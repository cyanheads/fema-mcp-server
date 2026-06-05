/**
 * @fileoverview Tests for fema_get_housing_assistance tool.
 * @module tests/tools/fema-get-housing-assistance.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { femaGetHousingAssistance } from '@/mcp-server/tools/definitions/fema-get-housing-assistance.tool.js';

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

function makeOwnerRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    state: 'TX',
    county: 'Harris',
    city: 'Houston',
    zipCode: '77002',
    validRegistrations: 1500,
    approvedForFemaAssistance: 900,
    totalApprovedIhpAmount: 4500000,
    repairReplaceAmount: 3000000,
    rentalAmount: 1000000,
    otherNeedsAmount: 500000,
    ...overrides,
  };
}

function makeRenterRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    state: 'TX',
    county: 'Harris',
    city: 'Houston',
    zipCode: '77002',
    validRegistrations: 800,
    approvedForFemaAssistance: 600,
    totalApprovedIhpAmount: 1200000,
    rentalAmount: 1000000,
    otherNeedsAmount: 200000,
    ...overrides,
  };
}

describe('femaGetHousingAssistance', () => {
  beforeEach(async () => {
    await setMock({
      fetchHousingAssistance: vi.fn().mockImplementation((dataset: string) => {
        if (dataset === 'HousingAssistanceOwners') {
          return Promise.resolve({ rows: [makeOwnerRow()], count: 1 });
        }
        return Promise.resolve({ rows: [makeRenterRow()], count: 1 });
      }),
    });
  });

  it('returns owners and renters when type is both', async () => {
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetHousingAssistance.handler(input, ctx);
    expect(result.owners).toHaveLength(1);
    expect(result.renters).toHaveLength(1);
    expect(result.owners_count).toBe(1);
    expect(result.renters_count).toBe(1);
    expect(result.owners[0]).toMatchObject({
      disaster_number: 4781,
      county: 'Harris',
      total_approved_ihp_amount: 4500000,
    });
  });

  it('returns only owners when type is owners', async () => {
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 4781, type: 'owners' });
    const result = await femaGetHousingAssistance.handler(input, ctx);
    expect(result.owners).toHaveLength(1);
    expect(result.renters).toHaveLength(0);
  });

  it('returns only renters when type is renters', async () => {
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 4781, type: 'renters' });
    const result = await femaGetHousingAssistance.handler(input, ctx);
    expect(result.owners).toHaveLength(0);
    expect(result.renters).toHaveLength(1);
  });

  it('throws no_results when both datasets return empty', async () => {
    await setMock({
      fetchHousingAssistance: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 9999 });
    await expect(femaGetHousingAssistance.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('handles sparse rows with missing optional amount fields', async () => {
    await setMock({
      fetchHousingAssistance: vi.fn().mockResolvedValue({
        rows: [{ disasterNumber: 4781, state: 'TX' }],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetHousingAssistance.handler(input, ctx);
    expect(result.owners[0]?.total_approved_ihp_amount).toBeUndefined();
    expect(result.owners[0]?.county).toBeUndefined();
    expect(result.owners[0]?.disaster_number).toBe(4781);
  });

  it('formats output with owner and renter sections', () => {
    const output = {
      owners: [
        {
          disaster_number: 4781,
          county: 'Harris',
          city: 'Houston',
          zip_code: '77002',
          valid_registrations: 1500,
          total_approved_ihp_amount: 4500000,
          repair_replace_amount: 3000000,
          rental_amount: 1000000,
        },
      ],
      renters: [
        {
          disaster_number: 4781,
          county: 'Harris',
          rental_amount: 1000000,
        },
      ],
      owners_count: 1,
      renters_count: 1,
    };
    const blocks = femaGetHousingAssistance.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Owner Assistance');
    expect(text).toContain('Renter Assistance');
    expect(text).toContain('4,500,000');
    expect(text).toContain('Harris');
  });
});
