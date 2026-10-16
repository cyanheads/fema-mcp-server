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

  it.each([
    ['OpenFemaDataSets', 'name'],
    ['DataSets', 'name'],
    ['DataSetFields', 'name'],
    ['OpenFemaDataSetFields', 'name'],
  ])(
    'returns rows for the metadata dataset %s at v1 on both surfaces (#33)',
    async (dataset, field) => {
      fetchMock.mockImplementation(
        routeFetch([
          // Ahead of the catalog route: the data request's query starts with $top, the catalog read's with $select.
          [
            `${endpoint(dataset, 1)}%24inlinecount=allpages&%24top=`,
            () => envelopeResponse(dataset, [{ [field]: 'NfipClaims' }], 78, 'v1'),
          ],
          [CATALOG_URL, () => catalogResponse()],
        ]),
      );
      const result = await runToolContract(femaQueryDataset, { dataset, limit: 1 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        dataset,
        rows: [{ name: 'NfipClaims' }],
        total_count: 78,
        returned_count: 1,
      });
      const text = contentText(result);
      expect(text).toContain(`1 of 78 records`);
      expect(text).toContain('NfipClaims');
      expect(calledUrls(fetchMock)[1]?.startsWith(endpoint(dataset, 1))).toBe(true);
    },
  );

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
      next_offset: 3,
      notice:
        'Returned 3 of the 195 matching records from offset 0, as many as limit allows; continue with offset 3.',
    });
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

  it('a case-only mismatch → unknown_dataset suggesting the catalog spelling, with no data request', async () => {
    fetchMock.mockImplementation(routeFetch([[CATALOG_URL, () => catalogResponse()]]));
    const result = await runToolContract(femaQueryDataset, { dataset: 'nfipClaims' });
    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      recovery: { hint: recovery('unknown_dataset') },
    });
    expect(error.message).toContain('Did you mean "NfipClaims"?');
    expect(contentText(result)).toContain('Did you mean "NfipClaims"?');
    expect(calledUrls(fetchMock)).toHaveLength(1);
  });

  it('an HTML 404 from a catalog-listed dataset → dataset_not_served on both surfaces (#33)', async () => {
    const dataset = 'PublicAssistanceProjectsStatus';
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(dataset, 1), () => htmlResponse(404)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset, limit: 1 });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'dataset_not_served',
      recovery: { hint: recovery('dataset_not_served') },
    });
    const text = contentText(result);
    expect(text).toContain(dataset);
    expect(text).toContain(recovery('dataset_not_served'));
    expect(text).toContain('reason dataset_not_served');
    for (const surface of [error.message, text]) {
      expect(surface).not.toMatch(/spell|case-sensitive|Did you mean|HTML/i);
    }
  });

  it('declares dataset_not_served and narrows unknown_dataset to names missing from the catalog', () => {
    const entry = (reason: string) => femaQueryDataset.errors?.find((e) => e.reason === reason);
    expect(entry('dataset_not_served')).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
    });
    expect(entry('dataset_not_served')).not.toHaveProperty('retryable');
    expect(entry('unknown_dataset')?.when).not.toMatch(/endpoint/i);
  });

  /** The issue's reproductions: 45 long substringof clauses (~15,000 characters), 100 or-joined comparisons. */
  const longFilter = Array.from(
    { length: 45 },
    () => `substringof('${'a'.repeat(300)}',designatedArea)`,
  ).join(' or ');
  const deepFilter = Array.from({ length: 100 }, (_, i) => `disasterNumber eq ${4000 + i}`).join(
    ' or ',
  );

  it('an over-long filter → request_too_long on both surfaces, never dataset_not_served (#48)', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => cdnBadRequestResponse()],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, filter: longFilter });
    const { error, text } = expectSanitized(result, 'request_too_long');
    expect(error.message).toMatch(
      /^OpenFEMA refused the request: its URL is [\d,]+ characters long/,
    );
    expect(text).toContain('8,900 characters');
    expect(text).toContain("in ('a','b')");
    for (const surface of [error.message, text]) {
      expect(surface).not.toMatch(/not serve|not found|catalog|Bad Request/i);
    }
  });

  it('an over-nested filter → filter_too_complex on both surfaces, not a quoting hint (#48)', async () => {
    reject400(ERROR_BODIES.filterTooDeep);
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, filter: deepFilter });
    const { error, text } = expectSanitized(result, 'filter_too_complex');
    expect(error.data.code).toBe('OF_OQP_000');
    expect(text).toContain('100 levels deep');
    expect(text).toContain("in ('a','b','c')");
    for (const surface of [error.message, text]) {
      expect(surface).not.toMatch(/could not parse|single quotes|Query too complex/i);
    }
  });

  it('declares request_too_long and filter_too_complex as service-thrown input errors (#48)', () => {
    for (const reason of ['request_too_long', 'filter_too_complex']) {
      expect(femaQueryDataset.errors?.find((e) => e.reason === reason)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
      });
    }
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

/** Markdown table lines of a `content[]` text: every line that opens with a cell boundary. */
function tableLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('| '));
}

