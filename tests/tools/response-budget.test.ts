/**
 * @fileoverview Tests for the shared response budget: the per-row charge, the whole-row cut,
 * the largest `$top` worth requesting, and the continuation sentence.
 * @module tests/tools/response-budget.test
 */

import { describe, expect, it } from 'vitest';
import {
  continuationNotice,
  maxRowsWithinBudget,
  RESPONSE_BUDGET_CHARS,
  rowCharge,
  rowsWithinBudget,
} from '@/mcp-server/tools/response-budget.js';

describe('response budget', () => {
  it('holds 100,000 characters of rows', () => {
    expect(RESPONSE_BUDGET_CHARS).toBe(100_000);
  });

  it('charges a row the larger of its JSON and its rendered text, plus a two-character separator', () => {
    const row = { a: 'x'.repeat(20) };
    const json = JSON.stringify(row).length;
    expect(rowCharge(row, 'short')).toBe(json + 2);
    expect(rowCharge(row, 'y'.repeat(json + 10))).toBe(json + 12);
    expect(rowCharge({}, '')).toBe(4);
  });

  it('keeps every row whose charges sum to exactly the budget', () => {
    expect(rowsWithinBudget(4, () => 25_000)).toBe(4);
    expect(rowsWithinBudget(5, () => 25_000)).toBe(4);
  });

  it('cuts at the first row that would cross the budget, never inside a row', () => {
    const charges = [40_000, 40_000, 20_001, 1];
    expect(rowsWithinBudget(charges.length, (i) => charges[i] ?? 0)).toBe(2);
  });

  it('returns one row alone when that row is over the budget', () => {
    expect(rowsWithinBudget(3, () => 250_000)).toBe(1);
    expect(rowsWithinBudget(1, () => 250_000)).toBe(1);
  });

  it('returns nothing for no rows', () => {
    expect(rowsWithinBudget(0, () => 1)).toBe(0);
  });

  it('reads each charge at most once per row, in order', () => {
    const seen: number[] = [];
    const kept = rowsWithinBudget(10, (i) => {
      seen.push(i);
      return 30_000;
    });
    expect(kept).toBe(3);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('bounds a page by the cheapest possible row', () => {
    expect(maxRowsWithinBudget(32)).toBe(3125);
    expect(maxRowsWithinBudget(100_001)).toBe(0);
  });

  it('names the offset to continue from and what ended the page', () => {
    expect(continuationNotice('150 of the 6616 matching PA projects', 0, 150, true)).toBe(
      'Returned 150 of the 6616 matching PA projects from offset 0, the most that fit the 100,000-character response budget; continue with offset 150.',
    );
    expect(continuationNotice('100 of the 195 matching records', 50, 150, false)).toBe(
      'Returned 100 of the 195 matching records from offset 50, as many as limit allows; continue with offset 150.',
    );
  });
});
