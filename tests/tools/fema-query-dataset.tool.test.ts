/**
 * @fileoverview Tests for fema_query_dataset — the generic escape hatch — run through the
 * tool contract (schema → handler → format → error envelope) against the real
 * OpenFemaService, with `fetch` stubbed by bodies captured from the live OpenFEMA API.
 * @module tests/tools/fema-query-dataset.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaQueryDataset } from '@/mcp-server/tools/definitions/fema-query-dataset.tool.js';
import { initOpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  CATALOG_URL,
  calledUrls,
  catalogResponse,
  ERROR_BODIES,
  endpoint,
  envelopeResponse,
  htmlResponse,
  jsonResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

const DDS = 'DisasterDeclarationsSummaries';
const DDS_ROW = {
  disasterNumber: 4781,
  state: 'TX',
  declarationDate: '2024-09-27T00:00:00.000Z',
};

type ErrorEnvelope = {
  code: number;
  message: string;
  data: { reason?: string; code?: string; name?: string; recovery?: { hint: string } };
};

function recovery(reason: string): string {
  const entry = femaQueryDataset.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`test setup: no contract entry for reason "${reason}"`);
  return entry.recovery;
}

function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n');
}

function errorOf(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initOpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fema_query_dataset — success', () => {
  it('returns rows on both client surfaces for a v2 dataset', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [DDS_ROW], 1)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: "state eq 'TX'",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      dataset: DDS,
      rows: [DDS_ROW],
      total_count: 1,
      returned_count: 1,
    });
    const text = contentText(result);
    expect(text).toContain(`1 of 1 records`);
    expect(text).toContain('4781');
    expect(text).toContain('declarationDate');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each([
    ['FemaWebDeclarationAreas', 1],
    ['NfipClaims', 3],
    ['HazardMitigationGrantProgramDisasterSummaries', 3],
  ])('queries %s at v%i from the catalog', async (dataset, version) => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [
          endpoint(dataset, version),
          () => envelopeResponse(dataset, [{ id: 7 }], 1, `v${version}`),
        ],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset, limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ dataset, rows: [{ id: 7 }] });
    expect(calledUrls(fetchMock)[1]?.startsWith(endpoint(dataset, version))).toBe(true);
  });

  it('empty result: no rows on either surface, with an explanatory notice', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [], 0)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: "state eq 'ZZ'",
    });
    expect(result.isError).not.toBe(true);
    const notice = `No records found in dataset "${DDS}" with the given filters. Check field names and filter syntax.`;
    expect(result.structuredContent).toMatchObject({
      rows: [],
      total_count: 0,
      returned_count: 0,
      notice,
    });
    const text = contentText(result);
    expect(text).toContain('No records returned');
    expect(text).toContain(notice);
  });

  it('cap reached: returned_count equals the limit and the total discloses the rest', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...DDS_ROW, disasterNumber: 4700 + i }));
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, rows, 195)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 3 });
    expect(result.structuredContent).toMatchObject({
      total_count: 195,
      returned_count: 3,
      totalCount: 195,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('3 of 195 records');
    expect(calledUrls(fetchMock)[1]).toContain('%24top=3&%24skip=0');
  });

  it('offset past the end: empty page with the full total', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [], 195)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, offset: 5000 });
    expect(result.isError).not.toBe(true);
    const notice =
      'Offset 5000 is past the end of the 195 matching records; the last valid offset is 194.';
    expect(result.structuredContent).toMatchObject({
      rows: [],
      total_count: 195,
      returned_count: 0,
      totalCount: 195,
      notice,
    });
    const text = contentText(result);
    expect(text).toContain('0 of 195 records');
    expect(text).toContain(notice);
    expect(text).not.toMatch(/\bno\b[^.\n]*\brecords\b/i);
    expect(calledUrls(fetchMock)[1]).toContain('%24skip=5000');
  });

  it('offset exactly at the total is past the end', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [], 195)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, offset: 195 });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'last valid offset is 194',
    );
  });

  it('invalid input is rejected before any request', async () => {
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 0 });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fema_query_dataset — error contract on the wire', () => {
  function reject400(body: unknown) {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => jsonResponse(400, body)],
      ]),
    );
  }

  /** The #4 / #2 / #15 invariants on both surfaces. */
  function expectSanitized(result: Awaited<ReturnType<typeof runToolContract>>, reason: string) {
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe(reason);
    expect(error.data.recovery?.hint).toBe(recovery(reason));
    expect(error.data).not.toHaveProperty('name');
    const text = contentText(result);
    for (const surface of [error.message, text]) {
      expect(surface).not.toMatch(/at \d+/);
      expect(surface).not.toContain('[undefined]');
      expect(surface).not.toMatch(/Int32|Int16|SByte|Byte\b/);
    }
    expect(text).toContain(recovery(reason));
    expect(text).toContain(`reason ${reason}`);
    return { error, text };
  }

  it('unknown select field → invalid_select', async () => {
    reject400(ERROR_BODIES.selectUnknownField);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      select: 'disasterNumber,bogusField',
      limit: 1,
    });
    const { error } = expectSanitized(result, 'invalid_select');
    expect(error.data.code).toBe('OF_OQP_003');
    expect(error.message).toContain('select');
    expect(error.message).toContain('bogusField');
    expect(error.message).not.toContain('$filter');
  });

  it('unknown orderby field → invalid_orderby', async () => {
    reject400(ERROR_BODIES.orderbyUnknownField);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      orderby: 'bogusField desc',
      limit: 1,
    });
    const { error } = expectSanitized(result, 'invalid_orderby');
    expect(error.data.code).toBe('OF_OQP_001');
    expect(error.message).toContain('orderby');
    expect(error.message).toContain('bogusField');
  });

  it('unquoted string in a filter → invalid_filter naming the value read as a field', async () => {
    reject400(ERROR_BODIES.filterUnquotedString);
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, filter: 'state eq TX' });
    const { error } = expectSanitized(result, 'invalid_filter');
    expect(error.data.code).toBe('OF_OQP_002');
    expect(error.message).toContain('"TX"');
    expect(recovery('invalid_filter')).toContain("state eq 'TX'");
  });

  it('fyDeclared overflow → names fyDeclared, never the disaster number', async () => {
    reject400(ERROR_BODIES.filterFyDeclaredOverflow);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: 'fyDeclared eq 40000',
    });
    const { error, text } = expectSanitized(result, 'invalid_filter');
    expect(error.message).toContain('fyDeclared');
    expect(text).not.toMatch(/disaster number/i);
  });

  it('disasterNumber overflow keeps the FEMA range sentence', async () => {
    reject400(ERROR_BODIES.filterDisasterNumberOverflow);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: 'disasterNumber eq 32768',
    });
    const { error } = expectSanitized(result, 'invalid_filter');
    expect(error.message).toBe('Disaster number is outside the valid FEMA range (1–32767).');
  });

  it('untyped parser error with one expression → that expression’s reason, no upstream code', async () => {
    reject400(ERROR_BODIES.untypedUnexpectedCharacter);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: 'INVALID FILTER EXPRESSION',
    });
    const { error } = expectSanitized(result, 'invalid_filter');
    expect(error.data).not.toHaveProperty('code');
    expect(error.message).toContain('filter');
  });

  it('untyped parser error with several expressions → invalid_odata_syntax naming each', async () => {
    reject400(ERROR_BODIES.untypedFailAtZero);
    const result = await runToolContract(femaQueryDataset, {
      dataset: DDS,
      filter: 'INVALID FILTER EXPRESSION',
      select: 'disasterNumber,,',
    });
    const { error } = expectSanitized(result, 'invalid_odata_syntax');
    expect(error.data).not.toHaveProperty('code');
    expect(error.message).toContain('filter');
    expect(error.message).toContain('select');
  });

  it('a name missing from the catalog → unknown_dataset without a data request (regression #10)', async () => {
    fetchMock.mockImplementation(routeFetch([[CATALOG_URL, () => catalogResponse()]]));
    const result = await runToolContract(femaQueryDataset, { dataset: 'NotARealDataset123' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      recovery: { hint: recovery('unknown_dataset') },
    });
    const text = contentText(result);
    expect(text).toContain('NotARealDataset123');
    expect(text).not.toContain('HTML');
    expect(text).not.toContain('instead of JSON');
    expect(text).not.toMatch(/\bv2\b/);
    expect(calledUrls(fetchMock)).toHaveLength(1);
  });

  it('an HTML 404 from a listed dataset → unknown_dataset', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint('FimaNfipPolicies', 2), () => htmlResponse(404)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: 'FimaNfipPolicies' });
    expect(errorOf(result).data.reason).toBe('unknown_dataset');
  });

  it('an unreadable catalog with nothing cached → catalog_unavailable', async () => {
    fetchMock.mockImplementation(
      routeFetch([[CATALOG_URL, () => new Response('down', { status: 503 })]]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: recovery('catalog_unavailable') },
    });
    expect(contentText(result)).toContain(recovery('catalog_unavailable'));
  });
});

describe('fema_query_dataset — format', () => {
  it('renders every selected field for large (>50-row) result sets, not just the first six (regression #18)', () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      disasterNumber: 4700 + i,
      declarationTitle: 'SEVERE STORMS',
      state: 'TX',
      incidentType: 'Severe Storm',
      declarationType: 'DR',
      declarationDate: '2024-09-27T00:00:00.000Z',
      ihProgramDeclared: false,
      paProgramDeclared: true,
    }));
    const blocks = femaQueryDataset.format!({
      dataset: DDS,
      rows,
      total_count: 51,
      returned_count: 51,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ihProgramDeclared: false');
    expect(text).toContain('paProgramDeclared: true');
    expect((text.match(/paProgramDeclared: true/g) ?? []).length).toBe(51);
  });
});
