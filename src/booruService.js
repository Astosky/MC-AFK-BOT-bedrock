// Made by Asto

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AttachmentBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from 'discord.js';
import {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  msg,
  thinDivider,
  text,
  button,
  actionRow,
} from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Write runtime state to .dat so nodemon's default *.json watcher never kills the bot mid-command!
// Still reads legacy booru-config.json seamlessly so already-saved keys keep working.
const CONFIG_PATH = path.join(__dirname, '..', 'auth-cache', 'booru-config.dat');
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'auth-cache', 'booru-config.json');

const API_USER_AGENT = 'AstoBot/2.2 (Discord Bot; +https://github.com/Astosky/MC-AFK-BOT-bedrock)';
const CDN_USER_AGENT = 'curl/8.7.1';
// Unboosted Discord servers cap uploads at 10 MB; stay safely under at 8.5 MB
const MAX_UPLOAD_BYTES = Math.floor(8.5 * 1024 * 1024);
const API_TIMEOUT_MS = 8_000;
const MEDIA_TIMEOUT_MS = 6_500;
const MAX_SEEN_HISTORY = 600;

// Keep to static & animated images so Discord MediaGallery renders every post cleanly & fast
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
]);

// Friendly tag synonyms when users type plain English words that return 0 booru hits
const COMMON_TAG_FALLBACKS = {
  girl: '1girl',
  woman: '1girl',
  boy: '1boy',
  man: '1boy',
  girls: 'multiple_girls',
  women: 'multiple_girls',
  boys: 'multiple_boys',
  men: 'multiple_boys',
};

// Mandatory safety blocklist — blocks illegal, minor/underage, non-consensual, and extreme tags
const BLOCKED_TAGS = new Set([
  'loli',
  'lolicon',
  'shota',
  'shotacon',
  'toddlercon',
  'toddler',
  'underage',
  'child',
  'children',
  'preteen',
  'kiddy',
  'infant',
  'baby',
  'young',
  'minor',
  'cub',
  'foalcon',
  'bestiality',
  'zoophilia',
  'gore',
  'guro',
  'snuff',
  'scat',
  'necrophilia',
  'real_person',
  'deepfake',
]);

export const BOORU_SITES = {
  gelbooru: {
    id: 'gelbooru',
    label: 'Gelbooru',
    nsfwOnly: false,
    requiresKey: true,
    referer: 'https://gelbooru.com/',
    keyHelpUrl: 'https://gelbooru.com/index.php?page=account&s=options',
  },
  r34: {
    id: 'r34',
    label: 'Rule34',
    nsfwOnly: false,
    requiresKey: true,
    referer: 'https://rule34.xxx/',
    keyHelpUrl: 'https://rule34.xxx/index.php?page=account&s=options',
  },
  safebooru: {
    id: 'safebooru',
    label: 'Safebooru',
    nsfwOnly: false,
    requiresKey: false,
    referer: 'https://safebooru.org/',
  },
  danbooru: {
    id: 'danbooru',
    label: 'Danbooru',
    nsfwOnly: false,
    requiresKey: false,
    referer: 'https://danbooru.donmai.us/',
  },
  konachan: {
    id: 'konachan',
    label: 'Konachan',
    nsfwOnly: false,
    requiresKey: false,
    referer: 'https://konachan.net/',
  },
  yandere: {
    id: 'yandere',
    label: 'Yande.re',
    nsfwOnly: false,
    requiresKey: false,
    referer: 'https://yande.re/',
  },
  tbib: {
    id: 'tbib',
    label: 'TBIB',
    nsfwOnly: false,
    requiresKey: false,
    referer: 'https://tbib.org/',
  },
};

const SITE_ALIASES = {
  gelbooru: 'gelbooru',
  gelbouru: 'gelbooru',
  gelborou: 'gelbooru',
  gelboru: 'gelbooru',
  gel: 'gelbooru',
  gb: 'gelbooru',
  r34: 'r34',
  rule34: 'r34',
  r34xxx: 'r34',
  safebooru: 'safebooru',
  safe: 'safebooru',
  sb: 'safebooru',
  danbooru: 'danbooru',
  dan: 'danbooru',
  db: 'danbooru',
  konachan: 'konachan',
  kona: 'konachan',
  yandere: 'yandere',
  yan: 'yandere',
  tbib: 'tbib',
};

