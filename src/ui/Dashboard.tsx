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

// ── Filters ─────────────────────────────────────────────────────────────────

const TOOL_RE = /^\s*(EnterPlanMode|AskUserQuestion|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookEdit|EnterWorktree|WebSearch|WebFetch)\s*$/;
const RELAY_PREFIX_RE = /^\s*\[(TO|FROM):(CLAUDE|CODEX|OPUS)\]\s*/i;
const RELAY_LINE_RE = /^\s*\[TO:(CLAUDE|CODEX|OPUS)\]\s/i;
const TASK_ADD_RE = /\[TASK:add\]\s*(.+)/i;
const TASK_DONE_RE = /\[TASK:done\]\s*(.+)/i;

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

function agentColorDot(agentColor: 'green' | 'yellow' | 'magenta'): string {
  if (agentColor === 'green') return chalk.green('• ');
  if (agentColor === 'magenta') return chalk.magenta('• ');
  return chalk.yellow('• ');
}

function entryToAnsiLines(e: DisplayEntry, agentColor: 'green' | 'yellow' | 'magenta'): string[] {
  const termW = process.stdout.columns || 80;
  const indentW = INDENT.length;
  const maxW = termW - indentW;

  if (e.kind === 'empty') return [''];

  if (e.kind === 'info') {
    const raw = `${INDENT}  ${chalk.yellowBright('!')} ${chalk.yellow(e.text)}`;
    return wordWrap(raw, termW, `${INDENT}    `);
  }

  if (e.kind === 'action') {
    const raw = `${INDENT}    ${chalk.dim(e.text)}`;
    return wordWrap(raw, termW, `${INDENT}      `);
  }

  if (e.kind === 'code') {
    const codeIndent = `${INDENT}  `;
    const raw = chalk.yellow(e.text);
    return wordWrap(raw, termW - codeIndent.length, codeIndent).map((l, i) => i === 0 ? `${codeIndent}${l}` : l);
  }

  if (e.kind === 'separator') {
    // Truncate separator lines to fit terminal width
    const sepText = e.text.length > maxW ? e.text.slice(0, maxW) : e.text;
    return [`${INDENT}${chalk.dim(sepText)}`];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.cyanBright : chalk.white;
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
    if (buf.length <= 6) {
      for (const a of buf) out.push({ text: a.trim(), kind: 'action' });
    } else {
      for (const a of buf.slice(0, 2)) out.push({ text: a.trim(), kind: 'action' });
      out.push({ text: `… ${buf.length - 4} more`, kind: 'action' });
      for (const a of buf.slice(-2)) out.push({ text: a.trim(), kind: 'action' });
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
    if (e.kind === 'empty' && out.length > 0 && out[out.length - 1].kind === 'empty') continue;
    out.push(e);
  }
  while (out.length > 0 && out[0].kind === 'empty') out.shift();
  while (out.length > 0 && out[out.length - 1].kind === 'empty') out.pop();
  return out;
}

function addActionSpacing(raw: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    const prev = i > 0 ? raw[i - 1] : null;
    const next = i < raw.length - 1 ? raw[i + 1] : null;
    if (e.kind === 'action' && (!prev || (prev.kind !== 'action' && prev.kind !== 'empty'))) {
      out.push({ text: '', kind: 'empty' });
    }
    out.push(e);
    if (e.kind === 'action' && (!next || (next.kind !== 'action' && next.kind !== 'empty'))) {
      out.push({ text: '', kind: 'empty' });
    }
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
    <Box flexDirection="column" borderStyle="round" borderColor="#444444" paddingX={1}>
      <Text>
        <Text bold color="whiteBright">{'  Plan '}</Text>
        <Text dimColor>{`${doneCount}/${total} `}</Text>
        <Text color="cyanBright">{bar}</Text>
        <Text dimColor>{` ${pct}%`}</Text>
      </Text>
      {visible.map((item) => (
        <Text key={item.id}>
          {item.done
            ? <Text color="green">{'  ✓ '}</Text>
            : <Text dimColor>{'  ○ '}</Text>
          }
          <Text color={item.done ? 'gray' : 'whiteBright'} strikethrough={item.done}>
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

  // Print welcome banner once at mount via stdout (not Ink)
  useEffect(() => {
    if (welcomePrinted.current) return;
    welcomePrinted.current = true;
    const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');

    const line1 = `  ${chalk.white.bold('>_ FEDI CLI')} ${chalk.dim('(v1.0)')}`;
    const line2 = '';
    const line3 = `  ${chalk.dim('agents:')}     ${chalk.magentaBright('Opus')} ${chalk.dim('(Director)')}, ${chalk.cyanBright('Sonnet')} ${chalk.dim('(Code)')}, ${chalk.greenBright('Codex')} ${chalk.dim('(Script)')}`;
    const line4 = `  ${chalk.dim('directory:')}  ${chalk.white(dir)}`;

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
      return chalk.dim('  │') + content + ' '.repeat(padding) + chalk.dim('│');
    };

    console.log('');
    console.log(chalk.dim('  ╭' + '─'.repeat(inner) + '╮'));

    console.log(row(line1));
    console.log(row(line2));
    console.log(row(line3));
    console.log(row(line4));

    console.log(chalk.dim('  ╰' + '─'.repeat(inner) + '╯'));
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

    for (const { agent, entries } of items) {
      if (entries.length === 0) continue;
      const agentColor: 'green' | 'yellow' | 'magenta' = agent === 'opus' ? 'magenta' : agent === 'claude' ? 'green' : 'yellow';

      const prevKind = lastEntryKind.current.get(agent);
      const currentId = currentMsgRef.current.get(agent);
      if (currentId) {
        const msg = chatMessagesRef.current.find((m) => m.id === currentId);
        if (msg) {
          msg.lines.push(...entries);
          // Append only new entries, with context from last entry for correct spacing
          outputLines.push(...entriesToAnsiOutputLines(entries, agentColor, prevKind));
          // Update last kind
          const last = entries[entries.length - 1];
          if (last) lastEntryKind.current.set(agent, last.kind);
          continue;
        }
      }

      // New message — add header
      const id = randomUUID();
      currentMsgRef.current.set(agent, id);
      chatMessagesRef.current.push({ id, agent, lines: [...entries], timestamp: Date.now(), status: 'streaming' });
      if (chatMessagesRef.current.length > MAX_MESSAGES) {
        chatMessagesRef.current = chatMessagesRef.current.slice(-MAX_MESSAGES);
      }

      const dot = agent === 'opus' ? chalk.magentaBright('●') : agent === 'claude' ? chalk.cyanBright('●') : chalk.greenBright('●');
      const agentName = agent === 'opus' ? chalk.magentaBright.bold('Opus') : agent === 'claude' ? chalk.cyanBright.bold('Sonnet') : chalk.greenBright.bold('Codex');
      outputLines.push('');
      // First text/heading entry goes on same line as agent header
      const firstIdx = entries.findIndex((e) => e.kind === 'text' || e.kind === 'heading');
      if (firstIdx !== -1) {
        const firstEntry = entries[firstIdx];
        const termW = process.stdout.columns || 80;
        const firstText = firstEntry.text;
        const wrapped = wordWrap(firstText, termW - INDENT.length, INDENT);
        outputLines.push(`  ${dot} ${agentName}`);
        outputLines.push(`${INDENT}${wrapped[0]}`);
        for (let w = 1; w < wrapped.length; w++) outputLines.push(wrapped[w]);
        // Rest of entries (skip the one we already rendered)
        const rest = entries.filter((_, i) => i !== firstIdx);
        if (rest.length > 0) {
          outputLines.push(...entriesToAnsiOutputLines(rest, agentColor));
        }
      } else {
        outputLines.push(`  ${dot} ${agentName}`);
        outputLines.push(...entriesToAnsiOutputLines(entries, agentColor));
      }
      // Track last kind
      const last = entries[entries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    if (outputLines.length > 0) {
      console.log(outputLines.join('\n'));
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
        setThinking(null);
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const entries = outputToEntries(line);
        if (entries.length === 0) return;
        enqueueOutput(agent, entries);
      },
      onAgentStatus: (agent: AgentId, status: AgentStatus) => {
        if (agent === 'opus') setOpusStatus(status);
        if (agent === 'claude') setClaudeStatus(status);
        if (agent === 'codex') setCodexStatus(status);
        if (status === 'error' || status === 'stopped') {
          setThinking(null);
        }
        if (status === 'waiting' || status === 'idle' || status === 'error' || status === 'stopped') {
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushBuffer(); }
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
              opus: { label: 'Opus', color: chalk.magentaBright, dot: chalk.magentaBright('●') },
              claude: { label: 'Sonnet', color: chalk.cyanBright, dot: chalk.cyanBright('●') },
              codex: { label: 'Codex', color: chalk.greenBright, dot: chalk.greenBright('●') },
              user: { label: 'User', color: chalk.white, dot: chalk.white('❯') },
            };

            console.log(chalk.dim('  ─── Session reprise: ') + chalk.cyanBright(match.id.slice(0, 8)) + chalk.dim(' ───'));
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
      console.log('');
      const termW = process.stdout.columns || 80;
      const availW = termW - 3;
      const wrapped = wordWrap(text, availW, '   ');

      const printBg = (line: string) => {
        const visible = stripAnsi(line).length;
        const pad = Math.max(0, termW - visible);
        console.log(chalk.bgHex('#2b2b2b')(line + ' '.repeat(pad)));
      };

      const userPrefix = chalk.cyanBright(' ❯ ');
      printBg(`${userPrefix}${chalk.white(wrapped[0] || '')}`);
      for (let i = 1; i < wrapped.length; i++) {
        printBg(`   ${chalk.white(wrapped[i])}`);
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
            const status = s.finishedAt ? chalk.green('done') : chalk.yellow('run');
            const task = s.task.length > 40 ? s.task.slice(0, 40) + '...' : s.task;
            const shortId = s.id.slice(0, 8);
            console.log(`    ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.cyanBright(shortId)}  ${status}  ${chalk.white(task)}`);
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
  const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');
  const opusLabel = opusRunning ? 'working' : opusStatus === 'waiting' ? 'idle' : opusStatus;
  const claudeLabel = claudeRunning ? 'working' : claudeStatus === 'waiting' ? 'idle' : claudeStatus;
  const codexLabel = codexRunning ? 'working' : codexStatus === 'waiting' ? 'idle' : codexStatus;

  // Ink ALWAYS renders the same small structure — no conditional branches
  // that change the tree shape. This prevents ghost frames in scrollback.
  return (
    <Box flexDirection="column">
      {thinking && <ThinkingSpinner />}
      {todos.length > 0 && <TodoPanel items={todos} />}
      <Box width="100%" flexGrow={1}>
        <Box width="100%" flexGrow={1} paddingX={1} paddingY={0} borderStyle="round" borderColor="gray">
          <Text color="white">{' ❯ '}</Text>
          <Box flexGrow={1}>
            <InputBar onSubmit={handleInput} placeholder="Improve documentation in @filename" />
          </Box>
        </Box>
      </Box>
      <Box paddingX={1} paddingTop={1} justifyContent="space-between">
        <Text dimColor>{'Esc stop · ^C quit · @sessions'}</Text>
        <Text>
          <Text color={opusRunning ? 'magentaBright' : 'gray'}>{opusRunning ? '● ' : '○ '}</Text>
          <Text dimColor>{opusLabel.padEnd(7)}</Text>
          <Text>{'  '}</Text>
          <Text color={claudeRunning ? 'cyanBright' : 'gray'}>{claudeRunning ? '● ' : '○ '}</Text>
          <Text dimColor>{claudeLabel.padEnd(7)}</Text>
          <Text>{'  '}</Text>
          <Text color={codexRunning ? 'blueBright' : 'gray'}>{codexRunning ? '● ' : '○ '}</Text>
          <Text dimColor>{codexLabel.padEnd(7)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
