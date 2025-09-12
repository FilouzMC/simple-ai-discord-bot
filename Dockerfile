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
CMD ["npm","start"]
