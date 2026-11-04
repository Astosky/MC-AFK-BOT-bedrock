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
import {
  BOORU_SITES,
  resolveBooruSite,
  getBooruCredentials,
  parseCredentialInput,
  verifyBooruCredentials,
  setBooruCredentials,
  clearBooruCredentials,
  fetchBooruPosts,
  buildBooruMessagePayload,
  buildMissingKeyMessage,
} from './booruService.js';
import {
  BooruScheduler,
  getClockInTimezone,
  parseScheduleSpec,
} from './booruScheduler.js';

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
const booruScheduler = new BooruScheduler(client);

client.on('clientReady', () => {
  if (GUILD_ID) {
    console.log(`Discord bot logged in as ${client.user.tag} — restricted to guild ${GUILD_ID}`);
  } else {
    console.log(`Discord bot logged in as ${client.user.tag} — active in all servers`);
  }
  syncDiscordPresence();
  syncBotApplicationBio();
  booruScheduler.start();
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

const MEDIA_COMMANDS = [
  { usage: '!gelbooru [tags...]',                  desc: 'Fetch & upload from Gelbooru (also `!gelbouru`, `!gel`).' },
  { usage: '!r34 [tags...]',                       desc: 'Fetch & upload from Rule34 (`!rule34`).' },
  { usage: '!safebooru / !danbooru [tags...]',     desc: 'Keyless fetch & upload from Safebooru or Danbooru.' },
  { usage: '!autopost <site> <HH:MM|every Xh> [tags]', desc: 'Auto-upload daily at a set time or interval (`!autopost` to manage).' },
  { usage: '!boorukey <gelbooru|r34> <id> <key>',  desc: 'Save your free Gelbooru / Rule34 API credentials.' },
];

function buildHelp(defaultServer) {
  const c = new ContainerBuilder();

  c.addTextDisplayComponents(text('## Bot Commands'));
  c.addSeparatorComponents(thinDivider());

  const connLines = CONNECTION_COMMANDS
    .map((cmd) => `\`${cmd.usage}\` — ${cmd.desc}`)
    .join('\n');

  const playLines = GAMEPLAY_COMMANDS
    .map((cmd) => `\`${cmd.usage}\` — ${cmd.desc}`)
    .join('\n');

  const mediaLines = MEDIA_COMMANDS
    .map((cmd) => `\`${cmd.usage}\` — ${cmd.desc}`)
    .join('\n');

  const defaultLine = defaultServer
    ? `\n\n**Default Server:** \`${defaultServer.host}:${defaultServer.port}\` (${defaultServer.edition === 'java' ? 'Java' : 'Bedrock'})`
    : '\n\n**Tip:** Run `!setserver <ip[:port]>` once so you can just type `!join AFKBot`, `!follow Asto`, or `!play`!';

  c.addTextDisplayComponents(
    text(
      '**Minecraft Bedrock (26.60) & Java AFK + Auto-Upload Bot**' +
      defaultLine +
      '\n\n**Setup & Connection:**\n' +
      connLines +
      '\n\n**Gameplay & Actions:**\n' +
      playLines +
      '\n\n**Booru Fetch & Scheduled Auto-Uploads:**\n' +
      mediaLines
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

const COOLDOWN_MS = 750;
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
  '!gelbouru': '!gelbooru',
  '!gelborou': '!gelbooru',
  '!gelboru': '!gelbooru',
  '!gel': '!gelbooru',
  '!rule34': '!r34',
  '!safe': '!safebooru',
  '!dan': '!danbooru',
  '!kona': '!konachan',
  '!yan': '!yandere',
  '!autoupload': '!autopost',
  '!schedule': '!autopost',
  '!daily': '!autopost',
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
  '!booru',
  '!gelbooru',
  '!r34',
  '!safebooru',
  '!danbooru',
  '!konachan',
  '!yandere',
  '!boorukey',
  '!autopost',
  ...Object.keys(COMMAND_ALIASES),
]);

function extractCountAndTags(rawList = []) {
  let count = 1;
  const tags = [];
  for (const item of rawList) {
    const m = String(item).match(/^(?:x|count:)([1-5])$/i);
    if (m) {
      count = Number(m[1]);
    } else {
      tags.push(item);
    }
  }
  return { count, tags };
}

async function handleBooruFetchCommand(message, siteInput, rawTagTokens) {
  const { count, tags } = extractCountAndTags(rawTagTokens);

  try {
    await message.channel.sendTyping?.().catch(() => {});
    const result = await fetchBooruPosts({
      siteInput,
      rawTags: tags,
      allowNsfw: true,
      count,
      guildId: message.guild.id,
    });

    if (result.posts.length === 0) {
      return await message.reply(
        msg(
          `No matching posts found on **${result.site.label}** for \`${tags.join(' ') || 'random'}\`.`
        )
      );
    }

    const payload = await buildBooruMessagePayload({
      site: result.site,
      posts: result.posts,
      usedTags: result.usedTags,
      includeNextButton: true,
    });

    try {
      return await message.reply(payload);
    } catch {
      // Fallback if Discord cannot unfurl an external URL inside V2 MediaGallery
      const first = result.posts[0];
      const fallbackOpts = {
        content: `**${result.site.label}** · \`${result.usedTags.join(' ') || 'random'}\`\n<${first.pageUrl}>`,
      };
      if (payload.files?.length) {
        fallbackOpts.files = payload.files;
      } else {
        fallbackOpts.content += `\n${first.fileUrl}`;
      }
      return await message.reply(fallbackOpts);
    }
  } catch (err) {
    if (err?.missingAuth && err.site) {
      return await message.reply(msg(buildMissingKeyMessage(err.site))).catch(() => {});
    }
    return await message.reply(msg(err?.message || 'Failed to fetch posts right now.')).catch(() => {});
  }
}

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

  // !gelbooru / !r34 / !safebooru / !danbooru / !konachan / !yandere [tags...]
  if (
    command === '!gelbooru' ||
    command === '!r34' ||
    command === '!safebooru' ||
    command === '!danbooru' ||
    command === '!konachan' ||
    command === '!yandere'
  ) {
    const siteId = command.slice(1);
    await handleBooruFetchCommand(message, siteId, args.slice(1));
    return;
  }

  // !booru <site> [tags...]
  if (command === '!booru') {
    if (!args[1]) {
      return message.reply(
        msg(
          'usage: `!booru <gelbooru|r34|safebooru|konachan|yandere|danbooru> [tags...]`\n' +
          '-# Or use shortcuts directly: `!gelbooru`, `!r34`, `!safebooru`, `!konachan`, `!yandere` *(add `x3` for multiple images)*'
        )
      );
    }
    const site = resolveBooruSite(args[1]);
    if (!site) {
      return message.reply(
        msg('Unknown site — choose `gelbooru`, `r34`, `safebooru`, `konachan`, `yandere`, or `danbooru`.')
      );
    }
    await handleBooruFetchCommand(message, site, args.slice(2));
    return;
  }

  // !boorukey [<site> <user_id> <api_key> | clear <site>]
  if (command === '!boorukey') {
    if (!args[1]) {
      const gelStatus = getBooruCredentials('gelbooru') ? 'Configured' : 'Not set';
      const r34Status = getBooruCredentials('r34') ? 'Configured' : 'Not set';
      return message.reply(
        msg(
          `**Booru API Keys**\n` +
          `• **Gelbooru:** ${gelStatus} — <${BOORU_SITES.gelbooru.keyHelpUrl}>\n` +
          `• **Rule34:** ${r34Status} — <${BOORU_SITES.r34.keyHelpUrl}>\n` +
          `• **Safebooru / Konachan / Yande.re / Danbooru:** Ready *(no key needed)*\n\n` +
          `-# Save a key: \`!boorukey <gelbooru|r34> &api_key=YOUR_KEY&user_id=YOUR_ID_NUMBER\``
        )
      );
    }

    if (args[1].toLowerCase() === 'clear' && args[2]) {
      const targetSite = resolveBooruSite(args[2]);
      if (!targetSite) return message.reply(msg('Unknown site (`gelbooru` or `r34`).'));
      clearBooruCredentials(targetSite.id);
      return message.reply(msg(`Cleared saved API credentials for **${targetSite.label}**.`));
    }

    const site = resolveBooruSite(args[1]);
    if (!site || !site.requiresKey) {
      return message.reply(
        msg('Specify `gelbooru` or `r34`: `!boorukey <gelbooru|r34> &api_key=YOUR_KEY&user_id=YOUR_ID_NUMBER`')
      );
    }

    const creds = parseCredentialInput(args.slice(2));
    if (creds.error === 'empty_api_key') {
      const uidHint = creds.partialUserId || '7006715';
      return message.reply(
        msg(
          `**Your \`api_key=\` is currently blank** (you pasted \`&api_key=&user_id=${uidHint}\`)!\n\n` +
          `**How to generate your key on ${site.label}:**\n` +
          `1. Open <${site.keyHelpUrl}>\n` +
          `2. Scroll down to **API Access Credentials**\n` +
          `3. **Check the box \`Generate New Key?\`**\n` +
          `4. Scroll all the way down and click **Save**\n` +
          `5. Open <${site.keyHelpUrl}> again — now there will be a long code after \`api_key=\`! Copy it and run:\n` +
          `   \`!boorukey ${site.id} &api_key=YOUR_LONG_CODE&user_id=${uidHint}\``
        )
      );
    }

    if (creds.error === 'non_numeric_user_id') {
      return message.reply(
        msg(
          `**\`user_id\` must be your numeric ID** (like \`7006715\`), not your username!\n` +
          `-# Example: \`!boorukey ${site.id} &api_key=YOUR_LONG_CODE&user_id=7006715\``
        )
      );
    }

    if (creds.error) {
      return message.reply(msg(buildMissingKeyMessage(site)));
    }

    // Delete command message to keep user's API key private in chat
    message.delete().catch(() => {});

    const check = await verifyBooruCredentials(site, creds);
    if (!check.ok) {
      return message.channel.send(msg(check.reason));
    }

    setBooruCredentials(site.id, creds);

    return message.channel.send(
      msg(
        `Verified & saved **${site.label}** API key (User ID \`${creds.userId}\`)!\n` +
        `-# Try \`!${site.id}\` now, or schedule daily uploads with \`!autopost ${site.id} 18:00 [tags]\`.`
      )
    );
  }

  // !autopost / !autoupload / !schedule / !daily
  if (command === '!autopost') {
    const sub = args[1]?.toLowerCase();

    if (!sub || sub === 'list' || sub === 'status') {
      return message.reply(booruScheduler.buildSchedulesPanel(message.guild.id));
    }

    if (sub === 'tz' || sub === 'timezone') {
      const tzArg = args[2];
      if (!tzArg) {
        const currentTz = booruScheduler.getGuildTimezone(message.guild.id);
        const clock = getClockInTimezone(currentTz);
        return message.reply(
          msg(
            `**Current Timezone:** \`${clock.timezone}\` (Current bot clock: **${clock.formattedTime}**)\n` +
            `-# Change with \`!autopost tz Africa/Algiers\`, \`!autopost tz UTC+1\`, \`!autopost tz Europe/Paris\`, etc.`
          )
        );
      }
      const ok = booruScheduler.setGuildTimezone(message.guild.id, tzArg);
      if (!ok) {
        return message.reply(
          msg('Invalid timezone — examples: `Africa/Algiers`, `Europe/Paris`, `UTC+1`, `UTC-5`, `UTC`.')
        );
      }
      const clock = getClockInTimezone(tzArg);
      return message.reply(
        msg(`Timezone updated to **${clock.timezone}** — current clock time is **${clock.formattedTime}**.`)
      );
    }

    if (['remove', 'del', 'delete', 'stop', 'clear'].includes(sub)) {
      const idArg = sub === 'clear' && !args[2] ? 'all' : args[2];
      if (!idArg) {
        return message.reply(msg('usage: `!autopost remove <id | all>`'));
      }
      const res = booruScheduler.removeSchedule(message.guild.id, idArg);
      if (res.removed === 0) {
        return message.reply(msg(res.all ? 'No active auto-upload schedules.' : `No schedule found with ID **#${idArg}**.`));
      }
      return message.reply(
        msg(
          res.all
            ? `Removed all **${res.removed}** auto-upload schedule${res.removed === 1 ? '' : 's'}.`
            : `Removed schedule **#${res.deleted.id}** (**${res.deleted.siteLabel}**).`
        )
      );
    }

    if (sub === 'now' || sub === 'test' || sub === 'run') {
      const schedules = booruScheduler.getGuildSchedules(message.guild.id);
      const targetSched = args[2]
        ? booruScheduler.getScheduleById(message.guild.id, args[2].replace(/^#/, ''))
        : schedules.length === 1
          ? schedules[0]
          : null;

      if (!targetSched) {
        return message.reply(
          msg(
            schedules.length === 0
              ? 'No active schedules yet — create one with `!autopost <site> <HH:MM> [tags]`.'
              : 'Specify which schedule ID to run: `!autopost now <id>` (check `!autopost` for IDs).'
          )
        );
      }

      await message.channel.sendTyping?.().catch(() => {});
      const runRes = await booruScheduler.triggerScheduleNow(targetSched, { manual: true });
      if (!runRes.ok) {
        return message.reply(msg(`Could not trigger **#${targetSched.id}**: ${runRes.error}`));
      }
      return;
    }

    // Add schedule: `!autopost [add] <site> <time | daily | every Xh> [tags...]`
    const offset = sub === 'add' ? 2 : 1;
    const siteToken = args[offset];
    const site = resolveBooruSite(siteToken);
    if (!site) {
      return message.reply(
        msg(
          'usage: `!autopost <gelbooru|r34|safebooru|danbooru> <HH:MM | daily | every 6h> [tags...]`\n' +
          '-# Examples:\n' +
          '-# • `!autopost gelbooru 18:00 blue_archive`\n' +
          '-# • `!autopost r34 22:30 x2 overwatch`\n' +
          '-# • `!autopost safebooru every 6h hatsune_miku`'
        )
      );
    }

    const tz = booruScheduler.getGuildTimezone(message.guild.id);
    const currentClock = getClockInTimezone(tz);
    const remainingTokens = args.slice(offset + 1);
    const spec = parseScheduleSpec(remainingTokens, currentClock);

    if (!spec) {
      return message.reply(
        msg(
          `Specify when to auto-upload (e.g. \`18:00\`, \`8:30pm\`, \`daily\`, or \`every 6h\`):\n` +
          `-# Example: \`!autopost ${site.id} 18:00 [tags...]\` *(current bot clock: **${currentClock.formattedTime}** ${currentClock.timezone})*`
        )
      );
    }

    const { count, tags } = extractCountAndTags(remainingTokens.slice(spec.consumed));
    const created = booruScheduler.addSchedule({
      guildId: message.guild.id,
      channelId: message.channel.id,
      siteInput: site.id,
      mode: spec.mode,
      time: spec.time || null,
      intervalMinutes: spec.intervalMinutes || null,
      rawTags: tags,
      count,
      allowNsfw: true,
    });

    if (!created.ok) {
      return message.reply(msg(created.error));
    }

    const s = created.schedule;
    const whenDesc =
      s.mode === 'daily'
        ? `every day at **${s.time}** (${created.clock.timezone})`
        : `every **${s.intervalMinutes >= 60 && s.intervalMinutes % 60 === 0 ? `${s.intervalMinutes / 60}h` : `${s.intervalMinutes}m`}**`;
    const tagDesc = s.tags.length > 0 ? `\`${s.tags.join(' ')}\`` : '`random`';
    const keyWarning =
      site.requiresKey && !getBooruCredentials(site.id)
        ? `\n\n-# Don't forget to set your ${site.label} API key once with \`!boorukey ${site.id} <user_id> <api_key>\`!`
        : '';

    return message.reply(
      msgWithButtons(
        `Scheduled **#${s.id}** — **${site.label}** (${tagDesc}${s.count > 1 ? ` ×${s.count}` : ''})\n` +
        `-# Auto-uploading in <#${s.channelId}> ${whenDesc} · Current bot clock: **${created.clock.formattedTime}**` +
        keyWarning,
        button(`autopost:now:${s.id}`, 'Post Now (Test)', ButtonStyle.Primary),
        button(`autopost:del:${s.id}`, 'Cancel Schedule', ButtonStyle.Danger)
      )
    );
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

  // ─── Booru & Auto-Upload Interactive Buttons ──────────────────────────────
  if (customId.startsWith('booru:next:')) {
    try {
      const rest = customId.slice('booru:next:'.length);
      const colonIdx = rest.indexOf(':');
      const siteId = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
      const rawTagPart = colonIdx === -1 ? '' : rest.slice(colonIdx + 1);
      const tagStr = rawTagPart === '_' ? '' : rawTagPart;
      const rawTags = tagStr ? tagStr.split(/\s+/).filter(Boolean) : [];

      await interaction.deferReply();
      const result = await fetchBooruPosts({
        siteInput: siteId,
        rawTags,
        allowNsfw: true,
        count: 1,
        guildId: interaction.guildId,
      });

      if (result.posts.length === 0) {
        await interaction.editReply(msg(`No more matching posts found on **${result.site.label}**.`));
        return;
      }

      const payload = await buildBooruMessagePayload({
        site: result.site,
        posts: result.posts,
        usedTags: result.usedTags,
        includeNextButton: true,
      });
      await interaction.editReply(payload);
    } catch (err) {
      const errText = err?.missingAuth && err.site ? buildMissingKeyMessage(err.site) : (err?.message || 'Failed to fetch.');
      if (interaction.deferred) {
        await interaction.editReply(msg(errText)).catch(() => {});
      } else {
        await interaction.reply({ content: errText, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }

  if (customId.startsWith('autopost:')) {
    try {
      const [, apAction, schedId] = customId.split(':');
      if (apAction === 'del') {
        booruScheduler.removeSchedule(interaction.guildId, schedId);
        await interaction.update(booruScheduler.buildSchedulesPanel(interaction.guildId));
        return;
      }
      if (apAction === 'now') {
        const sched = booruScheduler.getScheduleById(interaction.guildId, schedId);
        if (!sched) {
          await interaction.reply({ content: `Schedule #${schedId} no longer exists.`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await booruScheduler.triggerScheduleNow(sched, { manual: true });
        await interaction.editReply({
          content: res.ok ? `Uploaded post for schedule **#${sched.id}**!` : `Failed: ${res.error}`,
        });
        return;
      }
    } catch (err) {
      console.error('[Autopost Button Error]', err);
    }
    return;
  }

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
