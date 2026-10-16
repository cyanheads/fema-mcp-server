/**
 * @fileoverview Tests for the shared markdown table renderer used by fema_query_dataset and
 * fema_dataframe_query.
 * @module tests/tools/markdown-table.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatTableCell,
  renderTableHeader,
  renderTableRow,
} from '@/mcp-server/tools/markdown-table.js';

describe('formatTableCell', () => {
  it.each([
    ['an absent value', undefined, ''],
    ['null', null, 'null'],
    ['an empty string', '', '""'],
    ['a plain string', 'SEVERE STORMS', 'SEVERE STORMS'],
    ['zero', 0, '0'],
    ['a fraction', 1.5, '1.5'],
    ['false', false, 'false'],
    ['true', true, 'true'],
    ['an empty array', [], '[]'],
    ['an empty object', {}, '{}'],
    [
      'an array of strings',
      ['NFIP', 'claims', 'flood insurance'],
      '["NFIP","claims","flood insurance"]',
    ],
    [
      'an array of objects',
      [{ format: 'csv' }, { format: 'parquet' }],
      '[{"format":"csv"},{"format":"parquet"}]',
    ],
    ['nested values', { a: [1, { b: null, c: '' }] }, '{"a":[1,{"b":null,"c":""}]}'],
    ['a pipe', 'a|b', 'a\\|b'],
    ['a pipe inside nested JSON', { note: 'a|b' }, '{"note":"a\\|b"}'],
    ['a backslash before a pipe', 'a\\|b', 'a\\\\\\|b'],
    ['two backslashes before a pipe', 'a\\\\|b', 'a\\\\\\\\\\|b'],
    ['a backslash not before a pipe', 'C:\\temp\\', 'C:\\temp\\'],
    ['a LF', 'line1\nline2', 'line1 line2'],
    ['a CR', 'line1\rline2', 'line1 line2'],
    ['a CRLF', 'line1\r\nline2', 'line1 line2'],
    ['CR, CRLF, and LF in a row', 'a\r\r\n\nb', 'a   b'],
    ['a line break inside nested JSON', { nl: 'x\ny' }, '{"nl":"x\\ny"}'],
    ['the string "null"', 'null', 'null'],
  ])('renders %s', (_name, value, expected) => {
    expect(formatTableCell(value)).toBe(expected);
  });

  /**
   * GFM parsers split a row on every pipe not preceded by an odd run of backslashes: micromark
   * and marked read `\\|` as an escaped backslash and a cell boundary. Every pipe a cell emits
   * must therefore follow an odd run, however many backslashes the value put before it.
   */
  it.each(['a\\|b', 'a\\\\|b', '\\|', '\\\\\\|x|y\\', { note: 'a\\|b' }, ['\\', '|']])(
    'keeps every pipe escaped in %j',
    (value) => {
      const cell = formatTableCell(value);
      const source = typeof value === 'string' ? value : JSON.stringify(value);
      const runs = cell.match(/\\*\|/g) ?? [];
      expect(runs).toHaveLength(source.split('|').length - 1);
      for (const run of runs) expect((run.length - 1) % 2).toBe(1);
    },
  );

  it.each([
    ['pipes', (n: number) => '|'.repeat(n)],
    ['a backslash run', (n: number) => '\\'.repeat(n)],
    ['backslash runs before pipes', (n: number) => '\\\\\\|'.repeat(n / 4)],
    ['CRs', (n: number) => '\r'.repeat(n)],
    ['CRLFs', (n: number) => '\r\n'.repeat(n / 2)],
    ['LFs', (n: number) => '\n'.repeat(n)],
    ['mixed breaks and pipes', (n: number) => '\r\r\n\n|'.repeat(n / 5)],
    ['a digit run', (n: number) => '7'.repeat(n)],
  ])('stays linear on a value of %s from 5k to 320k characters', (_name, make) => {
    const cpuMicros = (value: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 3; trial++) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < 5; i++) formatTableCell(value);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, used.user + used.system);
      }
      return Math.max(best, 1);
    };
    const small = cpuMicros(make(5_000));
    const large = cpuMicros(make(320_000));
    expect(large / small).toBeLessThan(256);
    expect(large).toBeLessThan(1_000_000);
  });
});

describe('renderTableHeader', () => {
  it('renders the header and a separator with one cell per column', () => {
    expect(renderTableHeader(['disasterNumber', 'state'])).toBe(
      '| disasterNumber | state |\n| --- | --- |',
    );
  });

  it('escapes a pipe and flattens a line break in a column name', () => {
    expect(renderTableHeader(['a|b', 'c\r\nd', ''])).toBe(
      '| a\\|b | c d | "" |\n| --- | --- | --- |',
    );
  });
});

describe('renderTableRow', () => {
  const columns = ['name', 'distribution', 'license', 'title', 'description'];

  it('renders one line with a cell per column, in column order', () => {
    const line = renderTableRow(
      {
        description: 'One.\n\nTwo | three.',
        name: 'NfipClaims',
        title: '',
        license: null,
        distribution: [{ format: 'csv' }],
      },
      columns,
    );
    expect(line).toBe('| NfipClaims | [{"format":"csv"}] | null | "" | One.  Two \\| three. |');
  });

  it('renders a column the record lacks as an empty cell, and ignores keys outside the column list', () => {
    expect(renderTableRow({ name: 'x', extra: 'ignored' }, ['name', 'missing'])).toBe('| x |  |');
  });

  it('reads only the record’s own properties, never inherited ones', () => {
    expect(renderTableRow({}, ['constructor', 'toString', '__proto__'])).toBe('|  |  |  |');
    const own = JSON.parse('{"__proto__":{"a":1},"constructor":"c"}') as Record<string, unknown>;
    expect(renderTableRow(own, ['__proto__', 'constructor'])).toBe('| {"a":1} | c |');
  });
});
