/**
 * @fileoverview Tool: fema_get_disaster — bounded designated-area details for a specific disaster.
 * @module mcp-server/tools/definitions/fema-get-disaster
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline as literal } from '@cyanheads/mcp-ts-core/utils';
import { renderJson, renderNotice, requiresJson } from '@/mcp-server/tools/literal-markdown.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaGetDisaster = tool('fema_get_disaster', {
  title: 'Get FEMA Disaster Details',
  description:
    'Fetch up to 1,000 designated-area rows for a specific FEMA disaster by disaster number (e.g., 4781). Discloses partial area and program coverage when more rows exist. Returns counties and municipalities, programs observed, incident period, and disaster-wide funding totals when available. Use fema_search_disasters to find disaster numbers. The returned disaster_number chains to fema_get_public_assistance and fema_get_housing_assistance.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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
        'True when legacy IA or IHP was declared in a fetched row. Does not guarantee housing records. When areas_truncated is true, false does not exclude IA in unfetched rows.',
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
            ia_declared: z
              .boolean()
              .describe('True when legacy IA or IHP was declared for this area.'),
            pa_declared: z.boolean().describe('True when PA was declared for this area.'),
            hm_declared: z.boolean().describe('True when HM was declared for this area.'),
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
    funding: z
      .object({
        ia_approved_registrations: z
          .number()
          .nullable()
          .describe('Approved Individual Assistance applications.'),
        ihp_approved: z
          .number()
          .nullable()
          .describe('Approved Individuals and Households Program amount in USD.'),
        ha_approved: z.number().nullable().describe('Approved Housing Assistance amount in USD.'),
        ona_approved: z
          .number()
          .nullable()
          .describe('Approved Other Needs Assistance amount in USD.'),
        pa_obligated: z
          .number()
          .nullable()
          .describe(
            'Total Public Assistance obligations in USD, which can include categories outside A–B and C–G.',
          ),
        pa_obligated_cat_ab: z
          .number()
          .nullable()
          .describe('Public Assistance obligations in USD for emergency work (categories A–B).'),
        pa_obligated_cat_c_g: z
          .number()
          .nullable()
          .describe('Public Assistance obligations in USD for permanent work (categories C–G).'),
        hmgp_obligated: z
          .number()
          .nullable()
          .describe('Hazard Mitigation Grant Program obligations in USD.'),
        ia_load_date: z
          .string()
          .nullable()
          .describe('FEMA Individual Assistance data load timestamp.'),
        pa_load_date: z.string().nullable().describe('FEMA Public Assistance data load timestamp.'),
      })
      .optional()
      .describe(
        'Disaster-wide FEMA funding summary. Null fields are unreported. Omitted when the summary is unavailable.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Partial designated-area coverage and funding summary availability.'),
  },
  enrichmentTrailer: {
    notice: { render: renderNotice },
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
    const fundingAbort = new AbortController();
    const declaration = svc.fetchDisasters(
      {
        filter: `disasterNumber eq ${input.disaster_number}`,
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'iaProgramDeclared,ihProgramDeclared,paProgramDeclared,hmProgramDeclared,' +
          'designatedArea,fipsStateCode,fipsCountyCode',
        top: 1000,
      },
      ctx,
    );
    const fundingRead = svc
      .fetchDisasterFunding(input.disaster_number, ctx, fundingAbort.signal)
      .then(
        (row) => ({ ok: true as const, row }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const { rows, count } = await declaration.catch((error: unknown) => {
      fundingAbort.abort();
      throw error;
    });

    if (rows.length === 0) {
      fundingAbort.abort();
      throw ctx.fail(
        'not_found',
        `No disaster declaration found with number ${input.disaster_number}.`,
        { disasterNumber: input.disaster_number, ...ctx.recoveryFor('not_found') },
      );
    }
    const summary = await fundingRead;
    ctx.signal.throwIfAborted();
    if (
      !summary.ok &&
      (!(summary.error instanceof McpError) ||
        summary.error.code === JsonRpcErrorCode.InternalError ||
        summary.error.code === JsonRpcErrorCode.RequestCancelled)
    )
      throw summary.error;
    const rawFunding = summary.ok ? summary.row : undefined;
    const funding = rawFunding && {
      ia_approved_registrations: rawFunding.totalNumberIaApproved ?? null,
      ihp_approved: rawFunding.totalAmountIhpApproved ?? null,
      ha_approved: rawFunding.totalAmountHaApproved ?? null,
      ona_approved: rawFunding.totalAmountOnaApproved ?? null,
      pa_obligated: rawFunding.totalObligatedAmountPa ?? null,
      pa_obligated_cat_ab: rawFunding.totalObligatedAmountCatAb ?? null,
      pa_obligated_cat_c_g: rawFunding.totalObligatedAmountCatC2g ?? null,
      hmgp_obligated: rawFunding.totalObligatedAmountHmgp ?? null,
      ia_load_date: rawFunding.iaLoadDate ?? null,
      pa_load_date: rawFunding.paLoadDate ?? null,
    };

    // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above
    const first = rows[0]!;
    const designatedAreas = rows.map((r) => ({
      area: r.designatedArea ?? 'Unknown',
      ia_declared: r.iaProgramDeclared === true || r.ihProgramDeclared === true,
      pa_declared: r.paProgramDeclared === true,
      hm_declared: r.hmProgramDeclared === true,
      ...(r.fipsStateCode ? { fips_state_code: r.fipsStateCode } : {}),
      ...(r.fipsCountyCode ? { fips_county_code: r.fipsCountyCode } : {}),
    }));

    // Either IA program in any fetched area establishes IA; unfetched rows remain unknown.
    const ia_declared = rows.some(
      (r) => r.iaProgramDeclared === true || r.ihProgramDeclared === true,
    );
    const pa_declared = rows.some((r) => r.paProgramDeclared === true);
    const hm_declared = rows.some((r) => r.hmProgramDeclared === true);
    const partial = count > rows.length;
    const notices: string[] = [];
    if (partial) {
      notices.push(
        `Returned ${rows.length} of ${count} designated-area rows; program flags cover only fetched rows. False flags do not establish absence in the full declaration. Use fema_query_dataset with DisasterDeclarationsSummaries and filter disasterNumber eq ${input.disaster_number} for the full rows.`,
      );
    }
    if (!summary.ok)
      notices.push(
        'The OpenFEMA disaster funding summary could not be read. Retry to check funding totals.',
      );
    else if (!funding)
      notices.push('OpenFEMA has no disaster funding summary row for this declaration.');
    if (notices.length) ctx.enrich.notice(notices.join(' '));

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
      ...(funding ? { funding } : {}),
      ...(partial ? { areas_truncated: true, total_designated_area_count: count } : {}),
    };
  },

  format: (result) => {
    if (requiresJson(result)) return [{ type: 'text', text: renderJson(result) }];
    const lines: string[] = [];
    const label = result.declaration_type
      ? `${result.declaration_type}-${result.disaster_number}`
      : `Disaster #${result.disaster_number}`;
    lines.push(`# ${literal(label)} — ${literal(result.title)}`);
    lines.push(
      `**State:** ${literal(result.state)} | **Type:** ${literal(result.declaration_type)} | **Incident:** ${literal(result.incident_type)}`,
    );
    lines.push(`**Declared:** ${literal(result.declaration_date)}`);
    if (result.incident_begin_date) {
      lines.push(
        `**Incident Period:** ${literal(result.incident_begin_date)}${result.incident_end_date ? ` → ${literal(result.incident_end_date)}` : ' (ongoing)'}`,
      );
    }
    if (result.funding) {
      const f = result.funding;
      lines.push(
        '',
        '## Disaster-wide funding',
        `**IA approved registrations:** ${f.ia_approved_registrations}`,
        `**IHP approved (USD):** ${f.ihp_approved}`,
        `**Housing Assistance approved (USD):** ${f.ha_approved}`,
        `**Other Needs Assistance approved (USD):** ${f.ona_approved}`,
        `**PA obligated (USD):** ${f.pa_obligated}`,
        `**PA categories A–B obligated (USD):** ${f.pa_obligated_cat_ab}`,
        `**PA categories C–G obligated (USD):** ${f.pa_obligated_cat_c_g}`,
        `**HMGP obligated (USD):** ${f.hmgp_obligated}`,
        `**IA data load date:** ${f.ia_load_date === null ? 'null' : literal(f.ia_load_date)}`,
        `**PA data load date:** ${f.pa_load_date === null ? 'null' : literal(f.pa_load_date)}`,
        '',
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
          ? ` (FIPS ${literal(area.fips_state_code + area.fips_county_code)})`
          : '';
      const areaPrograms: string[] = [];
      if (area.ia_declared) areaPrograms.push('IA');
      if (area.pa_declared) areaPrograms.push('PA');
      if (area.hm_declared) areaPrograms.push('HM');
      lines.push(
        `- ${literal(area.area)}${fips} — ${areaPrograms.length ? areaPrograms.join(', ') : 'None'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
