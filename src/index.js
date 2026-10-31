// Made by Ayliee, All rights are reserved to AeroX Development

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  msg,
  ContainerBuilder,
  MessageFlags,
  thinDivider,
  text,
} from './ui.js';
import { BotManager } from './BotManager.js';

// ─── Startup validation ────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('[ERROR] DISCORD_TOKEN is not set. Add it to your .env file or Pterodactyl startup variables.');
  process.exit(1);
}

const GUILD_ID = process.env.GUILD_ID?.trim() || null;

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const botManager = new BotManager();

client.on('clientReady', () => {
  if (GUILD_ID) {
    console.log(`Discord bot logged in as ${client.user.tag} — restricted to guild ${GUILD_ID}`);
  } else {
    console.log(`Discord bot logged in as ${client.user.tag} — active in all servers`);
  }
});

// ─── Help ─────────────────────────────────────────────────────────────────────

const COMMANDS = [
  { usage: '!join [bedrock|java] <ip[:port]> [username]', desc: 'Join a cracked server (defaults to Bedrock).' },
  { usage: '!premjoin [bedrock|java] <ip[:port]>',        desc: 'Join via Microsoft / Xbox account (defaults to Bedrock).' },
  { usage: '!leave <ip> <username>',                      desc: 'Disconnect a bot.' },
  { usage: '!say <ip> <username> <message>',              desc: 'Send chat or a /command in-game.' },
  { usage: '!bots',                                       desc: 'List all active bots and versions.' },
  { usage: '!jump <ip> <username>',                       desc: 'Force a bot to jump.' },
  { usage: '!help',                                       desc: 'Show this reference.' },
];

function buildHelp() {
  const c = new ContainerBuilder();

  c.addTextDisplayComponents(text('## MC AFK Bot Commands'));
  c.addSeparatorComponents(thinDivider());

  const commandLines = COMMANDS
    .map((cmd) => `\`${cmd.usage}\` **- ${cmd.desc}**`)
    .join('\n');

  c.addTextDisplayComponents(
    text(
      '**Send Minecraft Bedrock (26.60) & Java AFK bots to any server from Discord.**\n' +
      '\n' +
      '**Main Commands:**\n' +
      commandLines
    )
  );

  c.addSeparatorComponents(thinDivider());

  c.addTextDisplayComponents(
    text(
      '-# Default ports: Bedrock `19132` (NetherNet & RakNet) · Java `25565`. Wrap spaced gamertags in `"quotes"`.\n' +
      '-# Bots auto-jump every 5s, rotate view every 30s, and auto-respawn to prevent AFK kicks.'
    )
  );

  c.addSeparatorComponents(thinDivider());

  c.addTextDisplayComponents(
    text('**Made by:** Ayliee  ·  AeroX Development')
  );

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Per-user command rate limiting ───────────────────────────────────────────

const COOLDOWN_MS = 3_000;
const cooldowns = new Map();

function isRateLimited(userId) {
  const last = cooldowns.get(userId);
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) return true;
  cooldowns.set(userId, now);
  return false;
}

// ─── Argument & address parsing helpers ───────────────────────────────────────

const JAVA_USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const BEDROCK_USERNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_ -]{1,14}[a-zA-Z0-9_]$/;

function isValidUsername(name, edition) {
  if (edition === 'java') return JAVA_USERNAME_RE.test(name);
  return (JAVA_USERNAME_RE.test(name) || BEDROCK_USERNAME_RE.test(name)) && !/\s{2,}/.test(name);
}

// Tokenize arguments while supporting "quoted Bedrock gamertags" and keeping raw tail index
function tokenizeCommand(input) {
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push({
      value: match[1] ?? match[2] ?? match[3],
      endIndex: re.lastIndex,
    });
  }
  return tokens;
}

// Sanitize Discord markdown links, <http://...>, schemes, and split host[:port]
function parseServerAddress(raw, defaultPort) {
  if (!raw) return null;
  let cleaned = String(raw).trim();

  // Extract target from markdown [label](url) if pasted
  const mdMatch = cleaned.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (mdMatch) cleaned = mdMatch[1];

  cleaned = cleaned
    .replace(/^<+|>+$/g, '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();

  if (!cleaned) return null;

  let host = cleaned;
  let port = defaultPort;

  // IPv6 [::1]:19132
  const ipv6Match = cleaned.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    host = ipv6Match[1];
    if (ipv6Match[2]) port = parseInt(ipv6Match[2], 10);
  } else {
    const colonIdx = cleaned.lastIndexOf(':');
    if (colonIdx > 0 && cleaned.indexOf(':') === colonIdx) {
      const maybePort = cleaned.slice(colonIdx + 1);
      host = cleaned.slice(0, colonIdx);
      if (/^\d+$/.test(maybePort)) {
        const parsed = parseInt(maybePort, 10);
        if (parsed >= 1 && parsed <= 65535) port = parsed;
      }
    }
  }

  if (!host) return null;
  return { host, port };
}

