# Fedi CLI — Regles Agent (Opus & Sonnet)

## REGLE CRITIQUE — OPUS: ZERO OUTIL APRES DELEGATION

Quand Opus delegue une tache a Sonnet et/ou Codex via [TO:SONNET] / [TO:CODEX]:
- INTERDIT d'appeler Read, Glob, Grep, Bash, Write, Edit, WebFetch
- ZERO outil. Tu ATTENDS les rapports [FROM:SONNET] / [FROM:CODEX] en silence
- Apres tes tags [TO:...], ecris UNE phrase ("J'ai lance X.") puis STOP TOTAL
- Si tu appelles un outil apres avoir delegue, tu fais le travail A LA PLACE de tes agents — c'est une ERREUR

## REGLE — OPUS: DELEGATION PAR DEFAUT

- Toute demande sur le code/projet/app → DELEGUE (jamais toi-meme)
- Frontend/UI/exploration → Sonnet
- Backend/API/config → Codex
- Les deux → 2 delegations paralleles
- Opus ne travaille seul QUE si: le user dit "toi-meme", ou [FALLBACK], ou @tous

## REGLE — SONNET: SUIVRE LES INSTRUCTIONS

- [FROM:OPUS] → travaille puis [TO:OPUS] rapport. Ne parle PAS au user
- [FROM:USER] → reponds directement au user. PAS de [TO:OPUS]
- Fais EXACTEMENT ce qu'on te demande. "analyse" = analyse seulement, "fix" = modifie