/** Cells of one table line, split on unescaped pipes. */
function cellsOf(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1);
}

describe('fema_query_dataset — format', () => {
  it('renders a page of scalar records as one header, one separator, and one line per record', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [
          endpoint(DDS, 2),
          () => envelopeResponse(DDS, [DDS_ROW, { ...DDS_ROW, disasterNumber: 4782 }], 2),
        ],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 2 });
    expect(tableLines(contentText(result))).toEqual([
      '| disasterNumber | state | declarationDate |',
      '| --- | --- | --- |',
      '| 4781 | TX | 2024-09-27T00:00:00.000Z |',
      '| 4782 | TX | 2024-09-27T00:00:00.000Z |',
    ]);
  });

  it('renders nested values as compact JSON, null and "" as distinct cells, and keeps one line per record (#43)', async () => {
    const row = {
      name: 'NfipClaims',
      distribution: [
        { format: 'csv', accessURL: 'https://example.test/claims.csv' },
        { format: 'parquet', accessURL: 'https://example.test/claims.parquet' },
      ],
      keyword: ['NFIP', 'claims', 'flood insurance'],
      license: null,
      title: '',
      description: 'Paragraph one.\r\n\r\nPara | two.\nThree.\rFour',
      version: 3,
      api: true,
    };
    fetchMock.mockImplementation(
      routeFetch([
        // Ahead of the catalog route: only the data request carries this $filter.
        [
          `${endpoint('OpenFemaDataSets', 1)}%24inlinecount=allpages&%24filter=`,
          () => envelopeResponse('OpenFemaDataSets', [row], 1, 'v1'),
        ],
        [CATALOG_URL, () => catalogResponse()],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, {
      dataset: 'OpenFemaDataSets',
      filter: "name eq 'NfipClaims'",
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify((result.structuredContent as { rows: unknown[] }).rows)).toBe(
      JSON.stringify([row]),
    );
    const lines = tableLines(contentText(result));
    expect(lines).toEqual([
      '| name | distribution | keyword | license | title | description | version | api |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| NfipClaims | [{"format":"csv","accessURL":"https://example.test/claims.csv"},{"format":"parquet","accessURL":"https://example.test/claims.parquet"}] | ["NFIP","claims","flood insurance"] | null | "" | Paragraph one.  Para \\| two. Three. Four | 3 | true |',
    ]);
    expect(contentText(result)).not.toContain('[object Object]');
  });

  it('renders a page of more than 50 records as the same table, with every selected field (#43, regression #18)', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      identifier: `urn:oid:2.49.0.1.840.0.${i}`,
      code: ['IPAWSv1.0'],
      note: null,
      info: [{ category: ['Met'], event: 'Flood Warning', ihProgramDeclared: false }],
      paProgramDeclared: true,
    }));
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [endpoint(DDS, 2), () => envelopeResponse(DDS, rows, 51)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 51 });
    expect(JSON.stringify((result.structuredContent as { rows: unknown[] }).rows)).toBe(
      JSON.stringify(rows),
    );
    const text = contentText(result);
    const lines = tableLines(text);
    expect(lines).toHaveLength(53);
    expect(lines[0]).toBe('| identifier | code | note | info | paProgramDeclared |');
    expect(lines.slice(2)).toEqual(
      rows.map(
        (r) =>
          `| ${r.identifier} | ["IPAWSv1.0"] | null | [{"category":["Met"],"event":"Flood Warning","ihProgramDeclared":false}] | true |`,
      ),
    );
    for (const line of lines) expect(cellsOf(line)).toHaveLength(5);
    expect(text).not.toContain('[object Object]');
    expect(text).not.toContain('note: null');
  });

  it('escapes a pipe or line break in a field name so the header keeps one cell per field (#43)', () => {
    const blocks = femaQueryDataset.format!({
      dataset: DDS,
      rows: [{ 'a|b': 1, 'c\nd': 2 }],
      total_count: 1,
      returned_count: 1,
    });
    const lines = tableLines((blocks[0] as { text: string }).text);
    expect(lines).toEqual(['| a\\|b | c d |', '| --- | --- |', '| 1 | 2 |']);
    for (const line of lines) expect(cellsOf(line)).toHaveLength(2);
  });
});

