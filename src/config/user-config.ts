import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { flog } from '../utils/log.js';

// ── User config schema ────────────────────────────────────────────────────

export interface UserConfig {
  /** Max execution time per agent exec call (ms). Default: 120000 */
  execTimeoutMs: number;
  /** Max execution time specifically for Codex (ms). Default: 360000 (3x execTimeoutMs) */
  codexTimeoutMs: number;
  /** Max execution time specifically for Gemini (ms). Default: 360000 (3x execTimeoutMs) */
  geminiTimeoutMs: number;
  /** Max time to wait for all delegates before force-delivering (ms). Default: 180000 */
  delegateTimeoutMs: number;
  /** Max relays per time window. Default: 50 */
  maxRelaysPerWindow: number;
  /** Relay rate-limit window (ms). Default: 60000 */
  relayWindowMs: number;
  /** Output flush interval (ms). Default: 400 */
  flushIntervalMs: number;
  /** Max messages in chat buffer. Default: 200 */
  maxMessages: number;
  /** Max cross-talk messages per round. Default: 20 */
  maxCrossTalkPerRound: number;
  /** Max log files to keep. Default: 20 */
  maxLogFiles: number;
  /** Claude model to use. Default: 'claude-sonnet-4-6' */
  claudeModel: string;
  /** Opus model to use. Default: 'claude-opus-4-6' */
  opusModel: string;
  /** Codex model to use. Default: 'gpt-5.3-codex' */
  codexModel: string;
  /** Gemini model to use. Default: 'gemini-2.5-pro' */
  geminiModel: string;
}

const DEFAULTS: UserConfig = {
  execTimeoutMs: 120_000,
  codexTimeoutMs: 360_000,
  geminiTimeoutMs: 360_000,
  delegateTimeoutMs: 180_000,
  maxRelaysPerWindow: 50,
  relayWindowMs: 60_000,
  flushIntervalMs: 400,
  maxMessages: 200,
  maxCrossTalkPerRound: 20,
  maxLogFiles: 20,
  claudeModel: 'claude-sonnet-4-6',
  opusModel: 'claude-opus-4-6',
  codexModel: 'gpt-5.3-codex',
  geminiModel: 'gemini-2.5-pro',
};

let cachedConfig: UserConfig | null = null;

/**
 * Load user configuration from ~/.fedi-cli/config.json.
 * Falls back to defaults for any missing values.
 * Config is cached after first load.
 */
export function loadUserConfig(): UserConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = join(homedir(), '.fedi-cli', 'config.json');

  if (!existsSync(configPath)) {
    cachedConfig = { ...DEFAULTS };
    return cachedConfig;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedConfig = {
      execTimeoutMs: typeof parsed.execTimeoutMs === 'number' ? parsed.execTimeoutMs : DEFAULTS.execTimeoutMs,
      codexTimeoutMs: typeof parsed.codexTimeoutMs === 'number' ? parsed.codexTimeoutMs : DEFAULTS.codexTimeoutMs,
      geminiTimeoutMs: typeof parsed.geminiTimeoutMs === 'number' ? parsed.geminiTimeoutMs : DEFAULTS.geminiTimeoutMs,
      delegateTimeoutMs: typeof parsed.delegateTimeoutMs === 'number' ? parsed.delegateTimeoutMs : DEFAULTS.delegateTimeoutMs,
      maxRelaysPerWindow: typeof parsed.maxRelaysPerWindow === 'number' ? parsed.maxRelaysPerWindow : DEFAULTS.maxRelaysPerWindow,
      relayWindowMs: typeof parsed.relayWindowMs === 'number' ? parsed.relayWindowMs : DEFAULTS.relayWindowMs,
      flushIntervalMs: typeof parsed.flushIntervalMs === 'number' ? parsed.flushIntervalMs : DEFAULTS.flushIntervalMs,
      maxMessages: typeof parsed.maxMessages === 'number' ? parsed.maxMessages : DEFAULTS.maxMessages,
      maxCrossTalkPerRound: typeof parsed.maxCrossTalkPerRound === 'number' ? parsed.maxCrossTalkPerRound : DEFAULTS.maxCrossTalkPerRound,
      maxLogFiles: typeof parsed.maxLogFiles === 'number' ? parsed.maxLogFiles : DEFAULTS.maxLogFiles,
      claudeModel: typeof parsed.claudeModel === 'string' ? parsed.claudeModel : DEFAULTS.claudeModel,
      opusModel: typeof parsed.opusModel === 'string' ? parsed.opusModel : DEFAULTS.opusModel,
      codexModel: typeof parsed.codexModel === 'string' ? parsed.codexModel : DEFAULTS.codexModel,
      geminiModel: typeof parsed.geminiModel === 'string' ? parsed.geminiModel : DEFAULTS.geminiModel,
    };
    flog.info('SYSTEM', `Loaded user config from ${configPath}`);
    return cachedConfig;
  } catch (err) {
    flog.warn('SYSTEM', `Failed to load config from ${configPath}: ${err}`);
    cachedConfig = { ...DEFAULTS };
    return cachedConfig;
  }
}

/** Reset cached config (useful for tests) */
export function resetConfigCache(): void {
  cachedConfig = null;
}
