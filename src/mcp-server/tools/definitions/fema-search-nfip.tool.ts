/**
 * @fileoverview Tool: fema_search_nfip — NFIP flood insurance claims (OpenFEMA `NfipClaims` v3),
 * paged inline by offset within a character budget, with DataCanvas spillover.
 * @module mcp-server/tools/definitions/fema-search-nfip
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type ColumnSchema,
  type SpilloverSpillResult,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { escapeODataString, getOpenFemaService } from '@/services/openfema/openfema-service.js';
import type { RawNfipClaim } from '@/services/openfema/types.js';
import { US_STATES } from '@/services/openfema/us-states.js';

/** Inline budget in characters of canvas-row JSON (~25k tokens) — the measure `spillover()` applies. */
const PREVIEW_CHARS = 100_000;
/** Cap on rows registered to canvas. */
const MAX_CANVAS_ROWS = 50_000;
/**
 * Rows per canvas page. OpenFEMA permits $top up to 10,000; 5,000 keeps the drain of a dense
 * ~50,000-row county-year to ~10 fetches, well inside transport timeouts, and fewer, larger
 * fetches are gentler on the FEMA API than many small ones.
 */
const PAGE_SIZE = 5000;
/** The 12 fields the tool reads — everything a response or canvas table carries. */
const NFIP_SELECT =
  'state,countyCode,reportedZipCode,dateOfLoss,yearOfLoss,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,buildingDamageAmount,contentsDamageAmount,ratedFloodZone,causeOfDamage,occupancyType';
/** A total order: `id` breaks date ties, so offset pages neither repeat nor skip a claim. */
const NFIP_ORDERBY = 'dateOfLoss desc,id';

/**
 * US state abbreviation → 2-digit FIPS code.
 * Used to normalize a 3-digit county code to the full 5-digit state+county FIPS.
 * Source: ANSI INCITS 38:2009 (formerly FIPS 5-2).
 */
const STATE_FIPS: Record<string, string> = {
  AL: '01',
  AK: '02',
  AZ: '04',
  AR: '05',
  CA: '06',
  CO: '08',
  CT: '09',
  DE: '10',
  DC: '11',
  FL: '12',
  GA: '13',
  HI: '15',
  ID: '16',
  IL: '17',
  IN: '18',
  IA: '19',
  KS: '20',
  KY: '21',
  LA: '22',
  ME: '23',
  MD: '24',
  MA: '25',
  MI: '26',
  MN: '27',
  MS: '28',
  MO: '29',
  MT: '30',
  NE: '31',
  NV: '32',
  NH: '33',
  NJ: '34',
  NM: '35',
  NY: '36',
  NC: '37',
  ND: '38',
  OH: '39',
  OK: '40',
  OR: '41',
  PA: '42',
  RI: '44',
  SC: '45',
  SD: '46',
  TN: '47',
  TX: '48',
  UT: '49',
  VT: '50',
  VA: '51',
  WA: '53',
  WV: '54',
  WI: '55',
  WY: '56',
  AS: '60',
  GU: '66',
  MP: '69',
  PR: '72',
  VI: '78',
};

/**
 * Explicit DuckDB schema for NFIP canvas tables. All fields are nullable to
 * prevent NOT NULL constraint failures during append: the sniff-based schema
 * inference marks a column NOT NULL when every row in the sniff window has a
 * non-null value — but NFIP data is sparse and later rows may omit fields
 * that happened to be present in the first N rows.
 */
const NFIP_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'state', type: 'VARCHAR', nullable: true },
  { name: 'county_code', type: 'VARCHAR', nullable: true },
  { name: 'zip_code', type: 'VARCHAR', nullable: true },
  { name: 'date_of_loss', type: 'VARCHAR', nullable: true },
  { name: 'year_of_loss', type: 'INTEGER', nullable: true },
  { name: 'amount_paid_building', type: 'DOUBLE', nullable: true },
  { name: 'amount_paid_contents', type: 'DOUBLE', nullable: true },
  { name: 'building_damage_amount', type: 'DOUBLE', nullable: true },
  { name: 'contents_damage_amount', type: 'DOUBLE', nullable: true },
  { name: 'rated_flood_zone', type: 'VARCHAR', nullable: true },
  { name: 'cause_of_damage', type: 'VARCHAR', nullable: true },
  { name: 'occupancy_type', type: 'INTEGER', nullable: true },
];

