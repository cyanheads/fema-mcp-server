/**
 * @fileoverview fema_get_housing_assistance and fema_get_public_assistance paging against
 * the real OpenFemaService, with `fetch` stubbed by OpenFEMA envelopes shaped like the live
 * API: an empty page past the end still carries `metadata.count`, a genuinely empty match
 * carries `count: 0`. Covers the housing `type` × dataset-state matrix on both surfaces, and
 * the zero counts and amounts OpenFEMA reports in place of absent values.
 * @module tests/tools/fema-assistance-paging.upstream.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaGetHousingAssistance } from '@/mcp-server/tools/definitions/fema-get-housing-assistance.tool.js';
import { femaGetPublicAssistance } from '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js';
import { initOpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  calledUrls,
  cdnBadRequestResponse,
  endpoint,
  envelopeResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

const OWNERS = 'HousingAssistanceOwners';
const RENTERS = 'HousingAssistanceRenters';
const PA = 'PublicAssistanceFundedProjectsDetails';

type ErrorEnvelope = { code: number; data: { reason?: string; recovery?: { hint: string } } };

function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
}

function errorOf(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

function housingRow(dataset: string) {
  return {
    disasterNumber: 4781,
    state: 'TX',
    county: 'Harris (County)',
    city: 'HOUSTON',
    zipCode: '77090',
    validRegistrations: 12,
    totalApprovedIhpAmount: dataset === OWNERS ? 250_000 : 90_000,
  };
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initOpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What one housing dataset holds for the request, or `excluded` when `type` leaves it out. */
type DatasetState = 'rows' | 'past-end' | 'empty' | 'excluded';

/** Per-dataset totals, distinct so each count is identifiable in the rendered text. */
const TOTALS = {
  [OWNERS]: { rows: 1200, 'past-end': 1064 },
  [RENTERS]: { rows: 1152, 'past-end': 1052 },
} as const;

const OFFSET = 1100;

/** The envelope OpenFEMA returns for `dataset` in `state` at offset 1100. */
function respond(dataset: typeof OWNERS | typeof RENTERS, state: DatasetState) {
  if (state === 'rows')
    return () => envelopeResponse(dataset, [housingRow(dataset)], TOTALS[dataset].rows);
  if (state === 'past-end') return () => envelopeResponse(dataset, [], TOTALS[dataset]['past-end']);
  return () => envelopeResponse(dataset, [], 0);
}

function total(dataset: typeof OWNERS | typeof RENTERS, state: DatasetState): number {
  return state === 'rows' || state === 'past-end' ? TOTALS[dataset][state] : 0;
}

const FETCHED: DatasetState[] = ['rows', 'past-end', 'empty'];
const MATRIX: Array<{
  type: 'owners' | 'renters' | 'both';
  owners: DatasetState;
  renters: DatasetState;
}> = [
  ...FETCHED.flatMap((owners) =>
    FETCHED.map((renters) => ({ type: 'both' as const, owners, renters })),
  ),
  ...FETCHED.map((owners) => ({ type: 'owners' as const, owners, renters: 'excluded' as const })),
  ...FETCHED.map((renters) => ({ type: 'renters' as const, owners: 'excluded' as const, renters })),
];

