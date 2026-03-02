#!/usr/bin/env node
const { main } = await import('../dist/index.js');
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
