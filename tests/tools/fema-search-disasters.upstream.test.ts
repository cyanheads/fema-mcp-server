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
  endpoint,
  envelopeResponse,
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
    });
    expect(out.declarations.map((d) => [d.disaster_number, d.designated_area_count])).toEqual([
      [4782, 3],
      [4781, 1],
    ]);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(text).toContain('**2 of 3 unique declaration(s)** (from 5 designated-area rows)');
    expect(text).toContain('**3 total**');
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