const BUDGET = 100_000;
/** Records the first upstream read of a page asks for when limit allows more. */
const READ_CHUNK = 500;

/** Record `i` of a wide match; `id` identifies it. */
const wideRow = (i: number, width = 300) => ({ id: i, note: 'n'.repeat(width), state: 'TX' });

/** Record `i` of a match whose table line outweighs its JSON: each `|` renders escaped as `\|`. */
const pipeRow = (i: number) => ({ id: i, note: '|'.repeat(300), state: 'TX' });

const queryParam = (url: string, name: string) => {
  const raw = new RegExp(`%24${name}=([^&]*)`).exec(url)?.[1];
  return raw === undefined ? undefined : Number(decodeURIComponent(raw));
};

/** Serve DisasterDeclarationsSummaries as an ordered match of `total` records paged by $skip/$top. */
function serveMatch(total: number, row: (i: number) => object = wideRow) {
  fetchMock.mockImplementation(
    routeFetch([
      [CATALOG_URL, () => catalogResponse()],
      [
        endpoint(DDS, 2),
        (url) => {
          const skip = queryParam(url, 'skip') ?? 0;
          const top = queryParam(url, 'top') ?? 1000;
          const size = Math.max(0, Math.min(top, total - skip));
          return envelopeResponse(
            DDS,
            Array.from({ length: size }, (_, k) => row(skip + k)),
            total,
          );
        },
      ],
    ]),
  );
}

type PageOut = {
  rows: Array<{ id: number }>;
  returned_count: number;
  total_count: number;
  next_offset?: number;
  notice?: string;
};
const page = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.structuredContent as unknown as PageOut;

/** Characters the rows of a page take on each surface: their JSON, and their table lines. */
function rowSurfaces(result: Awaited<ReturnType<typeof runToolContract>>) {
  const rows = page(result).rows;
  const rowLines = tableLines(contentText(result)).slice(2);
  return {
    json: rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0),
    text: rowLines.reduce((n, line) => n + line.length + 1, 0),
    lines: rowLines.length,
  };
}

