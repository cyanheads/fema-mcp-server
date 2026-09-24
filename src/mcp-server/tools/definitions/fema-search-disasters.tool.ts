/**
 * @fileoverview Tool: fema_search_disasters — search federal disaster declarations.
 * @module mcp-server/tools/definitions/fema-search-disasters
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeODataString, getOpenFemaService } from '@/services/openfema/openfema-service.js';
import { US_STATES } from '@/services/openfema/us-states.js';

const CALENDAR_DATE_ERROR =
  'Expected a calendar date in YYYY-MM-DD form (e.g., 2024-01-31) — no time, partial date, or day past the end of the month.';

/**
 * Designated-area rows read per search, newest declaration date first — OpenFEMA's largest
 * `$top`. OpenFEMA returns one row per designated area per disaster, so paging declarations
 * means reading their rows and deduplicating before `limit`/`offset` apply.
 */
const OVERFETCH_CAP = 10_000;

export const femaSearchDisasters = tool('fema_search_disasters', {
  title: 'Search FEMA Disaster Declarations',
  description:
    'Search federal disaster declarations by state, incident type, declaration type, date range, and county. ' +
    'Returns deduplicated declaration-level summaries — each disaster number appears once with a ' +
    'designatedAreaCount showing how many counties/municipalities were designated. ' +
    'The disaster number is the chain key for fema_get_disaster, fema_get_public_assistance, and fema_get_housing_assistance. ' +
    'Use declaration_type to filter: DR (major disaster, most common), EM (emergency), FM (fire management). ' +
    'Date filters apply to the declaration date. Use fema_get_disaster to retrieve all designated-area rows for a specific declaration. ' +
    'A search reads the most recent 10,000 designated-area rows; when more match, it returns the declarations dated after the day that window ends, sets truncated, and its notice names the date_to that continues with older declarations.',
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
        'Incident type filter (e.g., Flood, Hurricane, Tornado, Fire, Earthquake, Severe Storm). Case-insensitive substring match.',
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
        'Start of the declaration date range as a calendar date in YYYY-MM-DD format (e.g., 2024-01-01). Inclusive.',
      ),
    date_to: z
      .union([
        z.literal(''),
        z.iso.date({ error: CALENDAR_DATE_ERROR }).describe('Calendar date, YYYY-MM-DD.'),
      ])
      .optional()
      .describe(
        'End of the declaration date range as a calendar date in YYYY-MM-DD format (e.g., 2024-12-31). Inclusive.',
      ),
    county: z
      .string()
      .optional()
      .describe(
        'Filter by designated area / county name substring (e.g., Harris, Los Angeles). Case-insensitive.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe('Maximum number of unique disaster declarations to return (1–1000, default 50).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset in declarations (default 0). Use with limit to page through results.',
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
                'True when the Individuals and Households Program (IHP) was declared — indicates IA housing/personal grants are available.',
              ),
            pa_declared: z
              .boolean()
              .describe(
                'True when Public Assistance (infrastructure recovery grants) was declared.',
              ),
            hm_declared: z.boolean().describe('True when Hazard Mitigation grants were declared.'),
            designated_area_count: z
              .number()
              .describe(
                'Number of counties/municipalities designated — use fema_get_disaster for the full area list.',
              ),
          })
          .describe('Deduplicated summary for one disaster declaration.'),
      )
      .describe('Disaster declarations matching the search, one entry per unique disaster number.'),
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
        'Total matching designated-area rows from the API (raw row count, not declaration count). ' +
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
        'Paging guidance: when offset is at or past the end of the matching declarations, the total and the last valid offset; when truncated is true, that the totals are lower bounds and the date_to (YYYY-MM-DD) to search next for older declarations.',
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
  },
  enrichmentTrailer: {
    // Read only when totalCount is written without the total kind-tag: a truncated search.
    totalCount: { label: 'Lower bound on total declarations' },
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
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'Query returned zero disaster declarations.',
      recovery:
        'Broaden the search by removing filters, expanding the date range, or trying a different state or incident type.',
    },
  ],

  async handler(input, ctx) {
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    const filterParts: string[] = [];
    if (input.state) filterParts.push(`state eq '${input.state}'`);
    if (input.incident_type) {
      filterParts.push(`substringof('${escapeODataString(input.incident_type)}', incidentType)`);
    }
    if (input.declaration_type) filterParts.push(`declarationType eq '${input.declaration_type}'`);
    if (input.date_from) filterParts.push(`declarationDate ge '${input.date_from}T00:00:00.000Z'`);
    if (input.date_to) filterParts.push(`declarationDate le '${input.date_to}T23:59:59.999Z'`);
    if (input.county?.trim()) {
      filterParts.push(`substringof('${escapeODataString(input.county)}', designatedArea)`);
    }

    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchDisasters(
      {
        ...(filterParts.length > 0 ? { filter: filterParts.join(' and ') } : {}),
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'ihProgramDeclared,paProgramDeclared,hmProgramDeclared',
        orderby: 'declarationDate desc',
        top: OVERFETCH_CAP,
      },
      ctx,
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
        throw new Error('OpenFEMA returned a declaration row without a declarationDate.');
      }
    }
    const windowRows = cutDay
      ? rows.filter((row) => row.declarationDate?.slice(0, 10) !== cutDay)
      : rows;

    // Deduplicate: group area-rows by disasterNumber, accumulating designatedAreaCount.
    const disasterMap = new Map<
      number,
      {
        disaster_number: number;
        title: string;
        state: string;
        incident_type: string;
        declaration_type: string;
        declaration_date: string;
        incident_begin_date?: string;
        incident_end_date?: string;
        ia_declared: boolean;
        pa_declared: boolean;
        hm_declared: boolean;
        designated_area_count: number;
      }
    >();

    for (const row of windowRows) {
      const num = row.disasterNumber ?? 0;
      const existing = disasterMap.get(num);
      if (existing) {
        existing.designated_area_count += 1;
        // OR the IHP flag across all areas: declared for ANY area = declared for the disaster
        if (row.ihProgramDeclared) existing.ia_declared = true;
        if (row.paProgramDeclared) existing.pa_declared = true;
        if (row.hmProgramDeclared) existing.hm_declared = true;
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
        });
      }
    }

    // Slice the deduplicated list to honour the caller's offset/limit — now
    // applied against declarations, not area-rows.
    const declarations = Array.from(disasterMap.values()).slice(
      input.offset,
      input.offset + input.limit,
    );

    if (disasterMap.size === 0) {
      throw ctx.fail('no_results', 'No disaster declarations matched the query.', {
        ...ctx.recoveryFor('no_results'),
        recovery: {
          hint: 'No disaster declarations matched the search criteria. Broaden the search by removing filters, expanding the date range, or trying a different state or incident type.',
        },
      });
    }

    const total = disasterMap.size;
    // One notice: enrich.notice is last-wins, so the past-the-end and window sentences compose.
    const notice: string[] = [];
    if (declarations.length === 0) {
      const scope = cutDay
        ? `${total} declarations dated after ${cutDay}`
        : `${total} matching declarations`;
      notice.push(
        `Offset ${input.offset} is past the end of the ${scope}; the last valid offset is ${total - 1}.`,
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
      returned: declarations.length,
      ...(cutDay ? { cutDay } : {}),
    });
    return {
      declarations,
      total_declarations: total,
      total_area_rows: count,
      returned_count: declarations.length,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      result.total_area_rows > OVERFETCH_CAP
        ? `**${result.returned_count} of ${result.total_declarations}+ unique declaration(s)** — a lower bound: ${result.total_area_rows.toLocaleString('en-US')} designated-area rows match, more than the ${OVERFETCH_CAP.toLocaleString('en-US')} one search reads\n`
        : `**${result.returned_count} of ${result.total_declarations} unique declaration(s)** (from ${result.total_area_rows} designated-area rows)\n`,
    );
    for (const d of result.declarations) {
      const label = d.declaration_type
        ? `${d.declaration_type}-${d.disaster_number}`
        : `Disaster #${d.disaster_number}`;
      lines.push(`## ${label} — ${d.title}`);
      lines.push(
        `**State:** ${d.state} | **Type:** ${d.declaration_type} | **Incident:** ${d.incident_type}`,
      );
      lines.push(`**Declared:** ${d.declaration_date}`);
      if (d.incident_begin_date) {
        lines.push(
          `**Period:** ${d.incident_begin_date}${d.incident_end_date ? ` → ${d.incident_end_date}` : ' (ongoing)'}`,
        );
      }
      const programs: string[] = [];
      if (d.ia_declared) programs.push('IA');
      if (d.pa_declared) programs.push('PA');
      if (d.hm_declared) programs.push('HM');
      lines.push(`**Programs:** ${programs.length > 0 ? programs.join(', ') : 'None declared'}`);
      lines.push(`**Designated Areas:** ${d.designated_area_count}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
