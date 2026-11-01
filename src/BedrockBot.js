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
  buildBotControlRow,
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

function stripFormatting(str = '') {
  return String(str).replace(/§[0-9a-fk-org]/gi, '').trim();
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
    this.pitch = 0;
    this.yaw = 0;
    this.headYaw = 0;
    this.tick = 0n;
    this.jumpTicksRemaining = 0;
    this.jumpStartedThisCycle = false;
    this.pendingTeleportAck = false;
    this.arrayInputData = true;
    this.stringCmdVersion = true;

    this.authPassword = authPassword || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  get isOnline() {
    return this.inGame;
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
        this.options.username, // Discord user ID — stable unique cache key
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
  }

  _handleDiscoveryOrAuthError(err) {
    const name = this.realUsername || this.options.username;

    if (err?.code === 'ENOTFOUND') {
      this._failFatally(
        msg(`**${name}** — unknown host **${this.options.host}**\n-# DNS lookup failed (ENOTFOUND) · bot removed`)
      );
      return true;
    }

    // If the bot had not yet spawned once and the server is definitively Offline,
    // fail immediately with a clear message instead of locking the username for 5 retries.
    if (err?.serverOffline && !this.spawnedOnce) {
      this._failFatally(
        msgSections(
          `**${name}** — **${this.options.host}** is currently **Offline**`,
          `-# Start your server first, then run \`!join ${this.options.host}:${this.options.port} ${this.options.username}\` · bot removed`
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
          conLog: null, // Silence noisy stdout logs on Pterodactyl / Bonto
        },
        this.connectAbort.signal,
        (client, discovery) => {
          this.client = client;
          this.options.port = discovery.port || this.options.port;
          this.serverVersion = client.options.version || discovery.version || BEDROCK_CURRENT_VERSION;
          this.transportLabel =
            discovery.transport === 'nethernet'
              ? `NetherNet${discovery.signalling === 'http' ? '/HTTP' : ''}`
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
        }
        if (packet.rotation) {
          this.pitch = Number(packet.rotation.x) || 0;
          this.yaw = Number(packet.rotation.z) || 0;
          this.headYaw = this.yaw;
        }
        if (packet.current_tick != null) {
          this.tick = BigInt(packet.current_tick);
        }
      } catch {
        // Keep safe defaults
      }
    });

    client.on('spawn', () => {
      if (this.isStopping || this.isFatal) return;

      this.inGame = true;
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.serverIsStarting = false;
      this.isDisconnecting = false;
      this.lastErrorReason = null;

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
          `**${name}** connected to **${this.options.host}:${this.options.port}**\n-# Bedrock ${this.serverVersion} · ${this.transportLabel}`
        )
      );
      c.addSeparatorComponents(thinDivider());
      c.addActionRowComponents(
        buildBotControlRow(this.botId, { isOnline: true, isSneaking: this.isSneaking })
      );

      this.send({ components: [c], flags: MessageFlags.IsComponentsV2 });
      this.startAntiAfk();
    });

    // Keep position synchronized with server teleports & physics corrections
    client.on('move_player', (packet) => {
      if (!this.client || this.isStopping) return;
      if (String(packet.runtime_id) === String(this.runtimeEntityId)) {
        if (packet.position) {
          this.position = {
            x: Number(packet.position.x) || 0,
            y: Number(packet.position.y) || 0,
            z: Number(packet.position.z) || 0,
          };
        }
        if (typeof packet.pitch === 'number') this.pitch = packet.pitch;
        if (typeof packet.yaw === 'number') this.yaw = packet.yaw;
        if (typeof packet.head_yaw === 'number') this.headYaw = packet.head_yaw;
        if (packet.mode === 'teleport') {
          this.pendingTeleportAck = true;
        }
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
      }
    });

    // Auto-respawn if killed while AFK
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

      // Permanent auth mismatch: server has online-mode=true (Cracked disabled)
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
      // Do not overwrite an already-captured discovery diagnostic with a generic fallback timeout
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

  // ─── Reconnect & Anti-AFK ────────────────────────────────────────────────────

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

  _sendAuthInputTick() {
    if (!this.client || !this.inGame || this.isStopping) return;

    this.tick += 1n;

    const flags = [];
    if (this.pendingTeleportAck) {
      flags.push('handled_teleport');
      this.pendingTeleportAck = false;
    }
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

    let inputData;
    if (this.arrayInputData) {
      inputData = flags;
    } else {
      inputData = {};
      for (const f of flags) inputData[f] = true;
    }

    const yawRad = (this.yaw * Math.PI) / 180;
    const pitchRad = (this.pitch * Math.PI) / 180;
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
        move_vector: { x: 0, z: 0 },
        head_yaw: this.headYaw,
        input_data: inputData,
        input_mode: 'mouse',
        play_mode: 'normal',
        interaction_model: 'crosshair',
        interact_rotation: { x: this.pitch, z: this.yaw },
        tick: this.tick,
        delta: { x: 0, y: 0, z: 0 },
        transaction: undefined,
        item_stack_request: undefined,
        block_action: undefined,
        vehicle_rotation: undefined,
        predicted_vehicle: undefined,
        analogue_move_vector: { x: 0, z: 0 },
        camera_orientation: cameraOrientation,
        raw_move_vector: { x: 0, z: 0 },
      });
    } catch {
      // Ignore transient queue errors during disconnect
    }
  }

  _triggerJump() {
    this.jumpTicksRemaining = 4;
    this.jumpStartedThisCycle = true;
  }

  startAntiAfk() {
    this.stopAntiAfk();

    // Continuous 20 TPS server-authoritative input stream
    this.tickInterval = setInterval(() => this._sendAuthInputTick(), TICK_INTERVAL_MS);

    // Jump every 5 seconds
    this.jumpInterval = setInterval(() => {
      if (this.inGame) this._triggerJump();
    }, ANTI_AFK_INTERVAL_MS);

    // Rotate camera every 30 seconds (in degrees for Bedrock)
    this.lookInterval = setInterval(() => {
      if (this.inGame) {
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

  // ─── Actions ─────────────────────────────────────────────────────────────────

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
    // Bedrock player_position.y is eye level (~1.62 above feet)
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
    this.isSneaking = !this.isSneaking;
    this._pendingSneakTransition = this.isSneaking ? 'start' : 'stop';
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
    if (this.onStateChange) this.onStateChange();
  }
}
