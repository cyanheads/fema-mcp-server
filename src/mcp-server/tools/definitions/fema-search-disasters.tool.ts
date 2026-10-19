/**
 * @fileoverview Tool: fema_search_disasters — search federal disaster declarations.
 * @module mcp-server/tools/definitions/fema-search-disasters
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  continuationNotice,
  rowCharge,
  rowsWithinBudget,
} from '@/mcp-server/tools/response-budget.js';
import {
  anySubstringFilter,
  countySpellings,
  incidentTypeSpellings,
} from '@/services/openfema/name-matcher.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';
import { US_STATES } from '@/services/openfema/us-states.js';

const CALENDAR_DATE_ERROR =
  'Expected a calendar date in YYYY-MM-DD form (e.g., 2024-01-31) — no time, partial date, or day past the end of the month.';

/**
 * Designated-area rows read per request, newest declaration date first. OpenFEMA returns one
 * row per designated area per disaster, so paging declarations means reading their rows and
 * deduplicating before `limit`/`offset` apply. OpenFEMA serves larger pages (it answered
 * `$top=50000` on 2026-10-16), but an uncached 10,000-row page already takes up to 18 s, so
 * this size keeps a search's reads inside its time budget.
 */
const OVERFETCH_CAP = 10_000;

/**
 * Budget for one search — its main request and the reads of full area rows that follow it —
 * inside the 60-second request timeout of MCP SDK clients.
 */
const SEARCH_BUDGET_MS = 50_000;

/**
 * URL-encoded length budget for one `disasterNumber in (…)` filter. The rest of its URL adds
 * about 230 characters, keeping each request under the 8,000 characters past which a CDN
 * refusal reads as too long (the CDN refuses about 8,900). A full page of 1,000 four-digit
 * disaster numbers encodes to about 7,000 characters, so it takes one request.
 */
const IN_LIST_CHARS = 7_500;

const AREA_TOTALS_SELECT = 'disasterNumber,ihProgramDeclared,paProgramDeclared,hmProgramDeclared';

