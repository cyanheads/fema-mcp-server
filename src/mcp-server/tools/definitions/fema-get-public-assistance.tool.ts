/**
 * @fileoverview Tool: fema_get_public_assistance — PA funded project details for a disaster or state.
 * @module mcp-server/tools/definitions/fema-get-public-assistance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  continuationNotice,
  maxRowsWithinBudget,
  rowCharge,
  rowsWithinBudget,
} from '@/mcp-server/tools/response-budget.js';
import { anySubstringFilter, countySpellings } from '@/services/openfema/name-matcher.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';
import { US_STATES } from '@/services/openfema/us-states.js';

/** A project as the tool returns it. */
interface Project {
  applicant_id?: string | undefined;
  application_title?: string | undefined;
  county?: string | undefined;
  damage_category_code?: string | undefined;
  damage_category_description?: string | undefined;
  disaster_number: number;
  federal_share_obligated?: number | undefined;
  first_obligation_date?: string | undefined;
  project_amount?: number | undefined;
  project_size?: string | undefined;
  project_status?: string | undefined;
  pw_number?: number | undefined;
  state?: string | undefined;
  total_obligated?: number | undefined;
}

/** The text block `format()` renders for one project — also what the response budget charges it. */
function renderProject(p: Project): string {
  const lines: string[] = [];
  const title = p.application_title ?? `PW-${p.pw_number ?? 'unknown'}`;
  lines.push(`## ${title}`);
  lines.push(`**Disaster:** #${p.disaster_number}`);
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
  return lines.join('\n');
}

const projectCharge = (p: Project) => rowCharge(p, renderProject(p));

/** No project costs less than one carrying only its disaster number, so no page holds more. */
const MAX_PAGE_ROWS = maxRowsWithinBudget(projectCharge({ disaster_number: 0 }));

