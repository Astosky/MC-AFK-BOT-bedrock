import fs from 'fs';
import os from 'os';
import net, { isIP } from 'net';
import tls from 'tls';
import dns from 'dns';
import http from 'http';
import https from 'https';
import dgram from 'dgram';
import crypto from 'crypto';
import path from 'path';
import { once } from 'events';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Prefer IPv4 first so containers without IPv6 routing never stall on AAAA records
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older runtimes
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, '..', 'auth-cache', 'bedrock-server-keys.json');

const CANDIDATE_STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302, urls: 'stun:stun.l.google.com:19302' },
  { host: 'stun.cloudflare.com', port: 3478, urls: 'stun:stun.cloudflare.com:3478' },
];

// ─── RakNet backend initialization ────────────────────────────────────────────
// On Linux kernel 6.x (common on modern VPS, Bonto & Pterodactyl nodes),
// raknet-native ships a working N-API prebuild under prebuilds/linux-5-x64,
// while binding.js only checks the exact kernel major version (`linux-6-x64`).
// Load its built-in getFallbackPath() prebuild when available; otherwise fall
// back cleanly to pure-JS `jsp-raknet`.

function initRaknetBackend() {
  try {
    const rn = require('raknet-native');
    if (typeof rn?.RakClient === 'function' || typeof rn?.Client === 'function') {
      return 'raknet-native';
    }
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

// ─── Enhanced HTTP(S) Signalling (IPv4 fallback, redirects, self-signed TLS) ──

const TLS_CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const IPV6_UNREACHABLE_CODES = new Set([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAFNOSUPPORT',
  'EADDRNOTAVAIL',
]);

function singleHttpAttempt(targetUrl, { method = 'GET', headers = {}, body, signal, rejectUnauthorized = true, family } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname.replace(/^\[|\]$/g, ''),
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method,
      headers: {
        'user-agent': 'MCPE/NetherNet',
        accept: '*/*',
        ...headers,
        ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
      ...(isHttps ? { rejectUnauthorized, servername: isIP(targetUrl.hostname.replace(/^\[|\]$/g, '')) ? undefined : targetUrl.hostname } : {}),
      ...(family ? { family } : {}),
    };

    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(val);
    };

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) {
          req.destroy(new Error('HTTP signalling response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish(resolve, {
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (err) => finish(reject, err));
    });

    const onAbort = () => {
      const reason = signal?.reason || Object.assign(new Error('HTTP request timed out'), { code: 'ETIMEDOUT' });
      req.destroy(reason);
      finish(reject, reason);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    req.on('error', (err) => finish(reject, err));
    if (body != null) req.write(body);
    req.end();
  });
}

async function resilientHttpRequest(initialUrl, options = {}) {
  let currentUrl = new URL(initialUrl.toString());
  let tlsUntrusted = false;

  for (let redirects = 0; redirects <= 4; redirects++) {
    let res;
    try {
      res = await singleHttpAttempt(currentUrl, {
        ...options,
        rejectUnauthorized: !tlsUntrusted,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;

      // Retry over explicit IPv4 if container dual-stack hit an unrouted IPv6 address
      if (!options.family && IPV6_UNREACHABLE_CODES.has(err?.code)) {
        res = await singleHttpAttempt(currentUrl, {
          ...options,
          family: 4,
          rejectUnauthorized: !tlsUntrusted,
        });
      } else if (
        currentUrl.protocol === 'https:' &&
        !tlsUntrusted &&
        TLS_CERT_ERROR_CODES.has(err?.code)
      ) {
        // Self-signed BDS / Geyser TLS endpoint: allow TLS transport and enforce
        // cryptographic verifyServerIdentity + TOFU operator key pin instead.
        tlsUntrusted = true;
        res = await singleHttpAttempt(currentUrl, {
          ...options,
          rejectUnauthorized: false,
        });
      } else {
        throw err;
      }
    }

    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location && redirects < 4) {
      currentUrl = new URL(res.headers.location, currentUrl);
      if (res.status === 303 && options.method === 'POST') {
        options = { ...options, method: 'GET', body: undefined };
      }
      continue;
    }

    return { ...res, finalUrl: currentUrl, tlsUntrusted };
  }

  throw new Error('Too many HTTP redirects on NetherNet signalling endpoint');
}

function parseRemoteCandidatesFromSdp(sdp = '') {
  const results = [];
  for (const line of String(sdp).split(/\r?\n/)) {
    // a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type>
    const m = line.match(/^a=candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/i);
    if (m) {
      results.push({
        protocol: m[1].toLowerCase(),
        address: m[2],
        port: Number(m[3]),
        type: m[4].toLowerCase(),
      });
    }
  }
  return results;
}

// Patch `nethernet/src/signalling/http.js` BEFORE loading `nethernet` so both
// discovery (`pingHttp`) and SDP offer/answer (`exchangeOffer`) benefit from
// IPv4 fallback, redirect support, self-signed TLS + TOFU, and stage diagnostics.
const sdpIdentity = require('nethernet/src/signalling/sdpIdentity');
const nethernetHttpPath = require.resolve('nethernet/src/signalling/http.js');

function normalizeSignallingUrl(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error('HTTP signalling URL must be an HTTP(S) origin');
  }
  return url;
}

