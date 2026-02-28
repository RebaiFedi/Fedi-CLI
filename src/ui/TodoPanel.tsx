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

function TodoPanelComponent({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const doneCount = items.filter((t) => t.done).length;
  const total = items.length;
  const pct = Math.round((doneCount / total) * 100);

  // Show in-progress first, then pending, then done (most relevant on top)
  const sorted = [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return 0;
  });
  const visible = sorted.slice(0, MAX_VISIBLE_TODOS);
  const hidden = items.length - MAX_VISIBLE_TODOS;

  // Progress bar
  const barWidth = 16;
  const filled = Math.round((doneCount / total) * barWidth);
  const barFilled = '\u2501'.repeat(filled);
  const barEmpty = '\u2500'.repeat(barWidth - filled);
  const barColor = doneCount === total ? THEME.codex : THEME.opus;

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={0}>
      <Box>
        <Text dimColor>  </Text>
        <Text color={barColor} bold>{barFilled}</Text>
        <Text color={THEME.muted}>{barEmpty}</Text>
        <Text color={THEME.muted}> {doneCount}</Text>
        <Text dimColor>/</Text>
        <Text color={THEME.muted}>{total}</Text>
        <Text dimColor> ({pct}%)</Text>
      </Box>
      {visible.map((item) => {
        const maxLen = Math.min(60, (process.stdout.columns || 80) - 12);
        const label = item.text.length > maxLen ? item.text.slice(0, maxLen - 3) + '...' : item.text;
        if (item.done) {
          return (
            <Text key={item.id} dimColor>
              {'  '}
              <Text color={THEME.codex}>{'\u2714'}</Text>
              {' '}
              <Text strikethrough>{label}</Text>
            </Text>
          );
        }
        return (
          <Text key={item.id}>
            {'  '}
            <Text color={agentHex(item.agent)}>{'\u25B6'}</Text>
            {' '}
            <Text color={THEME.text}>{label}</Text>
          </Text>
        );
      })}
      {hidden > 0 && <Text dimColor>{'    +' + hidden + ' more'}</Text>}
    </Box>
  );
}

export const TodoPanel = React.memo(TodoPanelComponent);
