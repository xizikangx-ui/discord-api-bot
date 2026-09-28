require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const proxyUrl = process.env.DISCORD_PROXY_URL || process.env.HTTPS_PROXY;
if (proxyUrl) {
  // discord.js uses the `ws` package on Node.js; pass it an explicit CONNECT agent.
  // Node's global fetch proxy setting alone does not proxy that WebSocket implementation.
  const https = require('node:https');
  const wsModule = require('ws');
  const WebSocket = wsModule.WebSocket;
  const proxyAgent = new https.Agent({ proxyEnv: { HTTPS_PROXY: proxyUrl } });
  wsModule.WebSocket = new Proxy(WebSocket, {
    construct(target, args, newTarget) {
      if (String(args[0]).startsWith('wss:')) {
        const options = args[2] && typeof args[2] === 'object' ? args[2] : {};
        args[2] = { ...options, agent: proxyAgent };
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  console.log(`Discord 网关代理已启用：${new URL(proxyUrl).host}`);
}
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType,
  PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'API_BASE_URL', 'API_KEY', 'API_MODEL'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT = 28 * DAY;
const TIMEOUT_REFRESH = 27 * DAY;
const historyLimit = Math.max(0, Number.parseInt(process.env.MAX_HISTORY_MESSAGES || '12', 10));
const histories = new Map();
const pendingManagementActions = new Map();
const pendingManagementPanelSelections = new Map();
const pendingPunishments = new Map();
const managementSyncTimers = new Map();
const timeoutFile = path.join(__dirname, '..', 'data', 'long-timeouts.json');
const guildDataFile = path.join(__dirname, '..', 'data', 'guild-settings.json');
const pendingPunishmentsDir = path.join(__dirname, '..', 'data', 'pending-punishments');
const PUNISHMENT_CONFIRM_TTL = 15 * 60 * 1000;
let longTimeouts = [];
let guildData = { settings: {}, reminders: [], warningFollowups: [], warningExpirations: [], punishmentCases: [] };

function pendingPunishmentPath(token) {
  if (!/^[a-f0-9]{16}$/.test(token || '')) return null;
  return path.join(pendingPunishmentsDir, `${token}.json`);
}

async function savePendingPunishment(token, request) {
  const file = pendingPunishmentPath(token);
  if (!file) throw new Error('无效的处罚确认编号。');
  await fs.mkdir(pendingPunishmentsDir, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
}

async function readPendingPunishment(token) {
  const file = pendingPunishmentPath(token);
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function claimPendingPunishment(token) {
  const file = pendingPunishmentPath(token);
  if (!file) return null;
  const lock = `${file}.lock`;
  const processing = `${file}.processing`;
  const claimed = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.processing`;
  let lockHandle;
  try {
    lockHandle = await fs.open(lock, 'wx');
    await lockHandle.close();
    await fs.rename(file, claimed);
    await fs.rename(claimed, processing);
    return { request: JSON.parse(await fs.readFile(processing, 'utf8')), claimed: processing, lock };
  } catch (error) {
    await fs.unlink(claimed).catch(() => {});
    await fs.unlink(lock).catch(() => {});
    if (error.code === 'ENOENT' || error.code === 'EEXIST' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function recoverPunishmentFromConfirmationMessage(interaction) {
  const content = interaction.message?.content || '';
  const targetId = content.match(/^目标成员：<@!?([0-9]+)>$/m)?.[1];
  const modeText = content.match(/^处罚方式：(警告并禁言|仅禁言|仅警告)$/m)?.[1];
  const timeoutDays = content.match(/^禁言时长：([0-9]+) 天$/m)?.[1];
  const warningDaysText = content.match(/^警告时长：([0-9]+) 天$/m)?.[1];
  const reasonMatch = content.match(/^原因：(.*?)(?:\n\n此确认仅限你本人操作，)/ms);
  if (!targetId || !modeText || !reasonMatch) return null;
  const mode = modeText === '警告并禁言' ? 'both' : modeText === '仅禁言' ? 'timeout' : 'warning';
  const createdAt = interaction.message.createdTimestamp || Date.now();
  return {
    guildId: interaction.guildId,
    userId: targetId,
    mode,
    reason: reasonMatch[1].trim(),
    timeoutDays: timeoutDays ? Number(timeoutDays) : undefined,
    warningDays: warningDaysText ? Number(warningDaysText) : undefined,
    createdAt,
    moderatorId: interaction.message.interactionMetadata?.user?.id || interaction.user.id,
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName('提问').setDescription('向已接入的 AI/API 提问')
    .addStringOption((o) => o.setName('问题').setDescription('请输入你想问的内容').setRequired(true).setMaxLength(4000)),
  new SlashCommandBuilder()
    .setName('说话').setDescription('让机器人以自己的身份在当前频道或子区发言')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('内容').setDescription('机器人要发送的消息').setRequired(true).setMaxLength(1900))
    .addStringOption((o) => o.setName('回复消息链接').setDescription('可选：粘贴当前频道/子区中要回复的消息链接').setRequired(false).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('编辑说话').setDescription('通过消息链接编辑机器人之前发送的消息')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('消息链接').setDescription('粘贴机器人消息的 Discord 链接').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('新内容').setDescription('替换后的消息内容').setRequired(true).setMaxLength(1900)),
  new SlashCommandBuilder()
    .setName('配置身份组').setDescription('为成员添加或移除身份组')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) => s.setName('添加').setDescription('给成员添加身份组')
      .addUserOption((o) => o.setName('成员').setDescription('要配置的成员').setRequired(true))
      .addRoleOption((o) => o.setName('身份组').setDescription('要添加的身份组').setRequired(true)))
    .addSubcommand((s) => s.setName('移除').setDescription('移除成员的身份组')
      .addUserOption((o) => o.setName('成员').setDescription('要配置的成员').setRequired(true))
      .addRoleOption((o) => o.setName('身份组').setDescription('要移除的身份组').setRequired(true))),
  new SlashCommandBuilder()
    .setName('处罚面板').setDescription('发送并配置本服务器的处罚面板')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理组面板').setDescription('配置管理组任命、卸任和公示名单')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理组名单').setDescription('查看当前管理组成员和任职时间')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理组卸任').setDescription('当前管理组成员自行申请卸任')
    .addStringOption((o) => o.setName('理由').setDescription('卸任理由（可选）').setRequired(false).setMaxLength(400)),
  new SlashCommandBuilder()
    .setName('中层管理面板').setDescription('配置中层管理任命、卸任和公示名单')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('中层管理名单').setDescription('查看当前中层管理成员和任职时间')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((o) => o.setName('身份组').setDescription('选择要查看的中层身份组').setRequired(true)),
  new SlashCommandBuilder()
    .setName('中层管理卸任').setDescription('当前中层管理成员自行申请卸任')
    .addRoleOption((o) => o.setName('身份组').setDescription('选择要卸任的中层身份组').setRequired(true))
    .addStringOption((o) => o.setName('理由').setDescription('卸任理由（可选）').setRequired(false).setMaxLength(400)),
  new SlashCommandBuilder()
    .setName('处罚').setDescription('警告、禁言或同时执行警告和禁言')
    .addStringOption((o) => o.setName('方式').setDescription('选择处罚方式').setRequired(true)
      .addChoices({ name: '仅警告', value: 'warning' }, { name: '仅禁言', value: 'timeout' }, { name: '警告并禁言', value: 'both' }))
    .addUserOption((o) => o.setName('成员').setDescription('被处罚成员').setRequired(true))
    .addStringOption((o) => o.setName('原因').setDescription('处罚原因').setRequired(true).setMaxLength(400))
    .addIntegerOption((o) => o.setName('禁言天数').setDescription('禁言时长（1 到 90 天；仅禁言或警告并禁言时填写）').setRequired(false).setMinValue(1).setMaxValue(90))
    .addIntegerOption((o) => o.setName('警告天数').setDescription('警告身份组保留天数（1 到 90；留空则不自动移除）').setRequired(false).setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder()
    .setName('撤销处罚').setDescription('按处罚 ID 撤销当前生效的警告和/或禁言')
    .addStringOption((o) => o.setName('处罚编号').setDescription('处罚记录中的编号').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('定时提醒').setDescription('管理定时提及提醒')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('添加').setDescription('添加定时提醒（到期后自动重复，间隔为 0 表示只提醒一次）')
      .addChannelOption((o) => o.setName('频道').setDescription('发送提醒的频道').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('分钟后').setDescription('首次提醒在多少分钟后发送').setRequired(true).setMinValue(1).setMaxValue(525600))
      .addIntegerOption((o) => o.setName('重复间隔分钟').setDescription('0 表示只发送一次；最小重复间隔 10 分钟').setRequired(true).setMinValue(0).setMaxValue(525600))
      .addStringOption((o) => o.setName('内容').setDescription('提醒文字').setRequired(true).setMaxLength(1500))
      .addUserOption((o) => o.setName('提及成员').setDescription('要提醒的某个人（可选）').setRequired(false))
      .addRoleOption((o) => o.setName('提及身份组').setDescription('要提醒的身份组（可选）').setRequired(false)))
    .addSubcommand((s) => s.setName('列表').setDescription('查看本服务器的定时提醒'))
    .addSubcommand((s) => s.setName('删除').setDescription('按编号删除一个定时提醒')
      .addStringOption((o) => o.setName('编号').setDescription('在提醒列表中查看编号').setRequired(true).setMaxLength(40))),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildIds = [...new Set((process.env.DISCORD_GUILD_IDS || process.env.DISCORD_GUILD_ID || '')
    .split(',').map((id) => id.trim()).filter(Boolean))];
  const body = commands.map((command) => command.toJSON());
  if (guildIds.length) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body });
    }
    console.log(`Registered ${commands.length} commands for ${guildIds.length} server(s).`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body });
    console.log(`Registered ${commands.length} commands globally.`);
  }
}

function endpointUrl() {
  const base = process.env.API_BASE_URL.replace(/\/+$/, '');
  const endpoint = (process.env.API_PATH || '/chat/completions').replace(/^\/+/, '');
  return new URL(`${base}/${endpoint}`);
}

async function askApi(messages) {
  const response = await fetch(endpointUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.API_MODEL, messages }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('API response did not contain choices[0].message.content.');
  return answer.trim();
}

function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  while (text.length > maxLength) {
    let cut = text.lastIndexOf('\n', maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

async function saveTimeouts() {
  await fs.mkdir(path.dirname(timeoutFile), { recursive: true });
  const temp = `${timeoutFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(longTimeouts, null, 2), 'utf8');
  await fs.rename(temp, timeoutFile);
}

async function loadTimeouts() {
  try {
    longTimeouts = JSON.parse(await fs.readFile(timeoutFile, 'utf8'));
    if (!Array.isArray(longTimeouts)) longTimeouts = [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read saved timeout schedule:', error);
    longTimeouts = [];
  }
}

let guildSaveQueue = Promise.resolve();
let guildSaveVersion = 0;
async function saveGuildData() {
  await fs.mkdir(path.dirname(guildDataFile), { recursive: true });
  const snapshot = JSON.stringify(guildData, null, 2);
  const version = ++guildSaveVersion;
  const write = guildSaveQueue.catch(() => {}).then(async () => {
    const temp = `${guildDataFile}.${process.pid}.${version}.tmp`;
    await fs.writeFile(temp, snapshot, 'utf8');
    await fs.rename(temp, guildDataFile);
  });
  guildSaveQueue = write;
  await write;
}

async function loadGuildData() {
  try {
    const saved = JSON.parse(await fs.readFile(guildDataFile, 'utf8'));
    guildData = { settings: saved.settings || {}, reminders: saved.reminders || [], warningFollowups: saved.warningFollowups || [], warningExpirations: saved.warningExpirations || [], punishmentCases: saved.punishmentCases || [] };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read guild settings:', error.message);
    guildData = { settings: {}, reminders: [], warningFollowups: [], warningExpirations: [], punishmentCases: [] };
  }
}

function settingsFor(guildId) {
  guildData.settings[guildId] ||= { secondWarningReminder: false };
  managementTrack(guildData.settings[guildId], 'senior');
  managementTrack(guildData.settings[guildId], 'middle');
  return guildData.settings[guildId];
}

function managementTrack(setting, tier = 'senior', requestedRoleId = null) {
  if (tier === 'middle') {
    setting.middleManagementGroups ||= {};
    if (setting.middleManagementRoleId && !setting.middleManagementGroups[setting.middleManagementRoleId]) {
    setting.middleManagementGroups[setting.middleManagementRoleId] = {
        roleId: setting.middleManagementRoleId,
        channelId: null,
        parentChannelId: setting.middleManagementChannelId || null,
        legacyRosterMessageId: setting.middleManagementRosterMessageId || null,
        terms: setting.middleManagementTerms || [],
      };
    }
    delete setting.middleManagementRoleId;
    delete setting.middleManagementChannelId;
    delete setting.middleManagementRosterMessageId;
    delete setting.middleManagementTerms;
    const roleId = requestedRoleId || null;
    const group = roleId ? (setting.middleManagementGroups[roleId] ||= { roleId, channelId: null, rosterMessageId: null, terms: [] }) : null;
    if (group) {
      group.terms ||= [];
      group.rosterMessageIds ||= group.rosterMessageId ? [group.rosterMessageId] : [];
    }
    return { tier, roleId, channelId: group?.channelId || null, announcementChannelId: group?.announcementChannelId || null, rosterMessageId: group?.rosterMessageId || null,
      rosterMessageIds: group?.rosterMessageIds || [],
      terms: group?.terms || [], group, label: '中层管理', prefix: 'midmgmt' };
  }
  setting.managementTerms ||= [];
  setting.managementRosterMessageIds ||= setting.managementRosterMessageId ? [setting.managementRosterMessageId] : [];
  return { tier: 'senior', roleId: setting.managementRoleId || null, channelId: setting.managementChannelId || null,
    announcementChannelId: setting.managementAnnouncementChannelId || null,
    rosterMessageId: setting.managementRosterMessageId || null, rosterMessageIds: setting.managementRosterMessageIds, terms: setting.managementTerms,
    label: '管理组', prefix: 'mgmt' };
}

function setManagementTrackChannel(setting, track, channelId) {
  if (track.tier === 'middle') track.group.channelId = channelId;
  else setting.managementChannelId = channelId;
}

function setManagementAnnouncementChannel(setting, track, channelId) {
  track.announcementChannelId = channelId;
  if (track.tier === 'middle') track.group.announcementChannelId = channelId;
  else setting.managementAnnouncementChannelId = channelId;
}

function setManagementTrackRole(setting, track, roleId) {
  if (track.tier === 'middle') track.group.roleId = roleId;
  else setting.managementRoleId = roleId;
}

function setManagementTrackRosterMessage(setting, track, messageIds) {
  const ids = Array.isArray(messageIds) ? messageIds : messageIds ? [messageIds] : [];
  track.rosterMessageIds = ids;
  track.rosterMessageId = ids[0] || null;
  if (track.tier === 'middle') {
    track.group.rosterMessageIds = ids;
    track.group.rosterMessageId = ids[0] || null;
  } else {
    setting.managementRosterMessageIds = ids;
    setting.managementRosterMessageId = ids[0] || null;
  }
}

async function deleteManagementRosterMessages(guild, setting, track, channelId = track.channelId) {
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    for (const messageId of track.rosterMessageIds || (track.rosterMessageId ? [track.rosterMessageId] : [])) {
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message) await message.delete().catch(() => {});
    }
  }
  setManagementTrackRosterMessage(setting, track, []);
}

async function ensureManagementAnnouncementThread(guild, tier = 'senior', roleId = null) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  const parentId = tier === 'middle' ? track.group?.parentChannelId : track.channelId;
  if (!parentId) throw new Error(`请先设置${track.label}公示频道或子区。`);
  if (track.announcementChannelId) {
    const existing = await guild.channels.fetch(track.announcementChannelId).catch(() => null);
    if (existing?.isThread() && existing.parentId === parentId) {
      if (existing.archived) await existing.setArchived(false, '发布管理组任免公示');
      return existing;
    }
    setManagementAnnouncementChannel(setting, track, null);
  }
  const parent = await guild.channels.fetch(parentId).catch(() => null);
  const botMember = await guild.members.fetchMe();
  const permissions = parent?.permissionsFor(botMember);
  if (!parent?.isTextBased() || parent.isThread()
    || !permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.CreatePublicThreads)
    || !permissions.has(PermissionFlagsBits.SendMessagesInThreads)
    || !permissions.has(PermissionFlagsBits.ManageThreads)) {
    throw new Error(`请确认 Bot 在${track.label}公示频道有查看、发送、创建公开帖子、在帖子中发送消息和管理帖子的权限。`);
  }
  const role = track.roleId ? await guild.roles.fetch(track.roleId).catch(() => null) : null;
  const thread = await parent.threads.create({
    name: `${role?.name || track.label} 任免公示`.slice(0, 100),
    autoArchiveDuration: 10080,
    reason: `为${track.label}任命与卸任公示创建独立子区`,
  });
  setManagementAnnouncementChannel(setting, track, thread.id);
  await saveGuildData();
  return thread;
}

async function postPunishment(guild, { user, moderator, mode, reason, timeoutDays, hasWarning, warningDays, caseId, replacedCaseId = null }) {
  const setting = settingsFor(guild.id);
  if (!setting.logChannelId) return { primarySent: false, auditSent: !setting.auditChannelId };
  const channel = await guild.channels.fetch(setting.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return { primarySent: false, auditSent: !setting.auditChannelId };
  const action = mode === 'both' ? '警告并禁言' : mode === 'timeout' ? '禁言处罚' : '警告处罚';
  const embed = new EmbedBuilder().setColor(timeoutDays ? 0xE67E22 : 0xF1C40F)
    .setTitle(`${timeoutDays ? '🔇' : '⚠️'} ${action}`)
    .addFields(
      { name: '成员', value: `<@${user.id}>`, inline: true },
      { name: '管理员', value: `<@${moderator.id}>`, inline: true },
      { name: '原因', value: reason.slice(0, 1024) },
      ...(hasWarning ? [{ name: '警告', value: warningDays ? `${warningDays} 天` : '不自动移除', inline: true }] : []),
      ...(timeoutDays ? [{ name: '禁言时长', value: `${timeoutDays} 天`, inline: true }] : []),
      { name: '处罚 ID', value: caseId, inline: false },
      ...(replacedCaseId ? [{ name: '覆盖处罚', value: replacedCaseId, inline: false }] : []),
    ).setThumbnail(user.displayAvatarURL({ size: 128 })).setTimestamp();
  return sendPunishmentEmbed(guild, embed);
}

async function postPunishmentRevocation(guild, record, moderator) {
  const setting = settingsFor(guild.id);
  if (!setting.logChannelId) return { primarySent: false, auditSent: !setting.auditChannelId };
  const channel = await guild.channels.fetch(setting.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return { primarySent: false, auditSent: !setting.auditChannelId };
  const fields = [
    { name: '成员', value: `<@${record.userId}>`, inline: true },
    { name: '撤销人', value: `<@${moderator.id}>`, inline: true },
    { name: '被撤销处罚 ID', value: record.id, inline: false },
    { name: '撤销内容', value: [record.hasWarning ? '警告' : null, record.hasTimeout ? '禁言' : null].filter(Boolean).join(' + '), inline: true },
  ];
  return sendPunishmentEmbed(guild, new EmbedBuilder().setColor(0x95A5A6).setTitle('↩️ 处罚已撤销').addFields(...fields).setTimestamp());
}

async function sendPunishmentEmbed(guild, embed) {
  const setting = settingsFor(guild.id);
  const channelIds = [...new Set([setting.logChannelId, setting.auditChannelId].filter(Boolean))];
  let primarySent = false;
  let auditSent = !setting.auditChannelId || setting.auditChannelId === setting.logChannelId;
  for (const channelId of channelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      console.error(`Punishment log channel ${channelId} is unavailable.`);
      continue;
    }
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      if (channelId === setting.logChannelId) primarySent = true;
      if (channelId === setting.auditChannelId) auditSent = true;
    } catch (error) {
      console.error(`Could not write punishment log to ${channelId}:`, error.message);
    }
  }
  return { primarySent, auditSent };
}

async function validatePunishmentRequest(interaction, request) {
  const hasWarning = request.mode !== 'timeout';
  const hasTimeout = request.mode !== 'warning';
  const guild = interaction.guild;
  const user = await client.users.fetch(request.userId);
  const [member, botMember] = await Promise.all([guild.members.fetch(user.id), guild.members.fetchMe()]);
  const setting = settingsFor(guild.id);
  const previousCase = guildData.punishmentCases.find((item) => item.guildId === guild.id && item.userId === user.id && item.status === 'active');
  const botNeedsRoles = hasWarning || Boolean(previousCase?.hasWarning && !hasWarning);
  const botNeedsModeration = hasTimeout || Boolean(previousCase?.hasTimeout && !hasTimeout);
  if (botNeedsRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('机器人缺少“管理身份组”权限，无法执行或覆盖警告。');
  }
  if (botNeedsModeration && !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error('机器人缺少“管理成员”权限，无法执行或解除禁言。');
  }
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    throw new Error('机器人身份组必须高于被处罚成员的最高身份组。');
  }
  if (!setting.logChannelId) throw new Error('尚未配置处罚记录频道。请先运行 `/处罚面板` 进行设置。');
  let warningRole = null;
  if (setting.warningRoleId) {
    warningRole = await guild.roles.fetch(setting.warningRoleId);
    if (hasWarning && (!warningRole || warningRole.id === guild.id || warningRole.managed || warningRole.position >= botMember.roles.highest.position)) {
      throw new Error('警告身份组无效或高于机器人身份组，请检查面板设置和身份组层级。');
    }
  } else if (hasWarning) {
    throw new Error('尚未设置警告身份组。请先运行 `/处罚面板` 并选择警告身份组。');
  }
  return { guild, user, member, botMember, setting, warningRole, previousCase, hasWarning, hasTimeout };
}

async function executePunishmentRequest(interaction, request) {
  const { guild, user, member, setting, warningRole, previousCase, hasWarning, hasTimeout } = await validatePunishmentRequest(interaction, request);
  const { mode, reason, timeoutDays, warningDays } = request;
  const caseId = randomBytes(4).toString('hex');
  if (previousCase) {
    if (previousCase.hasWarning && (!hasWarning || previousCase.warningRoleId !== warningRole?.id)) {
      const previousRole = await guild.roles.fetch(previousCase.warningRoleId).catch(() => null);
      if (previousRole && member.roles.cache.has(previousRole.id)) {
        await member.roles.remove(previousRole, `处罚 ${caseId} 覆盖旧处罚 ${previousCase.id}`);
      }
    }
    if (previousCase.hasTimeout && !hasTimeout) await member.timeout(null, `处罚 ${caseId} 覆盖旧处罚 ${previousCase.id}`);
    previousCase.status = 'superseded';
    previousCase.supersededBy = caseId;
  }
  longTimeouts = longTimeouts.filter((job) => !(job.guildId === guild.id && job.userId === user.id));
  guildData.warningExpirations = guildData.warningExpirations.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
  guildData.warningFollowups = guildData.warningFollowups.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
  if (hasTimeout) {
    const endAt = Date.now() + timeoutDays * DAY;
    const until = Math.min(endAt, Date.now() + MAX_TIMEOUT);
    await member.timeout(until - Date.now(), reason);
    if (timeoutDays > 28) longTimeouts.push({ guildId: guild.id, userId: user.id, caseId, endAt, nextRefreshAt: until - DAY, reason });
  }
  if (hasWarning) {
    await member.roles.add(warningRole, `警告处罚 ${caseId}：${reason}`);
    if (warningDays) guildData.warningExpirations.push({ id: caseId, caseId, guildId: guild.id, userId: user.id, roleId: warningRole.id, expiresAt: Date.now() + warningDays * DAY });
    if (setting.secondWarningReminder) {
      guildData.warningFollowups.push({ id: `${caseId}-${user.id}`, caseId, guildId: guild.id, userId: user.id, guildName: guild.name, reason, dueAt: Date.now() + DAY });
    }
    await user.send(`你在“${guild.name}”收到警告。原因：${reason}`).catch(() => {});
  }
  guildData.punishmentCases.push({ id: caseId, guildId: guild.id, userId: user.id, moderatorId: interaction.user.id, mode, reason,
    hasWarning, warningRoleId: warningRole?.id || null, warningDays: warningDays || null,
    hasTimeout, timeoutDays: timeoutDays || null, status: 'active', createdAt: Date.now() });
  await Promise.all([saveGuildData(), saveTimeouts()]);
  const logged = await postPunishment(guild, { user, moderator: interaction.user, mode, reason, timeoutDays, hasWarning, warningDays, caseId, replacedCaseId: previousCase?.id || null });
  const summary = [`处罚已执行，编号：\`${caseId}\`。`, ...(hasWarning ? [`警告身份组${warningDays ? `将在 ${warningDays} 天后自动移除` : '不会自动移除'}。`] : []), ...(hasTimeout ? [`已禁言 ${timeoutDays} 天${timeoutDays > 28 ? '，并保存自动续期计划' : ''}。`] : []), ...(hasWarning && setting.secondWarningReminder ? ['已安排 24 小时后的私信提醒。'] : []), ...(!logged.primarySent ? ['处罚记录频道写入失败，请检查频道和 Bot 权限。'] : []), ...(!logged.auditSent ? ['留痕频道写入失败，请检查频道和 Bot 权限。'] : [])];
  return summary.join('\n');
}

async function processSchedules() {
  const now = Date.now();
  let changed = false;
  for (const reminder of [...guildData.reminders]) {
    if (reminder.nextAt > now) continue;
    try {
      const guild = await client.guilds.fetch(reminder.guildId);
      const channel = await guild.channels.fetch(reminder.channelId);
      const mention = reminder.userId ? `<@${reminder.userId}>` : reminder.roleId ? `<@&${reminder.roleId}>` : '';
      await channel.send({ content: `${mention} ${reminder.content}`.trim(),
        allowedMentions: { users: reminder.userId ? [reminder.userId] : [], roles: reminder.roleId ? [reminder.roleId] : [] } });
      if (reminder.intervalMs > 0) reminder.nextAt = now + reminder.intervalMs;
      else guildData.reminders = guildData.reminders.filter((item) => item.id !== reminder.id);
      changed = true;
    } catch (error) {
      console.error(`Reminder ${reminder.id} could not be sent:`, error.message);
      reminder.nextAt = now + 5 * 60 * 1000;
      changed = true;
    }
  }
  for (const followup of [...guildData.warningFollowups]) {
    if (followup.dueAt > now) continue;
    try {
      const user = await client.users.fetch(followup.userId);
      await user.send(`再次提醒：你在“${followup.guildName}”收到警告。原因：${followup.reason}`);
    } catch (error) {
      console.error(`Warning follow-up for ${followup.userId} could not be sent:`, error.message);
    }
    guildData.warningFollowups = guildData.warningFollowups.filter((item) => item.id !== followup.id);
    changed = true;
  }
  for (const expiration of [...guildData.warningExpirations]) {
    if (expiration.expiresAt > now) continue;
    try {
      const guild = await client.guilds.fetch(expiration.guildId);
      const member = await guild.members.fetch(expiration.userId);
      const role = await guild.roles.fetch(expiration.roleId);
      if (member && role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, `警告期限结束（处罚 ${expiration.caseId}）`);
      }
      guildData.warningExpirations = guildData.warningExpirations.filter((item) => item.id !== expiration.id);
      changed = true;
    } catch (error) {
      if (error.code === 10007 || error.code === 10011) {
        guildData.warningExpirations = guildData.warningExpirations.filter((item) => item.id !== expiration.id);
      } else {
        console.error(`Warning role expiration ${expiration.id} failed:`, error.message);
        expiration.expiresAt = now + 5 * 60 * 1000;
      }
      changed = true;
    }
  }
  if (changed) await saveGuildData();
}

function punishmentPanelEmbed(guildId) {
  const setting = settingsFor(guildId);
  return new EmbedBuilder().setColor(0x5865F2).setTitle('处罚设置面板')
    .setDescription(`处罚记录频道：${setting.logChannelId ? `<#${setting.logChannelId}>` : '尚未设置'}\n留痕频道：${setting.auditChannelId ? `<#${setting.auditChannelId}>` : '未启用'}\n警告身份组：${setting.warningRoleId ? `<@&${setting.warningRoleId}>` : '尚未设置'}\n警告二次提醒：${setting.secondWarningReminder ? '已开启（24 小时后私信成员）' : '关闭'}\n\n使用下方菜单配置。面板仅供本服务器管理员使用。`);
}

function punishmentPanel(guildId) {
  const setting = settingsFor(guildId);
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`punish-log:${guildId}`).setPlaceholder('选择处罚记录频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`punish-audit:${guildId}`).setPlaceholder('选择可选留痕频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`punish-role:${guildId}`).setPlaceholder('选择警告身份组')),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`punish-toggle:${guildId}`).setLabel(setting.secondWarningReminder ? '关闭二次提醒' : '开启二次提醒').setStyle(setting.secondWarningReminder ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`punish-audit-clear:${guildId}`).setLabel('清除留痕频道').setStyle(ButtonStyle.Secondary).setDisabled(!setting.auditChannelId),
    ),
  ];
}

