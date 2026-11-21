/**
 * Request-scoped composite-key join for Public Assistance projects and applicants.
 * @module services/openfema/pa-applicant-names
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeODataString, type OpenFemaService } from './openfema-service.js';
import type { RawPaProject } from './types.js';

const LOOKUP_BUDGET_MS = 8_000;
// Leave room for the endpoint and other parameters under OpenFEMA's CDN URL limit.
const ENCODED_FILTER_LIMIT = 6_500;
// Bound the depth of the upstream filter parser on a state-wide page.
const MAX_DISASTER_GROUPS = 16;
const PAGE_SIZE = 250;

function applicantKey({ disasterNumber, applicantId }: RawPaProject): string | undefined {
  if (
    disasterNumber === undefined ||
    !Number.isInteger(disasterNumber) ||
    disasterNumber < 1 ||
    disasterNumber > 32767 ||
    typeof applicantId !== 'string' ||
    !applicantId.trim() ||
    !applicantId.isWellFormed()
  )
    return undefined;
  return `${disasterNumber}:${applicantId}`;
}

function* filters(groups: Map<number, string[]>): Generator<string> {
  let terms: string[] = [];
  for (const [disasterNumber, ids] of groups) {
    let members: string[] = [];
    const term = (values: string[]) => applicantTerm(disasterNumber, values);
    for (const id of ids) {
      const candidate = [...terms, term([...members, id])].join(' or ');
      if (
        terms.length === MAX_DISASTER_GROUPS ||
        encodeURIComponent(candidate).length > ENCODED_FILTER_LIMIT
      ) {
        yield (members.length > 0 ? [...terms, term(members)] : terms).join(' or ');
        terms = [];
        members = [];
      }
      members.push(id);
    }
    if (members.length > 0) terms.push(term(members));
  }
  if (terms.length > 0) yield terms.join(' or ');
}

function applicantTerm(disasterNumber: number, members: string[]): string {
  return `(disasterNumber eq ${disasterNumber} and applicantId in (${members.join(',')}))`;
}

/** Reuse names and misses throughout a tool call, including pages drained for DataCanvas. */
export function paApplicantNames(
  service: OpenFemaService,
  ctx: Context,
  optionalDeadline: AbortSignal,
) {
  const names = new Map<string, string | undefined>();
  let lookupRemainingMs = LOOKUP_BUDGET_MS;
  let incomplete = false;

  return {
    get(row: RawPaProject): string | undefined {
      const key = applicantKey(row);
      return key === undefined ? undefined : names.get(key);
    },
    get incomplete(): boolean {
      return incomplete;
    },
    async load(rows: RawPaProject[], stagingSignal?: AbortSignal): Promise<void> {
      ctx.signal.throwIfAborted();
      const groups = new Map<number, string[]>();
      for (const row of rows) {
        const key = applicantKey(row);
        const { disasterNumber, applicantId } = row;
        if (
          key === undefined ||
          names.has(key) ||
          disasterNumber === undefined ||
          applicantId === undefined
        )
          continue;
        names.set(key, undefined);
        const value = `'${escapeODataString(applicantId)}'`;
        if (
          encodeURIComponent(applicantTerm(disasterNumber, [value])).length > ENCODED_FILTER_LIMIT
        ) {
          incomplete = true;
          continue;
        }
        const ids = groups.get(disasterNumber);
        if (ids) ids.push(value);
        else groups.set(disasterNumber, [value]);
      }
      if (groups.size === 0) return;

      const budgetMs = Math.floor(lookupRemainingMs);
      if (budgetMs <= 0) {
        incomplete = true;
        return;
      }
      const startedAt = performance.now();
      const deadline = AbortSignal.timeout(budgetMs);
      const signal = AbortSignal.any(
        stagingSignal ? [deadline, optionalDeadline, stagingSignal] : [deadline, optionalDeadline],
      );
      try {
        for (const filter of filters(groups)) {
          try {
            let skip = 0;
            let count: number;
            do {
              signal.throwIfAborted();
              const page = await service.fetchPaApplicants(
                {
                  filter,
                  select: 'disasterNumber,applicantId,applicantName',
                  orderby: 'disasterNumber,applicantId,id',
                  top: PAGE_SIZE,
                  skip,
                },
                ctx,
                signal,
              );
              for (const row of page.rows) {
                const key = applicantKey(row);
                if (
                  key !== undefined &&
                  names.has(key) &&
                  !names.get(key) &&
                  typeof row.applicantName === 'string' &&
                  row.applicantName.trim()
                ) {
                  names.set(key, row.applicantName);
                }
              }
              skip += page.rows.length;
              count = page.count;
              if (page.rows.length === 0 && skip < count) {
                incomplete = true;
                break;
              }
            } while (skip < count);
          } catch (error) {
            ctx.signal.throwIfAborted();
            stagingSignal?.throwIfAborted();
            if (!signal.aborted && !(error instanceof McpError)) throw error;
            incomplete = true;
            if (signal.aborted) break;
          }
        }
      } finally {
        // Pause the applicant budget between project pages while preserving the outer deadline.
        lookupRemainingMs -= performance.now() - startedAt;
      }
      ctx.signal.throwIfAborted();
    },
  };
}
