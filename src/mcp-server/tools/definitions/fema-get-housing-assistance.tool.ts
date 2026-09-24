/**
 * @fileoverview Tool: fema_get_housing_assistance — IA housing assistance data for a disaster.
 * @module mcp-server/tools/definitions/fema-get-housing-assistance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';
import { US_STATES } from '@/services/openfema/us-states.js';

export const femaGetHousingAssistance = tool('fema_get_housing_assistance', {
  title: 'Get FEMA Housing Assistance Data',
  description:
    'Retrieve Individual Assistance (IA) housing data for a disaster by disaster number. ' +
    'Returns owner and/or renter breakdowns by county and ZIP code — valid registrations, ' +
    'total approved IHP amounts, repair/rental amounts, and inspection data. ' +
    'Use type to select owners, renters, or both (default). ' +
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
    type: z
      .enum(['owners', 'renters', 'both'])
      .default('both')
      .describe('Which housing assistance dataset to query: owners, renters, or both (default).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe('Maximum records per dataset to return (default 100).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
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
          })
          .describe('Renter housing assistance aggregated by county and ZIP for one disaster.'),
      )
      .describe(
        'Renter (HousingAssistanceRenters) records. Empty when type is "owners" or no renter data exists.',
      ),
    owners_count: z
      .number()
      .describe('Total owner records available before the per-dataset limit.'),
    renters_count: z
      .number()
      .describe('Total renter records available before the per-dataset limit.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Paging guidance when offset is at or past the end of a queried dataset — names its total and last valid offset.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total owner + renter records available before the per-dataset limit — exceeds the returned count when either dataset was capped.',
      ),
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
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No IA housing records found for this disaster.',
      recovery:
        'IA housing data may take weeks to appear after a declaration. Verify the disaster number via fema_get_disaster and try again later.',
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

    const baseFilter = [`disasterNumber eq ${input.disaster_number}`];
    if (input.state?.trim()) {
      baseFilter.push(`state eq '${input.state}'`);
    }
    const filter = baseFilter.join(' and ');

    const queryOpts = {
      filter,
      orderby: 'totalApprovedIhpAmount desc',
      top: input.limit,
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

    if (ownersData.length === 0 && rentersData.length === 0 && pastEnd.length === 0) {
      throw ctx.fail('no_results', `No IA housing records for disaster ${input.disaster_number}.`, {
        disasterNumber: input.disaster_number,
        ...ctx.recoveryFor('no_results'),
        recovery: {
          hint: `No housing assistance records found for disaster ${input.disaster_number}. IA housing data may take weeks to appear after a declaration. Verify the disaster number via fema_get_disaster and try again later.`,
        },
      });
    }

    const mapRow = (r: (typeof ownersData)[0]) => ({
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
    });

    ctx.enrich.total(ownersCount + rentersCount);
    if (pastEnd.length > 0) {
      const ends = pastEnd.map(
        (d) => `the ${d.total} ${d.label} records (last valid offset ${d.total - 1})`,
      );
      ctx.enrich.notice(`Offset ${input.offset} is past the end of ${ends.join(' and ')}.`);
    }
    ctx.log.info('Housing assistance fetch complete', {
      disasterNumber: input.disaster_number,
      owners: ownersData.length,
      renters: rentersData.length,
    });

    return {
      owners: ownersData.map(mapRow),
      renters: rentersData.map(mapRow),
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
      for (const o of result.owners) {
        const loc = [o.county, o.city, o.zip_code].filter(Boolean).join(', ');
        const locLabel = loc || `Disaster #${o.disaster_number}`;
        lines.push(`### ${locLabel}`);
        lines.push(
          o.state
            ? `**State:** ${o.state} | **Disaster:** #${o.disaster_number}`
            : `**Disaster:** #${o.disaster_number}`,
        );
        if (o.valid_registrations != null)
          lines.push(`**Registrations:** ${o.valid_registrations}`);
        if (o.approved_for_fema_assistance != null)
          lines.push(`**Approved for FEMA Assistance:** ${o.approved_for_fema_assistance}`);
        if (o.total_approved_ihp_amount != null)
          lines.push(`**Total Approved IHP:** $${o.total_approved_ihp_amount.toLocaleString()}`);
        if (o.repair_replace_amount != null)
          lines.push(`**Repair/Replacement:** $${o.repair_replace_amount.toLocaleString()}`);
        if (o.rental_amount != null)
          lines.push(`**Rental Assistance:** $${o.rental_amount.toLocaleString()}`);
        if (o.other_needs_amount != null)
          lines.push(`**Other Needs:** $${o.other_needs_amount.toLocaleString()}`);
        lines.push('');
      }
    }

    if (result.renters.length > 0) {
      lines.push(
        `## Renter Assistance (${result.renters.length} of ${result.renters_count} records)`,
      );
      for (const r of result.renters) {
        const loc = [r.county, r.city, r.zip_code].filter(Boolean).join(', ');
        const locLabel = loc || `Disaster #${r.disaster_number}`;
        lines.push(`### ${locLabel}`);
        lines.push(
          r.state
            ? `**State:** ${r.state} | **Disaster:** #${r.disaster_number}`
            : `**Disaster:** #${r.disaster_number}`,
        );
        if (r.valid_registrations != null)
          lines.push(`**Registrations:** ${r.valid_registrations}`);
        if (r.approved_for_fema_assistance != null)
          lines.push(`**Approved for FEMA Assistance:** ${r.approved_for_fema_assistance}`);
        if (r.total_approved_ihp_amount != null)
          lines.push(`**Total Approved IHP:** $${r.total_approved_ihp_amount.toLocaleString()}`);
        if (r.rental_amount != null)
          lines.push(`**Rental Assistance:** $${r.rental_amount.toLocaleString()}`);
        if (r.other_needs_amount != null)
          lines.push(`**Other Needs:** $${r.other_needs_amount.toLocaleString()}`);
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
