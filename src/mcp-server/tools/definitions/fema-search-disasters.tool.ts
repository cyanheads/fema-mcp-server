/**
 * @fileoverview Tool: fema_search_disasters — search federal disaster declarations.
 * @module mcp-server/tools/definitions/fema-search-disasters
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeODataString, getOpenFemaService } from '@/services/openfema/openfema-service.js';

/** Valid US state/territory abbreviations accepted by OpenFEMA. */
const US_STATES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
  'FM',
  'MH',
  'PW',
]);

export const femaSearchDisasters = tool('fema_search_disasters', {
  title: 'Search FEMA Disaster Declarations',
  description:
    'Search federal disaster declarations by state, incident type, declaration type, date range, and county. ' +
    'Returns deduplicated declaration-level summaries — each disaster number appears once with a ' +
    'designatedAreaCount showing how many counties/municipalities were designated. ' +
    'The disaster number is the chain key for fema_get_disaster, fema_get_public_assistance, and fema_get_housing_assistance. ' +
    'Use declaration_type to filter: DR (major disaster, most common), EM (emergency), FM (fire management). ' +
    'Date filters apply to the declaration date. Use fema_get_disaster to retrieve all designated-area rows for a specific declaration.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe('Two-letter US state/territory code (e.g., TX, CA, FL, PR). Filters by state.'),
    incident_type: z
      .string()
      .optional()
      .describe(
        'Incident type filter (e.g., Flood, Hurricane, Tornado, Fire, Earthquake, Severe Storm). Case-insensitive substring match.',
      ),
    declaration_type: z
      .enum(['DR', 'EM', 'FM'])
      .optional()
      .describe(
        'Declaration type: DR (major disaster declaration), EM (emergency declaration), FM (fire management assistance declaration).',
      ),
    date_from: z
      .string()
      .optional()
      .describe(
        'Start of declaration date range in ISO 8601 format (e.g., 2024-01-01). Inclusive.',
      ),
    date_to: z
      .string()
      .optional()
      .describe('End of declaration date range in ISO 8601 format (e.g., 2024-12-31). Inclusive.'),
    county: z
      .string()
      .optional()
      .describe(
        'Filter by designated area / county name substring (e.g., Harris, Los Angeles). Case-insensitive.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe('Maximum number of declarations to return (1–1000, default 50).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset (default 0). Use with limit for paging through results.'),
  }),
  output: z.object({
    declarations: z
      .array(
        z
          .object({
            disaster_number: z
              .number()
              .describe(
                'Unique FEMA disaster number — pass to fema_get_disaster, fema_get_public_assistance, or fema_get_housing_assistance.',
              ),
            title: z
              .string()
              .describe('Official declaration title (e.g., "SEVERE STORMS AND FLOODING").'),
            state: z.string().describe('Two-letter state/territory code.'),
            incident_type: z
              .string()
              .describe('Type of incident (e.g., Flood, Hurricane, Tornado, Severe Storm).'),
            declaration_type: z
              .string()
              .describe(
                'Declaration type: DR (major disaster), EM (emergency), or FM (fire management).',
              ),
            declaration_date: z.string().describe('ISO 8601 date the declaration was signed.'),
            incident_begin_date: z
              .string()
              .optional()
              .describe('ISO 8601 incident start date. Absent when not recorded.'),
            incident_end_date: z
              .string()
              .optional()
              .describe('ISO 8601 incident end date. Absent for ongoing or unrecorded incidents.'),
            ia_declared: z
              .boolean()
              .describe('True when Individual Assistance (housing/personal grants) was declared.'),
            pa_declared: z
              .boolean()
              .describe(
                'True when Public Assistance (infrastructure recovery grants) was declared.',
              ),
            hm_declared: z.boolean().describe('True when Hazard Mitigation grants were declared.'),
            designated_area_count: z
              .number()
              .describe(
                'Number of counties/municipalities designated — use fema_get_disaster for the full area list.',
              ),
          })
          .describe('Deduplicated summary for one disaster declaration.'),
      )
      .describe('Disaster declarations matching the search, one entry per unique disaster number.'),
    total_area_rows: z
      .number()
      .describe(
        'Total matching designated-area rows from the API before pagination. ' +
          'DisasterDeclarationsSummaries returns one row per designated area per disaster — ' +
          'this count is higher than the number of unique declarations in `declarations`.',
      ),
    returned_count: z
      .number()
      .describe('Number of unique deduplicated declarations in this response.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no results were found.'),
  },
  errors: [
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The state parameter is not a valid 2-letter US state/territory code.',
      recovery:
        'Provide a valid 2-letter US state code such as TX, CA, FL, or PR. Check the full list at FEMA.gov.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'Query returned zero disaster declarations.',
      recovery:
        'Broaden the search by removing filters, expanding the date range, or trying a different state or incident type.',
    },
  ],

  async handler(input, ctx) {
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    const filterParts: string[] = [];
    if (input.state) filterParts.push(`state eq '${input.state}'`);
    if (input.incident_type) {
      filterParts.push(`substringof('${escapeODataString(input.incident_type)}', incidentType)`);
    }
    if (input.declaration_type) filterParts.push(`declarationType eq '${input.declaration_type}'`);
    if (input.date_from) {
      filterParts.push(`declarationDate ge '${escapeODataString(input.date_from)}T00:00:00.000Z'`);
    }
    if (input.date_to) {
      filterParts.push(`declarationDate le '${escapeODataString(input.date_to)}T23:59:59.999Z'`);
    }
    if (input.county?.trim()) {
      filterParts.push(`substringof('${escapeODataString(input.county)}', designatedArea)`);
    }

    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchDisasters(
      {
        ...(filterParts.length > 0 ? { filter: filterParts.join(' and ') } : {}),
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'iaProgramDeclared,paProgramDeclared,hmProgramDeclared',
        orderby: 'declarationDate desc',
        top: input.limit,
        skip: input.offset,
      },
      ctx,
    );

    // Deduplicate: group rows by disasterNumber, tracking designatedAreaCount
    const disasterMap = new Map<
      number,
      {
        disaster_number: number;
        title: string;
        state: string;
        incident_type: string;
        declaration_type: string;
        declaration_date: string;
        incident_begin_date?: string;
        incident_end_date?: string;
        ia_declared: boolean;
        pa_declared: boolean;
        hm_declared: boolean;
        designated_area_count: number;
      }
    >();

    for (const row of rows) {
      const num = row.disasterNumber ?? 0;
      const existing = disasterMap.get(num);
      if (existing) {
        existing.designated_area_count += 1;
      } else {
        disasterMap.set(num, {
          disaster_number: num,
          title: row.declarationTitle ?? 'Unknown',
          state: row.state ?? '',
          incident_type: row.incidentType ?? '',
          declaration_type: row.declarationType ?? '',
          declaration_date: row.declarationDate ?? '',
          ...(row.incidentBeginDate ? { incident_begin_date: row.incidentBeginDate } : {}),
          ...(row.incidentEndDate ? { incident_end_date: row.incidentEndDate } : {}),
          ia_declared: row.iaProgramDeclared ?? false,
          pa_declared: row.paProgramDeclared ?? false,
          hm_declared: row.hmProgramDeclared ?? false,
          designated_area_count: 1,
        });
      }
    }

    const declarations = Array.from(disasterMap.values());

    if (declarations.length === 0) {
      ctx.enrich.notice(
        `No disaster declarations matched the search criteria. Try broadening the date range, removing filters, or checking the state code.`,
      );
      throw ctx.fail('no_results', 'No disaster declarations matched the query.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    ctx.log.info('Disaster search complete', { count, returned: declarations.length });
    return {
      declarations,
      total_area_rows: count,
      returned_count: declarations.length,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**${result.returned_count} unique declaration(s)** (from ${result.total_area_rows} designated-area rows)\n`,
    );
    for (const d of result.declarations) {
      lines.push(`## DR-${d.disaster_number} — ${d.title}`);
      lines.push(
        `**State:** ${d.state} | **Type:** ${d.declaration_type} | **Incident:** ${d.incident_type}`,
      );
      lines.push(`**Declared:** ${d.declaration_date}`);
      if (d.incident_begin_date) {
        lines.push(
          `**Period:** ${d.incident_begin_date}${d.incident_end_date ? ` → ${d.incident_end_date}` : ' (ongoing)'}`,
        );
      }
      const programs: string[] = [];
      if (d.ia_declared) programs.push('IA');
      if (d.pa_declared) programs.push('PA');
      if (d.hm_declared) programs.push('HM');
      lines.push(`**Programs:** ${programs.length > 0 ? programs.join(', ') : 'None declared'}`);
      lines.push(`**Designated Areas:** ${d.designated_area_count}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