describe('fema_query_dataset — response budget and next_offset (#46)', () => {
  it('cuts a 10,000-row page to whole rows within 100,000 characters on each surface', async () => {
    serveMatch(70_567, pipeRow);
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000 });
    expect(result.isError).not.toBe(true);
    const o = page(result);
    // A piped row's table line is longer than its JSON: | 0 | \|\|… | TX | vs {"id":0,"note":"||…","state":"TX"}.
    const line = (i: number) => `| ${i} | ${'\\|'.repeat(300)} | TX |`;
    expect(line(0).length).toBeGreaterThan(JSON.stringify(pipeRow(0)).length);
    const charge = (i: number) => Math.max(JSON.stringify(pipeRow(i)).length, line(i).length) + 2;
    let fit = 0;
    let used = 0;
    while (used + charge(fit) <= BUDGET) used += charge(fit++);
    expect(o.returned_count).toBe(fit);
    expect(o.rows.map((r) => r.id)).toEqual(Array.from({ length: fit }, (_, i) => i));
    expect(o.total_count).toBe(70_567);
    expect(o.next_offset).toBe(fit);
    const surfaces = rowSurfaces(result);
    expect(surfaces.lines).toBe(fit);
    expect(surfaces.json).toBeLessThanOrEqual(BUDGET);
    expect(surfaces.text).toBeLessThanOrEqual(BUDGET);
    const notice = `Returned ${fit} of the 70567 matching records from offset 0, the most that fit the 100,000-character response budget; continue with offset ${fit}.`;
    expect(o.notice).toBe(notice);
    expect(contentText(result)).toContain(notice);
    expect(contentText(result)).toContain(`**Next offset:** ${fit}`);
  });

  it('keeps a page whose rows charge exactly the budget, and cuts the row past it', async () => {
    // 4 rows of charge 25,000: JSON {"id":N,"note":"…"} of 24,998 characters each.
    const exact = (i: number) => ({
      id: i,
      note: 'x'.repeat(24_998 - `{"id":${i},"note":""}`.length),
    });
    expect(JSON.stringify(exact(3)).length + 2).toBe(25_000);
    serveMatch(5, exact);
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 5 });
    expect(page(result).returned_count).toBe(4);
    expect(page(result).next_offset).toBe(4);
    serveMatch(4, exact);
    const whole = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 5 });
    expect(page(whole).returned_count).toBe(4);
    expect(page(whole).next_offset).toBeUndefined();
    expect(page(whole).notice).toBeUndefined();
  });

  it('returns a single record over the budget alone, with the next offset', async () => {
    serveMatch(3, (i) => wideRow(i, 150_000));
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 3 });
    expect(page(result).rows.map((r) => r.id)).toEqual([0]);
    expect(page(result).next_offset).toBe(1);
    expect(page(result).notice).toContain(
      'the most that fit the 100,000-character response budget',
    );
  });

  it('names the next offset when limit ended the page', async () => {
    serveMatch(195, (i) => ({ id: i }));
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 3, offset: 6 });
    expect(page(result)).toMatchObject({ returned_count: 3, total_count: 195, next_offset: 9 });
    expect(page(result).notice).toBe(
      'Returned 3 of the 195 matching records from offset 6, as many as limit allows; continue with offset 9.',
    );
  });

  it('pages a match by next_offset until it is absent, every record exactly once', async () => {
    serveMatch(1_200);
    const seen: number[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const o = page(
        await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000, offset }),
      );
      seen.push(...o.rows.map((r) => r.id));
      expect(o.returned_count).toBeGreaterThan(0);
      offset = o.next_offset;
      pages++;
    }
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(Array.from({ length: 1_200 }, (_, i) => i));
  });

  /** Records the mocked endpoint served across every data request of the test. */
  const recordsServed = () =>
    calledUrls(fetchMock)
      .filter((url) => url.startsWith(endpoint(DDS, 2)))
      .reduce((n, url) => n + (queryParam(url, 'top') ?? 0), 0);

  it('reads no more upstream records than the page can hold when wide records fill it early', async () => {
    // 10,000-character records: 9 fill the budget, so a $top of 10,000 would read ~100 MB.
    serveMatch(70_567, (i) => wideRow(i, 10_000));
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000 });
    expect(page(result).returned_count).toBe(9);
    expect(page(result).next_offset).toBe(9);
    expect(recordsServed()).toBe(READ_CHUNK);
  });

  it('still fills the budget with narrow records, reading little past the page', async () => {
    serveMatch(70_567, (i) => ({ id: i }));
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000 });
    const o = page(result);
    const charge = (i: number) => Math.max(JSON.stringify({ id: i }).length, `| ${i} |`.length) + 2;
    let fit = 0;
    let used = 0;
    while (used + charge(fit) <= BUDGET) used += charge(fit++);
    expect(fit).toBeGreaterThan(READ_CHUNK);
    expect(o.returned_count).toBe(fit);
    expect(o.next_offset).toBe(fit);
    expect(o.notice).toContain('the most that fit the 100,000-character response budget');
    expect(recordsServed()).toBeLessThan(Math.ceil(fit * 1.2));
  });

  it('pages narrow records read in several chunks by next_offset, every record exactly once', async () => {
    serveMatch(30_000, (i) => ({ id: i }));
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const o = page(
        await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000, offset }),
      );
      expect(o.returned_count).toBeGreaterThan(READ_CHUNK);
      seen.push(...o.rows.map((r) => r.id));
      offset = o.next_offset;
    }
    expect(seen).toEqual(Array.from({ length: 30_000 }, (_, i) => i));
  });

  it('reads no further once the page’s 50-second deadline has passed', async () => {
    let reads = 0;
    const start = Date.now();
    const now = vi.spyOn(Date, 'now');
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [
          endpoint(DDS, 2),
          (url) => {
            reads++;
            // The first read takes 51 seconds of the page's 50-second deadline.
            now.mockReturnValue(start + 51_000);
            const top = queryParam(url, 'top') ?? 0;
            return envelopeResponse(
              DDS,
              Array.from({ length: top }, (_, i) => ({ id: i })),
              70_567,
            );
          },
        ],
      ]),
    );
    now.mockReturnValue(start);
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000 });
    now.mockRestore();
    expect(reads).toBe(1);
    expect(page(result).returned_count).toBe(READ_CHUNK);
    expect(page(result).notice).toContain('OpenFEMA did not return the rest of this page');
  });

  it('keeps the first chunk as the page when the read for the rest fails, naming the next offset', async () => {
    let reads = 0;
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalogResponse()],
        [
          endpoint(DDS, 2),
          (url) => {
            reads++;
            if (reads > 1) return jsonResponse(400, { error: [{ message: 'bad' }] });
            const top = queryParam(url, 'top') ?? 0;
            return envelopeResponse(
              DDS,
              Array.from({ length: top }, (_, i) => ({ id: i })),
              70_567,
            );
          },
        ],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: DDS, limit: 10_000 });
    expect(result.isError).not.toBe(true);
    const o = page(result);
    expect(reads).toBe(2);
    expect(o.returned_count).toBe(READ_CHUNK);
    expect(o.next_offset).toBe(READ_CHUNK);
    expect(o.notice).toContain(`continue with offset ${READ_CHUNK}`);
    expect(o.notice).toContain('OpenFEMA did not return the rest of this page');
    expect(o.notice).not.toContain('as many as limit allows');
  });

  it('a call at the default limit reads its page in one request', async () => {
    serveMatch(70_567, (i) => ({ id: i }));
    await runToolContract(femaQueryDataset, { dataset: DDS });
    expect(recordsServed()).toBe(100);
    expect(calledUrls(fetchMock).filter((u) => u.startsWith(endpoint(DDS, 2)))).toHaveLength(1);
  });

  it('sets no next_offset on the last page or on an empty page past the end', async () => {
    serveMatch(195, (i) => ({ id: i }));
    const last = page(
      await runToolContract(femaQueryDataset, { dataset: DDS, limit: 100, offset: 100 }),
    );
    expect(last).toMatchObject({ returned_count: 95 });
    expect(last.next_offset).toBeUndefined();
    expect(last.notice).toBeUndefined();
    const past = page(await runToolContract(femaQueryDataset, { dataset: DDS, offset: 195 }));
    expect(past.next_offset).toBeUndefined();
    expect(past.notice).toContain('last valid offset is 194');
  });
});

