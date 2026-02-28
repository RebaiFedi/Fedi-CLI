import type { AgentId, AgentStatus, Message, OutputLine } from '../agents/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { MessageBus } from '../orchestrator/message-bus.js';
import { MockAgent } from './mock-agent.js';

export interface HarnessCallbackLog {
  outputs: Array<{ agent: AgentId; line: OutputLine }>;
  statuses: Array<{ agent: AgentId; status: AgentStatus }>;
  relays: Message[];
  relaysBlocked: Message[];
}

export interface TestHarness {
  orchestrator: Orchestrator;
  opus: MockAgent;
  claude: MockAgent;
  codex: MockAgent;
  bus: MessageBus;
  log: HarnessCallbackLog;
  /** Wait for PQueue microtasks to settle */
  flush(): Promise<void>;
}

/**
 * Create a fully wired test orchestrator with MockAgents.
 * No real processes are spawned — everything is in-memory.
 */
export function createTestOrchestrator(): TestHarness {
  const opus = new MockAgent('opus');
  const claude = new MockAgent('claude');
  const codex = new MockAgent('codex');
  const bus = new MessageBus();

  const orchestrator = new Orchestrator({ opus, claude, codex, bus });

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
    // Give PQueue microtasks time to process
    await new Promise((r) => setTimeout(r, 40));
  }

  return { orchestrator, opus, claude, codex, bus, log, flush };
}
