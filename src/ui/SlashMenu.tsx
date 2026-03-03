import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME, agentHex, agentDisplayName } from '../config/theme.js';
import {
  loadUserConfig,
  applyProfile,
  setAgentEffort,
  setAgentThinking,
  setSandboxMode,
  PROFILES,
  type UserConfig,
  type EffortLevel,
  type ProfileName,
} from '../config/user-config.js';
import type { AgentId } from '../agents/types.js';
import { SessionManager } from '../utils/session-manager.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface SlashMenuProps {
  onClose: () => void;
  enabledAgents: Set<AgentId>;
  projectDir: string;
  onResumeSession: (sessionId: string) => void;
}

type MenuView =
  | { screen: 'main' }
  | { screen: 'profile' }
  | { screen: 'effort-agent' }
  | { screen: 'effort-level'; agent: AgentId }
  | { screen: 'thinking-agent' }
  | { screen: 'thinking-toggle'; agent: AgentId }
  | { screen: 'sessions' };

interface SessionEntry {
  id: string;
  task: string;
  startedAt: number;
  finishedAt?: number;
}

const AGENTS: AgentId[] = ['opus', 'sonnet', 'codex'];
const EFFORT_LEVELS: EffortLevel[] = ['high', 'medium', 'low'];
const PROFILE_NAMES: ProfileName[] = ['high', 'medium', 'low'];

// ── Component ────────────────────────────────────────────────────────────────

