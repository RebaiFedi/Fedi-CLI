import { useCallback } from 'react';
import chalk from 'chalk';
import type { AgentId } from '../agents/types.js';
import { THEME, agentHex, agentDisplayName } from '../config/theme.js';
import {
  loadUserConfig,
  applyProfile,
  setAgentEffort,
  setAgentThinking,
  setSandboxMode,
  PROFILES,
  type EffortLevel,
  type ProfileName,
} from '../config/user-config.js';

const AGENTS = ['opus', 'sonnet', 'codex'] as const;
const EFFORT_LEVELS: EffortLevel[] = ['high', 'medium', 'low'];

interface SlashCommandsOptions {
  enabledAgentSet: Set<AgentId>;
  onOpenSessions?: () => void;
}

/**
 * Hook that handles /profile, /effort, /thinking, /config, /sandbox, /sessions, /help slash commands.
 * Returns a handler: (cmd, args) => boolean (true = consumed).
 */
export function useSlashCommands({ enabledAgentSet, onOpenSessions }: SlashCommandsOptions) {
  return useCallback(
    (cmd: string, args: string[]): boolean => {
      const cfg = loadUserConfig();

      // /profile [high|medium|low]
      if (cmd === 'profile' || cmd === 'profil') {
        const name = args[0]?.toLowerCase() as ProfileName | undefined;
        if (!name || !PROFILES[name]) {
          console.log(chalk.yellow(`\n  Usage: /profile <high|medium|low>`));
          console.log(chalk.dim(`  Profils disponibles:`));
          console.log(chalk.dim(`    high   — opus=high/thinking  sonnet=high  codex=high`));
          console.log(chalk.dim(`    medium — opus=high           sonnet=medium  codex=medium`));
          console.log(chalk.dim(`    low    — opus=medium         sonnet=low   codex=low\n`));
          return true;
        }
        applyProfile(name);
        const p = PROFILES[name];
        console.log(`\n  ${chalk.hex(THEME.text).bold(`Profil "${name}" applique`)}`);
        for (const a of AGENTS) {
          const effort = p[`${a}Effort`];
          const think = p[`${a}Thinking`];
          const color = agentHex(a as AgentId);
          console.log(
            `  ${chalk.hex(color)(agentDisplayName(a as AgentId))}  effort=${chalk.white(effort)}  thinking=${think ? chalk.hex(THEME.codex)('on') : chalk.dim('off')}`,
          );
        }
        console.log('');
        return true;
      }

      // /effort <agent> <level> or /effort (show all)
      if (cmd === 'effort') {
        if (args.length === 0) {
          console.log(`\n  ${chalk.hex(THEME.text).bold('Effort actuel')}`);
          for (const a of AGENTS) {
            const effort = cfg[`${a}Effort`];
            const color = agentHex(a as AgentId);
            console.log(
              `  ${chalk.hex(color)(agentDisplayName(a as AgentId))}  ${chalk.white(effort)}`,
            );
          }
          console.log(chalk.dim(`\n  Usage: /effort <opus|sonnet|codex> <high|medium|low>\n`));
          return true;
        }
        const agent = args[0]?.toLowerCase();
        const level = args[1]?.toLowerCase() as EffortLevel | undefined;
        if (!agent || !AGENTS.includes(agent as (typeof AGENTS)[number])) {
          console.log(chalk.yellow(`\n  Agent inconnu: ${agent}. Agents: opus, sonnet, codex\n`));
          return true;
        }
        if (!level || !EFFORT_LEVELS.includes(level)) {
          console.log(chalk.yellow(`\n  Niveau invalide. Niveaux: high, medium, low\n`));
          return true;
        }
        setAgentEffort(agent as (typeof AGENTS)[number], level);
        const color = agentHex(agent as AgentId);
        console.log(
          `\n  ${chalk.hex(color)(agentDisplayName(agent as AgentId))} effort → ${chalk.white.bold(level)}\n`,
        );
        return true;
      }

      // /thinking <agent> <on|off> or /thinking (show all)
      if (cmd === 'thinking' || cmd === 'think') {
        if (args.length === 0) {
          console.log(`\n  ${chalk.hex(THEME.text).bold('Thinking actuel')}`);
          for (const a of AGENTS) {
            const think = cfg[`${a}Thinking`];
            const color = agentHex(a as AgentId);
            console.log(
              `  ${chalk.hex(color)(agentDisplayName(a as AgentId))}  ${think ? chalk.hex(THEME.codex)('on') : chalk.dim('off')}`,
            );
          }
          console.log(chalk.dim(`\n  Usage: /thinking <opus|sonnet|codex> <on|off>\n`));
          return true;
        }
        const agent = args[0]?.toLowerCase();
        const toggle = args[1]?.toLowerCase();
        if (!agent || !AGENTS.includes(agent as (typeof AGENTS)[number])) {
          console.log(chalk.yellow(`\n  Agent inconnu: ${agent}. Agents: opus, sonnet, codex\n`));
          return true;
        }
        if (!toggle || !['on', 'off'].includes(toggle)) {
          console.log(chalk.yellow(`\n  Usage: /thinking ${agent} <on|off>\n`));
          return true;
        }
        const enabled = toggle === 'on';
        setAgentThinking(agent as (typeof AGENTS)[number], enabled);
        const color = agentHex(agent as AgentId);
        console.log(
          `\n  ${chalk.hex(color)(agentDisplayName(agent as AgentId))} thinking → ${enabled ? chalk.hex(THEME.codex).bold('on') : chalk.dim('off')}\n`,
        );
        return true;
      }

      // /config — show current full config
      if (cmd === 'config' || cmd === 'settings' || cmd === 'status') {
        console.log(`\n  ${chalk.hex(THEME.text).bold('Configuration agents')}`);
        console.log(chalk.dim('  ' + '─'.repeat(40)));
        for (const a of AGENTS) {
          const effort = cfg[`${a}Effort`];
          const think = cfg[`${a}Thinking`];
          const color = agentHex(a as AgentId);
          const enabledLabel = enabledAgentSet.has(a)
            ? chalk.hex(THEME.codex)('actif')
            : chalk.dim('inactif');
          console.log(
            `  ${chalk.hex(color).bold(agentDisplayName(a as AgentId))}  ${enabledLabel}  effort=${chalk.white(effort)}  thinking=${think ? chalk.hex(THEME.codex)('on') : chalk.dim('off')}`,
          );
        }
        console.log('');
        return true;
      }

      // /sandbox — toggle sandbox mode
      if (cmd === 'sandbox') {
        const current = cfg.sandboxMode;
        setSandboxMode(!current);
        const label = !current ? 'active (securise)' : 'desactive (full-auto)';
        const color = !current ? THEME.codex : THEME.opus;
        console.log(`\n  ${chalk.hex(THEME.text).bold('Sandbox')} → ${chalk.hex(color)(label)}\n`);
        return true;
      }

      // /sessions — open interactive session browser
      if (cmd === 'sessions' || cmd === 'session') {
        if (onOpenSessions) {
          onOpenSessions();
        } else {
          console.log(chalk.dim(`\n  Tapez / pour ouvrir le menu interactif, puis Sessions.\n`));
        }
        return true;
      }

      // /help — show available slash commands
      if (cmd === 'help' || cmd === '?') {
        console.log(`\n  ${chalk.hex(THEME.text).bold('Commandes disponibles')}`);
        console.log(chalk.dim('  ' + '─'.repeat(40)));
        console.log(
          `  ${chalk.white('/profile')} ${chalk.dim('<high|medium|low>')}      Appliquer un profil`,
        );
        console.log(
          `  ${chalk.white('/effort')} ${chalk.dim('<agent> <level>')}        Changer l'effort d'un agent`,
        );
        console.log(
          `  ${chalk.white('/thinking')} ${chalk.dim('<agent> <on|off>')}     Activer/desactiver thinking`,
        );
        console.log(`  ${chalk.white('/config')}                          Voir la config actuelle`);
        console.log(`  ${chalk.white('/sandbox')}                         Activer/desactiver le sandbox`);
        console.log(`  ${chalk.white('/sessions')}                        Reprendre une session`);
        console.log(`  ${chalk.white('/help')}                            Cette aide`);
        console.log('');
        console.log(chalk.dim('  Exemples:'));
        console.log(chalk.dim('    /profile high'));
        console.log(chalk.dim('    /effort opus medium'));
        console.log(chalk.dim('    /thinking sonnet on'));
        console.log('');
        return true;
      }

      // Unknown slash command — show error with available commands
      console.log(chalk.yellow(`\n  Commande inconnue: /${cmd}`));
      console.log(chalk.dim('  Commandes: /profile, /effort, /thinking, /config, /sandbox, /sessions, /help'));
      console.log(chalk.dim('  Tapez / pour ouvrir le menu interactif.\n'));
      return true;
    },
    [enabledAgentSet, onOpenSessions],
  );
}
