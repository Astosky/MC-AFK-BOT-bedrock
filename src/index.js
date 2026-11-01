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
  buildBotCardRows,
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
  setInterval(syncDiscordPresence, 60_000).unref?.();
});

// ─── Help ─────────────────────────────────────────────────────────────────────

const CONNECTION_COMMANDS = [
  { usage: '!setserver [bedrock|java] <ip[:port]>', desc: 'Save your default server so short commands work.' },
  { usage: '!join [username]',                      desc: 'Join your default server (or `!join [bedrock|java] <ip[:port]> [username]`).' },
  { usage: '!premjoin',                             desc: 'Join via Microsoft / Xbox account.' },
  { usage: '!bots',                                 desc: 'Interactive bot status & button control panel.' },
  { usage: '!players',                              desc: 'List online & nearby players with distances.' },
  { usage: '!leave [username | all]',               desc: 'Disconnect one bot or all active bots.' },
];

const GAMEPLAY_COMMANDS = [
  { usage: '!play',                  desc: 'Autonomous Play Mode — roam around, sprint-jump, inspect blocks & greet players!' },
  { usage: '!follow [player]',       desc: 'Follow a player (or nearest player if omitted).' },
  { usage: '!come [player]',         desc: 'Walk/sprint over to a player and stop beside them.' },
  { usage: '!look [player]',         desc: 'Stand still and track a player with head & eyes.' },
  { usage: '!circle [player]',       desc: 'Circle-strafe / orbit around a player.' },
  { usage: '!dance',                 desc: 'Party dance — crouch-beat, spin, jump & wave!' },
  { usage: '!hit [player]',          desc: 'Punch a nearby player/mob or wave your arm.' },
  { usage: '!spin',                  desc: 'Do a 360° jump spin.' },
  { usage: '!jump / !sneak / !coords', desc: 'Jump, toggle crouch, or check live XYZ coordinates.' },
  { usage: '!say <message>',         desc: 'Send chat or a `/command` in-game.' },
  { usage: '!stop',                  desc: 'Stop following / playing / dancing and return to AFK.' },
];

