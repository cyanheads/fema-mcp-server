/**
 * @fileoverview OpenFEMA API service — wraps the public OpenFEMA REST API with OData
 * parameter encoding, per-dataset API version resolution from the OpenFEMA dataset
 * catalog, response parsing, error classification, and retry logic.
 * @module services/openfema/openfema-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OpenFemaCatalogRow,
  OpenFemaEnvelope,
  OpenFemaErrorDetail,
  OpenFemaErrorResponse,
  OpenFemaQueryOptions,
  RawDisasterDeclaration,
  RawHousingAssistance,
  RawNfipClaim,
  RawPaProject,
} from './types.js';

/** How long a fetched dataset catalog is trusted before the next refresh. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed refresh, how long the previous catalog keeps serving before another attempt. */
const CATALOG_RETRY_MS = 5 * 60 * 1000;

/**
 * Escape a string value for embedding in an OData string literal (single-quoted).
 * OData 3 escapes a literal single quote as two consecutive single quotes ('').
 * Without this, user-supplied strings containing ' can break out of the literal
 * and alter the filter structure.
 */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Build encoded OData query string — uses %24 prefix for $ params (Akamai requirement). */
function buildODataQuery(opts: OpenFemaQueryOptions): string {
  const parts: string[] = [];
  // Always request inline count so we get real totals
  parts.push('%24inlinecount=allpages');
  if (opts.filter) parts.push(`%24filter=${encodeURIComponent(opts.filter)}`);
  if (opts.select) parts.push(`%24select=${encodeURIComponent(opts.select)}`);
  if (opts.orderby) parts.push(`%24orderby=${encodeURIComponent(opts.orderby)}`);
  if (opts.top !== undefined) parts.push(`%24top=${opts.top}`);
  if (opts.skip !== undefined) parts.push(`%24skip=${opts.skip}`);
  return parts.join('&');
}

