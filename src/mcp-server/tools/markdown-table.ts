/**
 * @fileoverview Markdown table rendering for tools that return arbitrary records —
 * one cell formatter for header and data cells, so `content[]` carries every value
 * `structuredContent` does and every record stays on one table line.
 * @module mcp-server/tools/markdown-table
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { requiresJson } from './literal-markdown.js';

/**
 * Text of one table cell. Objects and arrays render as compact JSON, `null` as `null`,
 * an empty string as `""`, and an absent value (a record without the column) as an empty
 * cell. Markdown syntax is literal. Unsafe strings use JSON notation here; complete
 * tool results containing them use the fenced JSON fallback instead of a table.
 */
export function formatTableCell(value: unknown): string {
  if (value === undefined) return '';
  if (value === '') return '""';
  const text =
    typeof value === 'string'
      ? value
      : value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return escapeMarkdownInline(
    typeof value === 'string' && requiresJson(value) ? JSON.stringify(value) : text,
  );
}

/** Header line and `---` separator line for a fixed column list. */
export function renderTableHeader(columns: readonly string[]): string {
  return [
    `| ${columns.map(formatTableCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ].join('\n');
}

/**
 * One table line for one record over a fixed column list — a cell per column, read from the
 * record's own properties only.
 */
export function renderTableRow(
  record: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): string {
  return `| ${columns.map((c) => formatTableCell(Object.hasOwn(record, c) ? record[c] : undefined)).join(' | ')} |`;
}
