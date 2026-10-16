/**
 * @fileoverview fema_search_disasters against the real OpenFemaService, with `fetch` stubbed by
 * an in-memory DisasterDeclarationsSummaries v2 that honours `$top` and the `date_to` filter —
 * the uncapped path, and the 10,000-row window trimmed to whole declarations with a `date_to`
 * continuation.
 * @module tests/tools/fema-search-disasters.upstream.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaSearchDisasters } from '@/mcp-server/tools/definitions/fema-search-disasters.tool.js';
import { initOpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  CATALOG_URL,
  calledUrls,
  cdnBadRequestResponse,
  ERROR_BODIES,
  endpoint,
  envelopeResponse,
  jsonResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

const DDS = 'DisasterDeclarationsSummaries';

type AreaRow = {
  disasterNumber: number;
  declarationTitle: string;
  state: string;
  incidentType: string;
  declarationType: string;
  declarationDate: string;
  ihProgramDeclared: boolean;
  paProgramDeclared: boolean;
  hmProgramDeclared: boolean;
};

type Declaration = {
  disaster_number: number;
  designated_area_count: number;
  declaration_date: string;
  ia_declared: boolean;
};

type SearchOutput = {
  declarations: Declaration[];
  total_declarations: number;
  total_area_rows: number;
  returned_count: number;
  truncated?: boolean;
  notice?: string;
  totalCount?: number;
  next_offset?: number;
};

/** A declaration's area rows; IHP is flagged only on its last area, as sort order can put it last. */
function declarationRows(
  disasterNumber: number,
  day: string,
  areas: number,
  time = '00:00:00.000',
): AreaRow[] {
  return Array.from({ length: areas }, (_, i) => ({
    disasterNumber,
    declarationTitle: `DECLARATION ${disasterNumber}`,
    state: 'TX',
    incidentType: 'Flood',
    declarationType: 'DR',
    declarationDate: `${day}T${time}Z`,
    ihProgramDeclared: i === areas - 1,
    paProgramDeclared: true,
    hmProgramDeclared: false,
  }));
}

/** Round-robin the rows of several declarations sharing one date, as OpenFEMA orders ties. */
function interleave(...groups: AreaRow[][]): AreaRow[] {
  const out: AreaRow[] = [];
  const longest = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < longest; i++) {
    for (const group of groups) {
      const row = group[i];
      if (row) out.push(row);
    }
  }
  return out;
}

/**
 * DisasterDeclarationsSummaries over `all` (already in `declarationDate desc` order): applies the
 * `declarationDate le` bound `date_to` produces, then `$top`, and counts the whole filtered match.
 */
function ddsServer(all: AreaRow[]) {
  return (url: string) => {
    const filter = decodeURIComponent(/%24filter=([^&]*)/.exec(url)?.[1] ?? '');
    const upTo = /declarationDate le '([^']+)'/.exec(filter)?.[1];
    const match = upTo ? all.filter((r) => r.declarationDate <= upTo) : all;
    const top = Number(/%24top=(\d+)/.exec(url)?.[1]);
    return envelopeResponse(DDS, match.slice(0, top), match.length);
  };
}

/** Area-row count per disaster number over a full dataset — OpenFEMA's complete counts. */
function fullCounts(all: AreaRow[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of all) counts.set(r.disasterNumber, (counts.get(r.disasterNumber) ?? 0) + 1);
  return counts;
}

function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
}

async function search(input: Record<string, unknown>) {
  const result = await runToolContract(femaSearchDisasters, input);
  expect(result.isError).not.toBe(true);
  return { out: result.structuredContent as SearchOutput, text: contentText(result) };
}

/**
 * 11,000 rows: DR-4800 (6,000 areas) on 2024-06-01; DR-4799 (3,000) and DR-4798 (1,500)
 * interleaved on 2024-05-01, where the 10,000-row window ends mid-date and splits both;
 * DR-4797 (500) on 2024-04-01, entirely past the window.
 */
function splitBoundaryDataset(): AreaRow[] {
  return [
    ...declarationRows(4800, '2024-06-01', 6000),
    ...interleave(
      declarationRows(4799, '2024-05-01', 3000),
      declarationRows(4798, '2024-05-01', 1500),
    ),
    ...declarationRows(4797, '2024-04-01', 500),
  ];
}

