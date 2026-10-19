/**
 * @fileoverview Complete-source and atomic-publication tests for the vocabulary generator.
 * @module tests/services/name-vocabulary-build.test
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNameVocabulary } from '../../scripts/build-name-vocabulary.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));

const DDS = 'DisasterDeclarationsSummaries';
const PA = 'PublicAssistanceFundedProjectsDetails';
const response = (entity: string, rows: unknown[], count = rows.length) =>
  Response.json({
    metadata: { count },
    [entity]: rows,
  });
let directory: string;
let output: string;

beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'fema-vocabulary-test-'));
  output = join(directory, 'snapshot.ts');
  writeFileSync(output, 'good snapshot');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true });
});

/** Settle the generator's paced requests without waiting on wall-clock backoff. */
async function finish(pending: Promise<void>) {
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  return outcome;
}

describe('vocabulary build', () => {
  it.each(['I/O', 'backoff'])(
    'stops stalled %s at the source deadline without publishing or retrying',
    async (phase) => {
      const sourceDeadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) =>
          ms === 360_000 ? sourceDeadline.signal : new AbortController().signal,
        );
      const fetchMock = vi.fn((_url: string, options: RequestInit) =>
        phase === 'backoff'
          ? Promise.resolve(new Response('down', { status: 503 }))
          : new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              });
            }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const outcome = buildNameVocabulary(output).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      sourceDeadline.abort(new DOMException('Source deadline exceeded', 'TimeoutError'));
      expect(await outcome).toMatchObject({
        name: 'TimeoutError',
        message: 'Source deadline exceeded',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([480_000, 360_000]);
      expect(readFileSync(output, 'utf8')).toBe('good snapshot');
    },
  );

  it('keeps the snapshot when formatting the complete download fails', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes(DDS)
            ? response(DDS, [{ designatedArea: 'Harris', incidentType: 'Flood' }])
            : response(PA, [{ county: 'Harris' }]),
        ),
      ),
    );
    expect(await finish(buildNameVocabulary(output))).toMatchObject({
      message: 'Vocabulary formatting failed; snapshot unchanged.',
    });
    expect(readFileSync(output, 'utf8')).toBe('good snapshot');
    expect(readdirSync(directory)).toEqual(['snapshot.ts']);
  });

  it('publishes complete sequential exports with declaration ordering and exact PA strings', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(DDS))
          return Promise.resolve(
            response(DDS, [{ designatedArea: 'Harris (County)', incidentType: 'Flood' }]),
          );
        return Promise.resolve(
          response(PA, [
            ...Array.from({ length: 10_000 }, () => ({ county: 'LaSalle Parish' })),
            { county: 'Chugach REAA' },
          ]),
        );
      }),
    );
    expect(await finish(buildNameVocabulary(output))).toBeUndefined();
    const source = readFileSync(output, 'utf8');
    expect(source).toContain('PA_COUNTIES');
    expect(source).toContain('LaSalle Parish');
    expect(source).toContain('Chugach REAA');
    expect(source).toContain('10,001 nonnull-county PublicAssistanceFundedProjectsDetails');
    expect(urls).toHaveLength(2);
    expect(urls.map((url) => new URL(url).searchParams.get('$orderby'))).toEqual(['id', null]);
    for (const url of urls) {
      expect(new URL(url).searchParams.get('$allrecords')).toBe('true');
      expect(new URL(url).searchParams.has('$top')).toBe(false);
    }
    expect(new URL(urls[1] ?? '').searchParams.get('$filter')).toBe('county ne null');
  });

  it.each([
    ['missing-count', /Invalid PublicAssistanceFundedProjectsDetails envelope/],
    ['short-page', /Incomplete PublicAssistanceFundedProjectsDetails: read 1 of 10002 rows/],
    ['invalid-row', /Invalid PublicAssistanceFundedProjectsDetails row/],
    ['invalid-name', /Invalid PublicAssistanceFundedProjectsDetails name field/],
    ['malformed-json', /JSON/],
    ['length-changing-name', /changes length when lowercased/],
    ['http501', /HTTP 501/],
    ['http400', /HTTP 400/],
    ['persistent503', /HTTP 503/],
  ])('keeps the previous snapshot after %s', async (failure, message) => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes(DDS))
          return Promise.resolve(
            response(DDS, [{ designatedArea: 'Harris', incidentType: 'Flood' }]),
          );
        calls++;
        if (failure === 'http400') return Promise.resolve(new Response('bad', { status: 400 }));
        if (failure === 'http501')
          return Promise.resolve(new Response('unsupported', { status: 501 }));
        if (failure === 'malformed-json') return Promise.resolve(new Response('{'));
        if (failure === 'length-changing-name')
          return Promise.resolve(response(PA, [{ county: 'İ' }]));
        if (failure === 'persistent503')
          return Promise.resolve(new Response('down', { status: 503 }));
        if (failure === 'missing-count')
          return Promise.resolve(Response.json({ [PA]: [{ county: 'Harris' }] }));
        if (failure === 'invalid-name') return Promise.resolve(response(PA, [{ county: 42 }]));
        if (failure === 'invalid-row')
          return Promise.resolve(
            Response.json({
              metadata: { count: 2 },
              [PA]: [null, null],
            }),
          );
        return Promise.resolve(response(PA, [{ county: 'Harris' }], 10_002));
      }),
    );
    const error = await finish(buildNameVocabulary(output));
    expect(error).toMatchObject({ message: expect.stringMatching(message) });
    expect(readFileSync(output, 'utf8')).toBe('good snapshot');
    expect(readdirSync(directory)).toEqual(['snapshot.ts']);
    expect(calls).toBe(failure === 'persistent503' ? 3 : 1);
  });

  it.each([429, 503, 'transport'] as const)(
    'retries transient %s and completes without restarting the first source',
    async (failure) => {
      let calls = 0;
      const fetchMock = vi.fn((url: string) => {
        if (url.includes(DDS))
          return Promise.resolve(
            response(DDS, [{ designatedArea: 'Harris', incidentType: 'Flood' }]),
          );
        calls++;
        if (calls === 1)
          return failure === 'transport'
            ? Promise.reject(new TypeError('network'))
            : Promise.resolve(new Response('retry', { status: failure }));
        return Promise.resolve(response(PA, [{ county: 'LaSalle Parish' }]));
      });
      vi.stubGlobal('fetch', fetchMock);
      expect(await finish(buildNameVocabulary(output))).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(readFileSync(output, 'utf8')).toContain('LaSalle Parish');
    },
  );
});
