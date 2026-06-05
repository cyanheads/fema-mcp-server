/**
 * @fileoverview Tests for fema_dataframe_query tool.
 * @module tests/tools/fema-dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext();
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

  it('throws when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext();
    const input = femaDataframeQuery.input.parse({
      canvas_id: 'canvas_abc123',
      query: 'SELECT * FROM t',
    });
    await expect(femaDataframeQuery.handler(input, ctx)).rejects.toThrow(
      'DataCanvas is not enabled',
    );
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