/**
 * 11,000 rows: 50 declarations x 100 areas on 2024-06-01, then 200 declarations x 30 areas
 * interleaved on 2024-05-15 — the window's oldest date holds 200 declarations, every one cut.
 */
function crowdedBoundaryDataset(): AreaRow[] {
  const newer = Array.from({ length: 50 }, (_, i) =>
    declarationRows(4900 - i, '2024-06-01', 100),
  ).flat();
  const crowded = interleave(
    ...Array.from({ length: 200 }, (_, i) => declarationRows(4700 - i, '2024-05-15', 30)),
  );
  return [...newer, ...crowded];
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

describe('fema_search_disasters — under the 10,000-row window', () => {
  it('pages whole declarations with exact totals and no caveat on either surface', async () => {
    const all = [
      ...declarationRows(4782, '2024-09-27', 3),
      ...declarationRows(4781, '2024-09-20', 1),
      ...declarationRows(4780, '2024-09-01', 1),
    ];
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const { out, text } = await search({ limit: 2 });
    expect(out).toMatchObject({
      total_declarations: 3,
      total_area_rows: 5,
      returned_count: 2,
      totalCount: 3,
      next_offset: 2,
    });
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4782, 3],
      [4781, 1],
    ]);
    expect(out).not.toHaveProperty('truncated');
    expect(out.notice).toBe(
      'Returned 2 of the 3 matching declarations from offset 0, as many as limit allows; continue with offset 2.',
    );
    expect(text).toContain('**2 of 3 unique declaration(s)** (from 5 designated-area rows)');
    expect(text).toContain('**3 total**');
    expect(text).toContain('**Next offset:** 2');
    expect(text).not.toMatch(/lower bound|date_to/i);

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('%24orderby=declarationDate%20desc&%24top=10000');
    expect(urls.some((u) => u.startsWith(CATALOG_URL))).toBe(false);
  });

  it('reads exactly 10,000 matching rows as the whole match: no trim, no truncated', async () => {
    const all = [
      ...declarationRows(4800, '2024-06-01', 6000),
      ...declarationRows(4799, '2024-05-01', 4000),
    ];
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const { out, text } = await search({});
    expect(out.total_area_rows).toBe(10_000);
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4800, 6000],
      [4799, 4000],
    ]);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(text).toContain('**2 of 2 unique declaration(s)**');
  });

  it('an empty match is still no_results', async () => {
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer([])]]));
    const result = await runToolContract(femaSearchDisasters, { state: 'WY' });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: number; data: { reason: string } } }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('no_results');
  });

  it('invalid input is rejected before any request', async () => {
    const result = await runToolContract(femaSearchDisasters, { offset: -1 });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a lowercase county as or-joined exact-case spellings in the request URL (#41)', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), ddsServer(declarationRows(4332, '2017-08-25', 1))]]),
    );
    await search({ county: 'dekalb' });
    // The second request reads the returned declaration's full area rows (#42).
    expect(calledUrls(fetchMock)).toHaveLength(2);
    const [url] = calledUrls(fetchMock);
    const filter = new URL(url ?? '').searchParams.get('$filter');
    expect(filter).toBe(
      "(substringof('DeKalb', designatedArea) or substringof('dekalb', designatedArea) or substringof('DEKALB', designatedArea) or substringof('Dekalb', designatedArea))",
    );
  });

  it('a county value that pushes the URL past the CDN limit → request_too_long with this tool’s hint (#48)', async () => {
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), () => cdnBadRequestResponse()]]));
    const result = await runToolContract(femaSearchDisasters, { county: 'x'.repeat(3_000) });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    const declared = femaSearchDisasters.errors?.find((e) => e.reason === 'request_too_long');
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('request_too_long');
    expect(error.data.recovery.hint).toBe(declared?.recovery);
    expect(contentText(result)).toContain(declared?.recovery ?? '');
    expect(contentText(result)).not.toMatch(/not found at OpenFEMA/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fema_search_disasters — past the 10,000-row window (#21)', () => {
  it('drops the declarations on the window’s oldest date, so every returned one is complete', async () => {
    const all = splitBoundaryDataset();
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const { out } = await search({});
    // DR-4799 and DR-4798 have only some of their rows in the window; both are left out.
    expect(out.declarations.map((d) => d.disaster_number)).toEqual([4800]);
    const counts = fullCounts(all);
    for (const d of out.declarations) {
      expect(d.designated_area_count).toBe(counts.get(d.disaster_number));
    }
    expect(out).toMatchObject({
      total_declarations: 1,
      total_area_rows: 11_000,
      returned_count: 1,
      totalCount: 1,
      truncated: true,
    });
  });

  it('names the date_to continuation in one notice and words totals as lower bounds on both surfaces', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), ddsServer(splitBoundaryDataset())]]),
    );
    const { out, text } = await search({ limit: 10 });
    const notice = out.notice as string;
    expect(notice).toContain('date_to=2024-05-01');
    expect(notice).toMatch(/lower bound/i);
    expect(notice).toContain('11,000');
    expect(notice).toMatch(/offset 0/);
    expect(notice).not.toContain('Offset');
    expect(text).toContain(notice);
    // The header never presents the window's count as the exact total.
    expect(text).not.toContain('**1 of 1 unique declaration(s)**');
    expect(text).toContain(
      '**1 of 1+ unique declaration(s)** — a lower bound: 11,000 designated-area rows match',
    );
    expect(text).not.toContain('**1 total**');
    expect(text).toContain('**Lower bound on total declarations:** 1');
    expect(text).toContain('**truncated:** true');
  });

  it('keeps every declaration when the boundary date holds many, each at its full count', async () => {
    const all = crowdedBoundaryDataset();
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const first = await search({ limit: 1000 });
    expect(first.out.truncated).toBe(true);
    expect(first.out.total_declarations).toBe(50);
    expect(new Set(first.out.declarations.map((d) => d.declaration_date))).toEqual(
      new Set(['2024-06-01T00:00:00.000Z']),
    );
    for (const d of first.out.declarations) expect(d.designated_area_count).toBe(100);
    expect(first.out.notice).toContain('date_to=2024-05-15');

    const next = await search({ limit: 1000, date_to: '2024-05-15' });
    expect(next.out).not.toHaveProperty('truncated');
    expect(next.out.total_declarations).toBe(200);
    for (const d of next.out.declarations) {
      expect(d.designated_area_count).toBe(30);
      expect(d.ia_declared).toBe(true);
    }
  });

  it('following date_to loses and duplicates no declaration between the two windows', async () => {
    const all = splitBoundaryDataset();
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const first = await search({ limit: 1000 });
    const continuation = /date_to=(\d{4}-\d{2}-\d{2})/.exec(first.out.notice ?? '')?.[1];
    expect(continuation).toBe('2024-05-01');

    const second = await search({ limit: 1000, date_to: continuation });
    expect(second.out).not.toHaveProperty('truncated');
    expect(second.out).not.toHaveProperty('notice');
    expect(second.out.declarations[0]?.disaster_number).toBe(4799);

    const seen = [...first.out.declarations, ...second.out.declarations];
    const numbers = seen.map((d) => d.disaster_number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const counts = fullCounts(all);
    expect(numbers.sort()).toEqual([...counts.keys()].sort());
    for (const d of seen) expect(d.designated_area_count).toBe(counts.get(d.disaster_number));
    // DR-4799's IHP flag sits on its last area, past the first window's cut.
    expect(second.out.declarations.find((d) => d.disaster_number === 4799)?.ia_declared).toBe(true);
    expect(calledUrls(fetchMock)[1]).toContain(
      encodeURIComponent("declarationDate le '2024-05-01T23:59:59.999Z'"),
    );
  });

  it('trims and continues by calendar day when declarations carry a time of day', async () => {
    // DR-4799 (18:30) sits wholly inside the window on the day it ends; DR-4798 (00:00) straddles it.
    const all = [
      ...declarationRows(4800, '2024-06-01', 6000),
      ...declarationRows(4799, '2024-05-01', 2500, '18:30:00.000'),
      ...declarationRows(4798, '2024-05-01', 2500),
      ...declarationRows(4797, '2024-04-30', 500, '23:30:00.000'),
    ];
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), ddsServer(all)]]));
    const first = await search({ limit: 1000 });
    expect(first.out.declarations.map((d) => d.disaster_number)).toEqual([4800]);
    expect(first.out.notice).toContain('date_to=2024-05-01');

    const second = await search({ limit: 1000, date_to: '2024-05-01' });
    expect(second.out).not.toHaveProperty('truncated');
    const counts = fullCounts(all);
    const seen = [...first.out.declarations, ...second.out.declarations];
    expect(seen.map((d) => d.disaster_number)).toEqual([4800, 4799, 4798, 4797]);
    for (const d of seen) expect(d.designated_area_count).toBe(counts.get(d.disaster_number));
  });

  it('an offset past the end of a capped window gets one composed notice', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), ddsServer(splitBoundaryDataset())]]),
    );
    const { out, text } = await search({ offset: 5 });
    expect(out).toMatchObject({
      declarations: [],
      returned_count: 0,
      total_declarations: 1,
      truncated: true,
    });
    const notice = out.notice as string;
    expect(notice).toContain('Offset 5 is past the end');
    expect(notice).toContain('last valid offset is 0');
    expect(notice).toContain('date_to=2024-05-01');
    expect(notice).toMatch(/lower bound/i);
    expect(text).toContain(notice);
    expect(text).toContain('**0 of 1+ unique declaration(s)**');
    // One notice: the trailer carries a single blockquote.
    expect(text.match(/^> /gm)).toHaveLength(1);
  });

  it('pages within a capped window up to the last valid offset as a normal page', async () => {
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), ddsServer(crowdedBoundaryDataset())]]),
    );
    const { out } = await search({ limit: 10, offset: 49 });
    expect(out.returned_count).toBe(1);
    expect(out.truncated).toBe(true);
    expect(out.notice).not.toContain('past the end');
    expect(out.notice).toContain('date_to=2024-05-15');
  });
});

