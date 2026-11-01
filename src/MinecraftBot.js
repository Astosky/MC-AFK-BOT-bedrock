// Made by Asto

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mineflayer from 'mineflayer';
import {
  msg,
  msgSections,
  ContainerBuilder,
  MessageFlags,
  thinDivider,
  text,
  buildBotCardRows,
  formatDuration,
} from './ui.js';

const FATAL_CODES = new Set(['ENOTFOUND']);
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 15_000;
const ANTI_AFK_INTERVAL_MS = 5_000;
const TICK_INTERVAL_MS = 50;
const MC_CHAT_LIMIT = 256;
const PLAY_TETHER_RADIUS = 22;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');
fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

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
  constructor(options, discordChannel, onFatal, onRealUsername, authPassword) {
    this.edition = 'java';
    this.botId = options.botId || `b_${Math.random().toString(36).slice(2, 8)}`;
    this.onStateChange = options.onStateChange || null;
    this.options = { ...options, port: options.port || 25565 };
    this.discordChannel = discordChannel;
    this.onFatal = onFatal;
    this.onRealUsername = onRealUsername;

    this.bot = null;
    this.tickInterval = null;
    this.jumpInterval = null;
    this.lookInterval = null;
    this.reconnectTimeout = null;

    this.isStopping = false;
    this.isFatal = false;
    this.isDisconnecting = false;
    this.connectedAt = null;
    this.isSneaking = false;
    this.reconnectAttempts = 0;
    this.spawnedOnce = false;
    this.realUsername = null;
    this.serverVersion = null;
    this.lastErrorReason = null;

    // Gameplay behavior state
    this.mode = 'afk';
    this.modeTarget = null;
    this._playAnchor = null;
    this._playAction = null;
    this._circleCenter = null;
    this._dancePhase = 0;
    this._spinTicksRemaining = 0;
    this._tickCounter = 0;

    this.authPassword = authPassword || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  get isOnline() {
    return Boolean(this.bot?.entity);
  }

  getModeLabel() {
    switch (this.mode) {
      case 'follow':
        return `Following ${this.modeTarget || 'nearest'}`;
      case 'come':
        return `Going to ${this.modeTarget || 'nearest'}`;
      case 'play':
        return 'Playing around';
      case 'look':
        return `Watching ${this.modeTarget || 'nearby'}`;
      case 'dance':
        return 'Dancing';
      case 'circle':
        return `Orbiting ${this.modeTarget || 'spot'}`;
      default:
        return 'AFK';
    }
  }

  send(content) {
    this.discordChannel.send(content).catch(() => {});
  }

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
        this.options.username,
        MS_CACHE_DIR,
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

      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.isDisconnecting = false;
      this.lastErrorReason = null;
      const name = this.bot.username;
      this.realUsername = name;
      this.serverVersion = this.bot.version || this.bot._client?.version || null;

      if (this.isSneaking && this.bot?.entity) {
        this.bot.setControlState('sneak', true);
      }
      if (this.mode === 'play' && !this._playAnchor && this.bot?.entity) {
        this._playAnchor = this.bot.entity.position.clone();
      }

      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      if (this.onStateChange) this.onStateChange();

      const verTag = this.serverVersion ? `Java ${this.serverVersion}` : 'Java';
      const c = new ContainerBuilder();
      c.addTextDisplayComponents(
        text(
          `**${name}** connected to **${this.options.host}:${this.options.port}**\n` +
          `-# ${verTag} · Mode: ${this.getModeLabel()}`
        )
      );
      c.addSeparatorComponents(thinDivider());
      c.addActionRowComponents(
        ...buildBotCardRows(this.botId, {
          isOnline: true,
          isSneaking: this.isSneaking,
          mode: this.mode,
        })
      );

      this.send({ components: [c], flags: MessageFlags.IsComponentsV2 });
      this.startAntiAfk();
    });

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
    this.connectedAt = null;
    if (this.onStateChange) this.onStateChange();

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

  // ─── Target Lookup & Behavior Loop ───────────────────────────────────────────

  _findNearbyPlayer(query = null) {
    if (!this.bot?.entity) return null;
    const selfPos = this.bot.entity.position;
    const selfName = (this.bot.username || '').toLowerCase();

    const visible = Object.values(this.bot.players || {})
      .filter((p) => p?.entity && p.username && p.username.toLowerCase() !== selfName);

    if (!query) {
      if (visible.length === 0) return null;
      visible.sort((a, b) => a.entity.position.distanceTo(selfPos) - b.entity.position.distanceTo(selfPos));
      return visible[0];
    }

    const q = String(query).trim().toLowerCase();
    return (
      visible.find((p) => p.username.toLowerCase() === q) ||
      visible.find((p) => p.username.toLowerCase().startsWith(q)) ||
      visible.find((p) => p.username.toLowerCase().includes(q)) ||
      null
    );
  }

  _findOnlinePlayerName(query) {
    if (!query || !this.bot?.players) return null;
    const selfName = (this.bot.username || '').toLowerCase();
    const q = String(query).trim().toLowerCase();
    const names = Object.keys(this.bot.players).filter((n) => n.toLowerCase() !== selfName);
    return (
      names.find((n) => n.toLowerCase() === q) ||
      names.find((n) => n.toLowerCase().startsWith(q)) ||
      names.find((n) => n.toLowerCase().includes(q)) ||
      null
    );
  }

  _clearControls() {
    if (!this.bot) return;
    for (const ctrl of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) {
      try { this.bot.setControlState(ctrl, false); } catch {}
    }
    if (this.mode === 'dance' || this.mode === 'play') {
      this.isSneaking = false;
      try { this.bot.setControlState('sneak', false); } catch {}
    }
  }

  _pulseJump() {
    if (!this.bot?.entity) return;
    this.bot.setControlState('jump', true);
    setTimeout(() => { if (this.bot) this.bot.setControlState('jump', false); }, 300);
  }

  _pickNextPlayAction() {
    const now = Date.now();
    const pos = this.bot.entity.position;
    const anchor = this._playAnchor || pos;
    const distFromAnchor = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);

    const yaw =
      distFromAnchor > PLAY_TETHER_RADIUS
        ? Math.atan2(-(anchor.x - pos.x), -(anchor.z - pos.z)) + (Math.random() - 0.5) * 0.8
        : Math.random() * Math.PI * 2 - Math.PI;

    const roll = Math.random();
    if (roll < 0.45) {
      return { kind: 'sprint_hop', yaw, pitch: 0, expiresAt: now + 2000 + Math.random() * 2200, ticks: 0 };
    }
    if (roll < 0.72) {
      return { kind: 'stroll', yaw, pitch: -0.3, expiresAt: now + 2000 + Math.random() * 2000, ticks: 0 };
    }
    if (roll < 0.88) {
      return { kind: 'strafe', dir: Math.random() < 0.5 ? 'left' : 'right', expiresAt: now + 1500 + Math.random() * 1400, ticks: 0 };
    }
    return { kind: 'breather', yaw, pitch: (Math.random() - 0.5) * 0.5, expiresAt: now + 1500 + Math.random() * 1500, ticks: 0 };
  }

  _updateBehaviorTick() {
    if (!this.bot?.entity || this.isStopping) return;
    this._tickCounter++;

    if (this._spinTicksRemaining > 0) {
      const nextYaw = this.bot.entity.yaw + (Math.PI * 2) / 12;
      this.bot.look(nextYaw, 0, true);
      if (this._spinTicksRemaining === 6) this.bot.swingArm('right');
      this._spinTicksRemaining--;
      return;
    }

    if (this.mode === 'afk') return;

    const selfPos = this.bot.entity.position;

    if (this.mode === 'look') {
      const target = this._findNearbyPlayer(this.modeTarget);
      if (target?.entity) {
        this.bot.lookAt(target.entity.position.offset(0, 1.6, 0), true);
      }
      return;
    }

    if (this.mode === 'follow' || this.mode === 'come') {
      const target = this._findNearbyPlayer(this.modeTarget);
      if (!target?.entity) {
        this._clearControls();
        return;
      }

      if (!this.modeTarget) this.modeTarget = target.username;
      const tPos = target.entity.position;
      this.bot.lookAt(tPos.offset(0, 1.6, 0), true);
      const dist = Math.hypot(tPos.x - selfPos.x, tPos.z - selfPos.z);

      if (this.mode === 'come' && dist <= 2.4) {
        const reachedName = target.username;
        const selfName = this.realUsername || this.options.username;
        this.bot.swingArm('right');
        this.stopActivity({ silent: true });
        this.send(msg(`**${selfName}** arrived at **${reachedName}**`));
        return;
      }

      if (dist > 6.0) {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('jump', Boolean(this.bot.entity.isCollidedHorizontally));
      } else if (dist > 2.4) {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', Boolean(this.bot.entity.isCollidedHorizontally));
      } else if (dist < 1.3) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', true);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      } else {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }
      return;
    }

    if (this.mode === 'dance') {
      this._dancePhase++;
      this.bot.look(this.bot.entity.yaw + 0.28, Math.sin(this._dancePhase * 0.4) * 0.5, true);
      if (this._dancePhase % 5 === 0) {
        this.isSneaking = !this.isSneaking;
        this.bot.setControlState('sneak', this.isSneaking);
      }
      if (this._dancePhase % 16 === 0) this._pulseJump();
      if (this._dancePhase % 9 === 0) this.bot.swingArm('right');
      return;
    }

    if (this.mode === 'circle') {
      const target = this.modeTarget ? this._findNearbyPlayer(this.modeTarget) : this._findNearbyPlayer(null);
      const center = target?.entity ? target.entity.position : (this._circleCenter || selfPos);
      this.bot.lookAt(center.offset(0, 1.5, 0), true);
      const dist = Math.hypot(center.x - selfPos.x, center.z - selfPos.z);
      this.bot.setControlState('left', true);
      this.bot.setControlState('forward', dist > 3.4);
      this.bot.setControlState('back', dist < 2.5);
      this.bot.setControlState('jump', Boolean(this.bot.entity.isCollidedHorizontally));
      return;
    }

    if (this.mode === 'play') {
      if (!this._playAnchor) this._playAnchor = selfPos.clone();
      if (!this._playAction || Date.now() >= this._playAction.expiresAt) {
        this._clearControls();
        this._playAction = this._pickNextPlayAction();
      }
      const act = this._playAction;
      act.ticks++;

      if (act.kind === 'sprint_hop') {
        this.bot.look(act.yaw, act.pitch, true);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        if (act.ticks % 13 === 1 || this.bot.entity.isCollidedHorizontally) this._pulseJump();
      } else if (act.kind === 'stroll') {
        this.bot.look(act.yaw, act.pitch, true);
        this.bot.setControlState('forward', act.ticks < 28);
        this.bot.setControlState('jump', Boolean(this.bot.entity.isCollidedHorizontally));
        if (act.ticks === 25) this.bot.swingArm('right');
      } else if (act.kind === 'strafe') {
        this.bot.setControlState(act.dir, true);
        if (act.ticks === 12) this.bot.swingArm('right');
      } else {
        this.bot.look(act.yaw, act.pitch, false);
      }
    }
  }

  startAntiAfk() {
    this.stopAntiAfk();

    this.tickInterval = setInterval(() => this._updateBehaviorTick(), TICK_INTERVAL_MS);

    this.jumpInterval = setInterval(() => {
      if (this.bot?.entity && (this.mode === 'afk' || this.mode === 'look')) {
        this._pulseJump();
      }
    }, ANTI_AFK_INTERVAL_MS);

    this.lookInterval = setInterval(() => {
      if (this.bot?.entity && this.mode === 'afk') {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 1.0;
        this.bot.look(yaw, pitch, false);
      }
    }, 30_000);
  }

  stopAntiAfk() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.jumpInterval) { clearInterval(this.jumpInterval); this.jumpInterval = null; }
    if (this.lookInterval) { clearInterval(this.lookInterval); this.lookInterval = null; }
  }

  // ─── Commands & Fun Gameplay Modes ───────────────────────────────────────────

  stopActivity({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    this._clearControls();
    this.mode = 'afk';
    this.modeTarget = null;
    this._playAnchor = null;
    this._playAction = null;
    this._circleCenter = null;
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** returned to **AFK** mode`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  follow(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    if (!playerQuery && this.mode === 'follow') {
      return this.stopActivity({ silent });
    }

    this._clearControls();
    const nearby = this._findNearbyPlayer(playerQuery);
    if (nearby?.entity) {
      this.mode = 'follow';
      this.modeTarget = nearby.username;
      const dist = nearby.entity.position.distanceTo(this.bot.entity.position).toFixed(1);
      if (this.onStateChange) this.onStateChange();
      const m = `**${name}** is now following **${nearby.username}** (${dist}m away)`;
      if (!silent) this.send(msg(m));
      return { ok: true, mode: this.mode, message: m };
    }

    if (playerQuery) {
      const onlineMatch = this._findOnlinePlayerName(playerQuery) || playerQuery;
      this.mode = 'follow';
      this.modeTarget = onlineMatch;
      if (this.onStateChange) this.onStateChange();
      const m = `**${name}** is watching for **${onlineMatch}** and will follow as soon as they're in range`;
      if (!silent) this.send(msg(m));
      return { ok: true, mode: this.mode, message: m };
    }

    const m = `**${name}** — no nearby players in render distance right now`;
    if (!silent) this.send(msg(m));
    return { ok: false, message: m };
  }

  come(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    const nearby = this._findNearbyPlayer(playerQuery);
    if (!nearby?.entity) {
      const targetDesc = playerQuery ? `**${playerQuery}**` : 'any player';
      const m = `**${name}** — can't see ${targetDesc} in render distance right now`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._clearControls();
    this.mode = 'come';
    this.modeTarget = nearby.username;
    const dist = nearby.entity.position.distanceTo(this.bot.entity.position).toFixed(1);
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** is heading over to **${nearby.username}** (${dist}m away)`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  togglePlay({ silent = false, forceOn = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    if (this.mode === 'play' && !forceOn) {
      return this.stopActivity({ silent });
    }

    this._clearControls();
    this.mode = 'play';
    this.modeTarget = null;
    this._playAnchor = this.bot.entity.position.clone();
    this._playAction = this._pickNextPlayAction();
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** started **Play Mode** — roaming around, sprint-jumping & exploring!`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  lookAtPlayer(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._clearControls();
    const nearby = this._findNearbyPlayer(playerQuery);
    this.mode = 'look';
    this.modeTarget = nearby ? nearby.username : playerQuery || null;
    if (this.onStateChange) this.onStateChange();
    const label = this.modeTarget ? `**${this.modeTarget}**` : 'nearby players';
    const m = `**${name}** is now watching ${label}`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  toggleDance({ silent = false, forceOn = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    if (this.mode === 'dance' && !forceOn) {
      return this.stopActivity({ silent });
    }

    this._clearControls();
    this.mode = 'dance';
    this.modeTarget = null;
    this._dancePhase = 0;
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** started **dancing**!`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  circle(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._clearControls();
    const nearby = this._findNearbyPlayer(playerQuery);
    this.mode = 'circle';
    this.modeTarget = nearby ? nearby.username : playerQuery || null;
    this._circleCenter = nearby?.entity ? nearby.entity.position.clone() : this.bot.entity.position.clone();
    if (this.onStateChange) this.onStateChange();
    const label = this.modeTarget ? `**${this.modeTarget}**` : 'their spot';
    const m = `**${name}** is now orbiting around ${label}`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  hit(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    const nearby = this._findNearbyPlayer(playerQuery);
    if (nearby?.entity) {
      const dist = nearby.entity.position.distanceTo(this.bot.entity.position);
      this.bot.lookAt(nearby.entity.position.offset(0, 1.5, 0), true);
      if (dist <= 4.2) {
        this.bot.attack(nearby.entity);
        const m = `**${name}** punched **${nearby.username}**`;
        if (!silent) this.send(msg(m));
        return { ok: true, message: m };
      }
      this.bot.swingArm('right');
      const m = `**${name}** waved at **${nearby.username}** (${dist.toFixed(1)}m away)`;
      if (!silent) this.send(msg(m));
      return { ok: true, message: m };
    }

    this.bot.swingArm('right');
    const m = `**${name}** waved / swung their arm`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  spin({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }
    this._pulseJump();
    this._spinTicksRemaining = 12;
    const m = `**${name}** did a 360° spin!`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  getPlayersInfo() {
    if (!this.bot?.entity) return { nearby: [], farOnline: [] };
    const selfPos = this.bot.entity.position;
    const selfName = (this.bot.username || '').toLowerCase();

    const nearby = [];
    const farOnline = [];
    for (const p of Object.values(this.bot.players || {})) {
      if (!p?.username || p.username.toLowerCase() === selfName) continue;
      if (p.entity) {
        nearby.push({
          username: p.username,
          distance: Number(p.entity.position.distanceTo(selfPos).toFixed(1)),
          x: Math.round(p.entity.position.x),
          y: Math.round(p.entity.position.y),
          z: Math.round(p.entity.position.z),
        });
      } else {
        farOnline.push(p.username);
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    return { nearby, farOnline };
  }

  getCoords() {
    const pos = this.bot?.entity?.position;
    if (!pos) return null;
    return {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
    };
  }

  getUptimeString() {
    if (!this.connectedAt) return null;
    return formatDuration(Date.now() - this.connectedAt);
  }

  jump({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game, cannot jump`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }
    this._pulseJump();
    const m = `**${name}** jumped`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  toggleSneak({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      const m = `**${name}** — not in-game, cannot toggle sneak`;
      if (!silent) this.send(msg(m));
      return { ok: false, sneaking: this.isSneaking, message: m };
    }
    this.isSneaking = !this.isSneaking;
    this.bot.setControlState('sneak', this.isSneaking);
    const m = `**${name}** sneak **${this.isSneaking ? 'ON' : 'OFF'}**`;
    if (!silent) this.send(msg(m));
    return { ok: true, sneaking: this.isSneaking, message: m };
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
    this.connectedAt = null;
    if (this.onStateChange) this.onStateChange();
  }
}
