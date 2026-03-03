import React, { useState, useEffect, useRef } from 'react';
import { Text } from 'ink';
import { THEME } from '../config/theme.js';
import { INDENT } from '../config/constants.js';

const THINKING_VERBS = [
  'Thinking',
  'Analyzing',
  'Reasoning',
  'Processing',
  'Evaluating',
  'Considering',
  'Reflecting',
  'Examining',
  'Assessing',
  'Investigating',
  'Reviewing',
  'Interpreting',
];

function randomVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}

const SPINNER_FRAMES = [
  '\u280B',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283C',
  '\u2834',
  '\u2826',
  '\u2827',
  '\u2807',
  '\u280F',
];

// ~37 ticks of 80ms ≈ 3000ms per verb change
const VERB_TICK_INTERVAL = 37;

function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m${secs}s`;
  return `${secs}s`;
}

interface SpinnerState {
  frame: number;
  verb: string;
  elapsed: string;
}

interface ThinkingSpinnerProps {
  compacting?: boolean;
}

function ThinkingSpinnerComponent({ compacting }: ThinkingSpinnerProps) {
  const [state, setState] = useState<SpinnerState>({
    frame: 0,
    verb: randomVerb(),
    elapsed: '0s',
  });
  const startTime = useRef(0);
  const tickCount = useRef(0);

  useEffect(() => {
    startTime.current = Date.now();
    tickCount.current = 0;

    const id = setInterval(() => {
      tickCount.current += 1;
      setState((prev) => ({
        frame: (prev.frame + 1) % SPINNER_FRAMES.length,
        elapsed: formatElapsed(Date.now() - startTime.current),
        verb: tickCount.current % VERB_TICK_INTERVAL === 0 ? randomVerb() : prev.verb,
      }));
    }, 80);

    return () => clearInterval(id);
  }, []);

  const label = compacting ? 'Compacting context' : state.verb;
  const color = compacting ? 'yellow' : THEME.opus;

  return (
    <Text>
      <Text color={color}>{`${INDENT}${SPINNER_FRAMES[state.frame]} `}</Text>
      <Text color={color} italic>
        {label}
      </Text>
      <Text color={color} dimColor>
        {'...'}
      </Text>
      <Text color={color} dimColor>
        {` ${state.elapsed}`}
      </Text>
    </Text>
  );
}

export const ThinkingSpinner = React.memo(ThinkingSpinnerComponent);