function buildHelp(defaultServer) {
  const c = new ContainerBuilder();

  c.addTextDisplayComponents(text('## MC AFK Bot Commands'));
  c.addSeparatorComponents(thinDivider());

  const connLines = CONNECTION_COMMANDS
    .map((cmd) => `\`${cmd.usage}\` — ${cmd.desc}`)
    .join('\n');

  const playLines = GAMEPLAY_COMMANDS
    .map((cmd) => `\`${cmd.usage}\` — ${cmd.desc}`)
    .join('\n');

  const defaultLine = defaultServer
    ? `\n\n**Default Server:** \`${defaultServer.host}:${defaultServer.port}\` (${defaultServer.edition === 'java' ? 'Java' : 'Bedrock'})`
    : '\n\n**Tip:** Run `!setserver <ip[:port]>` once so you can just type `!join AFKBot`, `!follow Asto`, or `!play`!';

  c.addTextDisplayComponents(
    text(
      '**Minecraft Bedrock (26.60) & Java AFK + Gameplay Bot**' +
      defaultLine +
      '\n\n**Setup & Connection:**\n' +
      connLines +
      '\n\n**Gameplay & Actions:**\n' +
      playLines
    )
  );

  c.addSeparatorComponents(thinDivider());

  c.addTextDisplayComponents(
    text(
      '-# Wrap spaced gamertags in `"quotes"`, e.g. `!follow "Player Name"`. Multiple bots? Pass `<botName>` first, e.g. `!follow Bot2 Asto`.'
    )
  );

  c.addSeparatorComponents(thinDivider());
  c.addTextDisplayComponents(text('**Made by Asto**'));

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Per-user command rate limiting ───────────────────────────────────────────

const COOLDOWN_MS = 1_500;
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

// Parse `[ip] [botUsername]` for single-bot commands (!leave, !jump, !sneak, !coords, !stop, !spin, !players)
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

// Parse `[botUsername] [on|off]` for mode toggles (!play, !dance)
function resolveModeToggleArgs(args) {
  const MODE_WORDS = new Set(['on', 'off', 'stop', 'afk']);
  if (!args[1]) {
    return { host: null, username: null, modeArg: null };
  }
  if (MODE_WORDS.has(args[1].toLowerCase()) && !args[2]) {
    return { host: null, username: null, modeArg: args[1].toLowerCase() };
  }
  if (looksLikeServerAddress(args[1])) {
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return { error: 'invalid server address' };
    return { host: parsed.host, username: args[2] || null, modeArg: args[3] || null };
  }
  return { host: null, username: args[1], modeArg: args[2] || null };
}

// Parse `[[ip] <botUsername>] [targetPlayer]` for player-targeted commands (!follow, !come, !look, !circle, !hit)
function resolvePlayerTargetArgs(args, defaultHost) {
  if (!args[1]) {
    return { host: null, username: null, targetPlayer: null };
  }

  // Full syntax with server IP: `!follow <ip> <botUsername> [targetPlayer]`
  if (looksLikeServerAddress(args[1])) {
    const parsed = parseServerAddress(args[1], 19132);
    if (!parsed) return { error: 'invalid server address' };
    return {
      host: parsed.host,
      username: args[2] || null,
      targetPlayer: args[3] || null,
    };
  }

  // Two non-IP args: `!follow <botUsername> <targetPlayer>`
  if (args[2]) {
    return {
      host: null,
      username: args[1],
      targetPlayer: args[2],
    };
  }

  // Single non-IP arg: `!follow Asto` -> targetPlayer = 'Asto'
  // (Exception: if multiple bots are active and args[1] matches one of our bots' names, treat as bot selector)
  if (botManager.bots.size > 1) {
    const botMatch = botManager.findBotFlexible(args[1], null, defaultHost);
    if (botMatch.match) {
      return { host: null, username: args[1], targetPlayer: null };
    }
  }

  return { host: null, username: null, targetPlayer: args[1] };
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
  const modeLabel = bot.getModeLabel?.() || 'AFK';
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
      text(
        `**${name}** connected to **${bot.options.host}:${bot.options.port}**\n` +
        `-# ${verLine} · Mode: ${modeLabel}`
      )
    );
    c.addSeparatorComponents(thinDivider());
    c.addActionRowComponents(
      ...buildBotCardRows(bot.botId, {
        isOnline: bot.isOnline,
        isSneaking: bot.isSneaking,
        mode: bot.mode,
      })
    );
  }
  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const COMMAND_ALIASES = {
  '!setseerver': '!setserver',
  '!server': '!setserver',
  '!status': '!bots',
  '!stalk': '!follow',
  '!here': '!come',
  '!random': '!play',
  '!wander': '!play',
  '!roam': '!play',
  '!explore': '!play',
  '!watch': '!look',
  '!party': '!dance',
  '!twerk': '!dance',
  '!orbit': '!circle',
  '!afk': '!stop',
  '!idle': '!stop',
  '!stay': '!stop',
  '!punch': '!hit',
  '!attack': '!hit',
  '!wave': '!hit',
  '!nearby': '!players',
};

