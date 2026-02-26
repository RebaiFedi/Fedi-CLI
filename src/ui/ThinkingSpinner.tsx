import React, { useState, useEffect } from 'react';
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

export function ThinkingSpinner() {
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(randomVerb);

  useEffect(() => {
    const spinId = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    const verbId = setInterval(() => setVerb(randomVerb()), 3000);
    return () => {
      clearInterval(spinId);
      clearInterval(verbId);
    };
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
    </Text>
  );
}
