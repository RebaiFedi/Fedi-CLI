import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import type { AgentId, AgentStatus, ChatMessage, DisplayEntry, Message, OutputLine } from '../agents/types.js';
import { AGENT_LABELS } from '../agents/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { renderMarkdown } from '../utils/render-markdown.js';
import { InputBar } from './InputBar.js';
import { logger } from '../utils/logger.js';

const MAX_MESSAGES = 200;
const INDENT = '    ';
const FLUSH_INTERVAL = 250;
const BUBBLE_SIDE_MARGIN = 1;
const MAX_READABLE_WIDTH = 200;
const THEME = {
  text: '#F8FAFC',
  muted: '#94A3B8',
  border: '#64748B',
  panelBorder: '#334155',
  info: '#FBBF24',
  opus: '#F59E0B',
  claude: '#38BDF8',
  codex: '#22C55E',
  userPrefix: '#CBD5E1',
  userBubbleBg: '#1F2937',
} as const;
const DOT_ACTIVE = '•';
const DOT_IDLE = '·';

function agentHex(agent: AgentId): string {
  if (agent === 'opus') return THEME.opus;
  if (agent === 'claude') return THEME.claude;
  return THEME.codex;
}

function agentName(agent: AgentId): string {
  if (agent === 'claude') return 'Sonnet';
  if (agent === 'opus') return 'Opus';
  return 'Codex';
}

// ── Filters ─────────────────────────────────────────────────────────────────

const TOOL_RE = /^\s*(EnterPlanMode|AskUserQuestion|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookEdit|EnterWorktree|WebSearch|WebFetch)\s*$/;
const RELAY_PREFIX_RE = /\[(TO|FROM):(CLAUDE|CODEX|OPUS)\]\s*/gi;
const RELAY_LINE_RE = /^\s*\[TO:(CLAUDE|CODEX|OPUS)\]\s/i;
const TASK_ADD_RE = /\[TASK:add\]\s*(.+)/i;
const TASK_DONE_RE = /\[TASK:done\]\s*(.+)/i;
const TASK_TAG_LINE_RE = /^\s*\[TASK:(add|done)\]\s*/i;
const CMD_OUTPUT_HEADER_RE = /^={3,}\s*.+\s*={3,}$/;  // ===== filename ===== lines from codex printf

// ── Thinking verbs ──────────────────────────────────────────────────────────

const THINKING_VERBS = [
  'Thinking', 'Analyzing', 'Reasoning', 'Processing',
  'Evaluating', 'Considering', 'Reflecting', 'Examining',
  'Assessing', 'Investigating', 'Reviewing', 'Interpreting',
];

function randomVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}

// ── Animated thinking indicator ──────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function ThinkingSpinner() {
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(randomVerb);

  useEffect(() => {
    const spinId = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    const verbId = setInterval(() => setVerb(randomVerb()), 3000);
    return () => { clearInterval(spinId); clearInterval(verbId); };
  }, []);

  return (
    <Text>
      <Text color="#e8912d">{`    ${SPINNER_FRAMES[frame]} `}</Text>
      <Text color="#e8912d" italic>{verb}</Text>
      <Text color="#e8912d" dimColor>{'...'}</Text>
    </Text>
  );
}

// ── Todo item ───────────────────────────────────────────────────────────────

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  agent: AgentId;
}

// ── OutputLine → DisplayEntry[] ─────────────────────────────────────────────

function outputToEntries(line: OutputLine): DisplayEntry[] {
  if (line.type === 'system') return [{ text: line.text, kind: 'action' }];
  if (line.type === 'info') return [{ text: line.text, kind: 'info' }];
  if (line.type === 'relay') return [];

  const filteredText = line.text
    .split('\n')
    .filter((l) => !RELAY_LINE_RE.test(l))
    .filter((l) => !TASK_TAG_LINE_RE.test(l))
    .filter((l) => !CMD_OUTPUT_HEADER_RE.test(l.trim()))
    .map((l) => l.replace(RELAY_PREFIX_RE, ''))
    .join('\n');

  if (!filteredText.trim()) return [];

  const styled = renderMarkdown(filteredText);
  const entries: DisplayEntry[] = [];
  for (const s of styled) {
    if (!s.text.trim() && !s.code) {
      entries.push({ text: '', kind: 'empty' });
    } else if (s.code) {
      entries.push({ text: s.text, kind: 'code' });
    } else if (s.dim) {
      entries.push({ text: s.text, kind: 'separator' });
    } else if (s.bold && s.color === 'cyan') {
      entries.push({ text: s.text, kind: 'heading', bold: true, color: 'cyan' });
    } else if (s.bold && s.color === 'white') {
      entries.push({ text: s.text, kind: 'heading', bold: true, color: 'white' });
    } else if (s.bold) {
      entries.push({ text: s.text, kind: 'heading', bold: true });
    } else {
      entries.push({ text: s.text, kind: 'text' });
    }
  }
  return entries.filter((e) => e.kind !== 'text' || !TOOL_RE.test(e.text));
}

