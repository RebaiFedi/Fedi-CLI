import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { flog } from '../utils/log.js';

// ── User config schema ────────────────────────────────────────────────────

export interface UserConfig {
  /** Max execution time per agent exec call (ms). Default: 120000 */
  execTimeoutMs: number;
  /** Max execution time specifically for Codex (ms). Default: 0 (no timeout — wait indefinitely) */
  codexTimeoutMs: number;
  /** Max idle time (ms) before a delegate is considered stuck (0 = no timeout). Default: 0 */
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
  /** Checkpoint throttle interval per agent (ms). Default: 5000 */
  checkpointThrottleMs: number;
}

const UserConfigSchema = z.object({
  execTimeoutMs: z.number().min(1000).default(120_000),
  codexTimeoutMs: z.number().min(0).default(0),
  delegateTimeoutMs: z.number().min(0).default(0),
  maxRelaysPerWindow: z.number().min(1).default(50),
  relayWindowMs: z.number().min(1000).default(60_000),
  flushIntervalMs: z.number().min(50).default(400),
  maxMessages: z.number().min(10).default(200),
  maxCrossTalkPerRound: z.number().min(1).default(20),
  maxLogFiles: z.number().min(1).default(20),
  claudeModel: z.string().default('claude-sonnet-4-6'),
  opusModel: z.string().default('claude-opus-4-6'),
  codexModel: z.string().default('gpt-5.3-codex'),
  checkpointThrottleMs: z.number().min(1000).default(5_000),
}).partial();

const DEFAULTS: UserConfig = {
  execTimeoutMs: 120_000,
  codexTimeoutMs: 0,
  delegateTimeoutMs: 0,
  maxRelaysPerWindow: 50,
  relayWindowMs: 60_000,
  flushIntervalMs: 400,
  maxMessages: 200,
  maxCrossTalkPerRound: 20,
  maxLogFiles: 20,
  claudeModel: 'claude-sonnet-4-6',
  opusModel: 'claude-opus-4-6',
  codexModel: 'gpt-5.3-codex',
  checkpointThrottleMs: 5_000,
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
    // Parse tolerantly key-by-key: valid keys are kept, invalid ones fall back to defaults
    const merged: Record<string, unknown> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key in DEFAULTS) {
          const fieldSchema = UserConfigSchema.shape[key as keyof typeof UserConfigSchema.shape];
          if (fieldSchema) {
            const result = fieldSchema.safeParse(value);
            if (result.success) {
              merged[key] = result.data;
            } else {
              flog.warn('SYSTEM', `Config key "${key}" invalid (${result.error.message}) — using default`);
            }
          }
        }
      }
    }
    cachedConfig = { ...DEFAULTS, ...merged };
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
