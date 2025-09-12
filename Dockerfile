# Image Node.js Alpine (lightweight)
FROM node:20-alpine

# Create app folder
WORKDIR /app

# Copy code
COPY . .

# Install dependencies
RUN npm install

ENTRYPOINT ["npm", "start"]