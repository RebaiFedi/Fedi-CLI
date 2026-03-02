import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { flog } from '../utils/log.js';

// ── Effort levels & profiles ──────────────────────────────────────────────

export type EffortLevel = 'high' | 'medium' | 'low';
export type ProfileName = 'high' | 'medium' | 'low';

/** Profile presets — each defines effort + thinking per agent */
export const PROFILES: Record<
  ProfileName,
  {
    opusEffort: EffortLevel;
    sonnetEffort: EffortLevel;
    codexEffort: EffortLevel;
    opusThinking: boolean;
    sonnetThinking: boolean;
    codexThinking: boolean;
  }
> = {
  high: {
    opusEffort: 'high',
    sonnetEffort: 'high',
    codexEffort: 'high',
    opusThinking: true,
    sonnetThinking: true,
    codexThinking: true,
  },
  medium: {
    opusEffort: 'high',
    sonnetEffort: 'medium',
    codexEffort: 'medium',
    opusThinking: true,
    sonnetThinking: false,
    codexThinking: false,
  },
  low: {
    opusEffort: 'medium',
    sonnetEffort: 'low',
    codexEffort: 'low',
    opusThinking: false,
    sonnetThinking: false,
    codexThinking: false,
  },
};

// ── User config schema ────────────────────────────────────────────────────

export interface UserConfig {
  /** Max execution time per agent exec call (ms). Default: 120000 */
  execTimeoutMs: number;
  /** Max execution time specifically for Codex (ms). Default: 0 (no timeout — wait indefinitely) */
  codexTimeoutMs: number;
  /** Max idle time (ms) before a delegate is considered stuck (0 = no timeout). Default: 120000 */
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
  /** Cross-talk mute hard ceiling (ms). Default: 15000 */
  crossTalkMuteTimeoutMs: number;
  /** Cross-talk early-clear threshold (ms). Default: 2000 */
  crossTalkClearThresholdMs: number;
  /** Max log files to keep. Default: 20 */
  maxLogFiles: number;
  /** Claude model to use. Default: 'claude-sonnet-4-6' */
  claudeModel: string;
  /** Opus model to use. Default: 'claude-opus-4-6' */
  opusModel: string;
  /** Codex model to use. Default: 'gpt-5.3-codex' */
  codexModel: string;
  /** Base delay for Opus restart backoff (ms). Default: 2000 */
  opusRestartBaseDelayMs: number;
  /** Max relay message content length (chars). Default: 50000 */
  maxRelayContentLength: number;
  /** Max consecutive agent failures before circuit breaker opens. Default: 3 */
  circuitBreakerThreshold: number;
  /** Circuit breaker cooldown (ms). Default: 60000 */
  circuitBreakerCooldownMs: number;
  /** Checkpoint throttle interval per agent (ms). Default: 5000 */
  checkpointThrottleMs: number;
  /** Opus effort level. Default: 'high' */
  opusEffort: EffortLevel;
  /** Sonnet effort level. Default: 'high' */
  sonnetEffort: EffortLevel;
  /** Codex effort level. Default: 'high' */
  codexEffort: EffortLevel;
  /** Enable thinking for Opus. Default: true */
  opusThinking: boolean;
  /** Enable thinking for Sonnet. Default: true */
  sonnetThinking: boolean;
  /** Enable thinking for Codex. Default: true */
  codexThinking: boolean;
  /** Sandbox mode: agents require approval for destructive operations. Default: false */
  sandboxMode: boolean;
  /** Relay draft flush delay (ms). Default: 150 */
  relayDraftFlushMs: number;
  /** Safety-net debounce delay (ms). Default: 500 */
  safetyNetDebounceMs: number;
  /** Log level: debug, info, warn, error. Default: 'debug' */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const UserConfigSchema = z
  .object({
    execTimeoutMs: z.number().min(1000).default(120_000),
    codexTimeoutMs: z.number().min(0).default(0),
    delegateTimeoutMs: z.number().min(0).default(120_000),
    maxRelaysPerWindow: z.number().min(1).default(50),
    relayWindowMs: z.number().min(1000).default(60_000),
    flushIntervalMs: z.number().min(50).default(400),
    maxMessages: z.number().min(10).default(200),
    maxCrossTalkPerRound: z.number().min(1).default(20),
    crossTalkMuteTimeoutMs: z.number().min(1000).default(15_000),
    crossTalkClearThresholdMs: z.number().min(500).default(2_000),
    maxLogFiles: z.number().min(1).default(20),
    claudeModel: z.string().default('claude-sonnet-4-6'),
    opusModel: z.string().default('claude-opus-4-6'),
    codexModel: z.string().default('gpt-5.3-codex'),
    opusRestartBaseDelayMs: z.number().min(500).default(2_000),
    maxRelayContentLength: z.number().min(1000).default(50_000),
    circuitBreakerThreshold: z.number().min(1).default(3),
    circuitBreakerCooldownMs: z.number().min(5000).default(60_000),
    checkpointThrottleMs: z.number().min(1000).default(5_000),
    opusEffort: z.enum(['high', 'medium', 'low']).default('high'),
    sonnetEffort: z.enum(['high', 'medium', 'low']).default('high'),
    codexEffort: z.enum(['high', 'medium', 'low']).default('high'),
    opusThinking: z.boolean().default(true),
    sonnetThinking: z.boolean().default(true),
    codexThinking: z.boolean().default(true),
    sandboxMode: z.boolean().default(false),
    relayDraftFlushMs: z.number().min(10).default(150),
    safetyNetDebounceMs: z.number().min(10).default(500),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  })
  .partial();

const DEFAULTS: UserConfig = {
  execTimeoutMs: 120_000,
  codexTimeoutMs: 0,
  delegateTimeoutMs: 120_000,
  maxRelaysPerWindow: 50,
  relayWindowMs: 60_000,
  flushIntervalMs: 400,
  maxMessages: 200,
  maxCrossTalkPerRound: 20,
  crossTalkMuteTimeoutMs: 15_000,
  crossTalkClearThresholdMs: 2_000,
  maxLogFiles: 20,
  claudeModel: 'claude-sonnet-4-6',
  opusModel: 'claude-opus-4-6',
  codexModel: 'gpt-5.3-codex',
  opusRestartBaseDelayMs: 2_000,
  maxRelayContentLength: 50_000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 60_000,
  checkpointThrottleMs: 5_000,
  opusEffort: 'high',
  sonnetEffort: 'high',
  codexEffort: 'high',
  opusThinking: true,
  sonnetThinking: true,
  codexThinking: true,
  sandboxMode: false,
  relayDraftFlushMs: 150,
  safetyNetDebounceMs: 500,
  logLevel: 'debug',
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
              flog.warn(
                'SYSTEM',
                `Config key "${key}" invalid (${result.error.message}) — using default`,
              );
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

/** Persist current config to ~/.fedi-cli/config.json */
function persistConfig(): void {
  if (!cachedConfig) return;
  const configDir = join(homedir(), '.fedi-cli');
  const configPath = join(configDir, 'config.json');
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(cachedConfig, null, 2), 'utf-8');
    flog.info('SYSTEM', `Config saved to ${configPath}`);
  } catch (err) {
    flog.warn('SYSTEM', `Failed to save config: ${err}`);
  }
}

