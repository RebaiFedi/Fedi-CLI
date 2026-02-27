import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  AgentStatus,
  ChatMessage,
  DisplayEntry,
  Message,
  OutputLine,
} from '../agents/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { InputBar } from './InputBar.js';
import { flog } from '../utils/log.js';
import { THEME, agentHex, agentDisplayName, agentChalkColor } from '../config/theme.js';
import { MAX_MESSAGES, INDENT, FLUSH_INTERVAL } from '../config/constants.js';
import { outputToEntries, extractTasks } from '../rendering/output-transform.js';
import { entriesToAnsiOutputLines } from '../rendering/ansi-renderer.js';
import { compactOutputLines } from '../rendering/compact.js';
import { ThinkingSpinner, randomVerb } from './ThinkingSpinner.js';
import { TodoPanel, type TodoItem } from './TodoPanel.js';
import { printWelcomeBanner } from './WelcomeBanner.js';
import { printSessionResume, buildResumePrompt } from './SessionResumeView.js';
import { printUserBubble } from './UserBubble.js';
// trace functions replaced by unified flog

// ── Props ───────────────────────────────────────────────────────────────────

interface DashboardProps {
  orchestrator: Orchestrator;
  projectDir: string;
  claudePath: string;
  codexPath: string;
  geminiPath: string;
  resumeSessionId?: string;
}

// ── Buffered entry ──────────────────────────────────────────────────────────

