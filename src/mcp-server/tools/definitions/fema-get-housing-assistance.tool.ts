/**
 * @fileoverview Tool: fema_get_housing_assistance — IA housing assistance data for a disaster.
 * @module mcp-server/tools/definitions/fema-get-housing-assistance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaGetHousingAssistance = tool('fema_get_housing_assistance', {
  title: 'Get FEMA Housing Assistance Data',
  description:
    'Retrieve Individual Assistance (IA) housing data for a disaster by disaster number. ' +
    'Returns owner and/or renter breakdowns by county and ZIP code — valid registrations, ' +
    'total approved IHP amounts, repair/rental amounts, and inspection data. ' +
    'Use type to select owners, renters, or both (default). ' +
    'IA housing data is only available when ia_declared: true on the disaster (check via fema_get_disaster). ' +
    'Use disaster_number from fema_search_disasters.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    disaster_number: z
      .number()
      .int()
      .positive()
      .describe('FEMA disaster number. Obtain from fema_search_disasters.'),
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
            zip_code: z.string().optional().describe('5-digit ZIP code. Absent when not recorded.'),
            valid_registrations: z
              .number()
              .optional()
              .describe(
                'Number of valid IA registrations from homeowners in this area. Absent when zero or not reported.',
              ),
            approved_for_fema_assistance: z
              .number()
              .optional()
              .describe(
                'Number of homeowner registrations approved for any FEMA assistance. Absent when zero or not reported.',
              ),
            total_approved_ihp_amount: z
              .number()
              .optional()
              .describe(
                'Total Individuals and Households Program (IHP) assistance approved in USD. Absent when zero or not reported.',
              ),
            repair_replace_amount: z
              .number()
              .optional()
              .describe(
                'Home repair and replacement assistance in USD. Absent when zero or not reported.',
              ),
            rental_amount: z
              .number()
              .optional()
              .describe('Rental assistance granted in USD. Absent when zero or not reported.'),
            other_needs_amount: z
              .number()
              .optional()
              .describe(
                'Other needs assistance (personal property, transportation, etc.) in USD. Absent when zero or not reported.',
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
            zip_code: z.string().optional().describe('5-digit ZIP code. Absent when not recorded.'),
            valid_registrations: z
              .number()
              .optional()
              .describe(
                'Number of valid IA registrations from renters in this area. Absent when zero or not reported.',
              ),
            approved_for_fema_assistance: z
              .number()
              .optional()
              .describe(
                'Number of renter registrations approved for any FEMA assistance. Absent when zero or not reported.',
              ),
            total_approved_ihp_amount: z
              .number()
              .optional()
              .describe(
                'Total IHP assistance approved for renters in USD. Absent when zero or not reported.',
              ),
            rental_amount: z
              .number()
              .optional()
              .describe('Rental assistance granted in USD. Absent when zero or not reported.'),
            other_needs_amount: z
              .number()
              .optional()
              .describe('Other needs assistance in USD. Absent when zero or not reported.'),
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
    notice: z.string().optional().describe('Guidance when no results were found.'),
  },
  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No IA housing records found for this disaster.',
      recovery:
        'Check that ia_declared is true for this disaster using fema_get_disaster. IA housing data may take weeks to appear after a declaration.',
    },
  ],

  async handler(input, ctx) {
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

    if (ownersData.length === 0 && rentersData.length === 0) {
      ctx.enrich.notice(
        `No housing assistance records found for DR-${input.disaster_number}. Verify IA was declared via fema_get_disaster.`,
      );
      throw ctx.fail('no_results', `No IA housing records for disaster ${input.disaster_number}.`, {
        disasterNumber: input.disaster_number,
        ...ctx.recoveryFor('no_results'),
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
    const lines: string[] = [];

    if (result.owners.length > 0) {
      lines.push(`## Owner Assistance (${result.owners.length} of ${result.owners_count} records)`);
      for (const o of result.owners) {
        const loc = [o.county, o.city, o.zip_code].filter(Boolean).join(', ');
        const locLabel = loc || `DR-${o.disaster_number}`;
        lines.push(`### ${locLabel}`);
        if (o.state) lines.push(`**State:** ${o.state} | **Disaster:** DR-${o.disaster_number}`);
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
        const locLabel = loc || `DR-${r.disaster_number}`;
        lines.push(`### ${locLabel}`);
        if (r.state) lines.push(`**State:** ${r.state} | **Disaster:** DR-${r.disaster_number}`);
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

    if (lines.length === 0) {
      lines.push('No housing assistance records available.');
      lines.push(`owners_count: ${result.owners_count}`);
      lines.push(`renters_count: ${result.renters_count}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
