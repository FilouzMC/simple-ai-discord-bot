# Simple Gemini Discord Bot

A Discord bot to chat with **Gemini**, featuring per-thread memory and automatic thread creation.  
Originally prototyped with **GPT-5** and **VS Code (GitHub Copilot)**.

--

## ✨ Features

- **Mention the bot with a question** → it replies directly with an additional button: **“Transform into thread”**.  
- **Transform into thread** → creates a public thread and transfers both the question and the answer.  
- **Inside an existing thread** → mentioning the bot makes it reply with context, using memory **only for that thread**.  
- **Persistent memory per thread** stored locally in **SQLite** (`memory.db`).  

---

## ⚙️ Configuration

- Settings are managed in `config.json` and `.env` (copy the `.env.example` file).  
- The value `threadAutoArchiveDuration` must be one of:  
  - `1h` (1 hour)  
  - `24h` (24 hours)  
  - `3d` (3 days)  
  - `1w` (1 week)
- Admins have access to **slash commands** for bot management.


---

## 🚀 Installation

```bash
npm install
npm start
```

### 🐳 Deploy with Docker (easy way)

1. Create a file `.env`
```
DISCORD_TOKEN=token
GEMINI_API_KEY=api_key
```
2. Build
```
docker build -t simple-gemini-discord-bot .
```
3. Run with docker-compose
```
docker compose up -d --build
```

--

## 📂 Tech Stack

- Node.js
- Discord.js
- SQLite for persistent storage

--

## 📝 Notes

- Built quickly as a prototype, but stable enough for community use.
- Memory is thread-scoped for better context isolation.
- Admin users (configured in `config.json`) are exempt from the transform cooldown and message age limit when creating threads.
