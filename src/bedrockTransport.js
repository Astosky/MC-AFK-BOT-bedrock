import fs from 'fs';
import path from 'path';
import { isIP } from 'net';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, '..', 'auth-cache', 'bedrock-server-keys.json');

const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// ─── RakNet backend initialization ────────────────────────────────────────────
// On Linux kernel 6.x (common on modern VPS & Pterodactyl nodes), raknet-native
// ships a working N-API prebuild under prebuilds/linux-5-x64/node-raknet.node,
// but its binding.js only checks the exact kernel major version (`linux-6-x64`).
// Load its built-in getFallbackPath() prebuild when available; otherwise fall
// back cleanly to pure-JS `jsp-raknet` (e.g. on ARM64 containers).

function initRaknetBackend() {
  try {
    require('raknet-native');
    return 'raknet-native';
  } catch {
    try {
      const helper = require('raknet-native/helpers/buildPath.js');
      const fallbackPath = helper.getFallbackPath?.();
      if (fallbackPath && fs.existsSync(fallbackPath)) {
        const nativeBindings = require(fallbackPath);
        const bindingModulePath = require.resolve('raknet-native/binding.js');
        require.cache[bindingModulePath] = {
          id: bindingModulePath,
          filename: bindingModulePath,
          loaded: true,
          exports: nativeBindings,
        };
        require('raknet-native');
        return 'raknet-native';
      }
    } catch {
      // Fall through to pure-JS jsp-raknet
    }
  }

  // Ensure internal bedrock-protocol calls to initRaknet('raknet-native') also
  // fall back to jsp-raknet when no native binary exists for this platform/arch.
  try {
    const rakPath = require.resolve('bedrock-protocol/src/rak.js');
    const origInitRaknet = require(rakPath);
    require.cache[rakPath].exports = (backend) => {
      if (!backend || backend === 'raknet-native') {
        return origInitRaknet('jsp-raknet');
      }
      return origInitRaknet(backend);
    };
  } catch {
    // Ignore if layout changes
  }

  return 'jsp-raknet';
}

export const PREFERRED_RAKNET_BACKEND = initRaknetBackend();

const bedrock = require('bedrock-protocol');
const { Client: BedrockClient } = require('bedrock-protocol/src/client');
const Options = require('bedrock-protocol/src/options');
const initRaknet = require('bedrock-protocol/src/rak');
const advertisement = require('bedrock-protocol/src/server/advertisement');
const { NethernetClient } = require('bedrock-protocol/src/nethernet');
const KeyExchange = require('bedrock-protocol/src/handshake/keyExchange');
const Login = require('bedrock-protocol/src/handshake/login');
const LoginVerify = require('bedrock-protocol/src/handshake/loginVerify');
const { sleep } = require('bedrock-protocol/src/datatypes/util');
const { Client: RawNethernetClient, pingHttp: discoverHttp } = require('nethernet');
const weriftBackend = require('nethernet/src/werift');

// Cloud containers / microVMs (e.g. Cloud Run, Firecracker, Pterodactyl NAT) may
// assign 169.254.x.x link-local NIC addresses which Werift skips unless enabled.
const OrigWeriftPC = weriftBackend.RTCPeerConnection;
weriftBackend.RTCPeerConnection = class ContainerSafePeerConnection extends OrigWeriftPC {
  constructor(config = {}) {
    super({
      iceUseLinkLocalAddress: true,
      ...config,
    });
  }
};

export const BEDROCK_CURRENT_VERSION = Options.CURRENT_VERSION; // e.g. '1.26.60'

// ─── Trust-On-First-Use (TOFU) operator key store for plain-HTTP NetherNet ────

function loadTrustedKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTrustedKeys(keys) {
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  } catch {
    // Ignore read-only filesystem errors
  }
}

function approveServerKey(fingerprint, origin) {
  const keys = loadTrustedKeys();
  if (keys[origin] !== fingerprint) {
    keys[origin] = fingerprint;
    saveTrustedKeys(keys);
  }
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLocalOrPrivateHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) {
    return true;
  }
  return false;
}