export const femaGetPublicAssistance = tool('fema_get_public_assistance', {
  title: 'Get FEMA Public Assistance Projects',
  description:
    'Retrieve Public Assistance (PA) funded project records for a disaster or state — shows where federal recovery money was obligated. ' +
    'Returns applicant, damage category, project size and status, federal share obligated, and total obligated amounts. ' +
    'Either disaster_number or state must be provided. ' +
    'Use disaster_number (from fema_search_disasters) to scope to a single declaration, or state to browse all PA projects for a state. ' +
    'PA projects are created only when the PA program is declared (pa_declared: true on the disaster). ' +
    'A page holds at most 100,000 characters of projects; when projects remain past it, next_offset is the offset to continue from.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    disaster_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'FEMA disaster number to scope results to a single declaration. Numbers above 32767 match no declaration.',
      ),
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe('Two-letter state code to browse all PA projects for a state.'),
    county: z
      .string()
      .optional()
      .describe(
        'Filter by county name (e.g., Harris, dekalb). Case-insensitive substring match: harris also matches Harrison.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100)
      .describe(
        'Maximum number of projects to return (1–10000, default 100). A page also stops at 100,000 characters of projects (roughly 220 projects); when either bound leaves matching projects out, next_offset names the offset to continue from.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset (default 0). Pass the previous page’s next_offset to continue.'),
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
              .describe(
                "Estimated total eligible cost of the project in USD from FEMA's damage survey, without administrative costs. Absent when not yet determined.",
              ),
            federal_share_obligated: z
              .number()
              .optional()
              .describe(
                'Federal dollars obligated for this project in USD; 0 when nothing is obligated.',
              ),
            total_obligated: z
              .number()
              .optional()
              .describe(
                'Federal share of the eligible project amount plus State (recipient) and applicant (subrecipient) administrative costs, in USD; equals federal_share_obligated when no administrative costs are recorded. Holds no non-federal share. 0 when nothing is obligated.',
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
                'Eligibility status of the project: Eligible (nearly all projects), Pending Eligibility Review, Ineligible, or Withdrawn. Absent when not set.',
              ),
            project_size: z
              .string()
              .optional()
              .describe(
                'Large or Small, set by comparing the eligible amount from the damage survey with the large-project threshold FEMA sets for each fiscal year. Absent when unclassified.',
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
      .describe(
        'Public assistance funded project records from offset onward, bounded by limit and by 100,000 characters of projects.',
      ),
    total_count: z.number().describe('Total matching projects before pagination.'),
    returned_count: z.number().describe('Number of projects in this response.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Paging guidance: the offset to continue from and whether limit or the response budget ended the page, or, when offset is at or past the end, the total and the last valid offset.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page: offset plus returned_count. Present only while matching projects remain past this page; pass it as offset to continue.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching projects before pagination — exceeds returned_count when results were capped at the limit.',
      ),
  },
  enrichmentTrailer: {
    next_offset: { label: 'Next offset' },
  },
  errors: [
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The state parameter is not a valid 2-letter US state/territory code.',
      recovery:
        'Provide a valid 2-letter US state code such as TX, CA, FL, or PR. Check the full list at FEMA.gov.',
    },
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither disaster_number nor state was provided.',
      recovery:
        'Provide at least one of disaster_number (from fema_search_disasters) or state (2-letter code) to scope the query.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The disaster number is above 32767, the highest number OpenFEMA holds, so no declaration exists.',
      recovery:
        'Verify the disaster number using fema_search_disasters. FEMA disaster numbers are typically 4-digit integers.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No PA project records found for the given filters.',
      recovery:
        'Verify the disaster has PA declared (pa_declared: true via fema_get_disaster) or check the state code. Recent disasters may have incomplete records.',
    },
    {
      reason: 'request_too_long',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The county value makes the request URL longer than the roughly 8,900 characters OpenFEMA accepts.',
      recovery:
        'Shorten county to the county name being searched for; stored county names are a few words long.',
    },
  ],

  async handler(input, ctx) {
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    if (!input.disaster_number && !input.state?.trim()) {
      throw ctx.fail('missing_filter', 'Either disaster_number or state must be provided.', {
        ...ctx.recoveryFor('missing_filter'),
      });
    }

    // OpenFEMA stores disasterNumber as Int16; a larger number names no declaration.
    if (input.disaster_number !== undefined && input.disaster_number > 32767) {
      throw ctx.fail(
        'not_found',
        `No disaster declaration found with number ${input.disaster_number}.`,
        { disasterNumber: input.disaster_number, ...ctx.recoveryFor('not_found') },
      );
    }

    const filterParts: string[] = [];
    if (input.disaster_number) {
      filterParts.push(`disasterNumber eq ${input.disaster_number}`);
    }
    if (input.state?.trim()) {
      filterParts.push(`stateAbbreviation eq '${input.state}'`);
    }
    const counties = countySpellings(input.county ?? '');
    if (counties.length > 0) filterParts.push(anySubstringFilter('county', counties));

    const svc = getOpenFemaService();
    const { rows, count } = await svc.fetchPaProjects(
      {
        filter: filterParts.join(' and '),
        orderby: 'totalObligated desc',
        top: Math.min(input.limit, MAX_PAGE_ROWS),
        skip: input.offset,
      },
      ctx,
    );

    if (rows.length === 0 && count === 0) {
      throw ctx.fail('no_results', 'No PA project records found.', {
        ...ctx.recoveryFor('no_results'),
        recovery: {
          hint: 'No Public Assistance projects found for the given filters. Verify the disaster has PA declared (pa_declared: true via fema_get_disaster) or check the state code. Recent disasters may have incomplete records.',
        },
      });
    }

    const fetched: Project[] = rows.map((r) => ({
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

    const returned = rowsWithinBudget(fetched.length, (i) =>
      projectCharge(fetched[i] ?? { disaster_number: 0 }),
    );
    const projects = fetched.slice(0, returned);
    const nextOffset = input.offset + returned;

    ctx.enrich.total(count);
    if (projects.length === 0) {
      ctx.enrich.notice(
        `Offset ${input.offset} is past the end of the ${count} matching PA projects; the last valid offset is ${count - 1}.`,
      );
    } else if (nextOffset < count) {
      ctx.enrich({ next_offset: nextOffset });
      ctx.enrich.notice(
        continuationNotice(
          `${returned} of the ${count} matching PA projects`,
          input.offset,
          nextOffset,
          returned < input.limit,
        ),
      );
    }
    ctx.log.info('PA projects fetch complete', { count, returned, fetched: fetched.length });
    return { projects, total_count: count, returned_count: returned };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.returned_count} of ${result.total_count} PA projects**\n`);
    for (const p of result.projects) lines.push(renderProject(p), '');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
