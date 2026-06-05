/**
 * @fileoverview Canvas accessor module — holds the optional DataCanvas instance
 * initialized from CoreServices in createApp's setup() callback.
 * @module services/canvas/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

export const getCanvas = (): DataCanvas | undefined => _canvas;
