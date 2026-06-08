/**
 * @fileoverview Tool: fema_dataframe_query — SQL SELECT against a DataCanvas table staged by fema_search_nfip.
 * @module mcp-server/tools/definitions/fema-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const femaDataframeQuery = tool('fema_dataframe_query', {
  title: 'Query FEMA DataCanvas Table',
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by fema_search_nfip. ' +
    'Enables aggregation, GROUP BY, SUM/COUNT, time-series, and filtered analysis over the full NFIP claims result ' +
    'without re-fetching from the API. ' +
    'Call fema_dataframe_describe first to get the exact table name and column names needed for valid SQL. ' +
    'Only SELECT statements are allowed — DDL, DML, COPY, and file-reading functions are blocked.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID from the fema_search_nfip response (the canvas_id field).'),
    query: z
      .string()
      .describe(
        'SQL SELECT statement to run against the staged table. Use the table name from fema_dataframe_describe. ' +
          'Example: "SELECT year_of_loss, COUNT(*) AS claims, SUM(amount_paid_building) AS total_building_paid FROM df_nfip_abc123 GROUP BY year_of_loss ORDER BY year_of_loss"',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe(
            'A single result row — keys are column names from the SELECT, values are the computed data.',
          ),
      )
      .describe('All rows returned by the query.'),
    row_count: z
      .number()
      .describe('Number of rows in this response (may be capped at the canvas row limit).'),
    canvas_id: z.string().describe('Canvas ID that was queried — reuse for follow-up queries.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery: 'Re-run fema_search_nfip to stage a fresh canvas, then use the new canvas_id.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL statement is not a valid SELECT, references a non-existent table or column, or uses blocked operations.',
      recovery:
        'Call fema_dataframe_describe to verify table and column names, then correct the SQL. Only SELECT statements are permitted.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw new Error(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use fema_dataframe_query.',
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.query, { signal: ctx.signal });

    ctx.log.info('DataCanvas query complete', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
    });

    return {
      rows: result.rows,
      row_count: result.rowCount,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.row_count} rows** | Canvas: ${result.canvas_id}\n`);
    if (result.rows.length === 0) {
      lines.push('_No rows returned._');
    } else {
      const headers = Object.keys(result.rows[0] ?? {});
      if (headers.length > 0) {
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of result.rows) {
          const cells = headers.map((h) => String(row[h] ?? ''));
          lines.push(`| ${cells.join(' | ')} |`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
