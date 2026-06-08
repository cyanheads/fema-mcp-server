/**
 * @fileoverview Resource: fema://disaster/{disasterNumber} — disaster declaration summary.
 * @module mcp-server/resources/definitions/fema-disaster
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFemaService } from '@/services/openfema/openfema-service.js';

export const femaDisasterResource = resource('fema://disaster/{disasterNumber}', {
  name: 'FEMA Disaster Declaration',
  description:
    'Summary for a specific FEMA disaster declaration — title, state, incident type, ' +
    'programs declared (IA/PA/HM), incident period, and designated area count. ' +
    'Read-once context injection for agents already holding a disaster number.',
  params: z.object({
    disasterNumber: z
      .string()
      .describe(
        'FEMA disaster number as a string (e.g., "4781"). Obtain from fema_search_disasters.',
      ),
  }),

  async handler(params, ctx) {
    const num = parseInt(params.disasterNumber, 10);
    if (Number.isNaN(num) || num <= 0) {
      throw notFound(
        `Invalid disaster number "${params.disasterNumber}". Expected a positive integer.`,
        { disasterNumber: params.disasterNumber },
      );
    }
    // OpenFEMA's OData layer stores disasterNumber as Int16 (max 32767).
    // Numbers above that produce a raw type-mismatch API error — treat as not-found.
    if (num > 32767) {
      throw notFound(`Disaster number ${num} not found in FEMA records.`, { disasterNumber: num });
    }

    const svc = getOpenFemaService();
    const { rows } = await svc.fetchDisasters(
      {
        filter: `disasterNumber eq ${num}`,
        select:
          'disasterNumber,declarationTitle,state,incidentType,declarationType,' +
          'declarationDate,incidentBeginDate,incidentEndDate,' +
          'ihProgramDeclared,paProgramDeclared,hmProgramDeclared',
        top: 500,
      },
      ctx,
    );

    if (rows.length === 0) {
      throw notFound(`Disaster number ${num} not found in FEMA records.`, { disasterNumber: num });
    }

    // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above via notFound throw
    const first = rows[0]!;
    // OR program flags across all area-rows: declared for ANY area = declared for the disaster.
    const programs: string[] = [];
    if (rows.some((r) => r.ihProgramDeclared === true)) programs.push('IA');
    if (rows.some((r) => r.paProgramDeclared === true)) programs.push('PA');
    if (rows.some((r) => r.hmProgramDeclared === true)) programs.push('HM');

    const summary = {
      disaster_number: first.disasterNumber ?? num,
      title: first.declarationTitle ?? 'Unknown',
      state: first.state ?? '',
      incident_type: first.incidentType ?? '',
      declaration_type: first.declarationType ?? '',
      declaration_date: first.declarationDate ?? '',
      incident_begin_date: first.incidentBeginDate,
      incident_end_date: first.incidentEndDate,
      programs_declared: programs,
      designated_area_count: rows.length,
    };

    ctx.log.info('Disaster resource fetched', { disasterNumber: num });

    return summary;
  },
});
