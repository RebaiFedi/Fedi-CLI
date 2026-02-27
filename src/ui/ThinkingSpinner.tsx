import React, { useState, useEffect, useRef } from 'react';
import { Text } from 'ink';

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

export function randomVerb(): string {
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

function ThinkingSpinnerComponent() {
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(randomVerb);
  const [elapsed, setElapsed] = useState('0s');
  const startTime = useRef(Date.now());
  const tickCount = useRef(0);

  useEffect(() => {
    startTime.current = Date.now();
    tickCount.current = 0;

    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setElapsed(formatElapsed(Date.now() - startTime.current));
      tickCount.current += 1;
      if (tickCount.current % VERB_TICK_INTERVAL === 0) {
        setVerb(randomVerb());
      }
    }, 80);

    return () => clearInterval(id);
  }, []);

  return (
    <Text>
      <Text color="#e8912d">{`  ${SPINNER_FRAMES[frame]} `}</Text>
      <Text color="#e8912d" italic>
        {verb}
      </Text>
      <Text color="#e8912d" dimColor>
        {'...'}
      </Text>
      <Text color="#e8912d" dimColor>
        {` ${elapsed}`}
      </Text>
    </Text>
  );
}

export const ThinkingSpinner = React.memo(ThinkingSpinnerComponent);
