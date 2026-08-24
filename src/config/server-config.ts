/**
 * @fileoverview Server-specific environment variable configuration for fema-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z.string().default('https://www.fema.gov/api/open/v2').describe('OpenFEMA API base URL'),
  requestTimeoutMs: z.coerce
    .number()
    .default(30000)
    .describe('HTTP request timeout in milliseconds'),
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
