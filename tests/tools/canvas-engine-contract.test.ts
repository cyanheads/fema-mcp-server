/**
 * @fileoverview Exercise FEMA SQL tool error envelopes against real DuckDB.
 * @module tests/tools/canvas-engine-contract.test
 */
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it } from 'vitest';
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';

it('advertises and returns the DuckDB data-conversion reason on both client surfaces', async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 100,
    exportRootPath: '/tmp',
    memoryLimitMb: 64,
    schemaSniffRows: 10,
  });
  const canvas = new DataCanvas(provider, new CanvasRegistry(provider));
  const context = createMockContext();
  setCanvas(canvas);
  try {
    const instance = await canvas.acquire(undefined, context);
    await instance.registerTable('claims', [{ amount: 'bad' }, { amount: '2' }]);
    const result = await runToolContract(
      femaDataframeQuery,
      { canvas_id: instance.canvasId, query: 'SELECT CAST(amount AS INTEGER) FROM claims' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'sql_execution_error',
          recovery: { hint: expect.stringContaining('TRY_CAST') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('TRY_CAST');
    expect(femaDataframeQuery.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'sql_execution_error', thrownBy: 'service' }),
      ]),
    );
    const success = await runToolContract(
      femaDataframeQuery,
      {
        canvas_id: instance.canvasId,
        query: 'SELECT TRY_CAST(amount AS INTEGER) AS amount FROM claims',
      },
      { context: { tenantId: 'default' } },
    );
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toMatchObject({
      rows: [{ amount: null }, { amount: 2 }],
      row_count: 2,
    });
    expect(JSON.stringify(success.content)).toContain('2');
  } finally {
    setCanvas(undefined);
    await canvas.shutdown(context);
  }
});