// ── Extract tasks & plan ────────────────────────────────────────────────────

function extractTasks(text: string): { adds: string[]; dones: string[] } {
  const adds: string[] = [];
  const dones: string[] = [];
  for (const line of text.split('\n')) {
    const addMatch = line.match(TASK_ADD_RE);
    if (addMatch) adds.push(addMatch[1].trim());
    const doneMatch = line.match(TASK_DONE_RE);
    if (doneMatch) dones.push(doneMatch[1].trim());
  }
  return { adds, dones };
}

// Plan items are ONLY populated via explicit [TASK:add] tags from agents.
// No auto-detection of numbered lists (too many false positives).

// ── Word-wrap helper ────────────────────────────────────────────────────────

/** Strip ANSI escape codes to measure visible character width */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Word-wrap `text` so each line fits within `maxWidth` visible characters.
 * Continuation lines are prefixed with `contIndent`.
 * Returns the first line (no prefix) + continuation lines (with prefix).
 */
function wordWrap(text: string, maxWidth: number, contIndent: string): string[] {
  const visibleLen = stripAnsi(text).length;
  if (visibleLen <= maxWidth || maxWidth < 10) return [text];

  // Split into words preserving ANSI codes attached to words
  const words = text.split(/( +)/);
  const lines: string[] = [];
  let currentLine = '';
  let currentVisible = 0;

  for (const word of words) {
    const wordVisible = stripAnsi(word).length;
    if (currentVisible + wordVisible > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      // Trim leading spaces from word on new line
      const trimmed = word.replace(/^ +/, '');
      currentLine = trimmed;
      currentVisible = stripAnsi(trimmed).length;
    } else {
      currentLine += word;
      currentVisible += wordVisible;
    }
  }
  if (currentLine) lines.push(currentLine);

  // First line is returned as-is, subsequent lines get continuation indent
  return lines.map((l, i) => i === 0 ? l : `${contIndent}${l}`);
}

// ── ANSI rendering helpers ──────────────────────────────────────────────────

function isTableLine(text: string): boolean {
  const t = stripAnsi(text).trim();
  return t.startsWith('|') && t.endsWith('|');
}

function entryToAnsiLines(e: DisplayEntry, _agentColor: 'green' | 'yellow' | 'magenta'): string[] {
  const termW = process.stdout.columns || 80;
  const maxW = Math.max(20, Math.min(termW - INDENT.length, MAX_READABLE_WIDTH));
  const wrapW = INDENT.length + maxW;

  if (e.kind === 'empty') return [''];

  if (isTableLine(e.text)) {
    const clipped = e.text.length > maxW
      ? `${e.text.slice(0, Math.max(0, maxW - 1))}…`
      : e.text;
    if (e.kind === 'separator') return [`${INDENT}${chalk.dim(clipped)}`];
    if (e.kind === 'heading') return [`${INDENT}${chalk.hex(THEME.text).bold(clipped)}`];
    return [`${INDENT}${clipped}`];
  }

  if (e.kind === 'info') {
    const raw = `${INDENT}  ${chalk.hex(THEME.info)('!')} ${chalk.hex(THEME.info)(e.text)}`;
    return wordWrap(raw, wrapW, `${INDENT}    `);
  }

  if (e.kind === 'action') {
    const raw = `${INDENT}    ${chalk.dim(e.text)}`;
    return wordWrap(raw, wrapW, `${INDENT}      `);
  }

  if (e.kind === 'code') {
    const codeIndent = `${INDENT}  `;
    const raw = chalk.hex(THEME.info)(e.text);
    const codeMaxW = Math.max(20, Math.min(termW - codeIndent.length, MAX_READABLE_WIDTH));
    return wordWrap(raw, codeMaxW, codeIndent).map((l, i) => i === 0 ? `${codeIndent}${l}` : l);
  }

  if (e.kind === 'separator') {
    // Truncate separator lines to fit terminal width
    const sepText = e.text.length > maxW ? e.text.slice(0, maxW) : e.text;
    return [`${INDENT}${chalk.dim(sepText)}`];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.hex(THEME.claude) : chalk.hex(THEME.text);
    const raw = col.bold(e.text);
    return wordWrap(raw, maxW, INDENT).map((l, i) => i === 0 ? `${INDENT}${l}` : l);
  }

  // Regular text — word-wrap with consistent indent on continuation
  return wordWrap(e.text, maxW, INDENT).map((l, i) => i === 0 ? `${INDENT}${l}` : l);
}

