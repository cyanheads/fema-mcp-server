/**
 * @fileoverview Tool: fema_get_disaster — fetch all designated-area rows for a specific disaster.
 * @module mcp-server/tools/definitions/fema-get-disaster
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaGetDisaster = tool('fema_get_disaster', {
  title: 'Get FEMA Disaster Details',
  description:
    'Fetch all designated-area rows for a specific FEMA disaster by disaster number (e.g., 4781). ' +
    'Returns every county/municipality designated under the declaration along with programs activated, ' +
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
    state_name: z
      .string()
      .optional()
      .describe('Full state or territory name. Absent when not returned by the API.'),
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
      .describe('True when Individual Assistance (housing/personal grants) was declared.'),
    pa_declared: z
      .boolean()
      .describe('True when Public Assistance (infrastructure recovery grants) was declared.'),
    hm_declared: z.boolean().describe('True when Hazard Mitigation grants were declared.'),
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
      .describe('All counties/municipalities designated for assistance under this declaration.'),
    designated_area_count: z
      .number()
      .describe('Total number of designated areas in this declaration.'),
  }),
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
    const svc = getOpenFemaService();
    const { rows } = await svc.fetchDisasters(
      {
        filter: `disasterNumber eq ${input.disaster_number}`,
        select:
          'disasterNumber,declarationTitle,state,stateName,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'iaProgramDeclared,paProgramDeclared,hmProgramDeclared,' +
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

    ctx.log.info('Disaster fetch complete', {
      disasterNumber: input.disaster_number,
      areaCount: designatedAreas.length,
    });

    return {
      disaster_number: first.disasterNumber ?? input.disaster_number,
      title: first.declarationTitle ?? 'Unknown',
      state: first.state ?? '',
      ...(first.stateName ? { state_name: first.stateName } : {}),
      incident_type: first.incidentType ?? '',
      declaration_type: first.declarationType ?? '',
      declaration_date: first.declarationDate ?? '',
      ...(first.incidentBeginDate ? { incident_begin_date: first.incidentBeginDate } : {}),
      ...(first.incidentEndDate ? { incident_end_date: first.incidentEndDate } : {}),
      ia_declared: first.iaProgramDeclared ?? false,
      pa_declared: first.paProgramDeclared ?? false,
      hm_declared: first.hmProgramDeclared ?? false,
      designated_areas: designatedAreas,
      designated_area_count: designatedAreas.length,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# DR-${result.disaster_number} — ${result.title}`);
    const stateLabel = result.state_name ? `${result.state_name} (${result.state})` : result.state;
    lines.push(
      `**State:** ${stateLabel} | **Type:** ${result.declaration_type} | **Incident:** ${result.incident_type}`,
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
    lines.push(`**Programs Declared:** ${programs.length > 0 ? programs.join(', ') : 'None'}`);
    lines.push('');
    lines.push(`## Designated Areas (${result.designated_area_count})`);
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
