/**
 * @fileoverview Tool: fema_dataframe_describe — describe tables on a DataCanvas staged by fema_search_nfip.
 * @module mcp-server/tools/definitions/fema-dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const femaDataframeDescribe = tool('fema_dataframe_describe', {
  title: 'Describe FEMA DataCanvas Tables',
  description:
    'List tables and column schemas on a DataCanvas staged by fema_search_nfip. ' +
    'Call this before fema_dataframe_query to discover the exact table name, column names, and DuckDB data types needed to write valid SQL. ' +
    'Row count reflects what was actually staged — check truncated in the fema_search_nfip response to know whether the canvas holds the full matching set.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z.string().describe('Canvas ID from the fema_search_nfip response.'),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Table or view name — use this exact string in SQL FROM clauses.'),
            kind: z
              .string()
              .describe(
                'Object type: "table" for a registered data table, "view" for a derived view.',
              ),
            row_count: z
              .number()
              .describe(
                'Total rows in this table — the full staged result set, not the inline preview count.',
              ),
            columns: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .describe(
                        'Column name — use in SELECT, WHERE, GROUP BY, and ORDER BY clauses.',
                      ),
                    type: z
                      .string()
                      .describe('DuckDB SQL data type (e.g., VARCHAR, DOUBLE, INTEGER, BOOLEAN).'),
                    nullable: z
                      .boolean()
                      .optional()
                      .describe(
                        'True when the column can contain NULL values. Absent when nullability is unknown.',
                      ),
                  })
                  .describe('A single column in the table.'),
              )
              .describe('All columns in this table, in schema order.'),
          })
          .describe('A single registered table or view on the canvas.'),
      )
      .describe('All tables and views available on this canvas.'),
    canvas_id: z.string().describe('Canvas ID that was described — pass to fema_dataframe_query.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery: 'Re-run fema_search_nfip to stage a fresh canvas, then use the new canvas_id.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw new Error(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use fema_dataframe_describe.',
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tableInfos = await instance.describe();

    ctx.log.info('DataCanvas describe complete', {
      canvasId: input.canvas_id,
      tableCount: tableInfos.length,
    });

    return {
      tables: tableInfos.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          ...(c.nullable != null ? { nullable: c.nullable } : {}),
        })),
      })),
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Canvas:** ${result.canvas_id} | **${result.tables.length} table(s)**\n`);
    for (const t of result.tables) {
      lines.push(`## ${t.name} (${t.kind}, ${t.row_count} rows)`);
      lines.push(`| Column | Type | Nullable |`);
      lines.push(`| --- | --- | --- |`);
      for (const c of t.columns) {
        lines.push(`| ${c.name} | ${c.type} | ${c.nullable ?? 'unknown'} |`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
