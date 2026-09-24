/**
 * @fileoverview Server-specific environment variable configuration for fema-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Strip trailing slashes and a trailing `/v<N>` segment: each dataset carries its own
 * API version, so the configured URL is the root the version is appended to. An
 * override written for the old per-version base (`…/api/open/v2`) keeps working.
 */
function toApiRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

const ServerConfigSchema = z.object({
  baseUrl: z
    .url()
    .default('https://www.fema.gov/api/open')
    .transform(toApiRoot)
    .describe('OpenFEMA API root, without a version segment'),
  requestTimeoutMs: z.coerce
    .number()
    .default(30000)
    .describe('Total upstream exchange and retry budget in milliseconds'),
  enableCanvasDrop: z
    .stringbool()
    .default(false)
    .describe('Enable destructive removal of tables and views from a DataCanvas'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'FEMA_BASE_URL',
    requestTimeoutMs: 'FEMA_REQUEST_TIMEOUT_MS',
    enableCanvasDrop: 'FEMA_ENABLE_CANVAS_DROP',
  });
  return _config;
}
