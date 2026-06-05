/**
 * @fileoverview Tests for fema_dataframe_describe tool.
 * @module tests/tools/fema-dataframe-describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaDataframeDescribe } from '@/mcp-server/tools/definitions/fema-dataframe-describe.tool.js';

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

const mockTableInfo = [
  {
    name: 'spilled_abc123',
    kind: 'table',
    rowCount: 5000,
    columns: [
      { name: 'state', type: 'VARCHAR', nullable: true },
      { name: 'year_of_loss', type: 'INTEGER', nullable: true },
      { name: 'amount_paid_building', type: 'DOUBLE', nullable: true },
    ],
  },
];

describe('femaDataframeDescribe', () => {
  beforeEach(async () => {
    const mockInstance = {
      canvasId: 'canvas_abc123',
      describe: vi.fn().mockResolvedValue(mockTableInfo),
    };
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    await setCanvasMock(mockCanvas);
  });

  it('returns table metadata for a canvas', async () => {
    const ctx = createMockContext();
    const input = femaDataframeDescribe.input.parse({ canvas_id: 'canvas_abc123' });
    const result = await femaDataframeDescribe.handler(input, ctx);
    expect(result.canvas_id).toBe('canvas_abc123');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      name: 'spilled_abc123',
      kind: 'table',
      row_count: 5000,
    });
    expect(result.tables[0]?.columns).toHaveLength(3);
    expect(result.tables[0]?.columns[0]).toMatchObject({ name: 'state', type: 'VARCHAR' });
  });

  it('throws when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext();
    const input = femaDataframeDescribe.input.parse({ canvas_id: 'canvas_abc123' });
    await expect(femaDataframeDescribe.handler(input, ctx)).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });

  it('formats output as table schema listing', () => {
    const output = {
      canvas_id: 'canvas_abc123',
      tables: [
        {
          name: 'spilled_abc123',
          kind: 'table',
          row_count: 5000,
          columns: [
            { name: 'state', type: 'VARCHAR', nullable: true },
            { name: 'year_of_loss', type: 'INTEGER', nullable: false },
          ],
        },
      ],
    };
    const blocks = femaDataframeDescribe.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas_abc123');
    expect(text).toContain('spilled_abc123');
    expect(text).toContain('state');
    expect(text).toContain('VARCHAR');
    expect(text).toContain('5000');
  });
});