async function enhancedPingHttp(origin, { timeout = 4500, signal } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const baseUrl = normalizeSignallingUrl(origin);
  const joinUrl = new URL('/v1/join', baseUrl);

  const res = await resilientHttpRequest(joinUrl, { method: 'GET', signal: combined });
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`Nethernet HTTP discovery returned ${res.status}`);
    err.httpStatus = res.status;
    err.responseBody = res.body?.slice(0, 200) || '';
    throw err;
  }

  const raw = res.body || '';
  let parsed = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const err = new Error('Nethernet /v1/join returned non-JSON body');
      err.responseBody = raw.slice(0, 120);
      throw err;
    }
  }

  const resolvedOrigin = `${res.finalUrl.protocol}//${res.finalUrl.host}`;
  return { ...parsed, raw, resolvedOrigin, tlsUntrusted: res.tlsUntrusted };
}

async function enhancedExchangeOffer(client, signal) {
  const rtc = client.rtcConnection;
  const diag = (client.http._diagnostics = client.http._diagnostics || {});
  diag.stage = 'ice_gathering';

  signal.throwIfAborted();
  while (rtc.iceGatheringState !== 'complete') {
    await once(rtc, 'icegatheringstatechange', { signal });
  }
  signal.throwIfAborted();

  const localSdp = rtc.localDescription?.sdp || '';
  diag.localCandidateCount = localSdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')).length;

  if (!client.identity) {
    throw new Error('Nethernet HTTP offer requires a player identity');
  }

  const body = sdpIdentity.attachIdentity(localSdp, client.identity);
  const { url, serverKey, onServerKey } = client.http;
  diag.stage = 'http_post_offer';

  const postUrl = new URL(`/v1/join/${client.networkId}`, url);
  const res = await resilientHttpRequest(postUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body,
    signal,
  });

  diag.httpStatus = res.status;

  if (res.status === 401 || res.status === 403) {
    const err = new Error(
      `Server rejected offline login (HTTP ${res.status} on /v1/join — Microsoft/Xbox authentication required)`
    );
    err.httpStatus = res.status;
    err.authRequired = true;
    throw err;
  }

  if (res.status < 200 || res.status >= 300) {
    const snippet = (res.body || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const err = new Error(
      `Nethernet HTTP signalling returned ${res.status}${snippet ? ` (${snippet})` : ''}`
    );
    err.httpStatus = res.status;
    throw err;
  }

  const answer = res.body || '';
  if (!answer.startsWith('v=')) {
    const err = new Error(`Nethernet HTTP rejected the offer: ${answer.slice(0, 160)}`);
    if (/unauth|identity|token|forbidden|login/i.test(answer)) {
      err.authRequired = true;
    }
    throw err;
  }

  const verified = sdpIdentity.verifyServerIdentity(answer);
  const trustedViaTls = res.finalUrl.protocol === 'https:' && !res.tlsUntrusted;
  let trusted = serverKey ? serverKey === verified.fingerprint : trustedViaTls;
  if (!trusted && !serverKey && onServerKey) {
    trusted = (await onServerKey(verified.fingerprint, res.finalUrl.origin)) === true;
  }
  if (!trusted) {
    throw new Error(`Untrusted Nethernet server key ${verified.fingerprint}`);
  }

  diag.offerAccepted = true;
  diag.stage = 'webrtc_ice';
  diag.remoteCandidates = parseRemoteCandidatesFromSdp(verified.sdp);

  signal.throwIfAborted();
  return verified.sdp;
}

