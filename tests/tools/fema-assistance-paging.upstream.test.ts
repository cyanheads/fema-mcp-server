/**
 * @fileoverview fema_get_housing_assistance and fema_get_public_assistance paging against
 * the real OpenFemaService, with `fetch` stubbed by OpenFEMA envelopes shaped like the live
 * API: an empty page past the end still carries `metadata.count`, a genuinely empty match
 * carries `count: 0`. Covers the housing `type` × dataset-state matrix on both surfaces.
 * @module tests/tools/fema-assistance-paging.upstream.test
 */

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

      if (pastEnd.length === 0) {
        expect(structured).not.toHaveProperty('notice');
        return;
      }
      const notice = structured.notice as string;
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
