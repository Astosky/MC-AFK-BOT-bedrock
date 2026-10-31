// Made by Ayliee, All rights are reserved to AeroX Development

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mineflayer from 'mineflayer';
import { msg, msgSections } from './ui.js';

const FATAL_CODES = new Set(['ENOTFOUND']);
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 15_000;
const ANTI_AFK_INTERVAL_MS = 5_000;
const MC_CHAT_LIMIT = 256;

// Local auth cache stored next to the bot files — works in any environment
// including headless servers and Pterodactyl containers (no Minecraft client needed)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');
fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

// Auth-plugin prompt patterns (AuthMe, nLogin, FastLogin, etc.)
const REGISTER_PATTERNS = [
  /\/register/i,
  /please register/i,
  /you must register/i,
  /register to (play|continue)/i,
  /use \/reg/i,
];
const LOGIN_PATTERNS = [
  /\/(login|l) /i,
  /please (log\s?in|authenticate)/i,
  /you must (log\s?in|authenticate)/i,
  /use \/log/i,
];

function extractText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  let t = node.text || node.translate || '';
  if (Array.isArray(node.extra)) t += node.extra.map(extractText).join('');
  if (Array.isArray(node.with)) t += node.with.map(extractText).join('');
  return t;
}

function parseKickReason(reason) {
  if (!reason) return 'Disconnected';
  if (typeof reason === 'object') {
    return extractText(reason).trim() || JSON.stringify(reason);
  }
  try {
    return extractText(JSON.parse(reason)).trim() || reason;
  } catch {
    return String(reason);
  }
}

export class MinecraftBot {
  /**
   * @param {object}   options          mineflayer createBot options (host, port, username, auth)
   * @param {object}   discordChannel   Discord TextChannel to send status messages to
   * @param {Function} onFatal          called when the bot permanently fails and is removed
   * @param {Function} onRealUsername   called with the real MC username after first spawn
   * @param {string}   [authPassword]   optional stable password injected by BotManager (cracked bots)
   */
  constructor(options, discordChannel, onFatal, onRealUsername, authPassword) {
    this.edition = 'java';
    this.options = { ...options, port: options.port || 25565 };
    this.discordChannel = discordChannel;
    this.onFatal = onFatal;
    this.onRealUsername = onRealUsername;
    this.bot = null;
    this.jumpInterval = null;
    this.lookInterval = null;
    this.reconnectTimeout = null;
    this.isStopping = false;
    this.isFatal = false;
    this.isDisconnecting = false;
    this.reconnectAttempts = 0;
    this.spawnedOnce = false;
    this.realUsername = null;
    this.serverVersion = null;
    this.lastErrorReason = null;

    this.authPassword = authPassword || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  get isOnline() {
    return Boolean(this.bot?.entity);
  }

  // Safely send a V2 container message to Discord; swallows channel errors
  send(content) {
    this.discordChannel.send(content).catch(() => {});
  }

  // ─── Microsoft pre-authentication ────────────────────────────────────────────

  async _preAuth() {
    try {
      const { default: prismarineAuth } = await import('prismarine-auth');
      const { Authflow, Titles } = prismarineAuth;

      const authOptions = {
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
        flow: 'live',
      };

      const flow = new Authflow(
        this.options.username,  // Discord user ID — stable unique cache key
        MS_CACHE_DIR,           // Shared cache directory passed to mineflayer as profilesFolder
        authOptions,
        (data) => {
          const mins = Math.floor((data.expires_in || 900) / 60);
          this.send(
            msgSections(
              `Microsoft login required — **${this.options.host}**`,
              `Open: <${data.verification_uri}>\n\nCode: \`${data.user_code}\``,
              `-# Expires in ${mins} min. Bot joins Java automatically after sign-in.`
            )
          );
        }
      );

      await flow.getMinecraftJavaToken({ fetchProfile: false });
      return true;
    } catch (err) {
      if (!this.isFatal && !this.isStopping) {
        this.isFatal = true;
        this.send(
          msg(`Microsoft authentication failed\n-# ${err.message || String(err)} · bot removed`)
        );
        if (this.onFatal) this.onFatal();
      }
      return false;
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────────────

  async connect() {
    if (this.isStopping || this.isFatal) return;

    this.isDisconnecting = false;
    this.lastErrorReason = null;

    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch {}
      this.bot = null;
    }

    if (this.options.auth === 'microsoft') {
      const ok = await this._preAuth();
      if (!ok) return;
    }

    if (this.isStopping || this.isFatal) return;

    const botOptions = {
      host: this.options.host,
      port: this.options.port || 25565,
      username: this.options.username,
      auth: this.options.auth || 'offline',
      profilesFolder: MS_CACHE_DIR,
      version: this.options.version || false,
      hideErrors: true,
    };

    this.bot = mineflayer.createBot(botOptions);

    this.bot.on('spawn', () => {
      if (this.isStopping || this.isFatal) return;

      this.reconnectAttempts = 0;
      this.isDisconnecting = false;
      this.lastErrorReason = null;
      const name = this.bot.username;
      this.realUsername = name;
      this.serverVersion = this.bot.version || this.bot._client?.version || null;

      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      const verTag = this.serverVersion ? `Java ${this.serverVersion}` : 'Java';
      this.send(
        msg(`**${name}** connected to **${this.options.host}:${this.options.port}**\n-# ${verTag}`)
      );
      this.startAntiAfk();
    });

    // Intercept all server chat — catches AuthMe, nLogin, FastLogin prompts
    this.bot.on('messagestr', (raw) => {
      if (!this.bot || this.isStopping) return;
      const t = raw.toLowerCase();

      if (REGISTER_PATTERNS.some((p) => p.test(t))) {
        setTimeout(() => {
          if (this.bot && !this.isStopping) {
            this.bot.chat(`/register ${this.authPassword} ${this.authPassword}`);
          }
        }, 800);
        return;
      }

      if (LOGIN_PATTERNS.some((p) => p.test(t))) {
        setTimeout(() => {
          if (this.bot && !this.isStopping) {
            this.bot.chat(`/login ${this.authPassword}`);
          }
        }, 800);
      }
    });

    // Chat relay — plain text to avoid rate-limiting on high-traffic servers
    this.bot.on('chat', (username, chatMessage) => {
      if (!this.bot || username === this.bot.username) return;
      this.discordChannel
        .send(`\`${this.bot.username}\` **${username}:** ${chatMessage}`)
        .catch(() => {});
    });

    this.bot.on('error', (err) => {
      if (this.isStopping || this.isFatal) return;
      if (FATAL_CODES.has(err.code)) {
        this.isFatal = true;
        const name = this.realUsername || this.options.username;
        this.send(
          msg(`**${name}** — unknown host **${this.options.host}**\n-# ${err.code} · bot removed`)
        );
        this.stop();
        if (this.onFatal) this.onFatal();
        return;
      }
      this.lastErrorReason = err.code || err.message || String(err);
    });

    this.bot.on('kicked', (reason) => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      this.isDisconnecting = true;
      const name = this.bot?.username || this.realUsername || this.options.username;
      const readable = parseKickReason(reason);
      this.lastErrorReason = readable;
      this.send(
        msgSections(
          `**${name}** kicked from **${this.options.host}**`,
          `-# ${readable}`
        )
      );
      this.handleDisconnect();
    });

    this.bot.on('end', (reason) => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      this.isDisconnecting = true;
      if (!this.lastErrorReason && reason) this.lastErrorReason = String(reason);
      this.handleDisconnect();
    });
  }

