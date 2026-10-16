/**
 * @fileoverview Tests for fema_search_disasters tool.
 * @module tests/tools/fema-search-disasters.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaSearchDisasters } from '@/mcp-server/tools/definitions/fema-search-disasters.tool.js';
import { countySpellings, incidentTypeSpellings } from '@/services/openfema/name-matcher.js';
import { DESIGNATED_AREAS, INCIDENT_TYPES } from '@/services/openfema/name-vocabulary.js';

// Mock the service accessor — handler calls getOpenFemaService() at runtime. The name matcher's
// OData escaping stays the real one, so the filters asserted here are the ones the tool sends.
vi.mock('@/services/openfema/openfema-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openfema/openfema-service.js')>();
  let _mockSvc: Record<string, unknown>;
  return {
    getOpenFemaService: () => _mockSvc,
    initOpenFemaService: () => {},
    escapeODataString: actual.escapeODataString,
    __setMock: (svc: Record<string, unknown>) => {
      _mockSvc = svc;
    },
  };
});

/** Minimal disaster row fixture. Uses ihProgramDeclared (IHP flag), not iaProgramDeclared. */
function makeDisasterRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    declarationTitle: 'HURRICANE HELENE',
    state: 'TX',
    incidentType: 'Hurricane',
    declarationType: 'DR',
    declarationDate: '2024-09-27T00:00:00.000Z',
    ihProgramDeclared: true,
    paProgramDeclared: true,
    hmProgramDeclared: false,
    ...overrides,
  };
}

async function setMock(impl: Record<string, unknown>) {
  const mod = await import('@/services/openfema/openfema-service.js');
  (mod as unknown as { __setMock: (s: Record<string, unknown>) => void }).__setMock(impl);
}

/** Every text block of a tool result, joined — format() output plus the enrichment trailer. */
function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
}

type ErrorEnvelope = {
  code: number;
  data: { reason?: string; recovery?: { hint: string } };
};