export function resolveBooruSite(raw = '') {
  const key = SITE_ALIASES[String(raw || '').trim().toLowerCase()];
  return key ? BOORU_SITES[key] : null;
}

// ─── Config & In-Memory Seen History ─────────────────────────────────────────

const seenMemory = new Map();

function readConfig() {
  const mergedKeys = {};
  for (const filePath of [LEGACY_CONFIG_PATH, CONFIG_PATH]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.keys && typeof parsed.keys === 'object') {
        for (const [k, v] of Object.entries(parsed.keys)) {
          if (v === null) delete mergedKeys[k];
          else mergedKeys[k] = v;
        }
      }
    } catch {
      // Ignore unreadable file
    }
  }
  return { keys: mergedKeys };
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ keys: cfg.keys || {} }, null, 2), 'utf8');
}

function isValidCredPair(userId, apiKey) {
  const uid = String(userId || '').trim();
  const key = String(apiKey || '').trim();
  if (!/^\d+$/.test(uid)) return false;
  if (key.length < 16 || key.includes('&') || key.includes('=')) return false;
  return true;
}

export function getBooruCredentials(siteId) {
  const cfg = readConfig();
  const stored = cfg.keys?.[siteId];
  if (stored?.userId && stored?.apiKey && isValidCredPair(stored.userId, stored.apiKey)) {
    return { userId: String(stored.userId).trim(), apiKey: String(stored.apiKey).trim() };
  }

  if (siteId === 'gelbooru' && process.env.GELBOORU_USER_ID && process.env.GELBOORU_API_KEY) {
    const uid = process.env.GELBOORU_USER_ID.trim();
    const key = process.env.GELBOORU_API_KEY.trim();
    if (isValidCredPair(uid, key)) return { userId: uid, apiKey: key };
  }
  if (siteId === 'r34' && process.env.R34_USER_ID && process.env.R34_API_KEY) {
    const uid = process.env.R34_USER_ID.trim();
    const key = process.env.R34_API_KEY.trim();
    if (isValidCredPair(uid, key)) return { userId: uid, apiKey: key };
  }

  return null;
}

export function parseCredentialInput(rawTokens = []) {
  const joined = rawTokens.join(' ').trim();
  if (!joined) return { error: 'missing' };

  if (/api_key\s*=|user_id\s*=/i.test(joined)) {
    const keyMatch = joined.match(/[?&]?api_key=([^&\s]+)/i);
    const uidMatch = joined.match(/[?&]?user_id=([^&\s]+)/i);
    const extractedKey = keyMatch ? keyMatch[1].trim() : '';
    const extractedUid = uidMatch ? uidMatch[1].trim() : '';

    if (!extractedKey) {
      return {
        error: 'empty_api_key',
        partialUserId: /^\d+$/.test(extractedUid) ? extractedUid : null,
      };
    }
    if (!/^\d+$/.test(extractedUid)) {
      return { error: 'non_numeric_user_id' };
    }
    return { userId: extractedUid, apiKey: extractedKey };
  }

  const cleaned = rawTokens.map((t) => String(t).trim()).filter(Boolean);
  if (cleaned.length >= 2) {
    const numToken = cleaned.find((t) => /^\d+$/.test(t));
    const keyToken = cleaned.find((t) => t !== numToken && t.length >= 16 && !t.includes('='));
    if (!numToken) {
      return { error: 'non_numeric_user_id' };
    }
    if (!keyToken) {
      return { error: 'empty_api_key', partialUserId: numToken };
    }
    return { userId: numToken, apiKey: keyToken };
  }

  return { error: 'invalid_format' };
}

