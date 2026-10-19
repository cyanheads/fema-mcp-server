/**
 * @fileoverview Tests for fema_get_public_assistance tool.
 * @module tests/tools/fema-get-public-assistance.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';
import { femaGetPublicAssistance } from '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js';

// Only the service accessor is stubbed: the county matcher runs the real escapeODataString.
vi.mock('@/services/openfema/openfema-service.js', async (importOriginal) => {
  let _mockSvc: Record<string, unknown>;
  return {
    ...(await importOriginal<object>()),
    getOpenFemaService: () => _mockSvc,
    initOpenFemaService: () => {},
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
    // Federal share plus administrative costs — never the project amount.
    totalObligated: 381250,
    county: 'Harris',
    stateAbbreviation: 'TX',
    projectStatus: 'Eligible',
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
      project_amount: 500000,
      federal_share_obligated: 375000,
      total_obligated: 381250,
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

  it('returns zero-match success with program guidance on both surfaces', async () => {
    await setMock({
      fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    });
    const result = await runToolContract(femaGetPublicAssistance, { disaster_number: 9999 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      projects: [],
      total_count: 0,
      returned_count: 0,
      notice: expect.stringContaining('fema_get_disaster'),
    });
    expect(contentText(result)).toContain('fema_get_disaster');
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
          total_obligated: 381250,
          federal_share_obligated: 375000,
          project_amount: 500000,
          project_status: 'Eligible',
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
    expect(text).toContain('**Total Obligated:** $381,250');
    expect(text).toContain('**Federal Share Obligated:** $375,000');
    expect(text).toContain('**Project Amount:** $500,000');
    expect(text).toContain('Status: Eligible | Size: Large');
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

  async function filterSent(input: Record<string, unknown>): Promise<string> {
    const result = await runToolContract(femaGetPublicAssistance, input);
    expect(result.isError).not.toBe(true);
    expect(fetchPaProjects).toHaveBeenCalledTimes(1);
    const [[options]] = fetchPaProjects.mock.calls as [[{ filter: string }]];
    return options.filter;
  }

  it('keeps matching a county spelled as stored (#41)', async () => {
    expect(await filterSent({ disaster_number: 4332, county: 'Harris' })).toContain(
      "substringof('Harris', county)",
    );
  });

  it.each(['LaSalle Parish', 'Chugach REAA'])(
    'includes exact PA spelling for %s in every input case (#52)',
    async (stored) => {
      for (const county of [stored, stored.toLowerCase(), stored.toUpperCase()]) {
        fetchPaProjects.mockClear();
        expect(await filterSent({ state: 'LA', county })).toContain(
          `substringof('${stored}', county)`,
        );
      }
    },
  );

  it.each([
    ['harris', 'Harris'],
    ['HARRIS', 'Harris'],
    ['dekalb', 'DeKalb'],
    ['dekalb county', 'DeKalb County'],
    ['st. louis, city of', 'St. Louis, City of'],
    ["o'brien", "O''Brien"],
  ])('matches county %j case-insensitively by sending %j (#41)', async (county, stored) => {
    expect(await filterSent({ disaster_number: 4332, county })).toContain(
      `substringof('${stored}', county)`,
    );
  });

  it('or-joins county spellings in parentheses after the disaster number (#41)', async () => {
    expect(await filterSent({ disaster_number: 4332, county: ' harris ' })).toBe(
      'disasterNumber eq 4332 and ' +
        "(substringof('Harris', county) or substringof('harris', county) or substringof('HARRIS', county))",
    );
  });

  it.each(['', '  '])('treats county %j as unset (#41)', async (county) => {
    expect(await filterSent({ disaster_number: 4332, county })).toBe('disasterNumber eq 4332');
  });

  it('describes county as a case-insensitive substring match (#41)', () => {
    expect(femaGetPublicAssistance.input.shape.county.description).toMatch(
      /case-insensitive substring/i,
    );
  });
});

describe('femaGetPublicAssistance — empty match', () => {
  it('keeps a state-only search scoped when suggesting a broader search', async () => {
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }) });
    const result = await runToolContract(femaGetPublicAssistance, { state: 'TX' });
    expect(result.isError).not.toBe(true);
    expect(contentText(result)).toContain('Try a different state');
    expect(contentText(result)).not.toContain('removing state');
  });
  it.each([0, 50])('returns zero-match success at offset %s on both surfaces', async (offset) => {
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows: [], count: 0 }) });
    const result = await runToolContract(femaGetPublicAssistance, {
      disaster_number: 9999,
      offset,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      projects: [],
      total_count: 0,
      returned_count: 0,
      notice: expect.stringContaining('fema_get_disaster'),
    });
    expect(contentText(result)).toContain('No PA projects matched');
    expect(contentText(result)).not.toMatch(/last valid offset|county|state code/);
    expect(result.structuredContent).not.toHaveProperty('next_offset');
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

  it('names the next offset on a full page at the limit (#46)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makePaRow({ pwNumber: i + 1 }));
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows, count: 10 }) });
    const result = await runToolContract(femaGetPublicAssistance, { state: 'TX', limit: 3 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      returned_count: 3,
      total_count: 10,
      totalCount: 10,
      next_offset: 3,
      notice:
        'Returned 3 of the 10 matching PA projects from offset 0, as many as limit allows; continue with offset 3.',
    });
  });

  it('adds no notice and no next_offset to the last page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makePaRow({ pwNumber: i + 1 }));
    await setMock({ fetchPaProjects: vi.fn().mockResolvedValue({ rows, count: 10 }) });
    const result = await runToolContract(femaGetPublicAssistance, {
      state: 'TX',
      limit: 5,
      offset: 7,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ returned_count: 3, total_count: 10 });
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('next_offset');
  });
});

describe('femaGetPublicAssistance — response budget and next_offset (#46)', () => {
  const BUDGET = 100_000;
  /** Project `i` of an ordered match, its JSON longer than its text block; pw_number identifies it. */
  const project = (i: number) =>
    makePaRow({ pwNumber: i + 1, applicationTitle: `Applicant ${i} ${'w'.repeat(200)}` });
  /** Project `i` with amounts only, its text block (labels, $ and thousands separators) longer than its JSON. */
  const amountsOnly = (i: number) => ({
    disasterNumber: 4781,
    pwNumber: i + 1,
    projectAmount: 123_456_789_012.5,
    federalShareObligated: 98_765_432_109.25,
    totalObligated: 99_999_999_999.75,
  });

  /** A fetchPaProjects that serves `total` projects the way OpenFEMA pages them. */
  async function serve(total: number, row: (i: number) => object = project) {
    const fetchPaProjects = vi
      .fn()
      .mockImplementation(({ skip = 0, top = 1000 }: { skip?: number; top?: number }) =>
        Promise.resolve({
          rows: Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, k) =>
            row(skip + k),
          ),
          count: total,
        }),
      );
    await setMock({ fetchPaProjects });
    return fetchPaProjects;
  }

  /** The text format() renders for one project: its block, without the page header. */
  const block = (p: Record<string, unknown>) =>
    (
      femaGetPublicAssistance.format!({
        projects: [p as never],
        total_count: 1,
        returned_count: 1,
      })[0] as { text: string }
    ).text
      .replace('**1 of 1 PA projects**\n\n', '')
      .replace(/\n$/, '');

  it('accepts limit 10000 and rejects 10001', async () => {
    await serve(5);
    const ok = await runToolContract(femaGetPublicAssistance, { state: 'TX', limit: 10_000 });
    expect(ok.isError).not.toBe(true);
    const over = await runToolContract(femaGetPublicAssistance, { state: 'TX', limit: 10_001 });
    expect(over.isError).toBe(true);
    expect(errorOf(over).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([
    ['its JSON', project],
    ['its text block', amountsOnly],
  ])(
    'cuts limit 10000 to whole projects within 100,000 characters on each surface when %s is longer',
    async (longer, row) => {
      const fetchPaProjects = await serve(8_000, row);
      const result = await runToolContract(femaGetPublicAssistance, {
        disaster_number: 4781,
        limit: 10_000,
      });
      const structured = result.structuredContent as {
        projects: Array<Record<string, unknown>>;
        next_offset?: number;
        notice?: string;
        total_count: number;
      };
      const charge = (p: Record<string, unknown>) =>
        Math.max(JSON.stringify(p).length, block(p).length) + 2;
      const projects = structured.projects;
      const [first = {}] = projects;
      const [json, text] = [JSON.stringify(first).length, block(first).length];
      expect(longer === 'its JSON' ? json > text : text > json).toBe(true);
      expect(projects.length).toBeGreaterThan(1);
      const used = projects.reduce((n, p) => n + charge(p), 0);
      expect(used).toBeLessThanOrEqual(BUDGET);
      // One more project would cross the budget: the cut is the most that fit.
      expect(used + charge(projects.at(-1) ?? {})).toBeGreaterThan(BUDGET);
      expect(projects.map((p) => p.pw_number)).toEqual(
        Array.from({ length: projects.length }, (_, i) => i + 1),
      );
      expect(structured.total_count).toBe(8_000);
      expect(structured.next_offset).toBe(projects.length);
      expect(structured.notice).toBe(
        `Returned ${projects.length} of the 8000 matching PA projects from offset 0, the most that fit the 100,000-character response budget; continue with offset ${projects.length}.`,
      );
      const content = contentText(result);
      expect(
        content.slice(content.indexOf('## '), content.indexOf('\n> ')).length,
      ).toBeLessThanOrEqual(BUDGET);
      /**
       * Projects past the most any page could hold are never requested. The cheapest project
       * carries only its disaster number and renders as "## PW-unknown\n**Disaster:** #0"
       * (30 characters, longer than its 21-character JSON), so no page holds more than
       * floor(100,000 / (30 + 2)) = 3,125.
       */
      expect(block({ disaster_number: 0 })).toHaveLength(30);
      expect(fetchPaProjects.mock.calls[0]?.[0].top).toBe(3_125);
    },
  );

  it('pages a match by next_offset until it is absent, every project exactly once', async () => {
    await serve(1_500);
    const seen: unknown[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const structured = (
        await runToolContract(femaGetPublicAssistance, { state: 'TX', limit: 10_000, offset })
      ).structuredContent as { projects: Array<{ pw_number: number }>; next_offset?: number };
      expect(structured.projects.length).toBeGreaterThan(0);
      seen.push(...structured.projects.map((p) => p.pw_number));
      offset = structured.next_offset;
      pages++;
    }
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(Array.from({ length: 1_500 }, (_, i) => i + 1));
  });
});

describe('femaGetPublicAssistance — amount, size, and status descriptions (#44)', () => {
  /** A project field's description, as advertised in the tool's output schema. */
  function described(field: string): string {
    const schema = z.toJSONSchema(femaGetPublicAssistance.output, { io: 'output' }) as unknown as {
      properties: { projects: { items: { properties: Record<string, { description: string }> } } };
    };
    return schema.properties.projects.items.properties[field]?.description ?? '';
  }

  it('total_obligated is federal share plus administrative costs, never a non-federal share', () => {
    const text = described('total_obligated');
    expect(text).toMatch(/federal share/i);
    expect(text).toMatch(/administrative costs/i);
    expect(text).toContain('equals federal_share_obligated when no administrative costs');
    expect(text).toContain('0 when nothing is obligated');
    expect(text).not.toMatch(/all funding sources/i);
  });

  it('project_amount is the damage-survey estimate without administrative costs', () => {
    const text = described('project_amount');
    expect(text).toMatch(/damage survey/i);
    expect(text).toMatch(/without administrative costs/i);
  });

  it('project_size names the upstream values and a fiscal-year threshold, with no fixed dollar figure', () => {
    const text = described('project_size');
    expect(text).toMatch(/\bLarge\b/);
    expect(text).toMatch(/\bSmall\b/);
    expect(text).toMatch(/fiscal year/i);
    expect(text).not.toMatch(/\$|\d|"(small|large)"/);
  });

  it('project_status is eligibility status with the values OpenFEMA reports', () => {
    const text = described('project_status');
    expect(text).toMatch(/eligibility status/i);
    for (const value of ['Eligible', 'Pending Eligibility Review', 'Ineligible', 'Withdrawn']) {
      expect(text).toContain(value);
    }
    expect(text).not.toMatch(/Obligated|Closed|In Progress/);
  });
});

describe('femaGetPublicAssistance — format() text, whole (characterization)', () => {
  it('renders the header and one blank-line-separated block per project, sparse ones included', () => {
    const text = (
      femaGetPublicAssistance.format!({
        projects: [
          {
            disaster_number: 4332,
            pw_number: 12,
            applicant_id: '201-99201-00',
            application_title: 'Harris County',
            damage_category_code: 'B',
            damage_category_description: 'Protective Measures',
            project_amount: 1500.5,
            federal_share_obligated: 1125.38,
            total_obligated: 1200,
            county: 'Harris',
            state: 'TX',
            project_status: 'Eligible',
            project_size: 'Large',
            first_obligation_date: '2017-10-01T00:00:00.000Z',
          },
          { disaster_number: 4332 },
        ],
        total_count: 6616,
        returned_count: 2,
      })[0] as { text: string }
    ).text;
    expect(text).toBe(
      '**2 of 6616 PA projects**\n\n## Harris County\n**Disaster:** #4332\n**Applicant ID:** 201-99201-00\n**Damage Category:** B — Protective Measures\n**Total Obligated:** $1,200\n**Federal Share Obligated:** $1,125.38\n**Project Amount:** $1,500.5\nStatus: Eligible | Size: Large | County: Harris | State: TX | PW: 12\n**First Obligated:** 2017-10-01T00:00:00.000Z\n\n## PW-unknown\n**Disaster:** #4332\n',
    );
  });
});