function formatHostForUrl(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function resolveVersionFromProtocol(protocol) {
  const num = Number(protocol);
  if (!num) return Options.CURRENT_VERSION;
  const matched = Object.keys(Options.Versions).find((v) => Options.Versions[v] === num);
  return matched || Options.CURRENT_VERSION;
}

// ─── Smart Bedrock Server Discovery (RakNet + NetherNet LAN + NetherNet HTTP) ─

export async function discoverBedrockServer({
  host,
  port = 19132,
  udpTimeoutMs = 2000,
  httpTimeoutMs = 4500,
  signal,
}) {
  // 1. Try UDP transports first (RakNet on host:port + NetherNet LAN on local hosts)
  const udpTransports = isLocalOrPrivateHost(host) ? ['raknet', 'nethernet'] : ['raknet'];
  const udpController = new AbortController();
  const udpSignal = signal ? AbortSignal.any([signal, udpController.signal]) : udpController.signal;

  try {
    const ad = await Promise.any(
      udpTransports.map(async (selected) => {
        if (selected === 'nethernet') {
          const con = new NethernetClient({ host });
          try {
            const res = await con.ping(udpTimeoutMs, { signal: udpSignal });
            return { ...res, transport: 'nethernet', signalling: 'lan' };
          } finally {
            try { con.close(); } catch {}
          }
        } else {
          const { RakClient } = initRaknet(PREFERRED_RAKNET_BACKEND);
          const con = new RakClient({ host, port, useWorkers: false });
          try {
            const raw = await con.ping(udpTimeoutMs, { signal: udpSignal });
            const rawStr = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
            return { ...advertisement.fromServerName(rawStr), transport: 'raknet' };
          } finally {
            try { con.close(); } catch {}
          }
        }
      })
    );

    const protocol = ad.transport === 'nethernet' && ad.version === 4 ? undefined : ad.protocol;
    return {
      reachable: true,
      transport: ad.transport,
      signalling: ad.signalling,
      networkId: ad.networkId,
      port: ad.portV4 || port,
      version: resolveVersionFromProtocol(protocol),
      motd: ad.motd,
    };
  } catch {
    // UDP did not respond — proceed to NetherNet HTTP(S) /v1/join discovery (Bedrock 26.50+ / 26.60+)
  } finally {
    udpController.abort();
  }

  signal?.throwIfAborted?.();

  // 2. Try NetherNet HTTP(S) discovery (`GET /v1/join`)
  // Try HTTPS first (for domains with TLS such as Aternos / reverse-proxied servers),
  // then plain HTTP (default built-in BDS / Geyser signalling).
  // Also try default port 19132 as fallback on *.aternos.me if an old custom port was supplied.
  const urlHost = formatHostForUrl(host);
  const candidatePorts = [port];
  if (port !== 19132 && /\.aternos\.me$/i.test(host)) {
    candidatePorts.push(19132);
  }

  let lastHttpError = null;
  for (const candidatePort of candidatePorts) {
    for (const proto of ['https', 'http']) {
      const origin = `${proto}://${urlHost}:${candidatePort}`;
      try {
        const data = await discoverHttp(origin, { timeout: httpTimeoutMs, signal });
        return {
          reachable: true,
          transport: 'nethernet',
          signalling: 'http',
          url: origin,
          port: candidatePort,
          version: resolveVersionFromProtocol(data.protocol),
          motd: data.name,
        };
      } catch (err) {
        signal?.throwIfAborted?.();
        lastHttpError = err;
      }
    }
  }

  // 3. Neither UDP nor HTTP discovery answered
  return {
    reachable: false,
    transport: 'raknet',
    port,
    version: Options.CURRENT_VERSION,
    error: lastHttpError,
  };
}

// ─── HTTP NetherNet adapter for bedrock-protocol 3.61.0 ───────────────────────

class HttpNethernetConnection {
  constructor({ host, url, serverKey, onServerKey, iceServers, responseTimeoutMs }) {
    this.onConnected = () => {};
    this.onCloseConnection = () => {};
    this.onEncapsulated = () => {};
    this.onError = () => {};

    const isLoopback = !host || host === '127.0.0.1' || host.toLowerCase() === 'localhost';
    this.nethernet = new RawNethernetClient(0n, host || '127.0.0.1', {
      webrtcBackend: 'werift',
      http: { url, serverKey, onServerKey },
      iceServers,
      responseTimeoutMs,
    });
    if (isLoopback) {
      const baseWebrtc = this.nethernet.webrtc;
      this.nethernet.webrtc = {
        ...baseWebrtc,
        RTCPeerConnection: class LoopbackPeerConnection extends baseWebrtc.RTCPeerConnection {
          constructor(cfg = {}) {
            super({ iceAdditionalHostAddresses: ['127.0.0.1'], ...cfg });
          }
        },
      };
    }

    this.nethernet.on('connected', (conn) => this.onConnected(conn));
    this.nethernet.on('error', (err) => this.onError(err));
    this.nethernet.on('disconnect', (addr, reason) => this.onCloseConnection(reason ?? addr));
    this.nethernet.on('encapsulated', (data, addr) => this.onEncapsulated({ buffer: data }, addr));
  }

  async connect() {
    await this.nethernet.connect();
  }

  sendReliable(data) {
    this.nethernet.send(data);
  }

  close() {
    this.nethernet.close();
  }
}

function wireStandardPostConnectHandlers(client) {
  client.on('network_stack_latency', (packet) => {
    if (packet.needs_response) {
      client.queue('network_stack_latency', { timestamp: packet.timestamp, needs_response: false });
    }
  });

  const completeResourcePacks = () =>
    client.write('resource_pack_client_response', {
      response_status: 'completed',
      response_status_name: 'resourcepackstackfinished',
      resourcepackids: [],
    });

  client.once('resource_packs_info', () => {
    completeResourcePacks();
    client.once('resource_pack_stack', completeResourcePacks);
    client.queue('client_cache_status', { enabled: false });

    if (client.versionLessThanOrEqualTo('1.20.80')) {
      client.queue('tick_sync', { request_time: BigInt(Date.now()), response_time: 0n });
    }

    sleep(500).then(() => {
      if (!client._closed) {
        client.queue('request_chunk_radius', { chunk_radius: client.viewDistance || 10 });
      }
    });
  });
}

function createHttpNethernetBedrockClient(options, discovery) {
  const connectTimeout = options.connectTimeout || 20_000;
  const client = new BedrockClient({
    port: discovery.port,
    ...options,
    version: options.version || discovery.version || Options.CURRENT_VERSION,
    transport: 'nethernet',
    skipPing: true,
    connectTimeout,
    delayedInit: true,
  });

  client.options.nethernet = {
    ...client.options.nethernet,
    signalling: 'http',
    url: discovery.url,
  };

  // HTTP NetherNet does not require a pre-shared remote networkId
  client.validateOptions = () => Options.validateOptions(client.options);

  // Initialize protocol serializers & auth/handshake helpers
  client.validateOptions();
  client.compressionAlgorithm = client.versionGreaterThanOrEqualTo('1.19.30') ? 'none' : 'deflate';
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
  client.serializer = createSerializer(client.options.version);
  client.deserializer = createDeserializer(client.options.version);
  client._loadFeatures();

  KeyExchange(client);
  Login(client, null, client.options);
  LoginVerify(client, null, client.options);

  client.nethernet = {};
  client.batchHeader = null;
  client.disableEncryption = true;

  const iceServers =
    options.nethernet?.iceServers ??
    (isLocalOrPrivateHost(options.host) ? [] : DEFAULT_STUN_SERVERS);

  client.connection = new HttpNethernetConnection({
    host: options.host,
    url: discovery.url,
    serverKey: options.nethernet?.serverKey,
    onServerKey: options.nethernet?.onServerKey || approveServerKey,
    iceServers,
    responseTimeoutMs: connectTimeout,
  });

  client.connection.onError = (err) => client.onConnectionError(err);

  // Offline HTTP NetherNet still requires a self-signed OIDC multiplayerToken
  // on the SDP offer (`a=identity:`) before `connection.connect()` runs.
  const origInnerConnect = client._connect;
  client._connect = (sessionData) => {
    if (client._closed) return;
    if (client.options.offline && !client.multiplayerToken) {
      client.createClientChain(null, true);
    }
    origInnerConnect(sessionData);
  };

  wireStandardPostConnectHandlers(client);
  client.connect();
  return client;
}

// ─── Unified client factory ───────────────────────────────────────────────────

export async function connectBedrockClient(options, abortSignal) {
  const discovery = await discoverBedrockServer({
    host: options.host,
    port: options.port || 19132,
    signal: abortSignal,
  });

  abortSignal?.throwIfAborted?.();

  const resolvedVersion = options.version || discovery.version || Options.CURRENT_VERSION;

  if (discovery.transport === 'nethernet' && discovery.signalling === 'http') {
    const client = createHttpNethernetBedrockClient(
      { ...options, port: discovery.port, version: resolvedVersion },
      discovery
    );
    return { client, discovery };
  }

  const client = bedrock.createClient({
    ...options,
    port: discovery.port,
    version: resolvedVersion,
    transport: discovery.transport,
    nethernet:
      discovery.transport === 'nethernet'
        ? { signalling: 'lan', networkId: discovery.networkId }
        : undefined,
    skipPing: true,
    followPort: false,
    raknetBackend: PREFERRED_RAKNET_BACKEND,
    useRaknetWorkers: PREFERRED_RAKNET_BACKEND !== 'jsp-raknet',
    connectTimeout: options.connectTimeout || 12_000,
  });

  return { client, discovery };
}
