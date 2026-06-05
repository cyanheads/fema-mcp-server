/**
 * @fileoverview Tool: fema_search_nfip — NFIP flood insurance claims with DataCanvas spillover.
 * @module mcp-server/tools/definitions/fema-search-nfip
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

/** Inline preview budget — ~25k tokens of JSON. */
const PREVIEW_CHARS = 100_000;
/** Cap on rows registered to canvas. */
const MAX_CANVAS_ROWS = 50_000;

export const femaSearchNfip = tool('fema_search_nfip', {
  title: 'Search NFIP Flood Insurance Claims',
  description:
    'Search National Flood Insurance Program (NFIP) claims data by state, county, ZIP code, and year range. ' +
    'Returns claim counts, amounts paid on building and contents, flood zones, and loss years. ' +
    'state is required — the full NFIP dataset is 2.7 million rows; unfiltered access is prohibited. ' +
    'When DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) and results exceed the inline preview, ' +
    'the full result set is staged on a canvas for SQL aggregation via fema_dataframe_query. ' +
    'Use fema_dataframe_describe to inspect the staged table schema before writing SQL. ' +
    'Without canvas, results are returned inline up to the limit.',
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
        'County code to narrow results within the state (e.g., 201 for Harris County TX). Use with state.',
      ),
    zip_code: z.string().optional().describe('ZIP code to narrow results to a specific area.'),
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
      .describe('Maximum rows to fetch (1–10000, default 1000).'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior call. Omit to create a fresh canvas. The response returns the canvas_id to pass to fema_dataframe_query.',
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
              .describe('County code (e.g., 201 for Harris County TX). Absent when not recorded.'),
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
                'NFIP claim payment for the building structure in USD. Absent when zero or not recorded.',
              ),
            amount_paid_contents: z
              .number()
              .optional()
              .describe(
                'NFIP claim payment for contents (personal property) in USD. Absent when zero or not recorded.',
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
                'Primary cause of the flood damage (e.g., "Flooding", "Tidal Overflow"). Absent when not recorded.',
              ),
            occupancy_type: z
              .string()
              .optional()
              .describe(
                'NFIP occupancy type code (e.g., 1=Single Family, 2=2-4 Family, 6=Non-Residential). Absent when not recorded.',
              ),
          })
          .describe('A single NFIP flood insurance claim record.'),
      )
      .describe(
        'Inline preview of claim records (first N rows). Full dataset available via canvas_id when spilled=true.',
      ),
    total_count: z
      .number()
      .describe('Total matching claims in the filtered dataset before the limit.'),
    returned_count: z.number().describe('Number of claim records in the inline preview.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID for the staged full result set. Pass to fema_dataframe_query and fema_dataframe_describe. Present when canvas is enabled.',
      ),
    canvas_table: z
      .string()
      .optional()
      .describe(
        'DuckDB table name on the canvas holding all fetched rows. Reference in SQL FROM clauses. Present when spilled=true.',
      ),
    spilled: z
      .boolean()
      .describe(
        'True when the full result set was staged on DataCanvas; use canvas_id + fema_dataframe_query for SQL analysis. False when all results fit inline.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the canvas row cap (50,000) was reached before all matching rows were staged. Apply tighter filters (county_code, zip_code, year range) for a complete set.',
      ),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance on canvas usage or result scope.'),
  },
  errors: [
    {
      reason: 'state_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'state parameter was not provided or is empty.',
      recovery:
        'Provide a valid 2-letter US state code. The full NFIP dataset is 2.7M rows and cannot be fetched without a state filter.',
    },
  ],

  async handler(input, ctx) {
    if (!input.state?.trim()) {
      throw ctx.fail('state_required', 'state is required for NFIP claims queries.', {
        ...ctx.recoveryFor('state_required'),
      });
    }

    const filterParts: string[] = [`state eq '${input.state}'`];
    if (input.county_code?.trim()) {
      filterParts.push(`countyCode eq '${input.county_code}'`);
    }
    if (input.zip_code?.trim()) {
      filterParts.push(`reportedZipCode eq '${input.zip_code}'`);
    }
    if (input.year_from != null) {
      filterParts.push(`yearOfLoss ge ${input.year_from}`);
    }
    if (input.year_to != null) {
      filterParts.push(`yearOfLoss le ${input.year_to}`);
    }

    const svc = getOpenFemaService();
    const { rows: rawRows, count } = await svc.fetchNfipClaims(
      {
        filter: filterParts.join(' and '),
        orderby: 'dateOfLoss desc',
        top: input.limit,
      },
      ctx,
    );

    const rows = rawRows.map((r) => ({
      ...(r.state ? { state: r.state } : {}),
      ...(r.countyCode ? { county_code: r.countyCode } : {}),
      ...(r.reportedZipCode ? { zip_code: r.reportedZipCode } : {}),
      ...(r.dateOfLoss ? { date_of_loss: r.dateOfLoss } : {}),
      ...(r.yearOfLoss != null ? { year_of_loss: r.yearOfLoss } : {}),
      ...(r.amountPaidOnBuildingClaim != null
        ? { amount_paid_building: r.amountPaidOnBuildingClaim }
        : {}),
      ...(r.amountPaidOnContentsClaim != null
        ? { amount_paid_contents: r.amountPaidOnContentsClaim }
        : {}),
      ...(r.buildingDamageAmount != null ? { building_damage_amount: r.buildingDamageAmount } : {}),
      ...(r.contentsDamageAmount != null ? { contents_damage_amount: r.contentsDamageAmount } : {}),
      ...(r.ratedFloodZone ? { rated_flood_zone: r.ratedFloodZone } : {}),
      ...(r.causeOfDamage ? { cause_of_damage: r.causeOfDamage } : {}),
      ...(r.occupancyType ? { occupancy_type: r.occupancyType } : {}),
    }));

    // Try canvas spillover if available
    const canvas = getCanvas();
    if (canvas) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      const result = await spillover({
        canvas: instance,
        source: rows,
        previewChars: PREVIEW_CHARS,
        caps: { maxRows: MAX_CANVAS_ROWS },
        signal: ctx.signal,
      });

      if (result.spilled) {
        ctx.enrich.notice(
          `Results staged on canvas table "${result.handle.tableName}". Use fema_dataframe_query with canvas_id "${instance.canvasId}" to run SQL aggregations.`,
        );
        ctx.log.info('NFIP claims spilled to canvas', {
          canvasId: instance.canvasId,
          tableName: result.handle.tableName,
          rowCount: result.handle.rowCount,
        });
        return {
          claims: result.previewRows as (typeof rows)[0][],
          total_count: count,
          returned_count: result.previewRows.length,
          canvas_id: instance.canvasId,
          canvas_table: result.handle.tableName,
          spilled: true,
          ...(result.truncated ? { truncated: true } : {}),
        };
      }

      // Fits in preview — still surface canvas_id for potential follow-up queries
      ctx.log.info('NFIP claims fit inline', { rowCount: result.previewRows.length, count });
      return {
        claims: result.previewRows as (typeof rows)[0][],
        total_count: count,
        returned_count: result.previewRows.length,
        canvas_id: instance.canvasId,
        canvas_table: '',
        spilled: false,
      };
    }

    // Canvas disabled — inline only
    ctx.log.info('NFIP claims inline (canvas disabled)', { returned: rows.length, count });
    if (count > rows.length) {
      ctx.enrich.notice(
        `Showing ${rows.length} of ${count} matching claims. Enable CANVAS_PROVIDER_TYPE=duckdb for full analytical access, or increase limit and use offset for pagination.`,
      );
    }

    return {
      claims: rows,
      total_count: count,
      returned_count: rows.length,
      spilled: false,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**${result.returned_count} of ${result.total_count} NFIP claims** | Spilled: ${result.spilled}`,
    );
    if (result.spilled && result.canvas_id) {
      lines.push(
        `**Canvas ID:** ${result.canvas_id} | **Table:** ${result.canvas_table ?? 'unknown'}`,
      );
      lines.push(`Use fema_dataframe_query with this canvas_id for SQL aggregations.\n`);
    }
    if (result.truncated) {
      lines.push(`_Note: canvas row cap hit — result set truncated._\n`);
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
