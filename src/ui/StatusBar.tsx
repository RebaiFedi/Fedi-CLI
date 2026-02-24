import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatus } from '../agents/types.js';

interface StatusBarProps {
  claudeStatus: AgentStatus;
  codexStatus: AgentStatus;
  projectDir: string;
}

function dot(status: AgentStatus): { d: string; c: string } {
  switch (status) {
    case 'running': return { d: '●', c: 'green' };
    case 'waiting': return { d: '●', c: 'greenBright' };
    case 'error':   return { d: '●', c: 'red' };
    default:        return { d: '○', c: 'gray' };
  }
}

export function StatusBar({ claudeStatus, codexStatus, projectDir }: StatusBarProps) {
  const c = dot(claudeStatus);
  const x = dot(codexStatus);
  const dir = projectDir.split('/').slice(-2).join('/');

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text><Text color={c.c}>{c.d}</Text><Text dimColor> Claude</Text></Text>
        <Text><Text color={x.c}>{x.d}</Text><Text dimColor> Codex</Text></Text>
        <Text dimColor>{dir}</Text>
      </Box>
      <Text dimColor>PgUp/Dn scroll · Esc stop · ^C quit</Text>
    </Box>
  );
}
