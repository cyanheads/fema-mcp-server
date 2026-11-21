/**
 * @fileoverview Tool: fema_get_public_assistance — PA funded project details for a disaster or state.
 * @module mcp-server/tools/definitions/fema-get-public-assistance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline as literal } from '@cyanheads/mcp-ts-core/utils';
import { renderJson, renderNotice, requiresJson } from '@/mcp-server/tools/literal-markdown.js';
import {
  continuationNotice,
  maxRowsWithinBudget,
  rowCharge,
  rowsWithinBudget,
} from '@/mcp-server/tools/response-budget.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  assistanceCanvasTableSchema,
  assistanceDeadline,
  renderAssistanceCanvas,
  stageAssistance,
} from '@/services/canvas/stage-assistance.js';
import { anySubstringFilter, countySpellings } from '@/services/openfema/name-matcher.js';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';
import { paApplicantNames } from '@/services/openfema/pa-applicant-names.js';
import type { RawPaProject } from '@/services/openfema/types.js';
import { US_STATES } from '@/services/openfema/us-states.js';

/** A project as the tool returns it. */
type Project = {
  applicant_id?: string | undefined;
  applicant_name?: string | undefined;
  application_title?: string | undefined;
  county?: string | undefined;
  county_fips?: string | undefined;
  damage_category_code?: string | undefined;
  damage_category_description?: string | undefined;
  disaster_number: number;
  federal_share_obligated?: number | undefined;
  first_obligation_date?: string | undefined;
  last_obligation_date?: string | undefined;
  mitigation_amount?: number | undefined;
  project_amount?: number | undefined;
  project_process_step?: string | undefined;
  project_size?: string | undefined;
  project_status?: string | undefined;
  pw_number?: number | undefined;
  state?: string | undefined;
  total_obligated?: number | undefined;
};

const PA_COLUMNS: ColumnSchema[] = [
  { name: 'disaster_number', type: 'INTEGER' },
  { name: 'pw_number', type: 'INTEGER', nullable: true },
  { name: 'applicant_id', type: 'VARCHAR', nullable: true },
  { name: 'applicant_name', type: 'VARCHAR', nullable: true },
  { name: 'application_title', type: 'VARCHAR', nullable: true },
  { name: 'damage_category_code', type: 'VARCHAR', nullable: true },
  { name: 'damage_category_description', type: 'VARCHAR', nullable: true },
  { name: 'project_amount', type: 'DOUBLE', nullable: true },
  { name: 'federal_share_obligated', type: 'DOUBLE', nullable: true },
  { name: 'total_obligated', type: 'DOUBLE', nullable: true },
  { name: 'mitigation_amount', type: 'DOUBLE', nullable: true },
  { name: 'county', type: 'VARCHAR', nullable: true },
  { name: 'county_fips', type: 'VARCHAR', nullable: true },
  { name: 'state', type: 'VARCHAR', nullable: true },
  { name: 'project_status', type: 'VARCHAR', nullable: true },
  { name: 'project_process_step', type: 'VARCHAR', nullable: true },
  { name: 'project_size', type: 'VARCHAR', nullable: true },
  { name: 'first_obligation_date', type: 'VARCHAR', nullable: true },
  { name: 'last_obligation_date', type: 'VARCHAR', nullable: true },
];

function mapProject(r: RawPaProject, applicantName: string | undefined): Project {
  const { stateNumberCode, countyCode } = r;
  const countyFips =
    typeof stateNumberCode === 'string' &&
    /^\d{1,2}$/.test(stateNumberCode) &&
    typeof countyCode === 'string' &&
    /^\d{1,3}$/.test(countyCode)
      ? `${stateNumberCode.padStart(2, '0')}${countyCode.padStart(3, '0')}`
      : undefined;
  return {
    disaster_number: r.disasterNumber ?? 0,
    ...(r.pwNumber ? { pw_number: r.pwNumber } : {}),
    ...(r.applicantId ? { applicant_id: r.applicantId } : {}),
    ...(applicantName ? { applicant_name: applicantName } : {}),
    ...(r.applicationTitle ? { application_title: r.applicationTitle } : {}),
    ...(r.damageCategoryCode ? { damage_category_code: r.damageCategoryCode } : {}),
    ...(r.damageCategoryDescrip ? { damage_category_description: r.damageCategoryDescrip } : {}),
    ...(r.projectAmount != null ? { project_amount: r.projectAmount } : {}),
    ...(r.federalShareObligated != null
      ? { federal_share_obligated: r.federalShareObligated }
      : {}),
    ...(r.totalObligated != null ? { total_obligated: r.totalObligated } : {}),
    ...(r.mitigationAmount != null ? { mitigation_amount: r.mitigationAmount } : {}),
    ...(r.county ? { county: r.county } : {}),
    ...(countyFips ? { county_fips: countyFips } : {}),
    ...(r.stateAbbreviation ? { state: r.stateAbbreviation } : {}),
    ...(r.projectStatus ? { project_status: r.projectStatus } : {}),
    ...(r.projectProcessStep ? { project_process_step: r.projectProcessStep } : {}),
    ...(r.projectSize ? { project_size: r.projectSize } : {}),
    ...(r.firstObligationDate ? { first_obligation_date: r.firstObligationDate } : {}),
    ...(r.lastObligationDate ? { last_obligation_date: r.lastObligationDate } : {}),
  };
}

