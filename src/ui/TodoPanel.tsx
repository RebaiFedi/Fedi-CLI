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

export function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const doneCount = items.filter((t) => t.done).length;
  const total = items.length;

  const visible = items.slice(0, MAX_VISIBLE_TODOS);
  const hidden = items.length - MAX_VISIBLE_TODOS;

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
          {doneCount}/{total}
        </Text>
      </Text>
    </Box>
  );
}
