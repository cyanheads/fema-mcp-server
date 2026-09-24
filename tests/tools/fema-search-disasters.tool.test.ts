/**
 * @fileoverview Tests for fema_search_disasters tool.
 * @module tests/tools/fema-search-disasters.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaSearchDisasters } from '@/mcp-server/tools/definitions/fema-search-disasters.tool.js';

// Mock the service module — handler calls getOpenFemaService() at runtime
vi.mock('@/services/openfema/openfema-service.js', () => {
  let _mockSvc: Record<string, unknown>;
  return {
    getOpenFemaService: () => _mockSvc,
    initOpenFemaService: () => {},
    escapeODataString: (value: string) => value.replace(/'/g, "''"),
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
