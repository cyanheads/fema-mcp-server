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

  it('throws state_required when state is missing', async () => {
    const ctx = createMockContext({ errors: femaSearchNfip.errors });
    // state has a Zod required constraint — bypass by casting
    const input = { state: '', limit: 100 } as ReturnType<typeof femaSearchNfip.input.parse>;
    await expect(femaSearchNfip.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'state_required' },
    });
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

  it('returns canvas_id and spilled=false when result fits inline', async () => {
    const { spillover } = await import('@cyanheads/mcp-ts-core/canvas');
    const previewRows = Array.from({ length: 10 }, (_, i) =>
      makeClaimRow({ yearOfLoss: 2020 + i }),
    );
    vi.mocked(spillover).mockResolvedValueOnce({
      spilled: false,
      previewRows: previewRows.map((r) => ({
        state: r.state,
        year_of_loss: r.yearOfLoss,
      })),
      handle: { tableName: '', rowCount: 10 },
      truncated: false,
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
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('canvas_xyz');
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