export function SlashMenu({ onClose, enabledAgents, projectDir, onResumeSession }: SlashMenuProps) {
  const [view, setView] = useState<MenuView>({ screen: 'main' });
  const [cursor, setCursor] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);

  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup all timers on unmount
  useEffect(() => {
    const capturedFlashTimer = flashTimerRef;
    const capturedNavTimer = navTimerRef;
    return () => {
      if (capturedFlashTimer.current) clearTimeout(capturedFlashTimer.current);
      if (capturedNavTimer.current) clearTimeout(capturedNavTimer.current);
    };
  }, []);

  const showFlash = useCallback((msg: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlash(msg);
    flashTimerRef.current = setTimeout(() => setFlash(null), 1500);
  }, []);

  // Load sessions when navigating to sessions screen
  useEffect(() => {
    if (view.screen !== 'sessions') return;
    let cancelled = false;
    const sm = new SessionManager(projectDir);
    sm.listSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [view.screen, projectDir]);

  // Build items for current view — single config load shared across render
  const cfg = loadUserConfig();
  const items = getItems(view, enabledAgents, sessions ?? [], cfg);

  useInput((_input, key) => {
    if (key.escape) {
      if (view.screen === 'main') {
        onClose();
      } else {
        setView({ screen: 'main' });
        setCursor(0);
      }
      return;
    }

    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : items.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c < items.length - 1 ? c + 1 : 0));
      return;
    }

    if (key.return) {
      const item = items[cursor];
      if (!item) return;

      // Handle sessions navigation: reset sessions cache when entering sessions screen
      if (view.screen === 'main' && item.id === 'sessions') {
        setSessions(null);
        setView({ screen: 'sessions' });
        setCursor(0);
        return;
      }

      // Handle session selection
      if (view.screen === 'sessions' && item.id !== 'none') {
        onResumeSession(item.id);
        return;
      }

      handleSelect(item, view, setView, setCursor, showFlash, onClose, navTimerRef, cfg);
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={0}>
        <Text bold color={THEME.text}>
          {getTitle(view)}
        </Text>
        <Text dimColor> (↑↓ naviguer · Enter selectionner · Esc retour)</Text>
      </Box>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {view.screen === 'sessions' && sessions === null ? (
        <Text dimColor>{'  Chargement...'}</Text>
      ) : (
        items.map((item, i) => {
          const selected = i === cursor;
          const prefix = selected ? '❯ ' : '  ';
          return (
            <Text key={item.id}>
              <Text color={selected ? THEME.opus : THEME.muted}>{prefix}</Text>
              <Text color={selected ? THEME.text : THEME.muted} bold={selected}>
                {item.label}
              </Text>
              {item.badge && (
                <Text dimColor>
                  {'  '}
                  {item.badge}
                </Text>
              )}
            </Text>
          );
        })
      )}
      {view.screen === 'main' && (
        <Box marginTop={0} flexDirection="column">
          <Text dimColor>{'─'.repeat(50)}</Text>
          <Text dimColor>{'Config actuelle:'}</Text>
          {AGENTS.map((a) => {
            const effort = cfg[`${a}Effort`];
            const think = cfg[`${a}Thinking`];
            const enabled = enabledAgents.has(a);
            return (
              <Text key={a}>
                <Text color={agentHex(a)}> {agentDisplayName(a).padEnd(8)}</Text>
                <Text color={enabled ? THEME.codex : THEME.muted}>
                  {enabled ? 'actif' : 'off  '}
                </Text>
                <Text dimColor>{'  effort='}</Text>
                <Text color={THEME.text}>{effort.padEnd(7)}</Text>
                <Text dimColor>{'thinking='}</Text>
                <Text color={think ? THEME.codex : THEME.muted}>{think ? 'on' : 'off'}</Text>
              </Text>
            );
          })}
          <Text>
            <Text dimColor>{' Sandbox   '}</Text>
            <Text color={cfg.sandboxMode ? THEME.codex : THEME.opus}>
              {cfg.sandboxMode ? 'on (securise)' : 'off (full-auto)'}
            </Text>
          </Text>
        </Box>
      )}
      {flash && (
        <Box marginTop={0}>
          <Text color={THEME.codex}>
            {'  ✓ '}
            {flash}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Menu items ───────────────────────────────────────────────────────────────

interface MenuItem {
  id: string;
  label: string;
  badge?: string;
}

function getTitle(view: MenuView): string {
  switch (view.screen) {
    case 'main':
      return '/ Commandes';
    case 'profile':
      return '/profile — Choisir un profil';
    case 'effort-agent':
      return '/effort — Choisir un agent';
    case 'effort-level':
      return `/effort ${view.agent} — Choisir le niveau`;
    case 'thinking-agent':
      return '/thinking — Choisir un agent';
    case 'thinking-toggle':
      return `/thinking ${view.agent} — Activer/Desactiver`;
    case 'sessions':
      return '/sessions — Reprendre une session';
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month} ${hours}:${mins}`;
}

function getItems(
  view: MenuView,
  enabledAgents: Set<AgentId>,
  sessions: SessionEntry[],
  cfg: UserConfig,
): MenuItem[] {

  switch (view.screen) {
    case 'main':
      return [
        { id: 'profile', label: 'Profil', badge: 'Appliquer un preset (high/medium/low)' },
        { id: 'effort', label: 'Effort', badge: "Regler l'effort par agent" },
        { id: 'thinking', label: 'Thinking', badge: 'Activer/desactiver le thinking' },
        {
          id: 'sandbox',
          label: 'Sandbox',
          badge: cfg.sandboxMode
            ? 'actif — cliquer pour desactiver'
            : 'inactif — cliquer pour activer',
        },
        { id: 'sessions', label: 'Sessions', badge: 'Reprendre une session precedente' },
        { id: 'close', label: 'Fermer', badge: 'Esc' },
      ];

    case 'profile':
      return PROFILE_NAMES.map((name) => {
        const p = PROFILES[name];
        const desc = AGENTS.map((a) => {
          const e = p[`${a}Effort`];
          const t = p[`${a}Thinking`] ? '/think' : '';
          return `${a}=${e}${t}`;
        }).join('  ');
        return { id: name, label: name.charAt(0).toUpperCase() + name.slice(1), badge: desc };
      });

    case 'effort-agent':
      return AGENTS.filter((a) => enabledAgents.has(a)).map((a) => ({
        id: a,
        label: agentDisplayName(a),
        badge: `actuel: ${cfg[`${a}Effort`]}`,
      }));

    case 'effort-level':
      return EFFORT_LEVELS.map((level) => ({
        id: level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
        badge: level === cfg[`${view.agent}Effort`] ? '← actuel' : undefined,
      }));

    case 'thinking-agent':
      return AGENTS.filter((a) => enabledAgents.has(a)).map((a) => ({
        id: a,
        label: agentDisplayName(a),
        badge: `actuel: ${cfg[`${a}Thinking`] ? 'on' : 'off'}`,
      }));

    case 'thinking-toggle':
      return [
        { id: 'on', label: 'On', badge: cfg[`${view.agent}Thinking`] ? '← actuel' : undefined },
        { id: 'off', label: 'Off', badge: !cfg[`${view.agent}Thinking`] ? '← actuel' : undefined },
      ];

    case 'sessions':
      if (sessions.length === 0) {
        return [{ id: 'none', label: 'Aucune session trouvee', badge: undefined }];
      }
      return sessions.slice(0, 10).map((s) => {
        const title = s.task.length > 45 ? s.task.slice(0, 45) + '...' : s.task;
        const status = s.finishedAt ? 'done' : 'interrompue';
        return {
          id: s.id,
          label: title,
          badge: `${formatDate(s.startedAt)}  ${status}`,
        };
      });
  }
}

// ── Selection handler ────────────────────────────────────────────────────────

function handleSelect(
  item: MenuItem,
  view: MenuView,
  setView: (v: MenuView) => void,
  setCursor: (n: number) => void,
  showFlash: (msg: string) => void,
  onClose: () => void,
  navTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  cfg: UserConfig,
) {
  switch (view.screen) {
    case 'main':
      if (item.id === 'profile') {
        setView({ screen: 'profile' });
        setCursor(0);
      } else if (item.id === 'effort') {
        setView({ screen: 'effort-agent' });
        setCursor(0);
      } else if (item.id === 'thinking') {
        setView({ screen: 'thinking-agent' });
        setCursor(0);
      } else if (item.id === 'sandbox') {
        setSandboxMode(!cfg.sandboxMode);
        showFlash(`Sandbox ${!cfg.sandboxMode ? 'active' : 'desactive'}`);
      } else if (item.id === 'close') {
        onClose();
      }
      break;

    case 'profile': {
      const name = item.id as ProfileName;
      applyProfile(name);
      showFlash(`Profil "${name}" applique`);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      navTimerRef.current = setTimeout(() => {
        setView({ screen: 'main' });
        setCursor(0);
      }, 800);
      break;
    }

    case 'effort-agent':
      setView({ screen: 'effort-level', agent: item.id as AgentId });
      setCursor(0);
      break;

    case 'effort-level': {
      const agent = (view as { agent: AgentId }).agent;
      const level = item.id as EffortLevel;
      setAgentEffort(agent, level);
      showFlash(`${agentDisplayName(agent)} effort → ${level}`);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      navTimerRef.current = setTimeout(() => {
        setView({ screen: 'main' });
        setCursor(0);
      }, 800);
      break;
    }

    case 'thinking-agent':
      setView({ screen: 'thinking-toggle', agent: item.id as AgentId });
      setCursor(0);
      break;

    case 'thinking-toggle': {
      const agent = (view as { agent: AgentId }).agent;
      const enabled = item.id === 'on';
      setAgentThinking(agent, enabled);
      showFlash(`${agentDisplayName(agent)} thinking → ${enabled ? 'on' : 'off'}`);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      navTimerRef.current = setTimeout(() => {
        setView({ screen: 'main' });
        setCursor(0);
      }, 800);
      break;
    }

    case 'sessions':
      // Handled inline in useInput
      break;
  }
}
