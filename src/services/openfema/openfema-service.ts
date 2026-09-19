/**
 * @fileoverview OpenFEMA API service — wraps the public OpenFEMA v2 REST API
 * with OData parameter encoding, response parsing, error classification, and retry logic.
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
      async ({ signal, remainingMs }) => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, Math.min(this.timeoutMs, remainingMs), ctx, {
            signal,
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
            (status === 400 &&
              (headers?.['content-type']?.includes('html') || isHtmlResponse(body)))
          ) {
            throw notFound(
              `Dataset "${dataset}" not found. Check the dataset name and verify it matches a valid OpenFEMA v2 entity name (e.g., FimaNfipClaims, DisasterDeclarationsSummaries).`,
              { reason: 'unknown_dataset', dataset, ...ctx.recoveryFor('unknown_dataset') },
            );
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
              const cleanMessage = /expected to be one of.*(?:Byte|Int16|SByte)/i.test(
                detail.message ?? '',
              )
                ? 'Disaster number is outside the valid FEMA range (1–32767).'
                : "Invalid OData $filter expression. String values must use single quotes; field names are case-sensitive. Example: state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'";
              throw validationError(cleanMessage, {
                reason: 'invalid_filter',
                code: detail.code,
                ...ctx.recoveryFor('invalid_filter'),
              });
            }
          }
          throw error;
        }

        const text = await response.text();
        if (response.headers.get('content-type')?.includes('html') || isHtmlResponse(text)) {
          throw notFound(
            `Dataset "${dataset}" not found. Check the dataset name and verify it matches a valid OpenFEMA v2 entity name (e.g., FimaNfipClaims, DisasterDeclarationsSummaries).`,
            { reason: 'unknown_dataset', dataset, ...ctx.recoveryFor('unknown_dataset') },
          );
        }

        let envelope: OpenFemaEnvelope;
        try {
          envelope = JSON.parse(text) as OpenFemaEnvelope;
        } catch {
          throw serviceUnavailable(
            'OpenFEMA returned non-JSON response — possible upstream error.',
            { dataset },
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
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: this.timeoutMs,
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
