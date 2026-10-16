/**
 * @fileoverview Tool: fema_query_dataset — generic OData query against any dataset in the
 * OpenFEMA dataset catalog, at the API version the catalog lists for it.
 * @module mcp-server/tools/definitions/fema-query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { renderTableHeader, renderTableRow } from '@/mcp-server/tools/markdown-table.js';
import {
  continuationNotice,
  RESPONSE_BUDGET_CHARS,
  rowCharge,
  rowsWithinBudget,
} from '@/mcp-server/tools/response-budget.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';
import type { DatasetDeprecation } from '@/services/openfema/types.js';

/**
 * Records the first read of a page asks for when limit allows more. A record can run past
 * 10,000 characters (IpawsArchivedAlerts), so asking for `limit` up front could read ~100 MB
 * to keep the 9 records that fit the budget; 500 such records stay near 5 MB.
 */
const READ_CHUNK = 500;
/** Reads one page may take: the first chunk, then reads sized from the records already read. */
const MAX_READS = 3;
/** One deadline across a page's reads, inside the 60-second request timeout of MCP SDK clients. */
const QUERY_BUDGET_MS = 50_000;

/** Where a deprecated version's replacement is: its dataset name, its data page, or both. */
function replacementText(deprecation: DatasetDeprecation): string {
  const { replacementDataset, replacementUrl } = deprecation;
  if (replacementDataset) {
    return ` Replacement dataset: ${replacementDataset}${replacementUrl ? ` (${replacementUrl})` : ''}.`;
  }
  return replacementUrl ? ` Replacement: ${replacementUrl}` : '';
}

/** The notice sentence for a deprecated dataset version that still answers. */
function deprecationNotice(dataset: string, deprecation: DatasetDeprecation, retired: boolean) {
  const day = deprecation.date?.slice(0, 10);
  const when = day ? (retired ? `, retired on ${day}` : `, to be retired on ${day}`) : '';
  return (
    `OpenFEMA has deprecated this version of "${dataset}"${when}.` +
    (deprecation.message ? ` OpenFEMA's notice: ${deprecation.message}` : '') +
    replacementText(deprecation)
  );
}

/** The recovery hint for a retired version: query the replacement by name when it is known. */
function retiredHint({ replacementDataset, replacementUrl }: DatasetDeprecation): string {
  if (replacementDataset) {
    return `This dataset version is retired. Query its replacement, ${replacementDataset}, with fema_query_dataset; field names can differ, so read one record with limit 1 first.`;
  }
  return replacementUrl
    ? `This dataset version is retired. OpenFEMA describes its replacement at ${replacementUrl}; take the replacement's dataset name from that page and query it with fema_query_dataset.`
    : 'This dataset version is retired and OpenFEMA names no replacement. Choose another dataset from https://www.fema.gov/about/openfema/data-sets.';
}