describe('fema_query_dataset — retired and deprecated dataset versions (#51)', () => {
  const HMA = 'HazardMitigationAssistanceProjects';
  const COMMUNITY = 'NfipCommunityLayerComprehensive';
  const catalog = () =>
    catalogResponse([
      ...CATALOG_ROWS,
      { name: HMA, version: 4, webService: `https://www.fema.gov/api/open/v4/${HMA}` },
      { name: COMMUNITY, version: 1, webService: `https://www.fema.gov/api/open/v1/${COMMUNITY}` },
    ]);
  /** The live v4 deprecation block (captured 2026-10-16), message trailing spaces included. */
  const RETIRED = {
    depDate: '2026-10-15T00:00:00.000Z',
    depApiMessage:
      'This dataset has been combined with the HMA Subapplications dataset. The Hazard Mitigation Assistance Projects prior version, V4, has been deprecated and is frozen as of August 31, 2026. It will remain until October 15, 2026, at which time it will no longer be available.  ',
    depNewUrl: 'https://www.fema.gov/openfema-data-page/hma-subapplications-v2',
    depWebMessage: 'This dataset has been combined with the HMA Subapplications dataset.',
  };
  /** The live v1 deprecation block (captured 2026-10-16): a future date and no replacement. */
  const DEPRECATED = {
    depDate: '2099-11-09T00:00:00.000Z',
    depApiMessage:
      'This dataset is deprecated. The data is frozen as of December 2004. It will remain until November 09, 2026, at which time it will no longer be available.',
    depNewUrl: null,
    depWebMessage: 'This dataset is deprecated.',
  };
  const envelope = (entity: string, rows: unknown[], count: number, dep: object) =>
    jsonResponse(200, {
      metadata: { count, entityname: entity, version: 'v4', DeprecationInformation: dep },
      [entity]: rows,
    });

  it('a retired version answering with no records → dataset_not_served quoting its message and replacement', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalog()],
        [endpoint(HMA, 4), () => envelope(HMA, [], 56_410, RETIRED)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: HMA, limit: 50 });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('dataset_not_served');
    const text = contentText(result);
    for (const surface of [error.message, text]) {
      expect(surface).toContain(RETIRED.depApiMessage.trim());
      expect(surface).toContain(RETIRED.depNewUrl);
      expect(surface).toContain(HMA);
      expect(surface).not.toMatch(/past the end|last valid offset/);
    }
    expect(error.data.recovery?.hint).toContain(RETIRED.depNewUrl);
    expect(text).toContain('reason dataset_not_served');
  });

  it('a retired version whose replacement page the catalog lists → the hint names the replacement dataset', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [
          CATALOG_URL,
          () =>
            catalogResponse([
              ...CATALOG_ROWS,
              { name: HMA, version: 4, webService: `https://www.fema.gov/api/open/v4/${HMA}` },
              {
                name: 'HmaSubapplications',
                version: 2,
                webService: 'https://www.fema.gov/api/open/v2/HmaSubapplications',
                // The live catalog links the page in a different letter case than depNewUrl.
                dataDictionary: 'https://www.fema.gov/openfema-data-page/HMA-Subapplications-v2',
              },
            ]),
        ],
        [endpoint(HMA, 4), () => envelope(HMA, [], 56_410, RETIRED)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: HMA, limit: 50 });
    const error = errorOf(result);
    expect(error.data.reason).toBe('dataset_not_served');
    expect(error.data.recovery?.hint).toContain(
      'Query its replacement, HmaSubapplications, with fema_query_dataset',
    );
    for (const surface of [error.message, contentText(result)]) {
      expect(surface).toContain(`Replacement dataset: HmaSubapplications (${RETIRED.depNewUrl}).`);
    }
  });

  it('a deprecated version still answering with records → the records plus its message as a notice', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalog()],
        [endpoint(COMMUNITY, 1), () => envelope(COMMUNITY, [{ id: 1 }], 51_943, DEPRECATED)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: COMMUNITY, limit: 1 });
    expect(result.isError).not.toBe(true);
    const o = page(result);
    expect(o).toMatchObject({ rows: [{ id: 1 }], total_count: 51_943, next_offset: 1 });
    expect(o.notice).toBe(
      `Returned 1 of the 51943 matching records from offset 0, as many as limit allows; continue with offset 1. OpenFEMA has deprecated this version of "${COMMUNITY}", to be retired on 2099-11-09. OpenFEMA's notice: ${DEPRECATED.depApiMessage}`,
    );
    expect(contentText(result)).toContain(o.notice);
  });

  it('a retired version paged past its count keeps the past-the-end notice and adds its message', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [CATALOG_URL, () => catalog()],
        [endpoint(HMA, 4), () => envelope(HMA, [], 56_410, RETIRED)],
      ]),
    );
    const result = await runToolContract(femaQueryDataset, { dataset: HMA, offset: 56_410 });
    expect(result.isError).not.toBe(true);
    expect(page(result).notice).toBe(
      `Offset 56410 is past the end of the 56410 matching records; the last valid offset is 56409. OpenFEMA has deprecated this version of "${HMA}", retired on 2026-10-15. OpenFEMA's notice: ${RETIRED.depApiMessage.trim()} Replacement: ${RETIRED.depNewUrl}`,
    );
  });
});