function managementPanelComponents(guildId, tier = 'senior') {
  const { prefix, label } = managementTrack(settingsFor(guildId), tier);
  if (tier === 'middle') {
    return [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`${prefix}-role:${guildId}`).setPlaceholder('先选择一个中层管理身份组')),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${prefix}-parent:${guildId}`)
        .setPlaceholder('选择公示频道（将在其中创建子区）').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefix}-create:${guildId}`).setLabel('创建实时名单子区').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${prefix}-announcement:${guildId}`).setLabel('创建任免公示子区').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`${prefix}-appoint:${guildId}`)
        .setPlaceholder('为当前选择的身份组选人任命').setMinValues(1).setMaxValues(25)),
      new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`${prefix}-resign:${guildId}`)
        .setPlaceholder('为当前选择的身份组选人卸任').setMinValues(1).setMaxValues(25)),
    ];
  }
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${prefix}-channel:${guildId}`)
      .setPlaceholder(`选择${label}公示频道`).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`${prefix}-role:${guildId}`)
      .setPlaceholder(`选择${label}身份组`)),
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`${prefix}-appoint:${guildId}`)
      .setPlaceholder('多选成员并任命').setMinValues(1).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`${prefix}-resign:${guildId}`)
      .setPlaceholder('多选成员并卸任').setMinValues(1).setMaxValues(25)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}-refresh:${guildId}`).setLabel('刷新实时名单').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${prefix}-announcement:${guildId}`).setLabel('创建任免公示子区').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function managementPanelEmbed(guildId, tier = 'senior') {
  const setting = settingsFor(guildId);
  if (tier === 'middle') {
    const groups = Object.values(setting.middleManagementGroups || {});
    const list = groups.length
      ? groups.map((group) => `${group.roleId ? `<@&${group.roleId}>` : '身份组未设置'} · 实时名单 ${group.channelId ? `<#${group.channelId}>` : '未创建'} · 任免公示 ${group.announcementChannelId ? `<#${group.announcementChannelId}>` : '首次变更时自动创建'}`).join('\n')
      : '尚未配置中层身份组。';
    return new EmbedBuilder().setColor(0x5865F2).setTitle('中层管理公示与任命面板')
      .setDescription(`每个中层身份组分别管理实时名单子区和任免公示子区，任命、卸任记录在独立子区，实时名单位置保持不变。\n\n已配置身份组：${groups.length}\n${list}\n\n先选择身份组和公示频道，再分别创建实时名单与任免公示子区。`);
  }
  const track = managementTrack(setting, tier);
  return new EmbedBuilder().setColor(0x5865F2).setTitle(`${track.label}任命面板`)
    .setDescription(`实时名单位置：${track.channelId ? `<#${track.channelId}>` : '尚未设置'}\n任免公示子区：${track.announcementChannelId ? `<#${track.announcementChannelId}>` : '尚未创建'}\n${track.label}身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n当前任职人数：${track.terms.filter((term) => !term.endedAt && !term.isBot).length}\n\n使用上方菜单配置频道和身份组；选择成员可批量任命或卸任。任命、卸任记录发送到任免公示子区，实时名单位置保持不变。Bot 账号不计入名单。`);
}

function managementRosterEmbeds(guildId, tier = 'senior', roleId = null) {
  const setting = settingsFor(guildId);
  const track = managementTrack(setting, tier, roleId);
  const active = track.terms.filter((term) => !term.endedAt && !term.isBot);
  const lines = active.map((term) => `• <@${term.userId}> · <t:${Math.floor(term.startedAt / 1000)}:d>`);
  if (!lines.length) lines.push('目前没有在任成员。');
  const descriptionLimit = 3400;
  const pages = [];
  let pageLines = [];
  let pageLength = 0;
  for (const line of lines) {
    if (pageLines.length && pageLength + line.length + 1 > descriptionLimit) {
      pages.push(pageLines.join('\n'));
      pageLines = [];
      pageLength = 0;
    }
    pageLines.push(line);
    pageLength += line.length + (pageLines.length > 1 ? 1 : 0);
  }
  if (pageLines.length) pages.push(pageLines.join('\n'));
  return pages.map((page, index) => new EmbedBuilder().setColor(0x2ECC71)
    .setTitle(`当前${track.label}名单${pages.length > 1 ? `（${index + 1}/${pages.length}）` : ''}`)
    .setDescription(`${index === 0 ? `身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n\n` : ''}${page}`)
    .setFooter({ text: `本名单由机器人自动更新 · 共 ${active.length} 人${pages.length > 1 ? ` · 第 ${index + 1}/${pages.length} 页` : ''}` }).setTimestamp());
}

async function updateManagementRoster(guild, tier = 'senior', roleId = null) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  if (!track.channelId) return false;
  const channel = await guild.channels.fetch(track.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  if (channel.isThread() && channel.archived) await channel.setArchived(false, '刷新管理组公示名单');
  const embeds = managementRosterEmbeds(guild.id, tier, track.roleId);
  const existing = [];
  for (const messageId of track.rosterMessageIds || (track.rosterMessageId ? [track.rosterMessageId] : [])) {
    const message = await channel.messages.fetch(messageId).catch((error) => {
      if (error.code === 10008 || error.code === 10003) return null;
      throw error;
    });
    if (message) existing.push(message);
  }
  const nextIds = [];
  for (let index = 0; index < embeds.length; index += 1) {
    const payload = { embeds: [embeds[index]], allowedMentions: { parse: [] } };
    if (existing[index]) {
      await existing[index].edit(payload);
      nextIds.push(existing[index].id);
    } else {
      const message = await channel.send(payload);
      nextIds.push(message.id);
    }
  }
  for (const obsolete of existing.slice(embeds.length)) await obsolete.delete().catch(() => {});
  if (nextIds.join(',') !== (track.rosterMessageIds || []).join(',')) {
    setManagementTrackRosterMessage(setting, track, nextIds);
    await saveGuildData();
  }
  return true;
}

async function syncManagementRole(guild, tier = 'senior', memberList = null, roleId = null) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  if (!track.roleId || !track.channelId) return false;
  const role = await guild.roles.fetch(track.roleId);
  if (!role) return false;
  // Requires the privileged Server Members Intent in the Developer Portal.
  const members = memberList || await guild.members.fetch();
  const now = Date.now();
  const terms = track.terms;
  const activeTerms = terms.filter((term) => !term.endedAt && !term.isBot);
  const presentIds = new Set(members.filter((member) => !member.user.bot && member.roles.cache.has(role.id)).map((member) => member.id));
  const newlyDetected = [];
  const removed = [];
  let changed = false;
  for (const userId of presentIds) {
    if (activeTerms.some((term) => term.userId === userId)) continue;
    const member = members.get(userId);
    terms.push({ userId, startedAt: now, appointedBy: null,
      appointmentReason: `机器人开始同步时已持有${track.label}身份组；任期从该时刻起计算` });
    newlyDetected.push({ member });
    changed = true;
  }
  for (const term of activeTerms) {
    const member = members.get(term.userId);
    if (member?.user.bot) {
      term.endedAt = now;
      term.isBot = true;
      term.resignedBy = null;
      term.resignationReason = '机器人账号不纳入管理组名单和任期统计';
      changed = true;
      continue;
    }
    if (presentIds.has(term.userId)) continue;
    term.endedAt = now;
    term.resignedBy = null;
    term.resignationReason = '自动同步发现成员已不再持有管理组身份组';
    if (member) removed.push({ member, tenure: term.startedAt ? formatTenure(now - term.startedAt) : '任命时间未记录' });
    changed = true;
  }
  if (changed) await saveGuildData();
  if (newlyDetected.length) {
    await announceManagementChange(guild, { action: '登记', records: newlyDetected, moderator: client.user, tier, roleId: track.roleId,
      startedAt: now, showReason: false });
  }
  if (removed.length) {
    await announceManagementChange(guild, { action: '卸任', records: removed, moderator: client.user, tier, roleId: track.roleId,
      endedAt: now, showReason: false });
  }
  if (!newlyDetected.length && !removed.length) await updateManagementRoster(guild, tier, track.roleId);
  return true;
}

async function reconcileManagementMember(member, hasRole, tier = 'senior', roleId = null) {
  if (member.user.bot) return;
  const guild = member.guild;
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  if (!track.roleId || !track.channelId) return;
  const role = await guild.roles.fetch(track.roleId);
  if (!role) return;
  const terms = track.terms;
  const activeTerm = terms.find((term) => term.userId === member.id && !term.endedAt);
  const now = Date.now();
  if (hasRole && !activeTerm) {
    const record = { member, tenure: '' };
    terms.push({ userId: member.id, startedAt: now, appointedBy: null,
      appointmentReason: `检测到${track.label}身份组已添加；从此时开始计时` });
    await saveGuildData();
    await announceManagementChange(guild, { action: '任命', records: [record], moderator: client.user, startedAt: now, tier, roleId: track.roleId,
      showReason: false });
  } else if (!hasRole && activeTerm) {
    activeTerm.endedAt = now;
    activeTerm.resignedBy = null;
    activeTerm.resignationReason = '检测到管理组身份组已移除';
    await saveGuildData();
    const record = { member, tenure: activeTerm.startedAt ? formatTenure(now - activeTerm.startedAt) : '任命时间未记录' };
    await announceManagementChange(guild, { action: '卸任', records: [record], moderator: client.user, endedAt: now, tier, roleId: track.roleId,
      showReason: false });
  }
}

function scheduleManagementMemberSync(member, hasRole, tier = 'senior', roleId = null) {
  const key = `${tier}:${roleId || ''}:${member.guild.id}:${member.id}`;
  const existing = managementSyncTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    managementSyncTimers.delete(key);
    reconcileManagementMember(member, hasRole, tier, roleId).catch((error) => console.error(`${managementTrack(settingsFor(member.guild.id), tier, roleId).label}成员同步失败（${member.guild.id}/${member.id}）：`, error.message));
  }, 1200);
  managementSyncTimers.set(key, timer);
}

