#!/usr/bin/env node
/**
 * @fileoverview fema-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
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
  setup(core) {
    initOpenFemaService(core.config, core.storage);
    setCanvas(core.canvas);
  },
  instructions:
    'Start with fema_search_disasters and use the disaster number to join declarations with public and housing assistance. For NFIP claims, supply a state filter; when results include a canvas_id, inspect columns with fema_dataframe_describe before querying with fema_dataframe_query. Use fema_query_dataset for other OpenFEMA v2 datasets.',
});