function extractEdition(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === 'bedrock' || lower === 'be') return 'bedrock';
  if (lower === 'java' || lower === 'je') return 'java';
  return null;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content) return;
  if (GUILD_ID && message.guild.id !== GUILD_ID) return;

  const trimmed = message.content.trim();
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) return;

  const args = tokens.map((t) => t.value);
  const command = args[0].toLowerCase();

  const knownCommands = ['!help', '!join', '!premjoin', '!leave', '!say', '!bots', '!jump'];
  if (!knownCommands.includes(command)) return;

  if (isRateLimited(message.author.id)) {
    return message.reply(msg('-# Please wait a moment before sending another command.'));
  }

  // !help
  if (command === '!help') {
    return message.reply(buildHelp());
  }

  // !join [bedrock|java] <ip[:port]> [username]
  if (command === '!join') {
    if (!args[1]) {
      return message.reply(msg('usage: `!join [bedrock|java] <ip[:port]> [username]`'));
    }

    const explicitEdition = extractEdition(args[1]);
    const edition = explicitEdition || 'bedrock';
    const addrArg = explicitEdition ? args[2] : args[1];
    const usernameArg = explicitEdition ? args[3] : args[2];

    if (!addrArg) {
      return message.reply(msg(`usage: \`!join ${edition} <ip[:port]> [username]\``));
    }

    const defaultPort = edition === 'java' ? 25565 : 19132;
    const parsed = parseServerAddress(addrArg, defaultPort);
    if (!parsed) {
      return message.reply(msg('invalid server address — example: `!join bedrock RndmCraft.aternos.me`'));
    }

    const username = usernameArg || `AFK_${Math.floor(1000 + Math.random() * 9000)}`;
    if (!isValidUsername(username, edition)) {
      const rule =
        edition === 'java'
          ? '3-16 characters, letters/numbers/underscores only.'
          : '3-16 characters, letters/numbers/spaces/underscores.';
      return message.reply(msg(`invalid username **${username}**\n-# Must be ${rule}`));
    }

    botManager.joinCracked({ edition, host: parsed.host, port: parsed.port, username }, message.channel);
    return;
  }

  // !premjoin [bedrock|java] <ip[:port]>
  if (command === '!premjoin') {
    if (!args[1]) {
      return message.reply(msg('usage: `!premjoin [bedrock|java] <ip[:port]>`'));
    }

    const explicitEdition = extractEdition(args[1]);
    const edition = explicitEdition || 'bedrock';
    const addrArg = explicitEdition ? args[2] : args[1];

    if (!addrArg) {
      return message.reply(msg(`usage: \`!premjoin ${edition} <ip[:port]>\``));
    }

    const defaultPort = edition === 'java' ? 25565 : 19132;
    const parsed = parseServerAddress(addrArg, defaultPort);
    if (!parsed) {
      return message.reply(msg('invalid server address — example: `!premjoin bedrock RndmCraft.aternos.me`'));
    }

    botManager.joinPremium(message.author.id, { edition, host: parsed.host, port: parsed.port }, message.channel);
    return;
  }

  // !leave <ip> <username>
  if (command === '!leave') {
    if (!args[1] || !args[2]) return message.reply(msg('usage: `!leave <ip> <username>`'));
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return message.reply(msg('invalid server address'));
    botManager.removeBot(args[2], parsed.host, message.channel);
    return;
  }

  // !say <ip> <username> <message...>
  if (command === '!say') {
    if (!args[1] || !args[2] || !args[3]) {
      return message.reply(msg('usage: `!say <ip> <username> <message>`'));
    }
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return message.reply(msg('invalid server address'));
    const chatText = trimmed.slice(tokens[2].endIndex).trim();
    botManager.say(args[2], parsed.host, chatText, message.channel);
    return;
  }

  // !bots
  if (command === '!bots') {
    return message.reply(botManager.getStatus());
  }

  // !jump <ip> <username>
  if (command === '!jump') {
    if (!args[1] || !args[2]) return message.reply(msg('usage: `!jump <ip> <username>`'));
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return message.reply(msg('invalid server address'));
    botManager.jump(args[2], parsed.host, message.channel);
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
