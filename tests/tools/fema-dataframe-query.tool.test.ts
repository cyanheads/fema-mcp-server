/**
 * @fileoverview Tests for fema_dataframe_query tool.
 * @module tests/tools/fema-dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

async function setCanvasMock(impl: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(impl);
}

function createQueryContext() {
  return createMockContext({ errors: femaDataframeQuery.errors }) as Parameters<
    typeof femaDataframeQuery.handler
  >[1];
}

describe('femaDataframeQuery', () => {
  beforeEach(async () => {
    const mockInstance = {
      canvasId: 'Ab_012-xy9',
      query: vi.fn().mockResolvedValue({
        rows: [
          { year_of_loss: 2024, claims: 150, total_building: 7500000 },
          { year_of_loss: 2023, claims: 200, total_building: 9000000 },
        ],
        rowCount: 2,
      }),
    };
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    await setCanvasMock(mockCanvas);
  });

  it('returns SQL query results from a canvas table', async () => {
    const ctx = createQueryContext();
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'Ab_012-xy9',
      query:
        'SELECT year_of_loss, COUNT(*) as claims, SUM(amount_paid_building) as total_building FROM spilled_abc123 GROUP BY year_of_loss ORDER BY year_of_loss',
    });
    const result = await femaDataframeQuery.handler(input, ctx);
    expect(result.canvas_id).toBe('Ab_012-xy9');
    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ year_of_loss: 2024 });
  });

  it('throws typed canvas_unavailable with recovery when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: femaDataframeQuery.errors });
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'Ab_012-xy9',
      query: 'SELECT * FROM t',
    });
    await expect(femaDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE') },
      },
    });
  });

  it('declares exactly the reasons its call path emits, framework-thrown ones marked thrownBy service (#38)', () => {
    const contract = (femaDataframeQuery.errors ?? []).map((entry) => ({
      reason: entry.reason,
      code: entry.code,
      thrownBy: 'thrownBy' in entry ? entry.thrownBy : undefined,
    }));
    const service = (reason: string, code: JsonRpcErrorCode) => ({
      reason,
      code,
      thrownBy: 'service',
    });
    expect(contract).toEqual([
      {
        reason: 'canvas_unavailable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        thrownBy: undefined,
      },
      service('canvas_not_found', JsonRpcErrorCode.NotFound),
      service('missing_table', JsonRpcErrorCode.NotFound),
      service('invalid_sql', JsonRpcErrorCode.ValidationError),
      service('non_select_statement', JsonRpcErrorCode.ValidationError),
      service('multi_statement', JsonRpcErrorCode.ValidationError),
      service('denied_function', JsonRpcErrorCode.ValidationError),
      service('plan_operator_not_allowed', JsonRpcErrorCode.ValidationError),
      service('sql_read_only', JsonRpcErrorCode.ValidationError),
      service('sql_execution_error', JsonRpcErrorCode.ValidationError),
    ]);
  });

  it('discloses truncation in structuredContent and content[] when the canvas caps the result (#19)', async () => {
    const mockInstance = {
      canvasId: 'Cap012-xy9',
      // Plain (non-registerAs) path: when the result exceeds the row limit the provider returns
      // truncated:true and sets rowCount to the applied cap (here 2), not a true total.
      query: vi.fn().mockResolvedValue({
        columns: ['year_of_loss'],
        rows: [{ year_of_loss: 2017 }, { year_of_loss: 2018 }],
        rowCount: 2,
        truncated: true,
      }),
    };
    await setCanvasMock({ acquire: vi.fn().mockResolvedValue(mockInstance) });

    const ctx = createQueryContext();
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'Cap012-xy9',
      query: 'SELECT year_of_loss FROM df_nfip_abc123',
    });
    const result = await femaDataframeQuery.handler(input, ctx);

    // structuredContent is built by the framework as output.extend(enrichment).parse({ ...domain,
    // ...enrichment }); reproduce it with the tool's own schemas. An undeclared enrichment field
    // would be stripped here — so this proves the disclosure truly reaches structuredContent.
    const structuredContent = femaDataframeQuery.output
      .extend(femaDataframeQuery.enrichment!)
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(structuredContent).toMatchObject({ truncated: true, shown: 2, cap: 2 });

    // content[]: the framework appends an enrichment trailer rendering `notice` (kind: notice) as a
    // `> ...` blockquote — its text is structuredContent.notice, a deterministic LIMIT/OFFSET
    // continuation for the submitted SQL.
    expect(structuredContent.notice).toContain('LIMIT 2 OFFSET 2');
  });

  it('keeps the canvas-cap guidance word for word when every capped row fits the budget', async () => {
    const rows = [{ year_of_loss: 2017 }, { year_of_loss: 2018 }];
    await setCanvasMock({
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'Cap012-xy9',
        query: vi.fn().mockResolvedValue({ rows, rowCount: 2, truncated: true }),
      }),
    });
    const result = await runToolContract(femaDataframeQuery, {
      canvas_id: 'Cap012-xy9',
      query: 'SELECT year_of_loss FROM df_nfip_abc123',
    });
    expect(result.structuredContent).toMatchObject({
      rows,
      row_count: 2,
      truncated: true,
      shown: 2,
      cap: 2,
      notice:
        'Showing the first 2 rows (canvas row limit). Append "LIMIT 2 OFFSET 2" to your SELECT and re-run to fetch the next page, advancing OFFSET by 2 each call; or aggregate (GROUP BY / COUNT / SUM) to summarize the full set without paging.',
    });
  });

  it('emits no truncation disclosure when the result is not capped (#19)', async () => {
    // The beforeEach mock returns rowCount:2 with no `truncated` key — the non-capped case.
    const ctx = createQueryContext();
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'Ab_012-xy9',
      query: 'SELECT * FROM df_nfip_abc123',
    });
    await femaDataframeQuery.handler(input, ctx);
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('formats query results as markdown table', () => {
    const output = {
      rows: [
        { year_of_loss: 2024, claims: 150, total_building: 7500000 },
        { year_of_loss: 2023, claims: 200, total_building: 9000000 },
      ],
      row_count: 2,
      canvas_id: 'Ab_012-xy9',
    };
    const blocks = femaDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Ab_012-xy9');
    expect(text).toContain('year_of_loss');
    expect(text).toContain('2024');
    expect(text).toContain('7500000');
  });

  it('renders the scalar result table as one header, one separator, and one line per row', () => {
    const blocks = femaDataframeQuery.format!({
      rows: [
        { year_of_loss: 2024, claims: 150, total_building: 7500000 },
        { year_of_loss: 2023, claims: 200, total_building: 9000000 },
      ],
      row_count: 2,
      canvas_id: 'Ab_012-xy9',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text.split('\n').filter((line) => line.startsWith('| '))).toEqual([
      '| year_of_loss | claims | total_building |',
      '| --- | --- | --- |',
      '| 2024 | 150 | 7500000 |',
      '| 2023 | 200 | 9000000 |',
    ]);
  });

  it('renders structs and lists as compact JSON, null and "" distinctly, and escapes pipes and line breaks (#43)', () => {
    const rows = [
      { loss: { county: '48201' }, note: 'a|b', n: null, e: '', arr: [1, 2], nl: 'line1\nline2' },
      { loss: { county: '48157' }, note: 'c', n: null, e: '', arr: [], nl: 'x\r\ny' },
    ];
    const blocks = femaDataframeQuery.format!({ rows, row_count: 2, canvas_id: 'Ab_012-xy9' });
    const text = (blocks[0] as { text: string }).text;
    const lines = text.split('\n').filter((line) => line.startsWith('| '));
    expect(lines).toEqual([
      '| loss | note | n | e | arr | nl |',
      '| --- | --- | --- | --- | --- | --- |',
      '| {"county":"48201"} | a\\|b | null | "" | [1,2] | line1 line2 |',
      '| {"county":"48157"} | c | null | "" | [] | x y |',
    ]);
    for (const line of lines) expect(line.split(/(?<!\\)\|/).slice(1, -1)).toHaveLength(6);
    expect(text).not.toContain('[object Object]');
  });

  it('escapes a pipe in a column name so the header has as many cells as the separator (#43)', () => {
    const blocks = femaDataframeQuery.format!({
      rows: [{ 'a|b': 1, c: 2 }],
      row_count: 1,
      canvas_id: 'Ab_012-xy9',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text.split('\n').filter((line) => line.startsWith('| '))).toEqual([
      '| a\\|b | c |',
      '| --- | --- |',
      '| 1 | 2 |',
    ]);
  });

  it('formats empty query result gracefully', () => {
    const output = {
      rows: [],
      row_count: 0,
      canvas_id: 'Ab_012-xy9',
    };
    const blocks = femaDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows returned');
  });
});

describe('femaDataframeQuery — response budget (#46)', () => {
  /** Result row `i`: 98–100 characters of JSON, its table line a little shorter. */
  const row = (i: number) => ({ id: i, label: 'x'.repeat(80) });

  type Out = {
    rows: Array<{ id: number }>;
    row_count: number;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
  };

  async function query(rows: unknown[], extra: Record<string, unknown> = {}) {
    await setCanvasMock({
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'Bud012-xy9',
        query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length, ...extra }),
      }),
    });
    const result = await runToolContract(femaDataframeQuery, {
      canvas_id: 'Bud012-xy9',
      query: 'SELECT id, label FROM df_nfip_abc123 ORDER BY id',
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
    return { out: result.structuredContent as Out, text };
  }

  /** Result row `i` whose table line, each pipe escaped, is longer than its JSON. */
  const pipedRow = (i: number) => ({ id: i, label: '|'.repeat(60) });

  /** The table line format() renders for `r`. */
  const tableLine = (r: Record<string, unknown>) =>
    (
      femaDataframeQuery.format!({ rows: [r], row_count: 1, canvas_id: 'Bud012-xy9' })[0] as {
        text: string;
      }
    ).text
      .split('\n')
      .at(-1) ?? '';
  /** What the budget charges a row: the longer of its JSON and its table line, plus a separator. */
  const charge = (r: Record<string, unknown>) =>
    Math.max(JSON.stringify(r).length, tableLine(r).length) + 2;
  /**
   * Lowering the LIMIT by shown keeps a query that carries one inside the rows that LIMIT
   * selected: advancing OFFSET alone would page past them, through the rest of the table.
   */
  const budgetNotice = (shown: number) =>
    `Showing the first ${shown} result rows, the most that fit the 100,000-character response budget. To read the rest, re-run the query under an ORDER BY that gives every row a fixed position, with its OFFSET advanced by ${shown} (append "OFFSET ${shown}" when it has none) and any LIMIT lowered by ${shown}, and keep doing so with each response's shown until a response is not truncated; or aggregate (GROUP BY / COUNT / SUM) to summarize the full set without paging.`;

  it.each([
    ['its JSON', row],
    ['its table line', pipedRow],
  ])(
    'cuts the rows at 100,000 characters between whole rows when %s is longer: truncated and shown, no cap',
    async (longer, make) => {
      const [json, line] = [JSON.stringify(make(0)).length, tableLine(make(0)).length];
      expect(longer === 'its JSON' ? json > line : line > json).toBe(true);
      const { out, text } = await query(Array.from({ length: 3000 }, (_, i) => make(i)));
      const shown = out.rows.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(3000);
      expect(out.rows.map((r) => r.id)).toEqual(Array.from({ length: shown }, (_, i) => i));
      const used = out.rows.reduce((n, r) => n + charge(r), 0);
      expect(used).toBeLessThanOrEqual(100_000);
      expect(used + charge(make(shown))).toBeGreaterThan(100_000);
      expect(out).toMatchObject({ row_count: shown, truncated: true, shown });
      expect(out).not.toHaveProperty('cap');
      expect(out.notice).toBe(budgetNotice(shown));
      expect(text).toContain(budgetNotice(shown));
      expect(text).toContain(`**${shown} rows**`);
      const tableLines = text.split('\n').filter((line) => line.startsWith('| '));
      expect(tableLines).toHaveLength(shown + 2);
      expect(tableLines.slice(2).join('\n').length).toBeLessThanOrEqual(100_000);
    },
  );

  it('keeps cap beside a budget cut when the canvas row limit also applied', async () => {
    const { out } = await query(
      Array.from({ length: 3000 }, (_, i) => row(i)),
      { truncated: true },
    );
    const shown = out.rows.length;
    expect(shown).toBeLessThan(3000);
    expect(out).toMatchObject({ row_count: shown, truncated: true, shown, cap: 3000 });
    expect(out.notice).toBe(budgetNotice(shown));
  });

  it('returns one row over the budget alone', async () => {
    const { out } = await query([{ blob: 'y'.repeat(120_000) }, { blob: 'z' }]);
    expect(out).toMatchObject({ row_count: 1, truncated: true, shown: 1 });
    expect(out.notice).toBe(budgetNotice(1));
  });

  it('leaves a result that fits the budget whole, with no disclosure', async () => {
    const rows = Array.from({ length: 900 }, (_, i) => row(i));
    const { out } = await query(rows);
    expect(out.row_count).toBe(900);
    expect(out.rows).toHaveLength(900);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
  });
});
