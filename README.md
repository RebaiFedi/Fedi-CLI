# Fedi CLI

Multi-agent AI orchestrator — coordinates Claude Opus (director), Claude Sonnet (frontend), and GPT Codex (backend) in a collaborative TUI.

## Architecture

```
User
  │
  ▼
┌──────────────────────────────────────┐
│           Fedi CLI (TUI)             │
│  Ink/React dashboard + input bar     │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│          Orchestrator                │
│  PQueue per agent, relay router,     │
│  delegate tracker, cross-talk mgr    │
├──────┬──────────┬────────────────────┤
│ Opus │  Sonnet  │      Codex         │
│ 4.6  │  4.6     │   GPT-5.3          │
│ Dir. │  Front   │   Backend          │
└──────┴──────────┴────────────────────┘
```

**Opus** is the director — analyzes tasks, delegates to workers, synthesizes reports.
**Sonnet** specializes in frontend (React, UI, CSS) but is polyvalent.
**Codex** specializes in backend (APIs, DB, config) but is polyvalent.

Agents communicate via relay tags (`[TO:SONNET]`, `[FROM:CODEX]`, etc.) parsed by the orchestrator's `RelayRouter`. Workers can cross-talk directly for coordination.

## Prerequisites

- **Node.js** >= 20.0.0 (see `.nvmrc`)
- **Claude Code CLI**: `npm i -g @anthropic-ai/claude-code`
- **Codex CLI**: `npm i -g @openai/codex`
- Valid API keys for Anthropic and OpenAI

## Install

```bash
# From npm (when published)
npm i -g fedi-cli

# From source
git clone <repo-url> && cd fedi-cli
npm install
npm run build
npm link   # makes `fedi` available globally
```

## Quick Start

```bash
# Launch interactive session
fedi

# With specific agents only
fedi --agents opus,sonnet

# With performance profile
fedi --profile medium

# Resume a previous session
fedi --sessions          # list sessions
fedi --resume <id>       # resume by ID
```

## CLI Reference

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `--log-level <level>` | Log level: `debug`, `info`, `warn`, `error` |
| `--sessions` | List saved sessions |
| `--view <id>` | View a session transcript (supports short IDs) |
| `--resume <id>` | Resume an interrupted session |
| `--agents <list>` | Comma-separated agents to enable (opus always forced) |
| `--profile <high\|medium\|low>` | Global effort+thinking preset |
| `--opus-effort <level>` | Per-agent effort: `high`, `medium`, `low` |
| `--sonnet-effort <level>` | Per-agent effort |
| `--codex-effort <level>` | Per-agent effort |
| `--thinking` | Enable thinking for Opus |
| `--no-thinking` | Disable thinking for all agents |
| `--sandbox` | Sandbox mode: agents require approval |
| `--unsafe` | Full-auto mode: no approval needed |

### Interactive Commands

| Command | Description |
|---------|-------------|
| `@opus <msg>` | Direct message to Opus |
| `@sonnet <msg>` | Direct message to Sonnet |
| `@codex <msg>` | Direct message to Codex |
| `@tous <msg>` | Broadcast to all agents |
| `/help` | Show slash commands |
| `/config` | Show current agent config |
| `/profile` | Change performance profile |
| `/effort` | Per-agent effort |
| `/thinking` | Toggle thinking mode |
| `/sandbox` | Toggle sandbox mode |
| `/sessions` | Browse and resume sessions |
| `Esc` | Stop running agents |
| `Ctrl+C` | Quit |

### Profiles

| Profile | Opus | Sonnet | Codex |
|---------|------|--------|-------|
| **high** | high/thinking | high/thinking | high/thinking |
| **medium** | high/thinking | medium | medium |
| **low** | medium | low | low |

## Configuration

Config is stored at `~/.fedi-cli/config.json` and persisted automatically when changed via CLI flags or slash commands.

Key settings:

