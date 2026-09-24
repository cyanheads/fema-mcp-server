/**
 * @fileoverview Tests for fema_get_public_assistance tool.
 * @module tests/tools/fema-get-public-assistance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';
import { femaGetPublicAssistance } from '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js';

vi.mock('@/services/openfema/openfema-service.js', () => {
  let _mockSvc: Record<string, unknown>;
  return {
    getOpenFemaService: () => _mockSvc,
    initOpenFemaService: () => {},
    escapeODataString: (value: string) => value.replace(/'/g, "''"),
    __setMock: (svc: Record<string, unknown>) => {
      _mockSvc = svc;
    },
  };
});

async function setMock(impl: Record<string, unknown>) {
  const mod = await import('@/services/openfema/openfema-service.js');
  (mod as unknown as { __setMock: (s: Record<string, unknown>) => void }).__setMock(impl);
}

function makePaRow(overrides: Record<string, unknown> = {}) {
  return {
    disasterNumber: 4781,
    pwNumber: 1,
    applicantId: 'TXHC',
    applicationTitle: 'Harris County Road Repair',
    damageCategoryCode: 'C',
    damageCategoryDescrip: 'Roads and Bridges',
    projectAmount: 500000,
    federalShareObligated: 375000,
    totalObligated: 500000,
    county: 'Harris',
    stateAbbreviation: 'TX',
    projectStatus: 'Obligated',
    projectSize: 'Large',
    firstObligationDate: '2024-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('femaGetPublicAssistance', () => {
  beforeEach(async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({
        rows: [makePaRow()],
        count: 1,
      }),
    });
  });

  it('returns PA project records for a disaster', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      disaster_number: 4781,
      pw_number: 1,
      damage_category_code: 'C',
      total_obligated: 500000,
    });
    expect(result.total_count).toBe(1);
    expect(result.returned_count).toBe(1);
  });

  it('returns projects when only state is provided', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ state: 'TX' });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects).toHaveLength(1);
  });

  it('throws missing_filter when neither disaster_number nor state provided', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({});
    await expect(femaGetPublicAssistance.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_filter' },
    });
  });

  it('throws no_results when query returns empty rows', async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 9999 });
    await expect(femaGetPublicAssistance.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('throws invalid_state for unknown state codes', async () => {
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ state: 'ZZ' });
    await expect(femaGetPublicAssistance.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state' },
    });
  });

  it('handles sparse PA rows with missing optional fields', async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({
        rows: [{ disasterNumber: 4781 }],
        count: 1,
      }),
    });
    const ctx = createMockContext({ errors: femaGetPublicAssistance.errors });
    const input = femaGetPublicAssistance.input.parse({ disaster_number: 4781 });
    const result = await femaGetPublicAssistance.handler(input, ctx);
    expect(result.projects[0]?.disaster_number).toBe(4781);
    expect(result.projects[0]?.total_obligated).toBeUndefined();
    expect(result.projects[0]?.project_status).toBeUndefined();
  });

  it('formats output with obligated amounts', () => {
    const output = {
      projects: [
        {
          disaster_number: 4781,
          pw_number: 1,
          application_title: 'Road Repair',
          damage_category_code: 'C',
          damage_category_description: 'Roads and Bridges',
          total_obligated: 500000,
          federal_share_obligated: 375000,
          project_amount: 500000,
          project_status: 'Obligated',
          project_size: 'Large',
          county: 'Harris',
        },
      ],
      total_count: 5,
      returned_count: 1,
    };
    const blocks = femaGetPublicAssistance.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Road Repair');
    expect(text).toContain('500,000');
    // PA records carry no declaration type — render a type-agnostic label, never DR-.
    expect(text).toContain('**Disaster:** #4781');
    expect(text).not.toContain('DR-4781');
  });
});

/** Every text block of a tool result, joined — format() output plus the enrichment trailer. */
function contentText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
}

type ErrorEnvelope = {
  code: number;
  data: { reason?: string; recovery?: { hint: string } };
};