describe('fema_get_housing_assistance — type × dataset-state matrix at offset 1100', () => {
  it.each(MATRIX)(
    'type $type · owners $owners · renters $renters',
    async ({ type, owners, renters }) => {
      const routes: Array<[string, ReturnType<typeof respond>]> = [];
      if (owners !== 'excluded') routes.push([endpoint(OWNERS, 2), respond(OWNERS, owners)]);
      if (renters !== 'excluded') routes.push([endpoint(RENTERS, 2), respond(RENTERS, renters)]);
      fetchMock.mockImplementation(routeFetch(routes));

      const result = await runToolContract(femaGetHousingAssistance, {
        disaster_number: 4781,
        type,
        offset: OFFSET,
      });

      const urls = calledUrls(fetchMock);
      expect(urls).toHaveLength(routes.length);
      for (const url of urls) expect(url).toContain(`%24skip=${OFFSET}`);
      if (owners === 'excluded') expect(urls.some((u) => u.includes(OWNERS))).toBe(false);
      if (renters === 'excluded') expect(urls.some((u) => u.includes(RENTERS))).toBe(false);

      const anyRows = owners === 'rows' || renters === 'rows';
      const pastEnd = [
        ...(owners === 'past-end' ? [{ label: 'owner', total: TOTALS[OWNERS]['past-end'] }] : []),
        ...(renters === 'past-end'
          ? [{ label: 'renter', total: TOTALS[RENTERS]['past-end'] }]
          : []),
      ];

      if (!anyRows && pastEnd.length === 0) {
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data.reason).toBe('no_results');
        expect(error.data.recovery?.hint).toContain('IA housing data may take weeks to appear');
        return;
      }

      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Record<string, unknown>;
      const ownersTotal = total(OWNERS, owners);
      const rentersTotal = total(RENTERS, renters);
      expect(structured).toMatchObject({
        owners: owners === 'rows' ? [expect.objectContaining({ zip_code: '77090' })] : [],
        renters: renters === 'rows' ? [expect.objectContaining({ zip_code: '77090' })] : [],
        owners_count: ownersTotal,
        renters_count: rentersTotal,
        totalCount: ownersTotal + rentersTotal,
      });

      const text = contentText(result);
      expect(text).toMatch(
        new RegExp(`owner[^\\n]*\\b${owners === 'rows' ? 1 : 0} of ${ownersTotal}\\b`, 'i'),
      );
      expect(text).toMatch(
        new RegExp(`renter[^\\n]*\\b${renters === 'rows' ? 1 : 0} of ${rentersTotal}\\b`, 'i'),
      );

      const notice = (structured.notice as string | undefined) ?? '';
      if (anyRows) {
        // A dataset with a row at offset 1100 holds more past it, so the page names the next offset.
        expect(structured.next_offset).toBe(OFFSET + 1);
        expect(notice).toContain(`continue with offset ${OFFSET + 1}.`);
        expect(text).toContain(notice);
      } else {
        expect(structured).not.toHaveProperty('next_offset');
      }
      if (pastEnd.length === 0) {
        expect(notice).not.toContain('past the end');
        return;
      }
      expect(notice).toContain(`Offset ${OFFSET}`);
      for (const { label, total: count } of pastEnd) {
        expect(notice).toContain(`${count} ${label} records`);
        expect(notice).toContain(`last valid offset ${count - 1}`);
      }
      expect(text).toContain(notice);
      expect(text).not.toMatch(/\bno\b[^.\n]*\brecords\b/i);
    },
  );
});

describe('fema_get_public_assistance — paging against OpenFEMA', () => {
  it('returns the empty page past the end as a success carrying the upstream total', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(PA, 2), () => envelopeResponse(PA, [], 1157)]]),
    );
    const result = await runToolContract(femaGetPublicAssistance, {
      disaster_number: 4781,
      offset: 100_000,
    });
    expect(calledUrls(fetchMock)[0]).toContain('%24skip=100000');
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ projects: [], total_count: 1157, returned_count: 0 });
    expect(structured.notice).toContain('last valid offset is 1156');
    expect(contentText(result)).toContain(structured.notice as string);
  });

  it('keeps no_results for a genuinely empty match', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(PA, 2), () => envelopeResponse(PA, [], 0)]]),
    );
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 9999 });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('a county value that pushes the URL past the CDN limit → request_too_long with this tool’s hint (#48)', async () => {
    fetchMock.mockImplementation(routeFetch([[endpoint(PA, 2), () => cdnBadRequestResponse()]]));
    const result = await runToolContract(femaGetPublicAssistance, {
      disaster_number: 4332,
      county: 'x'.repeat(3_000),
    });
    expect(result.isError).toBe(true);
    const declared = femaGetPublicAssistance.errors?.find((e) => e.reason === 'request_too_long');
    expect(errorOf(result)).toEqual({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^OpenFEMA refused the request: its URL is [\d,]+ characters/),
      data: {
        reason: 'request_too_long',
        urlLength: calledUrls(fetchMock)[0]?.length,
        recovery: { hint: declared?.recovery },
      },
    });
    expect(contentText(result)).toContain(declared?.recovery ?? '');
  });
});

