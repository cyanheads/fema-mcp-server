/**
 * @fileoverview Response budget shared by the row-returning tools: at most 100,000 characters
 * of rows on each client surface, each row charged the larger of its JSON and the text
 * `format()` renders for it, cut only between whole rows.
 * @module mcp-server/tools/response-budget
 */

/** Characters of rows one response holds on each surface (~25k tokens). */
export const RESPONSE_BUDGET_CHARS = 100_000;

/**
 * What one row costs: the larger of its JSON (`structuredContent`) and the text `format()`
 * renders for it (`content[]`), plus two for the separator either surface puts between rows —
 * a comma, a line break, or a blank line.
 */
export function rowCharge(row: unknown, text: string): number {
  return Math.max(JSON.stringify(row).length, text.length) + 2;
}

/**
 * How many leading rows fit the budget, where `chargeAt(i)` is what row `i` costs. Never fewer
 * than one when `count` is positive: a single row over the budget is returned alone.
 */
export function rowsWithinBudget(count: number, chargeAt: (index: number) => number): number {
  let used = 0;
  for (let i = 0; i < count; i++) {
    used += chargeAt(i);
    if (used > RESPONSE_BUDGET_CHARS) return Math.max(i, 1);
  }
  return count;
}

/**
 * The most rows one page can hold when no row costs less than `minCharge` — the largest
 * `$top` worth requesting, since rows past it are cut before they reach either surface.
 */
export function maxRowsWithinBudget(minCharge: number): number {
  return Math.floor(RESPONSE_BUDGET_CHARS / minCharge);
}

/**
 * The continuation sentence for a page that left matching rows out: what it returned, from
 * which offset, whether the response budget or `limit` ended it, and the offset to pass next.
 * `returned` describes the page, e.g. `"150 of the 6616 matching PA projects"`.
 */
export function continuationNotice(
  returned: string,
  offset: number,
  nextOffset: number,
  budgetCut: boolean,
): string {
  const end = budgetCut
    ? ', the most that fit the 100,000-character response budget'
    : ', as many as limit allows';
  return `Returned ${returned} from offset ${offset}${end}; continue with offset ${nextOffset}.`;
}
