/**
 * @fileoverview Tool: fema_dataframe_drop — remove a table or view from a FEMA DataCanvas.
 * @module mcp-server/tools/definitions/fema-dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const femaDataframeDropDefinition = tool('fema_dataframe_drop', {
  title: 'Drop FEMA DataCanvas Table',
  description:
    'Permanently remove one table or view from a DataCanvas staged by fema_search_nfip. ' +
    'This only deletes staged analytical data; it never changes FEMA source data. ' +
    'Call fema_dataframe_describe first to get the exact table or view name.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z.string().describe('Canvas ID from the fema_search_nfip response.'),
    table_name: z
      .string()
      .describe('Exact table or view name returned by fema_dataframe_describe.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas ID from which the table or view was removed.'),
    table_name: z.string().describe('Requested table or view name.'),
    dropped: z
      .boolean()
      .describe('True when the table or view existed and was removed; false when it was absent.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery: 'Re-run fema_search_nfip to stage a fresh canvas, then use the new canvas_id.',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'DataCanvas is disabled on this deployment (CANVAS_PROVIDER_TYPE is not set to duckdb).',
      recovery:
        'DataCanvas is disabled on this deployment. Self-hosted operators can enable it by setting CANVAS_PROVIDER_TYPE=duckdb.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_unavailable',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use fema_dataframe_drop.',
        { ...ctx.recoveryFor('canvas_unavailable') },
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const dropped = await instance.drop(input.table_name);

    ctx.log.info('DataCanvas table drop complete', {
      canvasId: input.canvas_id,
      tableName: input.table_name,
      dropped,
    });

    return {
      canvas_id: input.canvas_id,
      table_name: input.table_name,
      dropped,
    };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped \`${result.table_name}\` from canvas \`${result.canvas_id}\`.`
        : `No table or view named \`${result.table_name}\` exists on canvas \`${result.canvas_id}\`.`,
    },
  ],
});

export const femaDataframeDrop = getServerConfig().enableCanvasDrop
  ? femaDataframeDropDefinition
  : disabledTool(femaDataframeDropDefinition, {
      reason: 'DataCanvas deletion is disabled in this deployment.',
      hint: 'FEMA_ENABLE_CANVAS_DROP=true',
    });
