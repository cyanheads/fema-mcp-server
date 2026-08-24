/**
 * @fileoverview Tests for fema_dataframe_query tool.
 * @module tests/tools/fema-dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
      canvasId: 'canvas_abc123',
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
      canvas_id: 'canvas_abc123',
      query:
        'SELECT year_of_loss, COUNT(*) as claims, SUM(amount_paid_building) as total_building FROM spilled_abc123 GROUP BY year_of_loss ORDER BY year_of_loss',
    });
    const result = await femaDataframeQuery.handler(input, ctx);
    expect(result.canvas_id).toBe('canvas_abc123');
    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ year_of_loss: 2024 });
  });

  it('throws typed canvas_unavailable with recovery when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: femaDataframeQuery.errors });
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'canvas_abc123',
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

  it('discloses truncation in structuredContent and content[] when the canvas caps the result (#19)', async () => {
    const mockInstance = {
      canvasId: 'canvas_capped',
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
      canvas_id: 'canvas_capped',
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

  it('emits no truncation disclosure when the result is not capped (#19)', async () => {
    // The beforeEach mock returns rowCount:2 with no `truncated` key — the non-capped case.
    const ctx = createQueryContext();
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'canvas_abc123',
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
      canvas_id: 'canvas_abc123',
    };
    const blocks = femaDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas_abc123');
    expect(text).toContain('year_of_loss');
    expect(text).toContain('2024');
    expect(text).toContain('7500000');
  });

  it('formats empty query result gracefully', () => {
    const output = {
      rows: [],
      row_count: 0,
      canvas_id: 'canvas_abc123',
    };
    const blocks = femaDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows returned');
  });
});
