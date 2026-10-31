━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MC AFK Bot (Bedrock 26.60 & Java) — Pterodactyl Hosting Guide
  Made by Ayliee · AeroX Development
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REQUIREMENTS
────────────
  • Pterodactyl panel with a Node.js egg (v20.3+ recommended: Node 20, 22, or 24)
  • Outbound TCP & UDP internet access from the container (Bedrock uses UDP /
    WebRTC + TCP/HTTP on port 19132; Java uses TCP on port 25565)
  • A Discord bot token from https://discord.com/developers/applications
  • The bot application must have these Privileged Gateway Intents enabled:
      – Message Content Intent
      – Server Members Intent  (optional)

STEP 1 — CREATE THE EGG (if not already set up)
─────────────────────────────────────────────────
  In your Pterodactyl panel:
    Admin → Nests → Import Egg
  Use the official "Node.js Generic" egg, or any Node.js egg that:
    • Runs `npm install` before start
    • Uses `npm start` (or `node src/index.js`) as the startup command

  Recommended startup command:
    npm install --omit=dev && npm start

  NOTE: `.npmrc` includes `ignore-scripts=true` so Pterodactyl containers do NOT
  need `cmake` or a C++ compiler installed.

STEP 2 — CREATE THE SERVER
────────────────────────────
  Admin → Servers → Create New
    • Choose your Node.js egg
    • Set Docker image / Node.js version to Node 20, 22, or 24
    • RAM: 256 MB minimum (512 MB recommended if running multiple bots)
    • Disk: 512 MB minimum

STEP 3 — UPLOAD THE BOT
─────────────────────────
  Upload the repository files (or pull directly from Git) so the server root
  looks like:
    /home/container/
      src/
        index.js
        BotManager.js
        BedrockBot.js
        bedrockTransport.js
        MinecraftBot.js
        ui.js
      .npmrc
      package.json
      .env.example

STEP 4 — SET ENVIRONMENT VARIABLES
─────────────────────────────────────
  Option A — Via Pterodactyl Startup Variables (recommended):
    Go to your server → Startup tab
    Add the following variables:
      DISCORD_TOKEN   → your bot token
      GUILD_ID        → your Discord server ID (optional, leave blank for all guilds)

  Option B — Via .env file:
    In the File Manager, copy .env.example → .env
    Edit .env and fill in your DISCORD_TOKEN and optionally GUILD_ID

STEP 5 — START THE SERVER
───────────────────────────
  Click Start. Pterodactyl will run `npm install` and then `npm start`.
  You should see in the console:
    Discord bot logged in as YourBot#1234 — restricted to guild 123456789...

  If you see:
    [ERROR] DISCORD_TOKEN is not set.
  → Go back to Step 4 and make sure the token is configured.

STEP 6 — INVITE THE BOT
─────────────────────────
  Go to https://discord.com/developers/applications
  Select your bot → OAuth2 → URL Generator
  Scopes:   bot
  Permissions:
    • Read Messages / View Channels
    • Send Messages
    • Read Message History
  Copy the URL and open it in your browser to invite the bot.

  IMPORTANT: In the bot's settings page, enable:
    • Message Content Intent  (required for commands to work)

COMMANDS
────────
  !join [bedrock|java] <ip[:port]> [username]   Join a cracked server (default: bedrock)
  !premjoin [bedrock|java] <ip[:port]>          Join via Microsoft / Xbox account
  !leave <ip> <username>                        Disconnect a bot
  !say <ip> <username> <message>                Send chat or /command in-game
  !bots                                         List all active bots
  !jump <ip> <username>                         Force a bot to jump
  !help                                         Show command reference in Discord

ATERNOS & BEDROCK 26.60 NOTES
─────────────────────────────
  • Since Minecraft Bedrock 26.60, Aternos and Bedrock Dedicated Servers use
    NetherNet on default port `19132` (automatically handled by this bot).
  • Make sure your Aternos server is started/online before running `!join`.
  • If using `!join bedrock <ip>` (no Microsoft login), enable "Cracked" in
    your Aternos server Options; otherwise use `!premjoin bedrock <ip>`.
  • Microsoft / Xbox auth tokens are cached in `auth-cache/`. Delete that
    folder to force a new Microsoft login.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