export async function verifyBooruCredentials(site, { userId, apiKey }) {
  if (!site?.requiresKey) return { ok: true };
  const baseUrl =
    site.id === 'gelbooru'
      ? 'https://gelbooru.com/index.php'
      : 'https://api.rule34.xxx/index.php';

  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: '1',
    user_id: String(userId).trim(),
    api_key: String(apiKey).trim(),
  });

  try {
    const { status, text: raw } = await fetchTextWithTimeout(`${baseUrl}?${params.toString()}`, {}, API_TIMEOUT_MS);
    if (
      status === 401 ||
      status === 403 ||
      /missing authentication|authentication required|invalid api key/i.test(raw)
    ) {
      return {
        ok: false,
        reason:
          `**${site.label}** rejected that API key.\n` +
          `Make sure on <${site.keyHelpUrl}> you **checked \`Generate New Key?\`** and clicked **Save** at the bottom, then copy the new key.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true, unverified: true };
  }
}

export function setBooruCredentials(siteId, { userId, apiKey }) {
  const cfg = readConfig();
  if (!cfg.keys) cfg.keys = {};
  cfg.keys[siteId] = { userId: String(userId).trim(), apiKey: String(apiKey).trim() };
  writeConfig(cfg);
}

export function clearBooruCredentials(siteId) {
  const cfg = readConfig();
  cfg.keys[siteId] = null;
  writeConfig(cfg);
}

function getSeenSet(guildId) {
  const gKey = guildId || 'global';
  const list = seenMemory.get(gKey) || [];
  return new Set(list);
}

function recordSeenPost(guildId, postKey) {
  const gKey = guildId || 'global';
  const list = seenMemory.get(gKey) || [];
  if (!list.includes(postKey)) {
    list.push(postKey);
    if (list.length > MAX_SEEN_HISTORY) {
      list.splice(0, list.length - MAX_SEEN_HISTORY);
    }
    seenMemory.set(gKey, list);
  }
}

// ─── Tag Safety & Filtering ──────────────────────────────────────────────────

function isTagBlocked(tag) {
  const clean = String(tag || '').trim().toLowerCase().replace(/^-+/, '');
  if (!clean) return false;
  return BLOCKED_TAGS.has(clean);
}

export function validateUserTags(rawTags = []) {
  const cleaned = [];
  for (const t of rawTags) {
    const parts = String(t || '').trim().split(/\s+/).filter(Boolean);
    for (const p of parts) {
      const bare = p.toLowerCase().replace(/^[~+-]+/, '');
      if (isTagBlocked(bare)) {
        return { ok: false, blockedTag: bare };
      }
      cleaned.push(p);
    }
  }
  return { ok: true, tags: cleaned };
}

function normalizeSearchTags(tags = []) {
  if (tags.length === 1) {
    const mapped = COMMON_TAG_FALLBACKS[tags[0].toLowerCase()];
    if (mapped) return [mapped];
  }
  return tags;
}

function postPassesSafetyAndRating(post, { allowNsfw }) {
  if (!post?.fileUrl) return false;

  let ext = '';
  try {
    ext = path.extname(new URL(post.fileUrl).pathname).toLowerCase();
  } catch {
    return false;
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;

  const postTags = String(post.tags || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of postTags) {
    if (BLOCKED_TAGS.has(t)) return false;
  }

  if (!allowNsfw) {
    const r = String(post.rating || '').toLowerCase();
    const isSafe = r === 'general' || r === 'g' || r === 'safe' || r === 's';
    if (!isSafe) return false;
  }

  return true;
}

function normalizeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

// ─── End-to-End Timed Fetchers (Timer covers headers + full body stream!) ────

async function fetchTextWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': API_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const bodyText = await res.text();
    return { ok: res.ok, status: res.status, text: bodyText };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBufferWithTimeout(url, options = {}, timeoutMs = MEDIA_TIMEOUT_MS, maxBytes = MAX_UPLOAD_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': CDN_USER_AGENT,
        Accept: '*/*',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, status: res.status, buffer: null };
    }

    const declaredLen = Number(res.headers?.get?.('content-length') || 0);
    if (declaredLen > maxBytes) {
      controller.abort();
      return { ok: false, status: 413, buffer: null };
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      const ab = await res.arrayBuffer();
      if (ab.byteLength === 0 || ab.byteLength > maxBytes) {
        return { ok: false, status: 413, buffer: null };
      }
      return { ok: true, status: res.status, buffer: Buffer.from(ab) };
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          return { ok: false, status: 413, buffer: null };
        }
        chunks.push(Buffer.from(value));
      }
    }

    if (total === 0) return { ok: false, status: 204, buffer: null };
    return { ok: true, status: res.status, buffer: Buffer.concat(chunks, total) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Booru API Engines ───────────────────────────────────────────────────────

async function queryDapiSite(site, searchTags, { allowNsfw, page = 0 }) {
  const creds = getBooruCredentials(site.id);
  if (site.requiresKey && !creds) {
    const err = new Error(`Missing ${site.label} API credentials`);
    err.missingAuth = true;
    err.site = site;
    throw err;
  }

  const effectiveTags = [...searchTags];
  if (!allowNsfw && (site.id === 'gelbooru' || site.id === 'tbib') && !effectiveTags.some((t) => t.startsWith('rating:'))) {
    effectiveTags.push(site.id === 'gelbooru' ? 'rating:general' : 'rating:safe');
  }

  const hasPositiveTag = effectiveTags.some((t) => t && !t.startsWith('-'));
  if (hasPositiveTag && (site.id === 'gelbooru' || site.id === 'r34')) {
    if (!effectiveTags.includes('-loli')) effectiveTags.push('-loli');
    if (!effectiveTags.includes('-shota')) effectiveTags.push('-shota');
  }

  const baseUrl =
    site.id === 'gelbooru'
      ? 'https://gelbooru.com/index.php'
      : site.id === 'r34'
        ? 'https://api.rule34.xxx/index.php'
        : site.id === 'tbib'
          ? 'https://tbib.org/index.php'
          : 'https://safebooru.org/index.php';

  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: '100',
    pid: String(page),
  });
  if (effectiveTags.length > 0) {
    params.set('tags', effectiveTags.join(' '));
  }

  if (creds && site.requiresKey) {
    params.set('user_id', creds.userId);
    params.set('api_key', creds.apiKey);
  }

  let resp = await fetchTextWithTimeout(`${baseUrl}?${params.toString()}`);
  if (resp.status === 403 && !site.requiresKey) {
    resp = await fetchTextWithTimeout(`${baseUrl}?${params.toString()}`, {
      headers: { 'User-Agent': CDN_USER_AGENT },
    });
  }

  const rawText = resp.text;

  if (
    site.requiresKey &&
    (resp.status === 401 ||
      resp.status === 403 ||
      /missing authentication|authentication required|invalid api key/i.test(rawText))
  ) {
    const err = new Error(`${site.label} API authentication required or invalid`);
    err.missingAuth = true;
    err.site = site;
    throw err;
  }

  if (!resp.ok) {
    const err = new Error(`${site.label} returned HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    throw err;
  }

  const trimmed = rawText.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (site.requiresKey && /authentication|api_key/i.test(trimmed)) {
      const err = new Error(`${site.label} API authentication required`);
      err.missingAuth = true;
      err.site = site;
      throw err;
    }
    return [];
  }

  if (typeof parsed === 'string') {
    if (site.requiresKey && /authentication|api_key/i.test(parsed)) {
      const err = new Error(parsed);
      err.missingAuth = true;
      err.site = site;
      throw err;
    }
    return [];
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.post)
      ? parsed.post
      : parsed?.post
        ? [parsed.post]
        : [];

  return rawList.map((p) => {
    const id = String(p.id);
    const cleanImg = p.image ? String(p.image).split('?')[0] : '';
    let fileUrl = normalizeUrl(p.file_url);
    if (!fileUrl && p.directory && cleanImg) {
      if (site.id === 'safebooru') {
        fileUrl = `https://safebooru.org/images/${p.directory}/${cleanImg}`;
      } else if (site.id === 'r34') {
        fileUrl = `https://api-cdn.rule34.xxx/images/${p.directory}/${cleanImg}`;
      } else if (site.id === 'tbib') {
        fileUrl = `https://tbib.org//images/${p.directory}/${cleanImg}`;
      }
    }

    const hasSample = p.sample === true || p.sample === 1 || p.sample === '1';
    const baseNameNoExt = cleanImg ? cleanImg.replace(/\.[^.]+$/, '') : '';
    const sampleUrl =
      (hasSample && normalizeUrl(p.sample_url)) ||
      (site.id === 'safebooru' && p.directory && baseNameNoExt && hasSample
        ? `https://safebooru.org/samples/${p.directory}/sample_${baseNameNoExt}.jpg`
        : null) ||
      normalizeUrl(p.sample_url) ||
      fileUrl;

    const previewUrl = normalizeUrl(p.preview_url) || sampleUrl || fileUrl;

    const pageUrl =
      site.id === 'gelbooru'
        ? `https://gelbooru.com/index.php?page=post&s=view&id=${id}`
        : site.id === 'r34'
          ? `https://rule34.xxx/index.php?page=post&s=view&id=${id}`
          : site.id === 'tbib'
            ? `https://tbib.org/index.php?page=post&s=view&id=${id}`
            : `https://safebooru.org/index.php?page=post&s=view&id=${id}`;

    return {
      siteId: site.id,
      siteLabel: site.label,
      id,
      fileUrl,
      sampleUrl,
      previewUrl,
      pageUrl,
      rating: site.id === 'safebooru' ? 'safe' : (p.rating || 'questionable'),
      score: Number(p.score) || 0,
      tags: String(p.tags || ''),
      referer: site.referer,
    };
  });
}