function errorOf(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

describe('femaGetPublicAssistance — filters reaching OpenFEMA', () => {
  let fetchPaProjects: Mock;

  beforeEach(async () => {
    fetchPaProjects = vi.fn().mockResolvedValue({ rows: [makePaRow()], count: 1 });
    await setMock({ fetchPaProjects });
  });

  it('passes disaster number 32767, the top of the FEMA range, through to OpenFEMA', async () => {
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 32767 });
    expect(result.isError).not.toBe(true);
    expect(fetchPaProjects).toHaveBeenCalledTimes(1);
    expect(fetchPaProjects.mock.calls[0]?.[0]).toMatchObject({
      filter: 'disasterNumber eq 32767',
    });
  });

  it('scopes a state-only call by state alone', async () => {
    const result = await runToolContract(femaGetPublicAssistance, { state: 'TX' });
    expect(result.isError).not.toBe(true);
    expect(fetchPaProjects.mock.calls[0]?.[0]).toMatchObject({
      filter: "stateAbbreviation eq 'TX'",
    });
  });
});

describe('femaGetPublicAssistance — empty match', () => {
  it('returns no_results with its contract code and recovery on both surfaces', async () => {
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }) });
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 9999 });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('no_results');
    expect(error.data.recovery?.hint).toBe(
      'No Public Assistance projects found for the given filters. Verify the disaster has PA declared (pa_declared: true via fema_get_disaster) or check the state code. Recent disasters may have incomplete records.',
    );
    expect(contentText(result)).toContain('No PA project records found.');
  });
});

describe('femaGetPublicAssistance — disaster numbers above the FEMA range (#23)', () => {
  const getDisasterNotFound = femaGetDisaster.errors?.find((e) => e.reason === 'not_found');

  it('declares not_found with the same code and recovery as fema_get_disaster', () => {
    const entry = femaGetPublicAssistance.errors?.find((e) => e.reason === 'not_found');
    expect(getDisasterNotFound).toBeDefined();
    expect(entry?.code).toBe(getDisasterNotFound?.code);
    expect(entry?.recovery).toBe(getDisasterNotFound?.recovery);
  });

  it('fails 32768 as not_found without calling OpenFEMA', async () => {
    const fetchPaProjects = vi.fn();
    await setMock({ fetchPaProjects });
    const result = await runToolContract(femaGetPublicAssistance, {
      disaster_number: 32768,
      limit: 1,
    });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('not_found');
    expect(error.data.recovery?.hint).toBe(getDisasterNotFound?.recovery);
    expect(contentText(result)).toContain(`Recovery: ${getDisasterNotFound?.recovery}`);
    expect(fetchPaProjects).not.toHaveBeenCalled();
  });
});

describe('femaGetPublicAssistance — offset past the end (#32)', () => {
  it('returns an empty page with the total and a notice naming the last valid offset', async () => {
    const fetchPaProjects = vi.fn().mockResolvedValue({ rows: [], count: 1157 });
    await setMock({ fetchPaProjects });
    const result = await runToolContract(femaGetPublicAssistance, {
      disaster_number: 4781,
      offset: 100000,
    });
    expect(result.isError).not.toBe(true);
    expect(fetchPaProjects.mock.calls[0]?.[0]).toMatchObject({ skip: 100000 });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      projects: [],
      total_count: 1157,
      returned_count: 0,
      totalCount: 1157,
    });
    const notice = structured.notice as string;
    expect(notice).toContain('Offset 100000');
    expect(notice).toContain('1157 matching PA projects');
    expect(notice).toContain('last valid offset is 1156');
    const text = contentText(result);
    expect(text).toContain('0 of 1157 PA projects');
    expect(text).toContain(notice);
    expect(text).not.toMatch(/\bno\b[^.\n]*\b(records|projects)\b/i);
  });

  it('treats an offset exactly at the total as past the end', async () => {
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 5 }) });
    const result = await runToolContract(femaGetPublicAssistance, { state: 'TX', offset: 5 });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'last valid offset is 4',
    );
  });

  it('adds no notice to a page that has rows, including a full page at the limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makePaRow({ pwNumber: i + 1 }));
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows, count: 10 }) });
    const result = await runToolContract(femaGetPublicAssistance, { state: 'TX', limit: 3 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ returned_count: 3, total_count: 10, totalCount: 10 });
    expect(structured).not.toHaveProperty('notice');
  });
});
