/**
 * @fileoverview Tests for fema_dataframe_drop tool.
 * @module tests/tools/fema-dataframe-drop.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaDataframeDrop } from '@/mcp-server/tools/definitions/fema-dataframe-drop.tool.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let canvas: unknown;
  return {
    getCanvas: () => canvas,
    setCanvas: (value: unknown) => {
      canvas = value;
    },
    __setMock: (value: unknown) => {
      canvas = value;
    },
  };
});

async function setCanvasMock(impl: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (value: unknown) => void }).__setMock(impl);
}

describe('femaDataframeDrop', () => {
  const drop = vi.fn();

  beforeEach(async () => {
    drop.mockReset();
    drop.mockResolvedValue(true);
    await setCanvasMock({
      acquire: vi.fn().mockResolvedValue({ drop }),
    });
  });

  it('drops the requested canvas table', async () => {
    const ctx = createMockContext({ errors: femaDataframeDrop.errors });
    const input = femaDataframeDrop.input.parse({
      canvas_id: 'canvas_abc123',
      table_name: 'df_nfip_abc123',
    });

    const result = await femaDataframeDrop.handler(input, ctx);

    expect(drop).toHaveBeenCalledWith('df_nfip_abc123');
    expect(result).toEqual({
      canvas_id: 'canvas_abc123',
      table_name: 'df_nfip_abc123',
      dropped: true,
    });
  });

  it('returns dropped false when the table is already absent', async () => {
    drop.mockResolvedValue(false);
    const ctx = createMockContext({ errors: femaDataframeDrop.errors });
    const input = femaDataframeDrop.input.parse({
      canvas_id: 'canvas_abc123',
      table_name: 'missing_table',
    });

    await expect(femaDataframeDrop.handler(input, ctx)).resolves.toMatchObject({
      dropped: false,
    });
  });

  it('throws typed canvas_unavailable with recovery when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: femaDataframeDrop.errors });
    const input = femaDataframeDrop.input.parse({
      canvas_id: 'canvas_abc123',
      table_name: 'df_nfip_abc123',
    });

    await expect(femaDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE') },
      },
    });
  });

  it('formats both drop outcomes', () => {
    const removed = femaDataframeDrop.format!({
      canvas_id: 'canvas_abc123',
      table_name: 'df_nfip_abc123',
      dropped: true,
    });
    const absent = femaDataframeDrop.format!({
      canvas_id: 'canvas_abc123',
      table_name: 'df_nfip_abc123',
      dropped: false,
    });

    expect((removed[0] as { text: string }).text).toContain('Dropped');
    expect((absent[0] as { text: string }).text).toContain('No table or view');
  });
});