/**
 * A claim as staged on the canvas. Every field is explicitly null when absent so DuckDB
 * schema inference (based on the first N sniff rows) treats every column as nullable —
 * omitting a field would let a column come out NOT NULL when the sniff window happens to be
 * dense, and a later sparse row would then fail the constraint. A type alias, not an
 * interface, so it satisfies the `Row` record type `spillover()` accepts.
 */
type CanvasRow = {
  state: string | null;
  county_code: string | null;
  zip_code: string | null;
  date_of_loss: string | null;
  year_of_loss: number | null;
  amount_paid_building: number | null;
  amount_paid_contents: number | null;
  building_damage_amount: number | null;
  contents_damage_amount: number | null;
  rated_flood_zone: string | null;
  cause_of_damage: string | null;
  occupancy_type: number | null;
};

/** Map a raw API row to a canvas row (all fields explicitly null when absent). */
function toCanvasRow(r: RawNfipClaim): CanvasRow {
  return {
    state: r.state ?? null,
    county_code: r.countyCode ?? null,
    zip_code: r.reportedZipCode ?? null,
    date_of_loss: r.dateOfLoss ?? null,
    year_of_loss: r.yearOfLoss ?? null,
    amount_paid_building: r.amountPaidOnBuildingClaim ?? null,
    amount_paid_contents: r.amountPaidOnContentsClaim ?? null,
    building_damage_amount: r.buildingDamageAmount ?? null,
    contents_damage_amount: r.contentsDamageAmount ?? null,
    rated_flood_zone: r.ratedFloodZone ?? null,
    cause_of_damage: r.causeOfDamage ?? null,
    occupancy_type: r.occupancyType ?? null,
  };
}

/** Convert canvas rows (null fields) to the output schema shape (absent fields). */
function toOutputRows(canvasRows: CanvasRow[]) {
  return canvasRows.map((r) => ({
    ...(r.state != null ? { state: r.state } : {}),
    ...(r.county_code != null ? { county_code: r.county_code } : {}),
    ...(r.zip_code != null ? { zip_code: r.zip_code } : {}),
    ...(r.date_of_loss != null ? { date_of_loss: r.date_of_loss } : {}),
    ...(r.year_of_loss != null ? { year_of_loss: r.year_of_loss } : {}),
    ...(r.amount_paid_building != null ? { amount_paid_building: r.amount_paid_building } : {}),
    ...(r.amount_paid_contents != null ? { amount_paid_contents: r.amount_paid_contents } : {}),
    ...(r.building_damage_amount != null
      ? { building_damage_amount: r.building_damage_amount }
      : {}),
    ...(r.contents_damage_amount != null
      ? { contents_damage_amount: r.contents_damage_amount }
      : {}),
    ...(r.rated_flood_zone != null ? { rated_flood_zone: r.rated_flood_zone } : {}),
    ...(r.cause_of_damage != null ? { cause_of_damage: r.cause_of_damage } : {}),
    ...(r.occupancy_type != null ? { occupancy_type: r.occupancy_type } : {}),
  }));
}

/**
 * The leading rows whose canvas-row JSON fits the inline budget — the same per-row
 * `JSON.stringify` measure and cut-off `spillover()` applies to its preview.
 */
function withinBudget(rows: CanvasRow[]): CanvasRow[] {
  let chars = 0;
  let fit = 0;
  for (const row of rows) {
    chars += JSON.stringify(row).length;
    if (chars > PREVIEW_CHARS) break;
    fit++;
  }
  return rows.slice(0, fit);
}

/**
 * No canvas row serializes shorter than one of empty strings and single-digit numbers, so no
 * page larger than this can fit the budget (409 rows). A full canvas page always overflows it.
 */
