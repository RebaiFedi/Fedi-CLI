import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatus } from '../agents/types.js';

interface BannerProps {
  claudeStatus: AgentStatus;
  codexStatus: AgentStatus;
  projectDir: string;
}

function dot(s: AgentStatus): { d: string; c: string; l: string } {
  switch (s) {
    case 'running': return { d: '●', c: 'green', l: 'working' };
    case 'waiting': return { d: '●', c: 'greenBright', l: 'ready' };
    case 'error':   return { d: '●', c: 'red', l: 'error' };
    case 'stopped': return { d: '○', c: 'gray', l: 'stopped' };
    default:        return { d: '○', c: 'gray', l: 'idle' };
  }
}

export function Banner({ claudeStatus, codexStatus, projectDir }: BannerProps) {
  const c = dot(claudeStatus);
  const x = dot(codexStatus);
  const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text bold color="cyanBright">◆ FEDI</Text>
        <Text dimColor> │ </Text>
        <Text color={c.c}>{c.d}</Text><Text color="white" bold> Claude</Text><Text dimColor> ({c.l})</Text>
        <Text dimColor>  </Text>
        <Text color={x.c}>{x.d}</Text><Text color="white" bold> Codex</Text><Text dimColor> ({x.l})</Text>
      </Text>
      <Text dimColor>{dir}</Text>
    </Box>
  );
}