/** The text block `format()` renders for one project — also what the response budget charges it. */
function renderProject(p: Project): string {
  const lines: string[] = [];
  const title = p.application_title ?? `PW-${p.pw_number ?? 'unknown'}`;
  lines.push(`## ${literal(title)}`);
  lines.push(`**Disaster:** #${p.disaster_number}`);
  if (p.applicant_id) lines.push(`**Applicant ID:** ${literal(p.applicant_id)}`);
  if (p.applicant_name) lines.push(`**Applicant Name:** ${literal(p.applicant_name)}`);
  if (p.damage_category_code) {
    lines.push(
      `**Damage Category:** ${literal(p.damage_category_code)}${p.damage_category_description ? ` — ${literal(p.damage_category_description)}` : ''}`,
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
  if (p.mitigation_amount != null) {
    lines.push(
      `**Mitigation Amount:** $${p.mitigation_amount.toLocaleString('en-US', { maximumFractionDigits: 20 })}`,
    );
  }
  const meta: string[] = [];
  if (p.project_status) meta.push(`Status: ${literal(p.project_status)}`);
  if (p.project_size) meta.push(`Size: ${literal(p.project_size)}`);
  if (p.county) meta.push(`County: ${literal(p.county)}`);
  if (p.county_fips) meta.push(`County FIPS: ${literal(p.county_fips)}`);
  if (p.state) meta.push(`State: ${literal(p.state)}`);
  if (p.pw_number) meta.push(`PW: ${p.pw_number}`);
  if (meta.length > 0) lines.push(meta.join(' | '));
  if (p.first_obligation_date)
    lines.push(`**First Obligated:** ${literal(p.first_obligation_date)}`);
  if (p.last_obligation_date) lines.push(`**Last Obligated:** ${literal(p.last_obligation_date)}`);
  if (p.project_process_step)
    lines.push(`**Project Process Step:** ${literal(p.project_process_step)}`);
  return lines.join('\n');
}

const projectCharge = (p: Project) => rowCharge(p, renderProject(p));

/** No project costs less than one carrying only its disaster number, so no page holds more. */
const MAX_PAGE_ROWS = maxRowsWithinBudget(projectCharge({ disaster_number: 0 }));

export const femaGetPublicAssistance = tool('fema_get_public_assistance', {
  title: 'Get FEMA Public Assistance Projects',
  description:
    'Retrieve Public Assistance (PA) funded project records, including recipient name, damage category, project status, and federal obligations. Supply disaster_number from fema_search_disasters or a state code. A page holds up to 100,000 characters of projects. Use next_offset to continue. With DataCanvas enabled, an overflowing first page also stages up to 50,000 matching rows for fema_dataframe_query.',
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
        'Filter by county name (e.g., Harris, dekalb). Case-insensitive substring match: harris also matches Harrison. Recognized terminal County, Parish, Borough, and Census Area names accept plain or parenthesized types; unknown names retain original case fallbacks.',
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
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse a canvas returned by an earlier call. Used only when staging from offset 0; omit to stage on a new canvas.',
    ),
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
            applicant_name: z
              .string()
              .optional()
              .describe(
                'Recipient organization name from the applicant record for this disaster and applicant ID.',
              ),
            application_title: z
              .string()
              .optional()
              .describe("The application's free-form project title. Absent when not recorded."),
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
            county_fips: z
              .string()
              .optional()
              .describe(
                'Five-digit county FIPS code, including leading zeros. Absent when either component is unavailable.',
              ),
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
            project_process_step: z
              .string()
              .optional()
              .describe('Current FEMA project workflow step. Absent when not recorded.'),
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
            last_obligation_date: z
              .string()
              .optional()
              .describe(
                'ISO 8601 date the latest federal obligation was recorded. Absent before obligation.',
              ),
            mitigation_amount: z
              .number()
              .optional()
              .describe(
                'Proposed Section 406 mitigation amount in USD, including zero and negative adjustments.',
              ),
          })
          .describe('A single Public Assistance funded project record.'),
      )
      .describe(
        'Public assistance funded project records from offset onward, bounded by limit and by 100,000 characters of projects.',
      ),
    total_count: z.number().describe('Total matching projects before pagination.'),
    returned_count: z.number().describe('Number of projects in this response.'),
    spilled: z.boolean().describe('Whether the filtered match was staged on a DataCanvas.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID for querying the staged projects. Present after successful staging.',
    ),
    canvas_tables: z
      .array(assistanceCanvasTableSchema.describe('One staged Public Assistance project table.'))
      .optional()
      .describe('Staged table metadata. Present after successful staging.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on missing matches, inline continuation, incomplete applicant names, or DataCanvas staging.',
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
    notice: { render: renderNotice },
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
      reason: 'request_too_long',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The county value makes the request URL longer than the roughly 8,900 characters OpenFEMA accepts.',
      recovery:
        'Shorten county to the county name being searched for; stored county names are a few words long.',
    },
    {
      reason: 'canvas_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas supplied for PA staging is missing or expired.',
      recovery: 'Omit canvas_id to stage the same match on a fresh canvas.',
    },
  ],

  async handler(input, ctx) {
    const deadline = assistanceDeadline();
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
    const query = {
      filter: filterParts.join(' and '),
      orderby: 'totalObligated desc,gmProjectId,hash',
    };
    const { rows, count } = await svc.fetchPaProjects(
      {
        ...query,
        top: Math.min(input.limit, MAX_PAGE_ROWS),
        skip: input.offset,
      },
      ctx,
    );
    const names = paApplicantNames(svc, ctx, deadline);
    await names.load(rows);
    const project = (row: RawPaProject) => mapProject(row, names.get(row));
    const fetched = rows.map(project);

    const returned = rowsWithinBudget(fetched.length, (i) =>
      projectCharge(fetched[i] ?? { disaster_number: 0 }),
    );
    const projects = fetched.slice(0, returned);
    const nextOffset = input.offset + returned;

    ctx.enrich.total(count);
    const notices: string[] = [];
    if (count === 0) {
      const filters = [
        input.county?.trim() && 'county',
        input.state && input.disaster_number && 'state',
      ].filter(Boolean);
      notices.push(
        'No PA projects matched the filters. ' +
          (filters.length > 0 ? `Broaden the search by removing ${filters.join(' or ')}. ` : '') +
          (input.disaster_number
            ? 'Check the declaration’s PA program with fema_get_disaster; recent disasters may not yet have project records.'
            : 'Try a different state, or search again later; project records may not yet be published.'),
      );
    } else if (projects.length === 0) {
      notices.push(
        `Offset ${input.offset} is past the end of the ${count} matching PA projects; the last valid offset is ${count - 1}.`,
      );
    } else if (nextOffset < count) {
      ctx.enrich({ next_offset: nextOffset });
      notices.push(
        continuationNotice(
          `${returned} of the ${count} matching PA projects`,
          input.offset,
          nextOffset,
          returned < input.limit,
        ),
      );
    }
    const canvas =
      input.offset === 0 && returned > 0 && nextOffset < count ? getCanvas() : undefined;
    const staging = canvas
      ? await stageAssistance(
          canvas,
          input.canvas_id,
          [
            {
              dataset: 'PublicAssistanceFundedProjectsDetails',
              schema: PA_COLUMNS,
              count,
              firstRows: fetched,
              firstKeys: rows.map((row) => row.hash),
              async fetchPage(top, skip, signal) {
                const page = await svc.fetchPaProjects({ ...query, top, skip }, ctx, signal);
                await names.load(page.rows, signal);
                return {
                  rows: page.rows.map(project),
                  count: page.count,
                  keys: page.rows.map((row) => row.hash),
                };
              },
            },
          ],
          ctx,
          deadline,
        )
      : undefined;
    if (names.incomplete) notices.push('Some PA applicant names could not be looked up.');
    if (staging) notices.push(staging.notice);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    ctx.log.info('PA projects fetch complete', { count, returned, fetched: fetched.length });
    return {
      projects,
      total_count: count,
      returned_count: returned,
      ...(staging?.spilled
        ? { spilled: true, canvas_id: staging.canvas_id, canvas_tables: staging.canvas_tables }
        : { spilled: false }),
    };
  },

  format: (result) => {
    if (requiresJson(result)) return [{ type: 'text', text: renderJson(result) }];
    const lines: string[] = [];
    lines.push(
      `**${result.returned_count} of ${result.total_count} PA projects**`,
      ...renderAssistanceCanvas(result),
      '',
    );
    for (const p of result.projects) lines.push(renderProject(p), '');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
