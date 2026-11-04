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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
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
    nsfwOnly: false, // Supports SFW (rating:general) in normal channels, full in NSFW channels
    requiresKey: true,
    referer: 'https://gelbooru.com/',
    keyHelpUrl: 'https://gelbooru.com/index.php?page=account&s=options',
  },
  r34: {
    id: 'r34',
    label: 'Rule34',
    nsfwOnly: true, // Strictly requires an Age-Restricted (NSFW) Discord channel
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
};

const SITE_ALIASES = {
  gelbooru: 'gelbooru',
  gelbouru: 'gelbooru',
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

export function getBooruCredentials(siteId) {
  if (siteId === 'gelbooru') {
    const envUser = process.env.GELBOORU_USER_ID?.trim();
    const envKey = process.env.GELBOORU_API_KEY?.trim();
    if (envUser && envKey) return { userId: envUser, apiKey: envKey };
  }
  if (siteId === 'r34') {
    const envUser = process.env.R34_USER_ID?.trim();
    const envKey = process.env.R34_API_KEY?.trim();
    if (envUser && envKey) return { userId: envUser, apiKey: envKey };
  }

  const cfg = readConfig();
  const saved = cfg.keys?.[siteId];
  if (saved?.userId && saved?.apiKey) {
    return { userId: String(saved.userId), apiKey: String(saved.apiKey) };
  }
  return null;
}

// Supports both `!boorukey r34 <user_id> <api_key>` AND pasting `&api_key=...&user_id=...`
export function parseCredentialInput(tokens = []) {
  const joined = tokens.join(' ').trim();
  if (!joined) return null;

  if (joined.includes('api_key=') || joined.includes('user_id=')) {
    const cleaned = joined.replace(/^[?&]+/, '');
    const params = new URLSearchParams(cleaned);
    const apiKey = params.get('api_key')?.trim();
    const userId = params.get('user_id')?.trim();
    if (apiKey && userId) return { userId, apiKey };
  }

  if (tokens.length >= 2) {
    const a = tokens[0].trim();
    const b = tokens[1].trim();
    // Auto-detect which token is numeric user_id vs hex/string api_key
    if (/^\d+$/.test(a) && !/^\d+$/.test(b)) {
      return { userId: a, apiKey: b };
    }
    if (/^\d+$/.test(b) && !/^\d+$/.test(a)) {
      return { userId: b, apiKey: a };
    }
    return { userId: a, apiKey: b };
  }

  return null;
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
  if (BLOCKED_TAGS.has(clean)) return true;
  return false;
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

  // Check file extension is Discord-compatible image/video
  let ext = '';
  try {
    ext = path.extname(new URL(post.fileUrl).pathname).toLowerCase();
  } catch {
    return false;
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;

  // Enforce strict tag safety blocklist on every returned post
  const postTags = String(post.tags || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of postTags) {
    if (BLOCKED_TAGS.has(t)) return false;
  }

  // Enforce SFW rating in non-NSFW Discord channels
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
        'User-Agent': USER_AGENT,
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
  // Exclude blocked tags server-side as well
  if (!effectiveTags.includes('-loli')) effectiveTags.push('-loli');
  if (!effectiveTags.includes('-shota')) effectiveTags.push('-shota');

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
    tags: effectiveTags.join(' '),
  });

  if (creds) {
    params.set('user_id', creds.userId);
    params.set('api_key', creds.apiKey);
  }

  const res = await fetchWithTimeout(`${baseUrl}?${params.toString()}`);
  const rawText = await res.text();

  if (
    res.status === 401 ||
    res.status === 403 ||
    /missing authentication|authentication required|invalid api key/i.test(rawText)
  ) {
    const err = new Error(`${site.label} API authentication required or invalid`);
    err.missingAuth = true;
    err.site = site;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`${site.label} returned HTTP ${res.status}`);
  }

  const trimmed = rawText.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (/authentication|api_key/i.test(trimmed)) {
      const err = new Error(`${site.label} API authentication required`);
      err.missingAuth = true;
      err.site = site;
      throw err;
    }
    return [];
  }

  if (typeof parsed === 'string') {
    if (/authentication|api_key/i.test(parsed)) {
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
    // Safebooru sometimes omits file_url and provides directory + image
    let fileUrl = normalizeUrl(p.file_url);
    if (!fileUrl && site.id === 'safebooru' && p.directory && p.image) {
      fileUrl = `https://safebooru.org/images/${p.directory}/${p.image}`;
    }
    const sampleUrl =
      normalizeUrl(p.sample_url) ||
      (site.id === 'safebooru' && p.directory && p.image
        ? `https://safebooru.org/samples/${p.directory}/sample_${p.image}`
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
      rating: p.rating || 'questionable',
      score: Number(p.score) || 0,
      tags: String(p.tags || ''),
      referer: site.referer,
    };
  });
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

  const res = await fetchWithTimeout(`https://danbooru.donmai.us/posts.json?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Danbooru returned HTTP ${res.status}`);
  }

  const parsed = await res.json();
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p?.id && (p.file_url || p.large_file_url))
    .map((p) => ({
      siteId: site.id,
      siteLabel: site.label,
      id: String(p.id),
      fileUrl: normalizeUrl(p.file_url || p.large_file_url),
      sampleUrl: normalizeUrl(p.large_file_url || p.file_url),
      pageUrl: `https://danbooru.donmai.us/posts/${p.id}`,
      rating: p.rating || 'q',
      score: Number(p.score) || 0,
      tags: String(p.tag_string || ''),
      referer: site.referer,
    }));
}

