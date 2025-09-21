
# Simple AI Discord Bot

Un bot Discord pour discuter avec différents modèles d'IA générative, avec système de mémoire, de ratelimit, de prompt par salon, de blacklist, de résumé par débat.
De base, un projet fun pour tester les limites de GitHub Copilot et de GPT-5.

---

## Installation

- Cloner le repo
```git clone https://github.com/FilouzMC/simple-ai-discord-bot.git```
- Installer les dépendances
```npm install```
- Copier le fichier `.env.example` en `.env` et remplissez les valeurs
- Lancer le bot une première fois
- Configurer avec le fichier `config/config.json`

### 🐳 Déployer avec Docker
- Cloner le repo
```git clone https://github.com/FilouzMC/simple-ai-discord-bot.git```
- Copier le fichier `.env.example` en `.env` et remplissez les valeurs
- Build
```docker build -t simple-ai-discord-bot .```
- Exécuter avec Docker Compose
```docker compose up -d --build```