export const femaQueryDataset = tool('fema_query_dataset', {
  title: 'Query Any OpenFEMA Dataset',
  description:
    'Generic OData query against any dataset in the OpenFEMA dataset catalog — the escape hatch for datasets the ' +
    'convenience tools do not cover (e.g., NfipPolicies, IndividualAssistanceHousingRegistrantsLargeDisasters, ' +
    'FemaWebDeclarationAreas, PublicAssistanceApplicants). ' +
    'Accepts raw OData filter, select, orderby, and pagination parameters. ' +
    'For NfipPolicies, use propertyState (not state) for the state and reportedZipCode for the ZIP code — it has no countyCode; ' +
    'always include a ZIP filter to avoid timeout. ' +
    'The dataset name must match the exact OpenFEMA entity name (case-sensitive, e.g., NfipClaims). ' +
    'Names missing from the catalog return an unknown_dataset error; a listed dataset OpenFEMA does not serve through the API, or a retired version, returns dataset_not_served. ' +
    'A page holds at most 100,000 characters of records; when records remain past it, next_offset is the offset to continue from.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    dataset: z
      .string()
      .min(1)
      .describe(
        'OpenFEMA dataset entity name (case-sensitive, e.g., NfipPolicies, FemaWebDeclarationAreas, PublicAssistanceApplicants).',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        "OData $filter expression (e.g., \"state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'\"). String values in single quotes. For a list of values use field in ('a','b'): OpenFEMA rejects filters nested more than 100 levels deep (about 90 chained and/or comparisons) and request URLs past about 8,900 characters.",
      ),
    select: z
      .string()
      .optional()
      .describe(
        'Comma-separated field names to return (e.g., "disasterNumber,state,declarationDate").',
      ),
    orderby: z
      .string()
      .optional()
      .describe('OData $orderby expression (e.g., "declarationDate desc").'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100)
      .describe(
        'Maximum records to return (1–10000, default 100). A page also stops at 100,000 characters of records; when either bound leaves matching records out, next_offset names the offset to continue from.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset (default 0). Pass the previous page’s next_offset to continue.'),
  }),
  output: z.object({
    dataset: z.string().describe('The dataset that was queried.'),
    rows: z
      .array(
        z
          .object({})
          .passthrough()
          .describe(
            'A single record from the queried dataset. Field names and types vary by dataset.',
          ),
      )
      .describe(
        'Records from offset onward, bounded by limit and by 100,000 characters of records. Field names depend on the queried dataset.',
      ),
    total_count: z.number().describe('Total matching records before pagination.'),
    returned_count: z.number().describe('Number of records in this response.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Paging guidance — the offset to continue from and whether limit or the response budget ended the page, filter advice when nothing matches, or the total and last valid offset when offset is at or past the end — plus OpenFEMA’s notice when the dataset version is deprecated.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page: offset plus returned_count. Present only while matching records remain past this page; pass it as offset to continue.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching records before pagination — exceeds returned_count when results were capped at the limit.',
      ),
  },
  enrichmentTrailer: {
    next_offset: { label: 'Next offset' },
  },
  errors: [
    {
      reason: 'unknown_dataset',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset name is not in the OpenFEMA dataset catalog.',
      recovery:
        'Check the exact dataset entity name at https://www.fema.gov/about/openfema/data-sets. Names are case-sensitive (e.g., NfipClaims not nfipClaims).',
    },
    {
      reason: 'dataset_not_served',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The OpenFEMA dataset catalog lists the dataset, but OpenFEMA answers its API endpoint with a 404 page, or the version is past its deprecation date and returns no records.',
      recovery:
        'The name is correct, but OpenFEMA does not serve this dataset through the API. Choose another dataset from https://www.fema.gov/about/openfema/data-sets.',
    },
    {
      reason: 'catalog_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'The OpenFEMA dataset catalog could not be read, so the dataset API version is unknown.',
      recovery:
        'Retry the call in a few seconds; the dataset catalog is requested again on the next call.',
    },
    {
      reason: 'invalid_filter',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenFEMA rejected the filter expression — an unknown field, a value of the wrong type or range, or unparseable syntax.',
      recovery:
        "Fix the filter: put string values in single quotes (state eq 'TX', not state eq TX), compare numbers unquoted, and spell field names exactly as the dataset does (case-sensitive). Call fema_query_dataset with limit 1 and no filter to see the dataset's field names.",
    },
    {
      reason: 'invalid_select',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenFEMA rejected the select list — an unknown field or unparseable syntax.',
      recovery:
        "List field names separated by single commas, spelled exactly as the dataset does (case-sensitive). Call fema_query_dataset with limit 1 and no select to see the dataset's field names.",
    },
    {
      reason: 'invalid_orderby',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenFEMA rejected the orderby expression — an unknown field or unparseable syntax.',
      recovery:
        "Use a field name spelled exactly as the dataset does, optionally followed by asc or desc (e.g., declarationDate desc). Call fema_query_dataset with limit 1 to see the dataset's field names.",
    },
    {
      reason: 'invalid_odata_syntax',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenFEMA could not parse the request and did not say whether filter, select, or orderby was at fault.',
      recovery:
        'Retry with one of filter, select, or orderby at a time to find the one OpenFEMA cannot parse, then fix its syntax: quoted strings, exact field names, comma-separated select fields.',
    },
    {
      reason: 'request_too_long',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The request URL, mostly the filter after percent-encoding, is longer than the roughly 8,900 characters OpenFEMA accepts.',
      recovery:
        "Shorten the filter: replace or-joined equality comparisons on one field with a single field in ('a','b') list, drop unneeded select fields, or split the query into several calls.",
    },
    {
      reason: 'filter_too_complex',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The filter nests more than 100 levels deep, the most OpenFEMA allows; every and/or adds a level.',
      recovery:
        "Replace or-joined equality comparisons on one field with a single field in ('a','b','c') clause, or split the query into several calls with smaller filters.",
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFemaService();
    const deadlineAt = Date.now() + QUERY_BUDGET_MS;
    const query = {
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.select ? { select: input.select } : {}),
      ...(input.orderby ? { orderby: input.orderby } : {}),
    };

    // fetchDataset resolves the dataset's API version from the OpenFEMA catalog and throws the
    // contract's service reasons (unknown_dataset, dataset_not_served, catalog_unavailable,
    // invalid_filter, invalid_select, invalid_orderby, invalid_odata_syntax, request_too_long,
    // filter_too_complex) — those bubble unchanged.
    let requested = Math.min(input.limit, READ_CHUNK);
    const first = await svc.fetchDataset<Record<string, unknown>>(
      input.dataset,
      { ...query, top: requested, skip: input.offset },
      ctx,
    );
    const { count, deprecation } = first;
    const rows = [...first.rows];

    // Past its deprecation date OpenFEMA still answers a version with its old count and no
    // records, so an empty page inside that count is the retirement, not the end of the match.
    const retired = Date.parse(deprecation?.date ?? '') <= Date.now();
    if (deprecation && retired && rows.length === 0 && input.offset < count) {
      const { replacementDataset, replacementUrl } = deprecation;
      throw ctx.fail(
        'dataset_not_served',
        `OpenFEMA retired this version of "${input.dataset}" on ${deprecation.date?.slice(0, 10)}: it still counts ${count} matching records but returns none.` +
          (deprecation.message ? ` OpenFEMA's notice: ${deprecation.message}` : '') +
          replacementText(deprecation),
        {
          dataset: input.dataset,
          deprecationDate: deprecation.date,
          ...(replacementDataset ? { replacementDataset } : {}),
          ...(replacementUrl ? { replacementUrl } : {}),
          recovery: { hint: retiredHint(deprecation) },
        },
      );
    }

    // OpenFEMA returns one key set per page, so the first record's keys are every column.
    const columns = Object.keys(rows[0] ?? {});
    const charge = (row: Record<string, unknown>) => rowCharge(row, renderTableRow(row, columns));
    let used = rows.reduce((n, row) => n + charge(row), 0);

    /**
     * Read on while the page is under the budget and limit, sizing each read from the records
     * already read. The reads past the first are a best-effort fill: when one fails, the page
     * keeps the records read so far and next_offset continues from them.
     */
    let readFailure: McpError | undefined;
    let lastRead = first.rows.length;
    for (let reads = 1; reads < MAX_READS; reads++) {
      if (used > RESPONSE_BUDGET_CHARS || lastRead < requested || rows.length >= input.limit) break;
      const average = used / rows.length;
      requested = Math.min(
        input.limit - rows.length,
        Math.ceil((RESPONSE_BUDGET_CHARS - used) / average) + 1,
      );
      const deadlineMs = deadlineAt - Date.now();
      if (deadlineMs <= 0) {
        readFailure = timeout('The page ran out of time before its remaining records were read.');
        break;
      }
      try {
        const next = await svc.fetchDataset<Record<string, unknown>>(
          input.dataset,
          { ...query, top: requested, skip: input.offset + rows.length },
          ctx,
          { deadlineMs },
        );
        rows.push(...next.rows);
        used += next.rows.reduce((n, row) => n + charge(row), 0);
        lastRead = next.rows.length;
      } catch (error) {
        if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
        readFailure = error;
        break;
      }
    }

    const returned = rowsWithinBudget(rows.length, (i) => charge(rows[i] ?? {}));
    const page = rows.slice(0, returned);
    const nextOffset = input.offset + returned;
    const budgetCut = returned < rows.length;

    const notice: string[] = [];
    if (page.length === 0) {
      notice.push(
        count === 0
          ? `No records found in dataset "${input.dataset}" with the given filters. Check field names and filter syntax.`
          : `Offset ${input.offset} is past the end of the ${count} matching records; the last valid offset is ${count - 1}.`,
      );
    } else if (nextOffset < count) {
      ctx.enrich({ next_offset: nextOffset });
      const share = `${returned} of the ${count} matching records`;
      /**
       * Neither bound ended a page whose reads stopped short: a failed read, or later rows
       * narrower than the average the reads were sized from.
       */
      notice.push(
        budgetCut || returned === input.limit
          ? continuationNotice(share, input.offset, nextOffset, budgetCut)
          : readFailure
            ? `Returned ${share} from offset ${input.offset}; OpenFEMA did not return the rest of this page, so continue with offset ${nextOffset}.`
            : `Returned ${share} from offset ${input.offset}, short of both limit and the 100,000-character response budget; continue with offset ${nextOffset}.`,
      );
      if (readFailure) {
        ctx.log.warning('A read past the first chunk of a dataset page failed', {
          dataset: input.dataset,
          error: readFailure.message,
        });
      }
    }
    if (deprecation) notice.push(deprecationNotice(input.dataset, deprecation, retired));
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));

    ctx.enrich.total(count);
    ctx.log.info('Generic dataset query complete', {
      dataset: input.dataset,
      count,
      returned,
      fetched: rows.length,
    });

    return {
      dataset: input.dataset,
      rows: page,
      total_count: count,
      returned_count: returned,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**${result.returned_count} of ${result.total_count} records** from \`${result.dataset}\`\n`,
    );
    if (result.rows.length === 0) {
      lines.push(
        result.total_count === 0
          ? '_No records returned._'
          : '_This page is empty: the offset is past the end of the matching records._',
      );
    } else {
      // OpenFEMA returns one key set per page, so the first record's keys are every column.
      const columns = Object.keys(result.rows[0] ?? {});
      if (columns.length > 0) {
        lines.push(renderTableHeader(columns));
        for (const row of result.rows) lines.push(renderTableRow(row, columns));
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
