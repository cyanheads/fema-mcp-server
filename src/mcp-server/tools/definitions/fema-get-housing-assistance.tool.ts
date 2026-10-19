/**
 * @fileoverview Tool: fema_get_housing_assistance — IA housing assistance data for a disaster.
 * @module mcp-server/tools/definitions/fema-get-housing-assistance
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
import type { RawHousingAssistance } from '@/services/openfema/types.js';
import { US_STATES } from '@/services/openfema/us-states.js';

const ZIP_CODE = /^\d{5}$/;

/** Fields owner and renter records share, as the tool returns them. */
interface AreaRecord {
  approved_for_fema_assistance?: number | undefined;
  city?: string | undefined;
  county?: string | undefined;
  disaster_number: number;
  other_needs_amount?: number | undefined;
  rental_amount?: number | undefined;
  repair_replace_amount?: number | undefined;
  state?: string | undefined;
  total_approved_ihp_amount?: number | undefined;
  total_inspected?: number | undefined;
  valid_registrations?: number | undefined;
  zip_code?: string | undefined;
}

interface OwnerRecord extends AreaRecord {
  average_fema_inspected_damage?: number | undefined;
  no_fema_inspected_damage?: number | undefined;
  total_damage?: number | undefined;
}

interface RenterRecord extends AreaRecord {
  total_inspected_with_no_damage?: number | undefined;
  total_with_major_damage?: number | undefined;
  total_with_moderate_damage?: number | undefined;
  total_with_substantial_damage?: number | undefined;
}

/** The lines owner and renter blocks share: location heading, state, counts, and amounts. */
function areaLines(r: AreaRecord): string[] {
  const loc = [r.county, r.city, r.zip_code].filter(Boolean).join(', ');
  const lines = [
    `### ${loc || `Disaster #${r.disaster_number}`}`,
    r.state
      ? `**State:** ${r.state} | **Disaster:** #${r.disaster_number}`
      : `**Disaster:** #${r.disaster_number}`,
  ];
  if (r.valid_registrations != null) lines.push(`**Registrations:** ${r.valid_registrations}`);
  if (r.approved_for_fema_assistance != null)
    lines.push(`**Approved for FEMA Assistance:** ${r.approved_for_fema_assistance}`);
  if (r.total_approved_ihp_amount != null)
    lines.push(`**Total Approved IHP:** $${r.total_approved_ihp_amount.toLocaleString()}`);
  if (r.repair_replace_amount != null)
    lines.push(`**Repair/Replacement:** $${r.repair_replace_amount.toLocaleString()}`);
  if (r.rental_amount != null)
    lines.push(`**Rental Assistance:** $${r.rental_amount.toLocaleString()}`);
  if (r.other_needs_amount != null)
    lines.push(`**Other Needs:** $${r.other_needs_amount.toLocaleString()}`);
  return lines;
}

/** The text block `format()` renders for one owner record — also what the response budget charges it. */
function renderOwner(o: OwnerRecord): string {
  const lines = areaLines(o);
  if (o.total_inspected === 0) {
    // FEMA files 0 damage for an area nobody inspected — that 0 is no inspection, not $0.
    lines.push('**Inspection:** none recorded (0 applicants inspected); damage unknown');
  } else {
    if (o.total_inspected != null) lines.push(`**Inspected:** ${o.total_inspected}`);
    if (o.average_fema_inspected_damage != null)
      lines.push(
        `**Average Inspected Damage:** $${o.average_fema_inspected_damage.toLocaleString()}`,
      );
    if (o.total_damage != null)
      lines.push(`**Total Damage (FEMA Verified Loss):** $${o.total_damage.toLocaleString()}`);
    if (o.no_fema_inspected_damage != null)
      lines.push(`**Inspected With No Damage:** ${o.no_fema_inspected_damage}`);
  }
  return lines.join('\n');
}

/** The text block `format()` renders for one renter record — also what the response budget charges it. */
function renderRenter(r: RenterRecord): string {
  const lines = areaLines(r);
  if (r.total_inspected != null) lines.push(`**Inspected:** ${r.total_inspected}`);
  const degrees = [
    ['none', r.total_inspected_with_no_damage],
    ['moderate', r.total_with_moderate_damage],
    ['major', r.total_with_major_damage],
    ['substantial', r.total_with_substantial_damage],
  ].flatMap(([label, n]) => (n != null ? [`${label} ${n}`] : []));
  if (degrees.length > 0) lines.push(`**Damage Degree (registrations):** ${degrees.join(', ')}`);
  return lines.join('\n');
}