require.cache[nethernetHttpPath] = {
  id: nethernetHttpPath,
  filename: nethernetHttpPath,
  loaded: true,
  exports: {
    pingHttp: enhancedPingHttp,
    signallingUrl: normalizeSignallingUrl,
    exchangeOffer: enhancedExchangeOffer,
  },
};

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
const { Client: RawNethernetClient, ErrorCode: NethernetErrorCode } = require('nethernet');
const weriftBackend = require('nethernet/src/werift');

export const BEDROCK_CURRENT_VERSION = Options.CURRENT_VERSION; // e.g. '1.26.60'

// ─── Container-safe WebRTC PeerConnection & Outbound IPv4 + STUN Discovery ───
// Werift skips NICs named `veth*`, `tun*`, `tap*`, `utun*`, `vmnet*` and skips
// `169.254.x.x` link-local addresses unless explicitly configured, which leaves
// rootless/microVM containers (Bonto, Podman, Firecracker, Cloud Run) with zero
// local ICE sockets (`this.protocols = []`). Discover all real local IPv4s via
// both `os.networkInterfaces()` and a kernel UDP route lookup (`connect()`).

let cachedOutboundIpv4 = null;

async function detectContainerIpv4Addresses() {
  const found = new Set();

  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const info of entries || []) {
        const fam = info.family === 4 || info.family === 'IPv4';
        if (fam && !info.internal && info.address && info.address !== '0.0.0.0') {
          found.add(info.address);
        }
      }
    }
  } catch {
    // Ignore
  }

  if (cachedOutboundIpv4) {
    found.add(cachedOutboundIpv4);
  } else {
    try {
      const routedIp = await new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
          try { sock.close(); } catch {}
          resolve(null);
        }, 250);
        sock.once('error', () => {
          clearTimeout(timer);
          try { sock.close(); } catch {}
          resolve(null);
        });
        sock.connect(53, '1.1.1.1', () => {
          clearTimeout(timer);
          let addr = null;
          try { addr = sock.address()?.address; } catch {}
          try { sock.close(); } catch {}
          resolve(addr);
        });
      });
      if (routedIp && routedIp !== '0.0.0.0' && routedIp !== '127.0.0.1') {
        cachedOutboundIpv4 = routedIp;
        found.add(routedIp);
      }
    } catch {
      // Ignore
    }
  }

  return [...found];
}

let cachedStunServersPromise = null;

function probeSingleStunServer({ host, port, urls }, timeoutMs = 900) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const txId = crypto.randomBytes(12);
    // RFC 5389 20-byte Binding Request header
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); // Binding Request
    req.writeUInt16BE(0x0000, 2); // Length 0
    req.writeUInt32BE(0x2112a442, 4); // Magic Cookie
    txId.copy(req, 8);

    let done = false;
    const cleanup = () => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      return true;
    };

    const timer = setTimeout(() => {
      if (cleanup()) reject(new Error('STUN timeout'));
    }, timeoutMs);

    sock.once('error', (err) => {
      if (cleanup()) reject(err);
    });

    sock.on('message', (msg) => {
      if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.subarray(8, 20).equals(txId)) {
        if (cleanup()) resolve({ urls });
      }
    });

    sock.send(req, port, host, (err) => {
      if (err && cleanup()) reject(err);
    });
  });
}

async function resolveWorkingIceServers(isLocal) {
  if (isLocal) return [];
  if (!cachedStunServersPromise) {
    cachedStunServersPromise = Promise.any(
      CANDIDATE_STUN_SERVERS.map((s) => probeSingleStunServer(s, 900))
    )
      .then((winner) => [winner])
      .catch(() => []);
  }
  return cachedStunServersPromise;
}

const OrigWeriftPC = weriftBackend.RTCPeerConnection;
weriftBackend.RTCPeerConnection = class ContainerSafePeerConnection extends OrigWeriftPC {
  constructor(config = {}) {
    super({
      iceUseLinkLocalAddress: true,
      iceUseIpv4: true,
      iceUseIpv6: false,
      ...config,
    });
  }
};

// ─── Trust-On-First-Use (TOFU) operator key store for non-CA NetherNet ────────

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

// ─── Helpers & Java / Aternos Status Probe ────────────────────────────────────

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

