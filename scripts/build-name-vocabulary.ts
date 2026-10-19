#!/usr/bin/env bun
/**
 * @fileoverview Regenerate `src/services/openfema/name-vocabulary.ts` — the snapshot of
 * stored declaration `designatedArea` / `incidentType` and PA `county` strings the matcher
 * resolves caller input against.
 *
 * Downloads both complete v2 name sources sequentially, with bounded transient retries
 * and strict completeness checks. PA excludes null counties, which contribute no name. It
 * collects the distinct values, and writes them sorted with the run's UTC date as the
 * as-of date. A formatted temporary file replaces the snapshot only after both sources pass.
 *
 * Run it when OpenFEMA adds names the snapshot lacks: `bun run vocabulary:build`.
 *
 * @module scripts/build-name-vocabulary
 */

import { spawnSync } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ENDPOINT = 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries';
const PA_ENDPOINT = 'https://www.fema.gov/api/open/v2/PublicAssistanceFundedProjectsDetails';
const OUTPUT = resolve('src/services/openfema/name-vocabulary.ts');

interface Row {
  county?: string;
  designatedArea?: string;
  incidentType?: string;
}

interface Page {
  DisasterDeclarationsSummaries?: Row[];
  metadata?: { count?: number };
  PublicAssistanceFundedProjectsDetails?: Row[];
}

/** Pace source reads and retries without sleeping past their deadline. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      done();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Complete selected source, with three transient attempts sharing one six-minute deadline. */
async function fetchSource(
  endpoint: string,
  select: string,
  orderby: string,
  signal: AbortSignal,
): Promise<Page> {
  const parts = [
    '%24inlinecount=allpages',
    `%24select=${encodeURIComponent(select)}`,
    ...(orderby ? [`%24orderby=${orderby}`] : []),
    '%24format=json',
    '%24allrecords=true',
    ...(endpoint === PA_ENDPOINT ? ['%24filter=county%20ne%20null'] : []),
  ];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]);
  for (let attempt = 0; ; attempt++) {
    deadline.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${endpoint}?${parts.join('&')}`, { signal: deadline });
      if (response.ok) return (await response.json()) as Page;
    } catch (error) {
      deadline.throwIfAborted();
      if (attempt === 2 || error instanceof SyntaxError) throw error;
      await sleep(1000 * (attempt + 1), deadline);
      continue;
    }
    await response.body?.cancel();
    if (attempt === 2 || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`OpenFEMA returned HTTP ${response.status} while downloading ${endpoint}.`);
    }
    if (response.status >= 500) {
      const first = parts.shift();
      if (first !== undefined) parts.push(first);
    }
    await sleep(1000 * (attempt + 1), deadline);
  }
}

/** Read both sources completely before atomically publishing their formatted vocabulary. */
export async function buildNameVocabulary(output = OUTPUT): Promise<void> {
  const signal = AbortSignal.timeout(8 * 60_000);
  const areas = new Set<string>();
  const incidentTypes = new Set<string>();
  const counties = new Set<string>();
  const counts: number[] = [];
  for (const [endpoint, select, orderby, entity] of [
    [ENDPOINT, 'designatedArea,incidentType', 'id', 'DisasterDeclarationsSummaries'],
    [PA_ENDPOINT, 'county', '', 'PublicAssistanceFundedProjectsDetails'],
  ] as const) {
    signal.throwIfAborted();
    if (counts.length > 0) await sleep(1000, signal);
    const page = await fetchSource(endpoint, select, orderby, signal);
    const rows = page[entity];
    const count = page.metadata?.count;
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      !Array.isArray(rows)
    ) {
      throw new Error(`Invalid ${entity} envelope; refusing to write a partial vocabulary.`);
    }
    if (rows.length !== count) {
      throw new Error(
        `Incomplete ${entity}: read ${rows.length} of ${count} rows; refusing to write a partial vocabulary.`,
      );
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error(`Invalid ${entity} row.`);
      for (const [value, target] of [
        [row.designatedArea, areas],
        [row.incidentType, incidentTypes],
        [row.county, counties],
      ] as const) {
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') throw new Error(`Invalid ${entity} name field.`);
        if (value.trim()) target.add(value);
      }
    }
    console.log(
      `  ${entity}: read ${rows.length.toLocaleString('en-US')} of ${count.toLocaleString('en-US')} rows`,
    );
    counts.push(rows.length);
  }
  if (!areas.size || !incidentTypes.size || !counties.size)
    throw new Error('A vocabulary source contained no names; refusing to replace the snapshot.');

  /**
   * The matcher maps a match in a lowercased value back to the stored value by position, which
   * holds only when lowercasing keeps every value's length, checked for both sources here.
   */
  for (const value of [...areas, ...incidentTypes, ...counties]) {
    if (value.toLowerCase().length !== value.length) {
      throw new Error(`"${value}" changes length when lowercased; the matcher cannot index it.`);
    }
  }

  const sorted = (values: Set<string>) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const list = (values: Set<string>) =>
    sorted(values)
      .map((value) => `  ${JSON.stringify(value)},`)
      .join('\n');
  const asOf = new Date().toISOString().slice(0, 10);

  const temporary = `${output}.${process.pid}.tmp.ts`;
  try {
    writeFileSync(
      temporary,
      `/**
 * @fileoverview Snapshot of OpenFEMA names read on ${asOf}: all ${counts[0]?.toLocaleString('en-US')} declaration rows
 * and ${counts[1]?.toLocaleString('en-US')} nonnull-county PublicAssistanceFundedProjectsDetails rows (v2). Generated by
 * \`bun run vocabulary:build\` (scripts/build-name-vocabulary.ts) — do not edit by hand.
 * @module services/openfema/name-vocabulary
 */

/** UTC date the snapshot was read from OpenFEMA. */
export const VOCABULARY_AS_OF = '${asOf}';

/** Every distinct \`incidentType\` value (${incidentTypes.size}). */
export const INCIDENT_TYPES: readonly string[] = [
${list(incidentTypes)}
];

/** Every distinct \`designatedArea\` value (${areas.size}) — county, parish, municipio, and other area names. */
export const DESIGNATED_AREAS: readonly string[] = [
${list(areas)}
];

/** Every distinct nonblank PA \`county\` value (${counties.size}). */
export const PA_COUNTIES: readonly string[] = [
${list(counties)}
];
`,
    );

    const format = spawnSync('bunx', ['biome', 'format', '--write', temporary], {
      stdio: 'inherit',
      timeout: 30_000,
    });
    if (format.status !== 0) throw new Error('Vocabulary formatting failed; snapshot unchanged.');
    signal.throwIfAborted();
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(
    `Wrote ${output}: ${incidentTypes.size} incident types, ${areas.size} designated areas, ${counties.size} PA counties (as of ${asOf}).`,
  );
}

if (import.meta.main) await buildNameVocabulary();
