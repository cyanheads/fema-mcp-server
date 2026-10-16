/**
 * @fileoverview Tests for OpenFemaService at the network boundary — URL composition,
 * per-dataset version resolution from the OpenFEMA catalog, the catalog cache, and the
 * classification of OpenFEMA 400 bodies into the fema_query_dataset error contract.
 * `fetch` is stubbed with bodies captured from the live API; unrouted calls reject.
 * @module tests/services/openfema-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaQueryDataset } from '@/mcp-server/tools/definitions/fema-query-dataset.tool.js';
import { OpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  CATALOG_ROWS,
  CATALOG_URL,
  calledUrls,
  catalogResponse,
  cdnBadRequestResponse,
  ERROR_BODIES,
  endpoint,
  envelopeResponse,
  htmlResponse,
  jsonResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

/** The recovery hint declared for a reason on the fema_query_dataset contract. */
function contractRecovery(reason: string): string {
  const entry = femaQueryDataset.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`test setup: no contract entry for reason "${reason}"`);
  return entry.recovery;
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the call to reject');
}

const queryCtx = () => createMockContext({ errors: femaQueryDataset.errors });
const DDS = 'DisasterDeclarationsSummaries';

let fetchMock: Mock;
let svc: OpenFemaService;

beforeEach(() => {
  fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  svc = new OpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('convenience fetchers', () => {
  it('composes a %24-encoded OData URL for the pinned entity and version', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), () => envelopeResponse(DDS, [{ disasterNumber: 4781 }], 9)]]),
    );
    const result = await svc.fetchDisasters(
      { filter: "state eq 'TX'", orderby: 'declarationDate desc', top: 5, skip: 10 },
      createMockContext(),
    );
    expect(result).toEqual({ rows: [{ disasterNumber: 4781 }], count: 9 });
    expect(calledUrls(fetchMock)).toEqual([
      "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24inlinecount=allpages&%24filter=state%20eq%20'TX'&%24orderby=declarationDate%20desc&%24top=5&%24skip=10",
    ]);
  });

  it('requests each pinned entity and version without reading the catalog', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [])],
        [
          endpoint('PublicAssistanceFundedProjectsDetails', 2),
          () => envelopeResponse('PublicAssistanceFundedProjectsDetails', []),
        ],
        [
          endpoint('HousingAssistanceOwners', 2),
          () => envelopeResponse('HousingAssistanceOwners', []),
        ],
        [
          endpoint('HousingAssistanceRenters', 2),
          () => envelopeResponse('HousingAssistanceRenters', []),
        ],
        [endpoint('NfipClaims', 3), () => envelopeResponse('NfipClaims', [], 0, 'v3')],
      ]),
    );
    const ctx = createMockContext();
    await svc.fetchDisasters({ top: 1 }, ctx);
    await svc.fetchPaProjects({ top: 1 }, ctx);
    await svc.fetchHousingAssistance('HousingAssistanceOwners', { top: 1 }, ctx);
    await svc.fetchHousingAssistance('HousingAssistanceRenters', { top: 1 }, ctx);
    await svc.fetchNfipClaims({ top: 1 }, ctx);
    const urls = calledUrls(fetchMock);
    expect(urls.map((u) => u.slice(0, u.indexOf('?')))).toEqual([
      'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries',
      'https://www.fema.gov/api/open/v2/PublicAssistanceFundedProjectsDetails',
      'https://www.fema.gov/api/open/v2/HousingAssistanceOwners',
      'https://www.fema.gov/api/open/v2/HousingAssistanceRenters',
      'https://www.fema.gov/api/open/v3/NfipClaims',
    ]);
    expect(urls.some((u) => u.startsWith(CATALOG_URL))).toBe(false);
  });

  it('reads NFIP claims from the NfipClaims v3 envelope (live row shape)', async () => {
    const row = {
      state: 'TX',
      countyCode: '48201',
      reportedZipCode: '77008',
      dateOfLoss: '2026-08-28T00:00:00.000Z',
      yearOfLoss: 2026,
      amountPaidOnBuildingClaim: null,
      ratedFloodZone: 'AE',
      causeOfDamage: '4',
      occupancyType: 11,
      id: 7375147,
    };
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint('NfipClaims', 3), () => envelopeResponse('NfipClaims', [row], 58004, 'v3')],
      ]),
    );
    const result = await svc.fetchNfipClaims(
      {
        filter: "state eq 'TX' and countyCode eq '48201' and yearOfLoss ge 2017",
        orderby: 'dateOfLoss desc',
        top: 1,
      },
      createMockContext(),
    );
    expect(result).toEqual({ rows: [row], count: 58004 });
    expect(calledUrls(fetchMock)[0]).toContain('/api/open/v3/NfipClaims?');
    expect(calledUrls(fetchMock)[0]).not.toContain('FimaNfipClaims');
  });

  it('reads metadata.DeprecationInformation into deprecation, trimmed, dropping a null replacement (#51)', async () => {
    const serve = (dep: unknown) =>
      fetchMock.mockImplementation(
        routeFetch([
          [
            endpoint('NfipClaims', 3),
            () =>
              jsonResponse(200, {
                metadata: { count: 56_410, entityname: 'NfipClaims', DeprecationInformation: dep },
                NfipClaims: [],
              }),
          ],
        ]),
      );
    serve({
      depDate: '2026-10-15T00:00:00.000Z',
      depApiMessage: 'Combined with the HMA Subapplications dataset.  ',
      depNewUrl: 'https://www.fema.gov/openfema-data-page/hma-subapplications-v2',
      depWebMessage: 'Web text.',
    });
    expect(await svc.fetchNfipClaims({ top: 1 }, createMockContext())).toEqual({
      rows: [],
      count: 56_410,
      deprecation: {
        date: '2026-10-15T00:00:00.000Z',
        message: 'Combined with the HMA Subapplications dataset.',
        replacementUrl: 'https://www.fema.gov/openfema-data-page/hma-subapplications-v2',
      },
    });
    serve({
      depDate: '2026-11-09T00:00:00.000Z',
      depApiMessage: null,
      depNewUrl: null,
      depWebMessage: 'Frozen.',
    });
    expect((await svc.fetchNfipClaims({ top: 1 }, createMockContext())).deprecation).toEqual({
      date: '2026-11-09T00:00:00.000Z',
      message: 'Frozen.',
    });
    serve({ depDate: null, depApiMessage: '  ', depNewUrl: null });
    expect(await svc.fetchNfipClaims({ top: 1 }, createMockContext())).not.toHaveProperty(
      'deprecation',
    );
  });

  it('fails non-retryable HTTP responses once without exposing the query URL', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('not implemented', { status: 501 })),
    );
    const result = svc
      .fetchDisasters({ filter: "secret eq 'private'" }, createMockContext())
      .catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ retryable: false });
    expect(error.data).not.toHaveProperty('url');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled response body with the total request deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, options: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              options.signal?.addEventListener(
                'abort',
                () => controller.error(options.signal?.reason),
                { once: true },
              );
            },
          }),
        ),
      ),
    );
    let settled = false;
    const result = svc.fetchDisasters({}, createMockContext()).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(30001);
    expect(settled).toBe(true);
    const error = await result;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data.reason).toBe('retry_deadline_exceeded');
  });

  it('ends a disaster request at a caller deadline shorter than the configured timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        ),
    );
    let settled = false;
    const result = svc
      .fetchDisasters({}, createMockContext(), { deadlineMs: 5_000 })
      .catch((error) => {
        settled = true;
        return error;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    const error = await result;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 5_000 });
  });

  it('ends a disaster request the moment its caller signal aborts, without a retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        ),
    );
    const controller = new AbortController();
    const ctx = createMockContext();
    let settled = false;
    const result = svc.fetchDisasters({}, ctx, { signal: controller.signal }).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const error = await result;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The caller signal is the request's own: the context's signal stays live.
    expect(ctx.signal.aborted).toBe(false);
  });

  it('maps an HTML 404 and an HTML 400 to unknown_dataset', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(htmlResponse(404)));
    fetchMock.mockImplementationOnce(() => Promise.resolve(htmlResponse(400)));
    for (const _ of [404, 400]) {
      const error = await rejection(svc.fetchDisasters({ top: 1 }, createMockContext()));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'unknown_dataset', dataset: DDS });
      expect(error.message).toBe(`Dataset "${DDS}" was not found at OpenFEMA.`);
      expect(error.message).not.toContain('HTML');
    }
  });

  it('keeps the framework classification for a non-JSON 400 body', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('bad request', { status: 400, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    const error = await rejection(svc.fetchDisasters({ top: 1 }, createMockContext()));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).not.toHaveProperty('reason');
  });

  it('reports an out-of-range disaster number from any tool with the FEMA range sentence', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(400, ERROR_BODIES.filterDisasterNumberOverflow)),
    );
    const error = await rejection(
      svc.fetchPaProjects({ filter: 'disasterNumber eq 40000' }, createMockContext()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('Disaster number is outside the valid FEMA range (1–32767).');
    expect(error.data).toMatchObject({ reason: 'invalid_filter', code: 'OF_OQP_002' });
  });
});

