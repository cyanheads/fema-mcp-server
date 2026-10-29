/**
 * @fileoverview Tests for fema_get_housing_assistance tool.
 * @module tests/tools/fema-get-housing-assistance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';
import { femaGetHousingAssistance } from '@/mcp-server/tools/definitions/fema-get-housing-assistance.tool.js';

// Only the service accessor is stubbed: the county matcher runs the real escapeODataString.
vi.mock('@/services/openfema/openfema-service.js', async (importOriginal) => {
  let _mockSvc: Record<string, unknown>;
  return {
    ...(await importOriginal<object>()),
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

  it('returns zero totals when both datasets return empty', async () => {
    await setMock({
      fetchHousingAssistance: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaGetHousingAssistance.errors });
    const input = femaGetHousingAssistance.input.parse({ disaster_number: 9999 });
    await expect(femaGetHousingAssistance.handler(input, ctx)).resolves.toMatchObject({
      owners: [],
      renters: [],
      owners_count: 0,
      renters_count: 0,
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

const commonmark = new MarkdownIt('commonmark');

/** The lines a CommonMark client displays for `markdown`, with emphasis, code spans, and escapes resolved. */
function renderedLines(markdown: string): string[] {
  return commonmark
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .flatMap((token) =>
      (token.children ?? [])
        .map((child) =>
          child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content,
        )
        .join('')
        .split('\n'),
    );
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
  it.each(['owners', 'renters', 'both'] as const)(
    'returns empty %s success on both surfaces at any offset',
    async (type) => {
      await setMock({
        fetchHousingAssistance: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      for (const offset of [0, 50]) {
        const result = await runToolContract(femaGetHousingAssistance, {
          disaster_number: 9999,
          type,
          offset,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          owners: [],
          renters: [],
          owners_count: 0,
          renters_count: 0,
          notice: expect.stringContaining('fema_get_disaster'),
        });
        expect(contentText(result)).toContain('No IA housing records matched for disaster 9999.');
        expect(contentText(result)).not.toMatch(/last valid offset|ZIP|county/);
        expect(result.structuredContent).not.toHaveProperty('next_offset');
      }
    },
  );

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
    expect(result.structuredContent).toMatchObject({
      next_offset: 1,
      notice:
        'Returned 1 of the 1064 owner records and 1 of the 1152 renter records from offset 0, as many as limit allows; continue with offset 1.',
    });
  });
});