function errorOf(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

/** The distinct-disaster rows used by the paging tests: 3 declarations over 5 area rows. */
function threeDeclarationRows() {
  return [
    makeDisasterRow({ disasterNumber: 4780 }),
    makeDisasterRow({ disasterNumber: 4780 }),
    makeDisasterRow({ disasterNumber: 4780 }),
    makeDisasterRow({ disasterNumber: 4781 }),
    makeDisasterRow({ disasterNumber: 4782 }),
  ];
}

describe('femaSearchDisasters', () => {
  beforeEach(async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [makeDisasterRow()],
        count: 1,
      }),
    });
  });

  it('returns deduplicated declaration summaries', async () => {
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ state: 'TX' });
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]).toMatchObject({
      disaster_number: 4781,
      title: 'HURRICANE HELENE',
      state: 'TX',
      declaration_type: 'DR',
    });
    expect(result.total_area_rows).toBe(1);
    expect(result.returned_count).toBe(1);
  });

  it('ia_declared reflects ihProgramDeclared (IHP flag), not iaProgramDeclared', async () => {
    // iaProgramDeclared is the legacy general-IA flag (false for major disasters since ~2012).
    // ihProgramDeclared (Individuals & Households Program) is the correct field.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({
            ihProgramDeclared: true,
            iaProgramDeclared: false, // legacy flag — should NOT be used
          }),
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({});
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations[0]?.ia_declared).toBe(true);
  });

  it('ia_declared is false when ihProgramDeclared is false on all areas', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [makeDisasterRow({ ihProgramDeclared: false })],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({});
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations[0]?.ia_declared).toBe(false);
  });

  it('ia_declared is true when any area row has ihProgramDeclared true (OR rollup)', async () => {
    // OpenFEMA may return ihProgramDeclared: false rows first (sort order), followed by true.
    // The rollup must OR across all rows, not take the first row's value.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({ ihProgramDeclared: false }), // first row is false
          makeDisasterRow({ ihProgramDeclared: false }),
          makeDisasterRow({ ihProgramDeclared: true }), // later row is true
        ],
        count: 3,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({});
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations[0]?.ia_declared).toBe(true);
    // all 3 area rows for the same disaster
    expect(result.declarations[0]?.designated_area_count).toBe(3);
  });

  it('deduplicates multiple area rows for the same disaster number', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [makeDisasterRow(), makeDisasterRow(), makeDisasterRow({ disasterNumber: 4782 })],
        count: 50,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ state: 'TX' });
    const result = await femaSearchDisasters.handler(input, ctx);
    // Two distinct disaster numbers
    expect(result.declarations).toHaveLength(2);
    const dr4781 = result.declarations.find((d) => d.disaster_number === 4781);
    expect(dr4781?.designated_area_count).toBe(2);
    expect(result.total_area_rows).toBe(50);
  });

  it('limit/offset apply to deduplicated declarations, not area-rows', async () => {
    // 5 area-rows spanning 3 disasters: 4780 (3 areas), 4781 (1 area), 4782 (1 area).
    // With limit=2 offset=0 we expect exactly 2 DISTINCT declarations.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4781 }),
          makeDisasterRow({ disasterNumber: 4782 }),
        ],
        count: 5,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ limit: 2, offset: 0 });
    const result = await femaSearchDisasters.handler(input, ctx);
    // limit=2 should return 2 distinct declarations, not fewer
    expect(result.declarations).toHaveLength(2);
    expect(result.returned_count).toBe(2);
    // DR-4780 should show all 3 of its area-rows as designated_area_count
    const dr4780 = result.declarations.find((d) => d.disaster_number === 4780);
    expect(dr4780?.designated_area_count).toBe(3);
  });

  it('offset paginates across declarations', async () => {
    // 3 distinct disasters; offset=2 should return only the third
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4781 }),
          makeDisasterRow({ disasterNumber: 4782 }),
        ],
        count: 3,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ limit: 10, offset: 2 });
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]?.disaster_number).toBe(4782);
  });

  it('reports total_declarations as the distinct-declaration count and points the enrichment total at declarations, not area-rows (regression #17)', async () => {
    // 5 area-rows spanning 3 distinct disasters: 4780 (3 areas), 4781 (1), 4782 (1).
    // The raw area-row count (5) diverges from the 3 unique declarations.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4780 }),
          makeDisasterRow({ disasterNumber: 4781 }),
          makeDisasterRow({ disasterNumber: 4782 }),
        ],
        count: 5,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({});
    const result = await femaSearchDisasters.handler(input, ctx);
    // New field reports the DISTINCT declaration count, diverging from raw area-rows.
    expect(result.total_declarations).toBe(3);
    expect(result.total_area_rows).toBe(5);
    expect(result.total_declarations).toBeLessThan(result.total_area_rows);
    // The framework pagination total (ctx.enrich.total) now carries declarations, not area-rows.
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 3 });
  });

  it('throws invalid_state for unknown state codes', async () => {
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ state: 'ZZ' });
    await expect(femaSearchDisasters.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_state' },
    });
  });

  it('throws no_results when query returns empty rows', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ state: 'TX' });
    await expect(femaSearchDisasters.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('includes contextual guidance in recovery hint on no_results', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({ state: 'WY', incident_type: 'Hurricane' });
    let caught: unknown;
    try {
      await femaSearchDisasters.handler(input, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      data: {
        reason: 'no_results',
        recovery: { hint: expect.stringContaining('No disaster declarations matched') },
      },
    });
  });

  it('handles sparse upstream rows with missing optional fields', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          {
            disasterNumber: 9999,
            // title, state, incidentType, declarationType all absent
          },
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchDisasters.errors });
    const input = femaSearchDisasters.input.parse({});
    const result = await femaSearchDisasters.handler(input, ctx);
    expect(result.declarations[0]).toMatchObject({
      disaster_number: 9999,
      title: 'Unknown',
      state: '',
    });
  });

  it('formats output with disaster number and programs', () => {
    const output = {
      declarations: [
        {
          disaster_number: 4781,
          title: 'TEST HURRICANE',
          state: 'TX',
          incident_type: 'Hurricane',
          declaration_type: 'DR',
          declaration_date: '2024-01-01T00:00:00.000Z',
          ia_declared: true,
          pa_declared: true,
          hm_declared: false,
          designated_area_count: 5,
        },
      ],
      total_declarations: 1,
      total_area_rows: 10,
      returned_count: 1,
    };
    const blocks = femaSearchDisasters.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DR-4781');
    expect(text).toContain('TEST HURRICANE');
    expect(text).toContain('IA');
    expect(text).toContain('PA');
    expect(text).toContain('5');
  });

  it('format prefix follows the real declaration type (FM, EM) and never fabricates one', () => {
    const output = {
      declarations: [
        {
          disaster_number: 5634,
          title: 'STINKY FIRE',
          state: 'TX',
          incident_type: 'Fire',
          declaration_type: 'FM',
          declaration_date: '2024-01-01T00:00:00.000Z',
          ia_declared: false,
          pa_declared: false,
          hm_declared: false,
          designated_area_count: 1,
        },
        {
          disaster_number: 3600,
          title: 'SEVERE STORM EMERGENCY',
          state: 'FL',
          incident_type: 'Severe Storm',
          declaration_type: 'EM',
          declaration_date: '2024-02-01T00:00:00.000Z',
          ia_declared: false,
          pa_declared: true,
          hm_declared: false,
          designated_area_count: 2,
        },
        {
          // No declaration_type on the record — must fall back, never fabricate DR-.
          disaster_number: 9999,
          title: 'UNTYPED EVENT',
          state: 'CA',
          incident_type: 'Flood',
          declaration_type: '',
          declaration_date: '2024-03-01T00:00:00.000Z',
          ia_declared: false,
          pa_declared: false,
          hm_declared: false,
          designated_area_count: 1,
        },
      ],
      total_declarations: 3,
      total_area_rows: 4,
      returned_count: 3,
    };
    const text = (femaSearchDisasters.format!(output)[0] as { text: string }).text;
    expect(text).toContain('3 of 3 unique declaration(s)');
    expect(text).toContain('FM-5634');
    expect(text).toContain('EM-3600');
    expect(text).toContain('Disaster #9999');
    expect(text).not.toContain('DR-5634');
    expect(text).not.toContain('DR-3600');
    expect(text).not.toContain('DR-9999');
    expect(text).not.toContain('-9999');
  });
});

