// Made by Asto

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createRequire } from 'module';
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
import { connectBedrockClient, BEDROCK_CURRENT_VERSION } from './bedrockTransport.js';

const require = createRequire(import.meta.url);
const mcDataLoader = require('minecraft-data');

const MAX_RECONNECTS = 5;
const MAX_STARTING_RECONNECTS = 8;
const RECONNECT_DELAY_MS = 15_000;
const ANTI_AFK_INTERVAL_MS = 5_000;
const TICK_INTERVAL_MS = 50; // 20 TPS server-authoritative input tick
const MC_CHAT_LIMIT = 256;
const PLAY_TETHER_RADIUS = 22; // Keep autonomous play near home area

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');
fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

// Auth-plugin prompt patterns (SimpleAuth, ServerAuth, AuthMe via Geyser, etc.)
const REGISTER_PATTERNS = [
  /\/register/i,
  /please register/i,
  /you must register/i,
  /register to (play|continue)/i,
  /use \/reg/i,
];
const LOGIN_PATTERNS = [
  /\/(login|l)\b/i,
  /please (log\s?in|authenticate)/i,
  /you must (log\s?in|authenticate)/i,
  /use \/log/i,
];

const DISCONNECT_TRANSLATIONS = {
  'disconnectionScreen.notAuthenticated': 'Server requires Microsoft/Xbox authentication (Cracked is off)',
  'not_authenticated': 'Server requires Microsoft/Xbox authentication (Cracked is off)',
  'disconnectionScreen.notAllowed': 'You are not allowlisted/whitelisted on this server',
  'disconnectionScreen.serverFull': 'Server is full',
  'disconnectionScreen.outdatedClient': 'Bot protocol is older than the server version',
  'disconnectionScreen.outdatedServer': 'Server is running an older version',
  'disconnectionScreen.serverIdConflict': 'This account is already logged in on the server',
  'disconnectionScreen.loggedinOtherLocation': 'Logged in from another location',
  'disconnectionScreen.noReason': 'Disconnected by server (no reason given)',
  'disconnectionScreen.disconnected': 'Disconnected from server',
  'disconnectionScreen.timeout': 'Connection timed out',
};

const EMPTY_HELD_ITEM = {
  network_id: 0,
  count: 0,
  metadata: 0,
  has_stack_id: false,
  block_runtime_id: 0,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
};

function stripFormatting(str = '') {
  return String(str).replace(/§[0-9a-fk-org]/gi, '').trim();
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function wrapDegrees(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function lerpAngleDeg(current, target, factor = 0.35) {
  const diff = wrapDegrees(target - current);
  return wrapDegrees(current + diff * factor);
}

function formatBedrockDisconnect(raw) {
  if (!raw) return 'Disconnected';
  const cleaned = stripFormatting(typeof raw === 'object' ? raw.message || JSON.stringify(raw) : raw);
  if (!cleaned) return 'Disconnected';
  if (DISCONNECT_TRANSLATIONS[cleaned]) return DISCONNECT_TRANSLATIONS[cleaned];
  for (const [key, readable] of Object.entries(DISCONNECT_TRANSLATIONS)) {
    if (cleaned.includes(key)) return readable;
  }
  return cleaned;
}

function isUnauthenticatedKick(raw) {
  const s = String(typeof raw === 'object' ? raw?.message || '' : raw || '');
  return /notAuthenticated|not_authenticated|loginFailed|ErrorCode 37/i.test(s);
}

function extractBedrockMessageText(packet) {
  if (!packet) return '';
  const raw = packet.message || '';
  if (packet.type === 'json' || packet.type === 'json_whisper' || packet.type === 'json_announcement') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.rawtext)) {
        return stripFormatting(parsed.rawtext.map((e) => e.text || e.translate || '').join(''));
      }
    } catch {
      // Fall back to raw string
    }
  }
  return stripFormatting(raw);
}