const ownerCharge = (o: OwnerRecord) => rowCharge(o, renderOwner(o));
const renterCharge = (r: RenterRecord) => rowCharge(r, renderRenter(r));

/** No record costs less than one carrying only its disaster number, so no page holds more. */
const MAX_PAGE_ROWS = maxRowsWithinBudget(
  Math.min(ownerCharge({ disaster_number: 0 }), renterCharge({ disaster_number: 0 })),
);

export const femaGetHousingAssistance = tool('fema_get_housing_assistance', {
  title: 'Get FEMA Housing Assistance Data',
  description:
    'Retrieve Individual Assistance (IA) housing data for a disaster by disaster number. ' +
    'Returns owner and/or renter records aggregated by county, city, and ZIP code — valid registrations, ' +
    'total approved IHP amounts, repair/rental/other-needs amounts, and inspection counts (owners also carry inspected damage in USD). ' +
    'Narrow with state, county, or zip_code; owners_count, renters_count, and offset then count the filtered records. ' +
    'Use type to select owners, renters, or both (default). ' +
    'A page holds at most 100,000 characters of records, owners and renters cut at the same row count so one offset continues both; when records remain past it, next_offset is the offset to continue from. ' +
    'Use disaster_number from fema_search_disasters.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    disaster_number: z
      .number()
      .int()
      .positive()
      .describe(
        'FEMA disaster number. Obtain from fema_search_disasters. Numbers above 32767 match no declaration.',
      ),
    state: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe('Two-letter state code to narrow results when a disaster spans multiple states.'),
    county: z
      .string()
      .optional()
      .describe(
        'Filter by county name (e.g., Harris, dekalb). Case-insensitive substring match: harris also matches Harrison. OpenFEMA stores the county with its type, such as Harris (County) or Evangeline (Parish), and as the applicant reported it.',
      ),
    zip_code: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(ZIP_CODE, 'ZIP code must be exactly 5 digits (e.g., 77084).')
          .describe('5-digit ZIP code.'),
      ])
      .optional()
      .describe(
        'Filter by 5-digit ZIP code, as a string with leading zeros kept (e.g., 77084, 00609). ZIP+4 is not accepted. One ZIP can return several records, one per county and city spelling.',
      ),
    type: z
      .enum(['owners', 'renters', 'both'])
      .default('both')
      .describe('Which housing assistance dataset to query: owners, renters, or both (default).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100)
      .describe(
        'Maximum records per dataset to return (1–10000, default 100). A page also stops at 100,000 characters of owner and renter records together, cutting both datasets at the same row count; when either bound leaves matching records out, next_offset names the offset to continue from.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset into each queried dataset (default 0). Pass the previous page’s next_offset to continue both.',
      ),
  }),
  output: z.object({
    owners: z
      .array(
        z
          .object({
            disaster_number: z.number().describe('FEMA disaster number this record belongs to.'),
            state: z
              .string()
              .optional()
              .describe('Two-letter state code. Absent when not recorded.'),
            county: z.string().optional().describe('County name. Absent when not recorded.'),
            city: z.string().optional().describe('City name. Absent when not recorded.'),
            zip_code: z
              .string()
              .optional()
              .describe(
                '5-digit ZIP code; 00000 when OpenFEMA files the records under no ZIP code. Absent when not recorded.',
              ),
            valid_registrations: z
              .number()
              .optional()
              .describe(
                'Number of valid IA registrations from homeowners in this area. Absent when not reported.',
              ),
            approved_for_fema_assistance: z
              .number()
              .optional()
              .describe(
                'Number of homeowner registrations approved for any FEMA assistance; 0 when none were. Absent when not reported.',
              ),
            total_approved_ihp_amount: z
              .number()
              .optional()
              .describe(
                'Total Individuals and Households Program (IHP) assistance approved in USD; 0 when none was. Absent when not reported.',
              ),
            repair_replace_amount: z
              .number()
              .optional()
              .describe(
                'Home repair and replacement assistance in USD; 0 when none was approved. Absent when not reported.',
              ),
            rental_amount: z
              .number()
              .optional()
              .describe(
                'Rental assistance granted in USD; 0 when none was. Absent when not reported.',
              ),
            other_needs_amount: z
              .number()
              .optional()
              .describe(
                'Other needs assistance (personal property, transportation, etc.) in USD; 0 when none was approved. Absent when not reported.',
              ),
            total_inspected: z
              .number()
              .optional()
              .describe(
                'Number of homeowner applicants who received a FEMA inspection. 0 means no one in this area was inspected, so a 0 in average_fema_inspected_damage or total_damage then means not inspected, not $0 of damage. Absent when not reported.',
              ),
            average_fema_inspected_damage: z
              .number()
              .optional()
              .describe(
                "Average damage in USD, under FEMA's inspection guidelines, of the homeowners with a completed inspection; 0 when no damage was recorded or no one was inspected (see total_inspected). Measured separately from total_damage, so it is not total_damage divided by a count. Absent when not reported.",
              ),
            total_damage: z
              .number()
              .optional()
              .describe(
                'Total damage in USD recorded at the latest inspections: FEMA Verified Loss for real property (the home) and personal property, excluding transportation; 0 when none was recorded or no one was inspected (see total_inspected). Absent when not reported.',
              ),
            no_fema_inspected_damage: z
              .number()
              .optional()
              .describe(
                'Number of inspected homeowner applicants whose inspector recorded no damage; 0 when there were none. Absent when not reported.',
              ),
          })
          .describe('Homeowner housing assistance aggregated by county and ZIP for one disaster.'),
      )
      .describe(
        'Homeowner (HousingAssistanceOwners) records. Empty when type is "renters" or no owner data exists.',
      ),
    renters: z
      .array(
        z
          .object({
            disaster_number: z.number().describe('FEMA disaster number this record belongs to.'),
            state: z
              .string()
              .optional()
              .describe('Two-letter state code. Absent when not recorded.'),
            county: z.string().optional().describe('County name. Absent when not recorded.'),
            city: z.string().optional().describe('City name. Absent when not recorded.'),
            zip_code: z
              .string()
              .optional()
              .describe(
                '5-digit ZIP code; 00000 when OpenFEMA files the records under no ZIP code. Absent when not recorded.',
              ),
            valid_registrations: z
              .number()
              .optional()
              .describe(
                'Number of valid IA registrations from renters in this area. Absent when not reported.',
              ),
            approved_for_fema_assistance: z
              .number()
              .optional()
              .describe(
                'Number of renter registrations approved for any FEMA assistance; 0 when none were. Absent when not reported.',
              ),
            total_approved_ihp_amount: z
              .number()
              .optional()
              .describe(
                'Total IHP assistance approved for renters in USD; 0 when none was. Absent when not reported.',
              ),
            repair_replace_amount: z
              .number()
              .optional()
              .describe(
                "Home repair and replacement assistance in USD as OpenFEMA records it for renters; 0 when none was approved, as in nearly every renter area, since FEMA's data dictionary notes renters are not eligible for it. Absent when not reported.",
              ),
            rental_amount: z
              .number()
              .optional()
              .describe(
                'Rental assistance granted in USD; 0 when none was. Absent when not reported.',
              ),
            other_needs_amount: z
              .number()
              .optional()
              .describe(
                'Other needs assistance in USD; 0 when none was approved. Absent when not reported.',
              ),
            total_inspected: z
              .number()
              .optional()
              .describe(
                'Number of renter applicants who received a FEMA inspection; 0 when none did. Absent when not reported.',
              ),
            total_inspected_with_no_damage: z
              .number()
              .optional()
              .describe(
                'Number of valid renter registrations assigned no damage. Renters get a damage degree rather than a full home inspection, so this and the other degree counts count registrations and can exceed total_inspected; 0 when there were none. Absent when not reported.',
              ),
            total_with_moderate_damage: z
              .number()
              .optional()
              .describe(
                'Number of valid renter registrations assigned a moderate degree of damage, counted like total_inspected_with_no_damage; 0 when there were none. Absent when not reported.',
              ),
            total_with_major_damage: z
              .number()
              .optional()
              .describe(
                'Number of valid renter registrations assigned a major degree of damage, counted like total_inspected_with_no_damage; 0 when there were none. Absent when not reported.',
              ),
            total_with_substantial_damage: z
              .number()
              .optional()
              .describe(
                'Number of valid renter registrations assigned a substantial degree of damage, counted like total_inspected_with_no_damage; 0 when there were none. Absent when not reported.',
              ),
          })
          .describe(
            'Renter housing assistance aggregated by county and ZIP for one disaster. Renter records carry no dollar damage figures.',
          ),
      )
      .describe(
        'Renter (HousingAssistanceRenters) records. Empty when type is "owners" or no renter data exists.',
      ),
    owners_count: z
      .number()
      .describe(
        'Total owner records matching the disaster and any state, county, or zip_code filter, before the per-dataset limit.',
      ),
    renters_count: z
      .number()
      .describe(
        'Total renter records matching the disaster and any state, county, or zip_code filter, before the per-dataset limit.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Zero-match guidance for supplied filters and declared programs, or paging guidance: the continuation offset and whether limit or the response budget ended the page, and each queried nonzero dataset’s total and last valid offset when past its end.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, for both datasets: offset plus the larger of the owner and renter record counts returned. Present only while records remain in a queried dataset; pass it as offset to continue.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total owner + renter records available before the per-dataset limit — exceeds the returned count when either dataset was capped.',
      ),
    county_filter: z
      .string()
      .optional()
      .describe(
        'The county name both datasets were filtered by, trimmed, matched as a case-insensitive substring. Absent when county was not set.',
      ),
    zip_code_filter: z
      .string()
      .optional()
      .describe(
        'The 5-digit ZIP code both datasets were filtered by. Absent when zip_code was not set.',
      ),
  },
  enrichmentTrailer: {
    next_offset: { label: 'Next offset' },
    county_filter: { label: 'County filter (case-insensitive substring)' },
    zip_code_filter: { label: 'ZIP code filter' },
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
  ],

  async handler(input, ctx) {
    if (input.state && !US_STATES.has(input.state)) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a valid US state/territory code.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    // OpenFEMA stores disasterNumber as Int16; a larger number names no declaration.
    if (input.disaster_number > 32767) {
      throw ctx.fail(
        'not_found',
        `No disaster declaration found with number ${input.disaster_number}.`,
        { disasterNumber: input.disaster_number, ...ctx.recoveryFor('not_found') },
      );
    }

    const svc = getOpenFemaService();

    const county = input.county?.trim() || undefined;
    const zipCode = input.zip_code || undefined;

    // One $filter for both datasets, so each $inlinecount and $skip covers the filtered records.
    const baseFilter = [`disasterNumber eq ${input.disaster_number}`];
    if (input.state?.trim()) {
      baseFilter.push(`state eq '${input.state}'`);
    }
    if (county) baseFilter.push(anySubstringFilter('county', countySpellings(county)));
    if (zipCode) baseFilter.push(`zipCode eq '${zipCode}'`);
    const filter = baseFilter.join(' and ');

    const queryOpts = {
      filter,
      orderby: 'totalApprovedIhpAmount desc',
      top: Math.min(input.limit, MAX_PAGE_ROWS),
      skip: input.offset,
    };

    const fetchOwners = input.type === 'owners' || input.type === 'both';
    const fetchRenters = input.type === 'renters' || input.type === 'both';

    const [ownersResult, rentersResult] = await Promise.all([
      fetchOwners ? svc.fetchHousingAssistance('HousingAssistanceOwners', queryOpts, ctx) : null,
      fetchRenters ? svc.fetchHousingAssistance('HousingAssistanceRenters', queryOpts, ctx) : null,
    ]);

    const ownersData = ownersResult?.rows ?? [];
    const rentersData = rentersResult?.rows ?? [];
    const ownersCount = ownersResult?.count ?? 0;
    const rentersCount = rentersResult?.count ?? 0;

    // A queried dataset with records but none on this page: the offset is past its end.
    const pastEnd = [
      { label: 'owner', rows: ownersData.length, total: ownersCount },
      { label: 'renter', rows: rentersData.length, total: rentersCount },
    ].filter((d) => d.rows === 0 && d.total > 0);

    const mapArea = (r: RawHousingAssistance): AreaRecord => ({
      disaster_number: r.disasterNumber ?? input.disaster_number,
      ...(r.state ? { state: r.state } : {}),
      ...(r.county ? { county: r.county } : {}),
      ...(r.city ? { city: r.city } : {}),
      ...(r.zipCode ? { zip_code: r.zipCode } : {}),
      ...(r.validRegistrations != null ? { valid_registrations: r.validRegistrations } : {}),
      ...(r.approvedForFemaAssistance != null
        ? { approved_for_fema_assistance: r.approvedForFemaAssistance }
        : {}),
      ...(r.totalApprovedIhpAmount != null
        ? { total_approved_ihp_amount: r.totalApprovedIhpAmount }
        : {}),
      ...(r.repairReplaceAmount != null ? { repair_replace_amount: r.repairReplaceAmount } : {}),
      ...(r.rentalAmount != null ? { rental_amount: r.rentalAmount } : {}),
      ...(r.otherNeedsAmount != null ? { other_needs_amount: r.otherNeedsAmount } : {}),
      ...(r.totalInspected != null ? { total_inspected: r.totalInspected } : {}),
    });

    const mapOwner = (r: RawHousingAssistance): OwnerRecord => ({
      ...mapArea(r),
      ...(r.averageFemaInspectedDamage != null
        ? { average_fema_inspected_damage: r.averageFemaInspectedDamage }
        : {}),
      ...(r.totalDamage != null ? { total_damage: r.totalDamage } : {}),
      ...(r.noFemaInspectedDamage != null
        ? { no_fema_inspected_damage: r.noFemaInspectedDamage }
        : {}),
    });

    const mapRenter = (r: RawHousingAssistance): RenterRecord => ({
      ...mapArea(r),
      ...(r.totalInspectedWithNoDamage != null
        ? { total_inspected_with_no_damage: r.totalInspectedWithNoDamage }
        : {}),
      ...(r.totalWithModerateDamage != null
        ? { total_with_moderate_damage: r.totalWithModerateDamage }
        : {}),
      ...(r.totalWithMajorDamage != null
        ? { total_with_major_damage: r.totalWithMajorDamage }
        : {}),
      ...(r.totalWithSubstantialDamage != null
        ? { total_with_substantial_damage: r.totalWithSubstantialDamage }
        : {}),
    });

    // One row count for both datasets, so one offset continues both: row i costs the owner
    // and the renter record at index i together.
    const ownersAll = ownersData.map(mapOwner);
    const rentersAll = rentersData.map(mapRenter);
    const returned = rowsWithinBudget(Math.max(ownersAll.length, rentersAll.length), (i) => {
      const o = ownersAll[i];
      const r = rentersAll[i];
      return (o ? ownerCharge(o) : 0) + (r ? renterCharge(r) : 0);
    });
    const owners = ownersAll.slice(0, returned);
    const renters = rentersAll.slice(0, returned);
    const nextOffset = input.offset + returned;

    ctx.enrich.total(ownersCount + rentersCount);
    if (county) ctx.enrich({ county_filter: county });
    if (zipCode) ctx.enrich({ zip_code_filter: zipCode });
    const notice: string[] = [];
    if (ownersCount + rentersCount === 0) {
      const filters = [
        input.state && 'state',
        county && `county matching "${county}"`,
        zipCode && `ZIP ${zipCode}`,
      ].filter(Boolean);
      notice.push(
        `No IA housing records matched for disaster ${input.disaster_number}. ` +
          (filters.length > 0 ? `Broaden the search by removing ${filters.join(' or ')}. ` : '') +
          'Check the declaration’s IA program with fema_get_disaster; housing data may take weeks to appear.',
      );
    }
    if (pastEnd.length > 0) {
      const ends = pastEnd.map(
        (d) => `the ${d.total} ${d.label} records (last valid offset ${d.total - 1})`,
      );
      notice.push(`Offset ${input.offset} is past the end of ${ends.join(' and ')}.`);
    }
    if (returned > 0 && nextOffset < Math.max(ownersCount, rentersCount)) {
      ctx.enrich({ next_offset: nextOffset });
      const parts = [
        { label: 'owner', rows: owners.length, total: ownersCount },
        { label: 'renter', rows: renters.length, total: rentersCount },
      ].filter((d) => d.rows > 0);
      notice.push(
        continuationNotice(
          parts.map((d) => `${d.rows} of the ${d.total} ${d.label} records`).join(' and '),
          input.offset,
          nextOffset,
          returned < input.limit,
        ),
      );
    }
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));
    ctx.log.info('Housing assistance fetch complete', {
      disasterNumber: input.disaster_number,
      owners: owners.length,
      renters: renters.length,
      fetched: Math.max(ownersAll.length, rentersAll.length),
    });

    return {
      owners,
      renters,
      owners_count: ownersCount,
      renters_count: rentersCount,
    };
  },

  format: (result) => {
    const lines = [
      `**Owner records:** ${result.owners.length} of ${result.owners_count}`,
      `**Renter records:** ${result.renters.length} of ${result.renters_count}`,
      '',
    ];

    if (result.owners.length === 0 && result.renters.length === 0) {
      lines.push(
        result.owners_count + result.renters_count === 0
          ? 'No housing assistance records available.'
          : 'This page is empty: the offset is past the end of the records counted above.',
      );
    }

    if (result.owners.length > 0) {
      lines.push(`## Owner Assistance (${result.owners.length} of ${result.owners_count} records)`);
      for (const o of result.owners) lines.push(renderOwner(o), '');
    }

    if (result.renters.length > 0) {
      lines.push(
        `## Renter Assistance (${result.renters.length} of ${result.renters_count} records)`,
      );
      for (const r of result.renters) lines.push(renderRenter(r), '');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