describe('femaGetHousingAssistance — response budget and next_offset (#46)', () => {
  const BUDGET = 100_000;
  /** Owner `i` and renter `i` of ordered matches; zip_code identifies each. */
  const owner = (i: number) =>
    makeOwnerRow({
      zipCode: String(10_000 + i),
      city: `City ${'c'.repeat(120)}`,
      totalInspected: 12,
      averageFemaInspectedDamage: 11438.86,
      totalDamage: 77646948.98,
      noFemaInspectedDamage: 3,
    });
  const renter = (i: number) =>
    makeRenterRow({
      zipCode: String(10_000 + i),
      city: `Town ${'t'.repeat(80)}`,
      totalInspected: 3,
      totalInspectedWithNoDamage: 4,
      totalWithModerateDamage: 2,
      totalWithMajorDamage: 1,
      totalWithSubstantialDamage: 0,
    });

  /** Serve `owners` owner and `renters` renter records the way OpenFEMA pages each dataset. */
  async function serve(owners: number, renters: number) {
    const fetchHousingAssistance = vi
      .fn()
      .mockImplementation(
        (dataset: string, { skip = 0, top = 1000 }: { skip?: number; top?: number }) => {
          const [total, row] =
            dataset === 'HousingAssistanceOwners' ? [owners, owner] : [renters, renter];
          const size = Math.max(0, Math.min(top, total - skip));
          return Promise.resolve({
            rows: Array.from({ length: size }, (_, k) => row(skip + k)),
            count: total,
          });
        },
      );
    await setMock({ fetchHousingAssistance });
    return fetchHousingAssistance;
  }

  type Out = {
    owners: Array<Record<string, unknown>>;
    renters: Array<Record<string, unknown>>;
    next_offset?: number;
    notice?: string;
  };
  const zips = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => Number(r.zip_code) - 10_000);

  /** The text format() renders for one record of a section, without headers. */
  function block(kind: 'owners' | 'renters', record: Record<string, unknown>) {
    const text = (
      femaGetHousingAssistance.format!({
        owners: kind === 'owners' ? [record as never] : [],
        renters: kind === 'renters' ? [record as never] : [],
        owners_count: 1,
        renters_count: 1,
      })[0] as { text: string }
    ).text;
    return text.slice(text.indexOf('### ')).replace(/\n$/, '');
  }
  const charge = (kind: 'owners' | 'renters', r: Record<string, unknown>) =>
    Math.max(JSON.stringify(r).length, block(kind, r).length) + 2;

  it('accepts limit 10000 and rejects 10001', async () => {
    await serve(3, 3);
    const ok = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      limit: 10_000,
    });
    expect(ok.isError).not.toBe(true);
    const over = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      limit: 10_001,
    });
    expect(over.isError).toBe(true);
    expect(errorOf(over).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('cuts owners and renters at one row count, inspection fields charged, within the budget', async () => {
    const fetch = await serve(1_491, 1_619);
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      limit: 10_000,
    });
    const o = result.structuredContent as Out;
    const n = o.owners.length;
    expect(n).toBeGreaterThan(1);
    expect(o.renters).toHaveLength(n);
    expect(zips(o.owners)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(zips(o.renters)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(o.owners[0]).toHaveProperty('total_damage', 77646948.98);
    expect(o.renters[0]).toHaveProperty('total_with_moderate_damage', 2);
    const used =
      o.owners.reduce((sum, r) => sum + charge('owners', r), 0) +
      o.renters.reduce((sum, r) => sum + charge('renters', r), 0);
    expect(used).toBeLessThanOrEqual(BUDGET);
    const lastPair =
      charge('owners', o.owners.at(-1) ?? {}) + charge('renters', o.renters.at(-1) ?? {});
    expect(used + lastPair).toBeGreaterThan(BUDGET);
    expect(o.next_offset).toBe(n);
    expect(o.notice).toBe(
      `Returned ${n} of the 1491 owner records and ${n} of the 1619 renter records from offset 0, the most that fit the 100,000-character response budget; continue with offset ${n}.`,
    );
    const text = contentText(result);
    expect(text).toContain(`**Next offset:** ${n}`);
    expect(text.slice(text.indexOf('### '), text.indexOf('\n> ')).length).toBeLessThanOrEqual(
      BUDGET,
    );
    /**
     * Both datasets get the same $skip and a $top no larger than any page could hold: the
     * cheapest record carries only its disaster number and renders as
     * "### Disaster #0\n**Disaster:** #0" (32 characters, longer than its 21-character JSON),
     * so no page holds more than floor(100,000 / (32 + 2)) = 2,941.
     */
    expect(block('owners', { disaster_number: 0 })).toHaveLength(32);
    expect(block('renters', { disaster_number: 0 })).toHaveLength(32);
    expect(fetch.mock.calls.map(([dataset, opts]) => [dataset, opts.skip, opts.top])).toEqual([
      ['HousingAssistanceOwners', 0, 2_941],
      ['HousingAssistanceRenters', 0, 2_941],
    ]);
  });

  it.each([
    ['both', 1_491, 1_619],
    ['both', 1_619, 1_491],
    ['owners', 1_491, 1_619],
    ['renters', 1_491, 1_619],
  ] as const)(
    'pages type %s (%i owners, %i renters) by next_offset until absent, every record exactly once',
    async (type, owners, renters) => {
      await serve(owners, renters);
      const seen = { owners: [] as number[], renters: [] as number[] };
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const o = (
          await runToolContract(femaGetHousingAssistance, {
            disaster_number: 4332,
            type,
            limit: 10_000,
            offset,
          })
        ).structuredContent as Out;
        expect(o.owners.length + o.renters.length).toBeGreaterThan(0);
        seen.owners.push(...zips(o.owners));
        seen.renters.push(...zips(o.renters));
        offset = o.next_offset;
        pages++;
      }
      expect(pages).toBeGreaterThan(2);
      expect(seen.owners).toEqual(
        Array.from({ length: type === 'renters' ? 0 : owners }, (_, i) => i),
      );
      expect(seen.renters).toEqual(
        Array.from({ length: type === 'owners' ? 0 : renters }, (_, i) => i),
      );
    },
  );

  it('keeps paging the longer dataset after the shorter one ends, naming the end it passed', async () => {
    await serve(3, 10);
    const o = (
      await runToolContract(femaGetHousingAssistance, {
        disaster_number: 4332,
        limit: 4,
        offset: 4,
      })
    ).structuredContent as Out;
    expect(o.owners).toHaveLength(0);
    expect(zips(o.renters)).toEqual([4, 5, 6, 7]);
    expect(o.next_offset).toBe(8);
    expect(o.notice).toBe(
      'Offset 4 is past the end of the 3 owner records (last valid offset 2). Returned 4 of the 10 renter records from offset 4, as many as limit allows; continue with offset 8.',
    );
  });
});

