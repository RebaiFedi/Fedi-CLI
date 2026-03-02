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

## CROSS-TALK — COLLABORATION ENTRE AGENTS (Sonnet & Codex)

- PENDANT le travail: parlez-vous LIBREMENT! Coordonnez, informez, aidez. C'est une equipe.
- Codex peut envoyer des messages a Sonnet, Sonnet peut envoyer a Codex — c'est NORMAL et ENCOURAGE.
- Utilisez le cross-talk pour: contrats API, types partages, coordination front/back, aide mutuelle.
- APRES avoir envoye [TO:OPUS]: votre tache est finie. Ne renvoyez plus de messages.
- PAS de politesses APRES le rapport ("Merci!", "Bonne continuation!") — ca bloque la livraison.
- Sequence: travail → cross-talk libre → [TO:OPUS] rapport final → fin.
