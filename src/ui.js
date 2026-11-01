// Made by Asto

import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';

const FLAGS = MessageFlags.IsComponentsV2;

function thinDivider() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);
}

function thinSpacer() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false);
}

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function button(customId, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function actionRow(...buttons) {
  return new ActionRowBuilder().addComponents(...buttons);
}

// Single block of text in a container
export function msg(content) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(content));
  return { components: [c], flags: FLAGS };
}

// Single block of text + a row of interactive buttons inside the V2 container
export function msgWithButtons(content, ...buttons) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(content));
  if (buttons.length > 0) {
    c.addSeparatorComponents(thinDivider());
    c.addActionRowComponents(actionRow(...buttons));
  }
  return { components: [c], flags: FLAGS };
}

// Compact 5-button row for !bots multi-bot panel (max 5 buttons per row)
export function buildBotControlRow(
  botId,
  { isOnline = true, isSneaking = false, mode = 'afk' } = {}
) {
  const isPlaying = mode === 'play';
  const isFollowing = mode === 'follow';
  return actionRow(
    button(
      `bot:play:${botId}`,
      isPlaying ? 'Play: ON' : 'Play',
      isPlaying ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(
      `bot:follow:${botId}`,
      isFollowing ? 'Follow: ON' : 'Follow',
      isFollowing ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(`bot:jump:${botId}`, 'Jump', ButtonStyle.Secondary, !isOnline),
    button(
      `bot:sneak:${botId}`,
      isSneaking ? 'Sneak: ON' : 'Sneak',
      isSneaking ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(`bot:leave:${botId}`, 'Leave', ButtonStyle.Danger, false)
  );
}

// Two rich control rows for a single connected bot card (Modes + Quick Actions)
export function buildBotCardRows(
  botId,
  { isOnline = true, isSneaking = false, mode = 'afk' } = {}
) {
  const isPlaying = mode === 'play';
  const isFollowing = mode === 'follow';
  const isDancing = mode === 'dance';

  const modeRow = actionRow(
    button(
      `bot:play:${botId}`,
      isPlaying ? 'Play: ON' : 'Play Mode',
      isPlaying ? ButtonStyle.Success : ButtonStyle.Primary,
      !isOnline
    ),
    button(
      `bot:follow:${botId}`,
      isFollowing ? 'Following' : 'Follow Nearest',
      isFollowing ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(
      `bot:dance:${botId}`,
      isDancing ? 'Dancing' : 'Dance',
      isDancing ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(
      `bot:stop:${botId}`,
      'AFK / Stop',
      ButtonStyle.Secondary,
      !isOnline || mode === 'afk'
    )
  );

  const actionRowBar = actionRow(
    button(`bot:jump:${botId}`, 'Jump', ButtonStyle.Secondary, !isOnline),
    button(
      `bot:sneak:${botId}`,
      isSneaking ? 'Sneak: ON' : 'Sneak: OFF',
      isSneaking ? ButtonStyle.Success : ButtonStyle.Secondary,
      !isOnline
    ),
    button(`bot:hit:${botId}`, 'Wave / Hit', ButtonStyle.Secondary, !isOnline),
    button(`bot:coords:${botId}`, 'Coords', ButtonStyle.Primary, !isOnline),
    button(`bot:leave:${botId}`, 'Leave', ButtonStyle.Danger, false)
  );

  return [modeRow, actionRowBar];
}

// Multiple text sections split by thin dividers
export function msgSections(...sections) {
  const c = new ContainerBuilder();
  sections.forEach((content, i) => {
    if (i > 0) c.addSeparatorComponents(thinDivider());
    c.addTextDisplayComponents(text(content));
  });
  return { components: [c], flags: FLAGS };
}

// Titled list: header + divider + one row per item + divider + optional footer
export function msgList(header, rows, footer) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(header));
  c.addSeparatorComponents(thinDivider());

  rows.forEach((row, i) => {
    if (i > 0) c.addSeparatorComponents(thinSpacer());
    c.addTextDisplayComponents(text(row));
  });

  if (footer) {
    c.addSeparatorComponents(thinDivider());
    c.addTextDisplayComponents(text(footer));
  }

  return { components: [c], flags: FLAGS };
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

// Re-export builders so index.js & BotManager.js can compose custom panels directly
export {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  thinDivider,
  thinSpacer,
  text,
  button,
  actionRow,
};