const MAX_BUDGET_ROWS = Math.floor(
  PREVIEW_CHARS /
    JSON.stringify(
      Object.fromEntries(
        NFIP_CANVAS_SCHEMA.map(({ name, type }) => [name, type === 'VARCHAR' ? '' : 0]),
      ),
    ).length,
);

export const femaSearchNfip = tool('fema_search_nfip', {
  title: 'Search NFIP Flood Insurance Claims',
  description:
    'Search National Flood Insurance Program (NFIP) claims data by state, county, ZIP code, and year range. ' +
    'Returns the matching claim count and claim records — amounts paid on building and contents, damage estimates, flood zones, cause and occupancy codes, and loss dates — newest loss first. ' +
    'state is required — the full NFIP dataset is 2.7 million rows; unfiltered access is prohibited. ' +
    'Page the inline claims with limit and offset; a page holds at most 100,000 characters of claims. ' +
    'When DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) and the match exceeds that inline budget, ' +
    'a call at offset 0 stages the match (up to 50,000 claims) on a canvas: inspect the staged table with fema_dataframe_describe, ' +
    'then aggregate it with SQL via fema_dataframe_query.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .describe(
        'Two-letter US state code (required). NFIP dataset is 2.7M rows — state filter is mandatory.',
      ),
    county_code: z
      .string()
      .optional()
      .describe(
        'County code to narrow results within the state. Accepts the full 5-digit state+county FIPS (e.g., 48201 for Harris County TX) or the 3-digit county portion (e.g., 201) when state is provided — the server prepends the state FIPS automatically.',
      ),
    zip_code: z
      .string()
      .regex(/^\d{5}$/, 'ZIP code must be exactly 5 digits (e.g., 77002).')
      .optional()
      .describe('ZIP code to narrow results to a specific area (5-digit, e.g., 77002).'),
    year_from: z
      .number()
      .int()
      .min(1970)
      .max(2100)
      .optional()
      .describe('Start year of loss, inclusive (e.g., 2020).'),
    year_to: z
      .number()
      .int()
      .min(1970)
      .max(2100)
      .optional()
      .describe('End year of loss, inclusive (e.g., 2023).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe(
        'Maximum claims to return inline (1–10000, default 1000). A page also stops at 100,000 characters of claims (roughly 330 claims); when either bound leaves matching claims out, the notice names the offset to continue from. When DataCanvas is enabled and the match exceeds that character budget, a call at offset 0 stages the match on a canvas regardless of this value.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset into the matching claims, ordered newest date of loss first (default 0). Use with limit to page through a match. Only a call at offset 0 stages a match on a canvas; a later offset returns just its inline page. After a spill (spilled=true), read rows past the inline claims from the canvas table with fema_dataframe_query.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID from a prior call, to stage this match as another table on that canvas. Used only when the match is staged; omit it to stage on a fresh canvas. Pass the returned canvas_id to fema_dataframe_describe for the table columns, then to fema_dataframe_query for SQL.',
    ),
  }),
  output: z.object({
    claims: z
      .array(
        z
          .object({
            state: z
              .string()
              .optional()
              .describe('Two-letter state code. Absent when not in the record.'),
            county_code: z
              .string()
              .optional()
              .describe(
                '5-digit state+county FIPS code (e.g., 48201 for Harris County TX). Absent when not recorded.',
              ),
            zip_code: z
              .string()
              .optional()
              .describe('5-digit ZIP code of the insured property. Absent when not recorded.'),
            date_of_loss: z
              .string()
              .optional()
              .describe('ISO 8601 date the flood loss occurred. Absent when not recorded.'),
            year_of_loss: z
              .number()
              .optional()
              .describe('Calendar year the flood loss occurred. Absent when not recorded.'),
            amount_paid_building: z
              .number()
              .optional()
              .describe(
                'NFIP claim payment for the building structure in USD; 0 when the claim paid nothing on the building. Absent when not recorded.',
              ),
            amount_paid_contents: z
              .number()
              .optional()
              .describe(
                'NFIP claim payment for contents (personal property) in USD; 0 when the claim paid nothing on contents. Absent when not recorded.',
              ),
            building_damage_amount: z
              .number()
              .optional()
              .describe(
                'Estimated total building damage in USD (may exceed paid amount). Absent when not assessed.',
              ),
            contents_damage_amount: z
              .number()
              .optional()
              .describe(
                'Estimated total contents damage in USD (may exceed paid amount). Absent when not assessed.',
              ),
            rated_flood_zone: z
              .string()
              .optional()
              .describe(
                'FEMA flood zone designation at the property (e.g., AE, X, VE). Absent when not recorded.',
              ),
            cause_of_damage: z
              .string()
              .optional()
              .describe(
                'OpenFEMA cause-of-damage code, as published: 0 other causes; 1 tidal water overflow; 2 stream, river, or lake overflow; 3 alluvial fan overflow; 4 accumulation of rainfall or snowmelt; 7 erosion-demolition; 8 erosion-removal; 9 earth movement, landslide, land subsidence, sinkholes, etc.; A closed basin lake; B expedited claim handling without site inspection; C expedited claim handling follow-up site inspection; D expedited claim handling by the Adjusting Process Pilot Program (remote adjustment). Other values pass through unchanged. Absent when not recorded.',
              ),
            occupancy_type: z
              .number()
              .optional()
              .describe(
                'NFIP occupancy type code, as published. Legacy codes: 1 single-family residence; 2 residential building with 2 to 4 units; 3 residential building with more than 4 units; 4 non-residential building; 6 non-residential business. Risk Rating 2.0 codes: 11 single-family residential building (except a mobile home or a single unit within a multi-unit building); 12 residential non-condo building with 2 to 4 units, insuring all units; 13 residential non-condo building with 5 or more units, insuring all units; 14 residential mobile or manufactured home; 15 residential condo association building; 16 single residential unit within a multi-unit building; 17 non-residential mobile or manufactured home; 18 non-residential building; 19 non-residential unit within a multi-unit building. Other values pass through unchanged. Absent when not recorded.',
              ),
          })
          .describe('A single NFIP flood insurance claim record.'),
      )
      .describe(
        'Claims from offset onward, newest date of loss first, bounded by limit and 100,000 characters of claims. When spilled=true, canvas_table holds the staged match.',
      ),
    total_count: z
      .number()
      .describe(
        'Claims matching the filters, as counted by OpenFEMA — before offset, limit, and the canvas row cap.',
      ),
    returned_count: z.number().describe('Number of claim records in claims.'),
    staged_count: z
      .number()
      .optional()
      .describe(
        'Claims staged on canvas_table: the whole match, or its first 50,000 when truncated=true. Present only when spilled=true.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID for the staged match. Pass to fema_dataframe_describe and fema_dataframe_query. Present only when spilled=true.',
      ),
    canvas_table: z
      .string()
      .optional()
      .describe(
        'DuckDB table on the canvas holding the staged claims. List its columns with fema_dataframe_describe, then reference it in fema_dataframe_query FROM clauses. Present only when spilled=true.',
      ),
    spilled: z
      .boolean()
      .describe(
        'True when the match exceeded the inline budget and was staged on DataCanvas: call fema_dataframe_describe, then fema_dataframe_query, with canvas_id. False when nothing was staged.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the 50,000-row canvas cap was reached: canvas_table holds staged_count of the total_count matching claims. Apply tighter filters (county_code, zip_code, year range) to stage the complete set.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Paging and canvas guidance: the offset to continue from when claims were left out, the last valid offset when offset is past the end, or the canvas table and dataframe tools after a spill.',
      ),
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
      when: 'Query returned zero matching NFIP claims.',
      recovery:
        'Broaden the search by removing county_code, zip_code, or year filters, or verify the state code is correct.',
    },
  ],

  async handler(input, ctx) {
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    // Normalize a bare 3-digit county code to the full 5-digit state+county FIPS.
    // NFIP data stores countyCode as 5-digit FIPS; a 3-digit value silently returns zero rows.
    let countyCode = input.county_code?.trim() ?? '';
    if (countyCode.length === 3) {
      const stateFips = STATE_FIPS[input.state.toUpperCase()];
      if (stateFips) {
        countyCode = stateFips + countyCode;
      }
    }

    const filterParts: string[] = [`state eq '${escapeODataString(input.state)}'`];
    if (countyCode) {
      filterParts.push(`countyCode eq '${escapeODataString(countyCode)}'`);
    }
    if (input.zip_code?.trim()) {
      filterParts.push(`reportedZipCode eq '${escapeODataString(input.zip_code)}'`);
    }
    if (input.year_from != null) {
      filterParts.push(`yearOfLoss ge ${input.year_from}`);
    }
    if (input.year_to != null) {
      filterParts.push(`yearOfLoss le ${input.year_to}`);
    }

    const svc = getOpenFemaService();
    const query = { filter: filterParts.join(' and '), select: NFIP_SELECT, orderby: NFIP_ORDERBY };
    const { limit, offset } = input;
    // Only a call at offset 0 can stage: a later offset is a page of a match the caller already
    // has, so answering it with a fresh drain and canvas would re-stage the match on every page.
    const canvas = offset === 0 ? getCanvas() : undefined;

    // With a canvas, the first page is fetched whole: it decides whether the match fits the
    // inline budget before any canvas is acquired. Without one, only the requested page is
    // fetched, no larger than the rows that could fit the budget.
    const first = await svc.fetchNfipClaims(
      canvas
        ? { ...query, top: PAGE_SIZE, skip: 0 }
        : { ...query, top: Math.min(limit, MAX_BUDGET_ROWS), skip: offset },
      ctx,
    );
    const total = first.count;
    if (total === 0) {
      throw ctx.fail('no_results', `No NFIP claims matched the filters for ${input.state}.`, {
        ...ctx.recoveryFor('no_results'),
      });
    }
    if (offset >= total) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of the ${total} matching claims; the last valid offset is ${total - 1}.`,
      );
      return { claims: [], total_count: total, returned_count: 0, spilled: false };
    }

    const firstRows = first.rows.map(toCanvasRow);

    /** An unstaged page starting at `offset`; the notice names where to continue when claims were left out. */
    const inline = (rows: CanvasRow[]) => {
      const next = offset + rows.length;
      if (next < total) {
        const budget =
          rows.length < limit ? ', the most that fit the 100,000-character inline budget' : '';
        ctx.enrich.notice(
          `Returned ${rows.length} of the ${total} matching claims from offset ${offset}${budget}; continue with offset ${next}.`,
        );
      }
      ctx.log.info('NFIP claims returned inline', { total, offset, returned: rows.length });
      return {
        claims: toOutputRows(rows),
        total_count: total,
        returned_count: rows.length,
        spilled: false,
      };
    };

    if (!canvas) return inline(withinBudget(firstRows));

    const wholeMatch = firstRows.length < PAGE_SIZE || firstRows.length >= total;
    if (wholeMatch && withinBudget(firstRows).length === firstRows.length) {
      return inline(firstRows.slice(0, limit));
    }

    /** The match in order: the first page as fetched, then later pages up to the canvas row cap. */
    async function* drainMatch(): AsyncGenerator<CanvasRow> {
      yield* firstRows;
      let fetched = firstRows.length;
      let pageRows = firstRows.length;
      while (pageRows === PAGE_SIZE && fetched < Math.min(total, MAX_CANVAS_ROWS)) {
        // Pause between pages: rapid sequential requests draw 503 HTML responses from the FEMA API.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const { rows } = await svc.fetchNfipClaims(
          { ...query, top: PAGE_SIZE, skip: fetched },
          ctx,
        );
        for (const r of rows) yield toCanvasRow(r);
        fetched += rows.length;
        pageRows = rows.length;
      }
    }

    // The first page proved the match overflows the budget; only now is a canvas needed.
    const instance = await canvas.acquire(input.canvas_id, ctx);
    let spill: SpilloverSpillResult<CanvasRow>;
    try {
      const result = await spillover({
        canvas: instance,
        source: drainMatch(),
        schema: NFIP_CANVAS_SCHEMA,
        previewChars: PREVIEW_CHARS,
        caps: { maxRows: MAX_CANVAS_ROWS },
        signal: ctx.signal,
      });
      if (!result.spilled) {
        throw internalError(
          'spillover() kept inline an NFIP match whose first page overflows the preview budget.',
        );
      }
      spill = result;
    } catch (error) {
      // A canvas minted by this call holds nothing the caller can reach; a caller's canvas
      // keeps its other tables (spillover() already removed the partial one).
      if (instance.isNew) {
        await canvas.drop(instance.canvasId, ctx).catch((dropError: unknown) =>
          ctx.log.warning('Could not drop the canvas minted for a failed NFIP spill', {
            canvasId: instance.canvasId,
            error: dropError instanceof Error ? dropError.message : String(dropError),
          }),
        );
      }
      throw error;
    }

    const { handle, previewRows } = spill;
    const staged = handle.rowCount;
    // Tied to the cap, not to staged < total: a match OpenFEMA updates mid-drain can also differ.
    const truncated = staged === MAX_CANVAS_ROWS && total > staged;
    const claims = previewRows.slice(0, limit);
    const where = `table "${handle.tableName}" (canvas_id "${instance.canvasId}")`;
    ctx.enrich.notice(
      (truncated
        ? `Canvas ${where} holds the first ${staged} of the ${total} matching claims: the 50,000-row canvas cap was reached. Narrow county_code, zip_code, or the year range to stage the whole match. `
        : `Staged ${staged} matching claims on canvas ${where}. `) +
        'List its columns with fema_dataframe_describe, then run SQL on it with fema_dataframe_query. ' +
        `The first ${claims.length} of them are inline here; read the rest from the canvas table.`,
    );
    ctx.log.info('NFIP claims spilled to canvas', {
      canvasId: instance.canvasId,
      tableName: handle.tableName,
      total,
      staged,
      truncated,
    });
    return {
      claims: toOutputRows(claims),
      total_count: total,
      returned_count: claims.length,
      staged_count: staged,
      canvas_id: instance.canvasId,
      canvas_table: handle.tableName,
      spilled: true,
      ...(truncated ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**${result.returned_count} of ${result.total_count} NFIP claims** | Spilled: ${result.spilled}`,
    );
    if (result.spilled) {
      lines.push(
        `**Canvas ID:** ${result.canvas_id} | **Table:** ${result.canvas_table} | **Staged rows:** ${result.staged_count}`,
      );
      lines.push(
        "List the table's columns with fema_dataframe_describe, then run SQL with fema_dataframe_query using this canvas_id.\n",
      );
    }
    if (result.truncated) {
      lines.push(
        `_Note: the 50,000-row canvas cap was reached — the table holds ${result.staged_count} of the ${result.total_count} matching claims._\n`,
      );
    }
    if (result.claims.length === 0) {
      lines.push('_This page is empty: the offset is past the end of the matching claims._');
    }
    for (const c of result.claims) {
      const parts: string[] = [];
      if (c.state) parts.push(`State: ${c.state}`);
      if (c.county_code) parts.push(`County: ${c.county_code}`);
      if (c.zip_code) parts.push(`ZIP: ${c.zip_code}`);
      if (c.date_of_loss) parts.push(`Loss: ${c.date_of_loss}`);
      if (c.year_of_loss != null) parts.push(`Year: ${c.year_of_loss}`);
      if (c.rated_flood_zone) parts.push(`Zone: ${c.rated_flood_zone}`);
      if (c.cause_of_damage) parts.push(`Cause: ${c.cause_of_damage}`);
      if (c.occupancy_type) parts.push(`Occupancy: ${c.occupancy_type}`);
      if (c.amount_paid_building != null)
        parts.push(`Bldg Paid: $${c.amount_paid_building.toLocaleString()}`);
      if (c.amount_paid_contents != null)
        parts.push(`Contents Paid: $${c.amount_paid_contents.toLocaleString()}`);
      if (c.building_damage_amount != null)
        parts.push(`Bldg Damage: $${c.building_damage_amount.toLocaleString()}`);
      if (c.contents_damage_amount != null)
        parts.push(`Contents Damage: $${c.contents_damage_amount.toLocaleString()}`);
      lines.push(parts.join(' | '));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