describe('fema_search_disasters — county keeps declaration-level totals (#42)', () => {
  type CountyRow = AreaRow & {
    designatedArea: string;
    fipsStateCode: string;
    fipsCountyCode: string;
  };
  type MatchedArea = {
    area: string;
    fips_state_code?: string;
    fips_county_code?: string;
    ia_declared: boolean;
    pa_declared: boolean;
    hm_declared: boolean;
  };
  type CountyOutput = Omit<SearchOutput, 'declarations'> & {
    declarations: Array<Declaration & { pa_declared: boolean; matched_areas?: MatchedArea[] }>;
    area_totals_unavailable?: boolean;
  };

  /** `areas` rows for one declaration; area 0 is Bexar, PA/HM only, the rest carry IHP too. */
  function withAreas(disasterNumber: number, day: string, areas: number): CountyRow[] {
    return declarationRows(disasterNumber, day, areas).map((row, i) => ({
      ...row,
      designatedArea: i === 0 ? 'Bexar (County)' : `Area ${i} (County)`,
      fipsStateCode: '48',
      fipsCountyCode: String(29 + i).padStart(3, '0'),
      ihProgramDeclared: i !== 0,
      paProgramDeclared: true,
      hmProgramDeclared: true,
    }));
  }

  const isInList = (filter: string) => filter.startsWith('disasterNumber in (');
  const filterOf = (url: string) => new URL(url).searchParams.get('$filter') ?? '';

  /**
   * DisasterDeclarationsSummaries over `all`: a `disasterNumber in (…)` filter selects those
   * declarations' rows, in `id` order, paged by `$skip`/`$top`; any other filter is a county
   * search, answered with the rows whose designatedArea holds "Bexar".
   */
  function countyServer(all: CountyRow[], onInList?: (url: string) => Response | undefined) {
    return (url: string) => {
      const filter = filterOf(url);
      const top = Number(new URL(url).searchParams.get('$top'));
      const skip = Number(new URL(url).searchParams.get('$skip') ?? 0);
      if (isInList(filter)) {
        const override = onInList?.(url);
        if (override) return override;
        const numbers = new Set(
          (/\(([^)]*)\)/.exec(filter)?.[1] ?? '').split(',').map((n) => Number(n)),
        );
        const match = all.filter((r) => numbers.has(r.disasterNumber));
        return envelopeResponse(DDS, match.slice(skip, skip + top), match.length);
      }
      const match = all.filter((r) => r.designatedArea.includes('Bexar'));
      return envelopeResponse(DDS, match.slice(0, top), match.length);
    };
  }

  async function countySearch(all: CountyRow[], input: Record<string, unknown>) {
    fetchMock.mockImplementation(routeFetch([[endpoint(DDS, 2), countyServer(all)]]));
    const result = await runToolContract(femaSearchDisasters, input);
    expect(result.isError).not.toBe(true);
    return { out: result.structuredContent as CountyOutput, text: contentText(result) };
  }

  it('reports the whole declaration’s area count and flags, and the matched areas beside them', async () => {
    const all = [...withAreas(4332, '2017-08-25', 53), ...withAreas(4331, '2017-08-20', 5)];
    const { out, text } = await countySearch(all, { county: 'Bexar' });
    expect(out.total_area_rows).toBe(2);
    expect(out.total_declarations).toBe(2);
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4332, 53],
      [4331, 5],
    ]);
    expect(out.declarations[0]).toMatchObject({ ia_declared: true, pa_declared: true });
    expect(out.declarations[0]?.matched_areas).toEqual([
      {
        area: 'Bexar (County)',
        fips_state_code: '48',
        fips_county_code: '029',
        ia_declared: false,
        pa_declared: true,
        hm_declared: true,
      },
    ]);
    expect(out).not.toHaveProperty('area_totals_unavailable');
    expect(text).toContain('**Designated Areas:** 53');
    expect(text).toContain('**Matched Areas:** Bexar (County) (FIPS 48029) — PA, HM');

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0] ?? '').searchParams.get('$select')).toContain(
      'designatedArea,fipsStateCode,fipsCountyCode',
    );
    const followUp = new URL(urls[1] ?? '');
    expect(followUp.searchParams.get('$filter')).toBe('disasterNumber in (4332,4331)');
    expect(followUp.searchParams.get('$select')).toBe(
      'disasterNumber,ihProgramDeclared,paProgramDeclared,hmProgramDeclared',
    );
    expect(followUp.searchParams.get('$orderby')).toBe('id');
    expect(followUp.searchParams.get('$top')).toBe('10000');
  });

  it('reads only the returned page’s declarations', async () => {
    const all = [4335, 4334, 4333, 4332].flatMap((n, i) => withAreas(n, `2017-08-2${5 - i}`, 3));
    const { out } = await countySearch(all, { county: 'Bexar', limit: 2, offset: 1 });
    expect(out.declarations.map((d) => d.disaster_number)).toEqual([4334, 4333]);
    expect(filterOf(calledUrls(fetchMock)[1] ?? '')).toBe('disasterNumber in (4334,4333)');
    expect(out.total_declarations).toBe(4);
  });

  it('pages the full area rows past 10,000 and counts every one', async () => {
    const all = [...withAreas(4800, '2024-06-01', 12_500), ...withAreas(4799, '2024-05-01', 7)];
    const { out } = await countySearch(all, { county: 'Bexar' });
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4800, 12_500],
      [4799, 7],
    ]);
    const followUps = calledUrls(fetchMock).slice(1);
    expect(followUps.map((u) => new URL(u).searchParams.get('$skip'))).toEqual(['0', '10000']);
  });

  it('reads the pages after the first together, at most 3 at a time', async () => {
    const all = [
      ...withAreas(4800, '2024-06-01', 32_324),
      ...withAreas(4799, '2024-05-01', 20_000),
    ];
    const serve = countyServer(all);
    let inFlight = 0;
    const peaks: Array<[skip: string | null, inFlight: number]> = [];
    fetchMock.mockImplementation(
      routeFetch([
        [
          endpoint(DDS, 2),
          async (url) => {
            if (!isInList(filterOf(url))) return serve(url);
            inFlight += 1;
            peaks.push([new URL(url).searchParams.get('$skip'), inFlight]);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight -= 1;
            return serve(url);
          },
        ],
      ]),
    );
    const result = await runToolContract(femaSearchDisasters, { county: 'Bexar' });
    const out = result.structuredContent as CountyOutput;
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4800, 32_324],
      [4799, 20_000],
    ]);
    expect(peaks).toEqual([
      ['0', 1],
      ['10000', 1],
      ['20000', 2],
      ['30000', 3],
      ['40000', 1],
      ['50000', 2],
    ]);
  });

  /** The page a limit-1000 county search returns: 1,000 declarations, one matched area each. */
  function thousandDeclarations(first: number): CountyRow[] {
    return Array.from({ length: 1000 }, (_, i) =>
      withAreas(first - i, `2020-${String(1 + (i % 12)).padStart(2, '0')}-01`, 2),
    )
      .flat()
      .sort((a, b) => b.declarationDate.localeCompare(a.declarationDate));
  }

  it('reads a full page of 1,000 four-digit disaster numbers in one request under the URL guard', async () => {
    const { out } = await countySearch(thousandDeclarations(5678), {
      county: 'Bexar',
      limit: 1000,
    });
    // The 1,000 declarations' area rows are read before the response budget cuts the page.
    expect(out.returned_count).toBeLessThan(1000);
    expect(out.next_offset).toBe(out.returned_count);
    expect(out.declarations.every((d) => d.designated_area_count === 2)).toBe(true);
    const followUps = calledUrls(fetchMock).slice(1);
    expect(followUps).toHaveLength(1);
    expect((/\(([^)]*)\)/.exec(filterOf(followUps[0] ?? ''))?.[1] ?? '').split(',')).toHaveLength(
      1000,
    );
    expect(followUps[0]?.length).toBeLessThan(8_000);
  });

  it('cuts the page at the response budget after the area totals are read, charging the corrected declarations', async () => {
    /** 250 declarations of 100 areas each, one Bexar area apiece, titles `titleLength` long. */
    const build = (titleLength: number) =>
      Array.from({ length: 250 }, (_, i) =>
        withAreas(4500 + i, '2020-06-01', 100).map((row) => ({
          ...row,
          declarationTitle: 'T'.padEnd(titleLength, 'x'),
        })),
      ).flat();
    const probe = await countySearch(build(10).slice(0, 100), { county: 'Bexar' });
    const probeLength = JSON.stringify(probe.out.declarations[0]).length;
    /**
     * Each corrected declaration then serializes to 499 characters and costs 501: 199 fit the
     * 100,000-character budget and a 200th does not. Before the correction (area count 1,
     * ia_declared false) each would serialize one character shorter and cost 500, so 200 would fit.
     */
    const { out } = await countySearch(build(10 + 499 - probeLength), {
      county: 'Bexar',
      limit: 1000,
    });
    expect(JSON.stringify(out.declarations[0]).length).toBe(499);
    expect(out.returned_count).toBe(199);
    expect(out.next_offset).toBe(199);
    expect(out.total_declarations).toBe(250);
    expect(out.declarations.every((d) => d.designated_area_count === 100 && d.ia_declared)).toBe(
      true,
    );
    expect(out.notice).toBe(
      'Returned 199 of the 250 matching declarations from offset 0, the most that fit the 100,000-character response budget; continue with offset 199.',
    );
  });

  it('splits the disaster-number list across requests that each stay under the URL guard', async () => {
    const { out } = await countySearch(thousandDeclarations(32_000), {
      county: 'Bexar',
      limit: 1000,
    });
    expect(out.declarations.every((d) => d.designated_area_count === 2)).toBe(true);
    const followUps = calledUrls(fetchMock).slice(1);
    expect(followUps).toHaveLength(2);
    const numbers = followUps.flatMap((u) =>
      (/\(([^)]*)\)/.exec(filterOf(u))?.[1] ?? '').split(','),
    );
    expect(new Set(numbers).size).toBe(1000);
    expect(numbers).toHaveLength(1000);
    for (const url of followUps) expect(url.length).toBeLessThan(8_000);
  });

  /** One declaration with two areas, Bexar first, per disaster number. */
  const numbered = (numbers: number[]) =>
    numbers.flatMap((n, i) => withAreas(n, `2020-${String(1 + (i % 12)).padStart(2, '0')}-01`, 2));
  /** `fiveDigit` numbers from 10,000 up, then four-digit ones from 1,000 up: 1,000 in all. */
  const mixedDigits = (fiveDigit: number) => [
    ...Array.from({ length: fiveDigit }, (_, i) => 10_000 + i),
    ...Array.from({ length: 1000 - fiveDigit }, (_, i) => 1000 + i),
  ];

  it.each([
    [479, 1],
    [480, 2],
  ])(
    'takes a disaster-number list of up to 7,500 encoded characters in one request (%i five-digit numbers → %i request(s))',
    async (fiveDigit, requests) => {
      const { out } = await countySearch(numbered(mixedDigits(fiveDigit)), {
        county: 'Bexar',
        limit: 1000,
      });
      expect(out.declarations.every((d) => d.designated_area_count === 2)).toBe(true);
      const filters = calledUrls(fetchMock).slice(1).map(filterOf);
      expect(filters).toHaveLength(requests);
      const lengths = filters.map((f) => encodeURIComponent(f).length);
      if (requests === 1) expect(lengths).toEqual([7_500]);
      for (const length of lengths) expect(length).toBeLessThanOrEqual(7_500);
    },
  );

  it.each([
    [
      'a later page of one list',
      () => [...withAreas(4800, '2024-06-01', 12_500), ...withAreas(4799, '2024-05-01', 7)],
      (url: string, inListCall: number) =>
        inListCall > 1 && new URL(url).searchParams.get('$skip') === '10000',
    ],
    [
      'the second of two lists',
      () => thousandDeclarations(32_000),
      (_url: string, inListCall: number) => inListCall === 2,
    ],
  ])(
    'a failed request for %s keeps every declaration’s matched-area values, never a mix',
    async (_, rows, fails) => {
      let inListCalls = 0;
      let failed = 0;
      fetchMock.mockImplementation(
        routeFetch([
          [
            endpoint(DDS, 2),
            countyServer(rows(), (url) => {
              if (!fails(url, ++inListCalls)) return;
              failed += 1;
              return jsonResponse(400, ERROR_BODIES.filterUnknownField);
            }),
          ],
        ]),
      );
      const result = await runToolContract(femaSearchDisasters, { county: 'Bexar', limit: 1000 });
      expect(result.isError).not.toBe(true);
      expect(failed).toBe(1);
      const out = result.structuredContent as CountyOutput;
      expect(out.area_totals_unavailable).toBe(true);
      for (const d of out.declarations) {
        expect(d.designated_area_count).toBe(d.matched_areas?.length);
        expect(d.ia_declared).toBe(false);
      }
    },
  );

  it('without county: one request, no matched_areas, unchanged totals', async () => {
    const all = withAreas(4332, '2017-08-25', 53);
    fetchMock.mockImplementation(
      routeFetch([[endpoint(DDS, 2), () => envelopeResponse(DDS, all, all.length)]]),
    );
    const result = await runToolContract(femaSearchDisasters, { state: 'TX' });
    const out = result.structuredContent as CountyOutput;
    expect(out.declarations[0]).toMatchObject({ designated_area_count: 53, ia_declared: true });
    expect(out.declarations[0]).not.toHaveProperty('matched_areas');
    expect(contentText(result)).not.toContain('Matched Areas');
    expect(calledUrls(fetchMock)).toHaveLength(1);
    expect(new URL(calledUrls(fetchMock)[0] ?? '').searchParams.get('$select')).not.toContain(
      'designatedArea',
    );
  });

  it('an offset past the end reads no area rows', async () => {
    const { out } = await countySearch(withAreas(4332, '2017-08-25', 3), {
      county: 'Bexar',
      offset: 5,
    });
    expect(out.returned_count).toBe(0);
    expect(calledUrls(fetchMock)).toHaveLength(1);
  });

  it('a failed area-row request keeps the matched-area values and says so on both surfaces', async () => {
    const all = withAreas(4332, '2017-08-25', 53);
    fetchMock.mockImplementation(
      routeFetch([
        [
          endpoint(DDS, 2),
          countyServer(all, () => jsonResponse(400, ERROR_BODIES.filterUnknownField)),
        ],
      ]),
    );
    const result = await runToolContract(femaSearchDisasters, { county: 'Bexar' });
    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as CountyOutput;
    expect(out.area_totals_unavailable).toBe(true);
    expect(out.declarations[0]).toMatchObject({ designated_area_count: 1, ia_declared: false });
    expect(out.declarations[0]?.matched_areas).toHaveLength(1);
    expect(out.notice).toMatch(/count only the areas county matched/);
    expect(out.notice).toContain('fema_get_disaster');
    expect(contentText(result)).toContain(out.notice ?? '');
  });

  it('a request cancelled during the area-row read ends as RequestCancelled, not a degraded result', async () => {
    const all = withAreas(4332, '2017-08-25', 53);
    const controller = new AbortController();
    fetchMock.mockImplementation(
      routeFetch([
        [
          endpoint(DDS, 2),
          countyServer(all, () => {
            controller.abort();
            throw new DOMException('The operation was aborted.', 'AbortError');
          }),
        ],
      ]),
    );
    const result = await runToolContract(
      femaSearchDisasters,
      { county: 'Bexar' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.RequestCancelled,
    );
  });
});