async function announceManagementChange(guild, { action, records, moderator, startedAt, endedAt, reason, showReason = true, tier = 'senior', roleId = null }) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  let channel = null;
  try {
    channel = await ensureManagementAnnouncementThread(guild, tier, roleId);
  } catch (error) {
    console.error(`${track.label}任免公示子区不可用，将尝试现有公示位置：`, error.message);
    channel = track.channelId ? await guild.channels.fetch(track.channelId).catch(() => null) : null;
  }
  if (!channel?.isTextBased()) return false;
  if (channel.isThread() && channel.archived) await channel.setArchived(false, '更新管理组任免公示');
  const embed = new EmbedBuilder().setColor(action === '任命' ? 0x2ECC71 : 0xE67E22)
    .setTitle(action === '登记' ? `📣 现任${track.label}成员登记` : action === '任命' ? `📣 ${track.label}任命公示` : `📣 ${track.label}卸任公示`)
    .addFields(
      { name: '成员', value: records.map((record) => `<@${record.member.id}>`).join('、').slice(0, 1024), inline: false },
      { name: '管理员', value: `<@${moderator.id}>`, inline: true },
      ...(action === '卸任' ? [
        { name: '卸任时间', value: `<t:${Math.floor(endedAt / 1000)}:F>`, inline: true },
        { name: '任职时长', value: records.map((record) => `<@${record.member.id}>：${record.tenure}`).join('\n').slice(0, 1024), inline: false },
      ] : [{ name: action === '登记' ? '开始计时' : '任命时间', value: `<t:${Math.floor(startedAt / 1000)}:F>`, inline: true }]),
      ...(showReason ? [{ name: '理由', value: (reason || '未填写').slice(0, 1024), inline: false }] : []),
    ).setTimestamp();
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  await updateManagementRoster(guild, tier, track.roleId);
  return true;
}