/** Convert entries to ANSI lines with proper spacing around action groups */
function entriesToAnsiOutputLines(entries: DisplayEntry[], agentColor: 'green' | 'yellow' | 'magenta', prevKind?: DisplayEntry['kind']): string[] {
  // Prepend context entry for correct spacing at the boundary
  const withContext: DisplayEntry[] = prevKind ? [{ text: '', kind: prevKind }, ...entries] : entries;
  const processed = compact(collapseActions(addActionSpacing(withContext)));
  // If we prepended a context entry, skip the first output entry (it's the fake context)
  const start = prevKind ? 1 : 0;
  const lines: string[] = [];
  for (let i = start; i < processed.length; i++) {
    lines.push(...entryToAnsiLines(processed[i], agentColor));
  }
  return lines;
}

// ── Compact & collapse ──────────────────────────────────────────────────────

function collapseActions(entries: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    if (buf.length <= 2) {
      for (const a of buf) out.push({ text: a.trim(), kind: 'action' });
    } else {
      // Show last action + count
      out.push({ text: `${buf[buf.length - 1].trim()} (+${buf.length - 1} more)`, kind: 'action' });
    }
    buf = [];
  };
  for (const e of entries) {
    if (e.kind === 'action') buf.push(e.text);
    else { flush(); out.push(e); }
  }
  flush();
  return out;
}

function compact(entries: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    // Skip consecutive empty lines (max 1 blank between blocks)
    if (e.kind === 'empty' && out.length > 0 && out[out.length - 1].kind === 'empty') continue;
    out.push(e);
  }
  // Only strip leading empties, keep trailing ones for spacing after content
  while (out.length > 0 && out[0].kind === 'empty') out.shift();
  return out;
}

function addActionSpacing(raw: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(raw[i]);
    // After an action entry, if next entry is NOT action/empty, insert blank line
    if (raw[i].kind === 'action' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next.kind !== 'action' && next.kind !== 'empty') {
        out.push({ text: '', kind: 'empty' });
      }
    }
    // Before an action entry, if prev entry is NOT action/empty, insert blank line
    if (i + 1 < raw.length && raw[i + 1].kind === 'action' && raw[i].kind !== 'action' && raw[i].kind !== 'empty') {
      out.push({ text: '', kind: 'empty' });
    }
  }
  return out;
}

function compactOutputLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = stripAnsi(line).trim();
    const isEmpty = trimmed === '';

    if (isEmpty && out.length > 0) {
      const prevTrimmed = stripAnsi(out[out.length - 1]).trim();
      const nextTrimmed = i + 1 < lines.length ? stripAnsi(lines[i + 1]).trim() : '';
      const prevIsEmpty = prevTrimmed === '';
      const prevIsSeparator = /^[-─]{3,}$/.test(prevTrimmed);
      const nextIsSeparator = /^[-─]{3,}$/.test(nextTrimmed);
      // Skip only double blanks and blanks around separators
      if (prevIsEmpty || prevIsSeparator || nextIsSeparator) continue;
    }
    out.push(line);
  }
  return out;
}

// ── Props ───────────────────────────────────────────────────────────────────

interface DashboardProps {
  orchestrator: Orchestrator;
  projectDir: string;
  claudePath: string;
  codexPath: string;
  resumeSessionId?: string;
}

// ── Todo panel ──────────────────────────────────────────────────────────────

const MAX_VISIBLE_TODOS = 4;

function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const doneCount = items.filter((t) => t.done).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((doneCount / total) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  // Show only first MAX_VISIBLE_TODOS items, collapse the rest
  const visible = items.slice(0, MAX_VISIBLE_TODOS);
  const hidden = items.length - MAX_VISIBLE_TODOS;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.panelBorder} paddingX={1}>
      <Text>
        <Text bold color={THEME.text}>{'  Plan '}</Text>
        <Text dimColor>{`${doneCount}/${total} `}</Text>
        <Text color={THEME.claude}>{bar}</Text>
        <Text dimColor>{` ${pct}%`}</Text>
      </Text>
      {visible.map((item) => (
        <Text key={item.id}>
          {item.done
            ? <Text color={THEME.codex}>{'  ✓ '}</Text>
            : <Text dimColor>{'  ○ '}</Text>
          }
          <Text color={item.done ? THEME.muted : THEME.text} strikethrough={item.done}>
            {item.text}
          </Text>
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor>{`    + ${hidden} autres`}</Text>
      )}
    </Box>
  );
}

// ── Buffered entry ──────────────────────────────────────────────────────────

interface BufferedEntry { agent: AgentId; entries: DisplayEntry[]; }

// ── Dashboard ───────────────────────────────────────────────────────────────
//
// Architecture: Ink renders ONLY the bottom bar (input + status + todo).
// ALL chat content is written via process.stdout.write() into terminal
// scrollback. This means:
// - No <Static> — it causes duplication bugs
// - No height changes — Ink always renders the same small structure
// - No spinners in chat — they cause 30fps re-renders that block scroll
// - Scroll is FREE — scrollback is native terminal, never touched by Ink

