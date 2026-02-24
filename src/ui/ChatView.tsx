import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ChatMessage, DisplayEntry } from '../agents/types.js';

interface ChatViewProps {
  messages: ChatMessage[];
  height: number;
  scrollOffset: number;
  autoScroll: boolean;
  onScrollChange: (offset: number) => void;
  onAutoScrollChange: (auto: boolean) => void;
}

// ── Filter tool name lines ──────────────────────────────────────────────────

const TOOL_RE = /^\s*(EnterPlanMode|AskUserQuestion|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookEdit|EnterWorktree|WebSearch|WebFetch)\s*$/;

function filterTools(entries: DisplayEntry[]): DisplayEntry[] {
  return entries.filter((e) => e.kind !== 'text' || !TOOL_RE.test(e.text));
}

// ── Collapse actions ────────────────────────────────────────────────────────

function collapseActions(entries: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    if (buf.length <= 4) {
      for (const a of buf) out.push({ text: a.trim(), kind: 'action' });
    } else {
      out.push({ text: `… ${buf.length - 2} more`, kind: 'action' });
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

// ── Remove consecutive empties ──────────────────────────────────────────────

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

// ── Flat line types ─────────────────────────────────────────────────────────

type LK = 'agent' | 'body' | 'action' | 'heading' | 'dim' | 'gap' | 'spin' | 'codex-lbl' | 'codex-act';

interface FL {
  text: string;
  kind: LK;
  bold?: boolean;
  agentId?: 'claude' | 'codex' | 'gemini' | 'user' | 'system';
}

function flatten(messages: ChatMessage[]): FL[] {
  const out: FL[] = [];

  for (const msg of messages) {
    const entries = compact(collapseActions(filterTools(msg.lines)));

    // Codex: compact actions only
    if (msg.agent === 'codex') {
      const acts = entries.filter((e) => e.kind === 'action');
      if (acts.length === 0 && msg.status !== 'streaming') continue;
      out.push({ text: '   ◇ Codex', kind: 'codex-lbl', agentId: 'codex' });
      if (acts.length === 0) {
        out.push({ text: '', kind: 'spin', agentId: 'codex' });
      } else {
        for (const a of acts) out.push({ text: `     ● ${a.text}`, kind: 'codex-act' });
      }
      continue;
    }

    // Gap before message blocks
    if (out.length > 0) out.push({ text: '', kind: 'gap' });

    // Agent header
    if (msg.agent === 'claude') {
      out.push({ text: '  ◆ Claude', kind: 'agent', bold: true, agentId: 'claude' });
    } else if (msg.agent === 'user') {
      out.push({ text: '  ▸ You', kind: 'agent', bold: true, agentId: 'user' });
    } else {
      out.push({ text: '  ● System', kind: 'agent', bold: true, agentId: 'system' });
    }

    if (entries.length === 0 && msg.status === 'streaming') {
      out.push({ text: '', kind: 'spin', agentId: msg.agent });
      continue;
    }

    for (const e of entries) {
      switch (e.kind) {
        case 'empty':     out.push({ text: '', kind: 'gap' }); break;
        case 'action':    out.push({ text: `   ● ${e.text}`, kind: 'action' }); break;
        case 'heading':   out.push({ text: `   ${e.text}`, kind: 'heading', bold: true }); break;
        case 'separator': out.push({ text: `   ${e.text}`, kind: 'dim' }); break;
        default:          out.push({ text: `   ${e.text}`, kind: 'body' }); break;
      }
    }
  }

  return out;
}

// ── Render ───────────────────────────────────────────────────────────────────

export function ChatView({ messages, height, scrollOffset, autoScroll, onScrollChange, onAutoScrollChange }: ChatViewProps) {
  const viewH = Math.max(height, 5);
  const flat = useMemo(() => flatten(messages), [messages]);
  const total = flat.length;
  const maxOff = Math.max(0, total - viewH);

  // Compute effective offset
  let offset: number;
  if (autoScroll) {
    offset = maxOff;
    // Sync parent state if it's behind
    if (scrollOffset !== maxOff) {
      // Schedule update for next tick to avoid setState during render warning
      Promise.resolve().then(() => onScrollChange(maxOff));
    }
  } else {
    offset = Math.min(scrollOffset, maxOff);
    // Re-enable autoScroll if user scrolled to bottom
    if (offset >= maxOff && maxOff > 0) {
      Promise.resolve().then(() => onAutoScrollChange(true));
    }
  }

  const visible = flat.slice(offset, offset + viewH);
  const streaming = new Set(messages.filter((m) => m.status === 'streaming').map((m) => m.agent));
  const pct = maxOff > 0 ? Math.round((offset / maxOff) * 100) : 100;
  const showIndicator = !autoScroll && total > viewH;

  // Pad to fill height
  const usedLines = visible.length + (showIndicator ? 1 : 0);
  const padCount = Math.max(0, viewH - usedLines);

  return (
    <Box flexDirection="column">
      {/* Scroll indicator */}
      {showIndicator && (
        <Text dimColor>{`  ── ${pct}% ── PgUp↑ PgDn↓ ──`}</Text>
      )}

      {visible.length === 0 ? (
        <Text dimColor>{'  Waiting for your message...'}</Text>
      ) : (
        visible.map((ln, i) => {
          const k = `${offset}-${i}`;
          switch (ln.kind) {
            case 'agent': {
              const cols: Record<string, string> = { claude: 'cyanBright', user: 'magentaBright', system: 'gray' };
              const col = ln.agentId ? (cols[ln.agentId] ?? 'white') : 'white';
              const live = ln.agentId ? streaming.has(ln.agentId) : false;
              return <Text key={k} bold color={col}>{ln.text}{live ? <Text color="green">{' ●'}</Text> : null}</Text>;
            }
            case 'codex-lbl': {
              const live = streaming.has('codex');
              return <Text key={k} dimColor>{ln.text}{live ? <Text color="green">{' ●'}</Text> : null}</Text>;
            }
            case 'codex-act':
              return <Text key={k} color="green" dimColor>{ln.text}</Text>;
            case 'action':
              return <Text key={k} color="green" dimColor>{ln.text}</Text>;
            case 'body':
              return <Text key={k} color="whiteBright">{ln.text}</Text>;
            case 'heading':
              return <Text key={k} bold color="whiteBright">{ln.text}</Text>;
            case 'dim':
              return <Text key={k} dimColor>{ln.text}</Text>;
            case 'gap':
              return <Text key={k}>{''}</Text>;
            case 'spin': {
              const sc = ln.agentId === 'codex' ? 'green' : 'cyanBright';
              return <Text key={k} color={sc}>{'   '}<Spinner type="dots" /></Text>;
            }
            default:
              return <Text key={k} color="whiteBright">{ln.text}</Text>;
          }
        })
      )}

      {/* Pad remaining space */}
      {padCount > 0 && Array.from({ length: padCount }, (_, i) => (
        <Text key={`p${i}`}>{''}</Text>
      ))}
    </Box>
  );
}