async function editManagementPanelSource(interaction, guildId, tier) {
  try {
    await interaction.editReply({ embeds: [managementPanelEmbed(guildId, tier)], components: managementPanelComponents(guildId, tier) });
    return true;
  } catch (error) {
    if (error.code === 10008 || error.code === 10003) return false;
    throw error;
  }
}

function formatTenure(milliseconds) {
  const totalDays = Math.max(0, Math.floor(milliseconds / DAY));
  const months = Math.floor(totalDays / 30);
  const days = totalDays % 30;
  const hours = Math.floor((milliseconds % DAY) / (60 * 60 * 1000));
  return [months ? `${months} 个月` : '', days ? `${days} 天` : '', !months && !days ? `${hours} 小时` : ''].filter(Boolean).join('');
}

async function executeManagementAction(guild, { action, memberIds, moderator, reason, tier = 'senior', roleId = null }) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  const terms = track.terms;
  const role = track.roleId ? await guild.roles.fetch(track.roleId) : null;
  if (!track.channelId || !role || role.managed || role.id === guild.id) {
    throw new Error(`${track.label}身份组或公示频道尚未正确配置。`);
  }
  const [botMember, members] = await Promise.all([
    guild.members.fetchMe(), Promise.all(memberIds.map((id) => guild.members.fetch(id))),
  ]);
  if (role.position >= botMember.roles.highest.position) throw new Error('机器人身份组必须高于管理组身份组。');
  if (members.some((member) => member.user.bot)) throw new Error('管理组名单仅统计真人账号，不能通过面板任命或卸任其他 Bot。');
  const isAdmin = moderator.id === guild.ownerId || (await guild.members.fetch(moderator.id)).permissions.has(PermissionFlagsBits.Administrator);
  const moderatorMember = isAdmin ? null : await guild.members.fetch(moderator.id);
  for (const member of members) {
    if (member.user.bot || member.id === guild.ownerId || member.id === botMember.id || member.roles.highest.position >= botMember.roles.highest.position
      || (moderatorMember && member.roles.highest.position >= moderatorMember.roles.highest.position)) {
      throw new Error(`无法管理成员 ${member.user.tag}：请检查身份组层级。`);
    }
  }

  const records = [];
  if (action === '任命') {
    const startedAt = Date.now();
    for (const member of members) {
      if (terms.some((term) => term.userId === member.id && !term.endedAt)) continue;
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, `管理组任命：${reason || '未填写理由'}`);
      terms.push({ userId: member.id, startedAt, appointedBy: moderator.id, appointmentReason: reason || '' });
      records.push({ member });
    }
    if (!records.length) return { message: '所选成员已经全部在任，没有重复添加。', updated: false };
    await saveGuildData();
    const announced = await announceManagementChange(guild, { action, records, moderator, startedAt, reason, tier, roleId: track.roleId });
    return { message: `已任命 ${records.length} 人。${announced ? '公示和当前名单已更新。' : '公示发送失败，请检查频道权限。'}`, updated: true };
  }

  const endedAt = Date.now();
  for (const member of members) {
    const activeTerm = terms.find((term) => term.userId === member.id && !term.endedAt);
    const hadRole = member.roles.cache.has(role.id);
    if (hadRole) await member.roles.remove(role, `管理组卸任：${reason || '未填写理由'}`);
    if (activeTerm) {
      activeTerm.endedAt = endedAt;
      activeTerm.resignedBy = moderator.id;
      activeTerm.resignationReason = reason || '';
      records.push({ member, tenure: formatTenure(endedAt - activeTerm.startedAt) });
    } else if (hadRole) {
      terms.push({ userId: member.id, startedAt: null, endedAt, appointedBy: null,
        appointmentReason: '机器人开始记录前已持有身份组', resignedBy: moderator.id, resignationReason: reason || '' });
      records.push({ member, tenure: '任命时间未记录' });
    }
  }
  if (!records.length) return { message: '所选成员当前都不在管理组名单中。', updated: false };
  await saveGuildData();
  const announced = await announceManagementChange(guild, { action, records, moderator, endedAt, reason, tier, roleId: track.roleId });
  return { message: `已为 ${records.length} 人办理卸任。${announced ? '公示和当前名单已更新。' : '公示发送失败，请检查频道权限。'}`, updated: true };
}

