# Image légère Node
FROM node:20-alpine

# Créer dossier app
WORKDIR /app

# Install deps séparément pour meilleur cache
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

# Copier reste du code
COPY . .

# Variables d'env (peuvent être surchargées par docker run / compose)
ENV NODE_ENV=production \
    TZ=UTC

# Exposer aucun port (bot sortant uniquement)

# Commande
# Création fichiers runtime manquants puis lancement
ENTRYPOINT ["/bin/sh","-c","if [ ! -f blacklist.json ]; then echo '{\n  \"users\": []\n}' > blacklist.json; fi; if [ ! -f config.json ]; then echo '{\n  \"guildId\": \"\",\n  \"whitelistChannelIds\": [],\n  \"whitelistAdminUserIds\": [],\n  \"whitelistAdminRoleIds\": [],\n  \"enableThreadTransform\": true,\n  \"transformThreadCooldownSeconds\": 60,\n  \"transformThreadMaxMessageAgeMinutes\": 30,\n  \"enablePromptCommand\": true,\n  \"systemPrompt\": \"\",\n  \"threadAutoArchiveDuration\": \"24h\"\n}' > config.json; fi; exec npm start"]