interface BufferedEntry {
  agent: AgentId;
  entries: DisplayEntry[];
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export function Dashboard({
  orchestrator,
  projectDir,
  claudePath,
  codexPath,
  geminiPath,
  resumeSessionId,
}: DashboardProps) {
  const { exit } = useApp();

  const [opusStatus, setOpusStatus] = useState<AgentStatus>('idle');
  const [claudeStatus, setClaudeStatus] = useState<AgentStatus>('idle');
  const [codexStatus, setCodexStatus] = useState<AgentStatus>('idle');
  const [geminiStatus, setGeminiStatus] = useState<AgentStatus>('idle');
  /** Track which agents have actually worked (been 'running' at least once) */
  const agentWasActive = useRef<Set<AgentId>>(new Set());
  const [stopped, setStopped] = useState(false);
  const stoppedRef = useRef(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosHiddenAt, setTodosHiddenAt] = useState<number>(0);
  const [thinking, setThinking] = useState<string | null>(null);

  // Schedule auto-hide when all todos are done; reset when new todos arrive
  const todosAllDone = todos.length > 0 && todos.every((t) => t.done);
  useEffect(() => {
    if (!todosAllDone) return;
    const timer = setTimeout(() => setTodosHiddenAt(Date.now()), 1500);
    return () => clearTimeout(timer);
  }, [todosAllDone]);

  const todosVisible = todos.length > 0 && !(todosAllDone && todosHiddenAt > 0);

  const currentMsgRef = useRef<Map<string, string>>(new Map());
  const lastEntryKind = useRef<Map<string, DisplayEntry['kind']>>(new Map());
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const outputBuffer = useRef<BufferedEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const welcomePrinted = useRef(false);
  const lastPrintedAgent = useRef<AgentId | null>(null);
  const pendingActions = useRef<Map<AgentId, string[]>>(new Map());
  /** Last time we printed an action summary for each agent — throttle to avoid spam */
  const lastActionPrint = useRef<Map<AgentId, number>>(new Map());
  /** Debounce timer for clearing the thinking spinner (avoids flicker between agent transitions) */
  const thinkingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Print welcome banner once at mount
  useEffect(() => {
    if (welcomePrinted.current) return;
    welcomePrinted.current = true;
    printWelcomeBanner(projectDir);
  }, [projectDir]);

  // Fix Ink resize ghost: clear stale output when terminal width changes
  const { stdout } = useStdout();
  const lastWidth = useRef(stdout.columns || 80);
  useEffect(() => {
    const onResize = () => {
      const newWidth = stdout.columns || 80;
      if (newWidth !== lastWidth.current) {
        // Ink only clears on width decrease. On increase, ghost boxes remain.
        // Write clear-to-end-of-screen to prevent ghosts.
        stdout.write('\x1b[J');
        lastWidth.current = newWidth;
      }
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  const flushBuffer = useCallback(() => {
    flushTimer.current = null;
    const items = outputBuffer.current.splice(0);
    if (items.length === 0) return;

    // Collect ALL output into a single string, then emit ONE console.log.
    // Multiple console.log calls while Ink is rendering cause ghost/duplicate
    // lines because each call triggers Ink to erase + redraw its dynamic zone.
    const outputLines: string[] = [];

    const flushPendingActions = (agent: AgentId, agentColor: 'green' | 'yellow' | 'magenta' | 'cyan') => {
      const actions = pendingActions.current.get(agent);
      if (!actions || actions.length === 0) return;
      const summary: DisplayEntry[] = [];
      if (actions.length <= 2) {
        for (const a of actions) summary.push({ text: a, kind: 'action' });
      } else {
        summary.push({
          text: `${actions[actions.length - 1]} (+${actions.length - 1} more)`,
          kind: 'action',
        });
      }
      outputLines.push(...entriesToAnsiOutputLines(summary, agentColor));
      pendingActions.current.set(agent, []);
    };

    for (const { agent, entries } of items) {
      if (entries.length === 0) continue;
      const agentColor = agentChalkColor(agent);

      const contentEntries: DisplayEntry[] = [];
      const newActions: string[] = [];
      for (const e of entries) {
        if (e.kind === 'action') {
          newActions.push(e.text);
        } else {
          contentEntries.push(e);
        }
      }

      if (newActions.length > 0) {
        const existing = pendingActions.current.get(agent) ?? [];
        pendingActions.current.set(agent, [...existing, ...newActions]);
      }

      if (contentEntries.length === 0) {
        // Actions only — print compact summary (throttled: max once per 3s per agent)
        const allActions = pendingActions.current.get(agent) ?? [];
        const now = Date.now();
        const lastPrint = lastActionPrint.current.get(agent) ?? 0;
        if (allActions.length > 0 && now - lastPrint >= 3000) {
          lastActionPrint.current.set(agent, now);
          const last = allActions[allActions.length - 1];
          const short = last.length > 50 ? last.slice(0, 47) + '...' : last;
          const count = allActions.length > 1 ? chalk.dim(` (+${allActions.length - 1})`) : '';
          const label = chalk.hex(agentHex(agent))(agentDisplayName(agent));
          outputLines.push(`${INDENT}${label} ${chalk.dim(short)}${count}`);
        }
        continue;
      }

      const prevKind = lastEntryKind.current.get(agent);
      const currentId = currentMsgRef.current.get(agent);
      if (currentId) {
        const msg = chatMessagesRef.current.find((m) => m.id === currentId);
        if (msg) {
          const agentSwitched = lastPrintedAgent.current && lastPrintedAgent.current !== agent;
          if (agentSwitched) {
            outputLines.push('');
            const agName = chalk.hex(agentHex(agent)).bold(agentDisplayName(agent));
            outputLines.push(`${INDENT}${agName}`);
          }
          lastPrintedAgent.current = agent;
          msg.lines.push(...entries);
          flushPendingActions(agent, agentColor);
          outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor, prevKind));
          const last = contentEntries[contentEntries.length - 1];
          if (last) lastEntryKind.current.set(agent, last.kind);
          continue;
        }
      }

      if (lastPrintedAgent.current && lastPrintedAgent.current !== agent) {
        outputLines.push('');
      }
      lastPrintedAgent.current = agent;

      const id = randomUUID();
      currentMsgRef.current.set(agent, id);
      chatMessagesRef.current.push({
        id,
        agent,
        lines: [...entries],
        timestamp: Date.now(),
        status: 'streaming',
      });
      if (chatMessagesRef.current.length > MAX_MESSAGES) {
        chatMessagesRef.current = chatMessagesRef.current.slice(-MAX_MESSAGES);
      }

      const name = chalk.hex(agentHex(agent)).bold(agentDisplayName(agent));
      outputLines.push(`${INDENT}${name}`);
      flushPendingActions(agent, agentColor);
      outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor));
      const last = contentEntries[contentEntries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    if (outputLines.length > 0) {
      const final = compactOutputLines(outputLines).join('\n');
      flog.debug('UI', 'Output displayed', { preview: final.slice(0, 120) });
      // Single console.log call — Ink erases+redraws its zone only once
      console.log(final);
    }
  }, []);

  const enqueueOutput = useCallback(
    (agent: AgentId, entries: DisplayEntry[]) => {
      outputBuffer.current.push({ agent, entries });
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, FLUSH_INTERVAL);
      }
    },
    [flushBuffer],
  );