describe('disaster numbers above the FEMA range never reach OpenFEMA', () => {
  it('fema_get_public_assistance', async () => {
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 32768 });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['owners', 'renters', 'both'] as const)(
    'fema_get_housing_assistance, type %s',
    async (type) => {
      const result = await runToolContract(femaGetHousingAssistance, {
        disaster_number: 32768,
        type,
      });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

/** Every output-field description of a tool, keyed by JSON path, from its advertised schema. */
function fieldDescriptions(schema: z.ZodType): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { description?: string; properties?: object; items?: unknown };
    if (n.description && path) out[path] = n.description;
    for (const [key, child] of Object.entries(n.properties ?? {})) walk(child, `${path}.${key}`);
    if (n.items) walk(n.items, `${path}[]`);
  };
  walk(z.toJSONSchema(schema, { io: 'output' }), '');
  return out;
}

describe('zero amounts, as OpenFEMA reports them, reach both surfaces', () => {
  /** Live HousingAssistance rows (DR-4332): one registration, nothing approved. */
  const zeroOwner = {
    disasterNumber: 4332,
    state: 'TX',
    county: 'Aransas (County)',
    city: 'AUSTIN',
    zipCode: '78728',
    validRegistrations: 1,
    approvedForFemaAssistance: 0,
    totalApprovedIhpAmount: 0,
    repairReplaceAmount: 0,
    rentalAmount: 0,
    otherNeedsAmount: 0,
  };
  const zeroRenter = {
    disasterNumber: 4332,
    state: 'TX',
    county: 'Harris (County)',
    city: 'NOT APPLICABLE',
    zipCode: '00000',
    validRegistrations: 1,
    approvedForFemaAssistance: 0,
    totalApprovedIhpAmount: 0,
    repairReplaceAmount: 0,
    rentalAmount: 0,
    otherNeedsAmount: 0,
  };

  it('fema_get_housing_assistance keeps 0 counts and amounts, and no description calls them absent', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(OWNERS, 2), () => envelopeResponse(OWNERS, [zeroOwner], 1)],
        [endpoint(RENTERS, 2), () => envelopeResponse(RENTERS, [zeroRenter], 1)],
      ]),
    );
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 4332 });
    expect(result.isError).not.toBe(true);
    const zeros = {
      approved_for_fema_assistance: 0,
      total_approved_ihp_amount: 0,
      rental_amount: 0,
      other_needs_amount: 0,
    };
    expect(result.structuredContent).toMatchObject({
      owners: [{ ...zeros, repair_replace_amount: 0, valid_registrations: 1 }],
      renters: [{ ...zeros, valid_registrations: 1, zip_code: '00000' }],
    });
    const text = contentText(result);
    expect(text).toContain('**Approved for FEMA Assistance:** 0');
    expect(text).toContain('**Total Approved IHP:** $0');
    expect(text).toContain('**Repair/Replacement:** $0');

    const described = fieldDescriptions(femaGetHousingAssistance.output);
    for (const [path, text] of Object.entries(described)) {
      expect(text, path).not.toMatch(/absent when zero/i);
    }
    expect(described['.renters[].zip_code']).toContain('00000');
  });

  it('fema_get_public_assistance keeps 0 obligations, and their descriptions say 0, not absent', async () => {
    /** Live PublicAssistanceFundedProjectsDetails row (DR-4856): eligible, nothing obligated. */
    const row = {
      disasterNumber: 4856,
      pwNumber: 266,
      projectAmount: 24644,
      federalShareObligated: 0,
      totalObligated: 0,
      firstObligationDate: '2025-07-08T00:00:00.000Z',
      projectStatus: 'Eligible',
      projectSize: 'Small',
    };
    fetchMock.mockImplementation(
      routeFetch([[endpoint(PA, 2), () => envelopeResponse(PA, [row], 1)]]),
    );
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 4856 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      projects: [{ federal_share_obligated: 0, total_obligated: 0, project_amount: 24644 }],
    });
    const text = contentText(result);
    expect(text).toContain('**Total Obligated:** $0');
    expect(text).toContain('**Federal Share Obligated:** $0');

    const described = fieldDescriptions(femaGetPublicAssistance.output);
    for (const field of ['federal_share_obligated', 'total_obligated']) {
      const description = described[`.projects[].${field}`];
      expect(description, field).not.toMatch(/absent/i);
      expect(description, field).toMatch(/\b0\b/);
    }
  });
});

