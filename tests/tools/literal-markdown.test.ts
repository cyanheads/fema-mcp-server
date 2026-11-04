/**
 * @fileoverview Lossless fallback decisions, independent enrichment text and scanner bounds.
 * @module tests/tools/literal-markdown.test
 */
import { describe, expect, it } from 'vitest';
import { renderJson, renderLiteral, requiresJson } from '@/mcp-server/tools/literal-markdown.js';
import { jsonFallback, renderedText } from '../helpers/rendered-markdown.js';

describe('literal Markdown', () => {
  it.each([
    '*literal*',
    '<b>literal</b>',
    '&amp; &#10;',
    '[x](https://example.com)',
    '`code`',
    'a\\|b',
    'a_b',
    '- list',
    '1. list',
    'trailing #',
  ])('reads %j back literally', (value) => {
    expect(requiresJson(value)).toBe(false);
    expect(renderedText(renderLiteral(value))).toEqual([value]);
  });
  it.each(['\r', '\n', '\u0000', '\u000b', '\t', ' leading', 'trailing ', '\n```\n~~~~\n'])(
    'retains unsafe nested strings and keys %j',
    (value) => {
      const data = { [value]: [{ nested: value }], other: null };
      expect(requiresJson(data)).toBe(true);
      expect(jsonFallback(renderJson(data))).toEqual(data);
      expect(jsonFallback(renderLiteral(value))).toBe(value);
    },
  );
  it('walks nested records without a recursion limit below JSON serialization', () => {
    let value: unknown = 'line1\nline2';
    for (let i = 0; i < 5000; i++) value = { next: [value] };
    expect(requiresJson(value)).toBe(true);
  });
  it.each([
    ['openers', (n: number) => '<'.repeat(n)],
    ['nested prefixes', (n: number) => '[<a&'.repeat(n / 4)],
    ['closing headings', (n: number) => `a ${'#'.repeat(n)}`],
    ['backslashes before pipes', (n: number) => '\\\\|'.repeat(Math.ceil(n / 3)).slice(0, n)],
    ['line ending in newline', (n: number) => `${'x'.repeat(n)}\n`],
    ['line breaks throughout', (n: number) => 'x\n'.repeat(n / 2)],
  ])('keeps rendering bounded on %s', (_, make) => {
    let first = 0;
    for (const n of [5000, 20000, 80000, 320000]) {
      const value = make(n);
      const fallback = value.includes('\n');
      expect(requiresJson({ nested: [{ value }] })).toBe(fallback);
      const output = renderLiteral(value);
      if (fallback) expect(jsonFallback(output)).toBe(value);
      else expect(renderedText(output)).toEqual([value]);
      let fastest = Infinity;
      for (let trial = 0; trial < 3; trial++) {
        const start = process.threadCpuUsage();
        renderLiteral(value);
        const elapsed = process.threadCpuUsage(start);
        fastest = Math.min(fastest, (elapsed.user + elapsed.system) / 1000);
      }
      if (n === 5000) first = fastest;
      expect(fastest).toBeLessThan(500);
      expect(fastest / Math.max(first, 0.05)).toBeLessThan(256);
    }
  });
});