/** Apply a profile preset — overrides effort/thinking settings and persists */
export function applyProfile(profile: ProfileName): void {
  const cfg = loadUserConfig();
  const preset = PROFILES[profile];
  cfg.opusEffort = preset.opusEffort;
  cfg.sonnetEffort = preset.sonnetEffort;
  cfg.codexEffort = preset.codexEffort;
  cfg.opusThinking = preset.opusThinking;
  cfg.sonnetThinking = preset.sonnetThinking;
  cfg.codexThinking = preset.codexThinking;
  persistConfig();
  flog.info(
    'SYSTEM',
    `Profile "${profile}" applied: opus=${preset.opusEffort}/${preset.opusThinking ? 'thinking' : 'no-think'} sonnet=${preset.sonnetEffort} codex=${preset.codexEffort}`,
  );
}

/** Override effort for a specific agent and persist */
export function setAgentEffort(agent: 'opus' | 'sonnet' | 'codex', effort: EffortLevel): void {
  const cfg = loadUserConfig();
  if (agent === 'opus') cfg.opusEffort = effort;
  else if (agent === 'sonnet') cfg.sonnetEffort = effort;
  else if (agent === 'codex') cfg.codexEffort = effort;
  persistConfig();
  flog.info('SYSTEM', `${agent} effort set to "${effort}"`);
}

/** Override thinking for a specific agent and persist */
export function setAgentThinking(agent: 'opus' | 'sonnet' | 'codex', enabled: boolean): void {
  const cfg = loadUserConfig();
  if (agent === 'opus') cfg.opusThinking = enabled;
  else if (agent === 'sonnet') cfg.sonnetThinking = enabled;
  else if (agent === 'codex') cfg.codexThinking = enabled;
  persistConfig();
  flog.info('SYSTEM', `${agent} thinking ${enabled ? 'enabled' : 'disabled'}`);
}

/** Set sandbox mode (true = safe, false = full-auto) and persist */
export function setSandboxMode(enabled: boolean): void {
  const cfg = loadUserConfig();
  cfg.sandboxMode = enabled;
  persistConfig();
  flog.info('SYSTEM', `Sandbox mode ${enabled ? 'enabled' : 'disabled'}`);
}

/** Reset cached config (useful for tests) */
export function resetConfigCache(): void {
  cachedConfig = null;
}
