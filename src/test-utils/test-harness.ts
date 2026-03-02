import type { AgentId, AgentStatus, Message, OutputLine } from '../agents/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { MessageBus } from '../orchestrator/message-bus.js';
import { MockAgent } from './mock-agent.js';
import { loadUserConfig } from '../config/user-config.js';

// ── Fast test timers ───────────────────────────────────────────────────────
// Override timer values at import time so all orchestrator modules see fast values.
// loadUserConfig() returns a mutable cached object — mutating it affects all readers.
const _testCfg = loadUserConfig();
_testCfg.relayDraftFlushMs = 15;
_testCfg.safetyNetDebounceMs = 30;

/** Flush delay = max timer + small margin */
const FLUSH_MS = 50;

export interface HarnessCallbackLog {
  outputs: Array<{ agent: AgentId; line: OutputLine }>;
  statuses: Array<{ agent: AgentId; status: AgentStatus }>;
  relays: Message[];
  relaysBlocked: Message[];
}

export interface TestHarness {
  orchestrator: Orchestrator;
  opus: MockAgent;
  sonnet: MockAgent;
  codex: MockAgent;
  bus: MessageBus;
  log: HarnessCallbackLog;
  /** Wait for PQueue microtasks to settle */
  flush(): Promise<void>;
  /** Start the orchestrator so PQueue handlers accept messages */
  start(): Promise<void>;
}

/**
 * Create a fully wired test orchestrator with MockAgents.
 * No real processes are spawned — everything is in-memory.
 */
export function createTestOrchestrator(): TestHarness {
  const opus = new MockAgent('opus');
  const sonnet = new MockAgent('sonnet');
  const codex = new MockAgent('codex');
  const bus = new MessageBus();

  const orchestrator = new Orchestrator({ opus, sonnet, codex, bus });

  const log: HarnessCallbackLog = {
    outputs: [],
    statuses: [],
    relays: [],
    relaysBlocked: [],
  };

  orchestrator.bind({
    onAgentOutput: (agent, line) => {
      log.outputs.push({ agent, line });
    },
    onAgentStatus: (agent, status) => {
      log.statuses.push({ agent, status });
    },
    onRelay: (msg) => {
      log.relays.push(msg);
    },
    onRelayBlocked: (msg) => {
      log.relaysBlocked.push(msg);
    },
  });

  // Set config so startWithTask works (no real project dir needed)
  orchestrator.setConfig({
    projectDir: '/tmp/fedi-test',
    claudePath: 'claude',
    codexPath: 'codex',
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, FLUSH_MS));
  }

  async function start(): Promise<void> {
    // Start the orchestrator with a dummy task so PQueue handlers accept messages.
    // MockAgent.start() is a no-op so no real processes are spawned.
    await orchestrator.startWithTask('__test__');
    await flush();
    // Clear the initial task message and reset Opus to idle.
    // startWithTask sends a message to Opus which sets it to 'running' —
    // reset to 'idle' so tests control the agent status explicitly.
    opus.clearMessages();
    opus.setStatus('idle');
  }

  return { orchestrator, opus, sonnet, codex, bus, log, flush, start };
}