describe('oversized and over-nested requests (#48)', () => {
  /** A `substringof` filter whose `fetchDisasters({ filter, top: 1 })` URL is `length` characters. */
  function filterOfUrlLength(length: number): string {
    const filter = (n: number) => `substringof('${'a'.repeat(n)}',designatedArea)`;
    const base = `${endpoint(DDS, 2)}%24inlinecount=allpages&%24filter=${encodeURIComponent(filter(0))}&%24top=1`;
    return filter(length - base.length);
  }

  const orChain = (n: number) =>
    Array.from({ length: n }, (_, i) => `disasterNumber eq ${4000 + i}`).join(' or ');

  it.each([
    [8_000, 'unknown_dataset'],
    [8_001, 'request_too_long'],
  ])('an HTML 400 for a %i-character URL → %s', async (length, reason) => {
    fetchMock.mockImplementation(() => Promise.resolve(cdnBadRequestResponse()));
    const error = await rejection(
      svc.fetchDisasters({ filter: filterOfUrlLength(length), top: 1 }, createMockContext()),
    );
    expect(calledUrls(fetchMock).map((url) => url.length)).toEqual([length]);
    expect(error.data).toMatchObject({ reason });
  });

  it('a URL past the CDN limit → request_too_long naming its length and the limit, not retried', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(cdnBadRequestResponse()));
    const error = await rejection(
      svc.fetchDisasters({ filter: filterOfUrlLength(15_138), top: 1 }, createMockContext()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({ reason: 'request_too_long', urlLength: 15_138 });
    expect(error.message).toBe(
      'OpenFEMA refused the request: its URL is 15,138 characters long, past the roughly 8,900 characters OpenFEMA accepts.',
    );
    expect(error.message).not.toMatch(/Bad Request|not found|catalog/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [8_001, '8,001', 'close to'],
    [8_900, '8,900', 'close to'],
    [8_901, '8,901', 'past'],
  ])(
    'a refused URL of %i characters is reported as %s characters, %s the roughly 8,900 accepted',
    async (length, shown, relation) => {
      fetchMock.mockImplementation(() => Promise.resolve(cdnBadRequestResponse()));
      const error = await rejection(
        svc.fetchDisasters({ filter: filterOfUrlLength(length), top: 1 }, createMockContext()),
      );
      expect(error.data).toEqual({ reason: 'request_too_long', urlLength: length });
      expect(error.message).toBe(
        `OpenFEMA refused the request: its URL is ${shown} characters long, ${relation} the roughly 8,900 characters OpenFEMA accepts.`,
      );
    },
  );

  it('a long URL to a catalog-listed dataset carries the request_too_long contract hint', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => cdnBadRequestResponse()],
      ]),
    );
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: filterOfUrlLength(15_138), top: 1 }, queryCtx()),
    );
    expect(error.data).toMatchObject({
      reason: 'request_too_long',
      recovery: { hint: contractRecovery('request_too_long') },
    });
    expect(contractRecovery('request_too_long')).toMatch(/in \(/);
  });

  it('a listed dataset that answers a long URL with its 404 page is still dataset_not_served', async () => {
    const dataset = 'PublicAssistanceProjectsStatus';
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(dataset, 1), () => htmlResponse(404)],
      ]),
    );
    const error = await rejection(
      svc.fetchDataset(dataset, { filter: 'x'.repeat(9_000), top: 1 }, queryCtx()),
    );
    expect(error.data).toMatchObject({ reason: 'dataset_not_served', dataset });
  });

  it('a filter past the nesting limit → filter_too_complex naming the limit, no upstream text', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => jsonResponse(400, ERROR_BODIES.filterTooDeep)],
      ]),
    );
    const error = await rejection(svc.fetchDataset(DDS, { filter: orChain(100) }, queryCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({
      reason: 'filter_too_complex',
      code: 'OF_OQP_000',
      recovery: { hint: contractRecovery('filter_too_complex') },
    });
    expect(error.message).toBe(
      'Invalid filter: the expression nests more than 100 levels deep, the most OpenFEMA allows. Every and/or adds a level, so a filter holds at most about 90 chained comparisons.',
    );
    expect(error.message).not.toMatch(/Query too complex|could not parse|quote/i);
    expect(contractRecovery('filter_too_complex')).toMatch(/in \(/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('every convenience fetcher inherits filter_too_complex', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(400, ERROR_BODIES.filterTooDeep)),
    );
    const error = await rejection(
      svc.fetchPaProjects({ filter: orChain(100) }, createMockContext()),
    );
    expect(error.data).toMatchObject({ reason: 'filter_too_complex', code: 'OF_OQP_000' });
  });

  it('an OF_OQP_000 with any other message keeps the parse-error classification', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(400, {
          error: [{ ...ERROR_BODIES.filterTooDeep.error[0], message: 'Something else' }],
        }),
      ),
    );
    const error = await rejection(svc.fetchDisasters({ filter: 'x eq 1' }, createMockContext()));
    expect(error.data).toMatchObject({ reason: 'invalid_filter' });
    expect(error.message).toBe('Invalid filter: OpenFEMA could not parse the expression.');
  });
});