describe('fema_get_housing_assistance — county and zip_code filters against OpenFEMA (#47)', () => {
  /** The decoded `$filter` of a request URL. */
  function filterOf(url: string): string | null {
    return new URL(url).searchParams.get('$filter');
  }

  it('sends the same filtered $filter to both datasets and reports each filtered $inlinecount', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(OWNERS, 2), () => envelopeResponse(OWNERS, [housingRow(OWNERS)], 3)],
        [endpoint(RENTERS, 2), () => envelopeResponse(RENTERS, [housingRow(RENTERS)], 6)],
      ]),
    );
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      county: 'harris',
      zip_code: '77084',
      offset: 2,
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    const urls = calledUrls(fetchMock);
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      '/api/open/v2/HousingAssistanceOwners',
      '/api/open/v2/HousingAssistanceRenters',
    ]);
    for (const url of urls) {
      expect(filterOf(url)).toBe(
        "disasterNumber eq 4332 and (substringof('Harris', county) or substringof('harris', county) or substringof('HARRIS', county)) and zipCode eq '77084'",
      );
      expect(new URL(url).searchParams.get('$skip')).toBe('2');
      expect(new URL(url).searchParams.get('$top')).toBe('1');
    }
    expect(result.structuredContent).toMatchObject({
      owners_count: 3,
      renters_count: 6,
      totalCount: 9,
      county_filter: 'harris',
      zip_code_filter: '77084',
    });
    const text = contentText(result);
    expect(text).toContain('**Owner records:** 1 of 3');
    expect(text).toContain('**Renter records:** 1 of 6');
  });

  it('applies the past-end notice to the filtered totals', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(OWNERS, 2), () => envelopeResponse(OWNERS, [], 3)],
        [endpoint(RENTERS, 2), () => envelopeResponse(RENTERS, [housingRow(RENTERS)], 6)],
      ]),
    );
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      county: 'Harris',
      zip_code: '77084',
      offset: 5,
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { notice: string }).notice).toBe(
      'Offset 5 is past the end of the 3 owner records (last valid offset 2).',
    );
  });

  it('a county value that pushes the URL past the CDN limit → request_too_long with this tool’s hint', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(OWNERS, 2), () => cdnBadRequestResponse()],
        [endpoint(RENTERS, 2), () => cdnBadRequestResponse()],
      ]),
    );
    const result = await runToolContract(femaGetHousingAssistance, {
      disaster_number: 4332,
      county: 'x'.repeat(3_000),
    });
    expect(result.isError).toBe(true);
    const declared = femaGetHousingAssistance.errors?.find((e) => e.reason === 'request_too_long');
    const error = errorOf(result) as ErrorEnvelope & { data: { urlLength?: number } };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'request_too_long', recovery: { hint: declared?.recovery } },
    });
    expect(calledUrls(fetchMock).map((url) => url.length)).toContain(error.data.urlLength);
    expect(error.data.urlLength).toBeGreaterThan(8_000);
    expect(contentText(result)).toContain(declared?.recovery ?? '');
  });

  it('keeps an uninspected owner row and a renter repair_replace_amount from live-shaped envelopes', async () => {
    /** Live-shaped DR-4332 rows: an owner area nobody inspected, a renter with repair aid. */
    const uninspected = {
      ...housingRow(OWNERS),
      totalInspected: 0,
      averageFemaInspectedDamage: 0,
      totalDamage: 0,
      noFemaInspectedDamage: 0,
    };
    const renterWithRepair = {
      ...housingRow(RENTERS),
      repairReplaceAmount: 4_250.5,
      totalInspected: 3,
      totalInspectedWithNoDamage: 4,
      totalWithModerateDamage: 2,
      totalWithMajorDamage: 1,
      totalWithSubstantialDamage: 0,
    };
    fetchMock.mockImplementation(
      routeFetch([
        [endpoint(OWNERS, 2), () => envelopeResponse(OWNERS, [uninspected], 1)],
        [endpoint(RENTERS, 2), () => envelopeResponse(RENTERS, [renterWithRepair], 1)],
      ]),
    );
    const result = await runToolContract(femaGetHousingAssistance, { disaster_number: 4332 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      owners: [{ total_inspected: 0, average_fema_inspected_damage: 0, total_damage: 0 }],
      renters: [{ repair_replace_amount: 4_250.5, total_with_major_damage: 1 }],
    });
    const text = contentText(result);
    expect(text).toContain(
      '**Inspection:** none recorded (0 applicants inspected); damage unknown',
    );
    expect(text).not.toContain('**Average Inspected Damage:** $0');
    expect(text).toContain('**Repair/Replacement:** $4,250.5');
  });
});