describe('femaSearchDisasters — date filters', () => {
  let fetchDisasters: Mock;

  beforeEach(async () => {
    fetchDisasters = vi.fn().mockResolvedValue({ rows: [makeDisasterRow()], count: 1 });
    await setMock({ fetchDisasters });
  });

  it('turns YYYY-MM-DD dates into an inclusive declarationDate range filter', async () => {
    const result = await runToolContract(femaSearchDisasters, {
      date_from: '2024-01-01',
      date_to: '2024-12-31',
    });
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters).toHaveBeenCalledTimes(1);
    expect(fetchDisasters.mock.calls[0]?.[0]).toMatchObject({
      filter:
        "declarationDate ge '2024-01-01T00:00:00.000Z' and declarationDate le '2024-12-31T23:59:59.999Z'",
    });
  });

  it('treats an empty date string as absent, as form-based clients send it', async () => {
    const result = await runToolContract(femaSearchDisasters, { date_from: '', date_to: '' });
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters.mock.calls[0]?.[0]).not.toHaveProperty('filter');
  });

  it('rejects date_from after date_to as invalid_range, naming both bounds, before fetching (#45)', async () => {
    const result = await runToolContract(femaSearchDisasters, {
      state: 'TX',
      date_from: '2018-01-01',
      date_to: '2017-01-01',
    });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    const declared = femaSearchDisasters.errors?.find((e) => e.reason === 'invalid_range');
    expect(declared).toBeDefined();
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_range');
    expect(error.data.recovery?.hint).toBe(declared?.recovery);
    const text = contentText(result);
    expect(text).toContain('date_from 2018-01-01');
    expect(text).toContain('date_to 2017-01-01');
    expect(text).toContain(declared?.recovery ?? '');
    expect(fetchDisasters).not.toHaveBeenCalled();
  });

  it('keeps equal date bounds valid: one day, inclusive', async () => {
    const result = await runToolContract(femaSearchDisasters, {
      date_from: '2017-08-25',
      date_to: '2017-08-25',
    });
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters.mock.calls[0]?.[0]).toMatchObject({
      filter:
        "declarationDate ge '2017-08-25T00:00:00.000Z' and declarationDate le '2017-08-25T23:59:59.999Z'",
    });
  });

  it.each([
    ['2018-01-01', '', "declarationDate ge '2018-01-01T00:00:00.000Z'"],
    ['', '2017-01-01', "declarationDate le '2017-01-01T23:59:59.999Z'"],
  ])(
    'checks no order when one bound is blank and filters on the other alone (date_from %j, date_to %j)',
    async (date_from, date_to, filter) => {
      const result = await runToolContract(femaSearchDisasters, { date_from, date_to });
      expect(result.isError).not.toBe(true);
      expect(fetchDisasters).toHaveBeenCalledTimes(1);
      expect(fetchDisasters.mock.calls[0]?.[0]).toMatchObject({ filter });
    },
  );
});

describe('femaSearchDisasters — empty match', () => {
  it('returns no_results with its contract code and recovery on both surfaces', async () => {
    await setMock({ fetchDisasters: vi.fn().mockResolvedValue({ rows: [], count: 0 }) });
    const result = await runToolContract(femaSearchDisasters, { state: 'WY' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('no_results');
    expect(error.data.recovery?.hint).toBe(
      'No disaster declarations matched the search criteria. Broaden the search by removing filters, expanding the date range, or trying a different state or incident type.',
    );
    expect(contentText(result)).toContain('No disaster declarations matched');
  });
});

describe('femaSearchDisasters — date format (#31)', () => {
  let fetchDisasters: Mock;

  beforeEach(async () => {
    fetchDisasters = vi.fn().mockResolvedValue({ rows: [makeDisasterRow()], count: 1 });
    await setMock({ fetchDisasters });
  });

  /**
   * Values OpenFEMA answers with HTTP 400 (`yesterday`, `2024-13-45`, `2024-1-5`, timestamps),
   * plus values it silently reinterprets: `2024` and `2024-01` as `2024-01-01`, and
   * `2024-02-30` rolled over to `2024-03-01`.
   */
  const rejected = [
    'yesterday',
    '2024-13-45',
    '2024-1-5',
    '2024-01-01T00:00:00Z',
    '2024/01/01',
    '2024',
    '2024-01',
    '2024-02-30',
    '2023-02-29',
  ];

  for (const field of ['date_from', 'date_to'] as const) {
    it.each(rejected)(
      `rejects ${field} %j as invalid_arguments before any request`,
      async (value) => {
        const result = await runToolContract(femaSearchDisasters, { [field]: value });
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data.reason).toBe('invalid_arguments');
        expect(error.data.recovery?.hint).toContain('YYYY-MM-DD');
        expect(contentText(result)).toContain(field);
        expect(contentText(result)).toContain('YYYY-MM-DD');
        expect(fetchDisasters).not.toHaveBeenCalled();
      },
    );
  }

  it('accepts a leap day', async () => {
    const result = await runToolContract(femaSearchDisasters, { date_from: '2024-02-29' });
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters.mock.calls[0]?.[0]).toMatchObject({
      filter: "declarationDate ge '2024-02-29T00:00:00.000Z'",
    });
  });

  it('advertises the YYYY-MM-DD format as a pattern in the input JSON Schema', () => {
    const schema = z.toJSONSchema(femaSearchDisasters.input, { io: 'input' }) as {
      properties: Record<string, { anyOf?: Array<Record<string, unknown>>; description?: string }>;
    };
    for (const field of ['date_from', 'date_to']) {
      const prop = schema.properties[field];
      const dateBranch = prop?.anyOf?.find((branch) => branch.format === 'date');
      expect(dateBranch?.pattern).toEqual(expect.any(String));
      expect(new RegExp(dateBranch?.pattern as string).test('2024-01-31')).toBe(true);
      expect(new RegExp(dateBranch?.pattern as string).test('2024-01')).toBe(false);
      expect(prop?.description).toContain('YYYY-MM-DD');
    }
  });
});

