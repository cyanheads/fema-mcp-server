/**
 * @fileoverview fema_search_nfip against the real OpenFemaService and a real DuckDB
 * canvas, with `fetch` stubbed by `NfipClaims` v3 rows shaped like the live API —
 * the inline path and a canvas spill paged past the first page.
 * @module tests/tools/fema-search-nfip.upstream.test
 */

import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaDataframeDescribe } from '@/mcp-server/tools/definitions/fema-dataframe-describe.tool.js';
import { femaSearchNfip } from '@/mcp-server/tools/definitions/fema-search-nfip.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { initOpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  CATALOG_URL,
  calledUrls,
  endpoint,
  envelopeResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

/** A v3 claim row: the fields the tool reads plus live-API noise, with v3's explicit nulls. */
function v3Claim(i: number) {
  return {
    agricultureStructureIndicator: false,
    asOfDate: '2026-09-08T00:00:00.000Z',
    policyCount: 1,
    dateOfLoss: '2026-08-28T00:00:00.000Z',
    ratedFloodZone: 'AE',
    occupancyType: 11,
    amountPaidOnBuildingClaim: i % 2 === 0 ? 1250.5 + i : null,
    amountPaidOnContentsClaim: null,
    yearOfLoss: 2017 + (i % 10),
    buildingDamageAmount: i % 3 === 0 ? 5000 : null,
    causeOfDamage: '4',
    contentsDamageAmount: null,
    nfipCommunityName: 'HOUSTON, CITY OF',
    state: 'TX',
    reportedCity: 'Currently Unavailable',
    reportedZipCode: '77008',
    countyCode: '48201',
    censusGeoid: '482015111002',
    id: 7_375_147 + i,
  };
}

const NFIP_V3 = endpoint('NfipClaims', 3);

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initOpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCanvas(undefined);
});

describe('fema_search_nfip — NfipClaims v3, canvas disabled', () => {
  it('requests NfipClaims v3 and maps rows onto unchanged output fields on both surfaces', async () => {
    setCanvas(undefined);
    fetchMock.mockImplementation(
      routeFetch([
        [NFIP_V3, () => envelopeResponse('NfipClaims', [v3Claim(0), v3Claim(1)], 58004, 'v3')],
      ]),
    );
    const result = await runToolContract(femaSearchNfip, {
      state: 'TX',
      county_code: '201',
      year_from: 2017,
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total_count: 58004,
      returned_count: 2,
      spilled: false,
      claims: [
        {
          state: 'TX',
          county_code: '48201',
          zip_code: '77008',
          date_of_loss: '2026-08-28T00:00:00.000Z',
          year_of_loss: 2017,
          amount_paid_building: 1250.5,
          building_damage_amount: 5000,
          rated_flood_zone: 'AE',
          cause_of_damage: '4',
          occupancy_type: 11,
        },
        { state: 'TX', year_of_loss: 2018 },
      ],
    });
    const [first, second] = (result.structuredContent as { claims: Record<string, unknown>[] })
      .claims;
    // v3's explicit nulls stay absent rather than becoming facts.
    expect(first).not.toHaveProperty('amount_paid_contents');
    expect(second).not.toHaveProperty('amount_paid_building');
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
    expect(text).toContain('2 of 58004 NFIP claims');
    expect(text).toContain('County: 48201');
    expect(text).toContain('Bldg Paid: $1,250.5');
    expect(text).toContain('Showing 2 of 58004 matching claims');

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      "https://www.fema.gov/api/open/v3/NfipClaims?%24inlinecount=allpages&%24filter=state%20eq%20'TX'%20and%20countyCode%20eq%20'48201'%20and%20yearOfLoss%20ge%202017&%24orderby=dateOfLoss%20desc&%24top=2",
    );
    expect(urls.some((u) => u.startsWith(CATALOG_URL))).toBe(false);
  });
});

describe('fema_search_nfip — NfipClaims v3, DuckDB canvas', () => {
  it('pages the v3 endpoint past the first page and stages every row with the unchanged columns', async () => {
    const provider = new DuckdbProvider({
      defaultRowLimit: 100,
      exportRootPath: '/tmp',
      memoryLimitMb: 128,
      schemaSniffRows: 10,
    });
    const canvas = new DataCanvas(provider, new CanvasRegistry(provider));
    setCanvas(canvas);
    const pageRows: Record<number, number> = { 0: 5000, 5000: 2000 };
    fetchMock.mockImplementation(
      routeFetch([
        [
          NFIP_V3,
          (url) => {
            const skip = Number(/%24skip=(\d+)/.exec(url)?.[1]);
            const size = pageRows[skip] ?? 0;
            const rows = Array.from({ length: size }, (_, i) => v3Claim(skip + i));
            return envelopeResponse('NfipClaims', rows, 7000, 'v3');
          },
        ],
      ]),
    );
    try {
      const result = await runToolContract(femaSearchNfip, {
        state: 'TX',
        county_code: '48201',
        limit: 5,
      });
      expect(result.isError).not.toBe(true);
      const out = result.structuredContent as {
        spilled: boolean;
        total_count: number;
        returned_count: number;
        canvas_id: string;
        canvas_table: string;
        claims: unknown[];
      };
      expect(out).toMatchObject({ spilled: true, total_count: 7000, returned_count: 5 });
      expect(out.claims).toHaveLength(5);
      const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
      expect(text).toContain(out.canvas_id);
      expect(text).toContain(out.canvas_table);

      const urls = calledUrls(fetchMock);
      expect(urls.map((u) => /%24skip=(\d+)/.exec(u)?.[1])).toEqual(['0', '5000']);
      for (const url of urls) {
        expect(url.startsWith(NFIP_V3)).toBe(true);
        expect(url).toContain('%24top=5000');
      }

      const described = await runToolContract(
        femaDataframeDescribe,
        { canvas_id: out.canvas_id },
        { context: { tenantId: 'default' } },
      );
      const table = (
        described.structuredContent as {
          tables: Array<{
            name: string;
            row_count: number;
            columns: Array<{ name: string; type: string }>;
          }>;
        }
      ).tables.find((t) => t.name === out.canvas_table);
      expect(table?.row_count).toBe(7000);
      expect(table?.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
        'state:VARCHAR',
        'county_code:VARCHAR',
        'zip_code:VARCHAR',
        'date_of_loss:VARCHAR',
        'year_of_loss:INTEGER',
        'amount_paid_building:DOUBLE',
        'amount_paid_contents:DOUBLE',
        'building_damage_amount:DOUBLE',
        'contents_damage_amount:DOUBLE',
        'rated_flood_zone:VARCHAR',
        'cause_of_damage:VARCHAR',
        'occupancy_type:INTEGER',
      ]);
    } finally {
      await canvas.shutdown(createMockContext());
    }
  }, 20_000);
});