describe('femaGetHousingAssistance — county and zip_code filters (#47)', () => {
  let fetchHousingAssistance: Mock;

  beforeEach(async () => {
    fetchHousingAssistance = vi
      .fn()
      .mockImplementation((dataset: string) =>
        Promise.resolve(
          dataset === 'HousingAssistanceOwners'
            ? { rows: [makeOwnerRow()], count: 3 }
            : { rows: [makeRenterRow()], count: 6 },
        ),
      );
    await setMock({ fetchHousingAssistance });
  });

  /** The `$filter` both datasets received — asserts the two are identical. */
  async function filterSent(
    input: { disaster_number: number } & Record<string, unknown>,
  ): Promise<string> {
    const result = await runToolContract(femaGetHousingAssistance, input);
    expect(result.isError).not.toBe(true);
    const calls = fetchHousingAssistance.mock.calls as Array<[string, { filter: string }]>;
    expect(calls.map(([dataset]) => dataset)).toEqual([
      'HousingAssistanceOwners',
      'HousingAssistanceRenters',
    ]);
    const [owners, renters] = calls.map(([, options]) => options.filter);
    expect(renters).toBe(owners);
    return owners ?? '';
  }

  it('keeps matching a county spelled as stored', async () => {
    expect(await filterSent({ disaster_number: 4332, county: 'Harris' })).toContain(
      "substringof('Harris', county)",
    );
  });

  it.each([
    ['harris', 'Harris'],
    ['HARRIS', 'Harris'],
    ['dewitt', 'DeWitt'],
    ['dekalb', 'DeKalb'],
    ["o'brien", "O''Brien"],
  ])(
    'matches county %j case-insensitively by sending %j inside $filter',
    async (county, stored) => {
      expect(await filterSent({ disaster_number: 4332, county })).toContain(
        `substringof('${stored}', county)`,
      );
    },
  );

  it('ANDs state, the or-joined county spellings, and the ZIP after the disaster number', async () => {
    expect(
      await filterSent({
        disaster_number: 4332,
        state: 'tx',
        county: ' harris ',
        zip_code: '77084',
      }),
    ).toBe(
      "disasterNumber eq 4332 and state eq 'TX' and " +
        "(substringof('Harris', county) or substringof('harris', county) or substringof('HARRIS', county)) and " +
        "zipCode eq '77084'",
    );
  });

  it('sends a ZIP with leading zeros as a quoted string', async () => {
    expect(await filterSent({ disaster_number: 4339, zip_code: '00609' })).toBe(
      "disasterNumber eq 4339 and zipCode eq '00609'",
    );
  });

  it('accepts a ZIP sent as a JSON number when its digits are the 5-digit form', async () => {
    expect(await filterSent({ disaster_number: 4332, zip_code: 77084 })).toBe(
      "disasterNumber eq 4332 and zipCode eq '77084'",
    );
  });

  it.each([{ county: '' }, { county: '   ' }, { zip_code: '' }, { county: '', zip_code: '' }])(
    'treats blank geography %j as unset',
    async (blank) => {
      expect(await filterSent({ disaster_number: 4332, ...blank })).toBe('disasterNumber eq 4332');
    },
  );

  it.each(['7708', '77084-1234', '770841234', 'ABCDE'])(
    'rejects zip_code %j before fetching, naming the 5-digit form',
    async (zip_code) => {
      const result = await runToolContract(femaGetHousingAssistance, {
        disaster_number: 4332,
        zip_code,
      });
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain('ZIP code must be exactly 5 digits (e.g., 77084).');
      expect(fetchHousingAssistance).not.toHaveBeenCalled();
    },
  );

  it('rejects a JSON number that lost its leading zeros (00609 sent as 609)', async () => {
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4339,
      zip_code: 609 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(contentText(result)).toMatch(/zip_code/);
    expect(fetchHousingAssistance).not.toHaveBeenCalled();
  });

  it('echoes the applied county and ZIP in enrichment on both surfaces', async () => {
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      county: ' harris ',
      zip_code: '77084',
    });
    expect(result.structuredContent).toMatchObject({
      owners_count: 3,
      renters_count: 6,
      totalCount: 9,
      county_filter: 'harris',
      zip_code_filter: '77084',
    });
    const lines = renderedLines(contentText(result));
    expect(lines).toContain('County filter (case-insensitive substring): harris');
    expect(lines).toContain('ZIP code filter: 77084');
  });

  it('echoes no geography when neither filter is set', async () => {
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 4332 });
    expect(result.structuredContent).not.toHaveProperty('county_filter');
    expect(result.structuredContent).not.toHaveProperty('zip_code_filter');
  });

  it('names the county and ZIP in the empty-match notice', async () => {
    fetchHousingAssistance.mockResolvedValue({ rows: [], count: 0 });
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      county: 'Harrisx',
      zip_code: '77084',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('county matching "Harrisx" or ZIP 77084'),
    });
    expect(contentText(result)).toContain('county matching "Harrisx" or ZIP 77084');
  });

  it('declares request_too_long with the same code and recovery as fema_get_public_assistance', async () => {
    const { femaGetPublicAssistance } = await import(
      '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js'
    );
    const pa = femaGetPublicAssistance.errors?.find((e) => e.reason === 'request_too_long');
    const housing = femaGetHousingAssistance.errors?.find((e) => e.reason === 'request_too_long');
    expect(housing).toMatchObject({ code: pa?.code, recovery: pa?.recovery, thrownBy: 'service' });
  });
});

