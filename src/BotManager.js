// Made by Ayliee, All rights are reserved to AeroX Development

import { BedrockBot } from './BedrockBot.js';
import { MinecraftBot } from './MinecraftBot.js';
import { msg, msgList } from './ui.js';

function normHost(host = '') {
  return String(host).trim().toLowerCase();
}

function normUser(user = '') {
  return String(user).trim().toLowerCase();
}

function makeBotKey(edition, username, host) {
  return `${edition}:${normUser(username)}@${normHost(host)}`;
}

export class BotManager {
  constructor() {
    this.bots = new Map();
    this._authPasswords = new Map();
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

  _findBot(username, host) {
    const h = normHost(host);
    const u = normUser(username);

    for (const [key, bot] of this.bots.entries()) {
      if (normHost(bot.options.host) !== h) continue;
      if (
        normUser(bot.realUsername) === u ||
        normUser(bot.options.username) === u ||
        normUser(bot.discordUserId) === u
      ) {
        return { key, bot };
      }
    }
    return null;
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

    channel
      .send(msg(`Connecting **${options.username}** to **${options.host}:${port}** (${editionLabel})...`))
      .catch(() => {});

    let currentKey = key;
    const bot = this._createBotInstance(
      edition,
      { ...options, port, auth: 'offline' },
      channel,
      () => this.bots.delete(currentKey),
      (realUsername) => {
        const nextKey = makeBotKey(edition, realUsername, options.host);
        if (nextKey !== currentKey) {
          this.bots.delete(currentKey);
          currentKey = nextKey;
          this.bots.set(currentKey, bot);
        }
      },
      authPassword
    );

    this.bots.set(currentKey, bot);
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
    channel
      .send(msg(`Starting Microsoft login for **${options.host}:${port}** (${editionLabel})...`))
      .catch(() => {});

    let currentKey = `${edition}:msa:${discordUserId}@${h}`;

    const bot = this._createBotInstance(
      edition,
      { ...options, port, username: discordUserId, auth: 'microsoft' },
      channel,
      () => this.bots.delete(currentKey),
      (realUsername) => {
        this.bots.delete(currentKey);
        currentKey = makeBotKey(edition, realUsername, options.host);
        this.bots.set(currentKey, bot);
      }
    );

    bot.discordUserId = discordUserId;
    this.bots.set(currentKey, bot);
    bot.connect().catch((err) => console.error('[BotManager] joinPremium connect error:', err));
  }

  removeBot(username, host, channel) {
    const found = this._findBot(username, host);
    if (found) {
      const displayName = found.bot.realUsername || username;
      found.bot.stop();
      this.bots.delete(found.key);
      return channel.send(msg(`**${displayName}** disconnected from **${host}**`));
    }
    return channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  jump(username, host, channel) {
    const found = this._findBot(username, host);
    if (found) {
      found.bot.jump();
      return;
    }
    channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  say(username, host, text, channel) {
    const found = this._findBot(username, host);
    if (found) {
      found.bot.say(text);
      return;
    }
    channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  getStatus() {
    if (this.bots.size === 0) {
      return msg('no active bots');
    }

    const rows = [...this.bots.values()].map((bot) => {
      const name = bot.realUsername || bot.options.username;
      const state = bot.isOnline ? 'online' : 'connecting';
      const editionLabel =
        bot.edition === 'java'
          ? `Java${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`
          : `Bedrock${bot.serverVersion ? ` ${bot.serverVersion}` : ''}`;
      return `**${name}** — ${bot.options.host}:${bot.options.port} (${editionLabel}) — ${state}`;
    });

    const count = rows.length;
    return msgList(
      '**Active Bots**',
      rows,
      `-# ${count} bot${count === 1 ? '' : 's'} running`
    );
  }
}
