/**
 * @fileoverview Tests for the server config — `FEMA_BASE_URL` is the OpenFEMA API root,
 * and an override that still ends in a version segment is normalized to that root.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadBaseUrl(value?: string): Promise<string> {
  vi.resetModules();
  if (value !== undefined) vi.stubEnv('FEMA_BASE_URL', value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig().baseUrl;
}

describe('getServerConfig — FEMA_BASE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the API root with no version segment', async () => {
    vi.stubEnv('FEMA_BASE_URL', '');
    await expect(loadBaseUrl()).resolves.toBe('https://www.fema.gov/api/open');
  });

  it.each([
    ['https://www.fema.gov/api/open/v2', 'https://www.fema.gov/api/open'],
    ['https://www.fema.gov/api/open/v2/', 'https://www.fema.gov/api/open'],
    ['https://www.fema.gov/api/open/v1', 'https://www.fema.gov/api/open'],
    ['https://www.fema.gov/api/open/', 'https://www.fema.gov/api/open'],
    ['http://localhost:8080/api/open/v3', 'http://localhost:8080/api/open'],
    ['http://localhost:8080/mirror', 'http://localhost:8080/mirror'],
  ])('normalizes %s to %s', async (value, expected) => {
    await expect(loadBaseUrl(value)).resolves.toBe(expected);
  });

  it('rejects a value that is not a URL at startup', async () => {
    await expect(loadBaseUrl('not a url')).rejects.toThrow(/FEMA_BASE_URL/);
  });
});