describe('femaGetHousingAssistance — inspection fields (#47)', () => {
  /** Live DR-4332 owner row (Orange (County), VIDOR): inspected, with damage. */
  const inspectedOwner = makeOwnerRow({
    totalInspected: 5507,
    averageFemaInspectedDamage: 11438.86,
    totalDamage: 77646948.98,
    noFemaInspectedDamage: 1319,
  });
  /** An owner area nobody inspected: OpenFEMA files its damage as 0. */
  const uninspectedOwner = makeOwnerRow({
    zipCode: '77010',
    totalInspected: 0,
    averageFemaInspectedDamage: 0,
    totalDamage: 0,
    noFemaInspectedDamage: 0,
  });
  /** A renter row with repair/replacement and degree counts above totalInspected. */
  const renter = makeRenterRow({
    repairReplaceAmount: 4250.5,
    totalInspected: 3,
    totalInspectedWithNoDamage: 4,
    totalWithModerateDamage: 2,
    totalWithMajorDamage: 1,
    totalWithSubstantialDamage: 0,
  });

  beforeEach(async () => {
    await setMock({
      fetchHousingAssistance: vi
        .fn()
        .mockImplementation((dataset: string) =>
          Promise.resolve(
            dataset === 'HousingAssistanceOwners'
              ? { rows: [inspectedOwner, uninspectedOwner], count: 2 }
              : { rows: [renter], count: 1 },
          ),
        ),
    });
  });

  it('reaches structuredContent per dataset, renters with repair_replace_amount and no dollar damage', async () => {
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 4332 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      owners: Record<string, unknown>[];
      renters: Record<string, unknown>[];
    };
    expect(structured.owners[0]).toMatchObject({
      total_inspected: 5507,
      average_fema_inspected_damage: 11438.86,
      total_damage: 77646948.98,
      no_fema_inspected_damage: 1319,
    });
    expect(structured.owners[1]).toMatchObject({
      total_inspected: 0,
      average_fema_inspected_damage: 0,
      total_damage: 0,
    });
    expect(structured.renters[0]).toEqual({
      disaster_number: 4781,
      state: 'TX',
      county: 'Harris',
      city: 'Houston',
      zip_code: '77002',
      valid_registrations: 800,
      approved_for_fema_assistance: 600,
      total_approved_ihp_amount: 1200000,
      repair_replace_amount: 4250.5,
      rental_amount: 1000000,
      other_needs_amount: 200000,
      total_inspected: 3,
      total_inspected_with_no_damage: 4,
      total_with_moderate_damage: 2,
      total_with_major_damage: 1,
      total_with_substantial_damage: 0,
    });
  });

  it('renders inspected owner damage, an uninspected owner as uninspected, and renter degrees', async () => {
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 4332 });
    const text = contentText(result);
    const [inspectedSection = '', uninspectedSection = ''] = text
      .split('## Renter Assistance')[0]!
      .split('### ')
      .slice(1);
    expect(inspectedSection).toContain('**Inspected:** 5507');
    expect(inspectedSection).toContain('**Average Inspected Damage:** $11,438.86');
    expect(inspectedSection).toContain('**Total Damage (FEMA Verified Loss):** $77,646,948.98');
    expect(inspectedSection).toContain('**Inspected With No Damage:** 1319');

    expect(uninspectedSection).toContain('77010');
    expect(uninspectedSection).toContain(
      '**Inspection:** none recorded (0 applicants inspected); damage unknown',
    );
    expect(uninspectedSection).not.toMatch(/Damage[^\n]*\$0/);

    const renterSection = text.split('## Renter Assistance')[1] ?? '';
    expect(renterSection).toContain('**Repair/Replacement:** $4,250.5');
    expect(renterSection).toContain('**Inspected:** 3');
    expect(renterSection).toContain(
      '**Damage Degree (registrations):** none 4, moderate 2, major 1, substantial 0',
    );
  });

  it('omits inspection lines for a sparse row that reports none', () => {
    const text = (
      femaGetHousingAssistance.format!({
        owners: [{ disaster_number: 4332, county: 'Harris (County)' }],
        renters: [{ disaster_number: 4332, county: 'Harris (County)' }],
        owners_count: 1,
        renters_count: 1,
      })[0] as { text: string }
    ).text;
    expect(text).not.toMatch(/Inspect|Damage/);
  });
});