async function queryMoebooru(site, searchTags, { allowNsfw, page = 1 }) {
  const effectiveTags = [...searchTags];
  if (!allowNsfw && !effectiveTags.some((t) => t.startsWith('rating:'))) {
    effectiveTags.push('rating:s');
  }

  const host =
    site.id === 'yandere'
      ? 'https://yande.re'
      : allowNsfw
        ? 'https://konachan.com'
        : 'https://konachan.net';

  const params = new URLSearchParams({
    limit: '100',
    page: String(page),
  });
  if (effectiveTags.length > 0) {
    params.set('tags', effectiveTags.join(' '));
  }

  let resp = await fetchTextWithTimeout(`${host}/post.json?${params.toString()}`);
  if (resp.status === 403 || resp.status === 503) {
    resp = await fetchTextWithTimeout(`${host}/post.json?${params.toString()}`, {
      headers: { 'User-Agent': CDN_USER_AGENT },
    });
  }

  if (!resp.ok) {
    const err = new Error(`${site.label} returned HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(resp.text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p?.id && (p.sample_url || p.jpeg_url || p.file_url))
    .map((p) => ({
      siteId: site.id,
      siteLabel: site.label,
      id: String(p.id),
      fileUrl: normalizeUrl(p.jpeg_url || p.file_url || p.sample_url),
      sampleUrl: normalizeUrl(p.sample_url || p.jpeg_url || p.file_url),
      previewUrl: normalizeUrl(p.preview_url || p.sample_url || p.file_url),
      pageUrl: `${host}/post/show/${p.id}`,
      rating: p.rating || 'q',
      score: Number(p.score) || 0,
      tags: String(p.tags || ''),
      referer: `${host}/`,
    }));
}

async function queryDanbooru(site, searchTags, { allowNsfw, page = 1 }) {
  const effectiveTags = searchTags.slice(0, 2);
  if (!allowNsfw && effectiveTags.length < 2 && !effectiveTags.some((t) => t.startsWith('rating:'))) {
    effectiveTags.push('rating:g');
  }

  const host = allowNsfw ? 'https://danbooru.donmai.us' : 'https://safebooru.donmai.us';
  const params = new URLSearchParams({
    limit: '100',
    page: String(page),
    tags: effectiveTags.join(' '),
  });

  let resp = await fetchTextWithTimeout(`${host}/posts.json?${params.toString()}`);
  if (resp.status === 403 || resp.status === 503) {
    resp = await fetchTextWithTimeout(`${host}/posts.json?${params.toString()}`, {
      headers: { 'User-Agent': CDN_USER_AGENT },
    });
  }

  if (!resp.ok) {
    const err = new Error(`Danbooru returned HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(resp.text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p?.id && (p.file_url || p.large_file_url))
    .map((p) => ({
      siteId: site.id,
      siteLabel: site.label,
      id: String(p.id),
      fileUrl: normalizeUrl(p.file_url || p.large_file_url),
      sampleUrl: normalizeUrl(p.large_file_url || p.file_url),
      previewUrl: normalizeUrl(p.preview_file_url || p.large_file_url || p.file_url),
      pageUrl: `https://danbooru.donmai.us/posts/${p.id}`,
      rating: p.rating || 'q',
      score: Number(p.score) || 0,
      tags: String(p.tag_string || ''),
      referer: site.referer,
    }));
}

async function fetchSiteOnce(site, tags, { allowNsfw }) {
  const randomPage = Math.floor(Math.random() * 3);

  if (site.id === 'danbooru') {
    let posts = await queryDanbooru(site, tags, { allowNsfw, page: randomPage + 1 });
    if (posts.length === 0 && randomPage > 0) {
      posts = await queryDanbooru(site, tags, { allowNsfw, page: 1 });
    }
    return posts;
  }

  if (site.id === 'konachan' || site.id === 'yandere') {
    let posts = await queryMoebooru(site, tags, { allowNsfw, page: randomPage + 1 });
    if (posts.length === 0 && randomPage > 0) {
      posts = await queryMoebooru(site, tags, { allowNsfw, page: 1 });
    }
    return posts;
  }

  let posts = await queryDapiSite(site, tags, { allowNsfw, page: randomPage });
  if (posts.length === 0 && randomPage > 0) {
    posts = await queryDapiSite(site, tags, { allowNsfw, page: 0 });
  }
  return posts;
}

// Multi-site fallback cascade when Cloudflare returns 403/503/5xx on keyless sites from datacenter IPs
async function fetchRawCandidates(site, tags, { allowNsfw }) {
  try {
    return await fetchSiteOnce(site, tags, { allowNsfw });
  } catch (primaryErr) {
    if (site.requiresKey || primaryErr?.missingAuth) {
      throw primaryErr;
    }

    const fallbackOrder = allowNsfw
      ? [
          BOORU_SITES.yandere,
          BOORU_SITES.konachan,
          ...(getBooruCredentials('gelbooru') ? [BOORU_SITES.gelbooru] : []),
          ...(getBooruCredentials('r34') ? [BOORU_SITES.r34] : []),
          BOORU_SITES.tbib,
          BOORU_SITES.safebooru,
        ]
      : [
          BOORU_SITES.safebooru,
          BOORU_SITES.konachan,
          BOORU_SITES.tbib,
        ];

    for (const candidateSite of fallbackOrder) {
      if (!candidateSite || candidateSite.id === site.id) continue;
      try {
        const posts = await fetchSiteOnce(candidateSite, tags, { allowNsfw });
        if (posts.length > 0) return posts;
      } catch {
        // Continue down the fallback chain
      }
    }

    throw primaryErr;
  }
}

export async function fetchBooruPosts({
  siteInput,
  rawTags = [],
  allowNsfw = true,
  count = 1,
  guildId = null,
}) {
  const site = typeof siteInput === 'string' ? resolveBooruSite(siteInput) : siteInput;
  if (!site) {
    throw new Error('Unknown booru site. Supported: `gelbooru`, `r34`, `safebooru`, `danbooru`, `konachan`, `yandere`');
  }

  const effectiveAllowNsfw = site.id === 'safebooru' ? false : Boolean(allowNsfw);

  if (site.nsfwOnly && !effectiveAllowNsfw) {
    const err = new Error(`**${site.label}** can only be used in an **Age-Restricted (NSFW)** Discord channel.`);
    err.nsfwRequired = true;
    throw err;
  }

  const tagCheck = validateUserTags(rawTags);
  if (!tagCheck.ok) {
    const err = new Error(`Tag \`${tagCheck.blockedTag}\` is blocked by safety rules.`);
    err.blockedTag = true;
    throw err;
  }

  let usedTags = normalizeSearchTags(tagCheck.tags);
  let candidates = await fetchRawCandidates(site, usedTags, { allowNsfw: effectiveAllowNsfw });
  let valid = candidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw: effectiveAllowNsfw }));

  // Retry multi-word tags joined with underscores (`blue archive` -> `blue_archive`)
  if (
    valid.length === 0 &&
    usedTags.length >= 2 &&
    usedTags.length <= 4 &&
    usedTags.every((t) => !t.includes('_') && !t.includes(':'))
  ) {
    const underscored = [usedTags.join('_')];
    const retryCheck = validateUserTags(underscored);
    if (retryCheck.ok) {
      const retryCandidates = await fetchRawCandidates(site, underscored, { allowNsfw: effectiveAllowNsfw });
      const retryValid = retryCandidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw: effectiveAllowNsfw }));
      if (retryValid.length > 0) {
        usedTags = underscored;
        valid = retryValid;
      }
    }
  }

  if (valid.length === 0) {
    return { site, usedTags, posts: [] };
  }

  const actualSite = resolveBooruSite(valid[0].siteId) || site;
  const seen = getSeenSet(guildId);
  const unseen = valid.filter((p) => !seen.has(`${actualSite.id}:${p.id}`));
  const pool = unseen.length >= count ? unseen : valid;

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const picked = shuffled.slice(0, Math.max(1, Math.min(5, count)));
  for (const p of picked) {
    recordSeenPost(guildId, `${actualSite.id}:${p.id}`);
  }

  return { site: actualSite, usedTags, posts: picked };
}

