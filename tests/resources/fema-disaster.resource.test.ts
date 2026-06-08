/**
 * @fileoverview Tests for fema://disaster/{disasterNumber} resource.
 * @module tests/resources/fema-disaster.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaDisasterResource } from '@/mcp-server/resources/definitions/fema-disaster.resource.js';

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

function makeDisasterRow(overrides: Record<string, unknown> = {}) {
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
    ihProgramDeclared: true, // IHP flag (correct); iaProgramDeclared is legacy/false for major disasters
    paProgramDeclared: true,
    hmProgramDeclared: false,
    ...overrides,
  };
}

describe('femaDisasterResource', () => {
  beforeEach(async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [makeDisasterRow(), makeDisasterRow({ designatedArea: 'Montgomery County' })],
        count: 2,
      }),
    });
  });

  it('returns disaster summary as JSON content', async () => {
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: '4781' });
    const result = await femaDisasterResource.handler(params, ctx);
    expect(result).toMatchObject({
      disaster_number: 4781,
      title: 'HURRICANE HELENE',
      state: 'TX',
      incident_type: 'Hurricane',
    });
    // designated_area_count should reflect the number of rows (2 area rows)
    expect(result.designated_area_count).toBe(2);
    // programs_declared should include IA and PA
    expect(result.programs_declared).toContain('IA');
    expect(result.programs_declared).toContain('PA');
    expect(result.programs_declared).not.toContain('HM');
  });

  it('programs_declared uses ihProgramDeclared (IHP flag), not iaProgramDeclared', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({
            ihProgramDeclared: true,
            iaProgramDeclared: false, // legacy flag — should NOT drive IA in programs_declared
          }),
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: '4781' });
    const result = await femaDisasterResource.handler(params, ctx);
    expect(result.programs_declared).toContain('IA');
  });

  it('programs_declared ORs ihProgramDeclared across all area rows', async () => {
    // First row has ihProgramDeclared: false; a later row has true.
    // Result must contain IA regardless of row order.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeDisasterRow({ ihProgramDeclared: false }),
          makeDisasterRow({ ihProgramDeclared: false }),
          makeDisasterRow({ ihProgramDeclared: true }),
        ],
        count: 3,
      }),
    });
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: '4781' });
    const result = await femaDisasterResource.handler(params, ctx);
    expect(result.programs_declared).toContain('IA');
    expect(result.designated_area_count).toBe(3);
  });

  it('throws NotFound for an invalid (non-numeric) disaster number', async () => {
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: 'abc' });
    await expect(femaDisasterResource.handler(params, ctx)).rejects.toThrow();
  });

  it('throws NotFound when the disaster number has no records', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: '9999' });
    await expect(femaDisasterResource.handler(params, ctx)).rejects.toThrow();
  });

  it('handles sparse rows with missing optional fields', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          {
            disasterNumber: 4781,
            declarationTitle: 'SPARSE EVENT',
            state: 'FL',
            // no stateName, no incidentBeginDate, no incidentEndDate, no programs
          },
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext();
    const params = femaDisasterResource.params.parse({ disasterNumber: '4781' });
    const result = await femaDisasterResource.handler(params, ctx);
    expect(result.title).toBe('SPARSE EVENT');
    expect((result as Record<string, unknown>).state_name).toBeUndefined();
    expect(result.incident_begin_date).toBeUndefined();
    // programs_declared should be an empty array
    expect(result.programs_declared).toEqual([]);
  });
});
