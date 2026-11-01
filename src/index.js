// Made by Asto

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  msg,
  msgWithButtons,
  ContainerBuilder,
  ButtonStyle,
  MessageFlags,
  thinDivider,
  text,
  button,
  buildBotControlRow,
} from './ui.js';
import { BotManager } from './BotManager.js';
import {
  parseServerAddress,
  looksLikeServerAddress,
  getDefaultServer,
  setDefaultServer,
  clearDefaultServer,
} from './serverConfig.js';

// ─── Startup validation ────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('[ERROR] DISCORD_TOKEN is not set. Add it to your .env file or container environment variables.');
  process.exit(1);
}

const GUILD_ID = process.env.GUILD_ID?.trim() || null;

// ─── Client & Live Discord Status ─────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const BOT_BIO = 'Made by Asto';

function syncDiscordPresence() {
  if (!client.user) return;
  try {
    const presence = botManager.getPresenceData();
    client.user.setPresence(presence);
  } catch {
    // Ignore transient gateway state errors
  }
}

async function syncBotApplicationBio() {
  try {
    if (!client.application) return;
    await client.application.fetch();
    if (client.application.description !== BOT_BIO) {
      await client.application.edit({ description: BOT_BIO });
    }
  } catch {
    // Ignore if application bio is managed externally
  }
}

const botManager = new BotManager({
  onChange: () => syncDiscordPresence(),
});

client.on('clientReady', () => {
  if (GUILD_ID) {
    console.log(`Discord bot logged in as ${client.user.tag} — restricted to guild ${GUILD_ID}`);
  } else {
    console.log(`Discord bot logged in as ${client.user.tag} — active in all servers`);
  }
  syncDiscordPresence();
  syncBotApplicationBio();
  // Refresh presence periodically in case of Discord gateway reconnects
  setInterval(syncDiscordPresence, 60_000).unref?.();
});

// ─── Help ─────────────────────────────────────────────────────────────────────

const COMMANDS = [
  { usage: '!setserver [bedrock|java] <ip[:port]>', desc: 'Save your default server so short commands work.' },
  { usage: '!join [username]',                      desc: 'Join your default server (or `!join [bedrock|java] <ip[:port]> [username]`).' },
  { usage: '!premjoin',                             desc: 'Join via Microsoft / Xbox account (or `!premjoin [bedrock|java] <ip[:port]>`).' },
  { usage: '!bots',                                 desc: 'Open interactive bot status & button control panel.' },
  { usage: '!say [username] <message>',             desc: 'Send chat or a `/command` in-game.' },
  { usage: '!jump [username]',                      desc: 'Force a bot to jump.' },
  { usage: '!sneak [username]',                     desc: 'Toggle crouch / sneak on or off.' },
  { usage: '!coords [username]',                    desc: 'Show live X / Y / Z coordinates & uptime.' },
  { usage: '!leave [username | all]',               desc: 'Disconnect one bot or all active bots.' },
  { usage: '!help',                                 desc: 'Show this reference.' },
];

function buildHelp(defaultServer) {
  const c = new ContainerBuilder();

  c.addTextDisplayComponents(text('## MC AFK Bot Commands'));
  c.addSeparatorComponents(thinDivider());

  const commandLines = COMMANDS
    .map((cmd) => `\`${cmd.usage}\` **- ${cmd.desc}**`)
    .join('\n');

  const defaultLine = defaultServer
    ? `\n\n**Current Default Server:** \`${defaultServer.host}:${defaultServer.port}\` (${defaultServer.edition === 'java' ? 'Java' : 'Bedrock'})`
    : '\n\n**Tip:** Run `!setserver <ip[:port]>` once so you can just type `!join AFKBot`!';

  c.addTextDisplayComponents(
    text(
      '**Send Minecraft Bedrock (26.60) & Java AFK bots to any server from Discord.**' +
      defaultLine +
      '\n\n**Commands:**\n' +
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
    text('**Made by Asto**')
  );

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Per-user command rate limiting ───────────────────────────────────────────

const COOLDOWN_MS = 2_000;
const cooldowns = new Map();

function isRateLimited(userId) {
  const last = cooldowns.get(userId);
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) return true;
  cooldowns.set(userId, now);
  return false;
}

// ─── Argument & username helpers ──────────────────────────────────────────────

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

function extractEdition(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === 'bedrock' || lower === 'be') return 'bedrock';
  if (lower === 'java' || lower === 'je') return 'java';
  return null;
}

