/**
 * @fileoverview Tool: fema_get_disaster — bounded designated-area details for a specific disaster.
 * @module mcp-server/tools/definitions/fema-get-disaster
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaGetDisaster = tool('fema_get_disaster', {
  title: 'Get FEMA Disaster Details',
  description:
    'Fetch up to 1,000 designated-area rows for a specific FEMA disaster by disaster number (e.g., 4781). ' +
    'Discloses partial area and program coverage when more rows exist. Returns counties/municipalities along with programs observed, ' +
    'incident period, and state info. Use fema_search_disasters to find disaster numbers. ' +
    'The returned disaster_number chains to fema_get_public_assistance and fema_get_housing_assistance.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    disaster_number: z
      .number()
      .int()
      .positive()
      .describe('FEMA disaster number (e.g., 4781). Obtain from fema_search_disasters.'),
  }),
  output: z.object({
    disaster_number: z
      .number()
      .describe('FEMA disaster number — use as the chain key for PA and housing assistance tools.'),
    title: z.string().describe('Official declaration title (e.g., "SEVERE STORMS AND FLOODING").'),
    state: z.string().describe('Two-letter state/territory code.'),
    incident_type: z.string().describe('Type of incident (e.g., Flood, Hurricane, Severe Storm).'),
    declaration_type: z
      .string()
      .describe('Declaration type: DR (major disaster), EM (emergency), or FM (fire management).'),
    declaration_date: z.string().describe('ISO 8601 date the declaration was signed.'),
    incident_begin_date: z
      .string()
      .optional()
      .describe('ISO 8601 start date of the incident. Absent when not recorded.'),
    incident_end_date: z
      .string()
      .optional()
      .describe('ISO 8601 end date of the incident. Absent for ongoing or unrecorded incidents.'),
    ia_declared: z
      .boolean()
      .describe(
        'True when IHP was declared in a fetched row. When areas_truncated is true, false does not exclude IHP in unfetched rows.',
      ),
    pa_declared: z
      .boolean()
      .describe(
        'True when PA was declared in a fetched row. When areas_truncated is true, false does not exclude PA in unfetched rows.',
      ),
    hm_declared: z
      .boolean()
      .describe(
        'True when HM was declared in a fetched row. When areas_truncated is true, false does not exclude HM in unfetched rows.',
      ),
    designated_areas: z
      .array(
        z
          .object({
            area: z.string().describe('Name of the designated county or municipality.'),
            fips_state_code: z
              .string()
              .optional()
              .describe('2-digit state FIPS code. Absent when not returned.'),
            fips_county_code: z
              .string()
              .optional()
              .describe('3-digit county FIPS code. Absent when not returned.'),
          })
          .describe('A single designated area entry.'),
      )
      .describe('Fetched counties/municipalities designated for assistance, up to 1,000 rows.'),
    designated_area_count: z
      .number()
      .describe('Number of designated-area rows fetched for this declaration.'),
    areas_truncated: z
      .boolean()
      .optional()
      .describe(
        'True when designated-area rows remain unfetched; program flags cover only fetched rows.',
      ),
    total_designated_area_count: z
      .number()
      .optional()
      .describe('Upstream total designated-area rows, present when areas_truncated is true.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Returned/total area counts and partial program evidence, with the dataset tool for full rows.',
      ),
  },
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No declaration found with the given disaster number.',
      recovery:
        'Verify the disaster number using fema_search_disasters. FEMA disaster numbers are typically 4-digit integers.',
    },
  ],

  async handler(input, ctx) {
    // OpenFEMA's OData layer stores disasterNumber as Int16 (max 32767).
    // Numbers above that produce a raw type-mismatch error from the API rather
    // than a 404 — treat them as not-found since no real FEMA disaster exceeds
    // this range.
    if (input.disaster_number > 32767) {
      throw ctx.fail(
        'not_found',
        `No disaster declaration found with number ${input.disaster_number}.`,
        { disasterNumber: input.disaster_number, ...ctx.recoveryFor('not_found') },
      );
    }

    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchDisasters(
      {
        filter: `disasterNumber eq ${input.disaster_number}`,
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'ihProgramDeclared,paProgramDeclared,hmProgramDeclared,' +
          'designatedArea,fipsStateCode,fipsCountyCode',
        top: 1000,
      },
      ctx,
    );

    if (rows.length === 0) {
      throw ctx.fail(
        'not_found',
        `No disaster declaration found with number ${input.disaster_number}.`,
        { disasterNumber: input.disaster_number, ...ctx.recoveryFor('not_found') },
      );
    }

    // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above
    const first = rows[0]!;
    const designatedAreas = rows.map((r) => ({
      area: r.designatedArea ?? 'Unknown',
      ...(r.fipsStateCode ? { fips_state_code: r.fipsStateCode } : {}),
      ...(r.fipsCountyCode ? { fips_county_code: r.fipsCountyCode } : {}),
    }));

    // OR program flags across all area-rows: ihProgramDeclared may be false on some
    // rows and true on others for the same disaster — declared for ANY area = declared.
    const ia_declared = rows.some((r) => r.ihProgramDeclared === true);
    const pa_declared = rows.some((r) => r.paProgramDeclared === true);
    const hm_declared = rows.some((r) => r.hmProgramDeclared === true);
    const partial = count > rows.length;
    if (partial) {
      ctx.enrich.notice(
        `Returned ${rows.length} of ${count} designated-area rows; program flags cover only fetched rows. False flags do not establish absence in the full declaration. Use fema_query_dataset with DisasterDeclarationsSummaries and filter disasterNumber eq ${input.disaster_number} for the full rows.`,
      );
    }

    ctx.log.info('Disaster fetch complete', {
      disasterNumber: input.disaster_number,
      areaCount: designatedAreas.length,
    });

    return {
      disaster_number: first.disasterNumber ?? input.disaster_number,
      title: first.declarationTitle ?? 'Unknown',
      state: first.state ?? '',
      incident_type: first.incidentType ?? '',
      declaration_type: first.declarationType ?? '',
      declaration_date: first.declarationDate ?? '',
      ...(first.incidentBeginDate ? { incident_begin_date: first.incidentBeginDate } : {}),
      ...(first.incidentEndDate ? { incident_end_date: first.incidentEndDate } : {}),
      ia_declared,
      pa_declared,
      hm_declared,
      designated_areas: designatedAreas,
      designated_area_count: designatedAreas.length,
      ...(partial ? { areas_truncated: true, total_designated_area_count: count } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const label = result.declaration_type
      ? `${result.declaration_type}-${result.disaster_number}`
      : `Disaster #${result.disaster_number}`;
    lines.push(`# ${label} — ${result.title}`);
    lines.push(
      `**State:** ${result.state} | **Type:** ${result.declaration_type} | **Incident:** ${result.incident_type}`,
    );
    lines.push(`**Declared:** ${result.declaration_date}`);
    if (result.incident_begin_date) {
      lines.push(
        `**Incident Period:** ${result.incident_begin_date}${result.incident_end_date ? ` → ${result.incident_end_date}` : ' (ongoing)'}`,
      );
    }
    const programs: string[] = [];
    if (result.ia_declared) programs.push('Individual Assistance (IA)');
    if (result.pa_declared) programs.push('Public Assistance (PA)');
    if (result.hm_declared) programs.push('Hazard Mitigation (HM)');
    lines.push(
      `**Programs ${result.areas_truncated ? 'Observed in Fetched Rows' : 'Declared'}:** ${programs.length > 0 ? programs.join(', ') : result.areas_truncated ? 'None observed; unfetched rows may declare programs' : 'None'}`,
    );
    lines.push('');
    lines.push(
      `## Designated Areas (${result.designated_area_count}${result.areas_truncated ? ` of ${result.total_designated_area_count}; partial coverage` : ''})`,
    );
    for (const area of result.designated_areas) {
      const fips =
        area.fips_state_code && area.fips_county_code
          ? ` (FIPS ${area.fips_state_code}${area.fips_county_code})`
          : '';
      lines.push(`- ${area.area}${fips}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
