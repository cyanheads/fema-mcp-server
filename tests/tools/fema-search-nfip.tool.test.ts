/**
 * @fileoverview Tests for fema_search_nfip through its public contract (`runToolContract`)
 * against the real OpenFemaService with `fetch` stubbed by an ordered `NfipClaims` v3
 * match, and a real DuckDB canvas: request shape, inline paging and budget, canvas
 * acquisition and cleanup, spill staging and the row cap, the notice matrix, the field
 * descriptions, and `format()`.
 * @module tests/tools/fema-search-nfip.tool.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaSearchNfip } from '@/mcp-server/tools/definitions/fema-search-nfip.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { initOpenFemaService } from '@/services/openfema/openfema-service.js';
import {
  calledUrls,
  ERROR_BODIES,
  endpoint,
  envelopeResponse,
  jsonResponse,
  routeFetch,
} from '../helpers/openfema-fixtures.js';

const NFIP_V3 = endpoint('NfipClaims', 3);
const SELECT =
  'state,countyCode,reportedZipCode,dateOfLoss,yearOfLoss,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,buildingDamageAmount,contentsDamageAmount,ratedFloodZone,causeOfDamage,occupancyType';
const PREVIEW_CHARS = 100_000;
const MAX_CANVAS_ROWS = 50_000;
const tenant = () => createMockContext({ tenantId: 'default' });

/**
 * Claim `i` of an ordered match, v3-shaped. Every field the tool reads is present, so a
 * returned claim serializes exactly like the canvas row the preview budget measures.
 * `amountPaidOnBuildingClaim` (1000 + i) identifies the row.
 */
