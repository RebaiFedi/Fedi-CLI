import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../agents/types.js';

interface CommLogProps {
  messages: Message[];
  maxMessages?: number;
}

export function CommLog({ messages, maxMessages = 4 }: CommLogProps) {
  const visible = messages.slice(-maxMessages);

  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">⚡ Communication</Text>
      {visible.map((msg) => {
        const fromColor = msg.from === 'claude' ? 'cyan' : msg.from === 'codex' ? 'green' : 'white';
        const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        return (
          <Box key={msg.id} gap={1}>
            <Text dimColor>{time}</Text>
            <Text color={fromColor} bold>{msg.from}</Text>
            <Text dimColor>→</Text>
            <Text bold>{msg.to}</Text>
            <Text wrap="truncate-end">{msg.content.slice(0, 90)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