  useInput((_input, key) => {
    if (key.escape && !stopped) {
      setStopped(true);
      stoppedRef.current = true;
      setThinking(null);
      // Clear any pending thinking timer
      if (thinkingClearTimer.current) {
        clearTimeout(thinkingClearTimer.current);
        thinkingClearTimer.current = null;
      }
      // Flush any pending output
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushBuffer();
      }
      // Stop all agents — fire-and-forget but agents are killed immediately
      orchestrator.stop().catch((err) => flog.error('UI', `Stop error: ${err}`));
      console.log('');
      console.log(
        chalk.dim('  Agents stoppes. Tapez un message pour relancer, ou Ctrl+C pour quitter.'),
      );
    }
  });

  const processTaskTags = useCallback((agent: AgentId, text: string) => {
    const { adds, dones } = extractTasks(text);
    if (adds.length > 0 || dones.length > 0) {
      setTodos((prev) => {
        let updated = [...prev];
        let hasNewItems = false;
        for (const add of adds) {
          if (!updated.some((t) => t.text.toLowerCase() === add.toLowerCase())) {
            updated.push({ id: randomUUID(), text: add, done: false, agent });
            hasNewItems = true;
          }
        }
        if (hasNewItems) setTodosHiddenAt(0);
        for (const done of dones) {
          const lower = done.toLowerCase();
          let idx = updated.findIndex((t) => !t.done && t.text.toLowerCase().includes(lower));
          if (idx === -1) {
            const doneWords = lower.split(/\s+/).filter((w) => w.length > 3);
            idx = updated.findIndex((t) => {
              if (t.done) return false;
              const todoLower = t.text.toLowerCase();
              const matchCount = doneWords.filter((w) => todoLower.includes(w)).length;
              return matchCount >= 2;
            });
          }
          if (idx !== -1) updated[idx] = { ...updated[idx], done: true };
        }
        return updated;
      });
    }
  }, []);

  useEffect(() => {
    orchestrator.setConfig({ projectDir, claudePath, codexPath, geminiPath });
    orchestrator.bind({
      onAgentOutput: (agent: AgentId, line: OutputLine) => {
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const entries = outputToEntries(line);
        if (entries.length === 0) return;
        enqueueOutput(agent, entries);
      },
      onAgentStatus: (agent: AgentId, status: AgentStatus) => {
        // Update pill status even when stopped (so pills go grey)
        if (agent === 'opus') setOpusStatus(status);
        if (agent === 'claude') setClaudeStatus(status);
        if (agent === 'codex') setCodexStatus(status);
        if (agent === 'gemini') setGeminiStatus(status);

        // Don't re-trigger spinner when we are stopped
        if (stoppedRef.current) return;

        if (status === 'running') {
          agentWasActive.current.add(agent);
          if (thinkingClearTimer.current) {
            clearTimeout(thinkingClearTimer.current);
            thinkingClearTimer.current = null;
          }
          setThinking((prev) => prev ?? randomVerb());
        } else {
          const statuses = [
            agent === 'opus' ? status : orchestrator.opus.status,
            agent === 'claude' ? status : orchestrator.claude.status,
            agent === 'codex' ? status : orchestrator.codex.status,
            agent === 'gemini' ? status : orchestrator.gemini.status,
          ];
          const anyRunningNow = statuses.some((s) => s === 'running');
          if (!anyRunningNow && !thinkingClearTimer.current) {
            thinkingClearTimer.current = setTimeout(() => {
              thinkingClearTimer.current = null;
              setThinking(null);
            }, 300);
          }
        }
        if (
          status === 'waiting' ||
          status === 'idle' ||
          status === 'error' ||
          status === 'stopped'
        ) {
          if (flushTimer.current) {
            clearTimeout(flushTimer.current);
            flushBuffer();
          }
          const remaining = pendingActions.current.get(agent);
          if (remaining && remaining.length > 0) {
            const ac = agentChalkColor(agent);
            const summary: DisplayEntry[] =
              remaining.length <= 2
                ? remaining.map((a) => ({ text: a, kind: 'action' as const }))
                : [
                    {
                      text: `${remaining[remaining.length - 1]} (+${remaining.length - 1} more)`,
                      kind: 'action' as const,
                    },
                  ];
            const lines = entriesToAnsiOutputLines(summary, ac);
            if (lines.length > 0) console.log(compactOutputLines(lines).join('\n'));
            pendingActions.current.set(agent, []);
          }
          const currentId = currentMsgRef.current.get(agent);
          if (currentId) {
            const msg = chatMessagesRef.current.find((m) => m.id === currentId);
            if (msg) msg.status = 'done';
            currentMsgRef.current.delete(agent);
            lastEntryKind.current.delete(agent);
          }
        }
      },
      onRelay: (msg: Message) => {
        flog.info('UI', `Relay: ${msg.from}->${msg.to}`);
        // Show cross-talk and delegation messages to the user
        const fromName = agentDisplayName(msg.from as AgentId);
        const toName = agentDisplayName(msg.to as AgentId);
        const fromColor = agentHex(msg.from as AgentId);
        const toColor = agentHex(msg.to as AgentId);
        const preview = msg.content.length > 120
          ? msg.content.slice(0, 117) + '...'
          : msg.content;
        const relayLine =
          `${INDENT}${chalk.hex(fromColor).bold(fromName)} ${chalk.dim('\u2192')} ${chalk.hex(toColor).bold(toName)}${chalk.dim(':')} ${chalk.hex('#CBD5E1')(preview)}`;
        console.log('');
        console.log(relayLine);
      },
      onRelayBlocked: (msg: Message) => {
        flog.info('UI', `Relay blocked: ${msg.from}->${msg.to}`);
      },
    });

    // Resume session if --resume flag was passed
    if (resumeSessionId) {
      (async () => {
        const sm = orchestrator.getSessionManager();
        if (!sm) return;
        const sessions = await sm.listSessions();
        const match = sessions.find((s) => s.id.startsWith(resumeSessionId));
        if (match) {
          const session = await sm.loadSession(match.id);
          if (session) {
            printSessionResume(session, match.id);
            const resumePrompt = buildResumePrompt(session);
            setThinking(randomVerb());
            orchestrator
              .startWithTask(resumePrompt)
              .catch((err) => flog.error('UI',`[DASHBOARD] Resume error: ${err}`));
          } else {
            console.log(chalk.red(`  Session ${resumeSessionId} non trouvee ou corrompue.`));
          }
        } else {
          console.log(chalk.red(`  Session ${resumeSessionId} non trouvee.`));
          console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
        }
      })().catch((err) => flog.error('UI',`[DASHBOARD] Session resume error: ${err}`));
    }

    const handleExit = () => {
      orchestrator.stop().finally(() => exit());
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
    return () => {
      process.off('SIGINT', handleExit);
      process.off('SIGTERM', handleExit);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (thinkingClearTimer.current) clearTimeout(thinkingClearTimer.current);
    };
  }, [
    orchestrator,
    exit,
    projectDir,
    claudePath,
    codexPath,
    geminiPath,
    resumeSessionId,
    processTaskTags,
    enqueueOutput,
    flushBuffer,
  ]);

  const handleInput = useCallback(
    (text: string) => {
      flog.info('UI', `User input: ${text.slice(0, 100)}`);
      printUserBubble(text);
      chatMessagesRef.current.push({
        id: randomUUID(),
        agent: 'user',
        lines: [{ text, kind: 'text' }],
        timestamp: Date.now(),
        status: 'done',
      });

      setThinking(randomVerb());

      // @sessions command
      if (text.trim() === '@sessions') {
        const sm = orchestrator.getSessionManager();
        if (!sm) {
          console.log(chalk.dim('    Session manager not initialized yet.'));
          return;
        }
        (async () => {
          const sessions = await sm.listSessions();
          if (sessions.length === 0) {
            console.log(chalk.dim('    Aucune session enregistree.'));
          } else {
            console.log('');
            console.log(chalk.white.bold('    Sessions enregistrees'));
            console.log(chalk.dim('    ' + '\u2500'.repeat(50)));
            for (const s of sessions.slice(0, 10)) {
              const date = new Date(s.startedAt);
              const dateStr = date.toLocaleDateString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
              });
              const timeStr = date.toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              });
              const status = s.finishedAt
                ? chalk.hex(THEME.codex)('done')
                : chalk.hex(THEME.info)('run');
              const task = s.task.length > 40 ? s.task.slice(0, 40) + '...' : s.task;
              const shortId = s.id.slice(0, 8);
              console.log(
                `    ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.hex(THEME.claude)(shortId)}  ${status}  ${chalk.hex(THEME.text)(task)}`,
              );
            }
            console.log('');
            console.log(chalk.dim('    Voir en detail: fedi --view <id>'));
            console.log('');
          }
        })().catch((err) => flog.error('UI',`[DASHBOARD] Sessions list error: ${err}`));
        return;
      }

      // @tous / @all — send directly to all 3 agents
      const allMatch = text.match(/^@(tous|all)\s+(.+)$/i);
      if (allMatch) {
        const allMessage = allMatch[2];
        if (!orchestrator.isStarted || stopped) {
          setStopped(false);
          stoppedRef.current = false;
          setTodos([]);
          orchestrator
            .restart(`Le user parle a tous les agents directement. Attends.`)
            .then(() => orchestrator.sendToAllDirect(allMessage))
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        } else {
          orchestrator.sendToAllDirect(allMessage);
        }
        return;
      }

      // Parse @agent commands
      let targetAgent: AgentId | null = null;
      let agentMessage = text;
      if (text.startsWith('@opus ')) {
        targetAgent = 'opus';
        agentMessage = text.slice(6);
      } else if (text.startsWith('@codex ')) {
        targetAgent = 'codex';
        agentMessage = text.slice(7);
      } else if (text.startsWith('@claude ') || text.startsWith('@sonnet ')) {
        targetAgent = 'claude';
        agentMessage = text.slice(text.indexOf(' ') + 1);
      } else if (text.startsWith('@gemini ')) {
        targetAgent = 'gemini';
        agentMessage = text.slice(8);
      }

      if (!orchestrator.isStarted || stopped) {
        setStopped(false);
        stoppedRef.current = false;
        setTodos([]);
        agentWasActive.current.clear();
        if (targetAgent && targetAgent !== 'opus') {
          const agentNames: Record<string, string> = { claude: 'Sonnet', codex: 'Codex', gemini: 'Gemini' };
          orchestrator
            .restart(
              `Le user veut parler directement a ${agentNames[targetAgent] ?? targetAgent}. Attends.`,
            )
            .then(() => {
              orchestrator.sendToAgent(targetAgent!, agentMessage);
            })
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        } else {
          orchestrator
            .restart(targetAgent === 'opus' ? agentMessage : text)
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        }
        return;
      }

      if (targetAgent) {
        orchestrator.sendToAgent(targetAgent, agentMessage);
        return;
      }
      orchestrator.sendUserMessage(text);
    },
    [orchestrator, stopped],
  );

  const anyRunning =
    opusStatus === 'running' ||
    claudeStatus === 'running' ||
    codexStatus === 'running' ||
    geminiStatus === 'running';

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {thinking ? <ThinkingSpinner /> : <Text> </Text>}
      {todosVisible && <TodoPanel items={todos} />}
      <Box width="100%" flexGrow={1}>
        <Box
          width="100%"
          flexGrow={1}
          paddingY={0}
          borderStyle="round"
          borderColor={anyRunning ? THEME.opus : THEME.panelBorder}
        >
          <Text color={THEME.text}>{' \u276F '}</Text>
          <Box flexGrow={1}>
            <InputBar onSubmit={handleInput} placeholder="Improve documentation in @filename" />
          </Box>
        </Box>
      </Box>
      <Box paddingX={2} paddingTop={0}>
        <Text>
          <Text dimColor>{'esc '}</Text>
          <Text color={THEME.muted}>{'stop'}</Text>
          <Text dimColor>{'  \u00B7  '}</Text>
          <Text dimColor>{'^C '}</Text>
          <Text color={THEME.muted}>{'quit'}</Text>
        </Text>
      </Box>
    </Box>
  );
}
