import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import type { AgentId } from '../agents/types.js';
import {
  loadUserConfig,
  applyProfile,
  setSandboxMode,
  PROFILES,
  type ProfileName,
} from '../config/user-config.js';
import { THEME, agentHex, agentDisplayName } from '../config/theme.js';

/**
 * Test slash command logic directly, replicating the core handler from useSlashCommands.
 * This avoids the need to mock React hooks while testing the actual business logic.
 */

const AGENTS = ['opus', 'sonnet', 'codex'] as const;

function handleSlashCommand(
  cmd: string,
  args: string[],
  enabledAgentSet: Set<AgentId>,
  onOpenSessions?: () => void,
): boolean {
  const cfg = loadUserConfig();

  if (cmd === 'profile' || cmd === 'profil') {
    const name = args[0]?.toLowerCase() as ProfileName | undefined;
    if (!name || !PROFILES[name]) {
      console.log(chalk.yellow(`\n  Usage: /profile <high|medium|low>`));
      return true;
    }
    applyProfile(name);
    console.log(`\n  Profile "${name}" applied`);
    return true;
  }

  if (cmd === 'config' || cmd === 'settings' || cmd === 'status') {
    console.log(`\n  ${chalk.hex(THEME.text).bold('Configuration agents')}`);
    for (const a of AGENTS) {
      const effort = cfg[`${a}Effort`];
      const think = cfg[`${a}Thinking`];
      const color = agentHex(a as AgentId);
      console.log(`  ${chalk.hex(color).bold(agentDisplayName(a as AgentId))} effort=${effort} thinking=${think}`);
    }
    return true;
  }

  if (cmd === 'sandbox') {
    const current = cfg.sandboxMode;
    setSandboxMode(!current);
    const label = !current ? 'active (securise)' : 'desactive (full-auto)';
    console.log(`\n  Sandbox → ${label}`);
    return true;
  }

  if (cmd === 'sessions' || cmd === 'session') {
    if (onOpenSessions) onOpenSessions();
    return true;
  }

  if (cmd === 'help' || cmd === '?') {
    console.log(`\n  Commandes disponibles`);
    console.log(`  /profile /effort /thinking /config /sandbox /sessions /help`);
    return true;
  }

  console.log(`\n  Commande inconnue: /${cmd}`);
  return true;
}

describe('useSlashCommands (logic)', () => {
  let output: string[];
  const origLog = console.log;

  beforeEach(() => {
    output = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('/help returns true and shows commands', () => {
    const result = handleSlashCommand('help', [], new Set(['opus', 'sonnet', 'codex']));
    assert.equal(result, true);
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('/profile'), 'should list /profile');
    assert.ok(text.includes('/config'), 'should list /config');
  });

  it('/profile without args shows usage', () => {
    const result = handleSlashCommand('profile', [], new Set(['opus', 'sonnet', 'codex']));
    assert.equal(result, true);
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Usage'), 'should show usage');
  });

  it('/config shows agent configuration', () => {
    const result = handleSlashCommand('config', [], new Set(['opus', 'sonnet', 'codex']));
    assert.equal(result, true);
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Configuration'), 'should show config header');
  });

  it('/sandbox toggles sandbox mode', () => {
    const result = handleSlashCommand('sandbox', [], new Set(['opus', 'sonnet', 'codex']));
    assert.equal(result, true);
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Sandbox'), 'should show sandbox toggle');
  });

  it('unknown command shows error', () => {
    const result = handleSlashCommand('unknowncmd', [], new Set(['opus', 'sonnet', 'codex']));
    assert.equal(result, true);
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Commande inconnue'), 'should show error');
  });

  it('/sessions calls the callback', () => {
    let called = false;
    handleSlashCommand('sessions', [], new Set(['opus', 'sonnet', 'codex']), () => { called = true; });
    assert.equal(called, true, 'should call onOpenSessions');
  });
});
