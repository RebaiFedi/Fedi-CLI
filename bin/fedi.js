#!/usr/bin/env node
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register tsx loader for direct TS execution in dev
try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // In production, compiled JS will be used
}

const { main } = await import('../src/index.js');
main();
