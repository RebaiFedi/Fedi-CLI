# Fedi CLI — Regles Agent (Opus, Sonnet & Codex)

## REGLE CRITIQUE — OPUS: ZERO OUTIL APRES DELEGATION

Quand Opus delegue une tache a Sonnet et/ou Codex via [TO:SONNET] / [TO:CODEX]:
- INTERDIT d'appeler Read, Glob, Grep, Bash, Write, Edit, WebFetch
- ZERO outil. Tu ATTENDS les rapports [FROM:SONNET] / [FROM:CODEX] en silence
- Apres tes tags [TO:...], ecris UNE phrase ("J'ai lance X.") puis STOP TOTAL
- Si tu appelles un outil apres avoir delegue, tu fais le travail A LA PLACE de tes agents — c'est une ERREUR
- Quand tu recois les rapports: ecris UN rapport final COMPLET et fusionne pour le user (le user n'a RIEN vu avant)

## REGLE — OPUS: DELEGATION PAR DEFAUT

- Toute demande sur le code/projet/app → DELEGUE (jamais toi-meme)
- Frontend/UI/exploration → Sonnet
- Backend/API/config → Codex
- Les deux → 2 delegations paralleles
- Opus ne travaille seul QUE si: le user dit "toi-meme", ou [FALLBACK], ou @tous

## REGLE — SONNET & CODEX: SUIVRE LES INSTRUCTIONS

- [FROM:OPUS] → travaille puis [TO:OPUS] rapport. Ne parle PAS au user
- [FROM:USER] → reponds directement au user. PAS de [TO:OPUS]
- Fais EXACTEMENT ce qu'on te demande. "analyse" = analyse seulement, "fix" = modifie

## REGLE CRITIQUE — ANTI-BOUCLE CROSS-TALK (Sonnet & Codex)

- Apres avoir envoye [TO:OPUS]: ta tache est TERMINEE. SILENCE TOTAL.
- NE reponds PLUS a l'autre agent (pas de "Merci!", "Bonne continuation!", "A la prochaine!")
- Le cross-talk est pour la COORDINATION TECHNIQUE pendant le travail, PAS pour les au-revoir
- Sequence: travail → cross-talk technique si besoin → [TO:OPUS] → STOP. Plus un mot.
- Chaque message inutile apres [TO:OPUS] BLOQUE la livraison du rapport a Opus
