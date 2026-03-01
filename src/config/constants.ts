import { loadUserConfig } from './user-config.js';

let cfg: ReturnType<typeof loadUserConfig> | null = null;
function getCfg() {
  if (!cfg) {
    cfg = loadUserConfig();
  }
  return cfg;
}

export function getMaxMessages() {
  return getCfg().maxMessages;
}
export function getFlushInterval() {
  return getCfg().flushIntervalMs;
}
export const INDENT = '  ';
export const BUBBLE_SIDE_MARGIN = 2;
/** Max text width — no hard cap, let terminal width decide (with small right margin) */
export const MAX_READABLE_WIDTH = 9999;
export const DOT_ACTIVE = '\u2022';
export const MAX_VISIBLE_TODOS = 4;
