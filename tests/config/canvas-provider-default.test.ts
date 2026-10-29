/**
 * @fileoverview Tests for the entry point's DataCanvas default — an unset, empty,
 * whitespace-only, or unsubstituted `${…}` placeholder `CANVAS_PROVIDER_TYPE` resolves
 * to `duckdb` by the time `createApp()` reads config, and an explicit `none` is kept.
 * @module tests/config/canvas-provider-default.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const createApp = vi.hoisted(() => vi.fn());

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

/** Load the entry point and return the canvas provider the framework config resolves inside `createApp()`. */
async function providerAtCreateApp(value: string | undefined): Promise<string | undefined> {
  vi.resetModules();
  vi.stubEnv('CANVAS_PROVIDER_TYPE', value);
  const { parseConfig } = await import('@cyanheads/mcp-ts-core/config');
  let provider: string | undefined;
  createApp.mockImplementationOnce(() => {
    provider = parseConfig().canvas.providerType;
  });
  await import('@/index.js');
  return provider;
}

describe('entry point — CANVAS_PROVIDER_TYPE default', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['an unsubstituted placeholder', `\${user_config.canvas_provider_type}`],
  ])('resolves to duckdb when %s', async (_label, value) => {
    await expect(providerAtCreateApp(value)).resolves.toBe('duckdb');
  });

  it('keeps an explicit none', async () => {
    await expect(providerAtCreateApp('none')).resolves.toBe('none');
  });

  it('leaves framework config validation to createApp(), which renders the startup banner', async () => {
    vi.resetModules();
    vi.stubEnv('CANVAS_DEFAULT_ROW_LIMIT', '0');
    createApp.mockClear();
    await import('@/index.js');
    expect(createApp).toHaveBeenCalledOnce();
  });
});
