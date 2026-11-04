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
  thinDivider,
  text,
  button,
  actionRow,
} from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'auth-cache', 'booru-config.json');

// Honest bot User-Agent avoids Cloudflare JA3 mismatch 403s on Danbooru & Safebooru
const API_USER_AGENT = 'AstoBot/2.1 (Discord Bot; +https://github.com/Astosky/MC-AFK-BOT-bedrock)';
const CDN_USER_AGENT = 'curl/8.7.1';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB safe Discord attachment cap
const FETCH_TIMEOUT_MS = 12_000;
const MAX_SEEN_HISTORY = 600;

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
]);

// Friendly tag synonyms when beginners type plain words that return 0 booru hits
const COMMON_TAG_FALLBACKS = {
  girl: '1girl',
  boy: '1boy',
  girls: 'multiple_girls',
  boys: 'multiple_boys',
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
};

export function resolveBooruSite(raw = '') {
  const key = SITE_ALIASES[String(raw || '').trim().toLowerCase()];
  return key ? BOORU_SITES[key] : null;
}

// ─── Config & Seen History Persistence ───────────────────────────────────────

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { keys: {}, seen: {} };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      keys: parsed?.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    };
  } catch {
    return { keys: {}, seen: {} };
  }
}

function writeConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function isValidCredPair(userId, apiKey) {
  return (
    Boolean(userId) &&
    Boolean(apiKey) &&
    /^\d+$/.test(String(userId).trim()) &&
    /^[a-zA-Z0-9_-]{16,}$/.test(String(apiKey).trim())
  );
}

export function getBooruCredentials(siteId) {
  if (siteId === 'gelbooru') {
    const envUser = process.env.GELBOORU_USER_ID?.trim();
    const envKey = process.env.GELBOORU_API_KEY?.trim();
    if (isValidCredPair(envUser, envKey)) return { userId: envUser, apiKey: envKey };
  }
  if (siteId === 'r34') {
    const envUser = process.env.R34_USER_ID?.trim();
    const envKey = process.env.R34_API_KEY?.trim();
    if (isValidCredPair(envUser, envKey)) return { userId: envUser, apiKey: envKey };
  }

  const cfg = readConfig();
  const saved = cfg.keys?.[siteId];
  if (saved && isValidCredPair(saved.userId, saved.apiKey)) {
    return { userId: String(saved.userId).trim(), apiKey: String(saved.apiKey).trim() };
  }
  return null;
}

// Supports `!boorukey r34 7006715 <api_key>` AND `&api_key=...&user_id=7006715`
// Detects blank `api_key=` (before clicking "Generate New Key?" -> Save) and ignores accidental usernames!
export function parseCredentialInput(tokens = []) {
  const joined = tokens.join(' ').trim();
  if (!joined) return { error: 'missing' };

  if (/api_key=|user_id=/i.test(joined)) {
    const uidMatch = joined.match(/user_id=([^&\s]*)/i);
    const keyMatch = joined.match(/api_key=([^&\s]*)/i);
    const extractedUid =
      uidMatch?.[1]?.trim() || tokens.find((t) => /^\d+$/.test(t.trim()))?.trim() || null;
    const extractedKey = keyMatch?.[1]?.trim() || '';

    if (!extractedKey) {
      return {
        error: 'empty_api_key',
        partialUserId: extractedUid,
      };
    }
    if (!extractedUid || !/^\d+$/.test(extractedUid)) {
      return { error: 'non_numeric_user_id' };
    }
    if (!isValidCredPair(extractedUid, extractedKey)) {
      return { error: 'invalid_format', partialUserId: extractedUid };
    }
    return { userId: extractedUid, apiKey: extractedKey };
  }

  const trimmedTokens = tokens.map((t) => t.trim()).filter(Boolean);
  const uidToken = trimmedTokens.find((t) => /^\d+$/.test(t));
  const keyToken =
    trimmedTokens.find((t) => t !== uidToken && /^[a-fA-F0-9]{24,}$/.test(t)) ||
    trimmedTokens.find((t) => t !== uidToken && /^[a-zA-Z0-9_-]{20,}$/.test(t));

  if (!uidToken) {
    return { error: 'non_numeric_user_id' };
  }
  if (!keyToken) {
    return { error: 'empty_api_key', partialUserId: uidToken };
  }

  return { userId: uidToken, apiKey: keyToken };
}