// ─── Media Download & Multi-Stage Discord Delivery ───────────────────────────

async function tryDownloadMedia(post) {
  let ext = '.jpg';
  try {
    ext = path.extname(new URL(post.fileUrl).pathname).toLowerCase() || '.jpg';
  } catch {
    ext = '.jpg';
  }

  // Keep animated GIFs using fileUrl first; for static PNG/JPG/WebP try fast sampleUrl (~200 KB) first!
  const candidateUrls =
    ext === '.gif'
      ? [post.fileUrl, post.sampleUrl, post.previewUrl]
      : [post.sampleUrl, post.fileUrl, post.previewUrl];

  const uniqueUrls = [...new Set(candidateUrls.filter(Boolean))];

  for (const mediaUrl of uniqueUrls) {
    try {
      let resp = await fetchBufferWithTimeout(mediaUrl, {
        headers: { Referer: post.referer || 'https://rule34.xxx/' },
      });
      if (resp.status === 403) {
        resp = await fetchBufferWithTimeout(mediaUrl, {});
      }
      if (!resp.ok || !resp.buffer) continue;

      let outExt = path.extname(new URL(mediaUrl).pathname).toLowerCase() || '.jpg';
      if (!ALLOWED_EXTENSIONS.has(outExt)) outExt = '.jpg';

      const filename = `${post.siteId}_${post.id}${outExt}`;
      return {
        buffer: resp.buffer,
        filename,
      };
    } catch {
      // Try next URL in candidateUrls
    }
  }
  return null;
}