export function Dashboard({ orchestrator, projectDir, claudePath, codexPath, resumeSessionId }: DashboardProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [opusStatus, setOpusStatus] = useState<AgentStatus>('idle');
  const [claudeStatus, setClaudeStatus] = useState<AgentStatus>('idle');
  const [codexStatus, setCodexStatus] = useState<AgentStatus>('idle');
  const [stopped, setStopped] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);

  const currentMsgRef = useRef<Map<string, string>>(new Map());
  const lastEntryKind = useRef<Map<string, DisplayEntry['kind']>>(new Map());
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const outputBuffer = useRef<BufferedEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const welcomePrinted = useRef(false);
  const lastPrintedAgent = useRef<AgentId | null>(null);
  /** Pending actions per agent — accumulated, printed as compact summary */
  const pendingActions = useRef<Map<AgentId, string[]>>(new Map());

  // Print welcome banner once at mount via stdout (not Ink)
  useEffect(() => {
    if (welcomePrinted.current) return;
    welcomePrinted.current = true;
    const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');

    const line1 = `  ${chalk.hex(THEME.text).bold('>_ Fedi Cli')} ${chalk.dim('(v1.0)')}`;
    const line2 = '';
    const line3 = `  ${chalk.dim('agents:')}     ${chalk.hex(THEME.opus)('Opus')} ${chalk.dim('(Director)')}, ${chalk.hex(THEME.claude)('Sonnet')} ${chalk.dim('(Code)')}, ${chalk.hex(THEME.codex)('Codex')} ${chalk.dim('(Script)')}`;
    const line4 = `  ${chalk.dim('directory:')}  ${chalk.hex(THEME.text)(dir)}`;

    // Strip ANSI codes to get visible length
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

    const contentWidth = Math.max(
      stripAnsi(line1).length,
      stripAnsi(line3).length,
      stripAnsi(line4).length
    );

    const termW = process.stdout.columns || 80;
    const inner = Math.min(contentWidth + 4, termW - 6);

    // Build a row: "  │" + content padded to inner width + "│"
    const row = (content: string) => {
      const visible = stripAnsi(content).length;
      const padding = Math.max(0, inner - visible);
      return chalk.hex(THEME.border)('  │') + content + ' '.repeat(padding) + chalk.hex(THEME.border)('│');
    };

    console.log('');
    console.log(chalk.hex(THEME.border)('  ╭' + '─'.repeat(inner) + '╮'));

    console.log(row(line1));
    console.log(row(line2));
    console.log(row(line3));
    console.log(row(line4));

    console.log(chalk.hex(THEME.border)('  ╰' + '─'.repeat(inner) + '╯'));
    console.log('');
    console.log(`  ${chalk.white.bold('Tip:')} ${chalk.dim.italic('Type @opus, @claude, or @codex to speak directly to an agent.')}`);
    console.log('');
  }, [projectDir]);

  const flushBuffer = useCallback(() => {
    flushTimer.current = null;
    const items = outputBuffer.current.splice(0);
    if (items.length === 0) return;

    // Collect ALL output into a single string, then ONE console.log call.
    // This minimizes Ink's clear/redraw cycles (1 instead of N).
    const outputLines: string[] = [];

    // Helper: flush pending actions for an agent as a compact summary line
    const flushPendingActions = (agent: AgentId, agentColor: 'green' | 'yellow' | 'magenta') => {
      const actions = pendingActions.current.get(agent);
      if (!actions || actions.length === 0) return;
      const summary: DisplayEntry[] = [];
      if (actions.length <= 2) {
        for (const a of actions) summary.push({ text: a, kind: 'action' });
      } else {
        summary.push({ text: `${actions[actions.length - 1]} (+${actions.length - 1} more)`, kind: 'action' });
      }
      outputLines.push(...entriesToAnsiOutputLines(summary, agentColor));
      pendingActions.current.set(agent, []);
    };

    for (const { agent, entries } of items) {
      if (entries.length === 0) continue;
      const agentColor: 'green' | 'yellow' | 'magenta' = agent === 'opus' ? 'magenta' : agent === 'claude' ? 'green' : 'yellow';

      // Separate actions from content entries
      const contentEntries: DisplayEntry[] = [];
      const newActions: string[] = [];
      for (const e of entries) {
        if (e.kind === 'action') {
          newActions.push(e.text);
        } else {
          contentEntries.push(e);
        }
      }

      // Accumulate actions
      if (newActions.length > 0) {
        const existing = pendingActions.current.get(agent) ?? [];
        pendingActions.current.set(agent, [...existing, ...newActions]);
      }

      // If only actions and no content, show a compact single-line summary
      if (contentEntries.length === 0) {
        const allActions = pendingActions.current.get(agent) ?? [];
        if (allActions.length === 0) continue;
        // Show last action with total count
        if (lastPrintedAgent.current && lastPrintedAgent.current !== agent) {
          if (outputLines.length > 0) {
            console.log(compactOutputLines(outputLines).join('\n'));
            outputLines.length = 0;
          }
          console.log('');
          // Re-show agent label when switching
          const dot = chalk.hex(agentHex(agent))(DOT_ACTIVE);
          const agName = chalk.hex(agentHex(agent)).bold(agentName(agent));
          outputLines.push(`  ${dot} ${agName}`);
        }
        lastPrintedAgent.current = agent;
        const actionText = allActions.length <= 1
          ? allActions[allActions.length - 1]
          : `${allActions[allActions.length - 1]} (+${allActions.length - 1} more)`;
        outputLines.push(...entriesToAnsiOutputLines([{ text: actionText, kind: 'action' }], agentColor));
        // Clear pending — they've been shown
        pendingActions.current.set(agent, []);
        continue;
      }

      const prevKind = lastEntryKind.current.get(agent);
      const currentId = currentMsgRef.current.get(agent);
      if (currentId) {
        const msg = chatMessagesRef.current.find((m) => m.id === currentId);
        if (msg) {
          const agentSwitched = lastPrintedAgent.current && lastPrintedAgent.current !== agent;
          if (agentSwitched) {
            // Flush previous output, then separator
            if (outputLines.length > 0) {
              console.log(compactOutputLines(outputLines).join('\n'));
              outputLines.length = 0;
            }
            console.log('');
            // Re-show agent label so user knows who's speaking
            const dot = chalk.hex(agentHex(agent))(DOT_ACTIVE);
            const agName = chalk.hex(agentHex(agent)).bold(agentName(agent));
            outputLines.push(`  ${dot} ${agName}`);
          }
          lastPrintedAgent.current = agent;
          msg.lines.push(...entries);
          // Flush any pending actions as compact summary before content
          flushPendingActions(agent, agentColor);
          // Append content entries
          outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor, prevKind));
          // Update last kind
          const last = contentEntries[contentEntries.length - 1];
          if (last) lastEntryKind.current.set(agent, last.kind);
          continue;
        }
      }

      // New message — add blank line if different agent wrote before
      if (lastPrintedAgent.current && lastPrintedAgent.current !== agent) {
        // Flush what we have so far, then print the blank separator
        if (outputLines.length > 0) {
          console.log(compactOutputLines(outputLines).join('\n'));
          outputLines.length = 0;
        }
        console.log('');
      }
      lastPrintedAgent.current = agent;

      const id = randomUUID();
      currentMsgRef.current.set(agent, id);
      chatMessagesRef.current.push({ id, agent, lines: [...entries], timestamp: Date.now(), status: 'streaming' });
      if (chatMessagesRef.current.length > MAX_MESSAGES) {
        chatMessagesRef.current = chatMessagesRef.current.slice(-MAX_MESSAGES);
      }

      const dot = chalk.hex(agentHex(agent))(DOT_ACTIVE);
      const name = chalk.hex(agentHex(agent)).bold(agentName(agent));
      // Put dot + agent name + first text on same line
      const firstIdx = contentEntries.findIndex((e) => e.kind === 'text' || e.kind === 'heading');
      if (firstIdx !== -1) {
        const termW = process.stdout.columns || 80;
        const nameLen = agentName(agent).length;
        const maxW = Math.max(20, Math.min(termW - 4 - nameLen - 3, MAX_READABLE_WIDTH));
        const wrapped = wordWrap(contentEntries[firstIdx].text, maxW, INDENT);
        outputLines.push(`  ${dot} ${name}  ${wrapped[0]}`);
        for (let w = 1; w < wrapped.length; w++) outputLines.push(wrapped[w]);
        // Flush pending actions after header
        flushPendingActions(agent, agentColor);
        const rest = contentEntries.filter((_, i) => i !== firstIdx);
        if (rest.length > 0) {
          outputLines.push(...entriesToAnsiOutputLines(rest, agentColor));
        }
      } else {
        outputLines.push(`  ${dot} ${name}`);
        // Flush pending actions
        flushPendingActions(agent, agentColor);
        outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor));
      }
      // Track last kind
      const last = contentEntries[contentEntries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    if (outputLines.length > 0) {
      console.log(compactOutputLines(outputLines).join('\n'));
    }
  }, []);

  const enqueueOutput = useCallback((agent: AgentId, entries: DisplayEntry[]) => {
    outputBuffer.current.push({ agent, entries });
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(flushBuffer, FLUSH_INTERVAL);
    }
  }, [flushBuffer]);

  useInput((_input, key) => {
    if (key.escape && !stopped) {
      setStopped(true);
      setThinking(null);
      orchestrator.stop();
      console.log('');
      console.log(chalk.dim('  Agents stoppes. Tapez un message pour relancer, ou Ctrl+C pour quitter.'));
    }
  });

  const processTaskTags = useCallback((agent: AgentId, text: string) => {
    const { adds, dones } = extractTasks(text);
    if (adds.length > 0 || dones.length > 0) {
      setTodos((prev) => {
        let updated = [...prev];
        for (const add of adds) {
          if (!updated.some((t) => t.text.toLowerCase() === add.toLowerCase())) {
            updated.push({ id: randomUUID(), text: add, done: false, agent });
          }
        }
        for (const done of dones) {
          const lower = done.toLowerCase();
          // Try exact include first
          let idx = updated.findIndex((t) => !t.done && t.text.toLowerCase().includes(lower));
          // If no match, try keyword overlap (at least 2 significant words match)
          if (idx === -1) {
            const doneWords = lower.split(/\s+/).filter((w) => w.length > 3);
            idx = updated.findIndex((t) => {
              if (t.done) return false;
              const todoLower = t.text.toLowerCase();
              const matchCount = doneWords.filter((w) => todoLower.includes(w)).length;
              return matchCount >= 2;
            });
          }
          if (idx !== -1) updated[idx] = { ...updated[idx], done: true };
        }
        return updated;
      });
    }
  }, []);

  useEffect(() => {
    orchestrator.setConfig({ projectDir, claudePath, codexPath });
    orchestrator.bind({
      onAgentOutput: (agent: AgentId, line: OutputLine) => {
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const entries = outputToEntries(line);
        if (entries.length === 0) return;
        enqueueOutput(agent, entries);
      },
      onAgentStatus: (agent: AgentId, status: AgentStatus) => {
        if (agent === 'opus') setOpusStatus(status);
        if (agent === 'claude') setClaudeStatus(status);
        if (agent === 'codex') setCodexStatus(status);

        // Show spinner when any agent starts working, hide when ALL done
        if (status === 'running') {
          setThinking((prev) => prev ?? randomVerb());
        } else {
          const statuses = [
            agent === 'opus' ? status : orchestrator.opus.status,
            agent === 'claude' ? status : orchestrator.claude.status,
            agent === 'codex' ? status : orchestrator.codex.status,
          ];
          const anyRunningNow = statuses.some(s => s === 'running');
          if (!anyRunningNow) {
            setThinking(null);
          }
        }
        if (status === 'waiting' || status === 'idle' || status === 'error' || status === 'stopped') {
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushBuffer(); }
          // Flush any remaining pending actions for this agent
          const remaining = pendingActions.current.get(agent);
          if (remaining && remaining.length > 0) {
            const ac: 'green' | 'yellow' | 'magenta' = agent === 'opus' ? 'magenta' : agent === 'claude' ? 'green' : 'yellow';
            const summary: DisplayEntry[] = remaining.length <= 2
              ? remaining.map(a => ({ text: a, kind: 'action' as const }))
              : [{ text: `${remaining[remaining.length - 1]} (+${remaining.length - 1} more)`, kind: 'action' as const }];
            const lines = entriesToAnsiOutputLines(summary, ac);
            if (lines.length > 0) console.log(compactOutputLines(lines).join('\n'));
            pendingActions.current.set(agent, []);
          }
          const currentId = currentMsgRef.current.get(agent);
          if (currentId) {
            const msg = chatMessagesRef.current.find((m) => m.id === currentId);
            if (msg) msg.status = 'done';
            currentMsgRef.current.delete(agent);
            lastEntryKind.current.delete(agent);
          }
        }
      },
      onRelay: (msg: Message) => {
        logger.info(`[DASHBOARD] Relay: ${msg.from} → ${msg.to}`);
        const fromLabel = AGENT_LABELS[msg.from as AgentId] ?? msg.from;
        const toLabel = AGENT_LABELS[msg.to as AgentId] ?? msg.to;
        const preview = msg.content.length > 60 ? msg.content.slice(0, 60) + '...' : msg.content;
        const relayLine = `${fromLabel} -> ${toLabel}: ${preview}`;
        // Show relay as info on the sender's output
        const fromAgent = msg.from as AgentId;
        if (fromAgent === 'opus' || fromAgent === 'claude' || fromAgent === 'codex') {
          enqueueOutput(fromAgent, [{ text: relayLine, kind: 'info' }]);
        }
      },
      onRelayBlocked: (msg: Message) => {
        logger.info(`[DASHBOARD] Relay blocked: ${msg.from} → ${msg.to}`);
        const fromLabel = AGENT_LABELS[msg.from as AgentId] ?? msg.from;
        const toLabel = AGENT_LABELS[msg.to as AgentId] ?? msg.to;
        const fromAgent = msg.from as AgentId;
        if (fromAgent === 'opus' || fromAgent === 'claude' || fromAgent === 'codex') {
          enqueueOutput(fromAgent, [{ text: `Relay bloque: ${fromLabel} -> ${toLabel} (profondeur max)`, kind: 'info' }]);
        }
      },
    });
    // Resume session if --resume flag was passed
    if (resumeSessionId) {
      const sm = orchestrator.getSessionManager();
      if (sm) {
        const sessions = sm.listSessions();
        const match = sessions.find(s => s.id.startsWith(resumeSessionId));
        if (match) {
          const session = sm.loadSession(match.id);
          if (session) {
            const agentMeta: Record<string, { label: string; color: (s: string) => string; dot: string }> = {
              opus: { label: 'Opus', color: chalk.hex(THEME.opus), dot: chalk.hex(THEME.opus)(DOT_ACTIVE) },
              claude: { label: 'Sonnet', color: chalk.hex(THEME.claude), dot: chalk.hex(THEME.claude)(DOT_ACTIVE) },
              codex: { label: 'Codex', color: chalk.hex(THEME.codex), dot: chalk.hex(THEME.codex)(DOT_ACTIVE) },
              user: { label: 'User', color: chalk.hex(THEME.text), dot: chalk.hex(THEME.text)('❯') },
            };

            console.log(chalk.dim('  ─── Session reprise: ') + chalk.hex(THEME.claude)(match.id.slice(0, 8)) + chalk.dim(' ───'));
            console.log(chalk.dim(`  Tache: ${session.task}`));
            console.log('');

            // Show last messages from the session (max 10)
            const recentMsgs = session.messages.slice(-10);
            for (const msg of recentMsgs) {
              const meta = agentMeta[msg.from] ?? { label: msg.from, color: chalk.white, dot: chalk.dim('·') };
              const content = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
              if (msg.from === 'user') {
                console.log(`  ${chalk.dim('❯')}  ${chalk.white(content)}`);
              } else {
                console.log(`  ${meta.dot} ${chalk.bold(meta.color(meta.label))}`);
                console.log(`${INDENT}${chalk.dim(content)}`);
              }
            }

            console.log('');
            console.log(chalk.dim('  ─── Fin historique ───'));
            console.log('');

            // Build resume context from last 5 messages
            const contextLines = session.messages.slice(-5).map(m => {
              const label = agentMeta[m.from]?.label ?? m.from;
              const target = agentMeta[m.to]?.label ?? m.to;
              const short = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
              return `[${label}->${target}] ${short}`;
            });

            const resumePrompt = `SESSION REPRISE — Voici le contexte de la session precedente:\n\nTACHE ORIGINALE: ${session.task}\n\n--- HISTORIQUE ---\n${contextLines.join('\n')}\n--- FIN ---\n\nLa session reprend. Attends le prochain message du user.`;

            setThinking(randomVerb());
            orchestrator.startWithTask(resumePrompt).catch((err) => logger.error(`[DASHBOARD] Resume error: ${err}`));
          } else {
            console.log(chalk.red(`  Session ${resumeSessionId} non trouvee ou corrompue.`));
          }
        } else {
          console.log(chalk.red(`  Session ${resumeSessionId} non trouvee.`));
          console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
        }
      }
    }

    const handleExit = () => { orchestrator.stop().finally(() => exit()); };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
    return () => {
      process.off('SIGINT', handleExit);
      process.off('SIGTERM', handleExit);
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [orchestrator, exit, projectDir, claudePath, codexPath, resumeSessionId, processTaskTags, enqueueOutput, flushBuffer]);

  const handleInput = useCallback(
    (text: string) => {
      const termW = process.stdout.columns || 80;
      const bubbleWidth = Math.max(20, termW - (BUBBLE_SIDE_MARGIN * 2));
      const wrapWidth = Math.max(10, Math.min(bubbleWidth - 3, MAX_READABLE_WIDTH)); // reserve " ❯ " prefix
      const wrapped = wordWrap(text, wrapWidth, '');

      const printBg = (line: string) => {
        const visible = stripAnsi(line).length;
        const pad = Math.max(0, bubbleWidth - visible);
        const margin = ' '.repeat(BUBBLE_SIDE_MARGIN);
        console.log(`${margin}${chalk.bgHex(THEME.userBubbleBg)(line + ' '.repeat(pad))}${margin}`);
      };

      const userPrefix = chalk.hex(THEME.userPrefix)(' ❯ ');
      console.log('');
      printBg(`${userPrefix}${chalk.hex(THEME.text)(wrapped[0] || '')}`);
      for (let i = 1; i < wrapped.length; i++) {
        printBg(`   ${chalk.hex(THEME.text)(wrapped[i] ?? '')}`);
      }
      console.log('');
      chatMessagesRef.current.push({
        id: randomUUID(), agent: 'user',
        lines: [{ text, kind: 'text' }],
        timestamp: Date.now(), status: 'done',
      });

      setThinking(randomVerb());

      // @sessions command — list saved sessions in chat
      if (text.trim() === '@sessions') {
        const sm = orchestrator.getSessionManager();
        if (!sm) {
          console.log(chalk.dim('    Session manager not initialized yet.'));
          return;
        }
        const sessions = sm.listSessions();
        if (sessions.length === 0) {
          console.log(chalk.dim('    Aucune session enregistree.'));
        } else {
          console.log('');
          console.log(chalk.white.bold('    Sessions enregistrees'));
          console.log(chalk.dim('    ' + '─'.repeat(50)));
          for (const s of sessions.slice(0, 10)) {
            const date = new Date(s.startedAt);
            const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const status = s.finishedAt ? chalk.hex(THEME.codex)('done') : chalk.hex(THEME.info)('run');
            const task = s.task.length > 40 ? s.task.slice(0, 40) + '...' : s.task;
            const shortId = s.id.slice(0, 8);
            console.log(`    ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.hex(THEME.claude)(shortId)}  ${status}  ${chalk.hex(THEME.text)(task)}`);
          }
          console.log('');
          console.log(chalk.dim('    Voir en detail: fedi --view <id>'));
          console.log('');
        }
        return;
      }

      // Parse @agent commands first
      let targetAgent: AgentId | null = null;
      let agentMessage = text;
      if (text.startsWith('@opus ')) { targetAgent = 'opus'; agentMessage = text.slice(6); }
      else if (text.startsWith('@codex ')) { targetAgent = 'codex'; agentMessage = text.slice(7); }
      else if (text.startsWith('@claude ') || text.startsWith('@sonnet ')) { targetAgent = 'claude'; agentMessage = text.slice(text.indexOf(' ') + 1); }

      if (!orchestrator.isStarted || stopped) {
        // Restart first, then route to the right agent
        setStopped(false);
        setTodos([]);
        if (targetAgent && targetAgent !== 'opus') {
          // Start Opus with minimal init, then send directly to the target agent
          orchestrator.restart(`Le user veut parler directement a ${targetAgent === 'claude' ? 'Sonnet' : 'Codex'}. Attends.`).then(() => {
            orchestrator.sendToAgent(targetAgent!, agentMessage);
          }).catch((err) => logger.error(`[DASHBOARD] Start error: ${err}`));
        } else {
          orchestrator.restart(targetAgent === 'opus' ? agentMessage : text).catch((err) => logger.error(`[DASHBOARD] Start error: ${err}`));
        }
        return;
      }

      if (targetAgent) {
        orchestrator.sendToAgent(targetAgent, agentMessage);
        return;
      }
      orchestrator.sendUserMessage(text);
    },
    [orchestrator, stopped],
  );

  const opusRunning = opusStatus === 'running';
  const claudeRunning = claudeStatus === 'running';
  const codexRunning = codexStatus === 'running';

  // Ink ALWAYS renders the same small structure — no conditional branches
  // that change the tree shape. This prevents ghost frames in scrollback.

  const anyRunning = opusRunning || claudeRunning || codexRunning;

  const agentPill = (name: string, running: boolean, color: string) => {
    if (running) {
      return (
        <Text>
          <Text color={color}>{DOT_ACTIVE}</Text>
          <Text color={color} bold>{` ${name} `}</Text>
        </Text>
      );
    }
    return (
      <Text>
        <Text color={THEME.muted}>{DOT_IDLE}</Text>
        <Text color={THEME.muted} dimColor>{` ${name} `}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Text>{' '}</Text>
      {thinking ? <ThinkingSpinner /> : <Text>{' '}</Text>}
      {todos.length > 0 && <TodoPanel items={todos} />}
      <Box width="100%" flexGrow={1}>
        <Box width="100%" flexGrow={1} paddingY={0} borderStyle="round" borderColor={anyRunning ? THEME.opus : THEME.panelBorder}>
          <Text color={THEME.text}>{' ❯ '}</Text>
          <Box flexGrow={1}>
            <InputBar onSubmit={handleInput} placeholder="Improve documentation in @filename" />
          </Box>
        </Box>
      </Box>
      <Box paddingX={2} paddingTop={0} justifyContent="space-between">
        <Text>
          <Text dimColor>{'esc '}</Text>
          <Text color={THEME.muted}>{'stop'}</Text>
          <Text dimColor>{'  ·  '}</Text>
          <Text dimColor>{'^C '}</Text>
          <Text color={THEME.muted}>{'quit'}</Text>
        </Text>
        <Box>
          {agentPill('Opus', opusRunning, THEME.opus)}
          <Text dimColor>{'  '}</Text>
          {agentPill('Sonnet', claudeRunning, THEME.claude)}
          <Text dimColor>{'  '}</Text>
          {agentPill('Codex', codexRunning, THEME.codex)}
        </Box>
      </Box>
    </Box>
  );
}
