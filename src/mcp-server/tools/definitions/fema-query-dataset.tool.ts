/**
 * @fileoverview Tool: fema_query_dataset — generic OData query against any dataset in the
 * OpenFEMA dataset catalog, at the API version the catalog lists for it.
 * @module mcp-server/tools/definitions/fema-query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

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
    'Names missing from the catalog return an unknown_dataset error; a listed dataset OpenFEMA does not serve through the API returns dataset_not_served.',
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
        "OData $filter expression (e.g., \"state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'\"). String values in single quotes.",
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
      .describe('Maximum records to return (1–10000, default 100).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
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
      .describe('Records returned from the dataset. Field names depend on the queried dataset.'),
    total_count: z.number().describe('Total matching records before pagination.'),
    returned_count: z.number().describe('Number of records in this response.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on an empty page — filter advice when nothing matches, or the total and last valid offset when offset is at or past the end.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching records before pagination — exceeds returned_count when results were capped at the limit.',
      ),
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
      when: 'The OpenFEMA dataset catalog lists the dataset, but OpenFEMA answers its API endpoint with a 404 page.',
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
  ],

  async handler(input, ctx) {
    const svc = getOpenFemaService();

    // fetchDataset resolves the dataset's API version from the OpenFEMA catalog and throws the
    // contract's service reasons (unknown_dataset, dataset_not_served, catalog_unavailable,
    // invalid_filter, invalid_select, invalid_orderby, invalid_odata_syntax) — those bubble unchanged.
    const { rows, count } = await svc.fetchDataset<Record<string, unknown>>(
      input.dataset,
      {
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.select ? { select: input.select } : {}),
        ...(input.orderby ? { orderby: input.orderby } : {}),
        top: input.limit,
        skip: input.offset,
      },
      ctx,
    );

    if (rows.length === 0) {
      ctx.enrich.notice(
        count === 0
          ? `No records found in dataset "${input.dataset}" with the given filters. Check field names and filter syntax.`
          : `Offset ${input.offset} is past the end of the ${count} matching records; the last valid offset is ${count - 1}.`,
      );
    }

    ctx.enrich.total(count);
    ctx.log.info('Generic dataset query complete', {
      dataset: input.dataset,
      count,
      returned: rows.length,
    });

    return {
      dataset: input.dataset,
      rows,
      total_count: count,
      returned_count: rows.length,
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
      const headers = Object.keys(result.rows[0] ?? {});
      if (headers.length > 0 && result.rows.length <= 50) {
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of result.rows) {
          const cells = headers.map((h) => String(row[h] ?? ''));
          lines.push(`| ${cells.join(' | ')} |`);
        }
      } else {
        for (const row of result.rows) {
          const parts = Object.entries(row)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ');
          lines.push(parts);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