describe('fetchDataset — OpenFEMA 400 classification', () => {
  /** Route the catalog plus a 400 body for the DisasterDeclarationsSummaries data request. */
  function reject400(body: unknown) {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => jsonResponse(400, body)],
      ]),
    );
  }

  /** Invariants every classified 400 keeps (#4, #2, #15). */
  function expectSanitized(error: McpError) {
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).not.toMatch(/at \d+/);
    expect(error.message).not.toContain('[undefined]');
    expect(error.message).not.toMatch(/Int32|Int16|Int64|SByte|Byte\b/);
    expect(error.data).not.toHaveProperty('name');
  }

  it('an unknown select field → invalid_select naming select and the field', async () => {
    reject400(ERROR_BODIES.selectUnknownField);
    const error = await rejection(
      svc.fetchDataset(DDS, { select: 'disasterNumber,bogusField', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({
      reason: 'invalid_select',
      code: 'OF_OQP_003',
      recovery: { hint: contractRecovery('invalid_select') },
    });
    expect(error.message).toContain('select');
    expect(error.message).toContain('"bogusField"');
    expect(error.message).not.toContain('filter');
  });

  it('an unknown orderby field → invalid_orderby naming orderby and the field', async () => {
    reject400(ERROR_BODIES.orderbyUnknownField);
    const error = await rejection(
      svc.fetchDataset(DDS, { orderby: 'bogusField desc', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({
      reason: 'invalid_orderby',
      code: 'OF_OQP_001',
      recovery: { hint: contractRecovery('invalid_orderby') },
    });
    expect(error.message).toContain('orderby');
    expect(error.message).toContain('"bogusField"');
    expect(error.message).not.toContain('filter');
  });

  it('an unknown filter field → invalid_filter naming the field, with quoting guidance', async () => {
    reject400(ERROR_BODIES.filterUnknownField);
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: 'bogusField eq 1', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({
      reason: 'invalid_filter',
      code: 'OF_OQP_002',
      recovery: { hint: contractRecovery('invalid_filter') },
    });
    expect(error.message).toContain('filter');
    expect(error.message).toContain('"bogusField"');
    expect(contractRecovery('invalid_filter')).toMatch(/single quotes/);
  });

  it('an unquoted string value reads as an unknown field and names it', async () => {
    reject400(ERROR_BODIES.filterUnquotedString);
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: 'state eq TX', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({ reason: 'invalid_filter' });
    expect(error.message).toContain('"TX"');
    expect(error.message).toMatch(/quote/i);
  });

  it('an Int16 overflow on a non-disaster field names that field, not the disaster number', async () => {
    reject400(ERROR_BODIES.filterFyDeclaredOverflow);
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: 'fyDeclared eq 40000', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({ reason: 'invalid_filter', code: 'OF_OQP_002' });
    expect(error.message).toContain('"fyDeclared"');
    expect(error.message).toContain('32767');
    expect(error.message).not.toMatch(/disaster number/i);
  });

  it('an Int16 overflow on a nullable field is still reported as a range error', async () => {
    reject400(ERROR_BODIES.filterYearOfLossOverflow);
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: 'yearOfLoss eq 40000', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.message).toContain('"yearOfLoss"');
    expect(error.message).toContain('32767');
  });

  it('disasterNumber overflow keeps the FEMA range sentence', async () => {
    reject400(ERROR_BODIES.filterDisasterNumberOverflow);
    const error = await rejection(
      svc.fetchDataset(DDS, { filter: 'disasterNumber eq 32768', top: 1 }, queryCtx()),
    );
    expectSanitized(error);
    expect(error.message).toBe('Disaster number is outside the valid FEMA range (1–32767).');
    expect(error.data).toMatchObject({
      reason: 'invalid_filter',
      recovery: { hint: contractRecovery('invalid_filter') },
    });
  });

  it.each([
    ['a number compared with a text field', ERROR_BODIES.filterNumberForText, 'state', /quote/i],
    [
      'a string compared with a numeric field',
      ERROR_BODIES.filterTextForNumber,
      'disasterNumber',
      /unquoted number/i,
    ],
    [
      'a number compared with a date field',
      ERROR_BODIES.filterNumberForDate,
      'declarationDate',
      /ISO 8601/,
    ],
    [
      'a number too large for Byte compared with a text field',
      ERROR_BODIES.filterLargeNumberForText,
      'state',
      /quote/i,
    ],
    [
      'a number too large for Byte compared with a true/false field',
      ERROR_BODIES.filterLargeNumberForBoolean,
      'iaProgramDeclared',
      /true or false/,
    ],
    ['a number compared with a GUID field', ERROR_BODIES.filterNumberForGuid, 'id', /GUID/],
    [
      'a decimal compared with an integer field',
      ERROR_BODIES.filterDecimalForInteger,
      'fyDeclared',
      /whole number/i,
    ],
  ])(
    '%s → a type message keyed on the field, never a range message',
    async (_label, body, field, guidance) => {
      reject400(body);
      const error = await rejection(svc.fetchDataset(DDS, { filter: 'x', top: 1 }, queryCtx()));
      expectSanitized(error);
      expect(error.data).toMatchObject({ reason: 'invalid_filter', code: 'OF_OQP_002' });
      expect(error.message).toContain(`"${field}"`);
      expect(error.message).toMatch(guidance);
      expect(error.message).not.toMatch(/outside the/);
    },
  );

  it.each([
    [
      'a quoted value that is not a date',
      ERROR_BODIES.filterInvalidDate,
      'declarationDate',
      /ISO 8601/,
    ],
    ['a quoted value that is not a GUID', ERROR_BODIES.filterInvalidUuid, 'id', /GUID/],
  ])(
    '%s → invalid_filter naming the field OpenFEMA names',
    async (_label, body, field, guidance) => {
      reject400(body);
      const error = await rejection(svc.fetchDataset(DDS, { filter: 'x', top: 1 }, queryCtx()));
      expectSanitized(error);
      expect(error.data).toMatchObject({
        reason: 'invalid_filter',
        code: 'OF_OQP_002',
        recovery: { hint: contractRecovery('invalid_filter') },
      });
      expect(error.message).toContain(`"${field}"`);
      expect(error.message).toMatch(guidance);
      expect(error.message).not.toMatch(/UUID|Invalid date/);
    },
  );

  it.each([
    [
      'filter',
      { filter: 'INVALID FILTER EXPRESSION' },
      ERROR_BODIES.untypedUnexpectedCharacter,
      'invalid_filter',
    ],
    ['select', { select: 'disasterNumber,,' }, ERROR_BODIES.untypedFailAtZero, 'invalid_select'],
    [
      'orderby',
      { orderby: 'declarationDate sideways' },
      ERROR_BODIES.untypedFailAtZero,
      'invalid_orderby',
    ],
  ])(
    'an untyped parser error with only %s supplied takes that reason',
    async (param, opts, body, reason) => {
      reject400(body);
      const error = await rejection(svc.fetchDataset(DDS, { ...opts, top: 1 }, queryCtx()));
      expectSanitized(error);
      expect(error.data).toMatchObject({ reason, recovery: { hint: contractRecovery(reason) } });
      expect(error.data).not.toHaveProperty('code');
      expect(error.message).toContain(param);
    },
  );

  it('an untyped parser error with several expressions supplied → invalid_odata_syntax naming each', async () => {
    reject400(ERROR_BODIES.untypedFailAtZero);
    const error = await rejection(
      svc.fetchDataset(
        DDS,
        { filter: 'INVALID FILTER EXPRESSION', select: 'disasterNumber,,', orderby: 'x', top: 1 },
        queryCtx(),
      ),
    );
    expectSanitized(error);
    expect(error.data).toMatchObject({
      reason: 'invalid_odata_syntax',
      recovery: { hint: contractRecovery('invalid_odata_syntax') },
    });
    expect(error.data).not.toHaveProperty('code');
    for (const param of ['filter', 'select', 'orderby']) expect(error.message).toContain(param);
  });
});

describe('fetchDataset — catalog version resolution', () => {
  /**
   * Route the catalog read plus one data request. The data route matches on its query prefix
   * (the catalog read sends `$select` there, a data request `$top`) and comes first, so an
   * `OpenFemaDataSets` data request is not answered as the catalog read.
   */
  function routeCatalogAnd(entity: string, version: number, rows: unknown[] = [{ id: 1 }]) {
    fetchMock.mockImplementation(
      routeFetch([
        [
          `${endpoint(entity, version)}%24inlinecount=allpages&%24top=`,
          () => envelopeResponse(entity, rows, rows.length, `v${version}`),
        ],
        [CATALOG_URL, () => catalogResponse()],
      ]),
    );
  }

  it.each([
    ['FemaWebDeclarationAreas', 1],
    ['PublicAssistanceApplicants', 1],
    ['IndividualAssistanceHousingRegistrantsLargeDisasters', 1],
    ['NfipClaims', 3],
    ['DisasterDeclarationsSummaries', 2],
    ['HazardMitigationGrantProgramDisasterSummaries', 3],
    ['OpenFemaDataSetFields', 1],
  ])('resolves %s to v%i', async (entity, version) => {
    routeCatalogAnd(entity, version);
    await expect(svc.fetchDataset(entity, { top: 1 }, queryCtx())).resolves.toEqual({
      rows: [{ id: 1 }],
      count: 1,
    });
    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      'https://www.fema.gov/api/open/v1/OpenFemaDataSets?%24inlinecount=allpages&%24select=name%2Cversion%2CwebService%2CdataDictionary&%24top=1000',
    );
    expect(urls[1]?.startsWith(endpoint(entity, version))).toBe(true);
  });

  it('takes the highest listed version regardless of catalog order', async () => {
    const reversed = [...CATALOG_ROWS].reverse();
    const entity = 'HazardMitigationGrantProgramDisasterSummaries';
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse(reversed)],
        [endpoint(entity, 3), () => envelopeResponse(entity, [])],
      ]),
    );
    await svc.fetchDataset(entity, { top: 1 }, queryCtx());
    expect(calledUrls(fetchMock)[1]?.startsWith(endpoint(entity, 3))).toBe(true);
  });

  it.each([
    ['DataSetFields', 'the catalog name of the OpenFemaDataSetFields path'],
    ['DataSets', 'the catalog’s own entry'],
    ['OpenFemaDataSets', 'the catalog endpoint, listed as DataSets'],
  ])('resolves %s (%s) to v1 and reads the envelope keyed by that name', async (entity) => {
    routeCatalogAnd(entity, 1);
    await expect(svc.fetchDataset(entity, { top: 1 }, queryCtx())).resolves.toEqual({
      rows: [{ id: 1 }],
      count: 1,
    });
    expect(calledUrls(fetchMock)[1]?.startsWith(endpoint(entity, 1))).toBe(true);
  });

  it.each([
    ['datasetfields', 'DataSetFields'],
    ['openfemadatasets', 'OpenFemaDataSets'],
  ])(
    'suggests the catalog spelling %s → %s for a case-only mismatch on an alias',
    async (typed, suggested) => {
      fetchMock.mockImplementation(routeFetch([[CATALOG_URL, () => catalogResponse()]]));
      const error = await rejection(svc.fetchDataset(typed, { top: 1 }, queryCtx()));
      expect(error.data).toMatchObject({ reason: 'unknown_dataset' });
      expect(error.message).toContain(`"${suggested}"`);
      expect(calledUrls(fetchMock)).toHaveLength(1);
    },
  );

  it('a name absent from the catalog → unknown_dataset with no data request', async () => {
    fetchMock.mockImplementation(routeFetch([[CATALOG_URL, () => catalogResponse()]]));
    const error = await rejection(svc.fetchDataset('NotARealDataset123', { top: 1 }, queryCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      dataset: 'NotARealDataset123',
      recovery: { hint: contractRecovery('unknown_dataset') },
    });
    expect(error.message).toContain('NotARealDataset123');
    expect(error.message).not.toMatch(/\bv2\b/);
    expect(error.message).not.toContain('FimaNfipClaims');
    expect(calledUrls(fetchMock)).toEqual([
      expect.stringMatching(/^https:\/\/www\.fema\.gov\/api\/open\/v1\/OpenFemaDataSets\?/),
    ]);
  });

  it('suggests the catalog spelling for a case-only mismatch', async () => {
    fetchMock.mockImplementation(routeFetch([[CATALOG_URL, () => catalogResponse()]]));
    const error = await rejection(svc.fetchDataset('nfipclaims', { top: 1 }, queryCtx()));
    expect(error.data).toMatchObject({ reason: 'unknown_dataset' });
    expect(error.message).toContain('"NfipClaims"');
  });

  it.each([
    ['an HTML 404', () => htmlResponse(404)],
    ['an HTML 400', () => htmlResponse(400)],
    ['an HTML 200', () => htmlResponse(200)],
  ])(
    'a catalog-listed dataset whose endpoint answers %s → dataset_not_served, with no spelling advice',
    async (_label, respond) => {
      const dataset = 'PublicAssistanceProjectsStatus';
      fetchMock.mockImplementation(
        routeFetch([
          [CATALOG_URL, () => catalogResponse()],
          [endpoint(dataset, 1), respond],
        ]),
      );
      const error = await rejection(svc.fetchDataset(dataset, { top: 1 }, queryCtx()));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({
        reason: 'dataset_not_served',
        dataset,
        recovery: { hint: contractRecovery('dataset_not_served') },
      });
      expect(error.message).toContain(dataset);
      expect(error.message).toMatch(/catalog/);
      for (const text of [error.message, contractRecovery('dataset_not_served')]) {
        expect(text).not.toMatch(/spell|case-sensitive|Did you mean/i);
      }
      // Not retried: one catalog read, one data request.
      expect(calledUrls(fetchMock)).toHaveLength(2);
    },
  );

  it('an HTML 404 from OpenFemaDataSets, which the catalog lists only as DataSets → unknown_dataset', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [
          `${endpoint('OpenFemaDataSets', 1)}%24inlinecount=allpages&%24top=`,
          () => htmlResponse(404),
        ],
        [CATALOG_URL, () => catalogResponse()],
      ]),
    );
    const error = await rejection(svc.fetchDataset('OpenFemaDataSets', { top: 1 }, queryCtx()));
    expect(error.data).toMatchObject({ reason: 'unknown_dataset', dataset: 'OpenFemaDataSets' });
    expect(error.message).toBe('Dataset "OpenFemaDataSets" was not found at OpenFEMA.');
  });

  it('two calls inside one cache window make one catalog request', async () => {
    routeCatalogAnd(DDS, 2);
    const ctx = queryCtx();
    await svc.fetchDataset(DDS, { top: 1 }, ctx);
    await svc.fetchDataset(DDS, { top: 1 }, ctx);
    const catalogCalls = calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL));
    expect(catalogCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('concurrent calls during a refresh share one in-flight catalog request', async () => {
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    fetchMock.mockImplementation(
      routeFetch([
        [
          CATALOG_URL,
          async () => {
            await catalogGate;
            return catalogResponse();
          },
        ],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [{ id: 1 }])],
        [endpoint('NfipClaims', 3), () => envelopeResponse('NfipClaims', [{ id: 2 }])],
      ]),
    );
    const first = svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    const second = svc.fetchDataset('NfipClaims', { top: 1 }, queryCtx());
    const third = svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    await Promise.resolve();
    releaseCatalog();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    const catalogCalls = calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL));
    expect(catalogCalls).toHaveLength(1);
  });

  it('refreshes the catalog once the 6-hour window has passed', async () => {
    vi.useFakeTimers();
    routeCatalogAnd(DDS, 2);
    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1);
    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(2);
  });

  it('a failed refresh reuses the previous map and backs off before trying again', async () => {
    vi.useFakeTimers();
    routeCatalogAnd(DDS, 2);
    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);

    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => new Response('upstream down', { status: 503 })],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, [{ id: 9 }])],
      ]),
    );
    fetchMock.mockClear();
    await expect(svc.fetchDataset(DDS, { top: 1 }, queryCtx())).resolves.toEqual({
      rows: [{ id: 9 }],
      count: 1,
    });
    // One catalog attempt (no retries), then the data request against the previous map.
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(1);

    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await svc.fetchDataset(DDS, { top: 1 }, queryCtx());
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(2);
  });

  it('with no map yet, a failed catalog read is ServiceUnavailable and the next call retries', async () => {
    fetchMock.mockImplementation(
      routeFetch([[CATALOG_URL, () => new Response('upstream down', { status: 503 })]]),
    );
    const error = await rejection(svc.fetchDataset(DDS, { top: 1 }, queryCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      dataset: DDS,
      recovery: { hint: contractRecovery('catalog_unavailable') },
    });
    expect(calledUrls(fetchMock)).toHaveLength(1);

    routeCatalogAnd(DDS, 2);
    await expect(svc.fetchDataset(DDS, { top: 1 }, queryCtx())).resolves.toMatchObject({
      count: 1,
    });
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(CATALOG_URL))).toHaveLength(2);
  });

  it('treats a catalog with no usable rows as unavailable', async () => {
    fetchMock.mockImplementation(
      routeFetch([[CATALOG_URL, () => catalogResponse([{ name: 'X', version: 'two' }])]]),
    );
    const error = await rejection(svc.fetchDataset(DDS, { top: 1 }, queryCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'catalog_unavailable' });
  });
});
