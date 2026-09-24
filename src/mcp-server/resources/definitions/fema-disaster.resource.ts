/**
 * @fileoverview Resource: fema://disaster/{disasterNumber} — disaster declaration summary.
 * @module mcp-server/resources/definitions/fema-disaster
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
        'FEMA disaster number as a string of digits (e.g., "4781"), 1–32767. Obtain from fema_search_disasters.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The disaster number is malformed, out of range, or matches no declaration.',
      recovery:
        'Use fema_search_disasters to find a valid FEMA disaster number, then read the resource with it.',
    },
  ],

  async handler(params, ctx) {
    const raw = params.disasterNumber;
    const num = Number(raw);
    if (!/^\d+$/.test(raw) || num === 0) {
      throw ctx.fail(
        'not_found',
        `Invalid disaster number "${raw}". Expected a positive integer.`,
        { disasterNumber: raw, ...ctx.recoveryFor('not_found') },
      );
    }
    // OpenFEMA stores disasterNumber as Int16; a larger number names no declaration.
    if (num > 32767) {
      throw ctx.fail('not_found', `Disaster number ${raw} not found in FEMA records.`, {
        disasterNumber: raw,
        ...ctx.recoveryFor('not_found'),
      });
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
      throw ctx.fail('not_found', `Disaster number ${num} not found in FEMA records.`, {
        disasterNumber: num,
        ...ctx.recoveryFor('not_found'),
      });
    }

    // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above via ctx.fail throw
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