function claim(i: number) {
  return {
    state: 'TX',
    countyCode: '48201',
    reportedZipCode: '77008',
    dateOfLoss: `2022-12-${String(28 - (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
    yearOfLoss: 2022,
    amountPaidOnBuildingClaim: 1000 + i,
    amountPaidOnContentsClaim: 250.5,
    buildingDamageAmount: 5000,
    contentsDamageAmount: 1200,
    ratedFloodZone: 'AE',
    causeOfDamage: '4',
    occupancyType: 11,
    id: `9f0c${String(i).padStart(8, '0')}`,
  };
}

const param = (url: string, name: string) => {
  const raw = new RegExp(`%24${name}=([^&]*)`).exec(url)?.[1];
  return raw === undefined ? undefined : decodeURIComponent(raw);
};

interface MatchOptions {
  /** Answer the page at this `$skip` with an OpenFEMA 400. */
  failAtSkip?: number;
  /** Called before a page is served. */
  onPage?: (skip: number) => void;
  /** Builds claim `i` of the match (default {@link claim}). */
  row?: (i: number) => object;
}

/** A `fetch` that serves an ordered match of `total` claims the way OpenFEMA pages it. */
function nfipMatch(total: number, { failAtSkip, onPage, row = claim }: MatchOptions = {}) {
  return routeFetch([
    [
      NFIP_V3,
      (url) => {
        const skip = Number(param(url, 'skip') ?? 0);
        const top = Number(param(url, 'top'));
        onPage?.(skip);
        if (skip === failAtSkip) return jsonResponse(400, ERROR_BODIES.filterUnknownField);
        const size = Math.max(0, Math.min(top, total - skip));
        const rows = Array.from({ length: size }, (_, k) => row(skip + k));
        return envelopeResponse('NfipClaims', rows, total, 'v3');
      },
    ],
  ]);
}

interface NfipOut {
  canvas_id?: string;
  canvas_table?: string;
  claims: Array<Record<string, unknown>>;
  notice?: string;
  returned_count: number;
  spilled: boolean;
  staged_count?: number;
  total_count: number;
  truncated?: boolean;
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
const out = (result: ContractResult) => result.structuredContent as unknown as NfipOut;
const text = (result: ContractResult) =>
  (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
/** Row indexes of the returned claims. */
const ids = (o: NfipOut) => o.claims.map((c) => (c.amount_paid_building as number) - 1000);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const chars = (rows: unknown[]) => rows.reduce<number>((n, r) => n + JSON.stringify(r).length, 0);

/** Canvas-row JSON length of a raw claim — the unit the preview budget counts. */
const canvasChars = (c: Partial<ReturnType<typeof claim>>) =>
  JSON.stringify({
    state: c.state ?? null,
    county_code: c.countyCode ?? null,
    zip_code: c.reportedZipCode ?? null,
    date_of_loss: c.dateOfLoss ?? null,
    year_of_loss: c.yearOfLoss ?? null,
    amount_paid_building: c.amountPaidOnBuildingClaim ?? null,
    amount_paid_contents: c.amountPaidOnContentsClaim ?? null,
    building_damage_amount: c.buildingDamageAmount ?? null,
    contents_damage_amount: c.contentsDamageAmount ?? null,
    rated_flood_zone: c.ratedFloodZone ?? null,
    cause_of_damage: c.causeOfDamage ?? null,
    occupancy_type: c.occupancyType ?? null,
  }).length;
/** Canvas-row JSON length of claim `i`. */
const rowChars = (i: number) => canvasChars(claim(i));
/** How many leading claims of a match fit the 100,000-character budget. */
const previewLength = () => {
  let used = 0;
  let n = 0;
  while (used + rowChars(n) <= PREVIEW_CHARS) used += rowChars(n++);
  return n;
};

let fetchMock: Mock;
let canvas: DataCanvas | undefined;

function useCanvas(maxCanvasesPerTenant = 100): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 100,
    exportRootPath: '/tmp',
    memoryLimitMb: 256,
    schemaSniffRows: 10,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      maxCanvasesPerTenant,
      sweeperIntervalMs: 0,
    }),
  );
  setCanvas(canvas);
  return canvas;
}

beforeEach(() => {
  fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initOpenFemaService({} as unknown as AppConfig, {} as unknown as StorageService);
  setCanvas(undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCanvas(undefined);
  await canvas?.shutdown(tenant());
  canvas = undefined;
});

const search = (input: Record<string, unknown>, context = {}) =>
  runToolContract(femaSearchNfip, { state: 'TX', ...input } as never, { context });

describe('fema_search_nfip — request shape', () => {
  it('sends $select, $orderby=dateOfLoss desc,id, $skip=offset, and $top on the canvas-disabled request', async () => {
    fetchMock.mockImplementation(nfipMatch(187));
    await search({ county_code: '201', year_from: 2022, year_to: 2022, limit: 50, offset: 100 });
    const [url = ''] = calledUrls(fetchMock);
    expect(param(url, 'select')).toBe(SELECT);
    expect(param(url, 'orderby')).toBe('dateOfLoss desc,id');
    expect(param(url, 'skip')).toBe('100');
    expect(param(url, 'top')).toBe('50');
    expect(param(url, 'filter')).toBe(
      "state eq 'TX' and countyCode eq '48201' and yearOfLoss ge 2022 and yearOfLoss le 2022",
    );
  });

  it('sends $select and $orderby on every canvas page', async () => {
    useCanvas();
    fetchMock.mockImplementation(nfipMatch(7000));
    const result = await search({ limit: 5 });
    expect(out(result).spilled).toBe(true);
    const urls = calledUrls(fetchMock);
    expect(urls.map((u) => param(u, 'skip'))).toEqual(['0', '5000']);
    for (const url of urls) {
      expect(param(url, 'select')).toBe(SELECT);
      expect(param(url, 'orderby')).toBe('dateOfLoss desc,id');
      expect(param(url, 'top')).toBe('5000');
    }
  }, 20_000);

  it('normalizes a 3-digit county_code to the 5-digit state+county FIPS', async () => {
    fetchMock.mockImplementation(nfipMatch(3));
    await search({ county_code: '201' });
    expect(param(calledUrls(fetchMock)[0] ?? '', 'filter')).toBe(
      "state eq 'TX' and countyCode eq '48201'",
    );
  });

  it('passes a 5-digit county_code through unchanged', async () => {
    fetchMock.mockImplementation(nfipMatch(3));
    await search({ county_code: '48201' });
    expect(param(calledUrls(fetchMock)[0] ?? '', 'filter')).toBe(
      "state eq 'TX' and countyCode eq '48201'",
    );
  });
});

describe('fema_search_nfip — canvas disabled', () => {
  it('pages a 187-claim match with limit 100 at offsets 0 and 100, every claim exactly once', async () => {
    fetchMock.mockImplementation(nfipMatch(187));
    const first = await search({ limit: 100, offset: 0 });
    const second = await search({ limit: 100, offset: 100 });
    expect(out(first)).toMatchObject({ total_count: 187, returned_count: 100, spilled: false });
    expect(out(second)).toMatchObject({ total_count: 187, returned_count: 87, spilled: false });
    expect([...ids(out(first)), ...ids(out(second))]).toEqual(range(0, 187));

    const next = 'Returned 100 of the 187 matching claims from offset 0; continue with offset 100.';
    expect(out(first).notice).toBe(next);
    expect(text(first)).toContain(next);
    expect(out(second).notice).toBeUndefined();
    expect(text(second)).not.toContain('continue with offset');
  });

  it('returns a match that fits the limit whole, with no notice', async () => {
    fetchMock.mockImplementation(nfipMatch(3));
    const result = await search({});
    expect(out(result)).toMatchObject({ total_count: 3, returned_count: 3, spilled: false });
    expect(out(result).notice).toBeUndefined();
  });

  it('answers an offset at the end with an empty page, its totals, and the last valid offset', async () => {
    fetchMock.mockImplementation(nfipMatch(187));
    const result = await search({ limit: 100, offset: 187 });
    expect(result.isError).not.toBe(true);
    expect(out(result)).toMatchObject({
      claims: [],
      total_count: 187,
      returned_count: 0,
      spilled: false,
    });
    const notice =
      'Offset 187 is past the end of the 187 matching claims; the last valid offset is 186.';
    expect(out(result).notice).toBe(notice);
    expect(text(result)).toContain(notice);
    expect(text(result)).toContain('past the end of the matching claims');
  });

  it('bounds limit 10000 by the 100,000-character budget and names the next offset', async () => {
    fetchMock.mockImplementation(nfipMatch(20_000));
    const result = await search({ limit: 10_000 });
    const o = out(result);
    const fit = previewLength();
    expect(o.returned_count).toBe(fit);
    expect(ids(o)).toEqual(range(0, fit));
    // The claims are the most that fit: one more row would cross the budget.
    expect(chars(o.claims)).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(chars(o.claims) + rowChars(fit)).toBeGreaterThan(PREVIEW_CHARS);
    const notice = `Returned ${fit} of the 20000 matching claims from offset 0, the most that fit the 100,000-character inline budget; continue with offset ${fit}.`;
    expect(o.notice).toBe(notice);
    expect(text(result)).toContain(notice);
    // Rows that can never fit are not requested: none serializes shorter than empty strings and zeros.
    const shortest = canvasChars({
      state: '',
      countyCode: '',
      reportedZipCode: '',
      dateOfLoss: '',
      yearOfLoss: 0,
      amountPaidOnBuildingClaim: 0,
      amountPaidOnContentsClaim: 0,
      buildingDamageAmount: 0,
      contentsDamageAmount: 0,
      ratedFloodZone: '',
      causeOfDamage: '',
      occupancyType: 0,
    });
    expect(Number(param(calledUrls(fetchMock)[0] ?? '', 'top'))).toBeLessThanOrEqual(
      Math.floor(PREVIEW_CHARS / shortest),
    );
  });

  it('fills the budget with claims that serialize shorter than a row of nulls', async () => {
    // A claim with no ZIP, zone, or date that paid $0 is shorter than the all-null canvas row.
    const short = () => ({
      state: 'TX',
      yearOfLoss: 2022,
      amountPaidOnBuildingClaim: 0,
      amountPaidOnContentsClaim: 0,
      buildingDamageAmount: 0,
      contentsDamageAmount: 0,
      causeOfDamage: '4',
      occupancyType: 1,
    });
    fetchMock.mockImplementation(nfipMatch(2000, { row: short }));
    const o = out(await search({ limit: 1000 }));
    const fit = Math.floor(PREVIEW_CHARS / canvasChars(short()));
    expect(fit).toBeGreaterThan(364);
    expect(o.returned_count).toBe(fit);
    expect(o.notice).toBe(
      `Returned ${fit} of the 2000 matching claims from offset 0, the most that fit the 100,000-character inline budget; continue with offset ${fit}.`,
    );
  });

  it('continues a budget-cut page from the offset the notice names', async () => {
    fetchMock.mockImplementation(nfipMatch(20_000));
    const fit = previewLength();
    const second = out(await search({ limit: 10_000, offset: fit }));
    expect(ids(second)[0]).toBe(fit);
    expect(second.notice).toContain(`continue with offset ${fit + second.returned_count}.`);
  });

  it('ignores a canvas_id when the canvas is disabled', async () => {
    fetchMock.mockImplementation(nfipMatch(3));
    const result = await search({ canvas_id: 'Ab_012-xy9' });
    expect(out(result)).toMatchObject({ total_count: 3, returned_count: 3, spilled: false });
    expect(out(result).canvas_id).toBeUndefined();
  });

  it('keeps no_results for an empty match, at any offset', async () => {
    fetchMock.mockImplementation(nfipMatch(0));
    for (const offset of [0, 50]) {
      const result = await search({ zip_code: '00000', offset });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_results' } },
      });
    }
  });

  it('maps sparse rows without inventing the missing fields', async () => {
    fetchMock.mockImplementation(
      routeFetch([[NFIP_V3, () => envelopeResponse('NfipClaims', [{ state: 'TX' }], 1, 'v3')]]),
    );
    const o = out(await search({}));
    expect(o.claims).toEqual([{ state: 'TX' }]);
  });
});

describe('fema_search_nfip — canvas enabled, match fits the preview', () => {
  it('never acquires a canvas: count unchanged, no canvas fields, next offset named', async () => {
    const c = useCanvas();
    const acquire = vi.spyOn(c, 'acquire');
    fetchMock.mockImplementation(nfipMatch(187));
    const result = await search({ county_code: '201', year_from: 2022, year_to: 2022, limit: 2 });
    const o = out(result);
    expect(acquire).not.toHaveBeenCalled();
    expect(c.countForTenant(tenant())).toBe(0);
    expect(o).toMatchObject({ total_count: 187, returned_count: 2, spilled: false });
    expect(o.canvas_id).toBeUndefined();
    expect(o.canvas_table).toBeUndefined();
    const next = 'Returned 2 of the 187 matching claims from offset 0; continue with offset 2.';
    expect(o.notice).toBe(next);
    expect(text(result)).toContain(next);
    expect(calledUrls(fetchMock)).toHaveLength(1);
  });

  it('pages the match at offsets 0 and 100, every claim exactly once', async () => {
    useCanvas();
    fetchMock.mockImplementation(nfipMatch(187));
    const first = out(await search({ limit: 100, offset: 0 }));
    const second = out(await search({ limit: 100, offset: 100 }));
    expect([...ids(first), ...ids(second)]).toEqual(range(0, 187));
    expect(first.notice).toBe(
      'Returned 100 of the 187 matching claims from offset 0; continue with offset 100.',
    );
    expect(second.notice).toBeUndefined();
    // Offset 0 reads a whole canvas page to learn whether the match overflows; a later offset reads its own page.
    expect(calledUrls(fetchMock).map((u) => [param(u, 'skip'), param(u, 'top')])).toEqual([
      ['0', '5000'],
      ['100', '100'],
    ]);
  });

  it('returns the whole fitting match with no notice and no canvas fields', async () => {
    useCanvas();
    fetchMock.mockImplementation(nfipMatch(187));
    const o = out(await search({ limit: 1000 }));
    expect(o).toMatchObject({ total_count: 187, returned_count: 187, spilled: false });
    expect(o.notice).toBeUndefined();
    expect(o.canvas_id).toBeUndefined();
  });

  it('answers an offset past the end without a canvas', async () => {
    const c = useCanvas();
    const acquire = vi.spyOn(c, 'acquire');
    fetchMock.mockImplementation(nfipMatch(187));
    const o = out(await search({ offset: 500 }));
    expect(o).toMatchObject({ claims: [], total_count: 187, returned_count: 0, spilled: false });
    expect(o.notice).toBe(
      'Offset 500 is past the end of the 187 matching claims; the last valid offset is 186.',
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it('reports no_results for an empty match without acquiring a canvas', async () => {
    const c = useCanvas();
    const acquire = vi.spyOn(c, 'acquire');
    fetchMock.mockImplementation(nfipMatch(0));
    const result = await search({ zip_code: '00000' });
    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_results' } } });
    expect(acquire).not.toHaveBeenCalled();
    expect(c.countForTenant(tenant())).toBe(0);
  });

  it('leaves no canvas behind when the first page fails', async () => {
    const c = useCanvas();
    fetchMock.mockImplementation(nfipMatch(187, { failAtSkip: 0 }));
    const result = await search({});
    expect(result.isError).toBe(true);
    expect(c.countForTenant(tenant())).toBe(0);
  });

  it('succeeds with the tenant canvas pool at its cap', async () => {
    const c = useCanvas(1);
    await c.acquire(undefined, tenant());
    fetchMock.mockImplementation(nfipMatch(187));
    const result = await search({ limit: 2 });
    expect(result.isError).not.toBe(true);
    expect(out(result)).toMatchObject({ total_count: 187, returned_count: 2 });
    expect(c.countForTenant(tenant())).toBe(1);
  });

  it('leaves a caller-supplied canvas untouched when nothing is staged', async () => {
    const c = useCanvas();
    const held = await c.acquire(undefined, tenant());
    const acquire = vi.spyOn(c, 'acquire');
    const drop = vi.spyOn(c, 'drop');
    fetchMock.mockImplementation(nfipMatch(187));
    const o = out(await search({ canvas_id: held.canvasId, limit: 10 }));
    expect(o.spilled).toBe(false);
    expect(o.canvas_id).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    expect(c.countForTenant(tenant())).toBe(1);
  });
});

describe('fema_search_nfip — canvas enabled, match overflows the preview', () => {
  it('stages the full match and names fema_dataframe_describe then fema_dataframe_query', async () => {
    const c = useCanvas();
    fetchMock.mockImplementation(nfipMatch(7000));
    const result = await search({ limit: 5 });
    const o = out(result);
    expect(o).toMatchObject({
      spilled: true,
      total_count: 7000,
      staged_count: 7000,
      returned_count: 5,
    });
    expect(o.truncated).toBeUndefined();
    expect(ids(o)).toEqual(range(0, 5));
    expect(c.countForTenant(tenant())).toBe(1);

    const notice =
      `Staged 7000 matching claims on canvas table "${o.canvas_table}" (canvas_id "${o.canvas_id}"). ` +
      'List its columns with fema_dataframe_describe, then run SQL on it with fema_dataframe_query. ' +
      'The first 5 of them are inline here; read the rest from the canvas table.';
    expect(o.notice).toBe(notice);
    expect(text(result)).toContain(notice);
    const body = text(result);
    expect(body.indexOf('fema_dataframe_describe')).toBeLessThan(
      body.indexOf('fema_dataframe_query'),
    );

    const instance = await c.acquire(o.canvas_id, tenant());
    const [table] = await instance.describe();
    expect(table).toMatchObject({ name: o.canvas_table, rowCount: 7000 });
  }, 20_000);

  it('counts the inline claims as the whole preview when limit exceeds it', async () => {
    useCanvas();
    fetchMock.mockImplementation(nfipMatch(7000));
    const o = out(await search({}));
    const preview = previewLength();
    expect(o.returned_count).toBe(preview);
    expect(o.notice).toContain(
      `The first ${preview} of them are inline here; read the rest from the canvas table.`,
    );
  }, 20_000);

  it('pages by a later offset with one upstream page and no canvas', async () => {
    const c = useCanvas();
    const acquire = vi.spyOn(c, 'acquire');
    fetchMock.mockImplementation(nfipMatch(93_589));
    for (const offset of [3, 1000]) {
      const result = await search({ limit: 10, offset });
      const o = out(result);
      expect(o).toMatchObject({ total_count: 93_589, returned_count: 10, spilled: false });
      expect(ids(o)).toEqual(range(offset, offset + 10));
      expect(o.canvas_id).toBeUndefined();
      const next = `Returned 10 of the 93589 matching claims from offset ${offset}; continue with offset ${offset + 10}.`;
      expect(o.notice).toBe(next);
      expect(text(result)).toContain(next);
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(c.countForTenant(tenant())).toBe(0);
    expect(calledUrls(fetchMock).map((u) => [param(u, 'skip'), param(u, 'top')])).toEqual([
      ['3', '10'],
      ['1000', '10'],
    ]);
  });

  it('keeps paging a spilled match after the spill filled the tenant canvas pool', async () => {
    const c = useCanvas(1);
    fetchMock.mockImplementation(nfipMatch(7000));
    const first = out(await search({ limit: 5 }));
    expect(first.spilled).toBe(true);
    for (const offset of [5, 3000]) {
      const result = await search({ limit: 5, offset });
      expect(result.isError).not.toBe(true);
      expect(ids(out(result))).toEqual(range(offset, offset + 5));
    }
    expect(c.countForTenant(tenant())).toBe(1);
    const [table] = await (await c.acquire(first.canvas_id, tenant())).describe();
    expect(table).toMatchObject({ name: first.canvas_table, rowCount: 7000 });
  }, 20_000);

  it('stages a match of exactly one canvas page from that page alone', async () => {
    useCanvas();
    fetchMock.mockImplementation(nfipMatch(5000));
    const o = out(await search({ limit: 5 }));
    expect(o).toMatchObject({ spilled: true, total_count: 5000, staged_count: 5000 });
    expect(o.truncated).toBeUndefined();
    expect(calledUrls(fetchMock)).toHaveLength(1);
  }, 20_000);

  it('does not claim the canvas cap when the match shrinks between pages', async () => {
    useCanvas();
    // OpenFEMA drops one claim after the first page is read: later pages count 6,999.
    fetchMock.mockImplementation(
      routeFetch([
        [
          NFIP_V3,
          (url) => {
            const skip = Number(param(url, 'skip'));
            const total = skip === 0 ? 7000 : 6999;
            const size = Math.max(0, Math.min(Number(param(url, 'top')), total - skip));
            const rows = Array.from({ length: size }, (_, k) => claim(skip + k + (skip ? 1 : 0)));
            return envelopeResponse('NfipClaims', rows, total, 'v3');
          },
        ],
      ]),
    );
    const o = out(await search({ limit: 5 }));
    expect(o).toMatchObject({ spilled: true, total_count: 7000, staged_count: 6999 });
    expect(o.truncated).toBeUndefined();
    expect(o.notice).not.toContain('cap');
    expect(o.notice).toContain('Staged 6999 matching claims');
  }, 20_000);

  it('answers an offset past the end without staging', async () => {
    const c = useCanvas();
    const acquire = vi.spyOn(c, 'acquire');
    fetchMock.mockImplementation(nfipMatch(7000));
    const o = out(await search({ offset: 7000 }));
    expect(o).toMatchObject({ claims: [], total_count: 7000, returned_count: 0, spilled: false });
    expect(o.notice).toBe(
      'Offset 7000 is past the end of the 7000 matching claims; the last valid offset is 6999.',
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(calledUrls(fetchMock)).toHaveLength(1);
  });

  it('registers the spill on a caller-supplied canvas', async () => {
    const c = useCanvas();
    const held = await c.acquire(undefined, tenant());
    fetchMock.mockImplementation(nfipMatch(7000));
    const o = out(await search({ canvas_id: held.canvasId, limit: 5 }));
    expect(o).toMatchObject({ spilled: true, canvas_id: held.canvasId });
    expect(c.countForTenant(tenant())).toBe(1);
    const tables = await (await c.acquire(held.canvasId, tenant())).describe();
    expect(tables.map((t) => t.name)).toContain(o.canvas_table);
  }, 20_000);

  it('drops the canvas it minted when a later page fails', async () => {
    const c = useCanvas();
    const drop = vi.spyOn(c, 'drop');
    fetchMock.mockImplementation(nfipMatch(7000, { failAtSkip: 5000 }));
    const result = await search({ limit: 5 });
    expect(result.isError).toBe(true);
    expect(c.countForTenant(tenant())).toBe(0);
    expect(drop).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('drops the canvas it minted when the request is aborted mid-drain', async () => {
    const c = useCanvas();
    const controller = new AbortController();
    fetchMock.mockImplementation(
      nfipMatch(7000, { onPage: (skip) => skip === 5000 && controller.abort() }),
    );
    const result = await search({ limit: 5 }, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(c.countForTenant(tenant())).toBe(0);
  }, 20_000);

  it.each([
    ['a later page fails', false],
    ['the request is aborted mid-drain', true],
  ])(
    'never drops a caller-supplied canvas when %s',
    async (_label, abort) => {
      const c = useCanvas();
      const held = await c.acquire(undefined, tenant());
      await held.registerTable('earlier', [{ n: 1 }]);
      const drop = vi.spyOn(c, 'drop');
      const controller = new AbortController();
      fetchMock.mockImplementation(
        abort
          ? nfipMatch(7000, { onPage: (skip) => skip === 5000 && controller.abort() })
          : nfipMatch(7000, { failAtSkip: 5000 }),
      );
      const result = await search(
        { canvas_id: held.canvasId, limit: 5 },
        { signal: controller.signal },
      );
      expect(result.isError).toBe(true);
      expect(drop).not.toHaveBeenCalled();
      expect(c.countForTenant(tenant())).toBe(1);
      const tables = await (await c.acquire(held.canvasId, tenant())).describe();
      expect(tables.map((t) => t.name)).toEqual(['earlier']);
    },
    20_000,
  );

  it(`stages ${MAX_CANVAS_ROWS} rows of a larger match and reports the upstream total_count`, async () => {
    const c = useCanvas();
    fetchMock.mockImplementation(nfipMatch(93_589));
    const result = await search({ year_from: 2017, year_to: 2017, limit: 5 });
    const o = out(result);
    expect(o).toMatchObject({
      spilled: true,
      truncated: true,
      total_count: 93_589,
      staged_count: MAX_CANVAS_ROWS,
      returned_count: 5,
    });
    expect(o.notice).toContain(
      `holds the first ${MAX_CANVAS_ROWS} of the 93589 matching claims: the 50,000-row canvas cap was reached.`,
    );
    expect(text(result)).toContain(
      `the table holds ${MAX_CANVAS_ROWS} of the 93589 matching claims`,
    );
    // Pages stop at the cap: nothing past row 50,000 is requested.
    expect(calledUrls(fetchMock).map((u) => Number(param(u, 'skip')))).toEqual(
      range(0, 10).map((p) => p * 5000),
    );
    const [table] = await (await c.acquire(o.canvas_id, tenant())).describe();
    expect(table?.rowCount).toBe(MAX_CANVAS_ROWS);
  }, 60_000);
});

describe('fema_search_nfip — notice matrix', () => {
  type Kind =
    | 'none'
    | 'continuation'
    | 'past-end'
    | 'spill'
    | 'spill-capped'
    | 'no_results'
    | 'other error';
  const classify = (result: ContractResult): Kind => {
    if (result.isError) {
      const { error } = result.structuredContent as { error: { data?: { reason?: string } } };
      return error.data?.reason === 'no_results' ? 'no_results' : 'other error';
    }
    const notice = out(result).notice;
    if (notice === undefined) return 'none';
    if (notice.startsWith('Offset ')) return 'past-end';
    if (notice.startsWith('Returned ')) return 'continuation';
    if (notice.includes('canvas cap was reached')) return 'spill-capped';
    return 'spill';
  };

  interface Cell {
    canvas: boolean;
    heldCanvas?: boolean;
    input: Record<string, unknown>;
    kind: Kind;
    name: string;
    total: number;
  }

  const cells: Cell[] = [
    { name: 'disabled · empty', canvas: false, total: 0, input: {}, kind: 'no_results' },
    { name: 'disabled · fits · 0', canvas: false, total: 187, input: {}, kind: 'none' },
    {
      name: 'disabled · fits · mid',
      canvas: false,
      total: 187,
      input: { offset: 100 },
      kind: 'none',
    },
    {
      name: 'disabled · fits · past-end',
      canvas: false,
      total: 187,
      input: { offset: 187 },
      kind: 'past-end',
    },
    {
      name: 'disabled · limit cut · 0',
      canvas: false,
      total: 187,
      input: { limit: 50 },
      kind: 'continuation',
    },
    {
      name: 'disabled · limit cut · mid',
      canvas: false,
      total: 187,
      input: { limit: 50, offset: 50 },
      kind: 'continuation',
    },
    {
      name: 'disabled · budget cut · 0',
      canvas: false,
      total: 2000,
      input: {},
      kind: 'continuation',
    },
    {
      name: 'disabled · budget cut · mid',
      canvas: false,
      total: 2000,
      input: { offset: 900 },
      kind: 'continuation',
    },
    {
      name: 'disabled · budget cut · past-end',
      canvas: false,
      total: 2000,
      input: { offset: 2000 },
      kind: 'past-end',
    },
    {
      name: 'disabled · canvas_id · limit cut',
      canvas: false,
      total: 187,
      input: { limit: 50, canvas_id: 'Ab_012-xy9' },
      kind: 'continuation',
    },
    { name: 'enabled · empty', canvas: true, total: 0, input: {}, kind: 'no_results' },
    { name: 'enabled · fits · 0', canvas: true, total: 187, input: {}, kind: 'none' },
    {
      name: 'enabled · fits · 0 · limit cut',
      canvas: true,
      total: 187,
      input: { limit: 50 },
      kind: 'continuation',
    },
    {
      name: 'enabled · fits · mid',
      canvas: true,
      total: 187,
      input: { offset: 100 },
      kind: 'none',
    },
    {
      name: 'enabled · fits · past-end',
      canvas: true,
      total: 187,
      input: { offset: 187 },
      kind: 'past-end',
    },
    {
      name: 'enabled · fits · canvas_id',
      canvas: true,
      total: 187,
      input: { limit: 50 },
      kind: 'continuation',
      heldCanvas: true,
    },
    { name: 'enabled · overflows · 0', canvas: true, total: 6000, input: {}, kind: 'spill' },
    {
      name: 'enabled · overflows · mid',
      canvas: true,
      total: 6000,
      input: { offset: 100, limit: 10 },
      kind: 'continuation',
    },
    {
      name: 'enabled · overflows · mid · canvas_id',
      canvas: true,
      total: 6000,
      input: { offset: 100, limit: 10 },
      kind: 'continuation',
      heldCanvas: true,
    },
    {
      name: 'enabled · overflows · past-end',
      canvas: true,
      total: 6000,
      input: { offset: 6000 },
      kind: 'past-end',
    },
    {
      name: 'enabled · overflows · canvas_id',
      canvas: true,
      total: 6000,
      input: {},
      kind: 'spill',
      heldCanvas: true,
    },
    {
      name: 'enabled · capped · past-end',
      canvas: true,
      total: 93_589,
      input: { offset: 93_589 },
      kind: 'past-end',
    },
  ];

  it.each(cells)(
    '$name → $kind',
    async ({ canvas: enabled, total, input, kind, heldCanvas }) => {
      const c = enabled ? useCanvas() : undefined;
      const held = heldCanvas && c ? await c.acquire(undefined, tenant()) : undefined;
      fetchMock.mockImplementation(nfipMatch(total));
      const result = await search({ ...input, ...(held ? { canvas_id: held.canvasId } : {}) });
      expect(classify(result)).toBe(kind);

      const notice = out(result).notice ?? '';
      // A notice written for one arm never carries another arm's guidance.
      if (kind === 'continuation' || kind === 'past-end') {
        expect(notice).not.toMatch(/canvas|fema_dataframe/);
      }
      if (kind === 'spill' || kind === 'spill-capped') {
        expect(notice).not.toContain('continue with offset');
        expect(notice).not.toContain('past the end');
        if (held) expect(notice).toContain(`canvas_id "${held.canvasId}"`);
      }
      if (kind === 'continuation') {
        const offset = (input.offset as number | undefined) ?? 0;
        expect(notice).toContain(`continue with offset ${offset + out(result).returned_count}.`);
      }
      // A canvas exists only for a spill without a held canvas, or for the held one.
      if (c) {
        const minted = kind.startsWith('spill') && !held ? 1 : 0;
        expect(c.countForTenant(tenant())).toBe(minted + (held ? 1 : 0));
      }
    },
    20_000,
  );
});

describe('fema_search_nfip — definition text', () => {
  const shape = femaSearchNfip.output.shape;
  const claimShape = shape.claims.element.shape;

  it('documents every cause_of_damage dictionary code and passes other values through', () => {
    const d = claimShape.cause_of_damage.description ?? '';
    for (const code of ['0', '1', '2', '3', '4', '7', '8', '9', 'A', 'B', 'C', 'D']) {
      expect(d).toMatch(new RegExp(`(^|[\\s;:(])${code} `));
    }
    expect(d).toContain('tidal water overflow');
    expect(d).toContain('Other values pass through unchanged');
    expect(d).not.toContain('Flooding');
  });

  it('documents the legacy and Risk Rating 2.0 occupancy_type codes, 6 as non-residential business', () => {
    const d = claimShape.occupancy_type.description ?? '';
    const codes = ['1', '2', '3', '4', '6', '11', '12', '13', '14', '15', '16', '17', '18', '19'];
    for (const code of codes) {
      expect(d).toMatch(new RegExp(`(^|[\\s;:(])${code} `));
    }
    expect(d).toContain('6 non-residential business');
    expect(d).toContain('Risk Rating 2.0');
    expect(d).toContain('Other values pass through unchanged');
  });

  it('names fema_dataframe_describe before fema_dataframe_query wherever a canvas is handed out', () => {
    const texts = [
      femaSearchNfip.input.shape.canvas_id.description,
      shape.canvas_table.description,
      shape.spilled.description,
    ];
    for (const t of texts) {
      const d = t ?? '';
      expect(d).toContain('fema_dataframe_describe');
      expect(d).toContain('fema_dataframe_query');
      expect(d.indexOf('fema_dataframe_describe')).toBeLessThan(d.indexOf('fema_dataframe_query'));
    }
  });

  it('describes offset paging and the canvas table as the continuation of a spill', () => {
    const d =
      (femaSearchNfip.input.shape as Record<string, { description?: string }>).offset
        ?.description ?? '';
    expect(d).toContain('canvas table');
    expect((femaSearchNfip.input.parse({ state: 'TX' }) as { offset?: number }).offset).toBe(0);
    expect(() => femaSearchNfip.input.parse({ state: 'TX', offset: -1 })).toThrow();
    expect(() => femaSearchNfip.input.parse({ state: 'TX', offset: 1.5 })).toThrow();
  });

  it('describes total_count as the upstream match count', () => {
    expect(shape.total_count.description).toContain('before offset, limit, and the canvas row cap');
  });
});

describe('fema_search_nfip — raw codes', () => {
  it('passes cause_of_damage and occupancy_type codes through on both surfaces', async () => {
    fetchMock.mockImplementation(
      routeFetch([
        [
          NFIP_V3,
          () =>
            envelopeResponse(
              'NfipClaims',
              [
                { ...claim(0), causeOfDamage: 'B', occupancyType: 6 },
                { ...claim(1), causeOfDamage: '@', occupancyType: 18 },
              ],
              2,
              'v3',
            ),
        ],
      ]),
    );
    const result = await search({});
    expect(out(result).claims).toMatchObject([
      { cause_of_damage: 'B', occupancy_type: 6 },
      { cause_of_damage: '@', occupancy_type: 18 },
    ]);
    expect(text(result)).toContain('Cause: B | Occupancy: 6');
    expect(text(result)).toContain('Cause: @ | Occupancy: 18');
  });
});

describe('fema_search_nfip — input validation', () => {
  it('throws invalid_state for unknown state codes', async () => {
    const result = await search({ state: 'ZZ' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_state' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty or missing state at the Zod layer', () => {
    expect(() => femaSearchNfip.input.parse({ state: '' })).toThrow();
    expect(() => femaSearchNfip.input.parse({})).toThrow();
  });

  it('rejects a malformed zip_code at the Zod layer', () => {
    expect(() => femaSearchNfip.input.parse({ state: 'TX', zip_code: '1234' })).toThrow();
    expect(() => femaSearchNfip.input.parse({ state: 'TX', zip_code: 'abcde' })).toThrow();
    expect(() => femaSearchNfip.input.parse({ state: 'TX', zip_code: '77002' })).not.toThrow();
  });
});

describe('fema_search_nfip — format', () => {
  type FormatInput = Parameters<NonNullable<typeof femaSearchNfip.format>>[0];
  const render = (result: Record<string, unknown>) =>
    (femaSearchNfip.format!(result as FormatInput)[0] as { text: string }).text;

  it('formats inline claims with their fields', () => {
    const t = render({
      claims: [
        {
          state: 'TX',
          county_code: '48201',
          zip_code: '77002',
          date_of_loss: '2024-05-15T00:00:00.000Z',
          year_of_loss: 2024,
          rated_flood_zone: 'AE',
          cause_of_damage: '4',
          occupancy_type: 11,
          amount_paid_building: 50000,
          amount_paid_contents: 10000,
        },
      ],
      total_count: 5000,
      returned_count: 1,
      spilled: false,
    });
    expect(t).toContain('1 of 5000');
    expect(t).toContain('County: 48201');
    expect(t).toContain('Cause: 4');
    expect(t).toContain('Occupancy: 11');
    expect(t).toContain('50,000');
    expect(t).toContain('AE');
  });

  it('formats a spill with the canvas, the staged count, and describe before query', () => {
    const t = render({
      claims: [{ state: 'TX', year_of_loss: 2024, amount_paid_building: 50000 }],
      total_count: 5000,
      returned_count: 1,
      staged_count: 5000,
      canvas_id: 'Ab_012-xy9',
      canvas_table: 'spilled_abc123',
      spilled: true,
    });
    expect(t).toContain('Ab_012-xy9');
    expect(t).toContain('spilled_abc123');
    expect(t).toContain('**Staged rows:** 5000');
    expect(t.indexOf('fema_dataframe_describe')).toBeGreaterThan(-1);
    expect(t.indexOf('fema_dataframe_describe')).toBeLessThan(t.indexOf('fema_dataframe_query'));
  });

  it('formats a capped spill with the staged and matching counts', () => {
    const t = render({
      claims: [{ state: 'TX', year_of_loss: 2017, amount_paid_building: 50000 }],
      total_count: 93_589,
      returned_count: 1,
      staged_count: 50_000,
      canvas_id: 'Ab_012-xy9',
      canvas_table: 'spilled_abc123',
      spilled: true,
      truncated: true,
    });
    expect(t).toContain('the table holds 50000 of the 93589 matching claims');
  });

  it('formats an empty page past the end', () => {
    const t = render({ claims: [], total_count: 187, returned_count: 0, spilled: false });
    expect(t).toContain('0 of 187 NFIP claims');
    expect(t).toContain('_This page is empty: the offset is past the end of the matching claims._');
  });
});