| Key | Default | Description |
|-----|---------|-------------|
| `execTimeoutMs` | 120000 | Max agent execution time (ms) |
| `codexTimeoutMs` | 0 | Codex timeout (0 = unlimited) |
| `delegateTimeoutMs` | 120000 | Idle delegate timeout (ms) |
| `maxRelaysPerWindow` | 50 | Rate limit per window |
| `relayWindowMs` | 60000 | Rate-limit window (ms) |
| `maxCrossTalkPerRound` | 20 | Cross-talk message ceiling |
| `maxLogFiles` | 20 | Log rotation count |
| `claudeModel` | claude-sonnet-4-6 | Sonnet model ID |
| `opusModel` | claude-opus-4-6 | Opus model ID |
| `codexModel` | gpt-5.3-codex | Codex model ID |
| `circuitBreakerThreshold` | 3 | Failures before circuit opens |
| `sandboxMode` | true | Require approval for destructive ops |
| `logLevel` | info | Log verbosity |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FEDI_LOG_LEVEL` | Override log level (`debug`, `info`, `warn`, `error`) |

## Logs & Sessions

**Logs** are written to `~/.fedi-cli/logs/` in two formats:
- `.log` — human-readable (timestamped, categorized)
- `.jsonl` — structured JSON (for programmatic analysis)

Log rotation keeps the most recent 20 sessions (configurable via `maxLogFiles`).

**Generated files**: Fedi CLI writes `AGENTS.md` (Codex system prompt) and `CLAUDE.md` (project rules for Claude agents) in the project directory at startup. If you use git, add them to your `.gitignore`:
```
AGENTS.md
CLAUDE.md
sessions/
```

**Sessions** are saved to `./sessions/` in the project directory. Each session records:
- All user messages and agent exchanges
- Agent session IDs for continuity
- Timestamps for replay

## Security Model

| Mode | Flag | Behavior |
|------|------|----------|
| **Sandbox** (default) | `--sandbox` | Agents require approval for destructive operations |
| **Full-auto** | `--unsafe` | Agents run with `--dangerously-skip-permissions` |

Toggle at runtime via `/sandbox` in the slash menu.

## Development

```bash
# Run in dev mode (tsx, no build)
npm run dev

# Build TypeScript
npm run build

# Typecheck without emitting
npm run typecheck

# Run tests
npm test

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:check
```

### Project Structure

```
src/
├── index.tsx              # CLI entry point, arg parsing
├── agents/
│   ├── types.ts           # Agent interfaces & types
│   ├── base-app-server-agent.ts  # JSON-RPC agent base class
│   ├── base-sonnet-agent.ts      # Claude CLI agent base
│   ├── opus.ts / sonnet.ts / codex.ts  # Concrete agents
│   └── ...
├── orchestrator/
│   ├── orchestrator.ts    # Main orchestrator (facade)
│   ├── relay-router.ts    # [TO:*] tag detection & routing
│   ├── delegate-tracker.ts # Opus→worker delegation tracking
│   ├── cross-talk-manager.ts # Inter-agent communication state
│   ├── buffer-manager.ts  # Output buffering & status snippets
│   ├── claude-md-manager.ts # CLAUDE.md generation
│   ├── prompt-rules.ts    # Shared prompt building blocks
│   ├── prompts.ts         # System prompt generation
│   └── message-bus.ts     # Message routing
├── ui/
│   ├── Dashboard.tsx       # Main TUI component
│   ├── InputBar.tsx        # User input
│   ├── SlashMenu.tsx       # / command menu
│   └── ...
├── config/
│   ├── user-config.ts     # Zod-validated config with persistence
│   └── theme.ts           # Color theme
├── utils/
│   ├── log.ts             # Unified logging (file + structured)
│   ├── session-manager.ts # Session persistence
│   ├── version.ts         # Package version
│   └── detect.ts          # CLI detection
└── test-utils/
    ├── test-harness.ts    # Fast test orchestrator setup
    └── mock-agent.ts      # In-memory mock agent
```

### Testing

Tests use Node.js built-in test runner (`node --test`). The test harness provides a fully wired in-memory orchestrator with mock agents — no real processes spawned.

Timer values are overridden at import time for fast tests (~5s instead of ~57s):
- `relayDraftFlushMs`: 15ms (vs 150ms production)
- `safetyNetDebounceMs`: 30ms (vs 500ms production)

### CI

GitHub Actions runs on Node 20 and 22:
1. `npm ci` — install
2. `npm run typecheck` — type checking
3. `npm run lint` — ESLint
4. `npm run format:check` — Prettier
5. `npm test` — unit tests
6. Smoke test — `npm pack` + install + verify binary + verify `main()` export + `--help`

## Troubleshooting

**Agents don't start / crash immediately**
- Check logs at `~/.fedi-cli/logs/`
- Verify Claude CLI is installed: `claude --version`
- Verify Codex CLI is installed: `codex --version`
- Ensure API keys are configured

**Agent is slow**
- This is normal for complex tasks. The orchestrator has patience built in.
- Check effort level: `/effort` or `--profile low` for faster responses
- Circuit breaker opens after 3 consecutive failures (auto-recovers after 60s)

**Session data**
- Sessions: `./sessions/` in project dir
- Config: `~/.fedi-cli/config.json`
- Logs: `~/.fedi-cli/logs/`

## License

MIT
