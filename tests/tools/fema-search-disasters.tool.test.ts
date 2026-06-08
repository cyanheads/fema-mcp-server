/**
 * @fileoverview Tests for fema_search_disasters tool.
 * @module tests/tools/fema-search-disasters.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      total_count: 10,
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
});
