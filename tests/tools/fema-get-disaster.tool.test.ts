/**
 * @fileoverview Tests for fema_get_disaster tool.
 * @module tests/tools/fema-get-disaster.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    ihProgramDeclared: true, // IHP flag (correct); iaProgramDeclared is legacy/false for major disasters
    paProgramDeclared: true,
    hmProgramDeclared: false,
    designatedArea: 'Harris County',
    fipsStateCode: '48',
    fipsCountyCode: '201',
    ...overrides,
  };
}

describe('femaGetDisaster', () => {
  it.each([9999, 32768])(
    'retains not_found code and recovery on both surfaces for %s (#54)',
    async (disaster_number) => {
      const fetchDisasters = vi.fn().mockResolvedValue({ rows: [], count: 0 });
      await setMock({ fetchDisasters });
      const result = await runToolContract(femaGetDisaster, { disaster_number });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'not_found',
            recovery: { hint: expect.stringContaining('fema_search_disasters') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('fema_search_disasters');
      expect(fetchDisasters).toHaveBeenCalledTimes(disaster_number > 32767 ? 0 : 1);
    },
  );

  it.each([2, 1000])('keeps complete declarations unchanged at %s rows (#54)', async (count) => {
    const fetchDisasters = vi
      .fn()
      .mockResolvedValue({ rows: Array.from({ length: count }, () => makeAreaRow()), count });
    await setMock({ fetchDisasters });
    const result = await runToolContract(femaGetDisaster, { disaster_number: 4781 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      designated_area_count: count,
      ia_declared: true,
      pa_declared: true,
    });
    for (const key of ['areas_truncated', 'total_designated_area_count', 'notice'])
      expect(result.structuredContent).not.toHaveProperty(key);
    expect(fetchDisasters).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'discloses partial area and program evidence on both surfaces: %s (#54)',
    async (positive) => {
      const fetchDisasters = vi.fn().mockResolvedValue({
        rows: Array.from({ length: 1000 }, () =>
          makeAreaRow({
            ihProgramDeclared: positive,
            paProgramDeclared: false,
            hmProgramDeclared: false,
          }),
        ),
        count: 1200,
      });
      await setMock({ fetchDisasters });
      const result = await runToolContract(femaGetDisaster, { disaster_number: 4781 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        areas_truncated: true,
        total_designated_area_count: 1200,
        designated_area_count: 1000,
        ia_declared: positive,
        pa_declared: false,
        notice: expect.stringContaining('program flags cover only fetched rows'),
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('1000 of 1200');
      expect(text).toContain('fema_query_dataset');
      expect(text).not.toContain('**Programs Declared:** None');
      expect(fetchDisasters).toHaveBeenCalledTimes(1);
      expect(fetchDisasters.mock.calls[0]?.[0].top).toBe(1000);
    },
  );

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

  it('ia_declared reflects ihProgramDeclared (IHP flag), not iaProgramDeclared', async () => {
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeAreaRow({
            ihProgramDeclared: true,
            iaProgramDeclared: false, // legacy flag — should NOT be used
          }),
        ],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 4781 });
    const result = await femaGetDisaster.handler(input, ctx);
    expect(result.ia_declared).toBe(true);
  });

  it('ia_declared is true when any area row has ihProgramDeclared true (OR rollup)', async () => {
    // Some rows may have ihProgramDeclared: false even though the disaster has IHP declared.
    // The rollup must OR across all rows, not take the first row's value.
    await setMock({
      fetchDisasters: vi.fn().mockResolvedValue({
        rows: [
          makeAreaRow({ ihProgramDeclared: false }), // first row is false
          makeAreaRow({ ihProgramDeclared: false, designatedArea: 'Bexar County' }),
          makeAreaRow({ ihProgramDeclared: true, designatedArea: 'Travis County' }), // later row is true
        ],
        count: 3,
      }),
    });
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 4781 });
    const result = await femaGetDisaster.handler(input, ctx);
    expect(result.ia_declared).toBe(true);
    expect(result.designated_area_count).toBe(3);
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

  it('throws not_found without calling the service when disaster_number > 32767', async () => {
    const fetchDisastersMock = vi.fn().mockResolvedValue({ rows: [], count: 0 });
    await setMock({ fetchDisasters: fetchDisastersMock });
    const ctx = createMockContext({ errors: femaGetDisaster.errors });
    const input = femaGetDisaster.input.parse({ disaster_number: 32768 });
    await expect(femaGetDisaster.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
    // Guard fires before the API call
    expect(fetchDisastersMock).not.toHaveBeenCalled();
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

  it.each([
    ['FM', 5634],
    ['EM', 3600],
  ] as const)(
    'format prefixes the disaster number with the real %s declaration type',
    (type, num) => {
      const output = {
        disaster_number: num,
        title: 'TEST EVENT',
        state: 'TX',
        incident_type: 'Fire',
        declaration_type: type,
        declaration_date: '2024-01-01T00:00:00.000Z',
        ia_declared: false,
        pa_declared: false,
        hm_declared: false,
        designated_areas: [{ area: 'Harris County' }],
        designated_area_count: 1,
      };
      const text = (femaGetDisaster.format!(output)[0] as { text: string }).text;
      expect(text).toContain(`${type}-${num}`);
      expect(text).not.toContain(`DR-${num}`);
    },
  );

  it('format falls back to a type-agnostic label when declaration_type is absent', () => {
    const output = {
      disaster_number: 9999,
      title: 'UNTYPED EVENT',
      state: 'CA',
      incident_type: 'Flood',
      declaration_type: '',
      declaration_date: '2024-03-01T00:00:00.000Z',
      ia_declared: false,
      pa_declared: false,
      hm_declared: false,
      designated_areas: [{ area: 'Los Angeles County' }],
      designated_area_count: 1,
    };
    const text = (femaGetDisaster.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Disaster #9999');
    expect(text).not.toContain('DR-9999');
    expect(text).not.toContain('-9999');
  });
});
