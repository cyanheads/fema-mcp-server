/**
 * @fileoverview Assistance staging against real DuckDB tables.
 * @module tests/services/canvas/stage-assistance.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  databaseError,
  forbidden,
  JsonRpcErrorCode,
  requestCancelled,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  type AssistanceSource,
  assistanceDeadline,
  stageAssistance as stageWithDeadline,
} from '@/services/canvas/stage-assistance.js';

const stageAssistance = (
  canvas: DataCanvas,
  canvasId: string | undefined,
  sources: AssistanceSource[],
  context: Context,
  deadline = assistanceDeadline(),
) => stageWithDeadline(canvas, canvasId, sources, context, deadline);

const ctx = createMockContext();
let provider: DuckdbProvider;
let canvas: DataCanvas;

beforeEach(() => {
  provider = new DuckdbProvider({
    defaultRowLimit: 100,
    exportRootPath: './.canvas-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 10,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      maxCanvasesPerTenant: 1,
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await canvas.shutdown(ctx);
});

function makeSource(overrides: Partial<AssistanceSource> = {}): AssistanceSource {
  return {
    dataset: 'HousingAssistanceOwners',
    schema: [{ name: 'ordinal', type: 'INTEGER', nullable: false }],
    count: 3,
    firstRows: [{ ordinal: 0 }],
    fetchPage: async (top, skip) => ({
      rows: Array.from({ length: top }, (_, index) => ({ ordinal: skip + index })),
      count: 3,
    }),
    ...overrides,
  };
}

it('registers exactly the cap and marks only a larger match truncated', async () => {
  const count = 50_002;
  const fetchPage = vi.fn(async (top: number, skip: number) => ({
    rows: Array.from({ length: top }, (_, index) => ({ ordinal: skip + index })),
    count,
  }));
  const result = await stageAssistance(canvas, undefined, [makeSource({ count, fetchPage })], ctx);
  if (!result.spilled) throw Error(result.notice);
  expect(result.canvas_tables).toEqual([
    {
      dataset: 'HousingAssistanceOwners',
      table_name: expect.any(String),
      staged_count: 50_000,
      truncated: true,
    },
  ]);
  expect(fetchPage.mock.lastCall?.slice(0, 2)).toEqual([999, 49_001]);
  const instance = await canvas.acquire(result.canvas_id, ctx);
  const table = result.canvas_tables[0]?.table_name;
  expect(
    (await instance.query(`SELECT MIN(ordinal) lo, MAX(ordinal) hi FROM ${table}`)).rows,
  ).toEqual([{ lo: 0, hi: 49_999 }]);
});

it('rolls back the successful half of a housing pair when the second registration fails', async () => {
  const instance = await canvas.acquire(undefined, ctx);
  await instance.registerTable('existing', [{ keep: 'yes' }]);
  const register = provider.registerTable.bind(provider);
  vi.spyOn(provider, 'registerTable')
    .mockImplementationOnce(register)
    .mockRejectedValueOnce(databaseError('Second registration failed'));
  const result = await stageAssistance(
    canvas,
    instance.canvasId,
    [makeSource(), makeSource({ dataset: 'HousingAssistanceRenters' })],
    ctx,
  );
  expect(result).toMatchObject({ spilled: false, notice: expect.stringContaining('next_offset') });
  expect((await instance.describe()).map((table) => table.name)).toEqual(['existing']);
  expect((await instance.query('SELECT keep FROM existing')).rows).toEqual([{ keep: 'yes' }]);
});

it('discloses when rollback could not remove a table from a supplied canvas', async () => {
  const instance = await canvas.acquire(undefined, ctx);
  const register = provider.registerTable.bind(provider);
  vi.spyOn(provider, 'registerTable')
    .mockImplementationOnce(register)
    .mockRejectedValueOnce(databaseError('Second registration failed'));
  vi.spyOn(provider, 'drop').mockRejectedValueOnce(databaseError('Drop failed'));
  const result = await stageAssistance(
    canvas,
    instance.canvasId,
    [makeSource(), makeSource({ dataset: 'HousingAssistanceRenters' })],
    ctx,
  );
  expect(result).toMatchObject({ spilled: false, notice: expect.stringContaining('may remain') });
  expect(await instance.describe()).toHaveLength(1);
});

it.each([
  { name: 'a short page', count: 3, rows: [{ ordinal: 1 }], keys: ['b'] },
  { name: 'a changed count', count: 4, rows: [{ ordinal: 1 }, { ordinal: 2 }], keys: ['b', 'c'] },
  { name: 'a repeated record', count: 3, rows: [{ ordinal: 0 }, { ordinal: 2 }], keys: ['a', 'c'] },
])('rolls back an incomplete registration on $name', async ({ count, rows, keys }) => {
  const instance = await canvas.acquire(undefined, ctx);
  await instance.registerTable('existing', [{ keep: 'yes' }]);
  const source = makeSource({ firstKeys: ['a'], fetchPage: async () => ({ count, rows, keys }) });
  const result = await stageAssistance(canvas, instance.canvasId, [source], ctx);
  expect(result).toMatchObject({
    spilled: false,
    notice: expect.stringContaining('match changed'),
  });
  expect((await instance.describe()).map((table) => table.name)).toEqual(['existing']);
});

it('releases a new canvas slot when an extra OpenFEMA page returns 403', async () => {
  const source = makeSource({
    fetchPage: async () => {
      throw forbidden('OpenFEMA denied an extra page', { status: 403 });
    },
  });
  const result = await stageAssistance(canvas, undefined, [source], ctx);
  expect(result).toMatchObject({ spilled: false, notice: expect.stringContaining('next_offset') });
  expect(canvas.countForTenant(ctx)).toBe(0);
});

it('preserves the inline path when the tenant is at the canvas limit', async () => {
  await canvas.acquire(undefined, ctx);
  await expect(stageAssistance(canvas, undefined, [makeSource()], ctx)).resolves.toMatchObject({
    spilled: false,
    notice: expect.stringContaining('active canvas limit'),
  });
  expect(canvas.countForTenant(ctx)).toBe(1);
});

it('treats a framework cancellation error as a staging timeout when only that deadline expired', async () => {
  const deadline = new AbortController();
  const source = makeSource({
    fetchPage: async () => {
      deadline.abort(new DOMException('Timed out', 'TimeoutError'));
      throw requestCancelled('Wrapped deadline expiry');
    },
  });
  const result = await stageAssistance(canvas, undefined, [source], ctx, deadline.signal);
  expect(result).toMatchObject({
    spilled: false,
    notice: expect.stringContaining('deadline elapsed'),
  });
  expect(canvas.countForTenant(ctx)).toBe(0);
});

it('rethrows caller cancellation and removes the new canvas', async () => {
  const caller = new AbortController();
  const callerCtx = createMockContext({ signal: caller.signal });
  const cancellation = new DOMException('Caller cancelled', 'AbortError');
  const source = makeSource({
    fetchPage: async () => {
      caller.abort(cancellation);
      throw requestCancelled('Wrapped caller cancellation');
    },
  });
  await expect(stageAssistance(canvas, undefined, [source], callerCtx)).rejects.toBe(cancellation);
  expect(canvas.countForTenant(callerCtx)).toBe(0);
});

it.each([new TypeError('Invalid row transformation'), validationError('Invalid local validation')])(
  'rethrows a non-HTTP continuation fault and removes the new canvas',
  async (fault) => {
    const deadline = new AbortController();
    const source = makeSource({
      fetchPage: async () => {
        deadline.abort(new DOMException('Elapsed', 'TimeoutError'));
        throw fault;
      },
    });
    await expect(stageAssistance(canvas, undefined, [source], ctx, deadline.signal)).rejects.toBe(
      fault,
    );
    expect(canvas.countForTenant(ctx)).toBe(0);
  },
);

it('propagates missing and malformed supplied canvas IDs', async () => {
  await expect(stageAssistance(canvas, 'aaaaaaaaaa', [makeSource()], ctx)).rejects.toMatchObject({
    code: JsonRpcErrorCode.NotFound,
    data: { reason: 'canvas_not_found' },
  });
  await expect(stageAssistance(canvas, 'malformed', [makeSource()], ctx)).rejects.toMatchObject({
    code: JsonRpcErrorCode.ValidationError,
    data: { reason: 'canvas_id_malformed' },
  });
  expect(canvas.countForTenant(ctx)).toBe(0);
});
