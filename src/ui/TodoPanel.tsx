import React from 'react';
import { Box, Text } from 'ink';
import type { AgentId } from '../agents/types.js';
import { THEME, agentHex } from '../config/theme.js';
import { MAX_VISIBLE_TODOS } from '../config/constants.js';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  agent: AgentId;
}

// ── Modern progress bar characters ──────────────────────────────────────
const BAR_FILLED = '\u2588';   // █
const BAR_PARTIAL = '\u2593';  // ▓
const BAR_EMPTY = '\u2591';    // ░

function TodoPanelComponent({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;

  const doneCount = items.filter((t) => t.done).length;
  const total = items.length;
  const pct = Math.round((doneCount / total) * 100);
  const allDone = doneCount === total;

  // Sort: in-progress first, then pending, then done
  const sorted = [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return 0;
  });
  const visible = sorted.slice(0, MAX_VISIBLE_TODOS);
  const hidden = Math.max(0, sorted.length - MAX_VISIBLE_TODOS);

  // Progress bar — sleek gradient feel
  const barWidth = 20;
  const filled = Math.round((doneCount / total) * barWidth);
  const barColor = allDone ? '#22C55E' : '#F59E0B';
  const barDimColor = '#1E293B';

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      {/* ── Header line ───────────────────────────────────── */}
      <Box>
        <Text color="#64748B">{' \u250C\u2500 '}</Text>
        <Text color={barColor} bold>{'TASKS'}</Text>
        <Text color="#475569">{' \u2500\u2500 '}</Text>
        <Text color={barColor}>{BAR_FILLED.repeat(filled)}</Text>
        {filled < barWidth && (
          <Text color={barColor} dimColor>{BAR_PARTIAL}</Text>
        )}
        <Text color={barDimColor}>{BAR_EMPTY.repeat(Math.max(0, barWidth - filled - 1))}</Text>
        <Text color="#475569">{' '}</Text>
        <Text color={allDone ? '#22C55E' : '#94A3B8'} bold>{`${pct}%`}</Text>
        <Text color="#475569">{` (${doneCount}/${total})`}</Text>
      </Box>

      {/* ── Task items ────────────────────────────────────── */}
      {visible.map((item) => {
        const maxLen = Math.min(55, (process.stdout.columns || 80) - 16);
        const label = item.text.length > maxLen ? item.text.slice(0, maxLen - 1) + '\u2026' : item.text;
        if (item.done) {
          return (
            <Box key={item.id}>
              <Text color="#334155">{' \u2502  '}</Text>
              <Text color="#22C55E">{'\u25C9'}</Text>
              <Text>{' '}</Text>
              <Text color="#475569" strikethrough>{label}</Text>
            </Box>
          );
        }
        return (
          <Box key={item.id}>
            <Text color="#334155">{' \u2502  '}</Text>
            <Text color={agentHex(item.agent)}>{'\u25CB'}</Text>
            <Text>{' '}</Text>
            <Text color={THEME.text}>{label}</Text>
          </Box>
        );
      })}

      {/* ── Hidden count ──────────────────────────────────── */}
      {hidden > 0 && (
        <Box>
          <Text color="#334155">{' \u2502  '}</Text>
          <Text color="#64748B" italic>{`+${hidden} more`}</Text>
        </Box>
      )}

      {/* ── Footer line ───────────────────────────────────── */}
      <Box>
        <Text color="#334155">{' \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'}</Text>
      </Box>
    </Box>
  );
}

export const TodoPanel = React.memo(TodoPanelComponent);
