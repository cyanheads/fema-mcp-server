/**
 * @fileoverview Parser-level checks for literal tool values and complete JSON fallbacks.
 * @module tests/tools/literal-rendering.test
 */
import { describe, expect, it } from 'vitest';
import { femaDataframeDescribe } from '@/mcp-server/tools/definitions/fema-dataframe-describe.tool.js';
import { femaDataframeDrop } from '@/mcp-server/tools/definitions/fema-dataframe-drop.tool.js';
import { femaDataframeQuery } from '@/mcp-server/tools/definitions/fema-dataframe-query.tool.js';
import { femaGetDisaster } from '@/mcp-server/tools/definitions/fema-get-disaster.tool.js';
import { femaGetHousingAssistance } from '@/mcp-server/tools/definitions/fema-get-housing-assistance.tool.js';
import { femaGetPublicAssistance } from '@/mcp-server/tools/definitions/fema-get-public-assistance.tool.js';
import { femaQueryDataset } from '@/mcp-server/tools/definitions/fema-query-dataset.tool.js';
import { femaSearchDisasters } from '@/mcp-server/tools/definitions/fema-search-disasters.tool.js';
import { femaSearchNfip } from '@/mcp-server/tools/definitions/fema-search-nfip.tool.js';
import {
  renderedText as inlineText,
  jsonFallback,
  markdown,
} from '../helpers/rendered-markdown.js';

function formatText(blocks: readonly { type: string; text?: string }[]): string {
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string')
    throw new Error('Expected one text result');
  return blocks[0].text;
}

describe('literal result rendering (#67)', () => {
  it('wires declaration headings, matched areas and per-area detail lists', () => {
    const declaration = {
      disaster_number: 1,
      title: '*title*',
      state: '<b>TX</b>',
      incident_type: '&amp;',
      declaration_type: '*DR*',
      declaration_date: 'date *literal*',
      designated_area_count: 1,
      ia_declared: true,
      pa_declared: false,
      hm_declared: false,
    };
    const area = {
      area: '[area](https://example.com)',
      ia_declared: true,
      pa_declared: false,
      hm_declared: false,
      fips_state_code: '<',
      fips_county_code: 'b>',
    };
    const search = femaSearchDisasters.output!.parse({
      declarations: [{ ...declaration, matched_areas: [area] }],
      returned_count: 1,
      total_declarations: 1,
      total_area_rows: 1,
    });
    const detail = femaGetDisaster.output!.parse({ ...declaration, designated_areas: [area] });
    for (const text of [
      formatText(femaSearchDisasters.format!(search)),
      formatText(femaGetDisaster.format!(detail)),
    ]) {
      const parsed = inlineText(text).join('\n');
      for (const value of [
        '*DR*-1 — *title*',
        '<b>TX</b>',
        '&amp;',
        'date *literal*',
        '[area](https://example.com)',
        'FIPS <b>',
      ])
        expect(parsed).toContain(value);
    }
  });
  it('wires housing location strings and NFIP claim/canvas labels', () => {
    const housing = femaGetHousingAssistance.output!.parse({
      owners: [{ disaster_number: 1, county: '*county*', city: '<city>', zip_code: '[zip]' }],
      renters: [],
      owners_count: 1,
      renters_count: 0,
    });
    expect(inlineText(formatText(femaGetHousingAssistance.format!(housing))).join('\n')).toContain(
      '*county*, <city>, [zip]',
    );
    const nfip = femaSearchNfip.output!.parse({
      claims: [
        { state: 'TX', rated_flood_zone: '*zone*', cause_of_damage: '[cause]', occupancy_type: 6 },
      ],
      returned_count: 1,
      total_count: 1,
      spilled: true,
      canvas_id: '*canvas*',
      canvas_table: '<table>',
      staged_count: 1,
    });
    const parsed = inlineText(formatText(femaSearchNfip.format!(nfip))).join('\n');
    for (const value of ['*zone*', '[cause]', '*canvas*', '<table>', 'Occupancy: 6'])
      expect(parsed).toContain(value);
  });
  it('wires dataframe names, types, SQL column headers and drop outcomes', () => {
    const describe = femaDataframeDescribe.output!.parse({
      canvas_id: '*canvas*',
      tables: [
        {
          name: '*table*',
          kind: '<kind>',
          row_count: 1,
          columns: [{ name: '[column]', type: '<type> &amp;' }],
        },
      ],
    });
    const parsed = inlineText(formatText(femaDataframeDescribe.format!(describe))).join('\n');
    for (const value of ['*canvas*', '*table*', '<kind>', '[column]', '<type> &amp;'])
      expect(parsed).toContain(value);
    for (const dropped of [true, false]) {
      const result = { canvas_id: '*canvas*', table_name: '`table`', dropped };
      const text = inlineText(formatText(femaDataframeDrop.format!(result))).join('\n');
      expect(text).toContain('*canvas*');
      expect(text).toContain('`table`');
      expect(
        jsonFallback(
          formatText(femaDataframeDrop.format!({ ...result, table_name: 'line1\nline2' })),
        ),
      ).toEqual({ ...result, table_name: 'line1\nline2' });
    }
    const query = {
      canvas_id: '*canvas*',
      rows: [{ '*column*': { note: '<b>x</b> &amp;' } }],
      row_count: 1,
    };
    const queryText = inlineText(formatText(femaDataframeQuery.format!(query)));
    expect(queryText.join('\n')).toContain('*canvas*');
    expect(queryText).toContain('*column*');
    expect(queryText).toContain('{"note":"<b>x</b> &amp;"}');
  });
  it('keeps the current readable layout for ordinary PA titles', () => {
    const result = {
      projects: [{ disaster_number: 4399, application_title: 'Road repair' }],
      returned_count: 1,
      total_count: 1,
    };
    expect(inlineText(formatText(femaGetPublicAssistance.format!(result)))).toContain(
      'Road repair',
    );
  });
  it.each([
    'Road Zone 5.1 *428*',
    '**literal** [link](https://example.com) `code`',
    '<b>literal</b> &amp;',
    'tail #',
    'a\\*b*',
  ])('preserves literal PA title %j', (title) => {
    const result = {
      projects: [{ disaster_number: 4399, application_title: title }],
      returned_count: 1,
      total_count: 1,
    };
    expect(inlineText(formatText(femaGetPublicAssistance.format!(result)))).toContain(title);
  });
  it('preserves nested JSON and headers after parsing an arbitrary-record table', () => {
    const key = '*field* <b>x</b> &amp;';
    const value = { nested: [{ note: '*literal* &amp; <b>x</b>', slash: 'a\\|b' }] };
    const result = {
      dataset: 'Example',
      returned_count: 1,
      total_count: 1,
      rows: [{ [key]: value }],
    };
    const text = inlineText(formatText(femaQueryDataset.format!(result)));
    expect(text).toContain(key);
    expect(text).toContain(JSON.stringify(value));
  });
  it.each(['line1\nline2', 'line1\r\nline2', ' leading ', '\u0000', '\u000b', '\n```\n~~~~\n'])(
    'uses complete collision-safe JSON for %j',
    (value) => {
      const result = {
        dataset: 'Example',
        returned_count: 1,
        total_count: 1,
        rows: [{ 'column\nname': { nested: [value] } }],
      };
      const tokens = markdown.parse(formatText(femaQueryDataset.format!(result)), {});
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.type).toBe('fence');
      expect(JSON.parse(tokens[0]!.content)).toEqual(result);
    },
  );
});
