# Discord Gemini Bot

Bot Discord (2025) utilisant Google Gemini + mémoire de conversation par thread via SQLite.

## Fonctionnalités
- Mentionne le bot avec une question: il répond en reply + bouton "Transformer en thread".
- Bouton: crée un thread public et y copie la question + réponse.
- Dans un thread existant: mention du bot => réponse avec contexte mémorisé uniquement pour ce thread.
- Mémoire persistante par thread stockée en SQLite (`memory.db`).

## Configuration

1. Copie `.env.example` vers `.env` et remplis uniquement:
```
DISCORD_TOKEN=...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-pro
DEFAULT_LOCALE=fr
```
2. Édite `config.json` pour le reste:
```jsonc
{
	"guildId": "123456789012345678",
	"whitelistChannelIds": ["123456789012345678", "234567890123456789"],
	"whitelistAdminUserIds": ["111111111111111111"],
	"whitelistAdminRoleIds": ["333333333333333333"],
	"userWhitelistIds": ["555555555555555555"],
	"roleWhitelistIds": ["666666666666666666"],
	"enableThreadTransform": true,
	"systemPrompt": "Tu es un assistant IA utile et concis sur un serveur Discord francophone. Ne révèle pas de secrets."
}
```
Les champs sont optionnels; si absent, certains retombent sur les variables d'environnement (rétrocompatibilité) ou valeurs par défaut.

## Démarrage
```
npm install
npm run start
```

## Notes
- Node.js >= 18.17 requis
- Le bot efface les messages système trop longs pour éviter dépassement du contexte.
- Ajoute éventuellement un index sur la table `memory` si croissance importante.
Les paramètres de whitelist (salons, utilisateurs, rôles), admin, prompt et guild sont maintenant centralisés dans `config.json`.

### Désactiver la transformation en thread
La clé `enableThreadTransform` (booléen, défaut: true) permet de masquer le bouton "Transformer en thread" et de bloquer son interaction lorsqu'elle est à `false`.

## Blacklist
Un fichier `blacklist.json` contient: `{ "users": ["id1", "id2"] }`.

Commande slash:
- `/blacklist add utilisateur:@User` -> ajoute
- `/blacklist remove utilisateur:@User` -> retire
- `/blacklist list` -> affiche la liste

Effets pour un utilisateur blacklist:
- Aucune réponse aux mentions ou replies
- Impossible d'utiliser le bouton "Transformer en thread"
- Impossible d'utiliser les autres boutons

Si aucune entrée admin (whitelistAdminUserIds / whitelistAdminRoleIds) n'est définie, personne ne peut gérer la blacklist.

## Commande /prompt
Permet aux admins de mettre à jour dynamiquement le prompt système utilisé pour toutes les réponses.

Usage:
`/prompt texte:"Nouveau comportement détaillé ici"`

Effets:
- Met à jour immédiatement le prompt en mémoire
- Sauvegarde la valeur dans `config.json` (clé `systemPrompt`)
- S'applique à la prochaine génération de réponse