export async function buildBooruMessagePayload({
  site,
  posts,
  usedTags = [],
  headerPrefix = null,
  includeNextButton = true,
  attachFiles = true,
}) {
  const files = [];
  const galleryItems = [];

  for (const post of posts) {
    const downloaded = attachFiles ? await tryDownloadMedia(post) : null;
    if (downloaded) {
      files.push(new AttachmentBuilder(downloaded.buffer, { name: downloaded.filename }));
      galleryItems.push(new MediaGalleryItemBuilder().setURL(`attachment://${downloaded.filename}`));
    } else {
      galleryItems.push(new MediaGalleryItemBuilder().setURL(post.sampleUrl || post.fileUrl));
    }
  }

  const c = new ContainerBuilder();
  const tagBadge = usedTags.length > 0 ? ` · \`${usedTags.join(' ')}\`` : ' · `random`';
  const title = headerPrefix
    ? `**${headerPrefix}** — **${site.label}**${tagBadge}`
    : `**${site.label}**${tagBadge}`;

  c.addTextDisplayComponents(text(title));
  c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...galleryItems));

  const first = posts[0];
  const sampleTags = first.tags
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => `\`${t}\``)
    .join(' ');

  c.addTextDisplayComponents(
    text(
      `-# ID #${first.id} · Score: ${first.score}${posts.length > 1 ? ` · ${posts.length} files` : ''}` +
      (sampleTags ? `\n-# ${sampleTags}` : '')
    )
  );

  const rowButtons = [];
  if (includeNextButton) {
    const encodedTags = usedTags.length > 0 ? usedTags.join(' ').slice(0, 72) : '_';
    rowButtons.push(
      button(`booru:next:${site.id}:${encodedTags}`, 'Another One', ButtonStyle.Primary)
    );
  }
  rowButtons.push(
    new ButtonBuilder()
      .setLabel('Source Post')
      .setStyle(ButtonStyle.Link)
      .setURL(first.pageUrl)
  );

  c.addSeparatorComponents(thinDivider());
  c.addActionRowComponents(actionRow(...rowButtons));

  const payload = {
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  };
  if (files.length > 0) {
    payload.files = files;
  }
  return payload;
}

