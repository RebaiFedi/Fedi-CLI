import React from 'react';
import { Box, Text } from 'ink';
import type { AgentId } from '../agents/types.js';
import { THEME, agentHex, agentDisplayName } from '../config/theme.js';
import { MAX_VISIBLE_TODOS } from '../config/constants.js';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  agent: AgentId;
}

const BAR_WIDTH = 12;

function buildProgressBar(done: number, total: number): string {
  if (total === 0) return '';
  const filled = Math.round((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function TodoPanelComponent({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const doneCount = items.filter((t) => t.done).length;
  const total = items.length;

  const visible = items.slice(0, MAX_VISIBLE_TODOS);
  const hidden = items.length - MAX_VISIBLE_TODOS;

  const progressBar = buildProgressBar(doneCount, total);

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={0}>
      <Text dimColor>{'  ' + '\u2500'.repeat(40)}</Text>
      {visible.map((item) => {
        const label = item.text.length > 55 ? item.text.slice(0, 52) + '...' : item.text;
        const agColor = agentHex(item.agent);
        const agName = agentDisplayName(item.agent);
        if (item.done) {
          return (
            <Text key={item.id} dimColor>
              {'  '}
              <Text color={THEME.codex}>{'\u2713'}</Text>
              {' '}
              <Text strikethrough>{label}</Text>
              <Text>{' '}</Text>
              <Text color={agColor}>{agName}</Text>
            </Text>
          );
        }
        return (
          <Text key={item.id}>
            {'  '}
            <Text color={THEME.opus}>{'\u25B8'}</Text>
            {' '}
            <Text color={THEME.text}>{label}</Text>
            <Text>{' '}</Text>
            <Text dimColor color={agColor}>{agName}</Text>
          </Text>
        );
      })}
      {hidden > 0 && <Text dimColor>{'    +' + hidden + ' more'}</Text>}
      <Text dimColor>
        {'  ' + '\u2500'.repeat(40) + ' '}
        <Text color={doneCount === total ? THEME.codex : THEME.muted}>
          {progressBar}{' '}{doneCount}/{total}
        </Text>
      </Text>
    </Box>
  );
}

export const TodoPanel = React.memo(TodoPanelComponent);
