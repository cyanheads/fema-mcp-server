#!/usr/bin/env node
/**
 * @fileoverview fema-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { femaDisasterResource } from './mcp-server/resources/definitions/fema-disaster.resource.js';
import { femaDataframeDescribe } from './mcp-server/tools/definitions/fema-dataframe-describe.tool.js';
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
  tools: [
    femaSearchDisasters,
    femaGetDisaster,
    femaGetPublicAssistance,
    femaGetHousingAssistance,
    femaSearchNfip,
    femaDataframeQuery,
    femaDataframeDescribe,
    femaQueryDataset,
  ],
  resources: [femaDisasterResource],
  prompts: [],
  setup(core) {
    initOpenFemaService(core.config, core.storage);
    setCanvas(core.canvas);
  },
  instructions:
    'FEMA disaster and flood data server. Primary entry points:\n' +
    '- fema_search_disasters: find federal disaster declarations by state/type/date\n' +
    '- fema_get_disaster: all designated areas for a specific disaster number\n' +
    '- fema_get_public_assistance: PA funded projects (where recovery money went)\n' +
    '- fema_get_housing_assistance: IA housing grants by county/ZIP\n' +
    '- fema_search_nfip: NFIP flood insurance claims (requires state filter; stages to canvas for SQL)\n' +
    '- fema_query_dataset: generic OData access to any OpenFEMA v2 dataset\n' +
    '- fema://disaster/{number}: read-once disaster summary resource\n' +
    'Disaster number is the join key across all PA and IA tools.',
});
