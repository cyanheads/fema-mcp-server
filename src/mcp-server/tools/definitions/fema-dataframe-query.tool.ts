/**
 * @fileoverview Tool: fema_dataframe_query — SQL SELECT against a DataCanvas table staged by fema_search_nfip.
 * @module mcp-server/tools/definitions/fema-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  DUCKDB_ERROR_REASONS,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderTableHeader, renderTableRow } from '@/mcp-server/tools/markdown-table.js';
import { rowCharge, rowsWithinBudget } from '@/mcp-server/tools/response-budget.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const femaDataframeQuery = tool('fema_dataframe_query', {
  title: 'Query FEMA DataCanvas Table',
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by fema_search_nfip. ' +
    'Enables aggregation, GROUP BY, SUM/COUNT, time-series, and filtered analysis over the full NFIP claims result ' +
    'without re-fetching from the API. ' +
    'Call fema_dataframe_describe first to get the exact table name and column names needed for valid SQL. ' +
    'Only SELECT statements are allowed — DDL, DML, COPY, and file-reading functions are blocked. ' +
    'A response holds at most 100,000 characters of rows; when it holds fewer rows than the query returned, truncated and shown are set and the notice says how to page with OFFSET.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID from the fema_search_nfip response (the canvas_id field).',
    ),
    query: z
      .string()
      .describe(
        'SQL SELECT statement to run against the staged table. Use the table name from fema_dataframe_describe. ' +
          'Results are capped at the canvas row limit and at 100,000 characters of rows; append LIMIT/OFFSET, under an ORDER BY, to page through additional rows, or aggregate (GROUP BY, COUNT, SUM) to summarize the full set in one query. ' +
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
      .describe(
        'Result rows from the query, bounded by the canvas row limit and by 100,000 characters of rows — when the truncated ' +
          'enrichment field is set, page the remainder with OFFSET (see the notice guidance).',
      ),
    row_count: z
      .number()
      .describe(
        'Number of rows in this response — fewer than the query returned when truncated is set.',
      ),
    canvas_id: z.string().describe('Canvas ID that was queried — reuse for follow-up queries.'),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more rows match than this response holds: the result was capped at the canvas row limit, or cut at the 100,000-character response budget.',
      ),
    shown: z
      .number()
      .optional()
      .describe(
        'Number of rows in this truncated response — the amount to advance OFFSET by, and to lower any LIMIT by, for the next page.',
      ),
    cap: z
      .number()
      .optional()
      .describe(
        'The canvas row limit, present only when it capped the result. Absent when only the response budget cut it.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Continuation guidance when truncated — how far to advance OFFSET, and lower any LIMIT, under an ORDER BY, to page the remainder.',
      ),
  },
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'DataCanvas is disabled on this deployment (CANVAS_PROVIDER_TYPE is not set to duckdb).',
      recovery:
        'DataCanvas is disabled on this deployment, so the fema_dataframe_* tools are unavailable. Use fema_search_nfip or fema_query_dataset — both return data without canvas staging. Self-hosted operators can enable it by setting CANVAS_PROVIDER_TYPE=duckdb.',
    },
    {
      reason: 'canvas_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery: 'Re-run fema_search_nfip to stage a fresh canvas, then use the new canvas_id.',
    },
    {
      reason: 'missing_table',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SELECT names a table that is not staged on this canvas — misspelled, dropped, or expired.',
      recovery:
        'Call fema_dataframe_describe to list the staged tables, or re-run fema_search_nfip to stage the data again.',
    },
    {
      reason: SQL_GATE_REASONS.invalidSql,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A SELECT fails to prepare — an unknown column, function, or type, or an invalid expression.',
      recovery:
        'Call fema_dataframe_describe for the exact column names and types, then correct the SELECT.',
    },
    {
      reason: SQL_GATE_REASONS.nonSelectStatement,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The statement is not a SELECT (DDL, DML, PRAGMA, EXPLAIN, ATTACH) or cannot be parsed.',
      recovery:
        'Rewrite the request as one read-only SELECT, or WITH … SELECT, over the staged table.',
    },
    {
      reason: SQL_GATE_REASONS.multiStatement,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query holds more than one SQL statement.',
      recovery: 'Send one SELECT per call, with nothing after a closing semicolon.',
    },
    {
      reason: SQL_GATE_REASONS.deniedFunction,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT calls a blocked function — a file reader, an engine-setting reader, or query()/query_table() over anything but one literal SELECT.',
      recovery:
        'Remove the blocked function and read the staged table by name; the canvas reads only data already staged on it.',
    },
    {
      reason: SQL_GATE_REASONS.planOperatorNotAllowed,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query plan uses an operator outside the read-only allowlist, such as a table function like range() or a system catalog like information_schema.',
      recovery:
        'Select from the staged table directly; call fema_dataframe_describe to list tables and columns instead of reading system catalogs.',
    },
    {
      reason: DUCKDB_ERROR_REASONS.sqlReadOnly,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The statement writes or names a file, such as COPY … TO or a quoted file path in FROM.',
      recovery:
        'Query the staged tables by name; the canvas neither reads nor writes files on this server.',
    },
    {
      reason: DUCKDB_ERROR_REASONS.sqlExecutionError,
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A SELECT fails while converting or calculating values in the staged data.',
      recovery:
        'Use TRY_CAST or filter out incompatible values before converting or calculating them.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_unavailable',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use fema_dataframe_query.',
        { ...ctx.recoveryFor('canvas_unavailable') },
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.query, { signal: ctx.signal });

    // Every row of a SQL result carries the same columns, in SELECT order.
    const columns = Object.keys(result.rows[0] ?? {});
    const shown = rowsWithinBudget(result.rows.length, (i) => {
      const row = result.rows[i] ?? {};
      return rowCharge(row, renderTableRow(row, columns));
    });
    const rows = result.rows.slice(0, shown);

    // On this plain (non-registerAs) path there is no true total: when the canvas capped the
    // result, the provider sets result.rowCount to the applied cap and marks result.truncated.
    const cap = result.truncated ? result.rowCount : undefined;
    if (shown < result.rows.length) {
      ctx.enrich({ truncated: true, shown, ...(cap !== undefined ? { cap } : {}) });
      ctx.enrich.notice(
        `Showing the first ${shown} result rows, the most that fit the 100,000-character response budget. ` +
          `To read the rest, re-run the query under an ORDER BY that gives every row a fixed position, with its OFFSET advanced by ${shown} (append "OFFSET ${shown}" when it has none) and any LIMIT lowered by ${shown}, ` +
          `and keep doing so with each response's shown until a response is not truncated; or aggregate (GROUP BY / COUNT / SUM) to summarize the full set without paging.`,
      );
    } else if (cap !== undefined) {
      ctx.enrich.truncated({
        shown,
        cap,
        guidance:
          `Showing the first ${cap} rows (canvas row limit). Append "LIMIT ${cap} OFFSET ${cap}" ` +
          `to your SELECT and re-run to fetch the next page, advancing OFFSET by ${cap} each call; ` +
          `or aggregate (GROUP BY / COUNT / SUM) to summarize the full set without paging.`,
      });
    }

    ctx.log.info('DataCanvas query complete', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
      shown,
      truncated: result.truncated ?? false,
    });

    return { rows, row_count: shown, canvas_id: input.canvas_id };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.row_count} rows** | Canvas: ${result.canvas_id}\n`);
    if (result.rows.length === 0) {
      lines.push('_No rows returned._');
    } else {
      // Every row of a SQL result carries the same columns, in SELECT order.
      const columns = Object.keys(result.rows[0] ?? {});
      if (columns.length > 0) {
        lines.push(renderTableHeader(columns));
        for (const row of result.rows) lines.push(renderTableRow(row, columns));
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
