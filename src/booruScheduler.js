// Made by Asto

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchBooruPosts,
  deliverBooruResult,
  buildMissingKeyMessage,
  resolveBooruSite,
  validateUserTags,
} from './booruService.js';
import {
  msg,
  ContainerBuilder,
  ButtonStyle,
  MessageFlags,
  thinDivider,
  thinSpacer,
  text,
  button,
  actionRow,
} from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULES_PATH = path.join(__dirname, '..', 'auth-cache', 'booru-schedules.dat');
const LEGACY_SCHEDULES_PATH = path.join(__dirname, '..', 'auth-cache', 'booru-schedules.json');
const CHECK_INTERVAL_MS = 20_000; // Check schedules every 20 seconds
const DEFAULT_TIMEZONE = process.env.BOORU_TZ?.trim() || process.env.TZ?.trim() || 'Africa/Algiers';

// ─── Timezone & Clock Utilities ──────────────────────────────────────────────

const OFFSET_TZ_RE = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::(\d{2}))?$/i;

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (OFFSET_TZ_RE.test(trimmed)) {
    const m = trimmed.match(OFFSET_TZ_RE);
    const hrs = Number(m[2]);
    const mins = Number(m[3] || 0);
    return hrs <= 14 && mins < 60;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: trimmed }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getClockInTimezone(tz = DEFAULT_TIMEZONE, date = new Date()) {
  const safeTz = isValidTimezone(tz) ? tz.trim() : 'UTC';
  const offsetMatch = safeTz.match(OFFSET_TZ_RE);

  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hrs = Number(offsetMatch[2]);
    const mins = Number(offsetMatch[3] || 0);
    const shifted = new Date(date.getTime() + sign * (hrs * 60 + mins) * 60_000);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hour = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();
    return {
      dateKey: `${year}-${month}-${day}`,
      hour,
      minute,
      totalMinutes: hour * 60 + minute,
      formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      timezone: safeTz.toUpperCase().replace(/\s+/g, ''),
    };
  }

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const hour = Number(map.hour || 0) % 24;
  const minute = Number(map.minute || 0);
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    timezone: safeTz,
  };
}

// Parse time token(s) like `18:00`, `6:30pm`, `8pm`, `daily`, `every 6h`, `30m`
export function parseScheduleSpec(tokens = [], currentClock) {
  if (!tokens.length) return null;

  let idx = 0;
  const first = tokens[0].toLowerCase();

  // `every 6h` / `every 30m` / `every day`
  if (first === 'every') {
    const second = (tokens[1] || '').toLowerCase();
    if (!second) return null;
    if (second === 'day' || second === 'daily') {
      idx = 2;
      // Check if followed by a clock time like `every day 18:00` or `every day at 18:00`
      if (tokens[idx]?.toLowerCase() === 'at') idx++;
      const maybeTime = tokens[idx] ? parseClockTimeToken(tokens[idx]) : null;
      if (maybeTime) {
        return { mode: 'daily', time: maybeTime, consumed: idx + 1 };
      }
      return { mode: 'daily', time: currentClock.formattedTime, consumed: 2 };
    }
    const iv = parseIntervalToken(second);
    if (!iv) return null;
    return { mode: 'interval', intervalMinutes: iv, consumed: 2 };
  }

  // `daily` / `everyday` (optionally followed by `18:00` or `at 18:00`)
  if (first === 'daily' || first === 'everyday') {
    idx = 1;
    if (tokens[idx]?.toLowerCase() === 'at') idx++;
    const maybeTime = tokens[idx] ? parseClockTimeToken(tokens[idx]) : null;
    if (maybeTime) {
      return { mode: 'daily', time: maybeTime, consumed: idx + 1 };
    }
    return { mode: 'daily', time: currentClock.formattedTime, consumed: 1 };
  }

  // Direct interval token like `6h`, `12h`, `30m`, `1d`
  const directInterval = parseIntervalToken(first);
  if (directInterval) {
    return { mode: 'interval', intervalMinutes: directInterval, consumed: 1 };
  }

  // Direct clock time like `18:00`, `6:30pm`, `9am`
  const directClock = parseClockTimeToken(first);
  if (directClock) {
    return { mode: 'daily', time: directClock, consumed: 1 };
  }

  return null;
}

export function parseClockTimeToken(raw = '') {
  const s = String(raw || '').trim().toLowerCase();
  // Match `18:00`, `6:30pm`, `8pm`, `12:15am`
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  // Require either `:MM` or `am/pm` so bare numbers like tag `1girl` aren't misread
  if (m[2] === undefined && !m[3]) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = m[3];

  if (minute < 0 || minute > 59) return null;

  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'am') {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseIntervalToken(raw = '') {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!num || num <= 0) return null;
  const unit = m[2][0];
  const mins = unit === 'd' ? num * 1440 : unit === 'h' ? num * 60 : num;
  return Math.max(10, Math.min(10080, mins)); // Clamp between 10 mins and 7 days
}

function formatIntervalLabel(mins) {
  if (mins % 1440 === 0) return `every ${mins / 1440}d`;
  if (mins % 60 === 0) return `every ${mins / 60}h`;
  return `every ${mins}m`;
}

