/**
 * @fileoverview Markdown table rendering for tools that return arbitrary records —
 * one cell formatter for header and data cells, so `content[]` carries every value
 * `structuredContent` does and every record stays on one table line.
 * @module mcp-server/tools/markdown-table
 */

/**
 * `|` as `\|`, with the backslashes directly before it doubled (`a\|b` → `a\\\|b`). GFM parsers
 * treat a pipe after an even run of backslashes as a cell boundary, so a value's own backslash
 * would otherwise unescape the pipe and add a cell. A loop rather than a regex keeps a long
 * backslash run linear.
 */
function escapePipes(text: string): string {
  const parts = text.split('|');
  const last = parts.length - 1;
  return parts
    .map((part, i) => {
      if (i === last) return part;
      let run = 0;
      while (part[part.length - 1 - run] === '\\') run++;
      return part + '\\'.repeat(run);
    })
    .join('\\|');
}

/**
 * Text of one table cell. Objects and arrays render as compact JSON, `null` as `null`,
 * an empty string as `""`, and an absent value (a record without the column) as an empty
 * cell. `|` is escaped as `\|` and each CR, LF, or CRLF becomes one space, so a value can
 * neither split its cell nor its row.
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
  return escapePipes(text.replace(/\r\n?|\n/g, ' '));
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
