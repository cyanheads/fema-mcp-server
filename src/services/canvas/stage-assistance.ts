/**
 * @fileoverview Stage filtered OpenFEMA assistance matches on a DataCanvas.
 * @module services/canvas/stage-assistance
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, ColumnSchema, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline as literal } from '@cyanheads/mcp-ts-core/utils';

const MAX_ROWS = 50_000;
const FETCH_PAGE_SIZE = 1_000;
const ASSISTANCE_CALL_BUDGET_MS = 50_000;
const TABLE_PREFIX = {
  PublicAssistanceFundedProjectsDetails: 'public_assistance',
  HousingAssistanceOwners: 'housing_owners',
  HousingAssistanceRenters: 'housing_renters',
} as const;

/** Metadata for one independently capped OpenFEMA dataset. */
export const assistanceCanvasTableSchema = z.object({
  dataset: z
    .enum([
      'PublicAssistanceFundedProjectsDetails',
      'HousingAssistanceOwners',
      'HousingAssistanceRenters',
    ])
    .describe('OpenFEMA dataset in this table.'),
  table_name: z.string().describe('Table name for fema_dataframe_describe and SQL FROM clauses.'),
  staged_count: z.number().describe('Number of filtered records staged in this table.'),
  truncated: z
    .boolean()
    .describe('True when this table holds the first 50,000 of more matching records.'),
});

type CanvasTable = z.infer<typeof assistanceCanvasTableSchema>;
type Row = Record<string, unknown>;
type RowKeys = (string | undefined)[];
type Page = { rows: Row[]; count: number; keys?: RowKeys };

/** A first page and its exact filtered, deterministically ordered continuation. */
export interface AssistanceSource {
  count: number;
  dataset: CanvasTable['dataset'];
  fetchPage: (top: number, skip: number, signal: AbortSignal) => Promise<Page>;
  firstKeys?: RowKeys;
  firstRows: Row[];
  schema: ColumnSchema[];
}

type Staged = { spilled: true; canvas_id: string; canvas_tables: CanvasTable[] };
type StagingResult = (Staged | { spilled: false }) & { notice: string };

/** These queries reuse accepted primary filters; an HTTP rejection applies only to staging. */
async function fetchContinuation(
  source: AssistanceSource,
  top: number,
  offset: number,
  signal: AbortSignal,
): Promise<Page> {
  try {
    return await source.fetchPage(top, offset, signal);
  } catch (error) {
    if (!(error instanceof McpError) || error.code === JsonRpcErrorCode.RequestCancelled)
      throw error;
    const status =
      error.data?.status ??
      (error.cause instanceof McpError ? error.cause.data?.status : undefined);
    if (typeof status !== 'number' || status < 400 || status >= 600) throw error;
    throw serviceUnavailable(
      'OpenFEMA rejected an assistance continuation page.',
      {
        status,
        reason: 'assistance_continuation_rejected',
      },
      { cause: error },
    );
  }
}

async function* drain(source: AssistanceSource, signal: AbortSignal): AsyncGenerator<Row> {
  const target = Math.min(source.count, MAX_ROWS);
  if (source.firstRows.length === 0 || source.firstRows.length > source.count) {
    throw serviceUnavailable('The first assistance page did not match its reported record count.', {
      reason: 'assistance_page_changed',
    });
  }
  const first = source.firstRows.slice(0, target);
  const seen = new Set<string>();
  const checkKeys = (keys: RowKeys = []) => {
    for (const key of keys) {
      if (key === undefined) continue;
      if (seen.has(key)) {
        throw serviceUnavailable('An assistance record repeated while its pages were being read.', {
          reason: 'assistance_page_changed',
        });
      }
      seen.add(key);
    }
  };
  checkKeys(source.firstKeys?.slice(0, target));
  yield* first;
  let offset = first.length;
  while (offset < target) {
    signal.throwIfAborted();
    const top = Math.min(FETCH_PAGE_SIZE, target - offset);
    const page = await fetchContinuation(source, top, offset, signal);
    signal.throwIfAborted();
    if (page.count !== source.count || page.rows.length !== top) {
      throw serviceUnavailable('The assistance match changed while its pages were being read.', {
        reason: 'assistance_page_changed',
      });
    }
    checkKeys(page.keys);
    yield* page.rows;
    offset += page.rows.length;
  }
}

