#!/usr/bin/env node
/**
 * @fileoverview fema-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import { femaDisasterResource } from './mcp-server/resources/definitions/fema-disaster.resource.js';
import { femaDataframeDescribe } from './mcp-server/tools/definitions/fema-dataframe-describe.tool.js';
import { femaDataframeDrop } from './mcp-server/tools/definitions/fema-dataframe-drop.tool.js';
import { femaDataframeQuery } from './mcp-server/tools/definitions/fema-dataframe-query.tool.js';
import { femaGetDisaster } from './mcp-server/tools/definitions/fema-get-disaster.tool.js';
import { femaGetHousingAssistance } from './mcp-server/tools/definitions/fema-get-housing-assistance.tool.js';
import { femaGetPublicAssistance } from './mcp-server/tools/definitions/fema-get-public-assistance.tool.js';
import { femaQueryDataset } from './mcp-server/tools/definitions/fema-query-dataset.tool.js';
import { femaSearchDisasters } from './mcp-server/tools/definitions/fema-search-disasters.tool.js';
import { femaSearchNfip } from './mcp-server/tools/definitions/fema-search-nfip.tool.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';
import { initOpenFemaService } from './services/openfema/openfema-service.js';

/**
 * Load `.env` the way the framework does (variables already set win; a missing file is
 * normal) so the default below sees an operator's `CANVAS_PROVIDER_TYPE=none` under Node.
 * Framework config is parsed and validated in `createApp()`, which renders the startup
 * banner; parsing it here would throw past that banner.
 */
try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
/**
 * DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it. Read through
 * `normalizeEnv` so a blank, whitespace-only, or unsubstituted `${…}` value takes this
 * default rather than the framework's `none`.
 */
if (normalizeEnv(process.env).CANVAS_PROVIDER_TYPE === undefined) {
  process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
}

await createApp({
  name: 'fema-mcp-server',
  title: 'fema-mcp-server',
  sessionMode: 'stateless',
  tools: [
    femaSearchDisasters,
    femaGetDisaster,
    femaGetPublicAssistance,
    femaGetHousingAssistance,
    femaSearchNfip,
    femaDataframeQuery,
    femaDataframeDescribe,
    femaDataframeDrop,
    femaQueryDataset,
  ],
  resources: [femaDisasterResource],
  prompts: [],
  skills: 'skills',
  setup(core) {
    getServerConfig();
    initOpenFemaService(core.config, core.storage);
    setCanvas(core.canvas);
  },
  instructions:
    'Use fema_search_disasters to find a disaster number, fema_get_disaster for funding totals, and the assistance tools for project or housing records. Scope NFIP claims by state and add the stored flood_event spelling to select a named event. When a tool returns canvas_id, inspect the tables with fema_dataframe_describe before querying them. Use fema_query_dataset for other OpenFEMA datasets. The fema-guide skill covers county naming, identifiers, dollar totals, and OData filters.',
});
