/**
 * @fileoverview Tests for fema_get_housing_assistance tool.
 * @module tests/tools/fema-get-housing-assistance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';
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

  it('throws invalid_state for unknown state codes', async () => {
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({
      disaster_number: 4332,
      state: 'ZZ',
      type: 'owners',
    });
    await expect(femaGetHousingAssistance.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state' },
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

  it('formats output with owner and renter sections and a type-agnostic disaster label', () => {
    const output = {
      owners: [
        {
          disaster_number: 4781,
          state: 'TX',
          county: 'Harris',
          city: 'Houston',
          zip_code: '77002',
          valid_registrations: 1500,
          total_approved_ihp_amount: 4500000,
          repair_replace_amount: 3000000,
          rental_amount: 1000000,
        },
        {
          // No location fields — exercises the type-agnostic locLabel fallback header.
          disaster_number: 4781,
          state: 'TX',
          total_approved_ihp_amount: 100000,
        },
      ],
      renters: [
        {
          disaster_number: 4781,
          state: 'TX',
          county: 'Harris',
          rental_amount: 1000000,
        },
      ],
      owners_count: 2,
      renters_count: 1,
    };
    const blocks = femaGetHousingAssistance.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Owner Assistance');
    expect(text).toContain('Renter Assistance');
    expect(text).toContain('4,500,000');
    expect(text).toContain('Harris');
    // Type-agnostic disaster label in both sections — never a fabricated DR- prefix.
    expect(text).toContain('**Disaster:** #4781');
    expect(text).toContain('Disaster #4781');
    expect(text).not.toContain('DR-');
  });

  it('renders the disaster number for sparse records missing state, in both owner and renter sections (regression #20)', () => {
    // A sparse row with county/city/ZIP but no state: the heading uses the location, so the
    // disaster number only reaches content[] via the **Disaster:** line — previously gated on
    // `if (state)`, which dropped the join key in both the owner and renter loops.
    const output = {
      owners: [
        {
          disaster_number: 4798,
          county: 'Harris (County)',
          city: 'HOUSTON',
          zip_code: '77090',
          total_approved_ihp_amount: 250000,
        },
      ],
      renters: [
        {
          disaster_number: 4798,
          county: 'Harris (County)',
          city: 'HOUSTON',
          zip_code: '77090',
          rental_amount: 90000,
        },
      ],
      owners_count: 1,
      renters_count: 1,
    };
    const blocks = femaGetHousingAssistance.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // The join key must reach content[] in BOTH sections even though state is absent.
    expect((text.match(/\*\*Disaster:\*\* #4798/g) ?? []).length).toBe(2);
    expect(text).toContain('Owner Assistance');
    expect(text).toContain('Renter Assistance');
  });
});

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

describe('femaGetHousingAssistance — filters reaching OpenFEMA', () => {
  it('passes disaster number 32767, the top of the FEMA range, to both datasets', async () => {
    const fetchHousingAssistance: Mock = vi.fn().mockResolvedValue({
      rows: [makeOwnerRow({ disasterNumber: 32767 })],
      count: 1,
    });
    await setMock({ fetchHousingAssistance });
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 32767 });
    expect(result.isError).not.toBe(true);
    expect(fetchHousingAssistance.mock.calls.map((call) => call[0])).toEqual([
      'HousingAssistanceOwners',
      'HousingAssistanceRenters',
    ]);
    for (const call of fetchHousingAssistance.mock.calls) {
      expect(call[1]).toMatchObject({ filter: 'disasterNumber eq 32767' });
    }
  });
});

describe('femaGetHousingAssistance — empty match', () => {
  it('returns no_results with its contract code and recovery on both surfaces', async () => {
    await setMock({
      fetchHousingAssistance: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 9999 });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('no_results');
    expect(error.data.recovery?.hint).toBe(
      'No housing assistance records found for disaster 9999. IA housing data may take weeks to appear after a declaration. Verify the disaster number via fema_get_disaster and try again later.',
    );
    expect(contentText(result)).toContain('No IA housing records for disaster 9999.');
  });

  it('format() renders the no-records line with both counts when both totals are zero', () => {
    const text = (
      femaGetHousingAssistance.format!({
        owners: [],
        renters: [],
        owners_count: 0,
        renters_count: 0,
      })[0] as { text: string }
    ).text;
    expect(text).toContain('No housing assistance records available.');
    expect(text).toMatch(/owner[^\n]*\b0\b/i);
    expect(text).toMatch(/renter[^\n]*\b0\b/i);
  });
});

describe('femaGetHousingAssistance — disaster numbers above the FEMA range (#23)', () => {
  const getDisasterNotFound = femaGetDisaster.errors?.find((e) => e.reason === 'not_found');

  it('declares not_found with the same code and recovery as fema_get_disaster', () => {
    const entry = femaGetHousingAssistance.errors?.find((e) => e.reason === 'not_found');
    expect(getDisasterNotFound).toBeDefined();
    expect(entry?.code).toBe(getDisasterNotFound?.code);
    expect(entry?.recovery).toBe(getDisasterNotFound?.recovery);
  });

  it.each(['owners', 'renters', 'both'] as const)(
    'fails 32768 as not_found for type %s without fetching either dataset',
    async (type) => {
      const fetchHousingAssistance = vi.fn();
      await setMock({ fetchHousingAssistance });
      const result = await runToolContract(femaGetHousingAssistance, {
        disaster_number: 32768,
        type,
        limit: 1,
      });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('not_found');
      expect(error.data.recovery?.hint).toBe(getDisasterNotFound?.recovery);
      expect(contentText(result)).toContain(`Recovery: ${getDisasterNotFound?.recovery}`);
      expect(fetchHousingAssistance).not.toHaveBeenCalled();
    },
  );
});

describe('femaGetHousingAssistance — both counts on every response (#25)', () => {
  /** Serve each dataset its own rows and total. */
  async function serve(
    owners: { rows: unknown[]; count: number },
    renters: { rows: unknown[]; count: number },
  ) {
    await setMock({
      fetchHousingAssistance: vi
        .fn()
        .mockImplementation((dataset: string) =>
          Promise.resolve(dataset === 'HousingAssistanceOwners' ? owners : renters),
        ),
    });
  }

  it('type owners states a renter count of 0', async () => {
    await serve({ rows: [makeOwnerRow()], count: 1064 }, { rows: [makeRenterRow()], count: 1152 });
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4781,
      type: 'owners',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({ owners_count: 1064, renters_count: 0 });
    const text = contentText(result);
    expect(text).toMatch(/owner[^\n]*\b1 of 1064\b/i);
    expect(text).toMatch(/renter[^\n]*\b0 of 0\b/i);
  });

  it('type renters states an owner count of 0', async () => {
    await serve({ rows: [makeOwnerRow()], count: 1064 }, { rows: [makeRenterRow()], count: 1152 });
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4781,
      type: 'renters',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({ owners_count: 0, renters_count: 1152 });
    const text = contentText(result);
    expect(text).toMatch(/owner[^\n]*\b0 of 0\b/i);
    expect(text).toMatch(/renter[^\n]*\b1 of 1152\b/i);
  });

  it('type both with the owner page empty still states the owner total', async () => {
    await serve({ rows: [], count: 1064 }, { rows: [makeRenterRow()], count: 1152 });
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4781,
      type: 'both',
      offset: 1100,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ owners_count: 1064, renters_count: 1152 });
    const text = contentText(result);
    expect(text).toMatch(/owner[^\n]*\b0 of 1064\b/i);
    expect(text).toContain('Renter Assistance');
  });

  it('type both with both pages populated keeps both sections and their counts', async () => {
    await serve({ rows: [makeOwnerRow()], count: 1064 }, { rows: [makeRenterRow()], count: 1152 });
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4781,
      limit: 1,
    });
    const text = contentText(result);
    expect(text).toContain('## Owner Assistance (1 of 1064 records)');
    expect(text).toContain('## Renter Assistance (1 of 1152 records)');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});
