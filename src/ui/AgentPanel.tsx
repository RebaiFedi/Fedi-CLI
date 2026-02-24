import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AgentStatus, OutputLine } from '../agents/types.js';
import { renderMarkdown } from '../utils/render-markdown.js';

interface AgentPanelProps {
  title: string;
  status: AgentStatus;
  lines: OutputLine[];
  color: string;
  height: number;
  selected: boolean;
  icon: string;
  scrollDelta: number;
}

function statusLabel(status: AgentStatus): { text: string; color: string } {
  switch (status) {
    case 'idle': return { text: 'IDLE', color: 'gray' };
    case 'running': return { text: 'WORKING', color: 'yellow' };
    case 'waiting': return { text: 'READY', color: 'green' };
    case 'error': return { text: 'ERROR', color: 'red' };
    case 'stopped': return { text: 'STOPPED', color: 'gray' };
  }
}

interface DisplayLine {
  text: string;
  kind: 'text' | 'action' | 'user' | 'heading' | 'separator' | 'empty';
  bold?: boolean;
  color?: string;
}

function processLines(rawLines: OutputLine[], agentColor: string): DisplayLine[] {
  const result: DisplayLine[] = [];
  let actionBuffer: string[] = [];

  const flushActions = () => {
    if (actionBuffer.length === 0) return;
    if (actionBuffer.length > 4) {
      result.push({ text: `  ┌ +${actionBuffer.length - 3} actions`, kind: 'action' });
      for (const a of actionBuffer.slice(-3)) {
        result.push({ text: `  │ ${a.trim()}`, kind: 'action' });
      }
      result.push({ text: '  └', kind: 'action' });
    } else {
      for (const a of actionBuffer) {
        result.push({ text: `  │ ${a.trim()}`, kind: 'action' });
      }
    }
    actionBuffer = [];
  };

  for (const line of rawLines) {
    if (line.type === 'system') {
      actionBuffer.push(line.text);
      continue;
    }

    flushActions();

    if (line.type === 'relay') {
      result.push({ text: line.text, kind: 'user', bold: true, color: 'magenta' });
      continue;
    }

    // Parse markdown for text lines
    const styled = renderMarkdown(line.text);
    for (const s of styled) {
      if (!s.text.trim()) {
        result.push({ text: '', kind: 'empty' });
      } else if (s.color === 'cyan') {
        result.push({ text: s.text, kind: 'heading', bold: true, color: agentColor });
      } else if (s.bold && s.color === 'white') {
        result.push({ text: s.text, kind: 'heading', bold: true, color: 'whiteBright' });
      } else if (s.dim) {
        result.push({ text: s.text, kind: 'separator' });
      } else if (s.bold) {
        result.push({ text: s.text, kind: 'heading', bold: true, color: s.color });
      } else {
        result.push({ text: s.text, kind: 'text' });
      }
    }
  }

  flushActions();
  return result;
}

export function AgentPanel({ title, status, lines, color, height, selected, icon, scrollDelta }: AgentPanelProps) {
  const viewHeight = Math.max(height - 3, 3);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  const displayLines = useMemo(() => processLines(lines, color), [lines, color]);

  useEffect(() => {
    if (autoScroll) {
      setScrollOffset(Math.max(0, displayLines.length - viewHeight));
    }
  }, [displayLines.length, autoScroll, viewHeight]);

  useEffect(() => {
    if (scrollDelta === 0) return;
    const max = Math.max(0, displayLines.length - viewHeight);
    if (scrollDelta === -999) { setAutoScroll(false); setScrollOffset(0); return; }
    if (scrollDelta === 999) { setAutoScroll(true); return; }
    setScrollOffset((prev) => {
      const next = Math.max(0, Math.min(max, prev + scrollDelta));
      if (next >= max) setAutoScroll(true); else setAutoScroll(false);
      return next;
    });
  }, [scrollDelta, displayLines.length, viewHeight]);

  const visible = displayLines.slice(scrollOffset, scrollOffset + viewHeight);
  const st = statusLabel(status);
  const total = displayLines.length;
  const pct = total > viewHeight
    ? Math.floor((scrollOffset / Math.max(1, total - viewHeight)) * 100)
    : 100;

  return (
    <Box
      flexDirection="column"
      borderStyle={selected ? 'bold' : 'round'}
      borderColor={selected ? 'cyanBright' : color}
      flexGrow={1}
      flexBasis="50%"
      height={height}
      overflow="hidden"
    >
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color={color} bold>{icon} {title}</Text>
        <Box gap={1}>
          {total > viewHeight && <Text color="gray">{pct}%</Text>}
          {status === 'running' ? (
            <Text color="yellow"><Spinner type="dots" /> {st.text}</Text>
          ) : (
            <Text color={st.color}>{st.text}</Text>
          )}
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {visible.length === 0 ? (
          <Text color="gray" italic>Awaiting response...</Text>
        ) : (
          visible.map((dl, i) => {
            const key = scrollOffset + i;
            switch (dl.kind) {
              case 'empty':
                return <Text key={key}>{' '}</Text>;

              case 'separator':
                return <Text key={key} color="gray">{dl.text}</Text>;

              case 'heading':
                return <Text key={key} bold color={dl.color ?? color}>{dl.text}</Text>;

              case 'action':
                return <Text key={key} color="yellow">{dl.text}</Text>;

              case 'user':
                return <Text key={key} bold color="magentaBright">{dl.text}</Text>;

              default:
                return (
                  <Text key={key} wrap="wrap" bold={dl.bold} color={dl.color ?? 'white'}>
                    {dl.text}
                  </Text>
                );
            }
          })
        )}
      </Box>
    </Box>
  );
}
