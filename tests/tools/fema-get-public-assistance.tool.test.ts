/**
 * @fileoverview Tests for fema_get_public_assistance tool.
 * @module tests/tools/fema-get-public-assistance.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaGetPublicAssistance } from '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js';

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

function makePaRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    pwNumber: 'PW-001',
    applicantId: 'TXHC',
    applicationTitle: 'Harris County Road Repair',
    damageCategoryCode: 'C',
    damageCategoryDescrip: 'Roads and Bridges',
    projectAmount: 500000,
    federalShareObligated: 375000,
    totalObligated: 500000,
    county: 'Harris',
    stateAbbreviation: 'TX',
    projectStatus: 'Obligated',
    projectSize: 'Large',
    firstObligationDate: '2024-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('femaGetPublicAssistance', () => {
  beforeEach(async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({
        rows: [makePaRow()],
        count: 1,
      }),
    });
  });

  it('returns PA project records for a disaster', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      disaster_number: 4781,
      pw_number: 'PW-001',
      damage_category_code: 'C',
      total_obligated: 500000,
    });
    expect(result.total_count).toBe(1);
    expect(result.returned_count).toBe(1);
  });

  it('returns projects when only state is provided', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ state: 'TX' });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects).toHaveLength(1);
  });

  it('throws missing_filter when neither disaster_number nor state provided', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({});
    await expect(femaGetPublicAssistance.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_filter' },
    });
  });

  it('throws no_results when query returns empty rows', async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 9999 });
    await expect(femaGetPublicAssistance.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('handles sparse PA rows with missing optional fields', async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({
        rows: [{ disasterNumber: 4781 }],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects[0]?.disaster_number).toBe(4781);
    expect(result.projects[0]?.total_obligated).toBeUndefined();
    expect(result.projects[0]?.project_status).toBeUndefined();
  });

  it('formats output with obligated amounts', () => {
    const output = {
      projects: [
        {
          disaster_number: 4781,
          pw_number: 'PW-001',
          application_title: 'Road Repair',
          damage_category_code: 'C',
          damage_category_description: 'Roads and Bridges',
          total_obligated: 500000,
          federal_share_obligated: 375000,
          project_amount: 500000,
          project_status: 'Obligated',
          project_size: 'Large',
          county: 'Harris',
        },
      ],
      total_count: 5,
      returned_count: 1,
    };
    const blocks = femaGetPublicAssistance.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Road Repair');
    expect(text).toContain('500,000');
    expect(text).toContain('DR-4781');
  });
});
