/**
 * @fileoverview Tool: fema_query_dataset — generic OData query against any OpenFEMA v2 dataset.
 * @module mcp-server/tools/definitions/fema-query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaQueryDataset = tool('fema_query_dataset', {
  title: 'Query Any OpenFEMA Dataset',
  description:
    'Generic OData query against any OpenFEMA v2 dataset — the escape hatch for datasets the ' +
    'convenience tools do not cover (e.g., FimaNfipPolicies, IndividualAssistanceHousingRegistrantsLargeDisasters, ' +
    'FemaWebDeclarationAreas, PublicAssistanceApplicants). ' +
    'Accepts raw OData filter, select, orderby, and pagination parameters. ' +
    'For NFIP Policies, use propertyState (not state) as the state field — always include a county or ZIP filter ' +
    'to avoid timeout. ' +
    'The dataset name must match the exact OpenFEMA v2 entity name (case-sensitive, e.g., FimaNfipClaims). ' +
    'Unknown dataset names return an unknown_dataset error.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    dataset: z
      .string()
      .min(1)
      .describe(
        'OpenFEMA v2 dataset entity name (case-sensitive, e.g., FimaNfipPolicies, FemaWebDeclarationAreas, PublicAssistanceApplicants).',
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
    notice: z.string().optional().describe('Guidance when no results were found.'),
  },
  errors: [
    {
      reason: 'unknown_dataset',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset name not recognized — API returned HTML 404 instead of JSON.',
      recovery:
        'Check the exact dataset entity name at https://www.fema.gov/about/openfema/data-sets. Names are case-sensitive (e.g., FimaNfipClaims not fimaNfipClaims).',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OData filter expression could not be parsed by the API.',
      recovery:
        'Fix the OData $filter syntax. String values must use single quotes. Check field names against the dataset schema at the FEMA OpenFEMA portal.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFemaService();

    // The service's fetchDataset will throw with reason 'unknown_dataset' or 'invalid_filter'
    // when the API returns the appropriate error shapes — those bubble unchanged.
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
        `No records found in dataset "${input.dataset}" with the given filters. Check field names and filter syntax.`,
      );
    }

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
      lines.push('_No records returned._');
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
            .slice(0, 6)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ');
          lines.push(parts);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
