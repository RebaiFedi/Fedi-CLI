import { loadUserConfig } from './user-config.js';

const cfg = loadUserConfig();

export const MAX_MESSAGES = cfg.maxMessages;
export const INDENT = '';
export const FLUSH_INTERVAL = cfg.flushIntervalMs;
export const BUBBLE_SIDE_MARGIN = 0;
export const MAX_READABLE_WIDTH = 200;
export const DOT_ACTIVE = '\u2022';
export const MAX_VISIBLE_TODOS = 4;
