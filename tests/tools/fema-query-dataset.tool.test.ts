/**
 * @fileoverview Tests for fema_query_dataset tool — generic escape hatch.
 * @module tests/tools/fema-query-dataset.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaQueryDataset } from '@/mcp-server/tools/definitions/fema-query-dataset.tool.js';

vi.mock('@/services/openfema/openfema-service.js', () => {
  let _mockSvc: Record<string, unknown>;
  return {
    getOpenFemaService: () => _mockSvc,
    initOpenFemaService: () => {},
    __setMock: (svc: Record<string, unknown>) => {
      _mockSvc = svc;
    },
  };
});

async function setMock(impl: Record<string, unknown>) {
  const mod = await import('@/services/openfema/openfema-service.js');
  (mod as unknown as { __setMock: (s: Record<string, unknown>) => void }).__setMock(impl);
}

describe('femaQueryDataset', () => {
  beforeEach(async () => {
    await setMock({
      fetchDataset: vi.fn().mockResolvedValue({
        rows: [{ disasterNumber: 4781, state: 'TX', declarationDate: '2024-09-27T00:00:00.000Z' }],
        count: 1,
      }),
    });
  });

  it('returns rows and count for a valid dataset', async () => {
    const ctx = createMockContext({ errors: femaQueryDataset.errors });
    const input = femaQueryDataset.input.parse({
      dataset: 'DisasterDeclarationsSummaries',
      filter: "state eq 'TX'",
      limit: 10,
    });
    const result = await femaQueryDataset.handler(input, ctx);
    expect(result.dataset).toBe('DisasterDeclarationsSummaries');
    expect(result.rows).toHaveLength(1);
    expect(result.total_count).toBe(1);
    expect(result.returned_count).toBe(1);
  });

  it('returns empty rows without throwing when count is 0', async () => {
    await setMock({
      fetchDataset: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaQueryDataset.errors });
    const input = femaQueryDataset.input.parse({
      dataset: 'DisasterDeclarationsSummaries',
      limit: 100,
    });
    const result = await femaQueryDataset.handler(input, ctx);
    expect(result.rows).toHaveLength(0);
    expect(result.returned_count).toBe(0);
  });

  it('propagates unknown_dataset error from service', async () => {
    const unknownDatasetError = new McpError(
      JsonRpcErrorCode.NotFound,
      'Dataset "BadName" not found',
      { reason: 'unknown_dataset', dataset: 'BadName' },
    );
    await setMock({
      fetchDataset: vi.fn().mockRejectedValue(unknownDatasetError),
    });
    const ctx = createMockContext({ errors: femaQueryDataset.errors });
    const input = femaQueryDataset.input.parse({ dataset: 'BadName' });
    await expect(femaQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unknown_dataset' },
    });
  });

  it('propagates invalid_filter error from service', async () => {
    const invalidFilterError = new McpError(JsonRpcErrorCode.InvalidParams, 'OData parse error', {
      reason: 'invalid_filter',
      code: 'OF_OQP_002',
    });
    await setMock({
      fetchDataset: vi.fn().mockRejectedValue(invalidFilterError),
    });
    const ctx = createMockContext({ errors: femaQueryDataset.errors });
    const input = femaQueryDataset.input.parse({
      dataset: 'DisasterDeclarationsSummaries',
      filter: 'INVALID_FIELD eq 1',
    });
    await expect(femaQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_filter' },
    });
  });

  it('service sanitizes raw parser error message into actionable text', async () => {
    // Simulate the raw error the service would have thrown before sanitization;
    // after the fix the service builds a clean message — verify it doesn't contain
    // internal position offsets or undefined codes.
    const sanitizedError = new McpError(
      JsonRpcErrorCode.InvalidParams,
      "Invalid OData $filter expression. String values must use single quotes; field names are case-sensitive. Example: state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'",
      { reason: 'invalid_filter', code: undefined, name: undefined },
    );
    await setMock({
      fetchDataset: vi.fn().mockRejectedValue(sanitizedError),
    });
    const ctx = createMockContext({ errors: femaQueryDataset.errors });
    const input = femaQueryDataset.input.parse({
      dataset: 'DisasterDeclarationsSummaries',
      filter: 'INVALID FILTER EXPRESSION',
    });
    let caught: unknown;
    try {
      await femaQueryDataset.handler(input, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    // Verify the message doesn't contain internal parse-position offsets
    const message = (caught as McpError).message;
    expect(message).not.toMatch(/at \d+/);
    expect(message).not.toContain('[undefined]');
    expect(message).toContain('$filter');
  });

  it('formats small result sets as markdown table', () => {
    const output = {
      dataset: 'DisasterDeclarationsSummaries',
      rows: [
        { disasterNumber: '4781', state: 'TX' },
        { disasterNumber: '4782', state: 'FL' },
      ],
      total_count: 2,
      returned_count: 2,
    };
    const blocks = femaQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DisasterDeclarationsSummaries');
    expect(text).toContain('disasterNumber');
    expect(text).toContain('4781');
    expect(text).toContain('TX');
  });

  it('formats empty result', () => {
    const output = {
      dataset: 'FimaNfipPolicies',
      rows: [],
      total_count: 0,
      returned_count: 0,
    };
    const blocks = femaQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FimaNfipPolicies');
    expect(text).toContain('No records');
  });
});
