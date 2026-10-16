/**
 * @fileoverview Exercise FEMA SQL tool error envelopes and result rendering against real DuckDB.
 * @module tests/tools/canvas-engine-contract.test
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';

type ErrorEnvelope = {
  code: number;
  data: { reason?: string; recovery?: { hint?: string } };
};

function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
}

/**
 * A canvas on the server's default export root. A root that contains the working directory
 * would let the engine reach a relative file path, so a COPY would fail the statement-type
 * gate instead of the engine's file-access refusal a deployment returns.
 */
function newCanvas() {
  const provider = new DuckdbProvider({
    defaultRowLimit: 100,
    exportRootPath: './.canvas-exports',
    memoryLimitMb: 64,
    schemaSniffRows: 10,
  });
  return new DataCanvas(provider, new CanvasRegistry(provider));
}

it('advertises and returns the DuckDB data-conversion reason on both client surfaces', async () => {
  const canvas = newCanvas();
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

describe('fema_dataframe_query against a real DuckDB canvas', () => {
  const canvas = newCanvas();
  const context = createMockContext();
  let canvasId = '';

  beforeAll(async () => {
    setCanvas(canvas);
    const instance = await canvas.acquire(undefined, context);
    canvasId = instance.canvasId;
    await instance.registerTable('claims', [
      { county_code: '48201', amount: '2' },
      { county_code: '48157', amount: '5' },
    ]);
  });

  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(context);
  });

  const run = (query: string, id = canvasId) =>
    runToolContract(
      femaDataframeQuery,
      { canvas_id: id, query },
      { context: { tenantId: 'default' } },
    );

  it.each([
    ['invalid_sql', JsonRpcErrorCode.ValidationError, 'SELECT flood_zone FROM claims'],
    ['missing_table', JsonRpcErrorCode.NotFound, 'SELECT * FROM no_such_table'],
    ['non_select_statement', JsonRpcErrorCode.ValidationError, 'DROP TABLE claims'],
    ['multi_statement', JsonRpcErrorCode.ValidationError, 'SELECT 1; SELECT 2'],
    ['denied_function', JsonRpcErrorCode.ValidationError, "SELECT current_setting('threads')"],
    ['plan_operator_not_allowed', JsonRpcErrorCode.ValidationError, 'SELECT * FROM range(3)'],
    ['sql_read_only', JsonRpcErrorCode.ValidationError, "COPY (SELECT 1) TO 'x.csv'"],
    [
      'sql_execution_error',
      JsonRpcErrorCode.ValidationError,
      'SELECT CAST(county_code AS TINYINT) FROM claims',
    ],
  ])(
    '%s: declared, and returned with a recovery hint on both surfaces (#38)',
    async (reason, code, sql) => {
      const result = await run(sql);
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: ErrorEnvelope }).error;
      expect(error.code).toBe(code);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery?.hint).toEqual(expect.stringMatching(/\S/));
      expect(contentText(result)).toMatch(/^Recovery: \S/m);
      expect(femaDataframeQuery.errors).toContainEqual(
        expect.objectContaining({ reason, code, thrownBy: 'service' }),
      );
    },
  );

  it('canvas_not_found: an unknown canvas_id is declared and returned with a recovery hint (#38)', async () => {
    const result = await run('SELECT 1', 'AAAAAAAAAA');
    const error = (result.structuredContent as { error: ErrorEnvelope }).error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('canvas_not_found');
    expect(error.data.recovery?.hint).toEqual(expect.stringMatching(/\S/));
    expect(contentText(result)).toMatch(/^Recovery: \S/m);
    expect(femaDataframeQuery.errors).toContainEqual(
      expect.objectContaining({
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
      }),
    );
  });

  it('a refused COPY writes no file', async () => {
    await run("COPY (SELECT 1) TO 'x.csv'");
    expect(existsSync(join(process.cwd(), 'x.csv'))).toBe(false);
  });

  it('renders DuckDB structs, lists, NULL, empty strings, pipes, and line breaks one row per line (#43)', async () => {
    const result = await run(
      "SELECT {'county': county_code} AS loss, 'a|b' AS note, NULL AS n, '' AS e, [1, 2] AS arr, " +
        "'line1' || chr(10) || 'line2' AS nl FROM claims ORDER BY county_code LIMIT 2",
    );
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { rows: unknown[] }).rows).toEqual([
      { loss: { county: '48157' }, note: 'a|b', n: null, e: '', arr: [1, 2], nl: 'line1\nline2' },
      { loss: { county: '48201' }, note: 'a|b', n: null, e: '', arr: [1, 2], nl: 'line1\nline2' },
    ]);
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.startsWith('| ')),
    ).toEqual([
      '| loss | note | n | e | arr | nl |',
      '| --- | --- | --- | --- | --- | --- |',
      '| {"county":"48157"} | a\\|b | null | "" | [1,2] | line1 line2 |',
      '| {"county":"48201"} | a\\|b | null | "" | [1,2] | line1 line2 |',
    ]);

    const header = await run('SELECT 1 AS "a|b", 2 AS c');
    expect(
      contentText(header)
        .split('\n')
        .filter((line) => line.startsWith('| ')),
    ).toEqual(['| a\\|b | c |', '| --- | --- |', '| 1 | 2 |']);
  });
});