// ─── Persistent Scheduler Class ──────────────────────────────────────────────

export class BooruScheduler {
  constructor(discordClient) {
    this.client = discordClient;
    this.timer = null;
    this.runningIds = new Set();
    this.state = this._loadState();
  }

  _loadState() {
    for (const filePath of [SCHEDULES_PATH, LEGACY_SCHEDULES_PATH]) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          return {
            nextId: Number(parsed.nextId) || 1,
            timezones: parsed.timezones && typeof parsed.timezones === 'object' ? parsed.timezones : {},
            schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
          };
        }
      } catch {
        // Try next path
      }
    }
    return { nextId: 1, timezones: {}, schedules: [] };
  }

  _saveState() {
    fs.mkdirSync(path.dirname(SCHEDULES_PATH), { recursive: true });
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(this.state, null, 2), 'utf8');
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this._tick().catch((err) => console.error('[BooruScheduler] tick error:', err));
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getGuildTimezone(guildId) {
    return this.state.timezones?.[guildId] || DEFAULT_TIMEZONE;
  }

  setGuildTimezone(guildId, tz) {
    if (!isValidTimezone(tz)) return false;
    this.state.timezones[guildId] = tz.trim();
    this._saveState();
    return true;
  }

  getGuildSchedules(guildId) {
    return this.state.schedules.filter((s) => s.guildId === guildId);
  }

  getScheduleById(guildId, id) {
    return this.state.schedules.find((s) => s.guildId === guildId && String(s.id) === String(id)) || null;
  }

  addSchedule({ guildId, channelId, siteInput, mode, time, intervalMinutes, rawTags = [], count = 1, allowNsfw = true }) {
    const site = resolveBooruSite(siteInput);
    if (!site) {
      return { ok: false, error: 'Unknown site. Use `gelbooru`, `r34`, `safebooru`, `konachan`, `yandere`, or `danbooru`.' };
    }
    if (site.nsfwOnly && !allowNsfw) {
      return {
        ok: false,
        error: `**${site.label}** auto-uploads can only be scheduled inside an **Age-Restricted (NSFW)** Discord channel.`,
      };
    }

    const tagCheck = validateUserTags(rawTags);
    if (!tagCheck.ok) {
      return { ok: false, error: `Tag \`${tagCheck.blockedTag}\` is blocked by safety rules.` };
    }

    const guildSchedules = this.getGuildSchedules(guildId);
    if (guildSchedules.length >= 15) {
      return { ok: false, error: 'Maximum of 15 active auto-upload schedules reached for this server.' };
    }

    const tz = this.getGuildTimezone(guildId);
    const clock = getClockInTimezone(tz);

    let initialLastRunDate = null;
    if (mode === 'daily' && time) {
      const [hh, mm] = time.split(':').map(Number);
      const targetMins = hh * 60 + mm;
      // If today's scheduled time already passed, mark today done so first run happens tomorrow at `time`
      if (targetMins < clock.totalMinutes) {
        initialLastRunDate = clock.dateKey;
      }
    }

    const schedule = {
      id: this.state.nextId++,
      guildId,
      channelId,
      siteId: site.id,
      siteLabel: site.label,
      mode, // 'daily' | 'interval'
      time: mode === 'daily' ? time : null,
      intervalMinutes: mode === 'interval' ? intervalMinutes : null,
      tags: tagCheck.tags,
      count: Math.max(1, Math.min(5, Number(count) || 1)),
      lastRunDate: initialLastRunDate,
      lastRunAt: mode === 'interval' ? Date.now() : null,
      createdAt: Date.now(),
    };

    this.state.schedules.push(schedule);
    this._saveState();
    return { ok: true, schedule, clock };
  }

  removeSchedule(guildId, idOrAll) {
    if (String(idOrAll).toLowerCase() === 'all') {
      const before = this.state.schedules.length;
      this.state.schedules = this.state.schedules.filter((s) => s.guildId !== guildId);
      const removed = before - this.state.schedules.length;
      if (removed > 0) this._saveState();
      return { removed, all: true };
    }

    const cleanId = String(idOrAll).replace(/^#/, '');
    const idx = this.state.schedules.findIndex(
      (s) => s.guildId === guildId && String(s.id) === cleanId
    );
    if (idx === -1) return { removed: 0, all: false };
    const [deleted] = this.state.schedules.splice(idx, 1);
    this._saveState();
    return { removed: 1, deleted, all: false };
  }

  async triggerScheduleNow(schedule, { manual = false } = {}) {
    if (!schedule || this.runningIds.has(schedule.id)) return { ok: false, error: 'Already running' };
    this.runningIds.add(schedule.id);

    try {
      const channel = await this.client.channels.fetch(schedule.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return { ok: false, error: 'Target channel no longer exists or is inaccessible.' };
      }

      const site = resolveBooruSite(schedule.siteId);
      const allowNsfw = site?.id !== 'safebooru';

      const result = await fetchBooruPosts({
        siteInput: schedule.siteId,
        rawTags: schedule.tags,
        allowNsfw,
        count: schedule.count || 1,
        guildId: schedule.guildId,
      });

      if (result.posts.length === 0) {
        const emptyMsg = `No matching posts found on **${schedule.siteLabel}** for \`${schedule.tags.join(' ') || 'random'}\`.`;
        if (manual) await channel.send(msg(emptyMsg)).catch(() => {});
        return { ok: false, error: emptyMsg };
      }

      const headerPrefix =
        schedule.mode === 'daily'
          ? `Daily Auto-Upload (#${schedule.id})`
          : `Scheduled Upload (#${schedule.id})`;

      await deliverBooruResult((opts) => channel.send(opts), {
        site: result.site,
        posts: result.posts,
        usedTags: result.usedTags,
        headerPrefix,
        includeNextButton: true,
      });
      return { ok: true };
    } catch (err) {
      if (err?.missingAuth && err.site) {
        const channel = await this.client.channels.fetch(schedule.channelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send(msg(buildMissingKeyMessage(err.site))).catch(() => {});
        }
      }
      return { ok: false, error: err?.message || String(err) };
    } finally {
      this.runningIds.delete(schedule.id);
    }
  }

  async _tick() {
    if (!this.client?.isReady() || this.state.schedules.length === 0) return;

    const now = new Date();
    const nowMs = now.getTime();
    let dirty = false;

    for (const sched of this.state.schedules) {
      if (this.runningIds.has(sched.id)) continue;

      if (sched.mode === 'daily' && sched.time) {
        const tz = this.getGuildTimezone(sched.guildId);
        const clock = getClockInTimezone(tz, now);
        if (sched.lastRunDate === clock.dateKey) continue;

        const [hh, mm] = sched.time.split(':').map(Number);
        const targetMins = hh * 60 + mm;
        const diff = clock.totalMinutes - targetMins;

        // Fire when within [0, 15] minutes of scheduled daily HH:MM
        if (diff >= 0 && diff <= 15) {
          sched.lastRunDate = clock.dateKey;
          sched.lastRunAt = nowMs;
          dirty = true;
          this._saveState();
          this.triggerScheduleNow(sched).catch(() => {});
        }
      } else if (sched.mode === 'interval' && sched.intervalMinutes) {
        const intervalMs = sched.intervalMinutes * 60_000;
        const last = sched.lastRunAt || sched.createdAt || 0;
        if (nowMs - last >= intervalMs) {
          sched.lastRunAt = nowMs;
          dirty = true;
          this._saveState();
          this.triggerScheduleNow(sched).catch(() => {});
        }
      }
    }

    if (dirty) this._saveState();
  }

  buildSchedulesPanel(guildId) {
    const schedules = this.getGuildSchedules(guildId);
    const tz = this.getGuildTimezone(guildId);
    const clock = getClockInTimezone(tz);
    const c = new ContainerBuilder();

    if (schedules.length === 0) {
      c.addTextDisplayComponents(
        text(
          `**Auto-Upload Schedules**\n` +
          `-# No active schedules · Bot clock: **${clock.formattedTime}** (${clock.timezone})\n\n` +
          `**Examples:**\n` +
          `\`!autopost gelbooru 18:00 blue_archive\` — post every day at 18:00\n` +
          `\`!autopost r34 22:30 x2 overwatch\` — post 2 images daily at 22:30\n` +
          `\`!autopost safebooru every 6h hatsune_miku\` — post every 6 hours\n` +
          `\`!autopost tz UTC+1\` — change your server's clock timezone`
        )
      );
      return { components: [c], flags: MessageFlags.IsComponentsV2 };
    }

    c.addTextDisplayComponents(text('**Active Auto-Upload Schedules**'));
    c.addSeparatorComponents(thinDivider());

    schedules.forEach((s, idx) => {
      if (idx > 0) c.addSeparatorComponents(thinSpacer());
      const whenLabel =
        s.mode === 'daily' ? `daily at **${s.time}**` : `**${formatIntervalLabel(s.intervalMinutes)}**`;
      const tagStr = s.tags.length > 0 ? `\`${s.tags.join(' ')}\`` : '`random`';
      const countTag = s.count > 1 ? ` · ×${s.count}` : '';

      c.addTextDisplayComponents(
        text(
          `**#${s.id}** · **${s.siteLabel}** ${tagStr}${countTag}\n` +
          `-# Runs ${whenLabel} in <#${s.channelId}>`
        )
      );

      // Interactive Run Now + Remove buttons for first 4 schedules (leaving 1 row margin)
      if (idx < 4) {
        c.addActionRowComponents(
          actionRow(
            button(`autopost:now:${s.id}`, `Post #${s.id} Now`, ButtonStyle.Primary),
            button(`autopost:del:${s.id}`, `Delete #${s.id}`, ButtonStyle.Danger)
          )
        );
      }
    });

    c.addSeparatorComponents(thinDivider());
    c.addTextDisplayComponents(
      text(
        `-# Current bot clock: **${clock.formattedTime}** (${clock.timezone}) · Change with \`!autopost tz <Zone|UTC+X>\` · Remove with \`!autopost remove <id|all>\``
      )
    );

    return { components: [c], flags: MessageFlags.IsComponentsV2 };
  }
}