function pickDefaultUsername(host) {
  if (!botManager.hasBotOnHost('AFKBot', host)) {
    return 'AFKBot';
  }
  return `AFK_${Math.floor(1000 + Math.random() * 9000)}`;
}

// Parse `[ip] [username]` for single-action commands (!leave, !jump, !sneak, !coords)
function resolveBotTargetArgs(args) {
  if (!args[1]) {
    return { host: null, username: null };
  }
  if (args[2]) {
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return { error: 'invalid server address' };
    return { host: parsed.host, username: args[2] };
  }
  if (looksLikeServerAddress(args[1])) {
    const parsed = parseServerAddress(args[1], 19132);
    return { host: parsed?.host || null, username: null };
  }
  return { host: null, username: args[1] };
}

function isBotsPanelMessage(discordMessage) {
  try {
    const raw = JSON.stringify(discordMessage?.components || []);
    return raw.includes('"bot:refresh"');
  } catch {
    return false;
  }
}

function rebuildConnectedBotCard(bot, disconnected = false) {
  const name = bot.realUsername || bot.options.username;
  const verLine =
    bot.edition === 'java'
      ? `Java${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`
      : `Bedrock ${bot.serverVersion} · ${bot.transportLabel || 'Bedrock'}`;

  const c = new ContainerBuilder();
  if (disconnected) {
    c.addTextDisplayComponents(
      text(`**${name}** disconnected from **${bot.options.host}:${bot.options.port}**\n-# ${verLine}`)
    );
  } else {
    c.addTextDisplayComponents(
      text(`**${name}** connected to **${bot.options.host}:${bot.options.port}**\n-# ${verLine}`)
    );
    c.addSeparatorComponents(thinDivider());
    c.addActionRowComponents(
      buildBotControlRow(bot.botId, { isOnline: bot.isOnline, isSneaking: bot.isSneaking })
    );
  }
  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const KNOWN_COMMANDS = new Set([
  '!help',
  '!setserver',
  '!setseerver',
  '!server',
  '!join',
  '!premjoin',
  '!leave',
  '!say',
  '!bots',
  '!status',
  '!jump',
  '!sneak',
  '!coords',
]);

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content) return;
  if (GUILD_ID && message.guild.id !== GUILD_ID) return;

  const trimmed = message.content.trim();
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) return;

  const args = tokens.map((t) => t.value);
  const rawCmd = args[0].toLowerCase();
  if (!KNOWN_COMMANDS.has(rawCmd)) return;

  // Normalize aliases
  const command =
    rawCmd === '!setseerver' || rawCmd === '!server'
      ? '!setserver'
      : rawCmd === '!status'
        ? '!bots'
        : rawCmd;

  if (isRateLimited(message.author.id)) {
    return message.reply(msg('-# Please wait a moment before sending another command.'));
  }

  const defaultServer = getDefaultServer(message.guild.id);

  // !help
  if (command === '!help') {
    return message.reply(buildHelp(defaultServer));
  }

  // !setserver [bedrock|java] <ip[:port]> | !setserver clear | !setserver
  if (command === '!setserver') {
    if (!args[1]) {
      if (!defaultServer) {
        return message.reply(
          msg(
            'No default server set yet.\n-# Set one with `!setserver <ip[:port]>` (or `!setserver java <ip[:port]>`) so `!join AFKBot` works directly.'
          )
        );
      }
      const edLabel = defaultServer.edition === 'java' ? 'Java' : 'Bedrock';
      return message.reply(
        msgWithButtons(
          `**Default Server:** \`${defaultServer.host}:${defaultServer.port}\` (${edLabel})\n` +
          `-# Run \`!join AFKBot\` (or click below) · Clear anytime with \`!setserver clear\``,
          button('bot:quickjoin', 'Join AFKBot', ButtonStyle.Success)
        )
      );
    }

    if (['clear', 'reset', 'none', 'off'].includes(args[1].toLowerCase())) {
      clearDefaultServer(message.guild.id);
      syncDiscordPresence();
      return message.reply(msg('Cleared default server.'));
    }

    const explicitEdition = extractEdition(args[1]);
    const edition = explicitEdition || 'bedrock';
    const addrArg = explicitEdition ? args[2] : args[1];

    if (!addrArg) {
      return message.reply(msg(`usage: \`!setserver ${edition} <ip[:port]>\``));
    }

    const defaultPort = edition === 'java' ? 25565 : 19132;
    const parsed = parseServerAddress(addrArg, defaultPort);
    if (!parsed || !looksLikeServerAddress(addrArg)) {
      return message.reply(
        msg('invalid server address — example: `!setserver RndmCraft.aternos.me:19132`')
      );
    }

    const saved = setDefaultServer(message.guild.id, {
      edition,
      host: parsed.host,
      port: parsed.port,
    });
    syncDiscordPresence();

    const edLabel = saved.edition === 'java' ? 'Java' : 'Bedrock';
    return message.reply(
      msgWithButtons(
        `Default server saved: **${saved.host}:${saved.port}** (${edLabel})\n` +
        `-# Now you can simply use \`!join AFKBot\`, \`!premjoin\`, \`!bots\`, \`!say\`, and \`!leave\`.`,
        button('bot:quickjoin', 'Join AFKBot', ButtonStyle.Success)
      )
    );
  }

  // !join [bedrock|java] [ip[:port]] [username]
  if (command === '!join') {
    const explicitEdition = extractEdition(args[1]);
    const rest = explicitEdition ? args.slice(2) : args.slice(1);

    let edition = explicitEdition || defaultServer?.edition || 'bedrock';
    let targetHost = null;
    let targetPort = null;
    let username = null;

    if (rest.length === 0) {
      // `!join` or `!join bedrock` -> use default server
      if (!defaultServer) {
        return message.reply(
          msg('No default server set — run `!setserver <ip[:port]>` first, or use `!join <ip[:port]> [username]`.')
        );
      }
      if (!explicitEdition) edition = defaultServer.edition;
      targetHost = defaultServer.host;
      targetPort = explicitEdition && explicitEdition !== defaultServer.edition
        ? (edition === 'java' ? 25565 : 19132)
        : defaultServer.port;
      username = pickDefaultUsername(targetHost);
    } else if (rest.length === 1) {
      // Either `!join AFKBot` (username on default server) OR `!join RndmCraft.aternos.me` (server IP)
      if (looksLikeServerAddress(rest[0])) {
        const defaultPort = edition === 'java' ? 25565 : 19132;
        const parsed = parseServerAddress(rest[0], defaultPort);
        if (!parsed) {
          return message.reply(msg('invalid server address — example: `!join RndmCraft.aternos.me AFKBot`'));
        }
        targetHost = parsed.host;
        targetPort = parsed.port;
        username = pickDefaultUsername(targetHost);
      } else {
        if (!defaultServer) {
          return message.reply(
            msg(
              `No default server set for **${rest[0]}** — save one once with \`!setserver <ip[:port]>\`, or run \`!join <ip[:port]> ${rest[0]}\`.`
            )
          );
        }
        if (!explicitEdition) edition = defaultServer.edition;
        targetHost = defaultServer.host;
        targetPort = explicitEdition && explicitEdition !== defaultServer.edition
          ? (edition === 'java' ? 25565 : 19132)
          : defaultServer.port;
        username = rest[0];
      }
    } else {
      // `!join <ip[:port]> <username>`
      const defaultPort = edition === 'java' ? 25565 : 19132;
      const parsed = parseServerAddress(rest[0], defaultPort);
      if (!parsed) {
        return message.reply(msg('invalid server address — example: `!join RndmCraft.aternos.me AFKBot`'));
      }
      targetHost = parsed.host;
      targetPort = parsed.port;
      username = rest[1];
    }

    if (!isValidUsername(username, edition)) {
      const rule =
        edition === 'java'
          ? '3-16 characters, letters/numbers/underscores only.'
          : '3-16 characters, letters/numbers/spaces/underscores.';
      return message.reply(msg(`invalid username **${username}**\n-# Must be ${rule}`));
    }

    botManager.joinCracked({ edition, host: targetHost, port: targetPort, username }, message.channel);
    return;
  }

  // !premjoin [bedrock|java] [ip[:port]]
  if (command === '!premjoin') {
    const explicitEdition = extractEdition(args[1]);
    const addrArg = explicitEdition ? args[2] : args[1];

    let edition = explicitEdition || defaultServer?.edition || 'bedrock';
    let targetHost = null;
    let targetPort = null;

    if (!addrArg) {
      if (!defaultServer) {
        return message.reply(
          msg('No default server set — run `!setserver <ip[:port]>` first, or use `!premjoin <ip[:port]>`.')
        );
      }
      if (!explicitEdition) edition = defaultServer.edition;
      targetHost = defaultServer.host;
      targetPort = explicitEdition && explicitEdition !== defaultServer.edition
        ? (edition === 'java' ? 25565 : 19132)
        : defaultServer.port;
    } else {
      const defaultPort = edition === 'java' ? 25565 : 19132;
      const parsed = parseServerAddress(addrArg, defaultPort);
      if (!parsed) {
        return message.reply(msg('invalid server address — example: `!premjoin RndmCraft.aternos.me`'));
      }
      targetHost = parsed.host;
      targetPort = parsed.port;
    }

    botManager.joinPremium(
      message.author.id,
      { edition, host: targetHost, port: targetPort },
      message.channel
    );
    return;
  }

  // !leave [all | username | <ip> <username>]
  if (command === '!leave') {
    if (args[1]?.toLowerCase() === 'all' && !args[2]) {
      return botManager.removeAllBots(message.channel);
    }
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.removeBot(target.username, target.host, message.channel, defaultServer?.host || null);
    return;
  }

  // !say [<ip> <username> <msg> | <username> <msg> | <msg>]
  if (command === '!say') {
    if (!args[1]) {
      return message.reply(msg('usage: `!say [username] <message>` (or `!say <ip> <username> <message>`)'));
    }

    // 1. Full syntax: `!say <ip> <username> <message...>`
    if (looksLikeServerAddress(args[1])) {
      if (!args[2] || !args[3]) {
        return message.reply(msg('usage: `!say <ip> <username> <message>`'));
      }
      const parsed = parseServerAddress(args[1], 19132);
      if (!parsed) return message.reply(msg('invalid server address'));
      const chatText = trimmed.slice(tokens[2].endIndex).trim();
      botManager.say(args[2], parsed.host, chatText, message.channel, defaultServer?.host || null);
      return;
    }

    // 2. Short syntax with bot username: `!say AFKBot hello everyone`
    const namedLookup = botManager.findBotFlexible(args[1], null, defaultServer?.host || null);
    if (namedLookup.match && args[2]) {
      const chatText = trimmed.slice(tokens[1].endIndex).trim();
      namedLookup.match.bot.say(chatText);
      return;
    }

    // 3. Single-bot convenience: `!say hello everyone` when 1 bot is active
    const singleLookup = botManager.findBotFlexible(null, null, defaultServer?.host || null);
    if (singleLookup.match) {
      const chatText = trimmed.slice(tokens[0].endIndex).trim();
      singleLookup.match.bot.say(chatText);
      return;
    }

    if (botManager.bots.size > 1) {
      return message.reply(msg('Multiple bots active — specify `!say <username> <message>`'));
    }
    return message.reply(msg('no active bots'));
  }

  // !bots / !status
  if (command === '!bots') {
    return message.reply(botManager.getStatus(defaultServer));
  }

  // !jump [username | <ip> <username>]
  if (command === '!jump') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.jump(target.username, target.host, message.channel, defaultServer?.host || null);
    return;
  }

  // !sneak [username | <ip> <username>]
  if (command === '!sneak') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.sneak(target.username, target.host, message.channel, defaultServer?.host || null);
    return;
  }

  // !coords [username | <ip> <username>]
  if (command === '!coords') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.coords(target.username, target.host, message.channel, defaultServer?.host || null);
    return;
  }
});