function stripMcCodes(str = '') {
  return String(str).replace(/§[0-9a-fk-org]/gi, '').replace(/\s+/g, ' ').trim();
}

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  let byte = 0;
  do {
    if (offset + numRead >= buf.length) return null;
    byte = buf[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((byte & 0x80) !== 0);
  return { value: result, size: numRead };
}

function flattenChatComponent(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return desc;
  let out = desc.text || '';
  if (Array.isArray(desc.extra)) {
    out += desc.extra.map(flattenChatComponent).join('');
  }
  return out;
}

// Fast zero-dependency Minecraft TCP Server List Ping (checks Aternos Offline /
// Starting states and detects if a target is actually a Java-only server).
async function probeJavaServerStatus(host, timeoutMs = 2000) {
  if (!host || isLocalOrPrivateHost(host)) return null;

  let targetHost = host;
  let targetPort = 25565;
  try {
    const srv = await Promise.race([
      dns.promises.resolveSrv(`_minecraft._tcp.${host}`),
      new Promise((_, r) => setTimeout(() => r(new Error('srv timeout')), 900)),
    ]);
    if (Array.isArray(srv) && srv[0]?.name) {
      targetHost = srv[0].name.replace(/\.$/, '');
      targetPort = srv[0].port || 25565;
    }
  } catch {
    // No SRV record — use host:25565
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('error', () => finish(null));

    socket.once('connect', () => {
      try {
        const hostBuf = Buffer.from(host, 'utf8');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        const handshakeBody = Buffer.concat([
          writeVarInt(0x00), // Packet ID: Handshake
          writeVarInt(769),  // Protocol version (1.21.4)
          writeVarInt(hostBuf.length),
          hostBuf,
          portBuf,
          writeVarInt(1),    // Next state: Status
        ]);
        const handshakePacket = Buffer.concat([writeVarInt(handshakeBody.length), handshakeBody]);
        const statusReqPacket = Buffer.from([0x01, 0x00]);
        socket.write(Buffer.concat([handshakePacket, statusReqPacket]));
      } catch {
        finish(null);
      }
    });

    let acc = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      try {
        const pktLen = readVarInt(acc, 0);
        if (!pktLen || acc.length < pktLen.size + pktLen.value) return;
        const pktId = readVarInt(acc, pktLen.size);
        if (!pktId || pktId.value !== 0x00) return finish(null);
        const strLen = readVarInt(acc, pktLen.size + pktId.size);
        if (!strLen) return;
        const strStart = pktLen.size + pktId.size + strLen.size;
        if (acc.length < strStart + strLen.value) return;

        const jsonStr = acc.subarray(strStart, strStart + strLen.value).toString('utf8');
        const status = JSON.parse(jsonStr);
        const versionName = stripMcCodes(status?.version?.name || '');
        const protocol = Number(status?.version?.protocol ?? -1);
        const motd = stripMcCodes(flattenChatComponent(status?.description));
        const combined = `${versionName} ${motd}`;

        if (/offline/i.test(versionName) || /server is offline/i.test(motd)) {
          finish({ kind: 'offline', versionName, motd });
        } else if (/starting|preparing|loading|queue|saving|stopping/i.test(versionName)) {
          finish({ kind: 'starting', versionName, motd });
        } else if (protocol > 0 && !/aternos/i.test(versionName)) {
          finish({ kind: 'java_online', versionName: versionName || 'Java', protocol, motd });
        } else {
          finish({ kind: 'unknown', versionName, protocol, motd });
        }
      } catch {
        finish(null);
      }
    });
  });
}

