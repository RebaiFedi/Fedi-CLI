# AGENTS.md — Configuration des agents VOLTA

## Gemini CLI
- Role: Chef de projet, read-only, supervision
- Commande: gemini --yolo
- Mode: Analyse, rapport, detection de mode

## Claude Code
- Role: Ingenieur frontend, React, UI, CSS
- Modele: claude-opus-4-6
- Mode: stream-json, dangerously-skip-permissions

## Codex CLI
- Role: Ingenieur backend, APIs, DB, auth
- Modele: gpt-5.3-codex-xhigh
- Mode: exec, full-auto, json

## Communication
Tous les agents communiquent via CHANNEL.md.
Format: [Agent → Destinataire] message (max 10 mots)
