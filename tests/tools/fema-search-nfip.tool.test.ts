/**
 * @fileoverview Tests for fema_search_nfip tool — including canvas spillover path.
 * @module tests/tools/fema-search-nfip.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaSearchNfip } from '@/mcp-server/tools/definitions/fema-search-nfip.tool.js';

// Mock the canvas module at the top level so `spillover` can be controlled per-test
vi.mock('@cyanheads/mcp-ts-core/canvas', () => ({
  spillover: vi.fn(),
}));

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

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

async function setSvcMock(impl: Record<string, unknown>) {
  const mod = await import('@/services/openfema/openfema-service.js');
  (mod as unknown as { __setMock: (s: Record<string, unknown>) => void }).__setMock(impl);
}

async function setCanvasMock(impl: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(impl);
}

function makeClaimRow(overrides: Record<string, unknown> = {}) {
  return {
    state: 'TX',
    countyCode: '201',
    reportedZipCode: '77002',
    dateOfLoss: '2024-05-15T00:00:00.000Z',
    yearOfLoss: 2024,
    amountPaidOnBuildingClaim: 50000,
    amountPaidOnContentsClaim: 10000,
    ratedFloodZone: 'AE',
    causeOfDamage: 'Overflow of Inland Waters',
    occupancyType: '1',
    ...overrides,
  };
}

describe('femaSearchNfip — no canvas', () => {
  beforeEach(async () => {
    await setSvcMock({
      fetchNfipClaims: vi.fn().mockResolvedValue({
        rows: [makeClaimRow()],
        count: 1,
      }),
    });
    await setCanvasMock(undefined); // canvas disabled
  });

  it('returns inline claims when canvas is disabled', async () => {
    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX' });
    const result = await femaSearchNfip.handler(input, ctx);
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      state: 'TX',
      county_code: '201',
      year_of_loss: 2024,
      amount_paid_building: 50000,
    });
    expect(result.total_count).toBe(1);
  });

  it('rejects empty state at the Zod validation layer', () => {
    // state is required and must be exactly 2 chars — Zod rejects before the handler runs
    expect(() => femaSearchNfip.input.parse({ state: '' })).toThrow();
    expect(() => femaSearchNfip.input.parse({})).toThrow();
  });

  it('handles sparse claim rows with missing optional fields', async () => {
    await setSvcMock({
      fetchNfipClaims: vi.fn().mockResolvedValue({
        rows: [{ state: 'TX' }], // only state present
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX' });
    const result = await femaSearchNfip.handler(input, ctx);
    expect(result.claims[0]?.state).toBe('TX');
    expect(result.claims[0]?.amount_paid_building).toBeUndefined();
    expect(result.claims[0]?.year_of_loss).toBeUndefined();
  });
});

describe('femaSearchNfip — canvas spillover path', () => {
  beforeEach(async () => {
    await setSvcMock({
      fetchNfipClaims: vi.fn().mockResolvedValue({
        rows: Array.from({ length: 10 }, (_, i) => makeClaimRow({ yearOfLoss: 2020 + i })),
        count: 5000,
      }),
    });
  });

  it('returns canvas_id and spilled=true when canvas spills', async () => {
    // Import the mocked spillover and configure it for this test
    const { spillover } = await import('@cyanheads/mcp-ts-core/canvas');
    vi.mocked(spillover).mockResolvedValueOnce({
      spilled: true,
      previewRows: [makeClaimRow()],
      handle: { tableName: 'spilled_abc123', rowCount: 5000 },
      truncated: false,
    } as Awaited<ReturnType<typeof spillover>>);

    const mockInstance = {
      canvasId: 'canvas_abc123',
      query: vi.fn(),
      describe: vi.fn(),
    };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    await setCanvasMock(mockCanvas);

    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX' });
    const result = await femaSearchNfip.handler(input, ctx);
    expect(result.canvas_id).toBe('canvas_abc123');
    expect(result.spilled).toBe(true);
    expect(result.canvas_table).toBe('spilled_abc123');
    expect(result.returned_count).toBe(1);
  });

  it('does NOT return canvas_id when result fits inline (secondary bug fix)', async () => {
    const { spillover } = await import('@cyanheads/mcp-ts-core/canvas');
    const previewRows = Array.from({ length: 10 }, (_, i) =>
      makeClaimRow({ yearOfLoss: 2020 + i }),
    ).map((r) => ({
      state: r.state,
      county_code: r.countyCode ?? null,
      zip_code: null,
      date_of_loss: null,
      year_of_loss: r.yearOfLoss,
      amount_paid_building: r.amountPaidOnBuildingClaim ?? null,
      amount_paid_contents: null,
      building_damage_amount: null,
      contents_damage_amount: null,
      rated_flood_zone: null,
      cause_of_damage: null,
      occupancy_type: null,
    }));
    vi.mocked(spillover).mockResolvedValueOnce({
      spilled: false,
      previewRows,
      // handle is undefined when spilled:false — match the actual spillover shape
    } as Awaited<ReturnType<typeof spillover>>);

    const mockInstance = {
      canvasId: 'canvas_xyz',
      query: vi.fn(),
      describe: vi.fn(),
    };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    await setCanvasMock(mockCanvas);

    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX' });
    const result = await femaSearchNfip.handler(input, ctx);
    // Secondary bug (#5): non-spilled path must NOT return a canvas_id (nothing was staged)
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.canvas_table).toBeUndefined();
  });
});

describe('femaSearchNfip — canvas staged set vs limit (regression #5 primary)', () => {
  it('stages MAX_CANVAS_ROWS rows independent of limit; truncated=true when cap hit', async () => {
    const { spillover } = await import('@cyanheads/mcp-ts-core/canvas');
    // Simulate a full canvas: 50k rows staged, preview has input.limit rows, cap was hit
    const previewRow = {
      state: 'TX',
      county_code: '48201',
      zip_code: null,
      date_of_loss: null,
      year_of_loss: 2017,
      amount_paid_building: null,
      amount_paid_contents: null,
      building_damage_amount: null,
      contents_damage_amount: null,
      rated_flood_zone: null,
      cause_of_damage: null,
      occupancy_type: null,
    };
    vi.mocked(spillover).mockResolvedValueOnce({
      spilled: true,
      previewRows: [previewRow],
      handle: { tableName: 'spilled_harvey', rowCount: 50000 },
      truncated: true,
    } as Awaited<ReturnType<typeof spillover>>);

    // fetchNfipClaims mock — called by the paginating generator
    const mockFetch = vi.fn().mockResolvedValue({
      rows: Array.from({ length: 1000 }, () => makeClaimRow({ countyCode: '48201' })),
      count: 49785,
    });
    await setSvcMock({ fetchNfipClaims: mockFetch });

    const mockInstance = { canvasId: 'canvas_harvey', query: vi.fn(), describe: vi.fn() };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    await setCanvasMock(mockCanvas);

    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    // limit=8 should NOT constrain the staged row count (that's what bug #5 was)
    const input = femaSearchNfip.input.parse({
      state: 'TX',
      county_code: '48201',
      year_from: 2017,
      year_to: 2017,
      limit: 8,
    });
    const result = await femaSearchNfip.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('canvas_harvey');
    // total_count reflects staged count (50000), not limit (8)
    expect(result.total_count).toBe(50000);
    // truncated=true because cap was hit
    expect(result.truncated).toBe(true);
    // inline preview capped to input.limit
    expect(result.returned_count).toBeLessThanOrEqual(8);

    // Verify spillover was called with the async generator (not a pre-materialized array)
    const spilloverArgs = vi.mocked(spillover).mock.calls[0]?.[0];
    expect(spilloverArgs?.source).toBeDefined();
    // An async generator has a Symbol.asyncIterator
    const source = spilloverArgs?.source as AsyncGenerator;
    expect(typeof source[Symbol.asyncIterator]).toBe('function');
  });
});

describe('femaSearchNfip — county_code normalization (regression #6)', () => {
  beforeEach(async () => {
    await setCanvasMock(undefined); // canvas disabled — test normalization via filter
  });

  it('prepends state FIPS when county_code is 3 digits', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      rows: [makeClaimRow({ countyCode: '48201' })],
      count: 49785,
    });
    await setSvcMock({ fetchNfipClaims: mockFetch });

    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX', county_code: '201' });
    const result = await femaSearchNfip.handler(input, ctx);

    // Verify the filter sent to the service uses 5-digit FIPS
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.stringContaining("countyCode eq '48201'"),
      }),
      ctx,
    );
    // Output county_code reflects what the API returned (48201)
    expect(result.claims[0]?.county_code).toBe('48201');
  });

  it('passes 5-digit county_code through unchanged', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      rows: [makeClaimRow({ countyCode: '48201' })],
      count: 49785,
    });
    await setSvcMock({ fetchNfipClaims: mockFetch });

    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    const input = femaSearchNfip.input.parse({ state: 'TX', county_code: '48201' });
    const result = await femaSearchNfip.handler(input, ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.stringContaining("countyCode eq '48201'"),
      }),
      ctx,
    );
    expect(result.claims[0]?.county_code).toBe('48201');
  });
});

describe('femaSearchNfip — format', () => {
  it('formats inline results with claims fields', () => {
    const output = {
      claims: [
        {
          state: 'TX',
          county_code: '201',
          zip_code: '77002',
          date_of_loss: '2024-05-15T00:00:00.000Z',
          year_of_loss: 2024,
          rated_flood_zone: 'AE',
          cause_of_damage: 'Overflow',
          amount_paid_building: 50000,
          amount_paid_contents: 10000,
        },
      ],
      total_count: 5000,
      returned_count: 1,
      spilled: false,
    };
    const blocks = femaSearchNfip.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 of 5000');
    expect(text).toContain('TX');
    expect(text).toContain('50,000');
    expect(text).toContain('AE');
  });

  it('formats spilled result with canvas_id reference', () => {
    const output = {
      claims: [{ state: 'TX', year_of_loss: 2024, amount_paid_building: 50000 }],
      total_count: 5000,
      returned_count: 1,
      canvas_id: 'canvas_abc123',
      canvas_table: 'spilled_abc123',
      spilled: true,
    };
    const blocks = femaSearchNfip.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas_abc123');
    expect(text).toContain('spilled_abc123');
    expect(text).toContain('fema_dataframe_query');
  });
});
