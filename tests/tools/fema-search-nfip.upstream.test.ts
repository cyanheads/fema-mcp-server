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
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';
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
import { renderedText } from '../helpers/rendered-markdown.js';

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
/** The projected fields, as `encodeURIComponent` puts them on the wire. */
const SELECT =
  'state%2CcountyCode%2CreportedZipCode%2CdateOfLoss%2CyearOfLoss%2CamountPaidOnBuildingClaim%2CamountPaidOnContentsClaim%2CbuildingDamageAmount%2CcontentsDamageAmount%2CratedFloodZone%2CcauseOfDamage%2CoccupancyType%2CfloodEvent';

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
  it('matches an exact event on the requested page and includes it in the ZIP-independent coverage count', async () => {
    const filters: Array<string | null> = [];
    fetchMock.mockImplementation(
      routeFetch([
        [
          NFIP_V3,
          (url) => {
            const params = new URL(url).searchParams;
            filters.push(params.get('$filter'));
            return params.get('$select') === 'countyCode'
              ? envelopeResponse(
                  'NfipClaims',
                  [],
                  params.get('$filter')?.includes('floodEvent eq') ? 17 : 99,
                  'v3',
                )
              : envelopeResponse(
                  'NfipClaims',
                  [{ ...v3Claim(0), floodEvent: "O'Brien Flood" }],
                  3,
                  'v3',
                );
          },
        ],
      ]),
    );
    const result = await runToolContract(femaSearchNfip, {
      state: 'TX',
      county_code: '201',
      zip_code: '77008',
      year_from: 2017,
      flood_event: "O'Brien Flood",
      offset: 1,
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      claims: [{ flood_event: "O'Brien Flood" }],
      next_offset: 2,
    });
    const text = renderedText(
      (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
    ).join('\n');
    expect(text).toContain("Event: O'Brien Flood");
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('17 claims'),
    });
    expect(text).toContain('17 claims');
    expect(text).toContain('does not identify their county or ZIP');
    expect(filters).toEqual([
      "state eq 'TX' and countyCode eq '48201' and reportedZipCode eq '77008' and yearOfLoss ge 2017 and floodEvent eq 'O''Brien Flood'",
      "state eq 'TX' and countyCode eq null and yearOfLoss ge 2017 and floodEvent eq 'O''Brien Flood'",
    ]);
  });

  it('explains exact spelling and how to discover events with and without a canvas', async () => {
    fetchMock.mockImplementation(
      routeFetch([[NFIP_V3, () => envelopeResponse('NfipClaims', [], 0, 'v3')]]),
    );
    const result = await runToolContract(femaSearchNfip, {
      state: 'TX',
      year_from: 2017,
      year_to: 2017,
      flood_event: 'hurricane harvey',
    });
    expect(result.structuredContent).toMatchObject({
      spilled: false,
      total_count: 0,
      returned_count: 0,
    });
    const text = renderedText(JSON.stringify(result.content)).join('\n');
    for (const phrase of [
      'spelling and case exactly',
      'page with next_offset',
      'GROUP BY flood_event',
    ]) {
      expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(phrase) });
      expect(text).toContain(phrase);
    }
  });

  it('rejects an empty event before calling OpenFEMA', async () => {
    const result = await runToolContract(femaSearchNfip, { state: 'TX', flood_event: '' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_arguments' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requests NfipClaims v3 and maps rows onto unchanged output fields on both surfaces', async () => {
    setCanvas(undefined);
    fetchMock.mockImplementation(
      routeFetch([
        [
          NFIP_V3,
          () =>
            envelopeResponse(
              'NfipClaims',
              [
                { ...v3Claim(0), floodEvent: 'Hurricane Harvey' },
                { ...v3Claim(1), floodEvent: null },
              ],
              58004,
              'v3',
            ),
        ],
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
          flood_event: 'Hurricane Harvey',
        },
        { state: 'TX', year_of_loss: 2018 },
      ],
    });
    const [first, second] = (result.structuredContent as { claims: Record<string, unknown>[] })
      .claims;
    // v3's explicit nulls stay absent rather than becoming facts.
    expect(first).not.toHaveProperty('amount_paid_contents');
    expect(second).not.toHaveProperty('amount_paid_building');
    expect(second).not.toHaveProperty('flood_event');
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
    expect(text).toContain('2 of 58004 NFIP claims');
    expect(text).toContain('County: 48201');
    expect(text).toContain('Event: Hurricane Harvey');
    expect(text).toContain('Bldg Paid: $1,250.5');
    expect(text).toContain(
      'Returned 2 of the 58004 matching claims from offset 0; continue with offset 2.',
    );

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('%24select=countyCode&%24top=1');
    expect(urls[0]).toBe(
      `https://www.fema.gov/api/open/v3/NfipClaims?%24inlinecount=allpages&%24filter=state%20eq%20'TX'%20and%20countyCode%20eq%20'48201'%20and%20yearOfLoss%20ge%202017&%24select=${SELECT}&%24orderby=dateOfLoss%20desc%2Cid&%24top=2&%24skip=0`,
    );
    expect(urls.some((u) => u.startsWith(CATALOG_URL))).toBe(false);
  });

  it('keeps a $0 payment as 0 on both surfaces, and no description calls it absent', async () => {
    setCanvas(undefined);
    const zeroPaid = { ...v3Claim(0), amountPaidOnBuildingClaim: 0, amountPaidOnContentsClaim: 0 };
    fetchMock.mockImplementation(
      routeFetch([[NFIP_V3, () => envelopeResponse('NfipClaims', [zeroPaid], 1, 'v3')]]),
    );
    const result = await runToolContract(femaSearchNfip, { state: 'TX', limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      claims: [{ amount_paid_building: 0, amount_paid_contents: 0 }],
    });
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
    expect(text).toContain('Bldg Paid: $0');
    expect(text).toContain('Contents Paid: $0');

    const claim = femaSearchNfip.output.shape.claims.element.shape;
    for (const field of ['amount_paid_building', 'amount_paid_contents'] as const) {
      expect(claim[field].description, field).not.toMatch(/absent when zero/i);
      expect(claim[field].description, field).toMatch(/\b0\b/);
    }
  });
});