function summarizeHttpDiscoveryFailure(host, port, httpsErr, httpErr) {
  const primary = httpsErr || httpErr;
  const status = httpsErr?.httpStatus || httpErr?.httpStatus;

  if (status === 404) {
    if (/\.aternos\.me$/i.test(host)) {
      return `HTTP 404 on ${host}:${port}/v1/join (Aternos server is offline, still booting, or not set up for Bedrock/Geyser)`;
    }
    return `HTTP 404 on ${host}:${port}/v1/join (server offline or NetherNet not enabled on port ${port})`;
  }
  if (status === 502 || status === 503 || status === 504) {
    return `HTTP ${status} on ${host}:${port}/v1/join (server is starting up or temporarily unavailable)`;
  }
  if (status) {
    return `HTTP ${status} on ${host}:${port}/v1/join`;
  }

  const code = primary?.code || primary?.cause?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const err = new Error(`Unknown host ${host} (DNS lookup failed)`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  if (code === 'ECONNREFUSED') {
    return `Port ${port} refused connection on ${host} (is the server started?)`;
  }
  if (code === 'ETIMEDOUT' || /timed? ?out|aborted/i.test(primary?.message || '')) {
    return `No response from ${host}:${port} over NetherNet HTTP or RakNet UDP (is the server online?)`;
  }

  return primary?.message || `No response from ${host}:${port}`;
}

// ─── Smart Bedrock Server Discovery (RakNet + NetherNet LAN + NetherNet HTTP) ─

export async function discoverBedrockServer({
  host,
  port = 19132,
  udpTimeoutMs = 1800,
  httpTimeoutMs = 4500,
  signal,
}) {
  // 1. Try UDP transports (RakNet on host:port + NetherNet LAN on local hosts)
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
  const urlHost = formatHostForUrl(host);
  const candidatePorts = [port];
  if (port !== 19132 && /\.aternos\.me$/i.test(host)) {
    candidatePorts.push(19132);
  }

  let httpsError = null;
  let httpError = null;

  for (const candidatePort of candidatePorts) {
    for (const proto of ['https', 'http']) {
      const origin = `${proto}://${urlHost}:${candidatePort}`;
      try {
        const data = await enhancedPingHttp(origin, { timeout: httpTimeoutMs, signal });
        return {
          reachable: true,
          transport: 'nethernet',
          signalling: 'http',
          url: data.resolvedOrigin || origin,
          port: candidatePort,
          version: resolveVersionFromProtocol(data.protocol),
          motd: data.name,
        };
      } catch (err) {
        signal?.throwIfAborted?.();
        if (proto === 'https') httpsError ??= err;
        else httpError ??= err;
      }
    }
  }

  // 3. Neither UDP nor HTTP /v1/join answered — run fast status check (Aternos Offline / Starting / Java-only)
  const javaProbe = await probeJavaServerStatus(host, 2000).catch(() => null);
  signal?.throwIfAborted?.();

  if (javaProbe?.kind === 'offline') {
    const err = new Error(`Server is currently Offline (${javaProbe.versionName || 'Offline'})`);
    err.serverOffline = true;
    throw err;
  }

  if (javaProbe?.kind === 'starting') {
    const err = new Error(`Server is still starting up (${javaProbe.versionName})`);
    err.serverStarting = true;
    throw err;
  }

  if (javaProbe?.kind === 'java_online') {
    const err = new Error(
      `${host} is online as Java Edition (${javaProbe.versionName}) without Bedrock/Geyser on port ${port}`
    );
    err.javaOnly = true;
    err.javaVersion = javaProbe.versionName;
    throw err;
  }

  const diagnostic = summarizeHttpDiscoveryFailure(host, port, httpsError, httpError);
  const gotHttpResponse = Boolean(httpsError?.httpStatus || httpError?.httpStatus);

  // On *.aternos.me or whenever an HTTP status code was received on the port,
  // RakNet is guaranteed not to be running — fail fast with the real diagnostic
  // instead of waiting 12s for a dummy RakNet timeout to hide the real error.
  if (/\.aternos\.me$/i.test(host) || gotHttpResponse) {
    throw new Error(diagnostic);
  }

  return {
    reachable: false,
    transport: 'raknet',
    port,
    version: Options.CURRENT_VERSION,
    diagnostic,
  };
}

// ─── HTTP NetherNet adapter for bedrock-protocol 3.61.0 ───────────────────────

function formatNethernetDisconnectReason(reason, diag) {
  const s = String(reason || '');
  if (/connecterror:37/i.test(s)) {
    const err = new Error('Server requires Microsoft/Xbox authentication (ErrorCode 37)');
    err.authRequired = true;
    return err;
  }

  if (diag?.offerAccepted) {
    const udpCand = diag.remoteCandidates?.find((c) => c.protocol === 'udp') || diag.remoteCandidates?.[0];
    const targetDesc = udpCand ? `${udpCand.address}:${udpCand.port}` : 'server UDP gameplay port';
    if (/connecterror:(5|8|9|14|15)|disconnected|closed/i.test(s)) {
      return new Error(
        `HTTP /v1/join succeeded, but WebRTC UDP to ${targetDesc} timed out (${s} — container firewall may block outbound UDP)`
      );
    }
  }

  if (/connecterror:(\d+)/i.test(s)) {
    const codeNum = Number(s.match(/connecterror:(\d+)/i)[1]);
    const codeName =
      Object.keys(NethernetErrorCode || {}).find((k) => NethernetErrorCode[k] === codeNum) || codeNum;
    return new Error(`NetherNet negotiation failed (${codeName})`);
  }

  return null;
}

class HttpNethernetConnection {
  constructor({ host, url, serverKey, onServerKey, iceServers, hostAddresses, responseTimeoutMs }) {
    this.onConnected = () => {};
    this.onCloseConnection = () => {};
    this.onEncapsulated = () => {};
    this.onError = () => {};

    const diagnostics = {};
    const isLoopback = !host || host === '127.0.0.1' || host.toLowerCase() === 'localhost';
    const additionalAddrs = isLoopback
      ? ['127.0.0.1', ...(hostAddresses || [])]
      : [...(hostAddresses || [])];

    this.diagnostics = diagnostics;
    this.nethernet = new RawNethernetClient(0n, host || '127.0.0.1', {
      webrtcBackend: 'werift',
      http: { url, serverKey, onServerKey, _diagnostics: diagnostics },
      iceServers,
      responseTimeoutMs,
      inactivityTimeoutMs: 12_000,
    });

    if (additionalAddrs.length > 0) {
      const baseWebrtc = this.nethernet.webrtc;
      this.nethernet.webrtc = {
        ...baseWebrtc,
        RTCPeerConnection: class ContainerHostPeerConnection extends baseWebrtc.RTCPeerConnection {
          constructor(cfg = {}) {
            super({
              iceAdditionalHostAddresses: additionalAddrs,
              iceUseLinkLocalAddress: true,
              iceUseIpv4: true,
              iceUseIpv6: false,
              ...cfg,
            });
          }
        },
      };
    }

    this.nethernet.on('connected', (conn) => {
      diagnostics.stage = 'connected';
      this.onConnected(conn);
    });
    this.nethernet.on('error', (err) => this.onError(err));
    this.nethernet.on('disconnect', (addr, reason) => {
      const richErr = formatNethernetDisconnectReason(reason ?? addr, diagnostics);
      if (richErr && diagnostics.stage !== 'connected') {
        this.onError(richErr);
      }
      this.onCloseConnection(reason ?? addr);
    });
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

async function createHttpNethernetBedrockClient(options, discovery) {
  const connectTimeout = options.connectTimeout || 22_000;
  const isLocal = isLocalOrPrivateHost(options.host);
  const [hostAddresses, workingStun] = await Promise.all([
    detectContainerIpv4Addresses(),
    options.nethernet?.iceServers !== undefined
      ? Promise.resolve(options.nethernet.iceServers)
      : resolveWorkingIceServers(isLocal),
  ]);

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

  const httpConn = new HttpNethernetConnection({
    host: options.host,
    url: discovery.url,
    serverKey: options.nethernet?.serverKey,
    onServerKey: options.nethernet?.onServerKey || approveServerKey,
    iceServers: workingStun,
    hostAddresses,
    responseTimeoutMs: connectTimeout,
  });

  client.connection = httpConn;
  client.connection.onError = (err) => client.onConnectionError(err);

  // Enrich generic 'Connect timed out' with the exact NetherNet HTTP / ICE stage
  const origOnConnectionError = client.onConnectionError.bind(client);
  client.onConnectionError = (err) => {
    if (err?.message === 'Connect timed out' && httpConn.diagnostics) {
      const d = httpConn.diagnostics;
      if (d.offerAccepted) {
        const udpCand = d.remoteCandidates?.find((c) => c.protocol === 'udp') || d.remoteCandidates?.[0];
        const target = udpCand ? `${udpCand.address}:${udpCand.port}` : `${options.host}`;
        err = new Error(
          `HTTP /v1/join succeeded, but WebRTC UDP to ${target} timed out (container host may block outbound UDP)`
        );
      } else if (d.stage) {
        err = new Error(`Connect timed out during ${d.stage}`);
      }
    }
    return origOnConnectionError(err);
  };

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
  return client;
}

// ─── Unified client factory ───────────────────────────────────────────────────

export async function connectBedrockClient(options, abortSignal, onBeforeConnect) {
  const discovery = await discoverBedrockServer({
    host: options.host,
    port: options.port || 19132,
    signal: abortSignal,
  });

  abortSignal?.throwIfAborted?.();

  const resolvedVersion = options.version || discovery.version || Options.CURRENT_VERSION;

  if (discovery.transport === 'nethernet' && discovery.signalling === 'http') {
    const client = await createHttpNethernetBedrockClient(
      { ...options, port: discovery.port, version: resolvedVersion },
      discovery
    );
    abortSignal?.throwIfAborted?.();
    if (onBeforeConnect) onBeforeConnect(client, discovery);
    client.connect();
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
    connectTimeout: options.connectTimeout || 10_000,
  });

  if (onBeforeConnect) onBeforeConnect(client, discovery);
  return { client, discovery };
}