describe('femaSearchDisasters — offset past the end (#32)', () => {
  it('reports a missing declaration date at the read cap as InternalError on both surfaces', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [makeDisasterRow({ declarationDate: undefined })],
        count: 10_001,
      }),
    });
    const result = await runToolContract(femaSearchDisasters, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.InternalError,
        message: 'OpenFEMA returned a declaration row without a declarationDate.',
      },
    });
    expect(contentText(result)).toContain(
      'OpenFEMA returned a declaration row without a declarationDate.',
    );
  });

  it('returns an empty page with the totals and a notice naming the last valid offset', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: threeDeclarationRows(), count: 5 }),
    });
    const result = await runToolContract(femaSearchDisasters, { offset: 3 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      declarations: [],
      total_declarations: 3,
      total_area_rows: 5,
      returned_count: 0,
      totalCount: 3,
    });
    const notice = structured.notice as string;
    expect(notice).toContain('Offset 3');
    expect(notice).toContain('3 matching declarations');
    expect(notice).toContain('last valid offset is 2');
    const text = contentText(result);
    expect(text).toContain('0 of 3 unique declaration(s)');
    expect(text).toContain(notice);
    expect(text).not.toMatch(/\bno\b[^.\n]*\b(records|declarations)\b/i);
  });

  it('keeps paging the last valid offset as a normal page', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: threeDeclarationRows(), count: 5 }),
    });
    const result = await runToolContract(femaSearchDisasters, { offset: 2 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ returned_count: 1, total_declarations: 3 });
    expect(structured).not.toHaveProperty('notice');
  });

  it('composes the past-the-end and lower-bound sentences into one notice when the 10,000-row cap was hit', async () => {
    // The window's oldest row (DR-4782) is dated on the day the cap cut through, so it is dropped.
    const rows = [
      ...threeDeclarationRows().slice(0, 4),
      makeDisasterRow({ disasterNumber: 4782, declarationDate: '2024-09-20T00:00:00.000Z' }),
    ];
    await setMock({ fetchDisasters: vi.fn().mockResolvedValue({ rows, count: 25_000 }) });
    const result = await runToolContract(femaSearchDisasters, { offset: 50 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { notice: string; truncated: boolean };
    expect(structured).toMatchObject({ total_declarations: 2, truncated: true });
    const notice = structured.notice;
    expect(notice).toContain('last valid offset is 1');
    expect(notice).toContain('2 declarations dated after 2024-09-20');
    expect(notice).toContain('10,000');
    expect(notice).toContain('date_to=2024-09-20');
    // More than 2 declarations match; only 2 are reachable inside the trimmed window.
    expect(notice).not.toContain('2 matching declarations');
    expect(contentText(result)).toContain(notice);
  });
});

