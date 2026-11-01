// Made by Asto

import { isIP } from 'net';
import { ActivityType } from 'discord.js';
import { BedrockBot } from './BedrockBot.js';
import { MinecraftBot } from './MinecraftBot.js';
import {
  msg,
  ContainerBuilder,
  ButtonStyle,
  MessageFlags,
  thinDivider,
  thinSpacer,
  text,
  button,
  actionRow,
  buildBotControlRow,
} from './ui.js';

function normHost(host = '') {
  return String(host).trim().toLowerCase();
}

function normUser(user = '') {
  return String(user).trim().toLowerCase();
}

function makeBotKey(edition, username, host) {
  return `${edition}:${normUser(username)}@${normHost(host)}`;
}

const GENERIC_SUBDOMAINS = new Set([
  'play',
  'mc',
  'mco',
  'bedrock',
  'be',
  'pe',
  'java',
  'je',
  'join',
  'server',
  'hub',
  'lobby',
]);

// Strip IPs and domain suffixes so Discord status only shows the clean server name
// e.g. "RndmCraft.aternos.me" -> "RndmCraft", "play.randomcraft.net" -> "Randomcraft", "1.2.3.4" -> "Minecraft"
export function formatServerDisplayName(host = '') {
  const cleaned = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!cleaned || cleaned.toLowerCase() === 'localhost' || isIP(cleaned) !== 0) {
    return 'Minecraft';
  }

  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length === 0) return 'Minecraft';

  let label = parts[0];
  if (parts.length >= 3 && GENERIC_SUBDOMAINS.has(parts[0].toLowerCase())) {
    label = parts[1];
  }

  if (!label || /^\d+$/.test(label)) return 'Minecraft';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export class BotManager {
  constructor({ onChange } = {}) {
    this.bots = new Map();
    this._authPasswords = new Map();
    this._nextId = 1;
    this.onChange = onChange || null;
  }

  _notifyChange() {
    if (this.onChange) {
      try { this.onChange(); } catch {}
    }
  }

  _allocBotId() {
    return `b${this._nextId++}`;
  }

  _getAuthPassword(username, host) {
    const key = `${normUser(username)}@${normHost(host)}`;
    if (!this._authPasswords.has(key)) {
      this._authPasswords.set(key, Math.random().toString(36).slice(2, 12) + 'Aa1!');
    }
    return this._authPasswords.get(key);
  }

  _createBotInstance(edition, options, channel, onFatal, onRealUsername, authPassword) {
    if (edition === 'java') {
      return new MinecraftBot(options, channel, onFatal, onRealUsername, authPassword);
    }
    return new BedrockBot(options, channel, onFatal, onRealUsername, authPassword);
  }

  getBotById(botId) {
    for (const [key, bot] of this.bots.entries()) {
      if (bot.botId === botId) return { key, bot };
    }
    return null;
  }

  hasBotOnHost(username, host) {
    return Boolean(this._findBot(username, host));
  }

  _matchesUser(bot, u) {
    return (
      normUser(bot.realUsername) === u ||
      normUser(bot.options.username) === u ||
      normUser(bot.discordUserId) === u
    );
  }

  _findBot(username, host) {
    const h = normHost(host);
    const u = normUser(username);

    for (const [key, bot] of this.bots.entries()) {
      if (normHost(bot.options.host) !== h) continue;
      if (this._matchesUser(bot, u)) {
        return { key, bot };
      }
    }
    return null;
  }

  // Flexible lookup supporting omitted server IP (checks defaultHost first, then sole match)
  findBotFlexible(username, host, defaultHost = null) {
    if (host) {
      return { match: this._findBot(username, host), ambiguous: false };
    }

    if (!username) {
      if (this.bots.size === 1) {
        const [key, bot] = [...this.bots.entries()][0];
        return { match: { key, bot }, ambiguous: false };
      }
      if (defaultHost) {
        const onDefault = [...this.bots.entries()].filter(
          ([, b]) => normHost(b.options.host) === normHost(defaultHost)
        );
        if (onDefault.length === 1) {
          const [key, bot] = onDefault[0];
          return { match: { key, bot }, ambiguous: false };
        }
      }
      return { match: null, ambiguous: this.bots.size > 1 };
    }

    if (defaultHost) {
      const onDefault = this._findBot(username, defaultHost);
      if (onDefault) return { match: onDefault, ambiguous: false };
    }

    const u = normUser(username);
    const matches = [];
    for (const [key, bot] of this.bots.entries()) {
      if (this._matchesUser(bot, u)) {
        matches.push({ key, bot });
      }
    }

    if (matches.length === 1) return { match: matches[0], ambiguous: false };
    if (matches.length > 1) return { match: null, ambiguous: true };
    return { match: null, ambiguous: false };
  }

  // Join a cracked / offline-mode server (Bedrock or Java)
  joinCracked(options, channel) {
    const edition = options.edition === 'java' ? 'java' : 'bedrock';
    const port = options.port || (edition === 'java' ? 25565 : 19132);
    const key = makeBotKey(edition, options.username, options.host);

    if (this.bots.has(key) || this._findBot(options.username, options.host)) {
      return channel.send(msg(`**${options.username}** is already active on **${options.host}**`));
    }

    const authPassword = this._getAuthPassword(options.username, options.host);
    const editionLabel = edition === 'java' ? 'Java' : 'Bedrock';
    const botId = this._allocBotId();

    channel
      .send(msg(`Connecting **${options.username}** to **${options.host}:${port}** (${editionLabel})...`))
      .catch(() => {});

    let currentKey = key;
    const bot = this._createBotInstance(
      edition,
      {
        ...options,
        port,
        auth: 'offline',
        botId,
        onStateChange: () => this._notifyChange(),
      },
      channel,
      () => {
        this.bots.delete(currentKey);
        this._notifyChange();
      },
      (realUsername) => {
        const nextKey = makeBotKey(edition, realUsername, options.host);
        if (nextKey !== currentKey) {
          this.bots.delete(currentKey);
          currentKey = nextKey;
          this.bots.set(currentKey, bot);
        }
        this._notifyChange();
      },
      authPassword
    );

    this.bots.set(currentKey, bot);
    this._notifyChange();
    bot.connect().catch((err) => console.error('[BotManager] joinCracked connect error:', err));
  }

  // Join an online-mode server via Microsoft / Xbox Live account (Bedrock or Java)
  joinPremium(discordUserId, options, channel) {
    const edition = options.edition === 'java' ? 'java' : 'bedrock';
    const port = options.port || (edition === 'java' ? 25565 : 19132);
    const h = normHost(options.host);

    const alreadyRunning = [...this.bots.values()].some(
      (b) =>
        b.edition === edition &&
        normHost(b.options.host) === h &&
        (b.options.username === discordUserId || b.discordUserId === discordUserId)
    );
    if (alreadyRunning) {
      return channel.send(msg(`You already have a ${edition} premium bot on **${options.host}**`));
    }

    const editionLabel = edition === 'java' ? 'Java' : 'Bedrock';
    const botId = this._allocBotId();

    channel
      .send(msg(`Starting Microsoft login for **${options.host}:${port}** (${editionLabel})...`))
      .catch(() => {});

    let currentKey = `${edition}:msa:${discordUserId}@${h}`;

    const bot = this._createBotInstance(
      edition,
      {
        ...options,
        port,
        username: discordUserId,
        auth: 'microsoft',
        botId,
        onStateChange: () => this._notifyChange(),
      },
      channel,
      () => {
        this.bots.delete(currentKey);
        this._notifyChange();
      },
      (realUsername) => {
        this.bots.delete(currentKey);
        currentKey = makeBotKey(edition, realUsername, options.host);
        this.bots.set(currentKey, bot);
        this._notifyChange();
      }
    );

    bot.discordUserId = discordUserId;
    this.bots.set(currentKey, bot);
    this._notifyChange();
    bot.connect().catch((err) => console.error('[BotManager] joinPremium connect error:', err));
  }

  removeByEntry(found) {
    const displayName = found.bot.realUsername || found.bot.options.username;
    const host = found.bot.options.host;
    found.bot.stop();
    this.bots.delete(found.key);
    this._notifyChange();
    return { displayName, host };
  }

  removeBot(username, host, channel, defaultHost = null) {
    const { match, ambiguous } = this.findBotFlexible(username, host, defaultHost);
    if (match) {
      const { displayName, host: targetHost } = this.removeByEntry(match);
      return channel.send(msg(`**${displayName}** disconnected from **${targetHost}**`));
    }
    if (ambiguous) {
      return channel.send(msg('Multiple bots active — specify `!leave <username>` or `!leave <ip> <username>` (or `!leave all`)'));
    }
    if (this.bots.size === 0) {
      return channel.send(msg('no active bots to disconnect'));
    }
    const targetDesc = host ? ` on **${host}**` : '';
    return channel.send(msg(`no bot named **${username}**${targetDesc}`));
  }

  removeAllBots(channel) {
    if (this.bots.size === 0) {
      return channel.send(msg('no active bots'));
    }
    const count = this.bots.size;
    for (const bot of this.bots.values()) {
      bot.stop();
    }
    this.bots.clear();
    this._notifyChange();
    return channel.send(msg(`Disconnected **${count}** bot${count === 1 ? '' : 's'}`));
  }

  jump(username, host, channel, defaultHost = null) {
    const { match, ambiguous } = this.findBotFlexible(username, host, defaultHost);
    if (match) {
      match.bot.jump();
      return;
    }
    if (ambiguous) {
      channel.send(msg('Multiple bots active — specify `!jump <username>` or `!jump <ip> <username>`'));
      return;
    }
    channel.send(msg(username ? `no bot named **${username}**` : 'no active bots'));
  }

  sneak(username, host, channel, defaultHost = null) {
    const { match, ambiguous } = this.findBotFlexible(username, host, defaultHost);
    if (match) {
      match.bot.toggleSneak();
      return;
    }
    if (ambiguous) {
      channel.send(msg('Multiple bots active — specify `!sneak <username>` or `!sneak <ip> <username>`'));
      return;
    }
    channel.send(msg(username ? `no bot named **${username}**` : 'no active bots'));
  }

  formatCoordsText(bot) {
    const name = bot.realUsername || bot.options.username;
    const coords = bot.getCoords?.();
    const uptime = bot.getUptimeString?.();
    const editionLabel =
      bot.edition === 'java'
        ? `Java${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`
        : `Bedrock${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`;

    if (!bot.isOnline || !coords) {
      return `**${name}** — connecting to **${bot.options.host}:${bot.options.port}** (${editionLabel})`;
    }

    const sneakTag = bot.isSneaking ? ' · sneaking' : '';
    const upTag = uptime ? ` · uptime ${uptime}` : '';
    return (
      `**${name}** — \`X: ${coords.x}, Y: ${coords.y}, Z: ${coords.z}\`\n` +
      `-# ${bot.options.host}:${bot.options.port} · ${editionLabel}${upTag}${sneakTag}`
    );
  }

  coords(username, host, channel, defaultHost = null) {
    const { match, ambiguous } = this.findBotFlexible(username, host, defaultHost);
    if (match) {
      return channel.send(msg(this.formatCoordsText(match.bot)));
    }
    if (ambiguous) {
      return channel.send(msg('Multiple bots active — specify `!coords <username>` or `!coords <ip> <username>`'));
    }
    return channel.send(msg(username ? `no bot named **${username}**` : 'no active bots'));
  }

  say(username, host, chatText, channel, defaultHost = null) {
    const { match, ambiguous } = this.findBotFlexible(username, host, defaultHost);
    if (match) {
      match.bot.say(chatText);
      return;
    }
    if (ambiguous) {
      channel.send(msg('Multiple bots active — specify `!say <username> <message>` or `!say <ip> <username> <message>`'));
      return;
    }
    channel.send(msg(username ? `no bot named **${username}**` : 'no active bots'));
  }

  // Interactive Discord V2 status & control panel
  getStatus(defaultServer = null) {
    const c = new ContainerBuilder();

    const defaultFooterLine = defaultServer
      ? `Default server: **${defaultServer.host}:${defaultServer.port}** (${defaultServer.edition === 'java' ? 'Java' : 'Bedrock'})`
      : 'Tip: set a default server with `!setserver <ip[:port]>`';

    if (this.bots.size === 0) {
      c.addTextDisplayComponents(
        text(`**Active Bots**\n-# No bots currently running · ${defaultFooterLine}`)
      );

      if (defaultServer) {
        c.addSeparatorComponents(thinDivider());
        c.addActionRowComponents(
          actionRow(
            button('bot:quickjoin', 'Join AFKBot', ButtonStyle.Success),
            button('bot:refresh', 'Refresh', ButtonStyle.Secondary)
          )
        );
      }

      return { components: [c], flags: MessageFlags.IsComponentsV2 };
    }

    c.addTextDisplayComponents(text('**Active Bots**'));
    c.addSeparatorComponents(thinDivider());

    const allBots = [...this.bots.values()];
    const interactiveBots = allBots.slice(0, 4); // Reserve 1 row for bottom bar (Discord max 5 ActionRows)

    allBots.forEach((bot, idx) => {
      if (idx > 0) c.addSeparatorComponents(thinSpacer());

      const name = bot.realUsername || bot.options.username;
      const state = bot.isOnline ? 'online' : 'connecting';
      const editionLabel =
        bot.edition === 'java'
          ? `Java${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`
          : `Bedrock${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`;

      const coords = bot.getCoords?.();
      const uptime = bot.getUptimeString?.();
      const metaParts = [];
      if (coords) metaParts.push(`XYZ: \`${coords.x}, ${coords.y}, ${coords.z}\``);
      if (uptime) metaParts.push(`up ${uptime}`);
      if (bot.isSneaking) metaParts.push('sneaking');

      const metaLine = metaParts.length > 0 ? `\n-# ${metaParts.join(' · ')}` : '';
      c.addTextDisplayComponents(
        text(`**${name}** — ${bot.options.host}:${bot.options.port} (${editionLabel}) — **${state}**${metaLine}`)
      );

      if (idx < interactiveBots.length) {
        c.addActionRowComponents(
          buildBotControlRow(bot.botId, { isOnline: bot.isOnline, isSneaking: bot.isSneaking })
        );
      }
    });

    c.addSeparatorComponents(thinDivider());
    const onlineCount = allBots.filter((b) => b.isOnline).length;
    c.addTextDisplayComponents(
      text(
        `-# ${onlineCount}/${allBots.length} online · ${defaultFooterLine}`
      )
    );

    const bottomButtons = [button('bot:refresh', 'Refresh', ButtonStyle.Secondary)];
    if (defaultServer && !this.hasBotOnHost('AFKBot', defaultServer.host)) {
      bottomButtons.unshift(button('bot:quickjoin', 'Join AFKBot', ButtonStyle.Success));
    }
    if (allBots.length > 1) {
      bottomButtons.push(button('bot:leaveall', 'Leave All', ButtonStyle.Danger));
    }
    c.addActionRowComponents(actionRow(...bottomButtons));

    return { components: [c], flags: MessageFlags.IsComponentsV2 };
  }

  // Build live Discord bot profile status (never exposes raw IPs or domain suffixes)
  getPresenceData() {
    const allBots = [...this.bots.values()];
    const onlineBots = allBots.filter((b) => b.isOnline);

    if (onlineBots.length === 1) {
      const b = onlineBots[0];
      const name = b.realUsername || b.options.username;
      const serverName = formatServerDisplayName(b.options.host);
      return {
        status: 'online',
        activities: [
          {
            name: `${serverName} · ${name}`,
            type: ActivityType.Playing,
          },
        ],
      };
    }

    if (onlineBots.length > 1) {
      const serverNames = [...new Set(onlineBots.map((b) => formatServerDisplayName(b.options.host)))];
      const hostSummary =
        serverNames.length === 1 ? serverNames[0] : `${serverNames[0]} +${serverNames.length - 1}`;
      return {
        status: 'online',
        activities: [
          {
            name: `${hostSummary} · ${onlineBots.length} bots online`,
            type: ActivityType.Playing,
          },
        ],
      };
    }

    if (allBots.length > 0) {
      const b = allBots[0];
      const serverName = formatServerDisplayName(b.options.host);
      return {
        status: 'idle',
        activities: [
          {
            name: `Connecting to ${serverName}...`,
            type: ActivityType.Playing,
          },
        ],
      };
    }

    return {
      status: 'idle',
      activities: [
        {
          name: 'Admiring Asto',
          type: ActivityType.Custom,
        },
      ],
    };
  }
}