/** `disasterNumber in (…)` filters covering `numbers` in order, each within IN_LIST_CHARS once URL-encoded. */
function inListFilters(numbers: readonly number[]): string[] {
  const opening = encodeURIComponent('disasterNumber in ()').length;
  const comma = encodeURIComponent(',').length;
  const chunks: number[][] = [];
  let chunk: number[] = [];
  let chars = opening;
  for (const n of numbers) {
    const digits = String(n).length;
    if (chunk.length > 0 && chars + comma + digits > IN_LIST_CHARS) {
      chunks.push(chunk);
      chunk = [];
      chars = opening;
    }
    chars += (chunk.length > 0 ? comma : 0) + digits;
    chunk.push(n);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.map((c) => `disasterNumber in (${c.join(',')})`);
}

interface AreaTotals {
  count: number;
  hm: boolean;
  ia: boolean;
  pa: boolean;
}

/**
 * Area-row pages read at once after a list's first page. An uncached 10,000-row page takes
 * 1–18 s (measured 2026-10-16), and the heaviest county page — 672 declarations, 32,324
 * rows — needs 4 pages, so reading the 3 after the first together keeps it inside the budget.
 */
const AREA_PAGE_CONCURRENCY = 3;

/**
 * Each declaration's area-row count and OR-ed program flags over all of its designated-area
 * rows — not only the ones a county filter matched — paged past 10,000 rows, with every
 * request inside `deadlineAt`. The first page to fail aborts the pages still in flight beside
 * it, since one failure already decides the result.
 */
async function readAreaTotals(
  numbers: readonly number[],
  ctx: Context,
  deadlineAt: number,
): Promise<Map<number, AreaTotals>> {
  const svc = getOpenFemaService();
  const totals = new Map<number, AreaTotals>();
  const failed = new AbortController();
  const readPage = async (filter: string, skip: number) => {
    const deadlineMs = deadlineAt - Date.now();
    if (deadlineMs <= 0) {
      throw timeout('The search ran out of time before every designated-area row was read.');
    }
    const page = await svc
      .fetchDisasters(
        { filter, select: AREA_TOTALS_SELECT, orderby: 'id', top: OVERFETCH_CAP, skip },
        ctx,
        { deadlineMs, signal: failed.signal },
      )
      .catch((error: unknown) => {
        failed.abort();
        throw error;
      });
    for (const row of page.rows) {
      const num = row.disasterNumber ?? 0;
      const t = totals.get(num) ?? { count: 0, ia: false, pa: false, hm: false };
      t.count += 1;
      t.ia ||= row.ihProgramDeclared === true;
      t.pa ||= row.paProgramDeclared === true;
      t.hm ||= row.hmProgramDeclared === true;
      totals.set(num, t);
    }
    return page;
  };
  for (const filter of inListFilters(numbers)) {
    const first = await readPage(filter, 0);
    if (first.rows.length < OVERFETCH_CAP) continue;
    const skips: number[] = [];
    for (let skip = OVERFETCH_CAP; skip < first.count; skip += OVERFETCH_CAP) skips.push(skip);
    for (let i = 0; i < skips.length; i += AREA_PAGE_CONCURRENCY) {
      await Promise.all(
        skips.slice(i, i + AREA_PAGE_CONCURRENCY).map((skip) => readPage(filter, skip)),
      );
    }
  }
  return totals;
}

/**
 * {@link readAreaTotals} as a best-effort correction: an upstream failure is returned for the
 * caller to disclose, while a cancelled request and a programmer error still throw.
 */
async function tryReadAreaTotals(
  numbers: readonly number[],
  ctx: Context,
  deadlineAt: number,
): Promise<Map<number, AreaTotals> | McpError> {
  try {
    return await readAreaTotals(numbers, ctx, deadlineAt);
  } catch (error) {
    if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
    return error;
  }
}

/** The programs a set of flags declares, as the format() lines name them. */
function programList(flags: { ia_declared: boolean; pa_declared: boolean; hm_declared: boolean }) {
  const programs: string[] = [];
  if (flags.ia_declared) programs.push('IA');
  if (flags.pa_declared) programs.push('PA');
  if (flags.hm_declared) programs.push('HM');
  return programs.length > 0 ? programs.join(', ') : 'None declared';
}

/** Why the area-row read failed, in terms a caller can act on — never service internals or a URL. */
function areaTotalsCause(error: McpError): string {
  const status = error.data?.status;
  if (error.code === JsonRpcErrorCode.Timeout) {
    return `it timed out inside the search’s ${SEARCH_BUDGET_MS / 1000}-second budget`;
  }
  if (error.code === JsonRpcErrorCode.RateLimited || status === 429) {
    return 'OpenFEMA rate limited it (HTTP 429)';
  }
  if (typeof status === 'number') return `OpenFEMA answered it with HTTP ${status}`;
  return 'OpenFEMA did not return a usable response';
}

/** A designated area county matched, with its own program flags. */
interface MatchedArea {
  area: string;
  fips_county_code?: string | undefined;
  fips_state_code?: string | undefined;
  hm_declared: boolean;
  ia_declared: boolean;
  pa_declared: boolean;
}

/** A declaration as the tool returns it. */
interface Declaration {
  declaration_date: string;
  declaration_type: string;
  designated_area_count: number;
  disaster_number: number;
  hm_declared: boolean;
  ia_declared: boolean;
  incident_begin_date?: string | undefined;
  incident_end_date?: string | undefined;
  incident_type: string;
  matched_areas?: MatchedArea[] | undefined;
  pa_declared: boolean;
  state: string;
  title: string;
}

/** The text block `format()` renders for one declaration — also what the response budget charges it. */
function renderDeclaration(d: Declaration): string {
  const label = d.declaration_type
    ? `${d.declaration_type}-${d.disaster_number}`
    : `Disaster #${d.disaster_number}`;
  const lines = [
    `## ${label} — ${d.title}`,
    `**State:** ${d.state} | **Type:** ${d.declaration_type} | **Incident:** ${d.incident_type}`,
    `**Declared:** ${d.declaration_date}`,
  ];
  if (d.incident_begin_date) {
    lines.push(
      `**Period:** ${d.incident_begin_date}${d.incident_end_date ? ` → ${d.incident_end_date}` : ' (ongoing)'}`,
    );
  }
  lines.push(`**Programs:** ${programList(d)}`);
  lines.push(`**Designated Areas:** ${d.designated_area_count}`);
  if (d.matched_areas) {
    const areas = d.matched_areas.map((a) => {
      const fips =
        a.fips_state_code && a.fips_county_code
          ? `FIPS ${a.fips_state_code}${a.fips_county_code}`
          : [
              a.fips_state_code && `state FIPS ${a.fips_state_code}`,
              a.fips_county_code && `county FIPS ${a.fips_county_code}`,
            ]
              .filter(Boolean)
              .join(', ');
      return `${a.area}${fips ? ` (${fips})` : ''} — ${programList(a)}`;
    });
    lines.push(`**Matched Areas:** ${areas.join('; ')}`);
  }
  return lines.join('\n');
}

export const femaSearchDisasters = tool('fema_search_disasters', {
  title: 'Search FEMA Disaster Declarations',
  description:
    'Search federal disaster declarations by state, incident type, declaration type, date range, and county. ' +
    'Returns deduplicated declaration-level summaries — each disaster number appears once with a ' +
    'designated_area_count showing how many counties/municipalities were designated. ' +
    'The disaster number is the chain key for fema_get_disaster, fema_get_public_assistance, and fema_get_housing_assistance. ' +
    'Use declaration_type to filter: DR (major disaster, most common), EM (emergency), FM (fire management). ' +
    'Date filters apply to the declaration date. Use fema_get_disaster to retrieve all designated-area rows for a specific declaration. ' +
    'county selects the declarations that designated a matching area; their area counts and program flags still describe the whole declaration, and matched_areas lists the matching areas with their own program flags. ' +
    'A search reads the most recent 10,000 designated-area rows; when more match, it returns the declarations dated after the day that window ends, sets truncated, and its notice names the date_to that continues with older declarations. ' +
    'A page holds at most 100,000 characters of declarations; when declarations remain past it, next_offset is the offset to continue from.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe('Two-letter US state/territory code (e.g., TX, CA, FL, PR). Filters by state.'),
    incident_type: z
      .string()
      .optional()
      .describe(
        'Incident type filter (e.g., Flood, Hurricane, Tornado, Fire, Earthquake, Severe Storm). Case-insensitive substring match: storm also matches Snowstorm and Winter Storm.',
      ),
    declaration_type: z
      .enum(['DR', 'EM', 'FM'])
      .optional()
      .describe(
        'Declaration type: DR (major disaster declaration), EM (emergency declaration), FM (fire management assistance declaration).',
      ),
    date_from: z
      .union([
        z.literal(''),
        z.iso.date({ error: CALENDAR_DATE_ERROR }).describe('Calendar date, YYYY-MM-DD.'),
      ])
      .optional()
      .describe(
        'Start of the declaration date range as a calendar date in YYYY-MM-DD format (e.g., 2024-01-01). Inclusive; not after date_to.',
      ),
    date_to: z
      .union([
        z.literal(''),
        z.iso.date({ error: CALENDAR_DATE_ERROR }).describe('Calendar date, YYYY-MM-DD.'),
      ])
      .optional()
      .describe(
        'End of the declaration date range as a calendar date in YYYY-MM-DD format (e.g., 2024-12-31). Inclusive; equal to date_from for a single day.',
      ),
    county: z
      .string()
      .optional()
      .describe(
        'Filter by designated area / county name (e.g., Harris, Los Angeles, dekalb). Case-insensitive substring match: harris also matches Harrison. Selects the declarations that designated a matching area; designated_area_count and the program flags still describe the whole declaration, and matched_areas lists the matching areas.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe(
        'Maximum number of unique disaster declarations to return (1–1000, default 50). A page also stops at 100,000 characters of declarations (roughly 290 declarations, about 190 with county); when either bound leaves matching declarations out, next_offset names the offset to continue from.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset in declarations (default 0). Pass the previous page’s next_offset to continue.',
      ),
  }),
  output: z.object({
    declarations: z
      .array(
        z
          .object({
            disaster_number: z
              .number()
              .describe(
                'Unique FEMA disaster number — pass to fema_get_disaster, fema_get_public_assistance, or fema_get_housing_assistance.',
              ),
            title: z
              .string()
              .describe('Official declaration title (e.g., "SEVERE STORMS AND FLOODING").'),
            state: z.string().describe('Two-letter state/territory code.'),
            incident_type: z
              .string()
              .describe('Type of incident (e.g., Flood, Hurricane, Tornado, Severe Storm).'),
            declaration_type: z
              .string()
              .describe(
                'Declaration type: DR (major disaster), EM (emergency), or FM (fire management).',
              ),
            declaration_date: z.string().describe('ISO 8601 date the declaration was signed.'),
            incident_begin_date: z
              .string()
              .optional()
              .describe('ISO 8601 incident start date. Absent when not recorded.'),
            incident_end_date: z
              .string()
              .optional()
              .describe('ISO 8601 incident end date. Absent for ongoing or unrecorded incidents.'),
            ia_declared: z
              .boolean()
              .describe(
                'True when the Individuals and Households Program (IHP) was declared for any area of the declaration — indicates IA housing/personal grants are available. Describes the whole declaration also when county is set; matched_areas carries each matched area’s own flag.',
              ),
            pa_declared: z
              .boolean()
              .describe(
                'True when Public Assistance (infrastructure recovery grants) was declared for any area of the declaration, also when county is set.',
              ),
            hm_declared: z
              .boolean()
              .describe(
                'True when Hazard Mitigation grants were declared for any area of the declaration, also when county is set.',
              ),
            designated_area_count: z
              .number()
              .describe(
                'Number of counties/municipalities the whole declaration designated, also when county is set — use fema_get_disaster for the full area list.',
              ),
            matched_areas: z
              .array(
                z
                  .object({
                    area: z
                      .string()
                      .describe('Name of the designated area, as stored (e.g., "Bexar (County)").'),
                    fips_state_code: z
                      .string()
                      .optional()
                      .describe('2-digit state FIPS code. Absent when not recorded.'),
                    fips_county_code: z
                      .string()
                      .optional()
                      .describe('3-digit county FIPS code. Absent when not recorded.'),
                    ia_declared: z.boolean().describe('True when IHP was declared for this area.'),
                    pa_declared: z
                      .boolean()
                      .describe('True when Public Assistance was declared for this area.'),
                    hm_declared: z
                      .boolean()
                      .describe('True when Hazard Mitigation was declared for this area.'),
                  })
                  .describe('One designated area that county matched, with its own program flags.'),
              )
              .optional()
              .describe(
                'The designated areas of this declaration that county matched, each with the programs declared for that area — which can differ from the declaration: an area designated for PA and HM only has ia_declared false. Present only when county is set.',
              ),
          })
          .describe('Deduplicated summary for one disaster declaration.'),
      )
      .describe(
        'Disaster declarations matching the search from offset onward, one entry per unique disaster number, bounded by limit and by 100,000 characters of declarations.',
      ),
    total_declarations: z
      .number()
      .describe(
        'Unique disaster declarations matching the query, before offset/limit paging — the ' +
          'bound for declaration-level pagination (limit/offset apply to declarations, not area rows). ' +
          'A lower bound when truncated is true: it counts only the declarations dated after the day the 10,000-row window ends.',
      ),
    total_area_rows: z
      .number()
      .describe(
        'Total matching designated-area rows from the API (raw row count, not declaration count) — with county set, the rows of the matching areas only. ' +
          'DisasterDeclarationsSummaries returns one row per designated area per disaster, ' +
          'so this is always ≥ the number of unique declarations. ' +
          'When it exceeds 10,000, the search reads the most recent 10,000 rows and drops the declarations dated on the oldest day among them, so every returned declaration is complete; the notice names the date_to that continues with older declarations.',
      ),
    returned_count: z
      .number()
      .describe('Number of unique deduplicated declarations in this response.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Zero-match guidance for supplied filters; paging guidance with continuation or the last valid offset for nonzero totals; when truncated is true, lower-bound totals and the date_to (YYYY-MM-DD) to search next; when area_totals_unavailable is true, why full area totals could not be read.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page: offset plus returned_count. Present only while matching declarations remain past this page — when truncated is true, only within the declarations dated after the day the window ends. Pass it as offset to continue.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Unique disaster declarations matching the query — the unit declaration-level pagination pages over. Exceeds returned_count when the matches span more than one page. A lower bound when truncated is true.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more than 10,000 designated-area rows match: the search covers only the declarations dated after the day its 10,000-row window ends. Each returned declaration is complete, the totals are lower bounds, and the notice names the date_to that continues with older declarations. Absent otherwise.',
      ),
    area_totals_unavailable: z
      .boolean()
      .optional()
      .describe(
        'True when county is set and reading the returned declarations’ full designated-area rows failed: designated_area_count and the ia/pa/hm flags then count only the areas county matched, and the notice names the cause. Absent otherwise.',
      ),
  },
  enrichmentTrailer: {
    // Read only when totalCount is written without the total kind-tag: a truncated search.
    totalCount: { label: 'Lower bound on total declarations' },
    area_totals_unavailable: { label: 'Declaration area totals unavailable' },
    next_offset: { label: 'Next offset' },
  },
  errors: [
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The state parameter is not a valid 2-letter US state/territory code.',
      recovery:
        'Provide a valid 2-letter US state code such as TX, CA, FL, or PR. Check the full list at FEMA.gov.',
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_from is later than date_to, so no declaration could match.',
      recovery:
        'Swap date_from and date_to so date_from is the earlier date; equal dates select a single day.',
    },
    {
      reason: 'request_too_long',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The incident_type or county value makes the request URL longer than the roughly 8,900 characters OpenFEMA accepts.',
      recovery:
        'Shorten incident_type and county to the name being searched for; stored incident types and county names are a few words long.',
    },
  ],

  async handler(input, ctx) {
    const deadlineAt = Date.now() + SEARCH_BUDGET_MS;
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }
    // ISO calendar dates order lexically.
    if (input.date_from && input.date_to && input.date_from > input.date_to) {
      throw ctx.fail(
        'invalid_range',
        `date_from ${input.date_from} is after date_to ${input.date_to}, so no declaration can match.`,
      );
    }

    const incidentTypes = incidentTypeSpellings(input.incident_type ?? '');
    const counties = countySpellings(input.county ?? '');
    const filterParts: string[] = [];
    if (input.state) filterParts.push(`state eq '${input.state}'`);
    if (incidentTypes.length > 0) {
      filterParts.push(anySubstringFilter('incidentType', incidentTypes));
    }
    if (input.declaration_type) filterParts.push(`declarationType eq '${input.declaration_type}'`);
    if (input.date_from) filterParts.push(`declarationDate ge '${input.date_from}T00:00:00.000Z'`);
    if (input.date_to) filterParts.push(`declarationDate le '${input.date_to}T23:59:59.999Z'`);
    if (counties.length > 0) filterParts.push(anySubstringFilter('designatedArea', counties));

    /**
     * With county set, the rows are the matching areas only: they name the matched areas, and a
     * second read of the returned declarations' full rows supplies their area counts and flags.
     */
    const byCounty = counties.length > 0;
    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchDisasters(
      {
        ...(filterParts.length > 0 ? { filter: filterParts.join(' and ') } : {}),
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'ihProgramDeclared,paProgramDeclared,hmProgramDeclared' +
          (byCounty ? ',designatedArea,fipsStateCode,fipsCountyCode' : ''),
        orderby: 'declarationDate desc',
        top: OVERFETCH_CAP,
      },
      ctx,
      { deadlineMs: deadlineAt - Date.now() },
    );

    /**
     * Past the cap, the window ends partway through the rows dated on its oldest day. Every row
     * of a declaration shares one declarationDate, so dropping that whole day leaves only
     * complete declarations — exactly the matches dated after it, which date_to=<that day>
     * (inclusive through 23:59:59.999Z) continues with no gap and no overlap.
     */
    let cutDay: string | undefined;
    if (count > OVERFETCH_CAP) {
      cutDay = rows.at(-1)?.declarationDate?.slice(0, 10);
      if (!cutDay) {
        throw internalError('OpenFEMA returned a declaration row without a declarationDate.');
      }
    }
    const windowRows = cutDay
      ? rows.filter((row) => row.declarationDate?.slice(0, 10) !== cutDay)
      : rows;

    // Deduplicate: group area-rows by disasterNumber, accumulating designated_area_count.
    const disasterMap = new Map<number, Declaration>();

    for (const row of windowRows) {
      const num = row.disasterNumber ?? 0;
      const matchedArea: MatchedArea | undefined = byCounty
        ? {
            area: row.designatedArea ?? 'Unknown',
            ...(row.fipsStateCode ? { fips_state_code: row.fipsStateCode } : {}),
            ...(row.fipsCountyCode ? { fips_county_code: row.fipsCountyCode } : {}),
            ia_declared: row.ihProgramDeclared ?? false,
            pa_declared: row.paProgramDeclared ?? false,
            hm_declared: row.hmProgramDeclared ?? false,
          }
        : undefined;
      const existing = disasterMap.get(num);
      if (existing) {
        existing.designated_area_count += 1;
        // OR the IHP flag across all areas: declared for ANY area = declared for the disaster
        if (row.ihProgramDeclared) existing.ia_declared = true;
        if (row.paProgramDeclared) existing.pa_declared = true;
        if (row.hmProgramDeclared) existing.hm_declared = true;
        if (matchedArea) existing.matched_areas?.push(matchedArea);
      } else {
        disasterMap.set(num, {
          disaster_number: num,
          title: row.declarationTitle ?? 'Unknown',
          state: row.state ?? '',
          incident_type: row.incidentType ?? '',
          declaration_type: row.declarationType ?? '',
          declaration_date: row.declarationDate ?? '',
          ...(row.incidentBeginDate ? { incident_begin_date: row.incidentBeginDate } : {}),
          ...(row.incidentEndDate ? { incident_end_date: row.incidentEndDate } : {}),
          ia_declared: row.ihProgramDeclared ?? false,
          pa_declared: row.paProgramDeclared ?? false,
          hm_declared: row.hmProgramDeclared ?? false,
          designated_area_count: 1,
          ...(matchedArea ? { matched_areas: [matchedArea] } : {}),
        });
      }
    }

    // offset/limit apply to declarations, not area rows.
    const page = Array.from(disasterMap.values()).slice(input.offset, input.offset + input.limit);

    // The area totals change what each declaration renders, so they are read before the budget cut.
    const totals =
      byCounty && page.length > 0
        ? await tryReadAreaTotals(
            page.map((d) => d.disaster_number),
            ctx,
            deadlineAt,
          )
        : undefined;
    if (totals && !(totals instanceof McpError)) {
      for (const d of page) {
        const t = totals.get(d.disaster_number);
        if (!t) continue;
        d.designated_area_count = t.count;
        d.ia_declared = t.ia;
        d.pa_declared = t.pa;
        d.hm_declared = t.hm;
      }
    }

    const returned = rowsWithinBudget(page.length, (i) => {
      const d = page[i] as Declaration;
      return rowCharge(d, renderDeclaration(d));
    });
    const declarations = page.slice(0, returned);
    const nextOffset = input.offset + returned;

    const total = disasterMap.size;
    const scope = cutDay
      ? `${total} declarations dated after ${cutDay}`
      : `${total} matching declarations`;
    // One notice: enrich.notice is last-wins, so the sentences compose.
    const notice: string[] = [];
    if (totals instanceof McpError) {
      ctx.enrich({ area_totals_unavailable: true });
      notice.push(
        `Reading the full designated-area rows of the ${returned} returned declaration(s) failed because ${areaTotalsCause(totals)}, so their designated_area_count, ia_declared, pa_declared, and hm_declared count only the areas county matched. ` +
          'Retry the search, or read a declaration whole with fema_get_disaster.',
      );
      ctx.log.warning('Declaration area totals unavailable for a county search', {
        declarations: page.length,
        error: totals.message,
      });
    }
    if (count === 0) {
      const filters = [
        input.state && 'state',
        input.incident_type?.trim() && 'incident_type',
        input.declaration_type && 'declaration_type',
        input.county?.trim() && 'county',
        (input.date_from || input.date_to) && 'date range',
      ].filter(Boolean);
      notice.push(
        'No disaster declarations matched the filters. ' +
          (filters.length > 0
            ? `Broaden the search by removing or widening ${filters.join(', ')}.`
            : 'Try the search again later; OpenFEMA returned no declarations.'),
      );
    } else if (returned === 0 && total > 0) {
      notice.push(
        `Offset ${input.offset} is past the end of the ${scope}; the last valid offset is ${total - 1}.`,
      );
    } else if (nextOffset < total) {
      ctx.enrich({ next_offset: nextOffset });
      notice.push(
        continuationNotice(
          `${returned} of the ${scope}`,
          input.offset,
          nextOffset,
          returned < page.length,
        ),
      );
    }
    if (cutDay) {
      ctx.enrich({ truncated: true, totalCount: total });
      notice.push(
        `${count.toLocaleString('en-US')} designated-area rows match, more than the ${OVERFETCH_CAP.toLocaleString('en-US')} one search reads, so this search covers only the ${total} declarations dated after ${cutDay} and the declaration totals are lower bounds. ` +
          `To continue with older declarations, repeat the search with date_to=${cutDay} and offset 0.`,
      );
    } else {
      ctx.enrich.total(total);
    }
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));
    ctx.log.info('Disaster search complete', {
      count,
      returned,
      ...(cutDay ? { cutDay } : {}),
    });
    return {
      declarations,
      total_declarations: total,
      total_area_rows: count,
      returned_count: returned,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      result.total_area_rows > OVERFETCH_CAP
        ? `**${result.returned_count} of ${result.total_declarations}+ unique declaration(s)** — a lower bound: ${result.total_area_rows.toLocaleString('en-US')} designated-area rows match, more than the ${OVERFETCH_CAP.toLocaleString('en-US')} one search reads\n`
        : `**${result.returned_count} of ${result.total_declarations} unique declaration(s)** (from ${result.total_area_rows} designated-area rows)\n`,
    );
    for (const d of result.declarations) lines.push(renderDeclaration(d), '');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