// Guaranteed 3-stage delivery so Discord's size cap or Server Explicit Media Filter NEVER causes silence
export async function deliverBooruResult(
  sendFn,
  { site, posts, usedTags = [], headerPrefix = null, includeNextButton = true }
) {
  // Stage 1: Full V2 card + downloaded image attachment
  const payload = await buildBooruMessagePayload({
    site,
    posts,
    usedTags,
    headerPrefix,
    includeNextButton,
    attachFiles: true,
  });

  try {
    return await sendFn(payload);
  } catch (err1) {
    console.warn('[Booru] Stage 1 send failed:', err1?.code || '', err1?.message || err1);

    // Stage 2: V2 card using remote sampleUrl/fileUrl (no binary upload — bypasses attachment size / scan)
    try {
      const urlOnlyPayload = await buildBooruMessagePayload({
        site,
        posts,
        usedTags,
        headerPrefix,
        includeNextButton,
        attachFiles: false,
      });
      return await sendFn(urlOnlyPayload);
    } catch (err2) {
      console.warn('[Booru] Stage 2 send failed:', err2?.code || '', err2?.message || err2);

      // Stage 3: Guaranteed V2 link card (works even if Discord's Server Safety filter blocks inline NSFW media)
      const first = posts[0];
      const filterBlocked = err1?.code === 200000 || err2?.code === 200000;
      const tip = filterBlocked
        ? `\n-# Discord's Server Safety filter blocked inline NSFW upload in this non-NSFW channel — set **Server Settings → Safety Setup → Explicit Media Content Filter** to **"Do not filter"** for inline previews!`
        : '';

      const c = new ContainerBuilder();
      c.addTextDisplayComponents(
        text(
          `**${site.label}** · \`${usedTags.join(' ') || 'random'}\` (ID #${first.id})` + tip
        )
      );
      const btns = [];
      if (includeNextButton) {
        const encodedTags = usedTags.length > 0 ? usedTags.join(' ').slice(0, 72) : '_';
        btns.push(button(`booru:next:${site.id}:${encodedTags}`, 'Another One', ButtonStyle.Primary));
      }
      btns.push(
        new ButtonBuilder()
          .setLabel('Open Image')
          .setStyle(ButtonStyle.Link)
          .setURL(first.fileUrl)
      );
      btns.push(
        new ButtonBuilder()
          .setLabel('Source Post')
          .setStyle(ButtonStyle.Link)
          .setURL(first.pageUrl)
      );
      c.addSeparatorComponents(thinDivider());
      c.addActionRowComponents(actionRow(...btns));

      return await sendFn({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }
}

export function buildMissingKeyMessage(site) {
  if (!site?.requiresKey) {
    return `**${site?.label || 'Booru'}** is temporarily unavailable — try again in a moment.`;
  }
  return (
    `**${site.label}** requires a free API key from your ${site.label} account.\n\n` +
    `**Exact steps:**\n` +
    `1. Open <${site.keyHelpUrl}> while logged in\n` +
    `2. Scroll down to **API Access Credentials**\n` +
    `3. **Check the box \`Generate New Key?\`** and click **Save** at the bottom!\n` +
    `   *(Until you tick \`Generate New Key?\` and click Save, \`api_key=\` is blank!)*\n` +
    `4. Re-open Options, copy the new \`&api_key=...&user_id=...\` text, and run:\n` +
    `   \`!boorukey ${site.id} &api_key=YOUR_LONG_KEY&user_id=YOUR_ID_NUMBER\`\n` +
    `   *(Do NOT type your username — \`user_id\` is the number like \`7006715\`!)*\n\n` +
    `-# Want keyless anime posts right away? Try \`!safebooru\`, \`!konachan\`, or \`!yandere\`.`
  );
}