// ─── Interactive Button Handlers ──────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (GUILD_ID && interaction.guildId !== GUILD_ID) return;

  const customId = interaction.customId || '';
  if (!customId.startsWith('bot:')) return;

  const defaultServer = getDefaultServer(interaction.guildId);
  const parts = customId.split(':'); // ['bot', action, optionalBotId]
  const action = parts[1];
  const botId = parts[2];

  try {
    if (action === 'refresh') {
      await interaction.update(botManager.getStatus(defaultServer));
      return;
    }

    if (action === 'quickjoin') {
      if (!defaultServer) {
        await interaction.reply({
          content: 'Set a default server first with `!setserver <ip[:port]>`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const username = pickDefaultUsername(defaultServer.host);
      botManager.joinCracked(
        {
          edition: defaultServer.edition,
          host: defaultServer.host,
          port: defaultServer.port,
          username,
        },
        interaction.channel
      );
      if (isBotsPanelMessage(interaction.message)) {
        await interaction.update(botManager.getStatus(defaultServer));
      } else {
        await interaction.reply({
          content: `Launching **${username}** on **${defaultServer.host}:${defaultServer.port}**...`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (action === 'leaveall') {
      const count = botManager.bots.size;
      for (const bot of botManager.bots.values()) {
        bot.stop();
      }
      botManager.bots.clear();
      syncDiscordPresence();
      await interaction.update(botManager.getStatus(defaultServer));
      if (count > 0 && interaction.channel) {
        interaction.channel.send(msg(`Disconnected **${count}** bot${count === 1 ? '' : 's'}`)).catch(() => {});
      }
      return;
    }

    const found = botId ? botManager.getBotById(botId) : null;
    if (!found) {
      if (isBotsPanelMessage(interaction.message)) {
        await interaction.update(botManager.getStatus(defaultServer));
      } else {
        await interaction.reply({
          content: 'That bot is no longer active.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    const { bot } = found;

    if (action === 'jump') {
      const res = bot.jump({ silent: true });
      await interaction.reply({
        content: res.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'sneak') {
      const res = bot.toggleSneak({ silent: true });
      if (!res.ok) {
        await interaction.reply({
          content: res.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (isBotsPanelMessage(interaction.message)) {
        await interaction.update(botManager.getStatus(defaultServer));
      } else {
        await interaction.update(rebuildConnectedBotCard(bot, false));
      }
      return;
    }

    if (action === 'coords') {
      await interaction.reply({
        content: botManager.formatCoordsText(bot),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'leave') {
      const { displayName, host } = botManager.removeByEntry(found);
      if (isBotsPanelMessage(interaction.message)) {
        await interaction.update(botManager.getStatus(defaultServer));
        interaction.channel?.send(msg(`**${displayName}** disconnected from **${host}**`)).catch(() => {});
      } else {
        await interaction.update(rebuildConnectedBotCard(bot, true));
      }
      return;
    }
  } catch (err) {
    console.error('[Discord Interaction Error]', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
