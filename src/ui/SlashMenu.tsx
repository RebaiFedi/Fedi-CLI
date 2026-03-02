import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME, agentHex, agentDisplayName } from '../config/theme.js';
import { loadUserConfig, applyProfile, setAgentEffort, setAgentThinking, PROFILES, type EffortLevel, type ProfileName } from '../config/user-config.js';
import type { AgentId } from '../agents/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface SlashMenuProps {
  onClose: () => void;
  enabledAgents: Set<AgentId>;
}

type MenuView =
  | { screen: 'main' }
  | { screen: 'profile' }
  | { screen: 'effort-agent' }
  | { screen: 'effort-level'; agent: AgentId }
  | { screen: 'thinking-agent' }
  | { screen: 'thinking-toggle'; agent: AgentId };

const AGENTS: AgentId[] = ['opus', 'sonnet', 'codex'];
const EFFORT_LEVELS: EffortLevel[] = ['high', 'medium', 'low'];
const PROFILE_NAMES: ProfileName[] = ['high', 'medium', 'low'];

// ── Component ────────────────────────────────────────────────────────────────

export function SlashMenu({ onClose, enabledAgents }: SlashMenuProps) {
  const [view, setView] = useState<MenuView>({ screen: 'main' });
  const [cursor, setCursor] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1500);
  }, []);

  // Build items for current view
  const items = getItems(view, enabledAgents);

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
      handleSelect(item, view, setView, setCursor, showFlash, onClose);
      return;
    }
  });

  const cfg = loadUserConfig();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={0}>
        <Text bold color={THEME.text}>
          {getTitle(view)}
        </Text>
        <Text dimColor>  (↑↓ naviguer · Enter selectionner · Esc retour)</Text>
      </Box>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {items.map((item, i) => {
        const selected = i === cursor;
        const prefix = selected ? '❯ ' : '  ';
        return (
          <Text key={item.id}>
            <Text color={selected ? THEME.opus : THEME.muted}>{prefix}</Text>
            <Text color={selected ? THEME.text : THEME.muted} bold={selected}>
              {item.label}
            </Text>
            {item.badge && (
              <Text dimColor>{'  '}{item.badge}</Text>
            )}
          </Text>
        );
      })}
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
                <Text color={agentHex(a)}>{' '}{agentDisplayName(a).padEnd(8)}</Text>
                <Text color={enabled ? THEME.codex : THEME.muted}>{enabled ? 'actif' : 'off  '}</Text>
                <Text dimColor>{'  effort='}</Text>
                <Text color={THEME.text}>{effort.padEnd(7)}</Text>
                <Text dimColor>{'thinking='}</Text>
                <Text color={think ? THEME.codex : THEME.muted}>{think ? 'on' : 'off'}</Text>
              </Text>
            );
          })}
        </Box>
      )}
      {flash && (
        <Box marginTop={0}>
          <Text color={THEME.codex}>{'  ✓ '}{flash}</Text>
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
  action?: () => void;
}

function getTitle(view: MenuView): string {
  switch (view.screen) {
    case 'main': return '/ Commandes';
    case 'profile': return '/profile — Choisir un profil';
    case 'effort-agent': return '/effort — Choisir un agent';
    case 'effort-level': return `/effort ${view.agent} — Choisir le niveau`;
    case 'thinking-agent': return '/thinking — Choisir un agent';
    case 'thinking-toggle': return `/thinking ${view.agent} — Activer/Desactiver`;
  }
}

function getItems(view: MenuView, enabledAgents: Set<AgentId>): MenuItem[] {
  const cfg = loadUserConfig();

  switch (view.screen) {
    case 'main':
      return [
        { id: 'profile', label: 'Profil', badge: 'Appliquer un preset (high/medium/low)' },
        { id: 'effort', label: 'Effort', badge: 'Regler l\'effort par agent' },
        { id: 'thinking', label: 'Thinking', badge: 'Activer/desactiver le thinking' },
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
) {
  switch (view.screen) {
    case 'main':
      if (item.id === 'profile') { setView({ screen: 'profile' }); setCursor(0); }
      else if (item.id === 'effort') { setView({ screen: 'effort-agent' }); setCursor(0); }
      else if (item.id === 'thinking') { setView({ screen: 'thinking-agent' }); setCursor(0); }
      else if (item.id === 'close') { onClose(); }
      break;

    case 'profile': {
      const name = item.id as ProfileName;
      applyProfile(name);
      showFlash(`Profil "${name}" applique`);
      // Go back to main after selection
      setTimeout(() => { setView({ screen: 'main' }); setCursor(0); }, 800);
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
      setTimeout(() => { setView({ screen: 'main' }); setCursor(0); }, 800);
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
      setTimeout(() => { setView({ screen: 'main' }); setCursor(0); }, 800);
      break;
    }
  }
}
