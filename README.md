# AeroX Minecraft AFK Bot (Bedrock 26.60 & Java)

A Discord-controlled Minecraft AFK bot supporting **Bedrock Edition** (including latest **26.60 / 1.26.60**, NetherNet HTTP/HTTPS & RakNet) as well as **Java Edition**. Supports both cracked (offline-mode) and premium (Microsoft / Xbox Live) accounts.

---

## What It Does

- Join any **Bedrock** (default port `19132`) or **Java** (default port `25565`) server through Discord commands
- Supports **Bedrock 26.60 (`1.26.60`)** including the new **NetherNet** HTTP/HTTPS WebRTC transport (used by Aternos, Bedrock Dedicated Server 26.60, and GeyserMC) as well as RakNet for older servers
- Keeps bots alive with automatic jumping, camera rotation, and auto-respawning
- Supports Microsoft / Xbox Live OAuth for online-mode servers — authentication code sent directly in Discord
- Auto-registers / logs in on servers running AuthMe, SimpleAuth, or similar plugins (using Bedrock `command_request` packets for `/` commands)
- Relays in-game chat to your Discord channel
- Auto-reconnects up to 5 times with clear disconnect/error diagnostics
- Manage multiple Bedrock and Java bots simultaneously across different servers

---

## Commands

Save your server once with `!setserver`, and you can use short commands without retyping the IP every time:

| Command | Description |
|---|---|
| `!setserver [bedrock\|java] <ip[:port]>` | Save your default server (persists across restarts; `!setserver clear` to reset) |
| `!join [username]` | Join your default server (or `!join [bedrock\|java] <ip[:port]> [username]`) |
| `!premjoin` | Join via Microsoft / Xbox account (or `!premjoin [bedrock\|java] <ip[:port]>`) |
| `!bots` | Interactive status & button control panel (**Jump**, **Sneak**, **Coords**, **Leave**) |
| `!say [username] <message>` | Send chat or a `/command` in-game (also supports `!say <ip> <username> <msg>`) |
| `!jump [username]` | Manually trigger a jump |
| `!sneak [username]` | Toggle crouch / sneak on or off |
| `!coords [username]` | Show live `X / Y / Z` coordinates & uptime |
| `!leave [username \| all]` | Disconnect a bot or all active bots |
| `!help` | Show the command list |

> **Tip:** Wrap Bedrock gamertags containing spaces in quotes, e.g. `!join bedrock RndmCraft.aternos.me "My Bot"`.
> On Aternos Bedrock servers, make sure the server is **Online** and **Cracked** is enabled in Aternos Options when using `!join` (or use `!premjoin bedrock <ip>` if Cracked is off).

---

## Project Structure

```
├── src/
│   ├── index.js            # Entry point, Discord client & command handler
│   ├── BotManager.js       # Manages lifecycle of active Bedrock & Java bots
│   ├── BedrockBot.js       # Bedrock 26.60+ bot logic, anti-AFK, Xbox auth & packets
│   ├── bedrockTransport.js # RakNet + NetherNet (LAN & HTTP/HTTPS /v1/join) transport
│   ├── MinecraftBot.js     # Java Edition bot logic via Mineflayer
│   └── ui.js               # Discord UI helpers (Components V2 containers)
├── .env.example            # Example environment variable file
├── .npmrc                  # Skips native C++ builds for container/Pterodactyl compatibility
├── HOSTING.md              # Pterodactyl & self-hosting guide
├── package.json
└── LICENSE
```

---

## Setup

1. Clone the repository
2. Ensure **Node.js 20.3+** (Node 20, 22, or 24 recommended) is installed
3. Install dependencies with `npm install`
4. Copy `.env.example` to `.env` and set your Discord bot token:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   GUILD_ID=your_discord_server_id_here
   ```
5. Run the bot with `npm start` (`node src/index.js`)

---

## License

This project is source-available. You may view, run, and privately modify the code, but distribution, public hosting, and commercial use are strictly prohibited. See [LICENSE](./LICENSE) for the full terms.

---

## Credits

Made by **Asto**
