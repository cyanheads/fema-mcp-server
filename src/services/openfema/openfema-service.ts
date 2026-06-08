/**
 * @fileoverview OpenFEMA API service — wraps the public OpenFEMA v2 REST API
 * with OData parameter encoding, response parsing, error classification, and retry logic.
 * @module services/openfema/openfema-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OpenFemaEnvelope,
  OpenFemaErrorResponse,
  OpenFemaQueryOptions,
  RawDisasterDeclaration,
  RawHousingAssistance,
  RawNfipClaim,
  RawPaProject,
} from './types.js';

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

export class OpenFemaService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const srv = getServerConfig();
    this.baseUrl = srv.baseUrl;
    this.timeoutMs = srv.requestTimeoutMs;
  }

  /**
   * Fetch a page from any OpenFEMA dataset.
   * Returns the data array and total count from the response envelope.
   */
  fetchDataset<T>(
    dataset: string,
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: T[]; count: number }> {
    const qs = buildODataQuery(opts);
    const url = `${this.baseUrl}/${dataset}?${qs}`;

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        // Combine the request abort signal with the timeout signal
        const signal =
          ctx.signal &&
          typeof (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any ===
            'function'
            ? (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any([
                ctx.signal,
                controller.signal,
              ])
            : controller.signal;

        let response: Response;
        try {
          response = await fetch(url, { signal });
        } finally {
          clearTimeout(timeoutId);
        }

        // HTML content-type = unknown dataset (Drupal 404)
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html') || (!response.ok && contentType.includes('html'))) {
          throw notFound(
            `Dataset "${dataset}" not found — API returned HTML instead of JSON. Check the dataset name.`,
            { reason: 'unknown_dataset', dataset },
          );
        }

        const text = await response.text();

        // Body HTML check as fallback (some error pages send application/json content-type)
        if (isHtmlResponse(text)) {
          throw notFound(
            `Dataset "${dataset}" not found — API returned HTML instead of JSON. Check the dataset name.`,
            { reason: 'unknown_dataset', dataset },
          );
        }

        if (!response.ok) {
          // Parse structured FEMA error response
          try {
            const errBody = JSON.parse(text) as OpenFemaErrorResponse;
            if (errBody.error?.[0]) {
              const e = errBody.error[0];
              if (response.status === 400) {
                // Sanitize the API error before surfacing it. The raw message may contain
                // internal parser offsets ("at 469"), undefined error codes, and schema
                // type details (Int16, Byte) that are not actionable for callers. Produce
                // a clean message based on the error pattern.
                const rawMsg = e.message ?? '';
                const cleanMessage = /expected to be one of.*(?:Byte|Int16|SByte)/i.test(rawMsg)
                  ? 'Disaster number is outside the valid FEMA range (1–32767).'
                  : "Invalid OData $filter expression. String values must use single quotes; field names are case-sensitive. Example: state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'";
                throw validationError(cleanMessage, {
                  reason: 'invalid_filter',
                  code: e.code,
                  name: e.name,
                });
              }
              throw serviceUnavailable(`OpenFEMA API error [${e.code}]: ${e.message}`, {
                status: response.status,
              });
            }
          } catch (parseErr) {
            // Re-throw if it's already a classified McpError
            if (parseErr instanceof Error && 'code' in parseErr) throw parseErr;
          }
          throw serviceUnavailable(
            `OpenFEMA API returned HTTP ${response.status} for dataset "${dataset}".`,
            { status: response.status, url },
          );
        }

        let envelope: OpenFemaEnvelope;
        try {
          envelope = JSON.parse(text) as OpenFemaEnvelope;
        } catch {
          throw serviceUnavailable(
            'OpenFEMA returned non-JSON response — possible upstream error.',
            { url },
          );
        }

        // Data array is keyed by entityName (e.g. "DisasterDeclarationsSummaries")
        const rows = (envelope[dataset] as T[] | undefined) ?? [];
        // count is in envelope.metadata.count when $inlinecount=allpages is sent
        const count =
          typeof envelope.metadata?.count === 'number' ? envelope.metadata.count : rows.length;

        ctx.log.debug('OpenFEMA fetch complete', { dataset, count, rows: rows.length });
        return { rows, count };
      },
      {
        operation: `OpenFemaService.fetchDataset(${dataset})`,
        // Context is safe to pass — the retry helper strips non-serializable fields before logging.
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch disaster declaration summaries. */
  fetchDisasters(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawDisasterDeclaration[]; count: number }> {
    return this.fetchDataset<RawDisasterDeclaration>('DisasterDeclarationsSummaries', opts, ctx);
  }

  /** Fetch public assistance funded project details. */
  fetchPaProjects(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawPaProject[]; count: number }> {
    return this.fetchDataset<RawPaProject>('PublicAssistanceFundedProjectsDetails', opts, ctx);
  }

  /** Fetch housing assistance — owners or renters. */
  fetchHousingAssistance(
    dataset: 'HousingAssistanceOwners' | 'HousingAssistanceRenters',
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawHousingAssistance[]; count: number }> {
    return this.fetchDataset<RawHousingAssistance>(dataset, opts, ctx);
  }

  /** Fetch NFIP claims. */
  fetchNfipClaims(
    opts: OpenFemaQueryOptions,
    ctx: Context,
  ): Promise<{ rows: RawNfipClaim[]; count: number }> {
    return this.fetchDataset<RawNfipClaim>('FimaNfipClaims', opts, ctx);
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