export class BedrockBot {
  /**
   * @param {object}   options          { host, port, username, auth, version }
   * @param {object}   discordChannel   Discord TextChannel for status & chat messages
   * @param {Function} onFatal          called when the bot permanently fails and is removed
   * @param {Function} onRealUsername   called with the real Gamertag/username on first spawn
   * @param {string}   [authPassword]   stable password for /register & /login plugins
   */
  constructor(options, discordChannel, onFatal, onRealUsername, authPassword) {
    this.edition = 'bedrock';
    this.botId = options.botId || `b_${Math.random().toString(36).slice(2, 8)}`;
    this.onStateChange = options.onStateChange || null;
    this.options = { ...options, port: options.port || 19132 };
    this.discordChannel = discordChannel;
    this.onFatal = onFatal;
    this.onRealUsername = onRealUsername;

    this.client = null;
    this.authflow = null;
    this.connectAbort = null;

    this.tickInterval = null;
    this.jumpInterval = null;
    this.lookInterval = null;
    this.reconnectTimeout = null;

    this.isStopping = false;
    this.isFatal = false;
    this.isDisconnecting = false;
    this.inGame = false;
    this.connectedAt = null;
    this.isSneaking = false;
    this._pendingSneakTransition = null;
    this.isSprinting = false;
    this._pendingSwingFlag = false;

    this.reconnectAttempts = 0;
    this.serverIsStarting = false;
    this.spawnedOnce = false;
    this.realUsername = null;
    this.serverVersion = BEDROCK_CURRENT_VERSION;
    this.transportLabel = 'Bedrock';
    this.lastErrorReason = null;

    // Player physics & protocol state
    this.runtimeEntityId = 1n;
    this.uniqueEntityId = 0n;
    this.position = { x: 0, y: 65.62, z: 0 };
    this.groundY = 65.62;
    this.velY = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.headYaw = 0;
    this.tick = 0n;
    this.jumpTicksRemaining = 0;
    this.jumpStartedThisCycle = false;
    this.pendingTeleportAck = false;
    this.arrayInputData = true;
    this.stringCmdVersion = true;

    // Movement & behavior mode state
    this.mode = 'afk'; // 'afk' | 'follow' | 'come' | 'play' | 'look' | 'dance' | 'circle'
    this.modeTarget = null;
    this.moveForward = 0;
    this.moveStrafe = 0;
    this.wantSprint = false;
    this._playAnchor = null;
    this._playAction = null;
    this._circleCenter = null;
    this._dancePhase = 0;
    this._spinTicksRemaining = 0;
    this._progressSamplePos = null;
    this._progressSampleTicks = 0;

    // Live world tracking
    this.onlinePlayers = new Map(); // uuid -> { uuid, username, uniqueId }
    this.trackedPlayers = new Map(); // runtimeIdStr -> { runtimeId, uniqueId, uuid, username, position }
    this.trackedEntities = new Map(); // runtimeIdStr -> { runtimeId, uniqueId, entityType, position }

    this.authPassword = authPassword || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  get isOnline() {
    return this.inGame;
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

  _failFatally(messagePayload) {
    if (this.isFatal || this.isStopping) return;
    this.isFatal = true;
    this.send(messagePayload);
    this.stop();
    if (this.onFatal) this.onFatal();
  }

  // ─── Microsoft / Xbox Live pre-authentication ────────────────────────────────

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
              `Microsoft / Xbox login required — **${this.options.host}**`,
              `Open: <${data.verification_uri}>\n\nCode: \`${data.user_code}\``,
              `-# Expires in ${mins} min. Bot joins Bedrock automatically after sign-in.`
            )
          );
        }
      );

      await flow.getXboxToken();
      this.authflow = flow;
      return true;
    } catch (err) {
      this._failFatally(
        msg(`Microsoft authentication failed\n-# ${err.message || String(err)} · bot removed`)
      );
      return false;
    }
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────────

  _cleanupClient() {
    if (this.connectAbort) {
      this.connectAbort.abort();
      this.connectAbort = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      c.removeAllListeners();
      try { c.close(); } catch {}
    }
    this.inGame = false;
    this.onlinePlayers.clear();
    this.trackedPlayers.clear();
    this.trackedEntities.clear();
    this.moveForward = 0;
    this.moveStrafe = 0;
    this.wantSprint = false;
  }

  _handleDiscoveryOrAuthError(err) {
    const name = this.realUsername || this.options.username;

    if (err?.code === 'ENOTFOUND') {
      this._failFatally(
        msg(`**${name}** — unknown host **${this.options.host}**\n-# DNS lookup failed (ENOTFOUND) · bot removed`)
      );
      return true;
    }

    if (err?.serverOffline && !this.spawnedOnce) {
      this._failFatally(
        msgSections(
          `**${name}** — **${this.options.host}** is currently **Offline**`,
          `-# Start your server first, then run \`!join ${this.options.username}\` · bot removed`
        )
      );
      return true;
    }

    if (err?.javaOnly && !this.spawnedOnce) {
      const javaCmd =
        this.options.auth === 'microsoft'
          ? `!premjoin java ${this.options.host}`
          : `!join java ${this.options.host} ${this.options.username}`;
      this._failFatally(
        msgSections(
          `**${name}** — **${this.options.host}** is running **Java Edition** (${err.javaVersion})`,
          `-# No Bedrock/Geyser listener responded on port ${this.options.port}. Use \`${javaCmd}\` (or install GeyserMC for Bedrock) · bot removed`
        )
      );
      return true;
    }

    if (err?.authRequired && this.options.auth !== 'microsoft') {
      this._failFatally(
        msgSections(
          `**${name}** — **${this.options.host}** requires Microsoft/Xbox login`,
          `-# Enable **Cracked** in your server Options, or use \`!premjoin bedrock ${this.options.host}:${this.options.port}\` · bot removed`
        )
      );
      return true;
    }

    if (err?.serverStarting) {
      this.serverIsStarting = true;
    }

    return false;
  }

  async connect() {
    if (this.isStopping || this.isFatal) return;

    this.isDisconnecting = false;
    this.serverIsStarting = false;
    this.lastErrorReason = null;
    this._cleanupClient();

    const isOffline = this.options.auth !== 'microsoft';
    if (!isOffline) {
      const ok = await this._preAuth();
      if (!ok) return;
    }

    if (this.isStopping || this.isFatal) return;

    this.connectAbort = new AbortController();

    try {
      await connectBedrockClient(
        {
          host: this.options.host,
          port: this.options.port || 19132,
          username: this.options.username,
          offline: isOffline,
          profilesFolder: MS_CACHE_DIR,
          authflow: this.authflow || undefined,
          version: this.options.version || undefined,
          conLog: null,
        },
        this.connectAbort.signal,
        (client, discovery) => {
          this.client = client;
          this.options.port = discovery.port || this.options.port;
          this.serverVersion = client.options.version || discovery.version || BEDROCK_CURRENT_VERSION;
          this.transportLabel =
            discovery.transport === 'nethernet'
              ? `NetherNet${discovery.signalling === 'http' ? '' : '/LAN'}`
              : 'RakNet';

          if (!discovery.reachable && discovery.diagnostic) {
            this.lastErrorReason = discovery.diagnostic;
          }

          this._configureProtocolCapabilities(this.serverVersion);
          this._attachListeners(client);
        }
      );
    } catch (err) {
      if (this.isStopping || this.isFatal) return;
      if (this._handleDiscoveryOrAuthError(err)) return;
      this.lastErrorReason = err?.message || String(err);
      this.handleDisconnect();
    }
  }

  _configureProtocolCapabilities(version) {
    try {
      const data = mcDataLoader(`bedrock_${version}`);
      const types = data?.protocol?.types || {};
      const paiFields = types.packet_player_auth_input?.[1] || [];
      const inputField = paiFields.find((f) => f.name === 'input_data');
      this.arrayInputData = Array.isArray(inputField?.type);

      const cmdFields = types.packet_command_request?.[1] || [];
      const verField = cmdFields.find((f) => f.name === 'version');
      this.stringCmdVersion = verField?.type === 'string';
    } catch {
      this.arrayInputData = true;
      this.stringCmdVersion = true;
    }
  }

  _attachListeners(client) {
    client.on('start_game', (packet) => {
      if (this.isStopping || this.isFatal) return;
      try {
        if (packet.runtime_entity_id != null) {
          this.runtimeEntityId = BigInt(packet.runtime_entity_id);
        }
        if (packet.entity_id != null) {
          this.uniqueEntityId = BigInt(packet.entity_id);
        }
        if (packet.player_position) {
          this.position = {
            x: Number(packet.player_position.x) || 0,
            y: Number(packet.player_position.y) || 65.62,
            z: Number(packet.player_position.z) || 0,
          };
          this.groundY = this.position.y;
          this.velY = 0;
        }
        if (packet.rotation) {
          this.pitch = Number(packet.rotation.x) || 0;
          this.yaw = Number(packet.rotation.z) || 0;
          this.headYaw = this.yaw;
        }
        if (packet.current_tick != null) {
          this.tick = BigInt(packet.current_tick);
        }
      } catch {}
    });

    client.on('spawn', () => {
      if (this.isStopping || this.isFatal) return;

      this.inGame = true;
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.serverIsStarting = false;
      this.isDisconnecting = false;
      this.lastErrorReason = null;

      if (this.mode === 'play' && !this._playAnchor) {
        this._playAnchor = { ...this.position };
      }

      const name = client.profile?.name || client.username || this.options.username;
      this.realUsername = name;

      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      if (this.onStateChange) this.onStateChange();

      const c = new ContainerBuilder();
      c.addTextDisplayComponents(
        text(
          `**${name}** connected to **${this.options.host}:${this.options.port}**\n` +
          `-# Bedrock ${this.serverVersion} · ${this.transportLabel} · Mode: ${this.getModeLabel()}`
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

    // ─── Online Player List & World Entity Tracking ──────────────────────────

    client.on('player_list', (packet) => {
      if (!this.client || this.isStopping) return;
      const records = Array.isArray(packet?.records)
        ? packet.records
        : Array.isArray(packet?.records?.records)
          ? packet.records.records.map((r) => ({ ...r, type: r.type || packet.records.type }))
          : [];

      for (const rec of records) {
        if (!rec?.uuid) continue;
        if (rec.type === 'remove') {
          this.onlinePlayers.delete(rec.uuid);
          for (const [rid, p] of this.trackedPlayers.entries()) {
            if (p.uuid === rec.uuid) this.trackedPlayers.delete(rid);
          }
        } else {
          const uname = stripFormatting(rec.username || '');
          const uid = rec.entity_unique_id != null ? String(rec.entity_unique_id) : null;
          if (uname) {
            this.onlinePlayers.set(rec.uuid, { uuid: rec.uuid, username: uname, uniqueId: uid });
            for (const p of this.trackedPlayers.values()) {
              if (!p.username && (p.uuid === rec.uuid || (uid && p.uniqueId === uid))) {
                p.username = uname;
              }
            }
          }
        }
      }
    });

    client.on('add_player', (packet) => {
      if (!this.client || this.isStopping || packet?.runtime_id == null) return;
      const ridStr = String(packet.runtime_id);
      if (ridStr === String(this.runtimeEntityId)) return;

      const uid = packet.unique_id != null ? String(packet.unique_id) : null;
      const uuid = packet.uuid || null;
      let uname = stripFormatting(packet.username || '');
      if (!uname && uuid && this.onlinePlayers.has(uuid)) {
        uname = this.onlinePlayers.get(uuid).username;
      }

      this.trackedPlayers.set(ridStr, {
        runtimeId: BigInt(packet.runtime_id),
        uniqueId: uid,
        uuid,
        username: uname || `Player_${ridStr}`,
        position: {
          x: Number(packet.position?.x) || 0,
          y: Number(packet.position?.y) || 65.62,
          z: Number(packet.position?.z) || 0,
        },
        yaw: Number(packet.yaw) || 0,
        pitch: Number(packet.pitch) || 0,
      });
    });

    client.on('add_entity', (packet) => {
      if (!this.client || this.isStopping || packet?.runtime_id == null) return;
      const ridStr = String(packet.runtime_id);
      const entityType = String(packet.entity_type || '').replace(/^minecraft:/, '');
      // Ignore dropped items, xp orbs, arrows, etc.
      if (/item|xp_orb|arrow|snowball|egg|potion|tnt|falling_block/i.test(entityType)) return;
      if (this.trackedEntities.size >= 100 && !this.trackedEntities.has(ridStr)) {
        const oldest = this.trackedEntities.keys().next().value;
        if (oldest) this.trackedEntities.delete(oldest);
      }
      this.trackedEntities.set(ridStr, {
        runtimeId: BigInt(packet.runtime_id),
        uniqueId: packet.unique_id != null ? String(packet.unique_id) : null,
        entityType,
        position: {
          x: Number(packet.position?.x) || 0,
          y: Number(packet.position?.y) || 64,
          z: Number(packet.position?.z) || 0,
        },
      });
    });

    client.on('remove_entity', (packet) => {
      if (!this.client || this.isStopping || packet?.entity_id_self == null) return;
      const uid = String(packet.entity_id_self);
      for (const [rid, p] of this.trackedPlayers.entries()) {
        if (p.uniqueId === uid) this.trackedPlayers.delete(rid);
      }
      for (const [rid, e] of this.trackedEntities.entries()) {
        if (e.uniqueId === uid) this.trackedEntities.delete(rid);
      }
    });

    // Keep self & other players synchronized with server teleports & movements
    client.on('move_player', (packet) => {
      if (!this.client || this.isStopping || packet?.runtime_id == null) return;
      const ridStr = String(packet.runtime_id);

      if (ridStr === String(this.runtimeEntityId)) {
        if (packet.position) {
          this.position = {
            x: Number(packet.position.x) || 0,
            y: Number(packet.position.y) || 0,
            z: Number(packet.position.z) || 0,
          };
          if (packet.on_ground !== false || packet.mode === 'teleport' || packet.mode === 'reset') {
            this.groundY = this.position.y;
            this.velY = 0;
          }
        }
        if (packet.mode === 'teleport' || packet.mode === 'reset') {
          if (typeof packet.pitch === 'number') this.pitch = packet.pitch;
          if (typeof packet.yaw === 'number') this.yaw = packet.yaw;
          if (typeof packet.head_yaw === 'number') this.headYaw = packet.head_yaw;
          this.pendingTeleportAck = true;
        }
        return;
      }

      const tracked = this.trackedPlayers.get(ridStr);
      if (tracked && packet.position) {
        tracked.position.x = Number(packet.position.x) || tracked.position.x;
        tracked.position.y = Number(packet.position.y) || tracked.position.y;
        tracked.position.z = Number(packet.position.z) || tracked.position.z;
        if (typeof packet.yaw === 'number') tracked.yaw = packet.yaw;
        if (typeof packet.pitch === 'number') tracked.pitch = packet.pitch;
      }
    });

    client.on('move_entity_delta', (packet) => {
      if (!this.client || this.isStopping || packet?.runtime_entity_id == null) return;
      const ridStr = String(packet.runtime_entity_id);
      const target = this.trackedPlayers.get(ridStr) || this.trackedEntities.get(ridStr);
      if (!target) return;
      if (typeof packet.x === 'number') target.position.x = packet.x;
      if (typeof packet.y === 'number') target.position.y = packet.y;
      if (typeof packet.z === 'number') target.position.z = packet.z;
    });

    client.on('move_entity', (packet) => {
      if (!this.client || this.isStopping || packet?.runtime_entity_id == null) return;
      const ridStr = String(packet.runtime_entity_id);
      const target = this.trackedPlayers.get(ridStr) || this.trackedEntities.get(ridStr);
      if (target && packet.position) {
        target.position.x = Number(packet.position.x) || target.position.x;
        target.position.y = Number(packet.position.y) || target.position.y;
        target.position.z = Number(packet.position.z) || target.position.z;
      }
    });

    client.on('correct_player_move_prediction', (packet) => {
      if (!this.client || this.isStopping) return;
      if (packet.position) {
        this.position = {
          x: Number(packet.position.x) || 0,
          y: Number(packet.position.y) || 0,
          z: Number(packet.position.z) || 0,
        };
        if (packet.on_ground) {
          this.groundY = this.position.y;
          this.velY = 0;
        } else if (packet.delta && typeof packet.delta.y === 'number') {
          this.velY = packet.delta.y;
          if (this.position.y < this.groundY) {
            this.groundY = this.position.y;
          }
        }
      }
    });

    // Auto-respawn if killed
    client.on('entity_event', (packet) => {
      if (!this.client || this.isStopping) return;
      if (
        packet.event_id === 'death' &&
        String(packet.runtime_entity_id) === String(this.runtimeEntityId)
      ) {
        setTimeout(() => {
          if (!this.client || this.isStopping) return;
          try {
            this.client.queue('respawn', {
              position: { x: 0, y: 0, z: 0 },
              state: 0,
              runtime_entity_id: this.runtimeEntityId,
            });
          } catch {}
        }, 1000);
      }
    });

    client.on('respawn', (packet) => {
      if (!this.client || this.isStopping) return;
      if (packet.state === 1) {
        if (packet.position) {
          this.position = {
            x: Number(packet.position.x) || 0,
            y: Number(packet.position.y) || 0,
            z: Number(packet.position.z) || 0,
          };
          this.groundY = this.position.y;
          this.velY = 0;
        }
        try {
          this.client.queue('respawn', {
            position: this.position,
            state: 2,
            runtime_entity_id: this.runtimeEntityId,
          });
          this.client.queue('player_action', {
            runtime_entity_id: this.runtimeEntityId,
            action: 'respawn',
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: -1,
          });
        } catch {}
      }
    });

    // Incoming chat & server auth prompts
    client.on('text', (packet) => {
      if (!this.client || this.isStopping) return;
      const content = extractBedrockMessageText(packet);
      if (!content) return;

      const lower = content.toLowerCase();
      if (REGISTER_PATTERNS.some((p) => p.test(lower))) {
        setTimeout(() => {
          if (this.client && !this.isStopping) {
            this._sendCommand(`/register ${this.authPassword} ${this.authPassword}`);
          }
        }, 800);
      } else if (LOGIN_PATTERNS.some((p) => p.test(lower))) {
        setTimeout(() => {
          if (this.client && !this.isStopping) {
            this._sendCommand(`/login ${this.authPassword}`);
          }
        }, 800);
      }

      if (packet.type === 'chat' || packet.type === 'announcement') {
        const sender = stripFormatting(packet.source_name || '');
        const selfName = this.realUsername || client.username || this.options.username;
        if (sender && sender !== selfName) {
          this.discordChannel
            .send(`\`${selfName}\` **${sender}:** ${content}`)
            .catch(() => {});
        }
      }
    });

    client.on('kick', (packet) => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      const name = this.realUsername || client.username || this.options.username;

      if (this.options.auth !== 'microsoft' && isUnauthenticatedKick(packet)) {
        this._failFatally(
          msgSections(
            `**${name}** — **${this.options.host}** requires Microsoft/Xbox login`,
            `-# Enable **Cracked** in your server settings, or use \`!premjoin bedrock ${this.options.host}:${this.options.port}\` · bot removed`
          )
        );
        return;
      }

      this.isDisconnecting = true;
      const readable = formatBedrockDisconnect(packet);
      this.lastErrorReason = readable;
      this.send(
        msgSections(
          `**${name}** kicked from **${this.options.host}**`,
          `-# ${readable}`
        )
      );
      this.handleDisconnect();
    });

    client.on('error', (err) => {
      if (this.isStopping || this.isFatal) return;
      if (this._handleDiscoveryOrAuthError(err)) return;

      const msgStr = err?.message || String(err);
      if (msgStr === 'Connect timed out' && this.lastErrorReason) {
        return;
      }
      this.lastErrorReason = msgStr;
    });

    client.on('close', () => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      this.isDisconnecting = true;
      this.handleDisconnect();
    });
  }

  // ─── Reconnect ───────────────────────────────────────────────────────────────

  handleDisconnect() {
    if (this.isStopping || this.isFatal) return;
    this.stopAntiAfk();
    this.inGame = false;
    this.connectedAt = null;
    if (this.onStateChange) this.onStateChange();

    const name = this.realUsername || this.options.username;
    const maxAttempts = this.serverIsStarting ? MAX_STARTING_RECONNECTS : MAX_RECONNECTS;

    if (this.reconnectAttempts >= maxAttempts) {
      const reasonSuffix = this.lastErrorReason ? ` · ${this.lastErrorReason}` : '';
      this.send(
        msg(
          `**${name}** — max reconnects reached on **${this.options.host}**\n-# removed after ${maxAttempts} failed attempts${reasonSuffix}`
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
        `**${name}** — reconnecting to **${this.options.host}:${this.options.port}**\n-# attempt ${this.reconnectAttempts}/${maxAttempts} · in ${delaySec}s${reasonLine}`
      )
    );

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect().catch(() => {}), RECONNECT_DELAY_MS);
  }

  // ─── Target Lookup & Aiming Helpers ──────────────────────────────────────────

  _selfLower() {
    return String(this.realUsername || this.options.username || '').toLowerCase();
  }

  _distanceTo(pos) {
    return Math.hypot(
      pos.x - this.position.x,
      pos.y - this.position.y,
      pos.z - this.position.z
    );
  }

  _horizDistanceTo(pos) {
    return Math.hypot(pos.x - this.position.x, pos.z - this.position.z);
  }

  _findNearbyPlayer(query = null) {
    const self = this._selfLower();
    const candidates = [...this.trackedPlayers.values()].filter(
      (p) => p.username && p.username.toLowerCase() !== self
    );

    if (!query) {
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => this._distanceTo(a.position) - this._distanceTo(b.position));
      return candidates[0];
    }

    const q = String(query).trim().toLowerCase();
    const exact = candidates.find((p) => p.username.toLowerCase() === q);
    if (exact) return exact;
    const prefix = candidates.find((p) => p.username.toLowerCase().startsWith(q));
    if (prefix) return prefix;
    return candidates.find((p) => p.username.toLowerCase().includes(q)) || null;
  }

  _findOnlinePlayerName(query) {
    if (!query) return null;
    const self = this._selfLower();
    const q = String(query).trim().toLowerCase();
    const names = [...this.onlinePlayers.values()]
      .map((p) => p.username)
      .filter((n) => n && n.toLowerCase() !== self);

    return (
      names.find((n) => n.toLowerCase() === q) ||
      names.find((n) => n.toLowerCase().startsWith(q)) ||
      names.find((n) => n.toLowerCase().includes(q)) ||
      null
    );
  }

  _findNearestLivingEntity(maxDist = 16) {
    const nearPlayer = this._findNearbyPlayer(null);
    if (nearPlayer && this._horizDistanceTo(nearPlayer.position) <= maxDist) {
      return {
        isPlayer: true,
        runtimeId: nearPlayer.runtimeId,
        name: nearPlayer.username,
        eyePos: nearPlayer.position,
      };
    }

    let best = null;
    let bestDist = maxDist;
    for (const ent of this.trackedEntities.values()) {
      const d = this._horizDistanceTo(ent.position);
      if (d < bestDist) {
        bestDist = d;
        best = ent;
      }
    }
    if (!best) return null;
    return {
      isPlayer: false,
      runtimeId: best.runtimeId,
      name: best.entityType || 'mob',
      eyePos: { x: best.position.x, y: best.position.y + 1.0, z: best.position.z },
    };
  }

  _lookAtPoint(tx, ty, tz, smoothing = 0.45) {
    const dx = tx - this.position.x;
    const dy = ty - this.position.y;
    const dz = tz - this.position.z;
    const horiz = Math.hypot(dx, dz);

    const targetYaw = Math.atan2(-dx, dz) * (180 / Math.PI);
    const targetPitch = clamp(-Math.atan2(dy, Math.max(0.05, horiz)) * (180 / Math.PI), -85, 85);

    this.yaw = smoothing >= 1 ? wrapDegrees(targetYaw) : lerpAngleDeg(this.yaw, targetYaw, smoothing);
    this.headYaw = this.yaw;
    this.pitch = smoothing >= 1 ? targetPitch : this.pitch + (targetPitch - this.pitch) * smoothing;
  }

  _setSneakInternal(val) {
    const next = Boolean(val);
    if (next !== this.isSneaking) {
      this.isSneaking = next;
      this._pendingSneakTransition = next ? 'start' : 'stop';
    }
  }

  _swingArmPacket() {
    if (!this.client || !this.inGame) return;
    this._pendingSwingFlag = true;
    try {
      this.client.queue('animate', {
        action_id: 'swing_arm',
        runtime_entity_id: this.runtimeEntityId,
        data: 0,
        has_swing_source: true,
        swing_source: 'attack',
        hand: 'main_hand',
      });
    } catch {}
  }

  _attackEntityPacket(runtimeId, targetPos) {
    if (!this.client || !this.inGame) return;
    this._swingArmPacket();
    try {
      this.client.queue('inventory_transaction', {
        transaction: {
          legacy: { legacy_request_id: 0 },
          transaction_type: 'item_use_on_entity',
          actions: [],
          transaction_data: {
            entity_runtime_id: BigInt(runtimeId),
            action_type: 'attack',
            hotbar_slot: 0,
            hand: 'main_hand',
            held_item: EMPTY_HELD_ITEM,
            player_pos: { ...this.position },
            click_pos: { ...targetPos },
          },
        },
      });
    } catch {}
  }

  // ─── Autonomous Behavior State Machine (20 TPS) ──────────────────────────────

  _pickNextPlayAction() {
    const now = Date.now();
    const anchor = this._playAnchor || this.position;
    const distFromAnchor = Math.hypot(this.position.x - anchor.x, this.position.z - anchor.z);

    // Bias heading back toward home anchor if drifting too far
    const baseHeading =
      distFromAnchor > PLAY_TETHER_RADIUS
        ? Math.atan2(-(anchor.x - this.position.x), anchor.z - this.position.z) * (180 / Math.PI) +
          (Math.random() - 0.5) * 50
        : Math.random() * 360 - 180;

    const nearLiving = this._findNearestLivingEntity(15);
    const roll = Math.random();

    if (nearLiving && roll < 0.28 && distFromAnchor <= PLAY_TETHER_RADIUS + 6) {
      return {
        kind: 'social_greet',
        expiresAt: now + 2600 + Math.random() * 1800,
        ticks: 0,
      };
    }
    if (roll < 0.56) {
      return {
        kind: 'sprint_hop',
        targetYaw: wrapDegrees(baseHeading),
        targetPitch: (Math.random() - 0.5) * 18,
        expiresAt: now + 1800 + Math.random() * 2400,
        ticks: 0,
      };
    }
    if (roll < 0.78) {
      return {
        kind: 'stroll_inspect',
        targetYaw: wrapDegrees(baseHeading),
        targetPitch: 15 + Math.random() * 28, // Look down at blocks
        expiresAt: now + 2000 + Math.random() * 2200,
        ticks: 0,
      };
    }
    if (roll < 0.90) {
      return {
        kind: 'strafe_peek',
        strafeDir: Math.random() < 0.5 ? 0.85 : -0.85,
        targetYaw: wrapDegrees(this.yaw + (Math.random() - 0.5) * 90),
        targetPitch: (Math.random() - 0.5) * 35,
        expiresAt: now + 1400 + Math.random() * 1500,
        ticks: 0,
      };
    }
    return {
      kind: 'breather',
      targetYaw: wrapDegrees(this.yaw + (Math.random() - 0.5) * 110),
      targetPitch: (Math.random() - 0.5) * 30,
      expiresAt: now + 1500 + Math.random() * 1800,
      ticks: 0,
    };
  }

  _updateBehaviorTick() {
    // One-shot 360° spin override
    if (this._spinTicksRemaining > 0) {
      this.yaw = wrapDegrees(this.yaw + 30);
      this.headYaw = this.yaw;
      if (this._spinTicksRemaining === 6) this._swingArmPacket();
      this._spinTicksRemaining--;
      return;
    }

    if (this.mode === 'afk') {
      this.moveForward = 0;
      this.moveStrafe = 0;
      this.wantSprint = false;
      return;
    }

    if (this.mode === 'look') {
      this.moveForward = 0;
      this.moveStrafe = 0;
      this.wantSprint = false;
      const target = this._findNearbyPlayer(this.modeTarget);
      if (target) {
        this._lookAtPoint(target.position.x, target.position.y, target.position.z, 0.45);
      } else if (!this.modeTarget) {
        const near = this._findNearestLivingEntity(20);
        if (near) this._lookAtPoint(near.eyePos.x, near.eyePos.y, near.eyePos.z, 0.35);
      }
      return;
    }

    if (this.mode === 'follow' || this.mode === 'come') {
      const target = this._findNearbyPlayer(this.modeTarget);
      if (!target) {
        this.moveForward = 0;
        this.moveStrafe = 0;
        this.wantSprint = false;
        // Slowly scan around waiting for target to enter render distance
        this.yaw = wrapDegrees(this.yaw + 2.5);
        this.headYaw = this.yaw;
        return;
      }

      if (!this.modeTarget) {
        this.modeTarget = target.username;
      }

      this._lookAtPoint(target.position.x, target.position.y, target.position.z, 0.5);
      const dist = this._horizDistanceTo(target.position);

      if (this.mode === 'come' && dist <= 2.4) {
        const reachedName = target.username;
        const selfName = this.realUsername || this.options.username;
        this._swingArmPacket();
        this.stopActivity({ silent: true });
        this.send(msg(`**${selfName}** arrived at **${reachedName}**`));
        return;
      }

      if (dist > 6.0) {
        this.moveForward = 1;
        this.moveStrafe = 0;
        this.wantSprint = true;
        if (target.position.y > this.position.y + 0.75 && this.jumpTicksRemaining === 0 && Number(this.tick % 12n) === 0) {
          this._triggerJump();
        }
      } else if (dist > 2.4) {
        this.moveForward = 1;
        this.moveStrafe = 0;
        this.wantSprint = false;
      } else if (dist < 1.25) {
        this.moveForward = -0.55;
        this.moveStrafe = 0;
        this.wantSprint = false;
      } else {
        this.moveForward = 0;
        this.moveStrafe = 0;
        this.wantSprint = false;
        // Occasional friendly wave when standing next to target
        if (Math.random() < 0.008) this._swingArmPacket();
      }
      return;
    }

    if (this.mode === 'dance') {
      this._dancePhase++;
      this.moveForward = 0;
      this.moveStrafe = Math.sin(this._dancePhase * 0.25) * 0.45;
      this.wantSprint = false;
      this.yaw = wrapDegrees(this.yaw + 16);
      this.headYaw = this.yaw;
      this.pitch = Math.sin(this._dancePhase * 0.4) * 35;

      if (this._dancePhase % 5 === 0) {
        this._setSneakInternal(!this.isSneaking);
      }
      if (this._dancePhase % 16 === 0) {
        this._triggerJump();
      }
      if (this._dancePhase % 9 === 0) {
        this._swingArmPacket();
      }
      return;
    }

    if (this.mode === 'circle') {
      const target = this.modeTarget ? this._findNearbyPlayer(this.modeTarget) : this._findNearbyPlayer(null);
      const center = target ? target.position : (this._circleCenter || this.position);
      this._lookAtPoint(center.x, center.y, center.z, 0.55);
      const dist = Math.hypot(center.x - this.position.x, center.z - this.position.z);
      this.moveStrafe = 0.95;
      this.moveForward = clamp((dist - 3.0) * 0.45, -0.8, 0.85);
      this.wantSprint = dist > 5.5;
      if (Number(this.tick % 28n) === 0) this._triggerJump();
      return;
    }

    if (this.mode === 'play') {
      if (!this._playAnchor) this._playAnchor = { ...this.position };
      if (!this._playAction || Date.now() >= this._playAction.expiresAt) {
        this._setSneakInternal(false);
        this._playAction = this._pickNextPlayAction();
      }

      const act = this._playAction;
      act.ticks++;

      if (act.kind === 'sprint_hop') {
        this.yaw = lerpAngleDeg(this.yaw, act.targetYaw, 0.25);
        this.headYaw = this.yaw;
        this.pitch += (act.targetPitch - this.pitch) * 0.2;
        this.moveForward = 1;
        this.moveStrafe = 0;
        this.wantSprint = true;
        if (act.ticks % 13 === 1) this._triggerJump();
      } else if (act.kind === 'stroll_inspect') {
        this.yaw = lerpAngleDeg(this.yaw, act.targetYaw, 0.2);
        this.headYaw = this.yaw;
        this.pitch += (act.targetPitch - this.pitch) * 0.2;
        this.moveForward = act.ticks < 28 ? 0.85 : 0;
        this.moveStrafe = 0;
        this.wantSprint = false;
        if (act.ticks === 25 || act.ticks === 35) this._swingArmPacket();
      } else if (act.kind === 'social_greet') {
        const near = this._findNearestLivingEntity(16);
        if (!near) {
          act.expiresAt = 0;
          return;
        }
        this._lookAtPoint(near.eyePos.x, near.eyePos.y, near.eyePos.z, 0.4);
        const d = this._horizDistanceTo(near.eyePos);
        this.moveForward = d > 3.0 ? 0.9 : 0;
        this.moveStrafe = 0;
        this.wantSprint = d > 7.0;
        if (d <= 4.0) {
          if (act.ticks % 6 === 0) this._setSneakInternal(!this.isSneaking);
          if (act.ticks === 10 || act.ticks === 24) this._swingArmPacket();
        }
      } else if (act.kind === 'strafe_peek') {
        this.yaw = lerpAngleDeg(this.yaw, act.targetYaw, 0.22);
        this.headYaw = this.yaw;
        this.pitch += (act.targetPitch - this.pitch) * 0.2;
        this.moveForward = 0.2;
        this.moveStrafe = act.strafeDir;
        this.wantSprint = false;
        if (act.ticks === 12) this._swingArmPacket();
      } else {
        // breather
        this.yaw = lerpAngleDeg(this.yaw, act.targetYaw, 0.12);
        this.headYaw = this.yaw;
        this.pitch += (act.targetPitch - this.pitch) * 0.15;
        this.moveForward = 0;
        this.moveStrafe = 0;
        this.wantSprint = false;
      }
    }
  }

  _sendAuthInputTick() {
    if (!this.client || !this.inGame || this.isStopping) return;

    this.tick += 1n;
    this._updateBehaviorTick();

    let moveX = clamp(this.moveStrafe, -1, 1);
    let moveZ = clamp(this.moveForward, -1, 1);
    const mag = Math.hypot(moveX, moveZ);
    if (mag > 1) {
      moveX /= mag;
      moveZ /= mag;
    }

    const shouldSprint = this.wantSprint && moveZ > 0.5 && !this.isSneaking;
    const flags = [];

    if (this.pendingTeleportAck) {
      flags.push('handled_teleport');
      this.pendingTeleportAck = false;
    }

    if (shouldSprint && !this.isSprinting) {
      flags.push('start_sprinting');
      this.isSprinting = true;
    } else if (!shouldSprint && this.isSprinting) {
      flags.push('stop_sprinting');
      this.isSprinting = false;
    }
    if (this.isSprinting) {
      flags.push('sprinting', 'sprint_down');
    }

    if (moveZ > 0.1) flags.push('up');
    if (moveZ < -0.1) flags.push('down');
    if (moveX > 0.1) flags.push('left');
    if (moveX < -0.1) flags.push('right');
    if (moveZ > 0.1 && moveX > 0.1) flags.push('up_left');
    if (moveZ > 0.1 && moveX < -0.1) flags.push('up_right');

    if (this.jumpTicksRemaining > 0) {
      flags.push('jumping', 'jump_down');
      if (this.jumpStartedThisCycle) {
        flags.push('start_jumping');
        this.jumpStartedThisCycle = false;
      }
      this.jumpTicksRemaining--;
    }

    if (this.isSneaking) {
      flags.push('sneaking', 'sneak_down');
    }
    if (this._pendingSneakTransition === 'start') {
      flags.push('start_sneaking');
      this._pendingSneakTransition = null;
    } else if (this._pendingSneakTransition === 'stop') {
      flags.push('stop_sneaking');
      this._pendingSneakTransition = null;
    }

    if (this._pendingSwingFlag) {
      flags.push('missed_swing');
      this._pendingSwingFlag = false;
    }

    // Advance predicted position along look yaw so both BDS and GeyserMC register smooth motion
    const yawRad = (this.yaw * Math.PI) / 180;
    const pitchRad = (this.pitch * Math.PI) / 180;
    const forwardX = -Math.sin(yawRad);
    const forwardZ = Math.cos(yawRad);
    const leftX = Math.cos(yawRad);
    const leftZ = Math.sin(yawRad);

    const speed = this.isSneaking ? 0.065 : this.isSprinting ? 0.28 : 0.215;
    const dx = (forwardX * moveZ + leftX * moveX) * speed;
    const dz = (forwardZ * moveZ + leftZ * moveX) * speed;

    let dy = 0;
    if (this.velY !== 0 || this.position.y > this.groundY + 0.001) {
      const nextY = this.position.y + this.velY;
      if (nextY <= this.groundY) {
        dy = this.groundY - this.position.y;
        this.position.y = this.groundY;
        this.velY = 0;
      } else {
        dy = this.velY;
        this.position.y = nextY;
        this.velY = (this.velY - 0.08) * 0.98;
      }
    }

    this.position.x += dx;
    this.position.z += dz;

    // Auto-jump over 1-block obstacles if server collision keeps clamping horizontal progress
    if (mag > 0.45) {
      if (!this._progressSamplePos) {
        this._progressSamplePos = { x: this.position.x, z: this.position.z };
        this._progressSampleTicks = 0;
      } else {
        this._progressSampleTicks++;
        if (this._progressSampleTicks >= 10) {
          const moved = Math.hypot(
            this.position.x - this._progressSamplePos.x,
            this.position.z - this._progressSamplePos.z
          );
          if (moved < 0.3 && this.jumpTicksRemaining === 0) {
            this._triggerJump();
          }
          this._progressSamplePos = { x: this.position.x, z: this.position.z };
          this._progressSampleTicks = 0;
        }
      }
    } else {
      this._progressSamplePos = null;
      this._progressSampleTicks = 0;
    }

    let inputData;
    if (this.arrayInputData) {
      inputData = flags;
    } else {
      inputData = {};
      for (const f of flags) inputData[f] = true;
    }

    const cameraOrientation = {
      x: -Math.sin(yawRad) * Math.cos(pitchRad),
      y: -Math.sin(pitchRad),
      z: Math.cos(yawRad) * Math.cos(pitchRad),
    };

    try {
      this.client.queue('player_auth_input', {
        pitch: this.pitch,
        yaw: this.yaw,
        position: this.position,
        move_vector: { x: moveX, z: moveZ },
        head_yaw: this.headYaw,
        input_data: inputData,
        input_mode: 'mouse',
        play_mode: 'normal',
        interaction_model: 'crosshair',
        interact_rotation: { x: this.pitch, z: this.yaw },
        tick: this.tick,
        delta: { x: dx, y: dy, z: dz },
        transaction: undefined,
        item_stack_request: undefined,
        block_action: undefined,
        vehicle_rotation: undefined,
        predicted_vehicle: undefined,
        analogue_move_vector: { x: moveX, z: moveZ },
        camera_orientation: cameraOrientation,
        raw_move_vector: { x: moveX, z: moveZ },
      });
    } catch {}
  }

  _triggerJump() {
    this.jumpTicksRemaining = 4;
    this.jumpStartedThisCycle = true;
    if (Math.abs(this.position.y - this.groundY) < 0.08) {
      this.velY = 0.42;
    }
  }

  startAntiAfk() {
    this.stopAntiAfk();

    // Continuous 20 TPS server-authoritative input & behavior stream
    this.tickInterval = setInterval(() => this._sendAuthInputTick(), TICK_INTERVAL_MS);

    // Standard AFK jump every 5s when stationary (afk or look mode)
    this.jumpInterval = setInterval(() => {
      if (this.inGame && (this.mode === 'afk' || this.mode === 'look')) {
        this._triggerJump();
      }
    }, ANTI_AFK_INTERVAL_MS);

    // Standard AFK camera turn every 30s only in idle AFK mode
    this.lookInterval = setInterval(() => {
      if (this.inGame && this.mode === 'afk') {
        this.yaw = Math.random() * 360 - 180;
        this.headYaw = this.yaw;
        this.pitch = (Math.random() - 0.5) * 50;
      }
    }, 30_000);
  }

  stopAntiAfk() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.jumpInterval) { clearInterval(this.jumpInterval); this.jumpInterval = null; }
    if (this.lookInterval) { clearInterval(this.lookInterval); this.lookInterval = null; }
  }

  // ─── Commands & Fun Gameplay Modes ───────────────────────────────────────────

  _resetMotionState() {
    this.moveForward = 0;
    this.moveStrafe = 0;
    this.wantSprint = false;
    this._playAction = null;
    this._progressSamplePos = null;
    this._progressSampleTicks = 0;
    if (this.mode === 'dance' || this.mode === 'play') {
      this._setSneakInternal(false);
    }
  }

  stopActivity({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    this._resetMotionState();
    this.mode = 'afk';
    this.modeTarget = null;
    this._playAnchor = null;
    this._circleCenter = null;
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** returned to **AFK** mode`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  follow(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    // Toggle off if button clicked while already following without explicit query
    if (!playerQuery && this.mode === 'follow') {
      return this.stopActivity({ silent });
    }

    this._resetMotionState();

    const nearby = this._findNearbyPlayer(playerQuery);
    if (nearby) {
      this.mode = 'follow';
      this.modeTarget = nearby.username;
      const dist = this._horizDistanceTo(nearby.position).toFixed(1);
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

    const m = `**${name}** — no nearby players in render distance right now (try \`!follow <player>\` or walk closer)`;
    if (!silent) this.send(msg(m));
    return { ok: false, message: m };
  }

  come(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    const nearby = this._findNearbyPlayer(playerQuery);
    if (!nearby) {
      const targetDesc = playerQuery ? `**${playerQuery}**` : 'any player';
      const m = `**${name}** — can't see ${targetDesc} in render distance right now`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._resetMotionState();
    this.mode = 'come';
    this.modeTarget = nearby.username;
    const dist = this._horizDistanceTo(nearby.position).toFixed(1);
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** is heading over to **${nearby.username}** (${dist}m away)`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  togglePlay({ silent = false, forceOn = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    if (this.mode === 'play' && !forceOn) {
      return this.stopActivity({ silent });
    }

    this._resetMotionState();
    this.mode = 'play';
    this.modeTarget = null;
    this._playAnchor = { ...this.position };
    this._playAction = this._pickNextPlayAction();
    if (this.onStateChange) this.onStateChange();
    const m = `**${name}** started **Play Mode** — roaming around, sprint-jumping & greeting nearby players!`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  lookAtPlayer(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._resetMotionState();
    const nearby = this._findNearbyPlayer(playerQuery);
    this.mode = 'look';
    this.modeTarget = nearby ? nearby.username : playerQuery || null;
    if (this.onStateChange) this.onStateChange();
    const label = this.modeTarget ? `**${this.modeTarget}**` : 'nearby players & mobs';
    const m = `**${name}** is now watching ${label}`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  toggleDance({ silent = false, forceOn = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    if (this.mode === 'dance' && !forceOn) {
      return this.stopActivity({ silent });
    }

    this._resetMotionState();
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
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    this._resetMotionState();
    const nearby = this._findNearbyPlayer(playerQuery);
    this.mode = 'circle';
    this.modeTarget = nearby ? nearby.username : playerQuery || null;
    this._circleCenter = nearby ? { ...nearby.position } : { ...this.position };
    if (this.onStateChange) this.onStateChange();
    const label = this.modeTarget ? `**${this.modeTarget}**` : 'their spot';
    const m = `**${name}** is now orbiting around ${label}`;
    if (!silent) this.send(msg(m));
    return { ok: true, mode: this.mode, message: m };
  }

  hit(playerQuery = null, { silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }

    const targetPlayer = this._findNearbyPlayer(playerQuery);
    if (targetPlayer) {
      const dist = this._distanceTo(targetPlayer.position);
      this._lookAtPoint(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 1);
      if (dist <= 4.5) {
        this._attackEntityPacket(targetPlayer.runtimeId, targetPlayer.position);
        const m = `**${name}** punched **${targetPlayer.username}**`;
        if (!silent) this.send(msg(m));
        return { ok: true, message: m };
      }
      this._swingArmPacket();
      const m = `**${name}** waved at **${targetPlayer.username}** (${dist.toFixed(1)}m away)`;
      if (!silent) this.send(msg(m));
      return { ok: true, message: m };
    }

    if (!playerQuery) {
      const nearMob = this._findNearestLivingEntity(4.2);
      if (nearMob) {
        this._lookAtPoint(nearMob.eyePos.x, nearMob.eyePos.y, nearMob.eyePos.z, 1);
        this._attackEntityPacket(nearMob.runtimeId, nearMob.eyePos);
        const m = `**${name}** hit nearby **${nearMob.name}**`;
        if (!silent) this.send(msg(m));
        return { ok: true, message: m };
      }
    }

    this._swingArmPacket();
    const m = `**${name}** waved / swung their arm`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  spin({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game yet`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }
    this._triggerJump();
    this._spinTicksRemaining = 12;
    const m = `**${name}** did a 360° spin!`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  getPlayersInfo() {
    const self = this._selfLower();
    const nearby = [...this.trackedPlayers.values()]
      .filter((p) => p.username && p.username.toLowerCase() !== self)
      .map((p) => ({
        username: p.username,
        distance: Number(this._horizDistanceTo(p.position).toFixed(1)),
        x: Math.round(p.position.x),
        y: Math.round(p.position.y - 1.62),
        z: Math.round(p.position.z),
      }))
      .sort((a, b) => a.distance - b.distance);

    const nearbySet = new Set(nearby.map((p) => p.username.toLowerCase()));
    const farOnline = [...this.onlinePlayers.values()]
      .map((p) => p.username)
      .filter((u) => u && u.toLowerCase() !== self && !nearbySet.has(u.toLowerCase()));

    return { nearby, farOnline };
  }

  // ─── Chat & Basic Controls ───────────────────────────────────────────────────

  _sendCommand(commandStr) {
    if (!this.client || !this.inGame) return;
    const cmd = commandStr.startsWith('/') ? commandStr : `/${commandStr}`;
    try {
      this.client.queue('command_request', {
        command: cmd,
        origin: {
          type: 'player',
          uuid: this.client.profile?.uuid || '00000000-0000-0000-0000-000000000000',
          request_id: '',
          player_entity_id: this.uniqueEntityId || 0n,
        },
        internal: false,
        version: this.stringCmdVersion ? 'latest' : 38,
      });
    } catch {}
  }

  _sendChat(messageStr) {
    if (!this.client || !this.inGame) return;
    const sender = this.realUsername || this.client.username || this.options.username;
    const xuid = String(this.client.profile?.xuid ?? '');
    try {
      this.client.queue('text', {
        type: 'chat',
        category: 'authored',
        needs_translation: false,
        chat: '',
        whisper: '',
        announcement: '',
        source_name: sender,
        message: messageStr,
        xuid,
        platform_chat_id: '',
        has_filtered_message: false,
        filtered_message: '',
      });
    } catch {}
  }

  getCoords() {
    if (!this.inGame || !this.position) return null;
    return {
      x: Math.round(this.position.x),
      y: Math.round(this.position.y - 1.62),
      z: Math.round(this.position.z),
    };
  }

  getUptimeString() {
    if (!this.connectedAt) return null;
    return formatDuration(Date.now() - this.connectedAt);
  }

  jump({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game, cannot jump`;
      if (!silent) this.send(msg(m));
      return { ok: false, message: m };
    }
    this._triggerJump();
    const m = `**${name}** jumped`;
    if (!silent) this.send(msg(m));
    return { ok: true, message: m };
  }

  toggleSneak({ silent = false } = {}) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      const m = `**${name}** — not in-game, cannot toggle sneak`;
      if (!silent) this.send(msg(m));
      return { ok: false, sneaking: this.isSneaking, message: m };
    }
    this._setSneakInternal(!this.isSneaking);
    const m = `**${name}** sneak **${this.isSneaking ? 'ON' : 'OFF'}**`;
    if (!silent) this.send(msg(m));
    return { ok: true, sneaking: this.isSneaking, message: m };
  }

  say(text) {
    const name = this.realUsername || this.options.username;
    if (!this.inGame) {
      this.send(msg(`**${name}** — not in-game, cannot send message`));
      return;
    }
    const truncated = text.length > MC_CHAT_LIMIT ? text.slice(0, MC_CHAT_LIMIT) : text;
    if (truncated.startsWith('/')) {
      this._sendCommand(truncated);
    } else {
      this._sendChat(truncated);
    }
    this.send(msg(`**${name}** said: ${truncated}`));
  }

  stop() {
    this.isStopping = true;
    this.stopAntiAfk();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.connectAbort) {
      this.connectAbort.abort();
      this.connectAbort = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      c.removeAllListeners();
      try { c.disconnect('Client leaving', true); } catch {
        try { c.close(); } catch {}
      }
    }
    this.inGame = false;
    this.connectedAt = null;
    this.onlinePlayers.clear();
    this.trackedPlayers.clear();
    this.trackedEntities.clear();
    if (this.onStateChange) this.onStateChange();
  }
}