async function reconcileLongTimeouts() {
  const now = Date.now();
  const active = [];
  for (const job of longTimeouts) {
    if (job.endAt <= now) {
      console.log(`Long timeout ended for ${job.userId} in ${job.guildId}.`);
      continue;
    }
    try {
      const guild = await client.guilds.fetch(job.guildId);
      const member = await guild.members.fetch(job.userId);
      if (job.nextRefreshAt <= now) {
        const until = Math.min(job.endAt, now + TIMEOUT_REFRESH);
        await member.timeout(until - now, job.reason || 'Scheduled long timeout refresh');
        job.nextRefreshAt = until >= job.endAt ? job.endAt : until - DAY;
        console.log(`Refreshed long timeout for ${job.userId} until ${new Date(until).toISOString()}.`);
      }
      active.push(job);
    } catch (error) {
      // A departed member or removed bot permission should not prevent other schedules from running.
      console.error(`Could not refresh timeout for ${job.userId} in ${job.guildId}:`, error.message);
      active.push(job);
    }
  }
  longTimeouts = active;
  await saveTimeouts();
}

function hasPermission(interaction, permission) {
  return interaction.memberPermissions?.has(permission) || false;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
let readyWatchdog;
client.on('shardError', (error) => console.error('Discord 网关连接错误:', error.message));
client.on('shardConnecting', () => console.log('正在连接 Discord 实时网关……'));
client.on('shardDisconnect', (event, shardId) => {
  console.error(`Discord 网关已断开（分片 ${shardId}，代码 ${event.code}）：${event.reason || '未提供原因'}`);
});
client.on('error', (error) => console.error('Discord 客户端错误:', error.message));
client.once('clientReady', async () => {
  clearTimeout(readyWatchdog);
  console.log(`Logged in as ${client.user.tag}`);
  await loadTimeouts();
  await loadGuildData();
  await reconcileLongTimeouts();
  for (const guild of client.guilds.cache.values()) {
    const setting = settingsFor(guild.id);
    const tracks = [];
    const seniorTrack = managementTrack(setting, 'senior');
    if (seniorTrack.roleId && seniorTrack.channelId) tracks.push(['senior', null]);
    for (const roleId of Object.keys(setting.middleManagementGroups || {})) {
      const track = managementTrack(setting, 'middle', roleId);
      if (track.roleId && track.channelId) tracks.push(['middle', roleId]);
    }
    if (!tracks.length) continue;
    guild.members.fetch().then((members) => Promise.all(tracks.map(([tier, roleId]) => {
      const track = managementTrack(setting, tier, roleId);
      return syncManagementRole(guild, tier, members, roleId).catch((error) => {
        console.error(`${track.label}成员读取失败（${guild.name}/${roleId || track.roleId}）：${error.message}。请在 Developer Portal 开启 Server Members Intent。`);
      });
    }))).catch((error) => {
      console.error(`管理组成员列表读取失败（${guild.name}）：${error.message}。请在 Developer Portal 开启 Server Members Intent。`);
    });
  }
  setInterval(() => reconcileLongTimeouts().catch((error) => console.error('Timeout scheduler failed:', error)), 60 * 1000);
  await processSchedules().catch((error) => console.error('Schedule startup processing failed:', error.message));
  setInterval(() => processSchedules().catch((error) => console.error('Schedule processing failed:', error.message)), 30 * 1000);
});
client.on('guildMemberUpdate', (oldMember, newMember) => {
  const setting = guildData.settings[newMember.guild.id];
  if (!setting) return;
  const seniorRoleId = managementTrack(setting, 'senior').roleId;
  if (seniorRoleId && oldMember.roles.cache.has(seniorRoleId) !== newMember.roles.cache.has(seniorRoleId)) {
    scheduleManagementMemberSync(newMember, newMember.roles.cache.has(seniorRoleId), 'senior');
  }
  for (const roleId of Object.keys(setting.middleManagementGroups || {})) {
    if (oldMember.roles.cache.has(roleId) !== newMember.roles.cache.has(roleId)) {
      scheduleManagementMemberSync(newMember, newMember.roles.cache.has(roleId), 'middle', roleId);
    }
  }
});
client.on('guildMemberRemove', (member) => {
  const setting = guildData.settings[member.guild.id];
  if (!setting) return;
  const seniorRoleId = managementTrack(setting, 'senior').roleId;
  if (seniorRoleId) scheduleManagementMemberSync(member, false, 'senior');
  for (const roleId of Object.keys(setting.middleManagementGroups || {})) scheduleManagementMemberSync(member, false, 'middle', roleId);
});

client.on('interactionCreate', async (interaction) => {
  console.log(`收到 Discord 交互：${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId || interaction.type}（服务器 ${interaction.guildId || '私聊'}）`);
  if (interaction.isModalSubmit() && interaction.customId.startsWith('mgmt-reason:')) {
    const token = interaction.customId.split(':')[1];
    const pending = pendingManagementActions.get(token);
    if (!pending || pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId
      || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      pendingManagementActions.delete(token);
      await interaction.reply({ content: '这次管理组操作已过期，请重新从管理组面板选择成员。', flags: MessageFlags.Ephemeral });
      return;
    }
    pendingManagementActions.delete(token);
    if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({ content: '你需要“管理身份组”权限才能任命或办理他人卸任。', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const reason = interaction.fields.getTextInputValue('reason').trim();
      const result = await executeManagementAction(interaction.guild, {
        action: pending.action === 'mgmt-appoint' ? '任命' : '卸任',
        memberIds: pending.memberIds, moderator: interaction.user, reason, tier: pending.tier, roleId: pending.roleId,
      });
      await interaction.editReply(result.message);
    } catch (error) {
      console.error('管理组理由提交失败:', error.message);
      await interaction.editReply(`操作未完成：${error.message}`);
    }
    return;
  }
  if (interaction.isButton() && (interaction.customId.startsWith('punishment-confirm:') || interaction.customId.startsWith('punishment-cancel:'))) {
    const [action, token] = interaction.customId.split(':');
    try {
      await interaction.deferUpdate();
    } catch (error) {
      console.warn(`处罚确认交互 ${token} 无法应答，未执行本次操作：${error.code || error.message}`);
      return;
    }
    let pending = await readPendingPunishment(token).catch((error) => { console.error('读取待确认处罚失败:', error); return null; });
    let recoveredFromMessage = false;
    if (!pending) {
      pending = recoverPunishmentFromConfirmationMessage(interaction);
      recoveredFromMessage = Boolean(pending);
      if (pending) console.warn(`待确认处罚 ${token} 的数据文件不存在，已从确认消息恢复；进程 ${process.pid}，目录 ${pendingPunishmentsDir}`);
    }
    if (!pending) {
      pendingPunishments.delete(token);
      console.error(`待确认处罚 ${token} 无法恢复；进程 ${process.pid}，目录 ${pendingPunishmentsDir}`);
      await interaction.editReply({ content: '找不到这张处罚确认卡对应的数据，尚未执行处罚。请重新运行 `/处罚`；若再次出现，请检查是否有多个不同目录中的 Bot 实例。', embeds: [], components: [] });
      return;
    }
    if (pending.moderatorId && pending.moderatorId !== interaction.user.id) {
      await interaction.editReply({ content: '这张处罚确认卡只能由发起命令的人操作。', embeds: [], components: [] });
      return;
    }
    if (pending.guildId !== interaction.guildId) {
      await interaction.editReply({ content: '处罚确认卡与当前服务器不匹配，尚未执行处罚。', embeds: [], components: [] });
      return;
    }
    if (Date.now() - pending.createdAt > PUNISHMENT_CONFIRM_TTL) {
      pendingPunishments.delete(token);
      const file = pendingPunishmentPath(token);
      if (file) await fs.unlink(file).catch(() => {});
      await interaction.editReply({ content: '这次处罚确认已超过 15 分钟，请重新运行 `/处罚`。', embeds: [], components: [] });
      return;
    }
    let claim = recoveredFromMessage ? null : await claimPendingPunishment(token);
    if (recoveredFromMessage) {
      const lock = `${pendingPunishmentPath(token)}.lock`;
      await fs.mkdir(pendingPunishmentsDir, { recursive: true });
      try {
        const handle = await fs.open(lock, 'wx');
        await handle.close();
        claim = { request: pending, claimed: lock };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (!claim) {
      pendingPunishments.delete(token);
      await interaction.editReply({ content: '这次处罚确认已处理，请重新运行 `/处罚`。', embeds: [], components: [] });
      return;
    }
    const claimedRequest = claim.request;
    pendingPunishments.delete(token);
    if (action === 'punishment-cancel') {
      await fs.unlink(claim.claimed).catch(() => {});
      if (claim.lock) await fs.unlink(claim.lock).catch(() => {});
      await interaction.editReply({ content: '已取消处罚，没有执行任何操作。', embeds: [], components: [] });
      return;
    }
    try {
      const summary = await executePunishmentRequest(interaction, claimedRequest);
      await interaction.editReply({ content: summary, embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
      console.error('/处罚 确认执行失败:', error);
      await interaction.editReply({ content: `处罚未能执行：${error.message}`, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
    } finally {
      await fs.unlink(claim.claimed).catch(() => {});
      if (claim.lock) await fs.unlink(claim.lock).catch(() => {});
    }
    return;
  }
  if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isButton()) {
    if ((interaction.customId.startsWith('mgmt-') || interaction.customId.startsWith('midmgmt-')) && interaction.inGuild()) {
      try {
        const [rawAction, guildId] = interaction.customId.split(':');
        const tier = rawAction.startsWith('midmgmt-') ? 'middle' : 'senior';
        const action = rawAction.replace(/^midmgmt-/, 'mgmt-');
        if (guildId !== interaction.guildId) return;
        const sessionKey = `${guildId}:${interaction.message.id}:${interaction.user.id}`;
        for (const [key, session] of pendingManagementPanelSelections) {
          if (Date.now() - session.updatedAt > 30 * 60 * 1000) pendingManagementPanelSelections.delete(key);
        }
        const session = pendingManagementPanelSelections.get(sessionKey) || { updatedAt: Date.now() };
        if (tier === 'middle' && rawAction === 'midmgmt-role' && interaction.isRoleSelectMenu()) {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能配置中层管理子区。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferUpdate();
          const role = await interaction.guild.roles.fetch(interaction.values[0]);
          const botMember = await interaction.guild.members.fetchMe();
          const setting = settingsFor(guildId);
          if (!role || role.id === guildId || role.managed || role.position >= botMember.roles.highest.position) {
            await interaction.followUp({ content: '请选择普通身份组，并把机器人的身份组放在它上方。', flags: MessageFlags.Ephemeral });
            return;
          }
          if (setting.managementRoleId === role.id) {
            await interaction.followUp({ content: '这个身份组已配置为管理组，请为中层管理选择另一个身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          session.roleId = role.id;
          session.updatedAt = Date.now();
          pendingManagementPanelSelections.set(sessionKey, session);
          return;
        }
        if (tier === 'middle' && rawAction === 'midmgmt-parent' && interaction.isChannelSelectMenu()) {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能配置中层管理子区。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferUpdate();
          session.parentChannelId = interaction.values[0];
          session.updatedAt = Date.now();
          pendingManagementPanelSelections.set(sessionKey, session);
          return;
        }
        if (tier === 'middle' && rawAction === 'midmgmt-create' && interaction.isButton()) {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能创建中层管理子区。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const roleId = session.roleId;
          if (!roleId || !session.parentChannelId || Date.now() - session.updatedAt > 30 * 60 * 1000) {
            await interaction.editReply('请先从面板选择一个中层身份组和公示频道，再创建子区。');
            return;
          }
          const setting = settingsFor(guildId);
          const role = await interaction.guild.roles.fetch(roleId);
          const parent = await interaction.guild.channels.fetch(session.parentChannelId);
          const botMember = await interaction.guild.members.fetchMe();
          const perms = parent?.permissionsFor(botMember);
          if (!role || role.managed || role.id === guildId || role.position >= botMember.roles.highest.position) {
            await interaction.editReply('所选身份组无效，或高于机器人的身份组。请重新选择。');
            return;
          }
          if (setting.managementRoleId === role.id) {
            await interaction.editReply('这个身份组已配置为管理组，请为中层管理选择另一个身份组。');
            return;
          }
          if (!parent?.isTextBased() || parent.isThread()
            || !perms?.has(PermissionFlagsBits.ViewChannel)
            || !perms.has(PermissionFlagsBits.SendMessages)
            || !perms.has(PermissionFlagsBits.CreatePublicThreads)
            || !perms.has(PermissionFlagsBits.SendMessagesInThreads)
            || !perms.has(PermissionFlagsBits.ManageThreads)) {
            await interaction.editReply('请选择普通文字或公告频道，并确认 Bot 有“查看频道”“发送消息”“创建公开帖子”“在帖子中发送消息”“管理帖子”权限。');
            return;
          }
          const track = managementTrack(setting, 'middle', roleId);
          const oldChannelId = track.channelId;
          if (track.channelId && track.group.parentChannelId === parent.id) {
            const existingThread = await interaction.guild.channels.fetch(oldChannelId).catch(() => null);
            if (existingThread?.isThread()) {
              const announcementThread = await ensureManagementAnnouncementThread(interaction.guild, 'middle', role.id);
              const updated = await syncManagementRole(interaction.guild, 'middle', null, role.id);
              await interaction.editReply({ content: updated
                ? `身份组 <@&${role.id}> 的实时名单仍位于 <#${oldChannelId}>；任免公示子区为 ${announcementThread}。已重新同步成员并刷新名单。`
                : `实时名单子区为 <#${oldChannelId}>，任免公示子区为 ${announcementThread}；成员同步未完成，请确认 Server Members Intent 已开启。`,
                embeds: [managementPanelEmbed(guildId, 'middle')], components: managementPanelComponents(guildId, 'middle') });
              return;
            }
          }
          const thread = await parent.threads.create({
            name: `${role.name} 公示`.slice(0, 100),
            autoArchiveDuration: 10080,
            reason: `为中层身份组 ${role.name} 创建独立公示子区`,
          });
          if (track.group.legacyRosterMessageId && track.group.parentChannelId) {
            const legacyChannel = await interaction.guild.channels.fetch(track.group.parentChannelId).catch(() => null);
            const legacyRoster = legacyChannel?.isTextBased()
              ? await legacyChannel.messages.fetch(track.group.legacyRosterMessageId).catch(() => null)
              : null;
            if (legacyRoster) await legacyRoster.delete().catch(() => {});
            track.group.legacyRosterMessageId = null;
          }
          if (oldChannelId && track.rosterMessageIds.length) {
            await deleteManagementRosterMessages(interaction.guild, setting, track, oldChannelId);
          }
          track.group.roleId = role.id;
          track.group.parentChannelId = parent.id;
          setManagementTrackRosterMessage(setting, track, []);
          setManagementTrackChannel(setting, track, thread.id);
          await saveGuildData();
          const announcementThread = await ensureManagementAnnouncementThread(interaction.guild, 'middle', role.id);
          const updated = await syncManagementRole(interaction.guild, 'middle', null, role.id);
          await interaction.editReply({ content: updated
            ? `已为 <@&${role.id}> 创建实时名单子区 ${thread} 和任免公示子区 ${announcementThread}，现有成员已开始同步。`
            : `已创建实时名单子区 ${thread} 和任免公示子区 ${announcementThread}，但成员同步未完成；请检查 Server Members Intent 后重试。`,
            embeds: [managementPanelEmbed(guildId, 'middle')], components: managementPanelComponents(guildId, 'middle') });
          return;
        }
        if (action === 'mgmt-announcement' && interaction.isButton()) {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能创建任免公示子区。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const roleId = tier === 'middle' ? session.roleId : null;
          const setting = settingsFor(guildId);
          const track = managementTrack(setting, tier, roleId);
          if (!track.roleId || !track.channelId) {
            await interaction.editReply('请先配置管理身份组和实时名单位置。');
            return;
          }
          const thread = await ensureManagementAnnouncementThread(interaction.guild, tier, track.roleId);
          await interaction.editReply({ content: `已创建任免公示子区 ${thread}。实时名单位置未改变。`,
            embeds: [managementPanelEmbed(guildId, tier)], components: managementPanelComponents(guildId, tier) });
          return;
        }
        const requiredPermission = action === 'mgmt-appoint' || action === 'mgmt-resign'
          ? PermissionFlagsBits.ManageRoles : PermissionFlagsBits.ManageGuild;
        if (!hasPermission(interaction, requiredPermission)) {
          await interaction.reply({ content: '你没有权限执行此管理组面板操作。', flags: MessageFlags.Ephemeral });
          return;
        }
        if ((action === 'mgmt-appoint' || action === 'mgmt-resign') && interaction.isUserSelectMenu()) {
          const setting = settingsFor(guildId);
          const roleId = tier === 'middle' ? session.roleId : null;
          const track = managementTrack(setting, tier, roleId);
          if (!track.channelId || !track.roleId) {
            await interaction.reply({ content: tier === 'middle' ? '请先选择已配置公示子区的中层身份组。' : '请先在面板设置管理组公示频道和身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          const now = Date.now();
          for (const [key, pending] of pendingManagementActions) {
            if (now - pending.createdAt > 10 * 60 * 1000) pendingManagementActions.delete(key);
          }
          const token = randomBytes(6).toString('hex');
          pendingManagementActions.set(token, { guildId, userId: interaction.user.id, action, tier, roleId: track.roleId, memberIds: interaction.values, createdAt: now });
          const modal = new ModalBuilder().setCustomId(`mgmt-reason:${token}`)
            .setTitle(`${action === 'mgmt-appoint' ? '填写任命理由' : '填写卸任理由'}`)
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
              .setCustomId('reason').setLabel('理由（可选）').setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('可简要说明任命或卸任的原因').setMaxLength(400).setRequired(false)));
          await interaction.showModal(modal);
          return;
        }
        if (action !== 'mgmt-refresh') await interaction.deferUpdate();
        if (action === 'mgmt-channel' && interaction.isChannelSelectMenu()) {
          const setting = settingsFor(guildId);
          const track = managementTrack(setting, tier);
          const channel = await interaction.guild.channels.fetch(interaction.values[0]);
          const botPermissions = channel.permissionsFor(interaction.guild.members.me);
          if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.SendMessages)) {
            await interaction.followUp({ content: '机器人在这个公示频道缺少查看频道或发送消息权限。', flags: MessageFlags.Ephemeral });
            return;
          }
          if (track.channelId && track.channelId !== channel.id && track.rosterMessageIds.length) {
            await deleteManagementRosterMessages(interaction.guild, setting, track);
          }
          setManagementTrackChannel(setting, track, channel.id);
          await saveGuildData();
          if (track.roleId) await syncManagementRole(interaction.guild, tier, null, track.roleId);
          else await updateManagementRoster(interaction.guild, tier);
          const panelUpdated = await editManagementPanelSource(interaction, guildId, tier);
          if (!panelUpdated) await interaction.followUp({ content: '设置已保存，但原面板消息已不存在。请重新运行对应的管理面板指令。', flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'mgmt-role' && interaction.isRoleSelectMenu() && tier === 'senior') {
          const setting = settingsFor(guildId);
          const track = managementTrack(setting, tier);
          const role = await interaction.guild.roles.fetch(interaction.values[0]);
          const botMember = await interaction.guild.members.fetchMe();
          if (!role || role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position) {
            await interaction.followUp({ content: '请选择普通身份组，并把机器人的身份组放在它上方。', flags: MessageFlags.Ephemeral });
            return;
          }
          const middleRoleIds = Object.keys(setting.middleManagementGroups || {});
          if ((tier === 'senior' && middleRoleIds.includes(role.id)) || (tier === 'middle' && setting.managementRoleId === role.id)) {
            const otherLabel = tier === 'middle' ? '管理组' : '中层管理';
            await interaction.followUp({ content: `${track.label}身份组必须与${otherLabel}身份组不同，请选择另一个身份组。`, flags: MessageFlags.Ephemeral });
            return;
          }
          if (track.roleId === role.id) {
            const panelUpdated = await editManagementPanelSource(interaction, guildId, tier);
            if (!panelUpdated) await interaction.followUp({ content: '设置未变更，但原面板消息已不存在。请重新运行对应的管理面板指令。', flags: MessageFlags.Ephemeral });
            return;
          }
          if (track.roleId && track.roleId !== role.id
            && track.terms.some((term) => !term.endedAt)) {
            await interaction.followUp({ content: `当前仍有在任${track.label}成员，不能直接更换身份组。请先办理所有成员卸任，再更换身份组。`, flags: MessageFlags.Ephemeral });
            return;
          }
          setManagementTrackRole(setting, track, role.id);
          await saveGuildData();
          if (track.channelId) await syncManagementRole(interaction.guild, tier);
          const panelUpdated = await editManagementPanelSource(interaction, guildId, tier);
          if (!panelUpdated) await interaction.followUp({ content: '设置已保存，但原面板消息已不存在。请重新运行对应的管理面板指令。', flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'mgmt-refresh' && interaction.isButton()) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const updated = await syncManagementRole(interaction.guild, tier);
          await interaction.editReply(updated ? '已重新读取管理组身份组成员并刷新公示名单。' : '尚未设置可用的公示频道或管理组身份组，请先完成配置。');
          return;
        }
      } catch (error) {
        console.error('管理组面板操作失败:', error);
        if (interaction.deferred) {
          await interaction.editReply('管理组面板操作失败。请确认 Bot 权限和子区状态；具体错误已输出到控制台。').catch(() => {});
        } else if (!interaction.replied) {
          await interaction.reply({ content: '操作失败。请检查 Bot 权限、身份组层级和面板配置。', flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
          await interaction.followUp({ content: '操作未能完成。请检查 Bot 权限和身份组层级。', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
      return;
    }
    if (!interaction.customId.startsWith('punish-') || !interaction.inGuild()) return;
    try {
    const [action, guildId] = interaction.customId.split(':');
    if (guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有本服务器管理员可以配置处罚面板。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await interaction.deferUpdate();
    const setting = settingsFor(guildId);
    if (action === 'punish-log' && interaction.isChannelSelectMenu()) {
      const channel = await interaction.guild.channels.fetch(interaction.values[0]);
      const permissions = channel.permissionsFor(interaction.guild.members.me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
        await interaction.followUp({ content: '机器人在这个频道缺少查看频道或发送消息权限。', flags: MessageFlags.Ephemeral });
        return;
      }
      setting.logChannelId = interaction.values[0];
    } else if (action === 'punish-audit' && interaction.isChannelSelectMenu()) {
      const channel = await interaction.guild.channels.fetch(interaction.values[0]);
      const permissions = channel.permissionsFor(interaction.guild.members.me);
      if (channel.guildId !== interaction.guildId || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
        await interaction.followUp({ content: '留痕频道必须属于本服务器，并且机器人需要查看频道和发送消息权限。', flags: MessageFlags.Ephemeral });
        return;
      }
      setting.auditChannelId = channel.id;
    } else if (action === 'punish-role' && interaction.isRoleSelectMenu()) {
      const role = await interaction.guild.roles.fetch(interaction.values[0]);
      const botMember = await interaction.guild.members.fetchMe();
      if (!role || role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position) {
        await interaction.followUp({ content: '请选择普通身份组，并把机器人的身份组放在它上方。', flags: MessageFlags.Ephemeral });
        return;
      }
      setting.warningRoleId = role.id;
    }
    else if (action === 'punish-toggle' && interaction.isButton()) setting.secondWarningReminder = !setting.secondWarningReminder;
    else if (action === 'punish-audit-clear' && interaction.isButton()) setting.auditChannelId = null;
    else return;
    await saveGuildData();
    await interaction.message.edit({ embeds: [punishmentPanelEmbed(guildId)], components: punishmentPanel(guildId) });
    } catch (error) {
      console.error('处罚面板交互失败:', error.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '设置没有保存，请检查频道和 Bot 权限后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.followUp({ content: '设置没有保存，请检查频道和 Bot 权限后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    // Each command interaction is acknowledged immediately. discord.js invokes
    // this async listener independently for every interaction, so slow API work
    // below does not put other commands into a shared queue.
    if (interaction.commandName !== '处罚面板') {
      await interaction.deferReply(interaction.commandName === '提问' ? {} : { flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === '提问') {
      const prompt = interaction.options.getString('问题', true);
      const historyKey = `${interaction.guildId || 'dm'}:${interaction.channelId}:${interaction.user.id}`;
      const history = histories.get(historyKey) || [];
      const answer = await askApi([
        { role: 'system', content: process.env.SYSTEM_PROMPT || 'You are a helpful assistant.' },
        ...history,
        { role: 'user', content: prompt },
      ]);
      if (historyLimit > 0) histories.set(historyKey, [...history, { role: 'user', content: prompt }, { role: 'assistant', content: answer }].slice(-historyLimit));
      const chunks = splitMessage(answer);
      await interaction.editReply({ content: chunks.shift() || '（API 没有返回文字。）', allowedMentions: { parse: [] } });
      for (const chunk of chunks) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.editReply({ content: '此指令只能在服务器内使用。', allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.commandName === '处罚面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '需要“管理服务器”权限才能配置处罚面板。', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: '处罚面板已创建。请使用下方菜单配置处罚记录频道、可选留痕频道、警告身份组和二次提醒。', embeds: [punishmentPanelEmbed(interaction.guildId)], components: punishmentPanel(interaction.guildId) });
      return;
    }

    if (interaction.commandName === '管理组面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置管理组面板。');
        return;
      }
      await updateManagementRoster(interaction.guild);
      await interaction.editReply({ embeds: [managementPanelEmbed(interaction.guildId)], components: managementPanelComponents(interaction.guildId) });
      return;
    }

    if (interaction.commandName === '中层管理面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置中层管理面板。');
        return;
      }
      await interaction.editReply({ embeds: [managementPanelEmbed(interaction.guildId, 'middle')], components: managementPanelComponents(interaction.guildId, 'middle') });
      return;
    }

    if (interaction.commandName === '管理组名单' || interaction.commandName === '中层管理名单') {
      const tier = interaction.commandName === '中层管理名单' ? 'middle' : 'senior';
      const roleId = tier === 'middle' ? interaction.options.getRole('身份组', true).id : null;
      const setting = settingsFor(interaction.guildId);
      const track = managementTrack(setting, tier, roleId);
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能查看完整管理组名单。');
        return;
      }
      if (!track.roleId || (tier === 'middle' && !track.channelId)) { await interaction.editReply('这个中层身份组还没有配置公示子区。请先使用 `/中层管理面板` 配置。'); return; }
      const activeTerms = track.terms.filter((term) => !term.endedAt && !term.isBot);
      const roster = activeTerms.length
        ? activeTerms.map((term) => `<@${term.userId}> — 任命于 <t:${Math.floor(term.startedAt / 1000)}:F>`).join('\n')
        : '目前没有在任成员。';
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x2ECC71).setTitle(`当前${track.label}名单`)
        .setDescription(`身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n\n${roster}`)
        .setFooter({ text: `在任 ${activeTerms.length} 人` })] });
      return;
    }

    if (interaction.commandName === '管理组卸任' || interaction.commandName === '中层管理卸任') {
      const tier = interaction.commandName === '中层管理卸任' ? 'middle' : 'senior';
      const roleId = tier === 'middle' ? interaction.options.getRole('身份组', true).id : null;
      const setting = settingsFor(interaction.guildId);
      const track = managementTrack(setting, tier, roleId);
      if (!track.roleId || !track.channelId) {
        await interaction.editReply(`${track.label}面板尚未配置身份组或公示频道，请联系服务器管理员。`);
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const role = await interaction.guild.roles.fetch(track.roleId);
      const botMember = await interaction.guild.members.fetchMe();
      if (!role || !member.roles.cache.has(role.id)) {
        await interaction.editReply(`你当前没有${track.label}身份，无法卸任。`);
        return;
      }
      if (role.position >= botMember.roles.highest.position) {
        await interaction.editReply('机器人身份组必须高于管理组身份组，才能办理卸任。');
        return;
      }
      const endedAt = Date.now();
      const activeTerm = track.terms.find((term) => term.userId === member.id && !term.endedAt);
      const reason = interaction.options.getString('理由')?.trim() || '';
      await member.roles.remove(role, `管理组成员自行卸任`);
      if (activeTerm) {
        activeTerm.endedAt = endedAt;
        activeTerm.resignedBy = interaction.user.id;
        activeTerm.resignationReason = reason;
      } else {
        track.terms.push({ userId: member.id, startedAt: null, endedAt, appointedBy: null,
          appointmentReason: '机器人开始记录前已持有身份组', resignedBy: interaction.user.id, resignationReason: reason });
      }
      await saveGuildData();
      const record = { member: interaction.user, tenure: activeTerm ? formatTenure(endedAt - activeTerm.startedAt) : '任命时间未记录' };
      const announced = await announceManagementChange(interaction.guild, { action: '卸任', records: [record], moderator: interaction.user, endedAt, reason, tier, roleId: track.roleId });
      await interaction.editReply(announced ? '已为你办理卸任，并更新公示记录和当前名单。' : '已移除你的管理组身份，但公示频道发送失败，请联系管理员检查频道权限。');
      return;
    }

    if (interaction.commandName === '定时提醒') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能管理定时提醒。');
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === '添加') {
        const channel = interaction.options.getChannel('频道', true);
        const minutes = interaction.options.getInteger('分钟后', true);
        const repeat = interaction.options.getInteger('重复间隔分钟', true);
        const user = interaction.options.getUser('提及成员');
        const role = interaction.options.getRole('提及身份组');
        if (user && role) { await interaction.editReply('一次提醒只能选择提及某个人或某个身份组，请重新添加。'); return; }
        if (repeat > 0 && repeat < 10) { await interaction.editReply('重复间隔至少需要 10 分钟，或填写 0 表示只提醒一次。'); return; }
        const botPerms = channel.permissionsFor(interaction.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms.has(PermissionFlagsBits.SendMessages)) {
          await interaction.editReply('机器人在所选频道缺少查看频道或发送消息权限。'); return;
        }
        if (role && !role.mentionable && !botPerms.has(PermissionFlagsBits.MentionEveryone)) {
          await interaction.editReply('要提醒这个身份组，请将其设为可被提及，或给机器人“提及 @everyone、@here 和所有身份组”权限。'); return;
        }
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        guildData.reminders.push({ id, guildId: interaction.guildId, channelId: channel.id, userId: user?.id || null,
          roleId: role?.id || null, content: interaction.options.getString('内容', true), nextAt: Date.now() + minutes * 60_000, intervalMs: repeat * 60_000 });
        await saveGuildData();
        await interaction.editReply(`已创建提醒，编号：\`${id}\`。首次提醒将在 ${minutes} 分钟后发送${repeat ? `，之后每 ${repeat} 分钟重复` : '，且只发送一次'}。`);
      } else if (subcommand === '列表') {
        const entries = guildData.reminders.filter((item) => item.guildId === interaction.guildId);
        await interaction.editReply(entries.length ? entries.map((item) => `编号：\`${item.id}\` · <#${item.channelId}> · <t:${Math.floor(item.nextAt / 1000)}:R> · ${item.intervalMs ? `每 ${item.intervalMs / 60000} 分钟` : '一次'} · ${item.userId ? `<@${item.userId}>` : item.roleId ? `<@&${item.roleId}>` : '无提及'} · ${item.content}`).join('\n') : '当前没有定时提醒。');
      } else {
        const id = interaction.options.getString('编号', true);
        const before = guildData.reminders.length;
        guildData.reminders = guildData.reminders.filter((item) => !(item.guildId === interaction.guildId && item.id === id));
        await saveGuildData();
        await interaction.editReply(before === guildData.reminders.length ? '没有找到这个编号。' : `已删除提醒 \`${id}\`。`);
      }
      return;
    }

    if (interaction.commandName === '处罚') {
      const mode = interaction.options.getString('方式', true);
      const hasWarning = mode !== 'timeout';
      const hasTimeout = mode !== 'warning';
      const user = interaction.options.getUser('成员', true);
      const reason = interaction.options.getString('原因', true);
      const timeoutDays = interaction.options.getInteger('禁言天数');
      const warningDays = interaction.options.getInteger('警告天数');
      if (hasTimeout && !timeoutDays) { await interaction.editReply('此处罚方式需要填写“禁言天数”。'); return; }
      if (!hasTimeout && timeoutDays) { await interaction.editReply('“仅警告”不能填写禁言天数，请更改处罚方式。'); return; }
      if (!hasWarning && warningDays) { await interaction.editReply('“仅禁言”不能填写警告天数，请更改处罚方式。'); return; }
      const request = { guildId: interaction.guildId, userId: user.id, mode, reason, timeoutDays, warningDays };
      try {
        const context = await validatePunishmentRequest(interaction, request);
        const token = randomBytes(8).toString('hex');
        const createdAt = Date.now();
        const pendingRequest = { ...request, userId: context.user.id, guildId: context.guild.id, moderatorId: interaction.user.id, createdAt };
        await savePendingPunishment(token, pendingRequest);
        console.log(`处罚确认已保存：${token}（进程 ${process.pid}，${pendingPunishmentsDir}）`);
        pendingPunishments.set(token, pendingRequest);
        const modeLabel = mode === 'both' ? '警告并禁言' : mode === 'timeout' ? '仅禁言' : '仅警告';
        const previousCase = context.previousCase;
        const warningExpiration = guildData.warningExpirations.find((item) => item.guildId === context.guild.id
          && item.userId === context.user.id && item.roleId === context.warningRole?.id && item.expiresAt > createdAt);
        const caseWarningEndAt = previousCase?.hasWarning && previousCase.warningDays && previousCase.createdAt
          ? previousCase.createdAt + previousCase.warningDays * DAY : 0;
        const warningEndAt = warningExpiration?.expiresAt || (caseWarningEndAt > createdAt ? caseWarningEndAt : 0);
        const warningRoleHeld = Boolean(context.warningRole && context.member.roles.cache.has(context.warningRole.id));
        const warningActive = Boolean(warningExpiration)
          || Boolean(previousCase?.hasWarning && (!previousCase.warningDays || caseWarningEndAt > createdAt))
          || (warningRoleHeld && !previousCase?.hasWarning);
        const timeoutUntil = context.member.communicationDisabledUntilTimestamp || 0;
        const timeoutSchedule = longTimeouts.find((item) => item.guildId === context.guild.id
          && item.userId === context.user.id && (!previousCase || item.caseId === previousCase.id));
        const caseTimeoutEndAt = previousCase?.hasTimeout && previousCase.timeoutDays && previousCase.createdAt
          ? previousCase.createdAt + previousCase.timeoutDays * DAY : 0;
        const punishmentEndAt = timeoutSchedule?.endAt || caseTimeoutEndAt;
        const remaining = (timestamp) => {
          const minutes = Math.max(0, Math.ceil((timestamp - createdAt) / 60_000));
          if (minutes < 60) return `${minutes} 分钟`;
          const hours = Math.ceil(minutes / 60);
          if (hours < 48) return `${hours} 小时`;
          return `${Math.ceil(hours / 24)} 天`;
        };
        const confirmationLines = [
          '请核对处罚内容，确认后才会执行：',
          `目标成员：<@${user.id}>`,
          `处罚方式：${modeLabel}`,
          ...(hasWarning ? [`警告身份组：${context.warningRole}` , `警告时长：${warningDays ? `${warningDays} 天` : '不自动移除'}`] : []),
          ...(hasTimeout ? [`禁言时长：${timeoutDays} 天`] : []),
          `目标当前是否在警告期：${warningActive ? '是' : '否'}`,
          `当前警告剩余时长：${warningActive ? (warningEndAt > createdAt ? remaining(warningEndAt) : '无自动到期记录') : '—'}`,
          `当前处罚剩余时长：${punishmentEndAt > createdAt ? remaining(punishmentEndAt) : (timeoutUntil > createdAt ? remaining(timeoutUntil) : '当前无生效处罚期限')}`,
          `Discord 当前禁言剩余时长：${timeoutUntil > createdAt ? remaining(timeoutUntil) : '当前未禁言'}`,
          `原因：${reason}`,
          ...(previousCase ? [`注意：确认后会覆盖当前生效处罚 \`${previousCase.id}\`。`] : []),
          '',
          '此确认仅限你本人操作，15 分钟后失效。',
        ];
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`punishment-confirm:${token}`).setLabel('确认执行').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`punishment-cancel:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ content: confirmationLines.join('\n'), components: [row], allowedMentions: { parse: [] } });
      } catch (error) {
        await interaction.editReply(error.message);
      }
      return;
    }

    if (interaction.commandName === '撤销处罚') {
      const caseId = interaction.options.getString('处罚编号', true).trim();
      const record = guildData.punishmentCases.find((item) => item.guildId === interaction.guildId && item.id === caseId);
      if (!record) {
        await interaction.editReply('没有找到这个服务器中对应的处罚 ID。旧版本产生的处罚记录无法按 ID 撤销，请先用新版重新处罚。');
        return;
      }
      if (record.status !== 'active') {
        const statusText = record.status === 'superseded' ? `这笔处罚已被新处罚 ${record.supersededBy || ''} 覆盖。` : record.status === 'revoked' ? '这笔处罚已经撤销。' : '这笔处罚当前不在生效状态。';
        await interaction.editReply(statusText);
        return;
      }
      const needsRoles = record.hasWarning && !hasPermission(interaction, PermissionFlagsBits.ManageRoles);
      const needsModeration = record.hasTimeout && !hasPermission(interaction, PermissionFlagsBits.ModerateMembers);
      if (needsRoles || needsModeration) {
        await interaction.editReply(`撤销此处罚需要${needsRoles ? '“管理身份组”' : ''}${needsRoles && needsModeration ? '和' : ''}${needsModeration ? '“管理成员”' : ''}权限。`);
        return;
      }
      const guild = interaction.guild;
      const [member, botMember] = await Promise.all([guild.members.fetch(record.userId), guild.members.fetchMe()]);
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        const caller = await guild.members.fetch(interaction.user.id);
        if (member.roles.highest.position >= caller.roles.highest.position) {
          await interaction.editReply('只能撤销身份组层级低于自己的成员处罚。');
          return;
        }
      }
      if (member.roles.highest.position >= botMember.roles.highest.position) {
        await interaction.editReply('机器人身份组必须高于被处罚成员的最高身份组，才能撤销此处罚。');
        return;
      }
      if (record.hasWarning && record.warningRoleId) {
        const role = await guild.roles.fetch(record.warningRoleId).catch(() => null);
        if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, `撤销处罚 ${record.id}（由 ${interaction.user.tag} 操作）`);
      }
      if (record.hasTimeout) await member.timeout(null, `撤销处罚 ${record.id}（由 ${interaction.user.tag} 操作）`);
      record.status = 'revoked';
      record.revokedAt = Date.now();
      record.revokedBy = interaction.user.id;
      guildData.warningExpirations = guildData.warningExpirations.filter((item) => item.caseId !== record.id);
      guildData.warningFollowups = guildData.warningFollowups.filter((item) => item.caseId !== record.id);
      longTimeouts = longTimeouts.filter((item) => item.caseId !== record.id);
      await Promise.all([saveGuildData(), saveTimeouts()]);
      const logged = await postPunishmentRevocation(guild, record, interaction.user);
      await interaction.editReply(`已按处罚 ID \`${record.id}\` 撤销${record.hasWarning && record.hasTimeout ? '警告和禁言' : record.hasWarning ? '警告' : '禁言'}。${!logged.primarySent ? '撤销已执行，但写入处罚记录频道失败。' : ''}${!logged.auditSent ? '留痕频道写入失败，请检查频道和 Bot 权限。' : ''}`);
      return;
    }

    if (interaction.commandName === '说话') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageMessages)) {
        await interaction.editReply('你需要“管理消息”权限才能使用此指令。');
        return;
      }
      const target = interaction.channel;
      if (!target?.isTextBased() || !target.guildId || target.guildId !== interaction.guildId) {
        await interaction.editReply('请在本服务器的文字频道或子区中使用此指令。');
        return;
      }
      if (target.type === ChannelType.GuildForum) {
        await interaction.editReply('请先打开要发言的论坛帖子，再在该帖子内使用 `/说话`。');
        return;
      }
      const botMember = await interaction.guild.members.fetchMe();
      const botPermissions = target.permissionsFor(botMember);
      const sendPermission = target.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(sendPermission)) {
        await interaction.editReply(`机器人在当前${target.isThread() ? '子区' : '频道'}缺少“查看频道”或“${target.isThread() ? '在子区内发送消息' : '发送消息'}”权限。论坛帖子还需要机器人有权访问该帖子，且帖子未被锁定。`);
        return;
      }
      const replyLink = interaction.options.getString('回复消息链接');
      let replyOptions = {};
      if (replyLink) {
        let parsed;
        try { parsed = new URL(replyLink); } catch {
          await interaction.editReply('回复消息链接格式不正确，请复制 Discord 的“复制消息链接”。');
          return;
        }
        const allowedHosts = new Set(['discord.com', 'www.discord.com', 'discordapp.com', 'www.discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
        const match = parsed.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
        if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) || !match) {
          await interaction.editReply('回复链接必须是 Discord 消息链接。');
          return;
        }
        const [, guildId, channelId, messageId] = match;
        if (guildId !== interaction.guildId || channelId !== target.id) {
          await interaction.editReply('只能回复当前频道或子区里的消息。');
          return;
        }
        const sourceMessage = await target.messages.fetch(messageId).catch(() => null);
        if (!sourceMessage) {
          await interaction.editReply('当前频道或子区里找不到这条消息，请确认链接有效且机器人能查看该消息。');
          return;
        }
        replyOptions = { reply: { messageReference: sourceMessage.id, failIfNotExists: false } };
      }
      await target.send({ content: interaction.options.getString('内容', true), ...replyOptions,
        allowedMentions: { parse: [], repliedUser: false } });
      await interaction.editReply(replyLink ? '已由机器人在当前频道/子区回复该消息。' : '已由机器人在当前频道/子区发言。');
      return;
    }

    if (interaction.commandName === '编辑说话') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageMessages)) {
        await interaction.editReply('你需要“管理消息”权限才能使用此指令。');
        return;
      }
      const everyonePermissions = interaction.channel?.permissionsFor(interaction.guild.roles.everyone);
      if (!everyonePermissions || everyonePermissions.has(PermissionFlagsBits.ViewChannel)) {
        await interaction.editReply('为了不在公开频道显示使用者，请在仅管理人员可见的私密频道中使用此指令。');
        return;
      }
      const link = interaction.options.getString('消息链接', true);
      let parsed;
      try { parsed = new URL(link); } catch {
        await interaction.editReply('消息链接格式不正确，请复制 Discord 的“复制消息链接”。');
        return;
      }
      const allowedHosts = new Set(['discord.com', 'www.discord.com', 'discordapp.com', 'www.discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
      const match = parsed.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
      if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) || !match) {
        await interaction.editReply('链接必须是 Discord 消息链接，格式类似 https://discord.com/channels/服务器ID/频道ID/消息ID。');
        return;
      }
      const [, guildId, channelId, messageId] = match;
      if (guildId !== interaction.guildId) {
        await interaction.editReply('只能编辑当前服务器中的消息。');
        return;
      }
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || channel.guildId !== interaction.guildId || !channel.messages) {
        await interaction.editReply('找不到这个服务器中的文字频道或子区。');
        return;
      }
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) {
        await interaction.editReply('找不到这条消息，或机器人无法查看该频道的消息记录。');
        return;
      }
      if (message.author.id !== client.user.id) {
        await interaction.editReply('出于安全限制，只能编辑此机器人的消息。');
        return;
      }
      await message.edit({ content: interaction.options.getString('新内容', true), allowedMentions: { parse: [] } });
      await interaction.editReply('已更新机器人消息。');
      return;
    }

    if (interaction.commandName === '配置身份组') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) {
        await interaction.editReply('你需要“管理身份组”权限才能使用此指令。');
        return;
      }
      const action = interaction.options.getSubcommand();
      const user = interaction.options.getUser('成员', true);
      const role = interaction.options.getRole('身份组', true);
      const guild = interaction.guild;
      const [member, botMember] = await Promise.all([guild.members.fetch(user.id), guild.members.fetchMe()]);
      if (role.id === guild.id || role.managed || role.position >= botMember.roles.highest.position) {
        await interaction.editReply('这个身份组不可由机器人管理。请把机器人的身份组拖到目标身份组上方，并选择普通身份组。');
        return;
      }
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        const caller = await guild.members.fetch(interaction.user.id);
        if (role.position >= caller.roles.highest.position) {
          await interaction.editReply('你只能管理层级低于自己最高身份组的身份组。');
          return;
        }
      }
      if (action === '添加') await member.roles.add(role, `Requested by ${interaction.user.tag}`);
      else await member.roles.remove(role, `Requested by ${interaction.user.tag}`);
      await interaction.editReply(`已为 <@${user.id}>${action === '添加' ? '添加' : '移除'}身份组“${role.name}”。`);
      return;
    }

  } catch (error) {
    console.error(`/${interaction.commandName} 执行失败:`, error.message, `错误代码=${error.code ?? '无'}`);
    if (error.code === 10062) {
      console.error('这次交互可能已超时，或已被另一个 Bot 进程确认。请确保相同 Token 只运行一个 Bot 实例。');
      return;
    }
    const message = '操作失败。请检查机器人权限、身份组层级和控制台错误信息。';
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function main() {
  await registerCommands();
  console.log('指令注册成功，正在登录 Discord……');
  readyWatchdog = setTimeout(() => {
    if (!client.isReady()) {
      console.error('连接超过 20 秒仍未完成。请确认 .env 中已填入重置后的有效 DISCORD_TOKEN；若 Token 正确，请检查网络/防火墙是否允许 Node.js 通过 HTTPS 443 连接 Discord 实时网关。');
    }
  }, 20_000);
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  console.error('Bot startup failed:', error);
  process.exit(1);
});