const KNOWN_COMMANDS = new Set([
  '!help',
  '!setserver',
  '!join',
  '!premjoin',
  '!leave',
  '!say',
  '!bots',
  '!jump',
  '!sneak',
  '!coords',
  '!follow',
  '!come',
  '!play',
  '!look',
  '!dance',
  '!circle',
  '!stop',
  '!hit',
  '!spin',
  '!players',
  ...Object.keys(COMMAND_ALIASES),
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

  const command = COMMAND_ALIASES[rawCmd] || rawCmd;

  if (isRateLimited(message.author.id)) {
    return message.reply(msg('-# Please wait a moment before sending another command.'));
  }

  const defaultServer = getDefaultServer(message.guild.id);
  const defaultHost = defaultServer?.host || null;

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
        `-# Now you can simply use \`!join AFKBot\`, \`!play\`, \`!follow <player>\`, \`!bots\`, and \`!leave\`.`,
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
    botManager.removeBot(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !say [<ip> <username> <msg> | <username> <msg> | <msg>]
  if (command === '!say') {
    if (!args[1]) {
      return message.reply(msg('usage: `!say [username] <message>` (or `!say <ip> <username> <message>`)'));
    }

    if (looksLikeServerAddress(args[1])) {
      if (!args[2] || !args[3]) {
        return message.reply(msg('usage: `!say <ip> <username> <message>`'));
      }
      const parsed = parseServerAddress(args[1], 19132);
      if (!parsed) return message.reply(msg('invalid server address'));
      const chatText = trimmed.slice(tokens[2].endIndex).trim();
      botManager.say(args[2], parsed.host, chatText, message.channel, defaultHost);
      return;
    }

    const namedLookup = botManager.findBotFlexible(args[1], null, defaultHost);
    if (namedLookup.match && args[2]) {
      const chatText = trimmed.slice(tokens[1].endIndex).trim();
      namedLookup.match.bot.say(chatText);
      return;
    }

    const singleLookup = botManager.findBotFlexible(null, null, defaultHost);
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

  // !players / !nearby
  if (command === '!players') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.players(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !play / !random / !wander / !roam
  if (command === '!play') {
    const target = resolveModeToggleArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.play(target.username, target.host, target.modeArg, message.channel, defaultHost);
    return;
  }

  // !dance / !party / !twerk
  if (command === '!dance') {
    const target = resolveModeToggleArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.dance(target.username, target.host, target.modeArg, message.channel, defaultHost);
    return;
  }

  // !stop / !afk / !idle / !stay
  if (command === '!stop') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.stopActivity(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !follow [player]
  if (command === '!follow') {
    if (args[1] && ['off', 'stop'].includes(args[1].toLowerCase()) && !args[2]) {
      botManager.stopActivity(null, null, message.channel, defaultHost);
      return;
    }
    const target = resolvePlayerTargetArgs(args, defaultHost);
    if (target.error) return message.reply(msg(target.error));
    botManager.follow(target.username, target.host, target.targetPlayer, message.channel, defaultHost);
    return;
  }

  // !come [player]
  if (command === '!come') {
    const target = resolvePlayerTargetArgs(args, defaultHost);
    if (target.error) return message.reply(msg(target.error));
    botManager.come(target.username, target.host, target.targetPlayer, message.channel, defaultHost);
    return;
  }

  // !look / !watch [player]
  if (command === '!look') {
    const target = resolvePlayerTargetArgs(args, defaultHost);
    if (target.error) return message.reply(msg(target.error));
    botManager.look(target.username, target.host, target.targetPlayer, message.channel, defaultHost);
    return;
  }

  // !circle / !orbit [player]
  if (command === '!circle') {
    const target = resolvePlayerTargetArgs(args, defaultHost);
    if (target.error) return message.reply(msg(target.error));
    botManager.circle(target.username, target.host, target.targetPlayer, message.channel, defaultHost);
    return;
  }

  // !hit / !punch / !wave [player]
  if (command === '!hit') {
    const target = resolvePlayerTargetArgs(args, defaultHost);
    if (target.error) return message.reply(msg(target.error));
    botManager.hit(target.username, target.host, target.targetPlayer, message.channel, defaultHost);
    return;
  }

  // !spin
  if (command === '!spin') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.spin(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !jump [username | <ip> <username>]
  if (command === '!jump') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.jump(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !sneak [username | <ip> <username>]
  if (command === '!sneak') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.sneak(target.username, target.host, message.channel, defaultHost);
    return;
  }

  // !coords [username | <ip> <username>]
  if (command === '!coords') {
    const target = resolveBotTargetArgs(args);
    if (target.error) return message.reply(msg(target.error));
    botManager.coords(target.username, target.host, message.channel, defaultHost);
    return;
  }
});

// ─── Interactive Button Handlers ──────────────────────────────────────────────

async function refreshPanelOrCard(interaction, bot, defaultServer) {
  if (isBotsPanelMessage(interaction.message)) {
    await interaction.update(botManager.getStatus(defaultServer));
  } else {
    await interaction.update(rebuildConnectedBotCard(bot, false));
  }
}

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

    if (action === 'play') {
      const res = bot.togglePlay({ silent: true });
      if (!res.ok) {
        await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
        return;
      }
      await refreshPanelOrCard(interaction, bot, defaultServer);
      return;
    }

    if (action === 'follow') {
      const res = bot.follow(null, { silent: true });
      if (!res.ok) {
        await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
        return;
      }
      await refreshPanelOrCard(interaction, bot, defaultServer);
      return;
    }

    if (action === 'dance') {
      const res = bot.toggleDance({ silent: true });
      if (!res.ok) {
        await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
        return;
      }
      await refreshPanelOrCard(interaction, bot, defaultServer);
      return;
    }

    if (action === 'stop') {
      bot.stopActivity({ silent: true });
      await refreshPanelOrCard(interaction, bot, defaultServer);
      return;
    }

    if (action === 'hit') {
      const res = bot.hit(null, { silent: true });
      await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'jump') {
      const res = bot.jump({ silent: true });
      await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'sneak') {
      const res = bot.toggleSneak({ silent: true });
      if (!res.ok) {
        await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
        return;
      }
      await refreshPanelOrCard(interaction, bot, defaultServer);
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
