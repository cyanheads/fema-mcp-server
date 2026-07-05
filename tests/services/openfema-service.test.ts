/**
 * @fileoverview Tests for OpenFemaService — service-layer error-contract surfacing.
 * Exercises fetchDataset's error branches directly (mocking fetch) to verify the
 * declared recovery hints reach the wire and the raw upstream `name` field is dropped.
 * @module tests/services/openfema-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { femaQueryDataset } from '@/mcp-server/tools/definitions/fema-query-dataset.tool.js';
import { OpenFemaService } from '@/services/openfema/openfema-service.js';

/** Minimal Response stub — only the members fetchDataset reads. */
function mockResponse(opts: { status: number; contentType: string; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? opts.contentType : null),
    },
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

/** The recovery hint declared for a reason on the fema_query_dataset contract. */
function contractRecovery(reason: string): string {
  const entry = femaQueryDataset.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`test setup: no contract entry for reason "${reason}"`);
  return entry.recovery;
}

describe('OpenFemaService.fetchDataset error contracts', () => {
  const svc = new OpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the declared unknown_dataset recovery hint from the service throw', async () => {
    // A Drupal 404 HTML page = unknown dataset.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ status: 404, contentType: 'text/html' })),
    );
    const ctx = createMockContext({ errors: femaQueryDataset.errors });

    let caught: unknown;
    try {
      await svc.fetchDataset('NoSuchDataset', {}, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data).toMatchObject({
      reason: 'unknown_dataset',
      dataset: 'NoSuchDataset',
      recovery: { hint: contractRecovery('unknown_dataset') },
    });
  });

  it('surfaces the invalid_filter recovery hint and drops the upstream name field', async () => {
    // OpenFEMA 400 with its structured error object (raw `name: "Error"` is diagnostic noise).
    const body = JSON.stringify({
      error: [{ name: 'Error', code: 'OF_OQP_002', type: 'ODATA', message: 'parse error at 469' }],
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 400, contentType: 'application/json', body })),
    );
    const ctx = createMockContext({ errors: femaQueryDataset.errors });

    let caught: unknown;
    try {
      await svc.fetchDataset('DisasterDeclarationsSummaries', { filter: 'state = TX' }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as Record<string, unknown>;
    // Contract recovery is surfaced; the useful upstream `code` is retained.
    expect(data).toMatchObject({
      reason: 'invalid_filter',
      code: 'OF_OQP_002',
      recovery: { hint: contractRecovery('invalid_filter') },
    });
    // Regression: the raw upstream `name` field no longer leaks into error data.
    expect(data).not.toHaveProperty('name');
  });
});