export async function verifyBooruCredentials(site, { userId, apiKey }) {
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
    const res = await fetchWithTimeout(`${baseUrl}?${params.toString()}`, {}, 10_000);
    const raw = (await res.text()).trim();
    if (
      res.status === 401 ||
      res.status === 403 ||
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
  if (cfg.keys?.[siteId]) {
    delete cfg.keys[siteId];
    writeConfig(cfg);
  }
}

function getSeenSet(guildId) {
  const cfg = readConfig();
  const list = Array.isArray(cfg.seen?.[guildId || 'global']) ? cfg.seen[guildId || 'global'] : [];
  return new Set(list);
}

function recordSeenPost(guildId, postKey) {
  const gKey = guildId || 'global';
  const cfg = readConfig();
  if (!cfg.seen) cfg.seen = {};
  const list = Array.isArray(cfg.seen[gKey]) ? cfg.seen[gKey] : [];
  if (!list.includes(postKey)) {
    list.push(postKey);
    if (list.length > MAX_SEEN_HISTORY) {
      list.splice(0, list.length - MAX_SEEN_HISTORY);
    }
    cfg.seen[gKey] = list;
    writeConfig(cfg);
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

// ─── API Fetchers ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      headers: {
        'User-Agent': API_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function queryDapiSite(site, searchTags, { allowNsfw, page = 0 }) {
  const creds = getBooruCredentials(site.id);
  if (site.requiresKey && !creds) {
    const err = new Error(`Missing ${site.label} API credentials`);
    err.missingAuth = true;
    err.site = site;
    throw err;
  }

  const effectiveTags = [...searchTags];
  if (!allowNsfw && site.id === 'gelbooru' && !effectiveTags.some((t) => t.startsWith('rating:'))) {
    effectiveTags.push('rating:general');
  }

  // Only append negative tags on Gelbooru/R34 (Safebooru's old DAPI returns empty on negative-only queries)
  if (site.id === 'gelbooru' || site.id === 'r34') {
    if (!effectiveTags.includes('-loli')) effectiveTags.push('-loli');
    if (!effectiveTags.includes('-shota')) effectiveTags.push('-shota');
  }

  const baseUrl =
    site.id === 'gelbooru'
      ? 'https://gelbooru.com/index.php'
      : site.id === 'r34'
        ? 'https://api.rule34.xxx/index.php'
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

  if (creds) {
    params.set('user_id', creds.userId);
    params.set('api_key', creds.apiKey);
  }

  let res = await fetchWithTimeout(`${baseUrl}?${params.toString()}`);
  if (res.status === 403 && !site.requiresKey) {
    res = await fetchWithTimeout(`${baseUrl}?${params.toString()}`, {
      headers: { 'User-Agent': CDN_USER_AGENT },
    });
  }

  const rawText = await res.text();

  if (
    site.requiresKey &&
    (res.status === 401 ||
      res.status === 403 ||
      /missing authentication|authentication required|invalid api key/i.test(rawText))
  ) {
    const err = new Error(`${site.label} API authentication required or invalid`);
    err.missingAuth = true;
    err.site = site;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`${site.label} returned HTTP ${res.status}`);
    err.httpStatus = res.status;
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
    if (!fileUrl && site.id === 'safebooru' && p.directory && cleanImg) {
      fileUrl = `https://safebooru.org/images/${p.directory}/${cleanImg}`;
    }

    const baseNameNoExt = cleanImg ? cleanImg.replace(/\.[^.]+$/, '') : '';
    const sampleUrl =
      normalizeUrl(p.sample_url) ||
      (site.id === 'safebooru' && p.directory && baseNameNoExt && p.sample
        ? `https://safebooru.org/samples/${p.directory}/sample_${baseNameNoExt}.jpg`
        : null) ||
      fileUrl;

    const pageUrl =
      site.id === 'gelbooru'
        ? `https://gelbooru.com/index.php?page=post&s=view&id=${id}`
        : site.id === 'r34'
          ? `https://rule34.xxx/index.php?page=post&s=view&id=${id}`
          : `https://safebooru.org/index.php?page=post&s=view&id=${id}`;

    return {
      siteId: site.id,
      siteLabel: site.label,
      id,
      fileUrl,
      sampleUrl,
      pageUrl,
      rating: site.id === 'safebooru' ? 'safe' : (p.rating || 'questionable'),
      score: Number(p.score) || 0,
      tags: String(p.tags || ''),
      referer: site.referer,
    };
  });
}

// Moebooru JSON API (Konachan & Yande.re — 100% keyless & reliable!)
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
    tags: effectiveTags.join(' '),
  });

  const res = await fetchWithTimeout(`${host}/post.json?${params.toString()}`);
  if (!res.ok) {
    const err = new Error(`${site.label} returned HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }

  const parsed = await res.json();
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p?.id && (p.file_url || p.sample_url || p.jpeg_url))
    .map((p) => ({
      siteId: site.id,
      siteLabel: site.label,
      id: String(p.id),
      fileUrl: normalizeUrl(p.sample_url || p.jpeg_url || p.file_url),
      sampleUrl: normalizeUrl(p.sample_url || p.preview_url || p.file_url),
      pageUrl: `${host}/post/show/${p.id}`,
      rating: p.rating || 'q',
      score: Number(p.score) || 0,
      tags: String(p.tags || ''),
      referer: `${host}/`,
    }));
}

async function queryDanbooru(site, searchTags, { allowNsfw, page = 1 }) {
  // Danbooru anonymous tier allows max 2 tags per search
  const effectiveTags = searchTags.slice(0, 2);
  if (!allowNsfw && effectiveTags.length < 2 && !effectiveTags.some((t) => t.startsWith('rating:'))) {
    effectiveTags.push('rating:g');
  }

  const params = new URLSearchParams({
    limit: '100',
    page: String(page),
    tags: effectiveTags.join(' '),
  });

  let res = await fetchWithTimeout(`https://danbooru.donmai.us/posts.json?${params.toString()}`);
  if (res.status === 403) {
    res = await fetchWithTimeout(`https://danbooru.donmai.us/posts.json?${params.toString()}`, {
      headers: { 'User-Agent': CDN_USER_AGENT },
    });
  }

  if (!res.ok) {
    const err = new Error(`Danbooru returned HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }

  const parsed = await res.json();
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p?.id && (p.file_url || p.large_file_url))
    .map((p) => ({
      siteId: site.id,
      siteLabel: site.label,
      id: String(p.id),
      fileUrl: normalizeUrl(p.large_file_url || p.file_url),
      sampleUrl: normalizeUrl(p.large_file_url || p.file_url),
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

async function fetchRawCandidates(site, tags, { allowNsfw }) {
  try {
    return await fetchSiteOnce(site, tags, { allowNsfw });
  } catch (err) {
    // If Cloudflare blocks anonymous Danbooru/Safebooru on container IP, seamlessly fall back to keyless Moebooru
    if (!site.requiresKey && (err?.httpStatus === 403 || err?.name === 'AbortError')) {
      const fallbackSite = allowNsfw ? BOORU_SITES.yandere : BOORU_SITES.konachan;
      return await fetchSiteOnce(fallbackSite, tags, { allowNsfw });
    }
    throw err;
  }
}

// Fetch `count` fresh, safety-verified posts (with automatic underscore & synonym tag retries!)
export async function fetchBooruPosts({
  siteInput,
  rawTags = [],
  allowNsfw = false,
  count = 1,
  guildId = null,
}) {
  const site = typeof siteInput === 'string' ? resolveBooruSite(siteInput) : siteInput;
  if (!site) {
    throw new Error('Unknown booru site. Supported: `gelbooru`, `r34`, `safebooru`, `danbooru`, `konachan`, `yandere`');
  }

  if (site.nsfwOnly && !allowNsfw) {
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

  let usedTags = tagCheck.tags;
  let candidates = await fetchRawCandidates(site, usedTags, { allowNsfw });
  let valid = candidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw }));

  // Retry 1: if user typed `!gelbooru blue archive` (spaces instead of `blue_archive`), retry underscored!
  if (
    valid.length === 0 &&
    usedTags.length >= 2 &&
    usedTags.length <= 4 &&
    usedTags.every((t) => !t.includes('_') && !t.includes(':'))
  ) {
    const underscored = [usedTags.join('_')];
    const retryCheck = validateUserTags(underscored);
    if (retryCheck.ok) {
      const retryCandidates = await fetchRawCandidates(site, underscored, { allowNsfw });
      const retryValid = retryCandidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw }));
      if (retryValid.length > 0) {
        usedTags = underscored;
        valid = retryValid;
      }
    }
  }

  // Retry 2: if user typed `!safebooru girl` instead of `1girl`, try booru synonym!
  if (valid.length === 0 && usedTags.length === 1) {
    const syn = COMMON_TAG_FALLBACKS[usedTags[0].toLowerCase()];
    if (syn) {
      const synCandidates = await fetchRawCandidates(site, [syn], { allowNsfw });
      const synValid = synCandidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw }));
      if (synValid.length > 0) {
        usedTags = [syn];
        valid = synValid;
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

// ─── Media Download & Discord Upload Payload ─────────────────────────────────

async function tryDownloadMedia(post) {
  // Prefer sampleUrl first when available so high-res 18 MB PNGs upload near-instantly, fallback to fileUrl
  const urlsToTry = [];
  if (post.fileUrl) urlsToTry.push(post.fileUrl);
  if (post.sampleUrl && post.sampleUrl !== post.fileUrl) urlsToTry.push(post.sampleUrl);

  for (const mediaUrl of urlsToTry) {
    try {
      let res = await fetchWithTimeout(
        mediaUrl,
        {
          headers: {
            'User-Agent': CDN_USER_AGENT,
            Referer: post.referer || 'https://gelbooru.com/',
            Accept: '*/*',
          },
        },
        FETCH_TIMEOUT_MS
      );
      if (res.status === 403) {
        res = await fetchWithTimeout(mediaUrl, { headers: { Accept: '*/*' } }, FETCH_TIMEOUT_MS);
      }
      if (!res.ok) continue;

      const contentLen = Number(res.headers.get('content-length') || 0);
      if (contentLen > MAX_UPLOAD_BYTES) continue;

      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > MAX_UPLOAD_BYTES) continue;

      let ext = path.extname(new URL(mediaUrl).pathname).toLowerCase() || '.jpg';
      if (!ALLOWED_EXTENSIONS.has(ext)) ext = '.jpg';

      const filename = `${post.siteId}_${post.id}${ext}`;
      return {
        buffer: Buffer.from(arrayBuf),
        filename,
      };
    } catch {
      // Try next URL
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
}) {
  const files = [];
  const galleryItems = [];

  for (const post of posts) {
    const downloaded = await tryDownloadMedia(post);
    if (downloaded) {
      files.push(new AttachmentBuilder(downloaded.buffer, { name: downloaded.filename }));
      galleryItems.push(new MediaGalleryItemBuilder().setURL(`attachment://${downloaded.filename}`));
    } else {
      galleryItems.push(new MediaGalleryItemBuilder().setURL(post.fileUrl));
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
    // Never leave a trailing colon when tags are empty; use '_' placeholder
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
