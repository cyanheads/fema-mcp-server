/**
 * @fileoverview Tests for the agent-doc selector shared by `scripts/clean-mcpb.ts`
 * (strips entries from a packed `.mcpb`) and `scripts/lint-packaging.ts` (check 8,
 * verifies a built bundle). Agent docs are removed only at an installed package's
 * root; a nested `skills/` directory inside a package — the MCP SDK's runtime
 * `dist/ext/skills/` modules — ships, or the bundle fails at boot.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';

interface CleanMcpbModule {
  AGENT_DOC_ENTRY: RegExp;
  filterAgentDocEntries(entries: string[]): string[];
}

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Both scripts load by URL at run time: a literal import of `lint-packaging.ts`
 * pulls its repo-only `../src/mcp-server/skills.js` fallback into the typecheck.
 */
const loadScript = async <T>(name: string): Promise<T> =>
  (await import(new URL(`../../scripts/${name}`, import.meta.url).href)) as T;

const clean = await loadScript<CleanMcpbModule>('clean-mcpb.ts');
const lint = await loadScript<LintPackagingModule>('lint-packaging.ts');

/** Runtime entries that must ship. */
const RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/some-pkg/lib/.claude/settings.js',
  'node_modules/some-pkg/docs/framework-skills/README.md',
  'dist/index.js',
  'skills/fema-guide/SKILL.md',
];

/** Agent docs at an installed package's root — unscoped, scoped, and nested. */
const AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/',
  'node_modules/vendor-pkg/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/pkg/.agents/skills/x/SKILL.md',
  'node_modules/pkg/SKILL.md',
  'node_modules/a/node_modules/@scope/b/skills/x/SKILL.md',
  'node_modules/@scope/a/node_modules/c/framework-skills/x/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it('clean-mcpb strips package-root agent docs and keeps nested runtime skills/ modules', () => {
    expect(clean.filterAgentDocEntries([...RUNTIME, ...AGENT_DOCS])).toEqual(AGENT_DOCS);
  });

  it('lint-packaging check 8 passes a bundle holding only runtime entries', () => {
    expect(lint.checkBundleEntries(RUNTIME, 'fema-mcp-server.mcpb')).toEqual([]);
  });

  it('lint-packaging check 8 reports every package-root agent doc', () => {
    const errors = lint.checkBundleEntries([...RUNTIME, ...AGENT_DOCS], 'fema-mcp-server.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`contains ${AGENT_DOCS.length} node_modules agent-doc entries`);
  });

  it('keeps the cleaner and linter selectors identical', () => {
    expect(lint.AGENT_DOC_ENTRY.source).toBe(clean.AGENT_DOC_ENTRY.source);
  });
});
