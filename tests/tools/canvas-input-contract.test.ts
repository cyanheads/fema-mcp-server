/**
 * @fileoverview Canvas identifier validation at the tool boundary.
 * @module tests/tools/canvas-input-contract.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { femaDataframeDescribe } from '@/mcp-server/tools/definitions/fema-dataframe-describe.tool.js';
import { femaDataframeDrop } from '@/mcp-server/tools/definitions/fema-dataframe-drop.tool.js';
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';
import { femaSearchNfip } from '@/mcp-server/tools/definitions/fema-search-nfip.tool.js';

describe('canvas ID tool boundaries', () => {
  for (const definition of [
    femaDataframeDescribe,
    femaDataframeDrop,
    femaDataframeQuery,
    femaSearchNfip,
  ]) {
    it(`${definition.name} rejects malformed IDs before reaching services`, async () => {
      const input = {
        canvas_id: 'invalid!',
        ...(definition.name === 'fema_dataframe_drop' ? { table_name: 't' } : {}),
        ...(definition.name === 'fema_dataframe_query' ? { query: 'SELECT 1' } : {}),
        ...(definition.name === 'fema_search_nfip' ? { state: 'TX' } : {}),
      };
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(JSON.stringify(result.content)).toContain('canvas_id');
    });
    it(`${definition.name} accepts minted ID characters and length`, () => {
      const args = { canvas_id: 'Ab_012-xy9', table_name: 't', query: 'SELECT 1', state: 'TX' };
      const keys = definition.input.shape;
      const input = Object.fromEntries(Object.entries(args).filter(([key]) => key in keys));
      expect(definition.input.safeParse(input).success).toBe(true);
    });
  }
});
