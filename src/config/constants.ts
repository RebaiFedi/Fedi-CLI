import { loadUserConfig } from './user-config.js';

export function getMaxMessages() {
  return loadUserConfig().maxMessages;
}
export function getFlushInterval() {
  return loadUserConfig().flushIntervalMs;
}
export const INDENT = '  ';
export const BUBBLE_SIDE_MARGIN = 2;
/** Max text width — no hard cap, let terminal width decide (with small right margin) */
export const MAX_READABLE_WIDTH = 9999;
export const DOT_ACTIVE = '\u2022';
export const MAX_VISIBLE_TODOS = 4;

/** Grace period (ms) before closing a message bubble after agent goes idle/waiting */
export const MSG_CLOSE_GRACE_MS = 3000;
/** Maximum number of messages kept in the bus history ring buffer */
export const BUS_HISTORY_LIMIT = 500;
/** Number of recent messages to include in conversation summary for session restart */
export const CONVERSATION_SUMMARY_LIMIT = 30;
/** Max characters per message content in conversation summary */
export const CONVERSATION_SUMMARY_TRUNCATE = 300;
/** Heartbeat interval (ms) for delegate liveness checks */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Max consecutive empty flushes before relay draft is abandoned */
export const RELAY_DRAFT_MAX_EMPTY_RETRIES = 12;