function isOperationalFailure(error: unknown): boolean {
  return (
    error instanceof McpError &&
    (error.code === JsonRpcErrorCode.ServiceUnavailable ||
      error.code === JsonRpcErrorCode.RateLimited ||
      error.code === JsonRpcErrorCode.Timeout ||
      error.code === JsonRpcErrorCode.DatabaseError ||
      error.code === JsonRpcErrorCode.Forbidden ||
      error.code === JsonRpcErrorCode.NotFound)
  );
}

/** Start the optional-work deadline at assistance tool entry, before the primary read. */
export function assistanceDeadline(): AbortSignal {
  return AbortSignal.timeout(ASSISTANCE_CALL_BUDGET_MS);
}

/** Stage every nonempty source as one operation, retaining any pre-existing canvas tables. */
export async function stageAssistance(
  canvas: DataCanvas,
  canvasId: string | undefined,
  sources: AssistanceSource[],
  ctx: Context,
  deadline: AbortSignal,
): Promise<StagingResult> {
  const signal = AbortSignal.any([ctx.signal, deadline]);
  const canvasTables: CanvasTable[] = [];
  const callId = crypto.randomUUID().replaceAll('-', '');
  let instance: CanvasInstance | undefined;
  try {
    signal.throwIfAborted();
    instance = await canvas.acquire(canvasId, ctx, { signal });
    for (const source of sources) {
      if (source.count === 0) continue;
      signal.throwIfAborted();
      const handle = await instance.registerTable(
        `${TABLE_PREFIX[source.dataset]}_${callId}`,
        drain(source, signal),
        { schema: source.schema, signal },
      );
      canvasTables.push({
        dataset: source.dataset,
        table_name: handle.tableName,
        staged_count: handle.rowCount,
        truncated: source.count > MAX_ROWS,
      });
      signal.throwIfAborted();
    }
    return {
      spilled: true,
      canvas_id: instance.canvasId,
      canvas_tables: canvasTables,
      notice:
        'Use fema_dataframe_describe to list the staged columns, then fema_dataframe_query to run SQL with the returned canvas_id.',
    };
  } catch (error) {
    let cleanupIncomplete = false;
    if (instance) {
      const live = instance;
      const results = await Promise.allSettled(
        live.isNew
          ? [canvas.drop(live.canvasId, ctx)]
          : canvasTables.map((table) => live.drop(table.table_name)),
      );
      cleanupIncomplete = results.some((result) => result.status === 'rejected');
      if (cleanupIncomplete) {
        ctx.log.warning('Failed to roll back one or more assistance canvas tables', {
          canvasId: live.canvasId,
        });
      }
    }
    ctx.signal.throwIfAborted();
    if (
      error instanceof McpError &&
      canvasId !== undefined &&
      (error.data?.reason === 'canvas_not_found' || error.data?.reason === 'canvas_id_malformed')
    )
      throw error;
    const timedOut =
      deadline.aborted &&
      (error === deadline.reason ||
        (error instanceof McpError &&
          (error.code === JsonRpcErrorCode.RequestCancelled ||
            error.code === JsonRpcErrorCode.Timeout)));
    if (!timedOut && !isOperationalFailure(error)) throw error;
    const reason = error instanceof McpError ? error.data?.reason : undefined;
    const why = timedOut
      ? 'the staging deadline elapsed'
      : reason === 'assistance_page_changed'
        ? 'the OpenFEMA match changed during pagination'
        : reason === 'assistance_continuation_rejected'
          ? 'OpenFEMA rejected a continuation page'
          : reason === 'canvas_capacity_exhausted'
            ? 'the active canvas limit was reached'
            : 'an OpenFEMA page or a canvas operation failed';
    return {
      spilled: false,
      notice:
        cleanupIncomplete && canvasId !== undefined
          ? `Canvas staging was unavailable because ${why}. Some tables may remain on the supplied canvas after rollback failed. Inspect it with fema_dataframe_describe and continue with the inline next_offset.`
          : `Canvas staging was unavailable because ${why}. Continue with the inline next_offset to read the remaining records.`,
    };
  }
}

/** Render the spill status and every dataset-to-table binding for clients reading text. */
export function renderAssistanceCanvas(result: {
  spilled: boolean;
  canvas_id?: string | undefined;
  canvas_tables?: CanvasTable[] | undefined;
}): string[] {
  const lines = [`**Spilled:** ${result.spilled}`];
  if (result.canvas_id !== undefined) lines.push(`**Canvas ID:** ${literal(result.canvas_id)}`);
  for (const table of result.canvas_tables ?? []) {
    lines.push(
      `**Dataset:** ${table.dataset} | **Table:** ${literal(table.table_name)} | **Staged rows:** ${table.staged_count} | **Truncated:** ${table.truncated}`,
    );
  }
  return lines;
}