async function fetchRawCandidates(site, tags, { allowNsfw }) {
  // Pick a random page 0..2 first for variety, falling back to page 0 if fewer posts exist
  const randomPage = Math.floor(Math.random() * 3);
  if (site.id === 'danbooru') {
    let posts = await queryDanbooru(site, tags, { allowNsfw, page: randomPage + 1 });
    if (posts.length === 0 && randomPage > 0) {
      posts = await queryDanbooru(site, tags, { allowNsfw, page: 1 });
    }
    return posts;
  }

  let posts = await queryDapiSite(site, tags, { allowNsfw, page: randomPage });
  if (posts.length === 0 && randomPage > 0) {
    posts = await queryDapiSite(site, tags, { allowNsfw, page: 0 });
  }
  return posts;
}

// Fetch `count` fresh, safety-verified posts (with automatic underscore tag retry!)
export async function fetchBooruPosts({
  siteInput,
  rawTags = [],
  allowNsfw = false,
  count = 1,
  guildId = null,
}) {
  const site = typeof siteInput === 'string' ? resolveBooruSite(siteInput) : siteInput;
  if (!site) {
    throw new Error('Unknown booru site. Supported: `gelbooru`, `r34`, `safebooru`, `danbooru`');
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

  // Smart fallback: if user typed `!gelbooru blue archive` (spaces instead of `blue_archive`), retry underscored!
  if (
    candidates.length === 0 &&
    usedTags.length >= 2 &&
    usedTags.length <= 4 &&
    usedTags.every((t) => !t.includes('_') && !t.includes(':'))
  ) {
    const underscored = [usedTags.join('_')];
    const retryCheck = validateUserTags(underscored);
    if (retryCheck.ok) {
      const retryCandidates = await fetchRawCandidates(site, underscored, { allowNsfw });
      if (retryCandidates.length > 0) {
        usedTags = underscored;
        candidates = retryCandidates;
      }
    }
  }

  const valid = candidates.filter((p) => postPassesSafetyAndRating(p, { allowNsfw }));
  if (valid.length === 0) {
    return { site, usedTags, posts: [] };
  }

  // Prefer unseen posts first, then shuffle
  const seen = getSeenSet(guildId);
  const unseen = valid.filter((p) => !seen.has(`${site.id}:${p.id}`));
  const pool = unseen.length >= count ? unseen : valid;

  // Fisher-Yates shuffle
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const picked = shuffled.slice(0, Math.max(1, Math.min(5, count)));
  for (const p of picked) {
    recordSeenPost(guildId, `${site.id}:${p.id}`);
  }

  return { site, usedTags, posts: picked };
}

// ─── Media Download & Discord Components V2 Upload Payload ───────────────────

async function tryDownloadMedia(post) {
  const urlsToTry = [post.fileUrl];
  if (post.sampleUrl && post.sampleUrl !== post.fileUrl) {
    urlsToTry.push(post.sampleUrl);
  }

  for (const mediaUrl of urlsToTry) {
    try {
      const res = await fetchWithTimeout(
        mediaUrl,
        { headers: { Referer: post.referer || 'https://gelbooru.com/' } },
        FETCH_TIMEOUT_MS
      );
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
      // Try sampleUrl or fall back to direct URL
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
    const encodedTags = usedTags.join(' ').slice(0, 72);
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

  return {
    components: [c],
    files,
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildMissingKeyMessage(site) {
  return (
    `**${site.label}** now requires a free API key from your ${site.label} account.\n\n` +
    `**Quick 30-second setup:**\n` +
    `1. Open <${site.keyHelpUrl}> (log in or sign up free)\n` +
    `2. Scroll down to **API Access Credentials**\n` +
    `3. Run in Discord: \`!boorukey ${site.id} <user_id> <api_key>\`\n` +
    `   *(or paste the raw \`&api_key=...&user_id=...\` string directly — your message will be auto-deleted for privacy!)*\n\n` +
    `-# Want keyless anime posts right away? Try \`!safebooru [tags]\` or \`!danbooru [tags]\`.`
  );
}
