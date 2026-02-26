import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, AgentStatus, Message, OutputLine } from '../agents/types.js';

let tracePath: string | null = null;
let traceEnabled = false;

/** Initialize trace logging. Call once at startup. */
export function initTrace(projectDir: string) {
  tracePath = join(projectDir, 'fedi-trace.log');
  traceEnabled = true;
  const header = `\n${'='.repeat(70)}\n  FEDI CLI TRACE — ${new Date().toISOString()}\n${'='.repeat(70)}\n\n`;
  writeFileSync(tracePath, header, 'utf-8');
}

function ts(): string {
  const d = new Date();
  return `${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function write(line: string) {
  if (!traceEnabled || !tracePath) return;
  try {
    appendFileSync(tracePath, `${ts()}  ${line}\n`, 'utf-8');
  } catch {
    // Ignore write errors
  }
}

// ── Public trace functions ───────────────────────────────────────────────────

/** User typed a message */
export function traceUserInput(text: string) {
  write(`[USER INPUT] ${text}`);
  write('');
}

/** Bus message sent */
export function traceBusMessage(msg: Pick<Message, 'from' | 'to' | 'content'>) {
  const preview = msg.content.replace(/\n+/g, ' ').slice(0, 120);
  write(`[BUS] ${msg.from} --> ${msg.to}: ${preview}`);
}

/** Relay detected in agent output */
export function traceRelay(from: AgentId, to: AgentId, content: string) {
  const preview = content.replace(/\n+/g, ' ').slice(0, 100);
  write(`[RELAY] ${from} --> ${to}: ${preview}`);
}

/** Relay blocked */
export function traceRelayBlocked(from: AgentId, to: AgentId) {
  write(`[RELAY BLOCKED] ${from} --> ${to} (depth limit)`);
}

/** Agent status changed */
export function traceAgentStatus(agent: AgentId, status: AgentStatus) {
  write(`[STATUS] ${agent}: ${status}`);
}

/** Agent output line (text/action/info) */
export function traceAgentOutput(agent: AgentId, line: OutputLine) {
  const prefix = line.type === 'stdout' ? 'TEXT' : line.type === 'system' ? 'ACTION' : line.type.toUpperCase();
  const preview = line.text.replace(/\n+/g, ' ').slice(0, 150);
  write(`[OUTPUT ${agent}] (${prefix}) ${preview}`);
}

/** Output was buffered (relay mute) */
export function traceBuffered(agent: AgentId, reason: string) {
  write(`[BUFFERED] ${agent}: ${reason}`);
}

/** Output displayed to user */
export function traceDisplayed(agent: AgentId, text: string) {
  const preview = text.replace(/\n+/g, ' ').slice(0, 120);
  write(`[DISPLAYED ${agent}] ${preview}`);
}

/** Agent on relay state change */
export function traceRelayState(agent: AgentId, state: 'start' | 'end', detail?: string) {
  write(`[RELAY STATE] ${agent}: ${state}${detail ? ` — ${detail}` : ''}`);
}

/** Opus buffer flushed */
export function traceOpusFlush(lineCount: number) {
  write(`[OPUS FLUSH] ${lineCount} buffered lines released`);
}

/** Generic trace message */
export function trace(msg: string) {
  write(`[INFO] ${msg}`);
}
