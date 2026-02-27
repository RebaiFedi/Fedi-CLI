import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getFlowId } from './flow.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory =
  | 'ORCH'
  | 'BUS'
  | 'RELAY'
  | 'BUFFER'
  | 'AGENT'
  | 'SESSION'
  | 'UI'
  | 'SYSTEM';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ── State ──────────────────────────────────────────────────────────────────

let jsonlStream: WriteStream | null = null;
let humanStream: WriteStream | null = null;
let minLevel: LogLevel = 'debug';
let initialized = false;

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialize the unified log system.
 * Logs are written to ~/.fedi-cli/logs/ using async write streams.
 */
export function initLog(options?: { level?: LogLevel }): void {
  if (initialized) return;
  initialized = true;

  minLevel = options?.level ?? 'debug';

  const logDir = join(homedir(), '.fedi-cli', 'logs');
  mkdirSync(logDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonlPath = join(logDir, `fedi-${ts}.jsonl`);
  const humanPath = join(logDir, `fedi-${ts}.log`);

  // Write header to human log
  const header = `${'='.repeat(70)}\n  FEDI CLI — ${new Date().toISOString()}\n${'='.repeat(70)}\n\n`;
  writeFileSync(humanPath, header, 'utf-8');
  writeFileSync(jsonlPath, '', 'utf-8');

  // Open async write streams
  jsonlStream = createWriteStream(jsonlPath, { flags: 'a', encoding: 'utf-8' });
  humanStream = createWriteStream(humanPath, { flags: 'a', encoding: 'utf-8' });

  // Silently handle stream errors to avoid crashing on disk issues
  jsonlStream.on('error', () => {});
  humanStream.on('error', () => {});
}

// ── Core write ─────────────────────────────────────────────────────────────

function formatTimestamp(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function write(level: LogLevel, cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
  if (!initialized) return;
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const flowId = getFlowId();
  const timestamp = formatTimestamp();

  // JSON structured log (async)
  if (jsonlStream) {
    const entry: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      cat,
      msg,
    };
    if (flowId) entry.flow = flowId;
    if (ctx) Object.assign(entry, ctx);
    jsonlStream.write(JSON.stringify(entry) + '\n');
  }

  // Human-readable log (async)
  if (humanStream) {
    const lvl = level.toUpperCase().padEnd(5);
    const category = `[${cat}]`.padEnd(10);
    const flowStr = flowId ? `flow=${flowId} ` : '';
    const ctxStr = ctx
      ? ' ' + Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    humanStream.write(`${timestamp} ${lvl} ${category} ${flowStr}${msg}${ctxStr}\n`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export const flog = {
  debug(cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
    write('debug', cat, msg, ctx);
  },
  info(cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
    write('info', cat, msg, ctx);
  },
  warn(cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
    write('warn', cat, msg, ctx);
  },
  error(cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
    write('error', cat, msg, ctx);
  },
};