describe('fema_search_nfip — NfipClaims v3, DuckDB canvas', () => {
  it.each([undefined, 'Hurricane Harvey'])(
    'stages event %s across pages and supports grouping by name',
    async (event) => {
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
              const params = new URL(url).searchParams;
              if (params.get('$select') === 'countyCode')
                return envelopeResponse('NfipClaims', [], 0, 'v3');
              const skip = Number(params.get('$skip'));
              const size = pageRows[skip] ?? 0;
              const eventFiltered = params
                .get('$filter')
                ?.includes("floodEvent eq 'Hurricane Harvey'");
              const rows = Array.from({ length: size }, (_, i) => ({
                ...v3Claim(skip + i),
                floodEvent: eventFiltered || skip === 0 ? 'Hurricane Harvey' : null,
              }));
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
          ...(event === undefined ? {} : { flood_event: event }),
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
        expect(out).toMatchObject({
          spilled: true,
          total_count: 7000,
          staged_count: 7000,
          returned_count: 5,
        });
        expect(out.claims).toHaveLength(5);
        expect(out.claims).toEqual(
          Array(5).fill(expect.objectContaining({ flood_event: 'Hurricane Harvey' })),
        );
        // Parsed, since a generated canvas ID can hold an underscore the Markdown escapes.
        const text = renderedText(
          (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
        ).join('\n');
        expect(text).toContain(out.canvas_id);
        expect(text).toContain(out.canvas_table);
        expect(text).toContain('Event: Hurricane Harvey');

        const allUrls = calledUrls(fetchMock);
        expect(allUrls.filter((url) => url.includes('%24select=countyCode&'))).toHaveLength(1);
        const urls = allUrls.filter((url) => !url.includes('%24select=countyCode&'));
        expect(urls.map((u) => /%24skip=(\d+)/.exec(u)?.[1])).toEqual(['0', '5000']);
        for (const url of urls) {
          expect(url.startsWith(NFIP_V3)).toBe(true);
          expect(url).toContain('%24top=5000');
          expect(url).toContain(`%24select=${SELECT}`);
          expect(url).toContain('%24orderby=dateOfLoss%20desc%2Cid');
          const filter = new URL(url).searchParams.get('$filter');
          expect(filter).toBe(
            `state eq 'TX' and countyCode eq '48201'${event ? " and floodEvent eq 'Hurricane Harvey'" : ''}`,
          );
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
          'flood_event:VARCHAR',
        ]);
        const grouped = await runToolContract(
          femaDataframeQuery,
          {
            canvas_id: out.canvas_id,
            query: `SELECT flood_event, COUNT(*) AS claims FROM ${out.canvas_table} GROUP BY flood_event ORDER BY flood_event`,
          },
          { context: { tenantId: 'default' } },
        );
        expect(grouped.isError).not.toBe(true);
        expect(grouped.structuredContent).toMatchObject({
          rows: event
            ? [{ flood_event: 'Hurricane Harvey', claims: '7000' }]
            : [
                { flood_event: 'Hurricane Harvey', claims: '5000' },
                { flood_event: null, claims: '2000' },
              ],
        });
      } finally {
        await canvas.shutdown(createMockContext());
      }
    },
    20_000,
  );
});