describe('femaGetHousingAssistance — format() text, whole (characterization)', () => {
  it('renders both sections with one blank-line-separated block per record, sparse ones included', () => {
    const text = (
      femaGetHousingAssistance.format!({
        owners: [
          {
            disaster_number: 4332,
            state: 'TX',
            county: 'Orange (County)',
            city: 'VIDOR',
            zip_code: '77662',
            valid_registrations: 9,
            approved_for_fema_assistance: 5,
            total_approved_ihp_amount: 1000,
            repair_replace_amount: 800,
            rental_amount: 100,
            other_needs_amount: 100,
            total_inspected: 5,
            average_fema_inspected_damage: 11438.86,
            total_damage: 77646948.98,
            no_fema_inspected_damage: 1,
          },
          {
            disaster_number: 4332,
            zip_code: '77010',
            total_inspected: 0,
            average_fema_inspected_damage: 0,
            total_damage: 0,
            no_fema_inspected_damage: 0,
          },
          { disaster_number: 4332 },
        ],
        renters: [
          {
            disaster_number: 4332,
            state: 'TX',
            county: 'Harris (County)',
            city: 'HOUSTON',
            zip_code: '77002',
            valid_registrations: 8,
            approved_for_fema_assistance: 6,
            total_approved_ihp_amount: 1200,
            repair_replace_amount: 0,
            rental_amount: 1000,
            other_needs_amount: 200,
            total_inspected: 3,
            total_inspected_with_no_damage: 4,
            total_with_moderate_damage: 2,
            total_with_major_damage: 1,
            total_with_substantial_damage: 0,
          },
          { disaster_number: 4332 },
        ],
        owners_count: 1491,
        renters_count: 1619,
      })[0] as { text: string }
    ).text;
    expect(text).toBe(
      '**Owner records:** 3 of 1491\n**Renter records:** 2 of 1619\n\n## Owner Assistance (3 of 1491 records)\n### Orange (County), VIDOR, 77662\n**State:** TX | **Disaster:** #4332\n**Registrations:** 9\n**Approved for FEMA Assistance:** 5\n**Total Approved IHP:** $1,000\n**Repair/Replacement:** $800\n**Rental Assistance:** $100\n**Other Needs:** $100\n**Inspected:** 5\n**Average Inspected Damage:** $11,438.86\n**Total Damage (FEMA Verified Loss):** $77,646,948.98\n**Inspected With No Damage:** 1\n\n### 77010\n**Disaster:** #4332\n**Inspection:** none recorded (0 applicants inspected); damage unknown\n\n### Disaster #4332\n**Disaster:** #4332\n\n## Renter Assistance (2 of 1619 records)\n### Harris (County), HOUSTON, 77002\n**State:** TX | **Disaster:** #4332\n**Registrations:** 8\n**Approved for FEMA Assistance:** 6\n**Total Approved IHP:** $1,200\n**Repair/Replacement:** $0\n**Rental Assistance:** $1,000\n**Other Needs:** $200\n**Inspected:** 3\n**Damage Degree (registrations):** none 4, moderate 2, major 1, substantial 0\n\n### Disaster #4332\n**Disaster:** #4332\n',
    );
  });
});