/** Detect HTML response (Drupal 404 pages). */
function isHtmlResponse(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * The catalog endpoint. OpenFEMA serves it at v1, but the catalog lists itself as `DataSets`
 * (`/v1/DataSets`, which serves the same rows).
 */
const CATALOG_DATASET = 'OpenFemaDataSets';
const CATALOG_VERSION = 1;

/**
 * Map each catalog entry's `webService` path segment and its catalog `name` — OpenFEMA serves
 * both (`OpenFemaDataSetFields` and `DataSetFields`) — to the highest version the catalog lists.
 */
function buildVersionMap(rows: OpenFemaCatalogRow[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const { name, version, webService } of rows) {
    if (typeof webService !== 'string' || typeof version !== 'number') continue;
    if (!Number.isInteger(version) || version < 1) continue;
    const entity = webService
      .replace(/[?#].*$/, '')
      .split('/')
      .filter(Boolean)
      .pop();
    for (const key of [entity, typeof name === 'string' ? name : undefined]) {
      if (key && version > (versions.get(key) ?? 0)) versions.set(key, version);
    }
  }
  return versions;
}

function unknownDataset(dataset: string, ctx: Context, detail: string): McpError {
  return notFound(`Dataset "${dataset}" ${detail}`, {
    reason: 'unknown_dataset',
    dataset,
    ...ctx.recoveryFor('unknown_dataset'),
  });
}

/** Builds the error for an entity whose endpoint OpenFEMA answers with its 404 page. */
type MissingEndpoint = (entity: string, ctx: Context) => McpError;

/** A pinned or catalog entity with no endpoint. */
const notAtOpenFema: MissingEndpoint = (entity, ctx) =>
  unknownDataset(entity, ctx, 'was not found at OpenFEMA.');

/** A name the catalog lists (so `resolveVersion` accepted it) whose endpoint is absent. */
const notServed: MissingEndpoint = (dataset, ctx) =>
  notFound(
    `Dataset "${dataset}" is listed in the OpenFEMA dataset catalog, but OpenFEMA does not serve it through the API.`,
    { reason: 'dataset_not_served', dataset, ...ctx.recoveryFor('dataset_not_served') },
  );

// --- OpenFEMA 400 classification ---

type ODataParam = 'filter' | 'select' | 'orderby';
type ODataReason = 'invalid_filter' | 'invalid_select' | 'invalid_orderby' | 'invalid_odata_syntax';

const ODATA_PARAMS: readonly ODataParam[] = ['filter', 'select', 'orderby'];
const REASON_BY_PARAM: Record<ODataParam, ODataReason> = {
  filter: 'invalid_filter',
  select: 'invalid_select',
  orderby: 'invalid_orderby',
};

/** Value ranges of the OData integer types OpenFEMA names in type errors. */
const INTEGER_RANGES: Record<string, readonly [min: number, max: number]> = {
  SByte: [-128, 127],
  Byte: [0, 255],
  Int16: [-32_768, 32_767],
  Int32: [-2_147_483_648, 2_147_483_647],
  Int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** `Invalid data type of: <sent> for "<Entity>"."<field>" expected to be one of [<types>]` */
const TYPE_ERROR =
  /Invalid data type of: (\w+) for "[^"]*"\."([^"]+)" expected to be one of \[([^\]]*)\]/;
/** `Invalid date for "<Entity>"."<field>"`, `Invalid UUID for …` — a quoted value the field cannot read. */
const UNREADABLE_VALUE = /Invalid (\w+) for "[^"]*"\."([^"]+)"/;
const UNKNOWN_FIELD = /field "([^"]+)" not found/i;
const FRACTIONAL = /Decimal|Double|Single/;

type FieldKind = 'date' | 'guid' | 'text' | 'boolean' | 'integer' | 'number';

const HOW_TO_COMPARE: Record<FieldKind, string> = {
  date: "holds dates — compare it with a quoted ISO 8601 timestamp such as '2024-01-01T00:00:00.000Z'",
  guid: 'holds GUIDs — compare it with a quoted GUID',
  text: 'holds text — put the value in single quotes',
  boolean: 'holds true/false — compare it with unquoted true or false',
  integer: 'holds whole numbers — compare it with an unquoted number with no decimal places',
  number: 'holds numbers — compare it with an unquoted number',
};

/** What a field holds, from the OData types OpenFEMA says it accepts — the most specific type wins. */
function fieldKind(accepted: string[]): FieldKind | undefined {
  if (accepted.some((type) => type.startsWith('Date'))) return 'date';
  if (accepted.includes('Guid')) return 'guid';
  if (accepted.includes('String')) return 'text';
  if (accepted.includes('Boolean')) return 'boolean';
  if (accepted.some((type) => FRACTIONAL.test(type))) return 'number';
  if (accepted.some((type) => INTEGER_RANGES[type])) return 'integer';
  return;
}

/** Message for a `$filter` value whose type the field rejects — an out-of-range integer or a mismatched type. */
function filterTypeMessage(sent: string, field: string, accepted: string[]): string {
  const kind = fieldKind(accepted);
  const sentRange = INTEGER_RANGES[sent];
  const acceptedRanges = accepted.flatMap((type) => {
    const range = INTEGER_RANGES[type];
    return range ? [range] : [];
  });
  if (sentRange && acceptedRanges.length > 0 && (kind === 'integer' || kind === 'number')) {
    const min = Math.min(...acceptedRanges.map(([lo]) => lo));
    const max = Math.max(...acceptedRanges.map(([, hi]) => hi));
    if (sentRange[1] > max) {
      return field === 'disasterNumber'
        ? 'Disaster number is outside the valid FEMA range (1–32767).'
        : `Invalid filter: the number compared with "${field}" is outside the range that field holds (${min} to ${max}).`;
    }
  }
  const lead = `Invalid filter: the value compared with "${field}" has the wrong type.`;
  return kind ? `${lead} "${field}" ${HOW_TO_COMPARE[kind]}.` : lead;
}

/** Message for a quoted `$filter` value OpenFEMA could not read as the field's type. */
function unreadableValueMessage(what: string, field: string): string {
  const lead = `Invalid filter: OpenFEMA could not read the value compared with "${field}".`;
  const kind = /^date/i.test(what) ? 'date' : /^(uuid|guid)$/i.test(what) ? 'guid' : undefined;
  return kind ? `${lead} "${field}" ${HOW_TO_COMPARE[kind]}.` : lead;
}

/**
 * Classify an OpenFEMA JSON 400 by the clause its `type` names. Messages are built
 * from the parameter and field names alone — upstream text (parse offsets, OData
 * type names) never reaches the caller. An untyped parser error is attributed to
 * the only expression supplied, or reported as `invalid_odata_syntax` when several were.
 */
function classifyODataError(
  detail: OpenFemaErrorDetail,
  opts: OpenFemaQueryOptions,
  dataset: string,
): { reason: ODataReason; message: string } {
  const clause = /\$(filter|select|orderby)\b/i.exec(detail.type ?? '')?.[1]?.toLowerCase() as
    | ODataParam
    | undefined;

  if (!clause) {
    const supplied = ODATA_PARAMS.filter((param) => opts[param]);
    const [only] = supplied;
    if (only && supplied.length === 1) {
      const what = only === 'select' ? 'field list' : 'expression';
      return {
        reason: REASON_BY_PARAM[only],
        message: `Invalid ${only}: OpenFEMA could not parse the ${what}.`,
      };
    }
    return {
      reason: 'invalid_odata_syntax',
      message:
        supplied.length > 0
          ? `Invalid OData syntax: OpenFEMA could not parse one of ${supplied.join(', ')} and did not say which.`
          : 'Invalid OData syntax: OpenFEMA could not parse the request.',
    };
  }

  const reason = REASON_BY_PARAM[clause];
  const text = detail.message ?? '';
  const unknownField = UNKNOWN_FIELD.exec(text)?.[1];
  if (unknownField) {
    const tail =
      clause === 'filter'
        ? 'Field names are case-sensitive, and a string value without single quotes is read as a field name.'
        : 'Field names are case-sensitive.';
    return {
      reason,
      message: `Invalid ${clause}: field "${unknownField}" does not exist in ${dataset}. ${tail}`,
    };
  }
  if (clause === 'filter') {
    const typeError = TYPE_ERROR.exec(text);
    if (typeError) {
      const [, sent = '', field = '', accepted = ''] = typeError;
      const types = accepted.split(',').map((type) => type.trim());
      return { reason, message: filterTypeMessage(sent, field, types) };
    }
    const unreadable = UNREADABLE_VALUE.exec(text);
    if (unreadable) {
      const [, what = '', field = ''] = unreadable;
      return { reason, message: unreadableValueMessage(what, field) };
    }
  }
  return { reason, message: `Invalid ${clause}: OpenFEMA rejected the expression.` };
}

// --- Service ---

export class OpenFemaService {
  /** API root without a version segment, e.g. `https://www.fema.gov/api/open`. */
  private readonly apiRoot: string;
  private readonly timeoutMs: number;
  private catalog: { versions: ReadonlyMap<string, number>; expiresAt: number } | undefined;
  private catalogRefresh: Promise<ReadonlyMap<string, number>> | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    const srv = getServerConfig();
    this.apiRoot = srv.baseUrl;
    this.timeoutMs = srv.requestTimeoutMs;
  }

  /**
   * Fetch a page from any OpenFEMA dataset, at the API version the OpenFEMA dataset
   * catalog lists for it. Returns the data array and total count from the response envelope.
   */
  async fetchDataset<T>(
    dataset: string,
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: T[]; count: number }> {
    const version = await this.resolveVersion(dataset, ctx);
    // The catalog lists itself only as `DataSets`, so its `OpenFemaDataSets` alias is no listed name.
    const missing = dataset === CATALOG_DATASET ? notAtOpenFema : notServed;
    return this.request<T>(dataset, version, opts, ctx, missing);
  }

  /** Fetch disaster declaration summaries. */
  fetchDisasters(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawDisasterDeclaration[]; count: number }> {
    return this.request<RawDisasterDeclaration>('DisasterDeclarationsSummaries', 2, opts, ctx);
  }

  /** Fetch public assistance funded project details. */
  fetchPaProjects(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawPaProject[]; count: number }> {
    return this.request<RawPaProject>('PublicAssistanceFundedProjectsDetails', 2, opts, ctx);
  }

  /** Fetch housing assistance — owners or renters. */
  fetchHousingAssistance(
    dataset: 'HousingAssistanceOwners' | 'HousingAssistanceRenters',
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawHousingAssistance[]; count: number }> {
    return this.request<RawHousingAssistance>(dataset, 2, opts, ctx);
  }

  /** Fetch NFIP redacted claims (`NfipClaims` v3). */
  fetchNfipClaims(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawNfipClaim[]; count: number }> {
    return this.request<RawNfipClaim>('NfipClaims', 3, opts, ctx);
  }

  /**
   * Resolve a dataset's API version from the catalog, by `webService` path segment or catalog
   * `name`; an unlisted name is `unknown_dataset`.
   */
  private async resolveVersion(dataset: string, ctx: Context): Promise<number> {
    let versions: ReadonlyMap<string, number>;
    try {
      versions = await this.datasetVersions(ctx);
    } catch (error) {
      throw serviceUnavailable(
        `The OpenFEMA dataset catalog could not be read, so the API version for "${dataset}" is unknown.`,
        { reason: 'catalog_unavailable', dataset, ...ctx.recoveryFor('catalog_unavailable') },
        { cause: error },
      );
    }
    const version = versions.get(dataset);
    if (version !== undefined) return version;
    const lower = dataset.toLowerCase();
    const suggestion = [...versions.keys()].find((name) => name.toLowerCase() === lower);
    throw unknownDataset(
      dataset,
      ctx,
      suggestion
        ? `is not in the OpenFEMA dataset catalog. Did you mean "${suggestion}"? Names are case-sensitive.`
        : 'is not in the OpenFEMA dataset catalog. Names are case-sensitive (e.g., NfipClaims, DisasterDeclarationsSummaries).',
    );
  }

  /** The cached catalog map, refreshed when stale; concurrent callers share one in-flight refresh. */
  private datasetVersions(ctx: Context): Promise<ReadonlyMap<string, number>> {
    if (this.catalog && Date.now() < this.catalog.expiresAt) {
      return Promise.resolve(this.catalog.versions);
    }
    this.catalogRefresh ??= this.refreshCatalog(ctx).finally(() => {
      this.catalogRefresh = undefined;
    });
    return this.catalogRefresh;
  }

  /**
   * One catalog request — no retries, and not bound to any one caller's cancellation,
   * since other callers may be awaiting it. A failure falls back to the previous map
   * (retried after a short backoff) and rethrows only when no map exists yet.
   */
  private async refreshCatalog(ctx: Context): Promise<ReadonlyMap<string, number>> {
    try {
      const { rows } = await this.exchange<OpenFemaCatalogRow>(
        CATALOG_DATASET,
        CATALOG_VERSION,
        { select: 'name,version,webService', top: 1000 },
        ctx,
        { timeoutMs: this.timeoutMs, missing: notAtOpenFema },
      );
      const versions = buildVersionMap(rows);
      if (versions.size === 0) {
        throw serviceUnavailable('The OpenFEMA dataset catalog listed no usable datasets.');
      }
      if (!versions.has(CATALOG_DATASET)) versions.set(CATALOG_DATASET, CATALOG_VERSION);
      this.catalog = { versions, expiresAt: Date.now() + CATALOG_TTL_MS };
      ctx.log.debug('OpenFEMA dataset catalog refreshed', { datasets: versions.size });
      return versions;
    } catch (error) {
      if (!this.catalog) throw error;
      this.catalog = { versions: this.catalog.versions, expiresAt: Date.now() + CATALOG_RETRY_MS };
      ctx.log.warning('OpenFEMA dataset catalog refresh failed; reusing the previous catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.catalog.versions;
    }
  }

  /**
   * Fetch one page of `entity` at `version`, retrying transient failures within the request
   * budget. `missing` builds the error for an endpoint OpenFEMA answers with its 404 page.
   */
  private request<T>(
    entity: string,
    version: number,
    opts: OpenFemaQueryOptions,
    ctx: Context,
    missing: MissingEndpoint = notAtOpenFema,
  ): Promise<{ rows: T[]; count: number }> {
    return withRetry(
      ({ signal, remainingMs }) =>
        this.exchange<T>(entity, version, opts, ctx, {
          signal,
          timeoutMs: Math.min(this.timeoutMs, remainingMs),
          missing,
        }),
      {
        operation: `OpenFemaService.request(${entity} v${version})`,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: this.timeoutMs,
      },
    );
  }

  /** One HTTP exchange: fetch, classify OpenFEMA error shapes, and parse the envelope. */
  private async exchange<T>(
    entity: string,
    version: number,
    opts: OpenFemaQueryOptions,
    ctx: Context,
    {
      signal,
      timeoutMs,
      missing,
    }: { signal?: AbortSignal; timeoutMs: number; missing: MissingEndpoint },
  ): Promise<{ rows: T[]; count: number }> {
    const url = `${this.apiRoot}/v${version}/${entity}?${buildODataQuery(opts)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, timeoutMs, ctx, {
        ...(signal ? { signal } : {}),
        expectedStatuses: [400, 404],
        errorHeaders: ['content-type'],
      });
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      const status = error.data?.status;
      const body = typeof error.data?.body === 'string' ? error.data.body : '';
      const headers = error.data?.headers as Record<string, string> | undefined;
      if (
        status === 404 ||
        (status === 400 && (headers?.['content-type']?.includes('html') || isHtmlResponse(body)))
      ) {
        throw missing(entity, ctx);
      }
      if (status === 400) {
        let parsed: OpenFemaErrorResponse | undefined;
        try {
          parsed = JSON.parse(body) as OpenFemaErrorResponse;
        } catch {
          /* Non-JSON errors retain the framework classification. */
        }
        const detail = parsed?.error?.[0];
        if (detail) {
          const { reason, message } = classifyODataError(detail, opts, entity);
          throw validationError(message, {
            reason,
            ...(detail.code ? { code: detail.code } : {}),
            ...ctx.recoveryFor(reason),
          });
        }
      }
      throw error;
    }

    const text = await response.text();
    if (response.headers.get('content-type')?.includes('html') || isHtmlResponse(text)) {
      throw missing(entity, ctx);
    }

    let envelope: OpenFemaEnvelope;
    try {
      envelope = JSON.parse(text) as OpenFemaEnvelope;
    } catch {
      throw serviceUnavailable('OpenFEMA returned non-JSON response — possible upstream error.', {
        dataset: entity,
      });
    }

    // Data array is keyed by the entity name (e.g. "DisasterDeclarationsSummaries")
    const rows = (envelope[entity] as T[] | undefined) ?? [];
    // count is in envelope.metadata.count when $inlinecount=allpages is sent
    const count =
      typeof envelope.metadata?.count === 'number' ? envelope.metadata.count : rows.length;

    ctx.log.debug('OpenFEMA fetch complete', {
      dataset: entity,
      version,
      count,
      rows: rows.length,
    });
    return { rows, count };
  }
}

// --- Init/accessor pattern ---

let _service: OpenFemaService | undefined;

export function initOpenFemaService(config: AppConfig, storage: StorageService): void {
  _service = new OpenFemaService(config, storage);
}

export function getOpenFemaService(): OpenFemaService {
  if (!_service) {
    throw new Error('OpenFemaService not initialized — call initOpenFemaService() in setup()');
  }
  return _service;
}