  handleDisconnect() {
    if (this.isStopping || this.isFatal) return;
    this.stopAntiAfk();

    const name = this.realUsername || this.options.username;

    if (this.reconnectAttempts >= MAX_RECONNECTS) {
      const reasonSuffix = this.lastErrorReason ? `\n-# Last error: ${this.lastErrorReason}` : '';
      this.send(
        msg(
          `**${name}** — max reconnects reached on **${this.options.host}**\n-# removed after ${MAX_RECONNECTS} failed attempts${reasonSuffix}`
        )
      );
      this.stop();
      if (this.onFatal) this.onFatal();
      return;
    }

    this.reconnectAttempts++;
    const delaySec = RECONNECT_DELAY_MS / 1000;
    const reasonLine = this.lastErrorReason ? ` · ${this.lastErrorReason}` : '';
    this.send(
      msg(
        `**${name}** — reconnecting to **${this.options.host}:${this.options.port}**\n-# attempt ${this.reconnectAttempts}/${MAX_RECONNECTS} · in ${delaySec}s${reasonLine}`
      )
    );

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect().catch(() => {}), RECONNECT_DELAY_MS);
  }

  startAntiAfk() {
    this.stopAntiAfk();

    // Jump every 5 seconds to prevent AFK kick
    this.jumpInterval = setInterval(() => {
      if (this.bot?.entity) {
        this.bot.setControlState('jump', true);
        setTimeout(() => { if (this.bot) this.bot.setControlState('jump', false); }, 400);
      }
    }, ANTI_AFK_INTERVAL_MS);

    // Rotate view every 30 seconds to simulate an active player
    this.lookInterval = setInterval(() => {
      if (this.bot?.entity) {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 1.0;
        this.bot.look(yaw, pitch, false);
      }
    }, 30_000);
  }

  stopAntiAfk() {
    if (this.jumpInterval) { clearInterval(this.jumpInterval); this.jumpInterval = null; }
    if (this.lookInterval) { clearInterval(this.lookInterval); this.lookInterval = null; }
  }

  jump() {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      this.send(msg(`**${name}** — not in-game, cannot jump`));
      return;
    }
    this.bot.setControlState('jump', true);
    setTimeout(() => { if (this.bot) this.bot.setControlState('jump', false); }, 400);
    this.send(msg(`**${name}** jumped`));
  }

  say(text) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      this.send(msg(`**${name}** — not in-game, cannot send message`));
      return;
    }
    const truncated = text.length > MC_CHAT_LIMIT ? text.slice(0, MC_CHAT_LIMIT) : text;
    this.bot.chat(truncated);
    this.send(msg(`**${name}** said: ${truncated}`));
  }

  stop() {
    this.isStopping = true;
    this.stopAntiAfk();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch {}
      this.bot = null;
    }
  }
}