describe('femaSearchDisasters — case-insensitive name filters (#41)', () => {
  let fetchDisasters: Mock;

  beforeEach(async () => {
    fetchDisasters = vi.fn().mockResolvedValue({ rows: [makeDisasterRow()], count: 1 });
    await setMock({ fetchDisasters });
  });

  /** The search's filter; a set county adds one read of the returned declaration's full rows (#42). */
  async function filterSent(input: Record<string, unknown>): Promise<string | undefined> {
    const result = await runToolContract(femaSearchDisasters, input);
    expect(result.isError).not.toBe(true);
    const calls = fetchDisasters.mock.calls as Array<[{ filter?: string }]>;
    const byCounty = String(input.county ?? '').trim() !== '';
    expect(calls).toHaveLength(byCounty ? 2 : 1);
    if (byCounty) expect(calls[1]?.[0].filter).toBe('disasterNumber in (4781)');
    return calls[0]?.[0].filter;
  }

  it('keeps matching the stored spelling a caller already sends', async () => {
    const filter = await filterSent({ incident_type: 'Hurricane', county: "O'Brien" });
    expect(filter).toContain("substringof('Hurricane', incidentType)");
    expect(filter).toContain("substringof('O''Brien', designatedArea)");
  });

  it('or-joins the spellings in parentheses so each filter composes with the others', async () => {
    expect(await filterSent({ state: 'TX', incident_type: 'hurricane', county: 'harris' })).toBe(
      "state eq 'TX' and " +
        "(substringof('Hurricane', incidentType) or substringof('hurricane', incidentType) or substringof('HURRICANE', incidentType)) and " +
        "(substringof('Harris', designatedArea) or substringof('harris', designatedArea) or substringof('HARRIS', designatedArea))",
    );
  });

  it('trims values before matching', async () => {
    const filter = await filterSent({ incident_type: '  Flood ', county: ' Harris  ' });
    expect(filter).toContain("substringof('Flood', incidentType)");
    expect(filter).toContain("substringof('Harris', designatedArea)");
    expect(filter).not.toMatch(/substringof\('\s|\s', /);
  });

  it.each(['', '   '])('treats incident_type and county %j as unset', async (blank) => {
    expect(await filterSent({ incident_type: blank, county: blank })).toBeUndefined();
  });

  /**
   * OpenFEMA accepts an `or` chain of 93 comparisons and rejects 94 with "maximum nesting depth
   * of 100 exceeded" (measured 2026-10-16); each `and`/`or` and each parenthesized group adds a
   * level, so comparisons plus groups bounds the levels a filter uses. Any input resolves to at
   * most 8 county and 6 incident-type spellings, so no input can pass 4 + 8 + 6 + 2 = 20.
   */
  it('stays far inside the nesting limit with the most ambiguous inputs and every filter set', async () => {
    const mostAmbiguous = (spell: (input: string) => string[], vocabulary: readonly string[]) => {
      const chars = [...new Set(vocabulary.join('').toLowerCase())];
      const inputs = [...chars, ...chars.flatMap((a) => chars.map((b) => `${a}${b}`))];
      return inputs.reduce((worst, input) =>
        spell(input).length > spell(worst).length ? input : worst,
      );
    };
    const county = mostAmbiguous(countySpellings, DESIGNATED_AREAS);
    const incident_type = mostAmbiguous(incidentTypeSpellings, INCIDENT_TYPES);
    const filter =
      (await filterSent({
        state: 'TX',
        incident_type,
        declaration_type: 'DR',
        date_from: '2020-01-01',
        date_to: '2020-12-31',
        county,
      })) ?? '';
    const comparisons = filter.match(/substringof\(| eq | ge | le /g)?.length ?? 0;
    const groups = filter.match(/(?:^|and )\(/g)?.length ?? 0;
    expect({ comparisons, groups }).toEqual({ comparisons: 11, groups: 2 });
  });

  it('describes both filters as case-insensitive substring matches', () => {
    const schema = z.toJSONSchema(femaSearchDisasters.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
    };
    for (const field of ['incident_type', 'county']) {
      expect(schema.properties[field]?.description).toMatch(/case-insensitive substring/i);
    }
  });
});

describe('femaSearchDisasters — county area totals under one deadline (#42)', () => {
  const T = 1_800_000_000_000;
  let now: number;
  let fetchDisasters: Mock;

  /** A county search whose main request takes `mainMs`; the area-row read returns 53 rows. */
  async function countySearch(mainMs: number) {
    fetchDisasters = vi
      .fn()
      .mockImplementationOnce(async () => {
        now += mainMs;
        return {
          rows: [
            makeDisasterRow({
              disasterNumber: 4332,
              designatedArea: 'Bexar (County)',
              fipsStateCode: '48',
              fipsCountyCode: '029',
              ihProgramDeclared: false,
              hmProgramDeclared: true,
            }),
          ],
          count: 1,
        };
      })
      .mockResolvedValue({
        rows: Array.from({ length: 53 }, (_, i) =>
          makeDisasterRow({ disasterNumber: 4332, ihProgramDeclared: i > 0 }),
        ),
        count: 53,
      });
    await setMock({ fetchDisasters });
    return runToolContract(femaSearchDisasters, { county: 'Bexar' });
  }

  beforeEach(() => {
    now = T;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives the main search the 50,000 ms budget and the area-row read what is left of it', async () => {
    const result = await countySearch(0);
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters).toHaveBeenCalledTimes(2);
    expect(fetchDisasters.mock.calls[0]?.[2]).toEqual({ deadlineMs: 50_000 });
    expect(fetchDisasters.mock.calls[1]?.[2]).toEqual({
      deadlineMs: 50_000,
      signal: expect.any(AbortSignal),
    });
    expect(result.structuredContent).toMatchObject({
      declarations: [{ designated_area_count: 53, ia_declared: true, hm_declared: false }],
    });
  });

  it('bounds the main search by the budget even without county', async () => {
    fetchDisasters = vi.fn().mockResolvedValue({ rows: [makeDisasterRow()], count: 1 });
    await setMock({ fetchDisasters });
    await runToolContract(femaSearchDisasters, { state: 'TX' });
    expect(fetchDisasters).toHaveBeenCalledTimes(1);
    expect(fetchDisasters.mock.calls[0]?.[2]).toEqual({ deadlineMs: 50_000 });
  });

  it('still reads the area rows with 1 ms of the budget left', async () => {
    const result = await countySearch(49_999);
    expect(fetchDisasters.mock.calls[0]?.[2]).toEqual({ deadlineMs: 50_000 });
    expect(fetchDisasters.mock.calls[1]?.[2]).toMatchObject({ deadlineMs: 1 });
    expect(result.structuredContent).not.toHaveProperty('area_totals_unavailable');
  });

  it('with the budget spent, sends no area-row request and discloses the matched-area values', async () => {
    const result = await countySearch(50_000);
    expect(result.isError).not.toBe(true);
    expect(fetchDisasters).toHaveBeenCalledTimes(1);
    const out = result.structuredContent as {
      declarations: Array<{ designated_area_count: number; ia_declared: boolean }>;
      area_totals_unavailable?: boolean;
      notice?: string;
    };
    expect(out.area_totals_unavailable).toBe(true);
    expect(out.declarations[0]).toMatchObject({ designated_area_count: 1, ia_declared: false });
    expect(out.notice).toBe(
      'Reading the full designated-area rows of the 1 returned declaration(s) failed because it timed out inside the search’s 50-second budget, so their designated_area_count, ia_declared, pa_declared, and hm_declared count only the areas county matched. Retry the search, or read a declaration whole with fema_get_disaster.',
    );
    const text = contentText(result);
    expect(text).toContain('**Declaration area totals unavailable:** true');
    expect(text).toContain(out.notice ?? '');
  });
});

describe('femaSearchDisasters — why the area-row read failed, in caller terms', () => {
  /** A county search whose area-row read fails with `error`. */
  async function failedRead(error: McpError) {
    const fetchDisasters = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [makeDisasterRow({ disasterNumber: 4332, designatedArea: 'Bexar (County)' })],
        count: 1,
      })
      .mockRejectedValue(error);
    await setMock({ fetchDisasters });
    const result = await runToolContract(femaSearchDisasters, { county: 'Bexar' });
    expect(result.isError).not.toBe(true);
    return { out: result.structuredContent as { notice: string }, text: contentText(result) };
  }

  const url =
    'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24filter=disasterNumber%20in%20(4332)';

  it.each([
    [
      'a retry deadline',
      new McpError(
        JsonRpcErrorCode.Timeout,
        'OpenFemaService.request(DisasterDeclarationsSummaries v2) exceeded its 21913ms retry deadline after 2 attempts.',
        { reason: 'retry_deadline_exceeded', deadlineMs: 21_913 },
      ),
      'failed because it timed out inside the search’s 50-second budget, so',
    ],
    [
      'a RateLimited code',
      new McpError(JsonRpcErrorCode.RateLimited, `Fetch failed for ${url}. Status: 429`, {
        status: 429,
      }),
      'failed because OpenFEMA rate limited it (HTTP 429), so',
    ],
    [
      'an HTTP 429 under another code',
      new McpError(JsonRpcErrorCode.ServiceUnavailable, `Fetch failed for ${url}. Status: 429`, {
        status: 429,
      }),
      'failed because OpenFEMA rate limited it (HTTP 429), so',
    ],
    [
      'an HTTP 503',
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Fetch failed for ${url}. Status: 503 (failed after 4 attempts)`,
        { status: 503, retryAttempts: 4, operation: 'OpenFemaService.request(…)' },
      ),
      'failed because OpenFEMA answered it with HTTP 503, so',
    ],
    [
      'a response with no status',
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'OpenFEMA returned non-JSON response — possible upstream error.',
        { dataset: 'DisasterDeclarationsSummaries' },
      ),
      'failed because OpenFEMA did not return a usable response, so',
    ],
  ])('names %s without service internals', async (_label, error, cause) => {
    const { out, text } = await failedRead(error);
    expect(out.notice).toContain(cause);
    for (const internal of [
      'OpenFemaService',
      'fema.gov',
      'Fetch failed',
      'retry deadline',
      'Cause:',
    ]) {
      expect(out.notice).not.toContain(internal);
      expect(text).not.toContain(internal);
    }
    expect(text).toContain(out.notice);
  });

  it('stops the sibling area-row pages when one of them fails', async () => {
    const area = makeDisasterRow({ disasterNumber: 4800, designatedArea: 'Bexar (County)' });
    const full = Array.from({ length: 10_000 }, () => makeDisasterRow({ disasterNumber: 4800 }));
    const siblings: Array<{ skip: number; abortedBy?: boolean }> = [];
    const fetchDisasters = vi.fn(
      async (
        opts: { filter?: string; skip?: number },
        _ctx: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        if (!opts.filter?.startsWith('disasterNumber in')) return { rows: [area], count: 1 };
        const skip = opts.skip ?? 0;
        if (skip === 0) return { rows: full, count: 40_000 };
        if (skip === 10_000) {
          throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Status: 503', { status: 503 });
        }
        const sibling: { skip: number; abortedBy?: boolean } = { skip };
        siblings.push(sibling);
        return new Promise((resolve, reject) => {
          const fallback = setTimeout(() => {
            sibling.abortedBy = false;
            resolve({ rows: full, count: 40_000 });
          }, 500);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            sibling.abortedBy = true;
            reject(new McpError(JsonRpcErrorCode.RequestCancelled, 'aborted'));
          });
        });
      },
    );
    await setMock({ fetchDisasters });
    const result = await runToolContract(femaSearchDisasters, { county: 'Bexar' });
    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as { area_totals_unavailable?: boolean; notice: string };
    expect(out.area_totals_unavailable).toBe(true);
    await vi.waitFor(() => expect(siblings.every((s) => s.abortedBy !== undefined)).toBe(true));
    expect(siblings).toEqual([
      { skip: 20_000, abortedBy: true },
      { skip: 30_000, abortedBy: true },
    ]);
    expect(out.notice).toContain('OpenFEMA answered it with HTTP 503');
  });
});

describe('femaSearchDisasters — response budget and next_offset (#46)', () => {
  /** `n` declarations, one area row each, newest first; titles padded to `titleLength`. */
  function declarations(n: number, titleLength = 20) {
    return Array.from({ length: n }, (_, i) =>
      makeDisasterRow({
        disasterNumber: 1000 + i,
        declarationTitle: `T${i}`.padEnd(titleLength, 'x'),
      }),
    );
  }

  type Page = {
    declarations: Array<{ disaster_number: number }>;
    total_declarations: number;
    returned_count: number;
    next_offset?: number;
    notice?: string;
  };

  async function page(rows: unknown[], input: Record<string, unknown>, count = rows.length) {
    await setMock({ fetchDisasters: vi.fn().mockResolvedValue({ rows, count }) });
    const result = await runToolContract(femaSearchDisasters, input);
    expect(result.isError).not.toBe(true);
    return { out: result.structuredContent as Page, text: contentText(result) };
  }

  it('cuts a page at 100,000 characters of declarations, between whole declarations, and names next_offset', async () => {
    /**
     * A long declaration type renders twice in each block (label and Type line) but serializes
     * once, so every block's text is longer than its JSON: the text surface sets each charge.
     */
    const rows = declarations(600, 200).map((row) => ({
      ...row,
      declarationType: 'X'.repeat(400),
    }));
    const { out, text } = await page(rows, { limit: 1000 });
    const returned = out.returned_count;
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(600);
    expect(out.declarations).toHaveLength(returned);
    const blocks = text
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('## '));
    expect(blocks).toHaveLength(returned);
    const charges = blocks.map((block, i) => {
      expect(block.length).toBeGreaterThan(JSON.stringify(out.declarations[i]).length);
      return block.length + 2;
    });
    const used = charges.reduce((n, c) => n + c, 0);
    expect(used).toBeLessThanOrEqual(100_000);
    // Every block renders to the same length, so one more declaration would cross the budget.
    expect(used + (charges[0] ?? 0)).toBeGreaterThan(100_000);
    expect(out.declarations.map((d) => d.disaster_number)).toEqual(
      Array.from({ length: returned }, (_, i) => 1000 + i),
    );
    expect(out.next_offset).toBe(returned);
    expect(out.total_declarations).toBe(600);
    const notice = `Returned ${returned} of the 600 matching declarations from offset 0, the most that fit the 100,000-character response budget; continue with offset ${returned}.`;
    expect(out.notice).toBe(notice);
    expect(text).toContain(notice);
    expect(text).toContain(`**Next offset:** ${returned}`);
    expect(text).toContain(`**${returned} of 600 unique declaration(s)**`);
  });

  it('says limit ended the page when it did', async () => {
    const { out } = await page(declarations(5), { limit: 2, offset: 1 });
    expect(out).toMatchObject({ returned_count: 2, next_offset: 3, total_declarations: 5 });
    expect(out.notice).toBe(
      'Returned 2 of the 5 matching declarations from offset 1, as many as limit allows; continue with offset 3.',
    );
  });

  it('returns a single declaration over the budget alone', async () => {
    const { out } = await page(declarations(2, 120_000), { limit: 10 });
    expect(out).toMatchObject({ returned_count: 1, next_offset: 1 });
    expect(out.notice).toContain('the most that fit the 100,000-character response budget');
  });

  it('pages by next_offset until it is absent, every declaration exactly once', async () => {
    const rows = declarations(600, 200);
    const seen: number[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const { out } = await page(rows, { limit: 1000, offset });
      seen.push(...out.declarations.map((d) => d.disaster_number));
      offset = out.next_offset;
      if (offset === undefined) expect(out).not.toHaveProperty('notice');
      pages += 1;
    }
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => 1000 + i));
  });

  it('continues within the window when the 10,000-row read truncated the match', async () => {
    const rows = [
      ...declarations(5),
      makeDisasterRow({ disasterNumber: 999, declarationDate: '2024-09-20T00:00:00.000Z' }),
    ];
    const { out } = await page(rows, { limit: 2 }, 25_000);
    expect(out).toMatchObject({ returned_count: 2, next_offset: 2, total_declarations: 5 });
    expect(out.notice).toContain(
      'Returned 2 of the 5 declarations dated after 2024-09-20 from offset 0, as many as limit allows; continue with offset 2.',
    );
    expect(out.notice).toContain('date_to=2024-09-20');
  });
});

describe('femaSearchDisasters — matched_areas format (#42)', () => {
  const declaration = {
    disaster_number: 4332,
    title: 'HURRICANE HARVEY',
    state: 'TX',
    incident_type: 'Hurricane',
    declaration_type: 'DR',
    declaration_date: '2017-08-25T00:00:00.000Z',
    ia_declared: true,
    pa_declared: true,
    hm_declared: true,
    designated_area_count: 53,
  };

  const render = (declarations: unknown[]) => {
    const result = femaSearchDisasters.output.parse({
      declarations,
      total_declarations: declarations.length,
      total_area_rows: 2,
      returned_count: declarations.length,
    });
    return (femaSearchDisasters.format!(result)[0] as { text: string }).text;
  };

  it('renders every matched area with its FIPS and its own programs', () => {
    const text = render([
      {
        ...declaration,
        matched_areas: [
          {
            area: 'Bexar (County)',
            fips_state_code: '48',
            fips_county_code: '029',
            ia_declared: false,
            pa_declared: true,
            hm_declared: true,
          },
          {
            area: 'Harris (County)',
            fips_state_code: '48',
            ia_declared: false,
            pa_declared: false,
            hm_declared: false,
          },
        ],
      },
    ]);
    expect(text).toContain('**Programs:** IA, PA, HM');
    expect(text).toContain('**Designated Areas:** 53');
    expect(text).toContain(
      '**Matched Areas:** Bexar (County) (FIPS 48029) — PA, HM; Harris (County) (state FIPS 48) — None declared',
    );
  });
});

describe('femaSearchDisasters — format() text, whole (characterization)', () => {
  it('renders the header and one blank-line-separated block per declaration', () => {
    const text = (
      femaSearchDisasters.format!({
        declarations: [
          {
            disaster_number: 4332,
            title: 'HURRICANE HARVEY',
            state: 'TX',
            incident_type: 'Hurricane',
            declaration_type: 'DR',
            declaration_date: '2017-08-25T00:00:00.000Z',
            incident_begin_date: '2017-08-23T00:00:00.000Z',
            incident_end_date: '2017-09-15T00:00:00.000Z',
            ia_declared: true,
            pa_declared: true,
            hm_declared: true,
            designated_area_count: 53,
            matched_areas: [
              {
                area: 'Harris (County)',
                fips_state_code: '48',
                fips_county_code: '201',
                ia_declared: true,
                pa_declared: true,
                hm_declared: true,
              },
              {
                area: 'Odd',
                fips_county_code: '999',
                ia_declared: false,
                pa_declared: false,
                hm_declared: false,
              },
            ],
          },
          {
            disaster_number: 5000,
            title: 'FIRE',
            state: 'CA',
            incident_type: 'Fire',
            declaration_type: '',
            declaration_date: '2024-01-01T00:00:00.000Z',
            incident_begin_date: '2024-01-01T00:00:00.000Z',
            ia_declared: false,
            pa_declared: false,
            hm_declared: false,
            designated_area_count: 1,
          },
        ],
        total_declarations: 2,
        total_area_rows: 54,
        returned_count: 2,
      })[0] as { text: string }
    ).text;
    expect(text).toBe(
      '**2 of 2 unique declaration(s)** (from 54 designated-area rows)\n\n## DR-4332 — HURRICANE HARVEY\n**State:** TX | **Type:** DR | **Incident:** Hurricane\n**Declared:** 2017-08-25T00:00:00.000Z\n**Period:** 2017-08-23T00:00:00.000Z → 2017-09-15T00:00:00.000Z\n**Programs:** IA, PA, HM\n**Designated Areas:** 53\n**Matched Areas:** Harris (County) (FIPS 48201) — IA, PA, HM; Odd (county FIPS 999) — None declared\n\n## Disaster #5000 — FIRE\n**State:** CA | **Type:**  | **Incident:** Fire\n**Declared:** 2024-01-01T00:00:00.000Z\n**Period:** 2024-01-01T00:00:00.000Z (ongoing)\n**Programs:** None declared\n**Designated Areas:** 1\n',
    );
  });
});
