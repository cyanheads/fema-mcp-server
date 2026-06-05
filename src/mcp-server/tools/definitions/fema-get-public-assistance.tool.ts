/**
 * @fileoverview Tool: fema_get_public_assistance — PA funded project details for a disaster or state.
 * @module mcp-server/tools/definitions/fema-get-public-assistance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaGetPublicAssistance = tool('fema_get_public_assistance', {
  title: 'Get FEMA Public Assistance Projects',
  description:
    'Retrieve Public Assistance (PA) funded project records for a disaster or state — shows where federal recovery money was obligated. ' +
    'Returns applicant, damage category, project size and status, federal share obligated, and total obligated amounts. ' +
    'Either disaster_number or state must be provided. ' +
    'Use disaster_number (from fema_search_disasters) to scope to a single declaration, or state to browse all PA projects for a state. ' +
    'PA projects are created only when the PA program is declared (pa_declared: true on the disaster).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    disaster_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('FEMA disaster number to scope results to a single declaration.'),
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe('Two-letter state code to browse all PA projects for a state.'),
    county: z.string().optional().describe('Filter by county name substring.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe('Maximum number of projects to return (1–1000, default 100).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
  }),
  output: z.object({
    projects: z
      .array(
        z
          .object({
            disaster_number: z.number().describe('FEMA disaster number this project belongs to.'),
            pw_number: z
              .number()
              .optional()
              .describe('Project Worksheet number assigned by FEMA. Absent when not yet assigned.'),
            applicant_id: z
              .string()
              .optional()
              .describe(
                'FEMA applicant identifier for the recipient organization. Absent when not recorded.',
              ),
            application_title: z
              .string()
              .optional()
              .describe('Name of the applicant organization or project. Absent when not recorded.'),
            damage_category_code: z
              .string()
              .optional()
              .describe(
                'FEMA damage category code (e.g., A=Debris Removal, B=Emergency Protective Measures, C=Roads and Bridges). Absent when unclassified.',
              ),
            damage_category_description: z
              .string()
              .optional()
              .describe(
                'Human-readable name for the damage category code. Absent when unclassified.',
              ),
            project_amount: z
              .number()
              .optional()
              .describe('Total estimated project cost in USD. Absent when not yet determined.'),
            federal_share_obligated: z
              .number()
              .optional()
              .describe(
                'Federal dollars obligated for this project in USD. Absent before obligation.',
              ),
            total_obligated: z
              .number()
              .optional()
              .describe(
                'Total obligated amount across all funding sources in USD. Absent before obligation.',
              ),
            county: z
              .string()
              .optional()
              .describe('County where the project is located. Absent when not recorded.'),
            state: z
              .string()
              .optional()
              .describe('Two-letter state abbreviation. Absent when not recorded.'),
            project_status: z
              .string()
              .optional()
              .describe(
                'Current project status (e.g., Obligated, Closed, In Progress). Absent when not set.',
              ),
            project_size: z
              .string()
              .optional()
              .describe(
                'Project size classification: "small" (≤$1M) or "large" (>$1M). Absent when unclassified.',
              ),
            first_obligation_date: z
              .string()
              .optional()
              .describe(
                'ISO 8601 date the first federal obligation was recorded. Absent before obligation.',
              ),
          })
          .describe('A single Public Assistance funded project record.'),
      )
      .describe('Public assistance funded project records.'),
    total_count: z.number().describe('Total matching projects before pagination.'),
    returned_count: z.number().describe('Number of projects in this response.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no results were found.'),
  },
  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither disaster_number nor state was provided.',
      recovery:
        'Provide at least one of disaster_number (from fema_search_disasters) or state (2-letter code) to scope the query.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No PA project records found for the given filters.',
      recovery:
        'Verify the disaster has PA declared (pa_declared: true via fema_get_disaster) or check the state code. Recent disasters may have incomplete records.',
    },
  ],

  async handler(input, ctx) {
    if (!input.disaster_number && !input.state?.trim()) {
      throw ctx.fail('missing_filter', 'Either disaster_number or state must be provided.', {
        ...ctx.recoveryFor('missing_filter'),
      });
    }

    const filterParts: string[] = [];
    if (input.disaster_number) {
      filterParts.push(`disasterNumber eq ${input.disaster_number}`);
    }
    if (input.state?.trim()) {
      filterParts.push(`stateAbbreviation eq '${input.state}'`);
    }
    if (input.county?.trim()) {
      filterParts.push(`substringof('${input.county}', county)`);
    }

    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchPaProjects(
      {
        filter: filterParts.join(' and '),
        orderby: 'totalObligated desc',
        top: input.limit,
        skip: input.offset,
      },
      ctx,
    );

    if (rows.length === 0) {
      ctx.enrich.notice(
        `No Public Assistance projects found for the given filters. Verify the disaster has PA declared via fema_get_disaster.`,
      );
      throw ctx.fail('no_results', 'No PA project records found.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    const projects = rows.map((r) => ({
      disaster_number: r.disasterNumber ?? 0,
      ...(r.pwNumber ? { pw_number: r.pwNumber } : {}),
      ...(r.applicantId ? { applicant_id: r.applicantId } : {}),
      ...(r.applicationTitle ? { application_title: r.applicationTitle } : {}),
      ...(r.damageCategoryCode ? { damage_category_code: r.damageCategoryCode } : {}),
      ...(r.damageCategoryDescrip ? { damage_category_description: r.damageCategoryDescrip } : {}),
      ...(r.projectAmount != null ? { project_amount: r.projectAmount } : {}),
      ...(r.federalShareObligated != null
        ? { federal_share_obligated: r.federalShareObligated }
        : {}),
      ...(r.totalObligated != null ? { total_obligated: r.totalObligated } : {}),
      ...(r.county ? { county: r.county } : {}),
      ...(r.stateAbbreviation ? { state: r.stateAbbreviation } : {}),
      ...(r.projectStatus ? { project_status: r.projectStatus } : {}),
      ...(r.projectSize ? { project_size: r.projectSize } : {}),
      ...(r.firstObligationDate ? { first_obligation_date: r.firstObligationDate } : {}),
    }));

    ctx.log.info('PA projects fetch complete', { count, returned: projects.length });
    return { projects, total_count: count, returned_count: projects.length };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.returned_count} of ${result.total_count} PA projects**\n`);
    for (const p of result.projects) {
      const title = p.application_title ?? `PW-${p.pw_number ?? 'unknown'}`;
      lines.push(`## ${title}`);
      lines.push(`**Disaster:** DR-${p.disaster_number}`);
      if (p.applicant_id) lines.push(`**Applicant ID:** ${p.applicant_id}`);
      if (p.damage_category_code) {
        lines.push(
          `**Damage Category:** ${p.damage_category_code}${p.damage_category_description ? ` — ${p.damage_category_description}` : ''}`,
        );
      }
      if (p.total_obligated != null) {
        lines.push(`**Total Obligated:** $${p.total_obligated.toLocaleString()}`);
      }
      if (p.federal_share_obligated != null) {
        lines.push(`**Federal Share Obligated:** $${p.federal_share_obligated.toLocaleString()}`);
      }
      if (p.project_amount != null) {
        lines.push(`**Project Amount:** $${p.project_amount.toLocaleString()}`);
      }
      const meta: string[] = [];
      if (p.project_status) meta.push(`Status: ${p.project_status}`);
      if (p.project_size) meta.push(`Size: ${p.project_size}`);
      if (p.county) meta.push(`County: ${p.county}`);
      if (p.state) meta.push(`State: ${p.state}`);
      if (p.pw_number) meta.push(`PW: ${p.pw_number}`);
      if (meta.length > 0) lines.push(meta.join(' | '));
      if (p.first_obligation_date) lines.push(`**First Obligated:** ${p.first_obligation_date}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
