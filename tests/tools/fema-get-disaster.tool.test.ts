/**
 * @fileoverview Tests for fema_get_disaster tool.
 * @module tests/tools/fema-get-disaster.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';

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

function makeAreaRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    declarationTitle: 'HURRICANE HELENE',
    state: 'TX',
    stateName: 'Texas',
    incidentType: 'Hurricane',
    declarationType: 'DR',
    declarationDate: '2024-09-27T00:00:00.000Z',
    incidentBeginDate: '2024-09-26T00:00:00.000Z',
    incidentEndDate: '2024-09-28T00:00:00.000Z',
    iaProgramDeclared: true,
    paProgramDeclared: true,
    hmProgramDeclared: false,
    designatedArea: 'Harris County',
    fipsStateCode: '48',
    fipsCountyCode: '201',
    ...overrides,
  };
}

describe('femaGetDisaster', () => {
  beforeEach(async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeAreaRow(),
          makeAreaRow({ designatedArea: 'Montgomery County', fipsCountyCode: '339' }),
        ],
        count: 2,
      }),
    });
  });

  it('returns all designated areas for a disaster', async () => {
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 4781 });
    const result = await femaGetDisaster.handler(input, ctx);
    expect(result.disaster_number).toBe(4781);
    expect(result.title).toBe('HURRICANE HELENE');
    expect(result.state).toBe('TX');
    expect(result.designated_areas).toHaveLength(2);
    expect(result.designated_area_count).toBe(2);
    expect(result.ia_declared).toBe(true);
    expect(result.pa_declared).toBe(true);
  });

  it('includes FIPS codes when present', async () => {
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 4781 });
    const result = await femaGetDisaster.handler(input, ctx);
    expect(result.designated_areas[0]).toMatchObject({
      area: 'Harris County',
      fips_state_code: '48',
      fips_county_code: '201',
    });
  });

  it('throws not_found when disaster_number has no rows', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 9999 });
    await expect(femaGetDisaster.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('handles sparse rows (missing optional dates)', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          {
            disasterNumber: 4781,
            declarationTitle: 'SPARSE DISASTER',
            state: 'FL',
            // no incidentBeginDate, no incidentEndDate, no stateName
          },
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 4781 });
    const result = await femaGetDisaster.handler(input, ctx);
    expect(result.incident_begin_date).toBeUndefined();
    expect(result.incident_end_date).toBeUndefined();
    expect(result.state_name).toBeUndefined();
    expect(result.ia_declared).toBe(false);
  });

  it('formats output with disaster number, programs, and areas', () => {
    const output = {
      disaster_number: 4781,
      title: 'TEST DISASTER',
      state: 'TX',
      incident_type: 'Hurricane',
      declaration_type: 'DR',
      declaration_date: '2024-01-01T00:00:00.000Z',
      incident_begin_date: '2024-01-01T00:00:00.000Z',
      ia_declared: true,
      pa_declared: false,
      hm_declared: false,
      designated_areas: [{ area: 'Harris County', fips_state_code: '48', fips_county_code: '201' }],
      designated_area_count: 1,
    };
    const blocks = femaGetDisaster.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DR-4781');
    expect(text).toContain('TEST DISASTER');
    expect(text).toContain('Individual Assistance (IA)');
    expect(text).toContain('Harris County');
    expect(text).toContain('FIPS 48201');
  });
});
