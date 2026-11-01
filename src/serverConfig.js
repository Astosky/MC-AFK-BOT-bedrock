import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.join(__dirname, '..', 'auth-cache');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'server-settings.json');

// Sanitize Discord markdown links, <http://...>, schemes, and split host[:port]
export function parseServerAddress(raw, defaultPort = 19132) {
  if (!raw) return null;
  let cleaned = String(raw).trim();

  // Extract target from markdown [label](url) if pasted
  const mdMatch = cleaned.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (mdMatch) cleaned = mdMatch[1];

  cleaned = cleaned
    .replace(/^<+|>+$/g, '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();

  if (!cleaned) return null;

  let host = cleaned;
  let port = defaultPort;

  // IPv6 [::1]:19132
  const ipv6Match = cleaned.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    host = ipv6Match[1];
    if (ipv6Match[2]) port = parseInt(ipv6Match[2], 10);
  } else {
    const colonIdx = cleaned.lastIndexOf(':');
    if (colonIdx > 0 && cleaned.indexOf(':') === colonIdx) {
      const maybePort = cleaned.slice(colonIdx + 1);
      host = cleaned.slice(0, colonIdx);
      if (/^\d+$/.test(maybePort)) {
        const parsed = parseInt(maybePort, 10);
        if (parsed >= 1 && parsed <= 65535) port = parsed;
      } else {
        return null;
      }
    }
  }

  if (!host || /\s/.test(host)) return null;
  return { host, port };
}

// Distinguish a server address (domain / IPv4 / IPv6 / host:port / localhost)
// from a Minecraft username like "AFKBot" or "My Bot".
export function looksLikeServerAddress(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s || /\s/.test(s)) return false;
  if (/^\[([^\]]+)\]/.test(s)) return true;
  if (/^[a-zA-Z]+:\/\//.test(s)) return true;
  if (s.includes('.') || s.includes(':')) return true;
  if (s.toLowerCase() === 'localhost') return true;
  return false;
}

function parseEnvDefaultServer() {
  const raw = process.env.DEFAULT_SERVER?.trim();
  if (!raw) return null;

  let edition = (process.env.DEFAULT_EDITION || 'bedrock').trim().toLowerCase();
  let addrPart = raw;

  const prefixMatch = raw.match(/^(bedrock|be|java|je)[:\s]+(.+)$/i);
  if (prefixMatch) {
    const p = prefixMatch[1].toLowerCase();
    edition = p === 'java' || p === 'je' ? 'java' : 'bedrock';
    addrPart = prefixMatch[2].trim();
  } else if (edition !== 'java') {
    edition = 'bedrock';
  }

  const defaultPort = edition === 'java' ? 25565 : 19132;
  const parsed = parseServerAddress(addrPart, defaultPort);
  if (!parsed) return null;

  return { edition, host: parsed.host, port: parsed.port };
}

function loadSettingsStore() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      return {
        defaultServer: data.defaultServer || null,
        guilds: data.guilds && typeof data.guilds === 'object' ? data.guilds : {},
      };
    }
  } catch {
    // Not created yet
  }
  return { defaultServer: null, guilds: {} };
}

function saveSettingsStore(store) {
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2));
  } catch {
    // Ignore read-only filesystem errors
  }
}

export function getDefaultServer(guildId) {
  const store = loadSettingsStore();
  if (guildId && store.guilds[guildId]) {
    return store.guilds[guildId];
  }
  if (store.defaultServer) {
    return store.defaultServer;
  }
  return parseEnvDefaultServer();
}

export function getAnyDefaultServer() {
  const store = loadSettingsStore();
  if (store.defaultServer) return store.defaultServer;
  const firstGuild = Object.values(store.guilds)[0];
  if (firstGuild) return firstGuild;
  return parseEnvDefaultServer();
}

export function setDefaultServer(guildId, { edition = 'bedrock', host, port }) {
  const normalized = {
    edition: edition === 'java' ? 'java' : 'bedrock',
    host: String(host).trim(),
    port: Number(port) || (edition === 'java' ? 25565 : 19132),
  };
  const store = loadSettingsStore();
  store.defaultServer = normalized;
  if (guildId) {
    store.guilds[guildId] = normalized;
  }
  saveSettingsStore(store);
  return normalized;
}

export function clearDefaultServer(guildId) {
  const store = loadSettingsStore();
  if (guildId) {
    delete store.guilds[guildId];
  }
  store.defaultServer = null;
  saveSettingsStore(store);
}
