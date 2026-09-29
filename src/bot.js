require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
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
  ContextMenuCommandBuilder, ApplicationCommandType,
  PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, LabelBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Partials,
} = require('discord.js');

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

function logFailure(label, error) {
  const code = error?.code ?? error?.rawError?.code;
  console.error(code ? `${label} (error code ${code})${error?.rawError?.message ? `: ${error.rawError.message}` : ''}` : `${label}${error?.message ? `: ${error.message}` : ''}`);
  if (code === 50035) console.error(JSON.stringify(error?.rawError?.errors || error?.errors || {}, null, 2));
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT = 28 * DAY;
const TIMEOUT_REFRESH = 27 * DAY;
const pendingManagementActions = new Map();
const pendingManagementPanelSelections = new Map();
const pendingManagementLockForms = new Map();
const pendingPunishments = new Map();
const pendingPunishmentRecords = {};
const processedPunishmentTokens = {};
const claimedPunishments = new Set();
const activePunishmentLocks = new Set();
const pendingPunishmentTargetClaims = new Set();
const managementSyncTimers = new Map();
let scheduleProcessing = false;
const activeReactionCleanups = new Set();
const activeModerationTargetClaims = new Set();
const activeManagementDeleteVotes = new Set();
const activeManagementDeleteExecutions = new Set();
const timeoutFile = path.join(__dirname, '..', 'data', 'long-timeouts.json');
const guildDataFile = path.join(__dirname, '..', 'data', 'guild-settings.json');
const pendingPunishmentsDir = path.join(__dirname, '..', 'data', 'pending-punishments');
const PUNISHMENT_CONFIRM_TTL = 60 * 1000;
const MODERATION_PROPOSAL_TTL = 24 * 60 * 60 * 1000;
const ENCRYPTED_JSON_FORMAT = 'discord-api-bot-encrypted-json';
const STORAGE_MARKER = 'discord-api-bot-state-v1';
const STORAGE_FILE_NAME = 'discord-api-bot-state.json';
const storageChannelId = process.env.DISCORD_STORAGE_CHANNEL_ID || '';
const legacyStorageChannelId = process.env.DISCORD_LEGACY_STORAGE_CHANNEL_ID || '';
function parseGuildIds(value) {
  return [...new Set((value || '').split(',').map((id) => id.trim()).filter(Boolean))];
}
function commandGuildIds() {
  return parseGuildIds(process.env.DISCORD_GUILD_IDS || process.env.DISCORD_GUILD_ID || '');
}
function punishmentGuildIds() {
  const configured = parseGuildIds(process.env.DISCORD_PUNISHMENT_GUILD_IDS || '');
  if (configured.length) return configured;
  const legacyIds = commandGuildIds();
  return legacyIds.length === 2 ? legacyIds : [];
}

function encryptionKey() {
  const encoded = process.env.DATA_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded.trim()) {
    throw new Error('DATA_ENCRYPTION_KEY must be a Base64-encoded 32-byte key to encrypt Discord state storage.');
  }
  return key;
}
let longTimeouts = [];
let guildData = { settings: {}, reminders: [], warningFollowups: [], warningExpirations: [], punishmentCases: [] };
let storageChannel = null;
let storageMessage = null;
let storageWritePromise = null;
let storageWriteRequested = false;
let storageReady = false;

function decryptJson(envelope) {
  if (envelope?.format !== ENCRYPTED_JSON_FORMAT) return { value: envelope, encrypted: false };
  const key = encryptionKey();
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted data format.');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Encrypted data file is invalid or incomplete.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return { value: JSON.parse(plaintext), encrypted: true };
}

function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: ENCRYPTED_JSON_FORMAT,
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

async function readLegacyJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return decryptJson(JSON.parse(raw)).value;
}

async function savePendingPunishment(token, request) {
  if (!/^[a-f0-9]{16}$/.test(token || '')) throw new Error('无效的处罚确认编号。');
  pendingPunishmentRecords[token] = request;
  try { await savePlatformStorage(); }
  catch (error) { delete pendingPunishmentRecords[token]; throw error; }
}

async function readPendingPunishment(token) {
  return /^[a-f0-9]{16}$/.test(token || '') ? pendingPunishmentRecords[token] || null : null;
}

async function claimPendingPunishment(token, recoveredRequest = null) {
  if (!/^[a-f0-9]{16}$/.test(token || '') || claimedPunishments.has(token)) return null;
  const request = pendingPunishmentRecords[token] || recoveredRequest;
  if (!request) return null;
  const now = Date.now();
  for (const [processedToken, expiresAt] of Object.entries(processedPunishmentTokens)) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) delete processedPunishmentTokens[processedToken];
  }
  if (processedPunishmentTokens[token]) return null;
  if (activePunishmentLocks.has(request.userId)) return null;
  claimedPunishments.add(token);
  activePunishmentLocks.add(request.userId);
  const savedRequest = pendingPunishmentRecords[token];
  processedPunishmentTokens[token] = now + 7 * DAY;
  delete pendingPunishmentRecords[token];
  try { await savePlatformStorage(); }
  catch (error) {
    if (savedRequest) pendingPunishmentRecords[token] = savedRequest;
    delete processedPunishmentTokens[token];
    claimedPunishments.delete(token);
    activePunishmentLocks.delete(request.userId);
    throw error;
  }
  return { request };
}

function recoverPunishmentFromConfirmationMessage(interaction) {
  const content = interaction.message?.content || '';
  const targetId = content.match(/^目标成员：<@!?([0-9]+)>$/m)?.[1];
  const modeText = content.match(/^处罚方式：(封禁并踢出|警告并禁言|仅禁言|仅警告)$/m)?.[1];
  const timeoutDays = content.match(/^禁言时长：([0-9]+) 天$/m)?.[1];
  const warningDaysText = content.match(/^警告时长：([0-9]+) 天$/m)?.[1];
  const reasonMatch = content.match(/^原因：(.*?)(?:\n\n此确认仅限你本人操作，)/ms);
  if (!targetId || !modeText || !reasonMatch) return null;
  const mode = modeText === '封禁并踢出' ? 'ban' : modeText === '警告并禁言' ? 'both' : modeText === '仅禁言' ? 'timeout' : 'warning';
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
  ...['处罚', '永封', '删帖', '锁定并关闭', '管理删帖', '管理锁定', '解锁'].map((name) =>
    new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message)),
  ...['处罚', '永封'].map((name) =>
    new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.User)),
  ...(() => {
    const command = new SlashCommandBuilder()
      .setName('说话').setDescription('让机器人以自己的身份在当前频道或子区发言')
      .addStringOption((o) => o.setName('内容').setDescription('机器人要发送的消息（与图片至少填写一项）').setRequired(false).setMaxLength(1900));
    for (const name of ['图片1', '图片2', '图片3', '图片4', '图片5']) {
      command.addAttachmentOption((o) => o.setName(name).setDescription('可选图片附件').setRequired(false));
    }
    command
      .addStringOption((o) => o.setName('图片链接').setDescription('可填多个 HTTPS 图片链接，用空格或换行分隔').setRequired(false).setMaxLength(1800))
      .addStringOption((o) => o.setName('回复消息链接').setDescription('可选：粘贴当前频道/子区中要回复的消息链接').setRequired(false).setMaxLength(200));
    return [command];
  })(),
  new SlashCommandBuilder()
    .setName('说话转发').setDescription('让机器人把一条本服务器可见的消息转发到当前频道或子区')
    .addStringOption((o) => o.setName('消息链接').setDescription('粘贴本服务器消息的 Discord 链接').setRequired(true).setMaxLength(200)),
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
    .setName('版务审批面板').setDescription('配置帖子操作和内容删除的审批流程')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理删帖面板').setDescription('配置管理组删帖记录和办公室提醒')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理删帖').setDescription('发起管理组删帖并进行二次确认')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器帖子内一条消息的链接').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('解锁').setDescription('由主管理组成员解锁并重新开放一个帖子')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器帖子内一条消息的链接').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('管理锁定').setDescription('由管理组成员直接锁定并关闭一个帖子')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器帖子内一条消息的链接').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('反应清理面板').setDescription('配置指定成员消息的自动表情反应清理')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('帖子操作申请').setDescription('申请锁定、关闭或锁定并关闭一个帖子')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器的帖子链接').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('操作').setDescription('要申请的帖子操作').setRequired(true)
      .addChoices({ name: '锁定', value: 'lock' }, { name: '关闭', value: 'close' }, { name: '锁定并关闭', value: 'lock-close' })),
  new SlashCommandBuilder()
    .setName('内容删除申请').setDescription('申请删除指定消息或整个帖子')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器的消息或帖子链接').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('目标类型').setDescription('选择删除一条消息还是整个帖子').setRequired(true)
      .addChoices({ name: '一条消息', value: 'message' }, { name: '整个帖子', value: 'thread' })),
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
    .setName('处罚').setDescription('警告或禁言成员')
    .addStringOption((o) => o.setName('方式').setDescription('选择处罚方式').setRequired(true)
      .addChoices({ name: '仅警告', value: 'warning' }, { name: '仅禁言', value: 'timeout' }, { name: '警告并禁言', value: 'both' }))
    .addStringOption((o) => o.setName('原因').setDescription('处罚原因').setRequired(true).setMaxLength(400))
    .addUserOption((o) => o.setName('成员').setDescription('从当前服务器选择成员（与用户 ID 二选一）').setRequired(false))
    .addStringOption((o) => o.setName('user_id').setDescription('目标在另一互通服务器时填用户 ID 或提及（与成员二选一）').setRequired(false).setMaxLength(32))
    .addIntegerOption((o) => o.setName('禁言天数').setDescription('禁言时长（1 到 90 天；仅禁言或警告并禁言时填写）').setRequired(false).setMinValue(1).setMaxValue(90))
    .addIntegerOption((o) => o.setName('警告天数').setDescription('警告身份组保留天数（1 到 90；留空则不自动移除）').setRequired(false).setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder()
    .setName('永封').setDescription('永久封禁并移出目标成员')
    .addStringOption((o) => o.setName('原因').setDescription('封禁原因').setRequired(true).setMaxLength(400))
    .addUserOption((o) => o.setName('成员').setDescription('从当前服务器选择成员（可选）').setRequired(false))
    .addStringOption((o) => o.setName('user_id').setDescription('服务器外用户：输入用户 ID 或用户提及（可选）').setRequired(false).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('撤销处罚').setDescription('按处罚 ID 撤销警告、禁言或封禁')
    .addStringOption((o) => o.setName('处罚编号').setDescription('处罚记录中的编号').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('定时提醒').setDescription('管理定时提及提醒')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('添加').setDescription('添加定时提醒（到期后自动重复，间隔为 0 表示只提醒一次）')
      .addChannelOption((o) => o.setName('频道').setDescription('发送提醒的频道').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('重复间隔分钟').setDescription('0 表示只发送一次；最小重复间隔 10 分钟').setRequired(true).setMinValue(0).setMaxValue(525600))
      .addStringOption((o) => o.setName('内容').setDescription('提醒文字').setRequired(true).setMaxLength(1500))
      .addIntegerOption((o) => o.setName('分钟后').setDescription('首次提醒在多少分钟后发送；与“秒后”二选一').setRequired(false).setMinValue(1).setMaxValue(525600))
      .addIntegerOption((o) => o.setName('秒后').setDescription('首次提醒在多少秒后发送（最少 5 秒；与“分钟后”二选一）').setRequired(false).setMinValue(5).setMaxValue(31536000))
      .addUserOption((o) => o.setName('提及成员').setDescription('要提醒的某个人（可选）').setRequired(false))
      .addStringOption((o) => o.setName('提及多人').setDescription('多个成员提及，粘贴成员提及并用空格或逗号分隔，最多 25 人').setRequired(false).setMaxLength(600))
      .addRoleOption((o) => o.setName('提及身份组').setDescription('要提醒的身份组（可选）').setRequired(false)))
    .addSubcommand((s) => s.setName('列表').setDescription('查看本服务器的定时提醒'))
    .addSubcommand((s) => s.setName('删除').setDescription('按编号删除一个定时提醒')
      .addStringOption((o) => o.setName('编号').setDescription('在提醒列表中查看编号').setRequired(true).setMaxLength(40))),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildIds = commandGuildIds();
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

function defaultGuildData() {
  return { settings: {}, reminders: [], warningFollowups: [], warningExpirations: [], punishmentCases: [], moderationProposals: [] };
}

function snapshotStorageState() {
  return JSON.parse(JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    guildData,
    longTimeouts,
    pendingPunishments: pendingPunishmentRecords,
    processedPunishmentTokens,
  }));
}

function savePlatformStorage() {
  if (!storageChannel || !client.isReady()) return Promise.reject(new Error('Discord 私密存储频道尚未连接，数据没有保存。'));
  storageWriteRequested = true;
  if (storageWritePromise) {
    const activeWrite = storageWritePromise;
    return activeWrite.then(() => storageWriteRequested ? savePlatformStorage() : undefined);
  }

  const write = (async () => {
    do {
      // Coalesce concurrent state changes into one encrypted attachment update.
      // If another command changes data during the REST request, write one more
      // latest snapshot before unblocking the callers.
      storageWriteRequested = false;
      const snapshot = snapshotStorageState();
      const file = Buffer.from(encryptJson(snapshot), 'utf8');
      const options = {
        content: STORAGE_MARKER,
        files: [{ attachment: file, name: STORAGE_FILE_NAME }],
        allowedMentions: { parse: [] },
      };
      if (storageMessage?.author?.id === client.user.id) {
        try {
          storageMessage = await storageMessage.edit({ ...options, attachments: [] });
        } catch (error) {
          if (error.code !== 10008) throw error;
          storageMessage = await storageChannel.send(options);
        }
      } else {
        storageMessage = await storageChannel.send(options);
      }
    } while (storageWriteRequested);
  })();
  let trackedWrite;
  trackedWrite = write.finally(() => {
    if (storageWritePromise === trackedWrite) storageWritePromise = null;
    // A save request can arrive just as the previous write loop is finishing.
    if (storageWriteRequested) return savePlatformStorage();
  });
  storageWritePromise = trackedWrite;
  return trackedWrite;
}

async function findStorageMessage(channel) {
  let before;
  for (let page = 0; page < 10; page += 1) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!messages.size) return null;
    const found = messages.find((message) => message.author.id === client.user.id && message.content === STORAGE_MARKER);
    if (found) return found;
    before = messages.last().id;
    if (messages.size < 100) return null;
  }
  return null;
}

async function readStorageSnapshot(message) {
  const attachment = message.attachments.find((item) => item.name === STORAGE_FILE_NAME);
  if (!attachment) throw new Error('Discord 私密存储记录缺少数据附件；为避免覆盖数据，机器人已停止启动。');
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`读取 Discord 私密存储附件失败（HTTP ${response.status}）。`);
  const { value, encrypted } = decryptJson(JSON.parse(await response.text()));
  if (value?.version !== 1 || !value.guildData || !Array.isArray(value.longTimeouts) || !value.pendingPunishments) {
    throw new Error('Discord 私密存储记录格式无效；为避免覆盖数据，机器人已停止启动。');
  }
  return { saved: value, encrypted };
}

async function fetchLegacyLocalState() {
  let savedGuildData = defaultGuildData();
  let savedTimeouts = [];
  const savedPending = {};
  try {
    const saved = await readLegacyJson(guildDataFile);
    savedGuildData = { ...defaultGuildData(), ...saved };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const saved = await readLegacyJson(timeoutFile);
    if (Array.isArray(saved)) savedTimeouts = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const entries = await fs.readdir(pendingPunishmentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{16}(?:\..+)?\.(?:json|processing)$/.test(entry.name)) continue;
      const token = entry.name.slice(0, 16);
      const file = path.join(pendingPunishmentsDir, entry.name);
      try { savedPending[token] = await readLegacyJson(file); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { savedGuildData, savedTimeouts, savedPending };
}

async function encryptLegacyLocalStateFile(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!raw.trim()) return false;

  const value = JSON.parse(raw);
  const { encrypted } = decryptJson(value);
  if (encrypted) return false;

  const temporaryFile = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporaryFile, encryptJson(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryFile, file);
  } catch (error) {
    try { await fs.unlink(temporaryFile); } catch {}
    throw error;
  }
  return true;
}

async function encryptLegacyLocalStateFiles() {
  const files = [guildDataFile, timeoutFile];
  try {
    const entries = await fs.readdir(pendingPunishmentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^[a-f0-9]{16}(?:\..+)?\.(?:json|processing)$/.test(entry.name)) {
        files.push(path.join(pendingPunishmentsDir, entry.name));
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  let encryptedCount = 0;
  for (const file of files) {
    if (await encryptLegacyLocalStateFile(file)) encryptedCount += 1;
  }
  if (encryptedCount) {
    console.log(`已使用 AES-256-GCM 加密 ${encryptedCount} 份本机旧状态副本。`);
  }
}

async function loadPlatformStorage() {
  if (!storageChannelId) throw new Error('请先在 .env 配置 DISCORD_STORAGE_CHANNEL_ID（私密存储频道 ID）。');
  storageChannel = await client.channels.fetch(storageChannelId);
  if (!storageChannel?.isTextBased?.() || !storageChannel.messages || !storageChannel.guild) {
    throw new Error('DISCORD_STORAGE_CHANNEL_ID 必须是机器人可访问的服务器文字频道或子区。');
  }
  const permissions = storageChannel.permissionsFor(client.user);
  const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
  if (!permissions?.has(requiredPermissions)) {
    throw new Error('机器人在私密存储频道需要查看频道、读取消息历史、发送消息和附加文件权限。');
  }
  if (storageChannel.permissionsFor(storageChannel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('存储频道目前对 @everyone 可见。请先将频道设为私密，仅允许机器人和可信管理员访问。');
  }

  const storedMessage = await findStorageMessage(storageChannel);

  if (storedMessage) {
    const { saved, encrypted } = await readStorageSnapshot(storedMessage);
    guildData = { ...defaultGuildData(), ...saved.guildData };
    longTimeouts = saved.longTimeouts;
    Object.assign(pendingPunishmentRecords, saved.pendingPunishments);
    Object.assign(processedPunishmentTokens, saved.processedPunishmentTokens || {});
    storageMessage = storedMessage;
    if (!encrypted) {
      await savePlatformStorage();
      console.log('已读取旧版未加密状态，并已在当前 Discord 频道覆盖为 AES-256-GCM 加密附件。');
    }
    await encryptLegacyLocalStateFiles();
    console.log('已从 Discord 私密存储频道读取数据。');
    return;
  }

  if (legacyStorageChannelId && legacyStorageChannelId !== storageChannelId) {
    const legacyChannel = await client.channels.fetch(legacyStorageChannelId);
    if (!legacyChannel?.isTextBased?.() || !legacyChannel.messages || !legacyChannel.guild) {
      throw new Error('DISCORD_LEGACY_STORAGE_CHANNEL_ID 必须是机器人可访问的旧状态文字频道。');
    }
    const legacyPermissions = legacyChannel.permissionsFor(client.user);
    if (!legacyPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error('机器人在旧状态频道需要查看频道和读取消息历史权限，无法迁移旧数据。');
    }
    const legacyMessage = await findStorageMessage(legacyChannel);
    if (legacyMessage) {
      const { saved } = await readStorageSnapshot(legacyMessage);
      guildData = { ...defaultGuildData(), ...saved.guildData };
      longTimeouts = saved.longTimeouts;
      Object.assign(pendingPunishmentRecords, saved.pendingPunishments);
      Object.assign(processedPunishmentTokens, saved.processedPunishmentTokens || {});
      await savePlatformStorage();
      await encryptLegacyLocalStateFiles();
      console.log('已从旧 Discord 状态频道迁移数据，并以 AES-256-GCM 加密后保存到新频道；旧频道副本未删除。');
      return;
    }
  }

  const legacy = await fetchLegacyLocalState();
  guildData = legacy.savedGuildData;
  longTimeouts = legacy.savedTimeouts;
  Object.assign(pendingPunishmentRecords, legacy.savedPending);
  await savePlatformStorage();
  await encryptLegacyLocalStateFiles();
  console.log('已将本地旧数据复制到 Discord 私密存储频道。本地旧文件尚未删除，请先核对 Discord 中的存储记录。');
}

async function saveTimeouts() {
  await savePlatformStorage();
}

async function saveGuildData() {
  await savePlatformStorage();
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
    companionRoleId: setting.managementCompanionRoleId || null,
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

function punishmentNoticeEmbed({ user, moderator, reason, timeoutDays, hasWarning, hasBan, warningDays, caseId, replacedCaseId = null }) {
  return new EmbedBuilder().setColor(hasBan ? 0x992D22 : timeoutDays ? 0xE67E22 : 0xF1C40F)
    .setTitle(hasBan ? '⛔ 封禁并踢出' : '⚠️ 处罚通知')
    .addFields(
      { name: '成员', value: `<@${user.id}>`, inline: true },
      { name: '管理员', value: `<@${moderator.id}>`, inline: true },
      { name: '原因', value: reason.slice(0, 1024) },
      ...(timeoutDays ? [{ name: '禁言时长', value: `${timeoutDays} 天`, inline: true }] : []),
      ...(hasWarning ? [{ name: '警告', value: warningDays ? `${warningDays} 天` : '不自动移除', inline: true }] : []),
      { name: '处罚 ID', value: caseId, inline: false },
      ...(replacedCaseId ? [{ name: '覆盖处罚', value: replacedCaseId, inline: false }] : []),
    ).setThumbnail(user.displayAvatarURL({ size: 128 })).setTimestamp();
}

async function postPunishment(guild, details) {
  const setting = settingsFor(guild.id);
  if (!setting.logChannelId) return { primarySent: false, auditSent: !setting.auditChannelId };
  const channel = await guild.channels.fetch(setting.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return { primarySent: false, auditSent: !setting.auditChannelId };
  return sendPunishmentEmbed(guild, punishmentNoticeEmbed(details));
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
    { name: '撤销内容', value: [record.hasWarning ? '警告' : null, record.hasTimeout ? '禁言' : null, record.hasBan || record.mode === 'ban' ? '封禁' : null].filter(Boolean).join(' + '), inline: true },
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
      console.error('Punishment log channel is unavailable.');
      continue;
    }
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      if (channelId === setting.logChannelId) primarySent = true;
      if (channelId === setting.auditChannelId) auditSent = true;
    } catch (error) {
      logFailure('Could not write punishment log.', error);
    }
  }
  return { primarySent, auditSent };
}

async function validatePunishmentRequest(interaction, request) {
  const hasBan = request.mode === 'ban';
  const hasWarning = !hasBan && request.mode !== 'timeout';
  const hasTimeout = !hasBan && request.mode !== 'warning';
  const user = await client.users.fetch(request.userId);
  const availableGuildIds = commandGuildIds();
  if (availableGuildIds.length && !availableGuildIds.includes(interaction.guildId)) {
    throw new Error('当前服务器未包含在 DISCORD_GUILD_IDS 可用名单中。');
  }
  const pairedGuildIds = punishmentGuildIds();
  const isPairedGuild = pairedGuildIds.includes(interaction.guildId);
  if (isPairedGuild && (pairedGuildIds.length !== 2
      || (availableGuildIds.length && !pairedGuildIds.every((id) => availableGuildIds.includes(id))))) {
    throw new Error('处罚互通需要在 DISCORD_PUNISHMENT_GUILD_IDS 配置两个服务器 ID，并确保它们也包含在 DISCORD_GUILD_IDS；再分别在两边配置处罚频道和警告身份组。');
  }
  const guildIds = isPairedGuild ? pairedGuildIds : [interaction.guildId];
  const guilds = await Promise.all(guildIds.map((id) => client.guilds.fetch(id)));
  const contexts = [];
  const absentGuilds = [];
  for (const guild of guilds) {
    let member = null;
    try { member = await guild.members.fetch({ user: user.id, force: true, cache: false }); }
    catch (error) {
      if ((error.code ?? error.rawError?.code) !== 10007) throw error;
    }
    const setting = settingsFor(guild.id);
    // Both sides need a working public notice channel, even when punishment applies on only one side.
    if (!setting.logChannelId) throw new Error(`尚未为“${guild.name}”配置处罚记录频道。请先在该服务器运行“/处罚面板”。`);
    const logChannel = await guild.channels.fetch(setting.logChannelId).catch(() => null);
    if (!logChannel?.isTextBased()) throw new Error(`“${guild.name}”的处罚记录频道不可用，未执行处罚。`);
    const logPermissions = logChannel.permissionsFor(client.user);
    if (!logPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new Error(`机器人在“${guild.name}”的处罚记录频道缺少查看、发送消息或嵌入链接权限，未执行处罚。`);
    }
    if (setting.auditChannelId) {
      const auditChannel = await guild.channels.fetch(setting.auditChannelId).catch(() => null);
      const auditPermissions = auditChannel?.isTextBased() ? auditChannel.permissionsFor(client.user) : null;
      if (!auditPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new Error(`机器人在“${guild.name}”的留痕频道缺少查看、发送消息或嵌入链接权限，未执行处罚。`);
      }
    }
    if (!member && !hasBan) {
      absentGuilds.push(guild);
      continue;
    }
    // Discord can ban a user by ID even when they are not a guild member.
    const botMember = await guild.members.fetchMe();
    const previousCase = guildData.punishmentCases.find((item) => item.guildId === guild.id && item.userId === user.id && item.status === 'active');
    const botNeedsRoles = hasWarning || Boolean(previousCase?.hasWarning && !hasWarning && !hasBan);
    const botNeedsModeration = hasTimeout || Boolean(previousCase?.hasTimeout && !hasTimeout && !hasBan);
    const botNeedsBan = hasBan;
    if (botNeedsRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error(`机器人在“${guild.name}”缺少“管理身份组”权限，未执行处罚。`);
    }
    if (botNeedsModeration && !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      throw new Error(`机器人在“${guild.name}”缺少“管理成员”权限，未执行处罚。`);
    }
    if (botNeedsBan && !botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      throw new Error(`机器人在“${guild.name}”缺少“封禁成员”权限，未执行处罚。`);
    }
    if (member && member.roles.highest.position >= botMember.roles.highest.position) {
      throw new Error(`机器人身份组必须高于目标成员在“${guild.name}”中的最高身份组，未执行处罚。`);
    }
    let warningRole = null;
    if (setting.warningRoleId) {
      warningRole = await guild.roles.fetch(setting.warningRoleId).catch(() => null);
      if (hasWarning && (!warningRole || warningRole.id === guild.id || warningRole.managed || warningRole.position >= botMember.roles.highest.position)) {
        throw new Error(`“${guild.name}”的警告身份组无效或高于机器人身份组，未执行处罚。`);
      }
    } else if (hasWarning) {
      throw new Error(`尚未为“${guild.name}”设置警告身份组。请先在该服务器运行“/处罚面板”。`);
    }
    contexts.push({ guild, member, botMember, setting, warningRole, previousCase, hasWarning, hasTimeout, hasBan });
  }
  if (!contexts.length) throw new Error('目标成员不在任一可处罚服务器中，未执行处罚。');
  const sourceChannel = interaction.channel || await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  const sourceBotMember = await interaction.guild.members.fetchMe();
  const sourcePermissions = sourceChannel?.permissionsFor(sourceBotMember);
  const sendPermission = sourceChannel?.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!sourceChannel?.isTextBased() || sourceChannel.type === ChannelType.GuildForum
      || sourceChannel.guildId !== interaction.guildId
      || !sourcePermissions?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])) {
    throw new Error('机器人无法在当前频道公示处罚通知；请确认机器人有查看频道、发送消息和嵌入链接权限。');
  }
  const displayContext = contexts.find((context) => context.guild.id === interaction.guildId && context.member)
    || contexts.find((context) => context.member)
    || contexts.find((context) => context.guild.id === interaction.guildId)
    || contexts[0];
  return { ...displayContext, user, contexts, absentGuilds, hasWarning, hasTimeout, hasBan };
}

async function executePunishmentRequest(interaction, request, targetLockHeld = false) {
  const lockKey = request.userId;
  if (targetLockHeld) {
    if (!activePunishmentLocks.has(lockKey)) throw new Error('处罚目标锁定状态无效，请重新发起处罚。');
  } else {
    if (activePunishmentLocks.has(lockKey)) throw new Error('该目标正在执行另一笔处罚，请稍后重试。');
    activePunishmentLocks.add(lockKey);
  }
  try { return await executePunishmentRequestUnlocked(interaction, request); }
  finally { activePunishmentLocks.delete(lockKey); }
}

async function executePunishmentRequestUnlocked(interaction, request) {
  const { user, contexts, absentGuilds, hasWarning, hasTimeout, hasBan } = await validatePunishmentRequest(interaction, request);
  const { mode, reason, timeoutDays, warningDays } = request;
  const caseId = randomBytes(6).toString('hex');
  const applied = [];
  try {
    for (const context of contexts) {
      const { guild, member, warningRole, previousCase } = context;
      const oldTimeoutUntil = member?.communicationDisabledUntilTimestamp || 0;
      const alreadyHeldWarning = Boolean(warningRole && member?.roles.cache.has(warningRole.id));
      const appliedContext = { context, oldTimeoutUntil, alreadyHeldWarning, addedWarning: false, changedTimeout: false, banned: false };
      applied.push(appliedContext);
      if (hasBan) {
        await guild.members.ban(user.id, { reason: `处罚 ${caseId}：${reason}` });
        appliedContext.banned = true;
      }
      if (hasWarning && !alreadyHeldWarning) {
        await member.roles.add(warningRole, `警告处罚 ${caseId}：${reason}`);
        appliedContext.addedWarning = true;
      }
      if (hasTimeout) {
        const endAt = Date.now() + timeoutDays * DAY;
        const until = Math.min(endAt, Date.now() + MAX_TIMEOUT);
        await member.timeout(until - Date.now(), reason);
        appliedContext.changedTimeout = true;
      }
    }
  } catch (error) {
    for (const { context, oldTimeoutUntil, addedWarning, changedTimeout, banned } of applied.reverse()) {
      if (banned) await context.guild.members.unban(user.id, `同步处罚 ${caseId} 未能完成，回滚`).catch(() => {});
      if (addedWarning && context.warningRole) await context.member.roles.remove(context.warningRole, `同步处罚 ${caseId} 未能完成，回滚`).catch(() => {});
      if (changedTimeout) {
        const remainingMs = oldTimeoutUntil - Date.now();
        await context.member.timeout(remainingMs > 0 ? remainingMs : null, `同步处罚 ${caseId} 未能完成，回滚`).catch(() => {});
      }
    }
    throw new Error(`双向同步未能在全部服务器完成，已尝试回滚；${error.message}`);
  }

  const now = Date.now();
  const cleanupFailures = [];
  for (const { guild, member, setting, warningRole, previousCase } of contexts) {
    if (previousCase) {
      if (!hasBan && previousCase.hasWarning && (!hasWarning || previousCase.warningRoleId !== warningRole?.id)) {
        const previousRole = await guild.roles.fetch(previousCase.warningRoleId).catch(() => null);
        if (previousRole && member.roles.cache.has(previousRole.id)) {
          try { await member.roles.remove(previousRole, `处罚 ${caseId} 覆盖旧处罚 ${previousCase.id}`); }
          catch (error) { cleanupFailures.push(guild.name); logFailure('旧警告身份组清理失败。', error); }
        }
      }
      if (!hasBan && previousCase.hasTimeout && !hasTimeout) {
        try { await member.timeout(null, `处罚 ${caseId} 覆盖旧处罚 ${previousCase.id}`); }
        catch (error) { cleanupFailures.push(guild.name); logFailure('旧禁言清理失败。', error); }
      }
      previousCase.status = 'superseded';
      previousCase.supersededBy = caseId;
    }
    longTimeouts = longTimeouts.filter((job) => !(job.guildId === guild.id && job.userId === user.id));
    guildData.warningExpirations = guildData.warningExpirations.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
    guildData.warningFollowups = guildData.warningFollowups.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
    if (hasTimeout && timeoutDays > 28) {
      const endAt = now + timeoutDays * DAY;
      longTimeouts.push({ guildId: guild.id, userId: user.id, caseId, endAt, nextRefreshAt: Math.min(endAt, now + MAX_TIMEOUT) - DAY, reason });
    }
    if (hasWarning && warningDays) guildData.warningExpirations.push({ id: caseId, caseId, guildId: guild.id, userId: user.id, roleId: warningRole.id, expiresAt: now + warningDays * DAY });
    guildData.punishmentCases.push({ id: caseId, syncGroupId: caseId, syncGuildIds: contexts.map((item) => item.guild.id), guildId: guild.id,
      userId: user.id, moderatorId: interaction.user.id, mode, reason, hasWarning, warningRoleId: warningRole?.id || null,
      warningDays: warningDays || null, hasTimeout, timeoutDays: timeoutDays || null, hasBan, status: 'active', createdAt: now });
  }
  for (const guild of absentGuilds) {
    for (const previousCase of guildData.punishmentCases.filter((item) => item.guildId === guild.id && item.userId === user.id && item.status === 'active')) {
      previousCase.status = 'superseded';
      previousCase.supersededBy = caseId;
    }
    longTimeouts = longTimeouts.filter((job) => !(job.guildId === guild.id && job.userId === user.id));
    guildData.warningExpirations = guildData.warningExpirations.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
    guildData.warningFollowups = guildData.warningFollowups.filter((item) => !(item.guildId === guild.id && item.userId === user.id));
  }
  if (hasWarning && contexts.some((context) => context.setting.secondWarningReminder)) {
    guildData.warningFollowups.push({ id: `${caseId}-${user.id}`, caseId, guildId: interaction.guildId, userId: user.id,
      guildName: contexts.map((context) => context.guild.name).join('、'), reason, dueAt: now + DAY });
  }
  if (hasWarning) await user.send(`你在以下服务器收到同步警告：${contexts.map((item) => item.guild.name).join('、')}。原因：${reason}`).catch(() => {});
  let persistenceFailed = false;
  try { await savePlatformStorage(); }
  catch (error) { persistenceFailed = true; logFailure('双向处罚已应用，但状态没有写入 Discord 私密存储。', error); }
  const executedGuildNames = contexts.map((item) => item.guild.name);
  const absentGuildNames = absentGuilds.map((guild) => guild.name);
  const logTargets = [
    ...contexts.map(({ guild, previousCase }) => ({ guild, previousCase })),
    ...absentGuilds.map((guild) => ({ guild, previousCase: null })),
  ];
  const logResults = await Promise.all(logTargets.map(async ({ guild, previousCase }) => ({
    guildId: guild.id,
    ...(await postPunishment(guild, {
      user, moderator: interaction.user, mode, reason, timeoutDays, hasWarning, hasBan, warningDays, caseId,
      replacedCaseId: previousCase?.id || null,
    })),
  })));
  const failedLogs = logResults.filter((logged) => !logged.primarySent || !logged.auditSent).length;
  const sourceLog = logResults.find((item) => item.guildId === interaction.guildId);
  const sourceSetting = settingsFor(interaction.guildId);
  const alreadyAnnounced = sourceLog && (interaction.channelId === sourceSetting.logChannelId
    ? sourceLog.primarySent : interaction.channelId === sourceSetting.auditChannelId && sourceLog.auditSent);
  let announcedInCurrentChannel = Boolean(alreadyAnnounced);
  if (!announcedInCurrentChannel) {
    try {
      const channel = interaction.channel || await interaction.guild.channels.fetch(interaction.channelId);
      const replacedCaseIds = [...new Set(contexts.map((item) => item.previousCase?.id).filter(Boolean))].join('、');
      await channel.send({ embeds: [punishmentNoticeEmbed({ user, moderator: interaction.user, reason, timeoutDays, hasWarning, hasBan,
        warningDays, caseId, replacedCaseId: replacedCaseIds || null })],
      allowedMentions: { parse: [] } });
      announcedInCurrentChannel = true;
    } catch (error) { logFailure('当前频道处罚公示发送失败。', error); }
  }
  const summary = [`已在“${executedGuildNames.join('、')}”执行处罚，编号：\`${caseId}\`。`,
    ...(hasBan ? ['目标已被封禁并移出对应服务器；撤销可使用此处罚编号。'] : []),
    ...(hasWarning ? [`警告身份组${warningDays ? `将在 ${warningDays} 天后自动移除` : '不会自动移除'}。`] : []),
    ...(hasTimeout ? [`已禁言 ${timeoutDays} 天${timeoutDays > 28 ? '，并保存自动续期计划' : ''}。`] : []),
    ...(absentGuilds.length ? [`目标不在“${absentGuildNames.join('、')}”，该服未执行警告或禁言，已向该服公示。`] : []),
    ...(hasWarning && contexts.some((context) => context.setting.secondWarningReminder) ? ['已安排 24 小时后的二次私信提醒。'] : []),
    ...(cleanupFailures.length ? [`旧处罚清理在以下服务器失败：${[...new Set(cleanupFailures)].join('、')}。`] : []),
    ...(failedLogs ? [`有 ${failedLogs} 个服务器的处罚记录或留痕频道写入失败，请检查对应面板和频道权限。`] : []),
    ...(!announcedInCurrentChannel ? ['当前频道公示发送失败；处罚本身已执行，请检查该频道的 Bot 权限。'] : []),
    ...(persistenceFailed ? ['同步状态写入 Discord 私密存储失败；请先保持 Bot 运行并检查存储频道连接，再重试保存。'] : [])];
  return summary.join('\n');
}

async function processSchedules() {
  if (scheduleProcessing) return;
  scheduleProcessing = true;
  try { await processSchedulesUnlocked(); }
  finally { scheduleProcessing = false; }
}

async function processSchedulesUnlocked() {
  const now = Date.now();
  let changed = false;
  for (const reminder of [...guildData.reminders]) {
    if (reminder.nextAt > now) continue;
    try {
      const guild = await client.guilds.fetch(reminder.guildId);
      const channel = await guild.channels.fetch(reminder.channelId);
      const userIds = reminder.userIds || (reminder.userId ? [reminder.userId] : []);
      const mentions = [...userIds.map((id) => `<@${id}>`), ...(reminder.roleId ? [`<@&${reminder.roleId}>`] : [])];
      await channel.send({ content: `${mentions.join(' ')} ${reminder.content}`.trim(),
        allowedMentions: { users: userIds, roles: reminder.roleId ? [reminder.roleId] : [] } });
      if (reminder.intervalMs > 0) reminder.nextAt = now + reminder.intervalMs;
      else guildData.reminders = guildData.reminders.filter((item) => item.id !== reminder.id);
      changed = true;
    } catch (error) {
      logFailure('A scheduled reminder could not be sent.', error);
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
      logFailure('A warning follow-up could not be sent.', error);
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
        logFailure('A warning role expiration failed.', error);
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

function moderationProposalResourceKey(proposal) {
  const targetType = proposal.kind === 'thread-action' || proposal.deleteTargetType === 'thread' ? 'thread' : 'message';
  const targetId = targetType === 'thread' ? (proposal.threadId || proposal.channelId) : proposal.messageId;
  return targetId ? targetType + ':' + targetId : null;
}

async function notifyModerationOffice(guild, proposal, roleIds, stageLabel) {
  const setting = settingsFor(guild.id);
  if (!setting.moderationOfficeChannelId || !roleIds || !roleIds.length || !proposal.approvalMessageId) return;
  try {
    const channel = await guild.channels.fetch(setting.moderationOfficeChannelId).catch(() => null);
    const botMember = await guild.members.fetchMe();
    const permissions = channel && channel.permissionsFor(botMember);
    if (!channel || !channel.isTextBased() || !channel.send || !permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('办公室频道不可用，或 Bot 缺少查看/发送消息权限。');
    const roles = roleIds.map((id) => guild.roles.cache.get(id)).filter(Boolean);
    if (roles.some((role) => !role.mentionable) && !permissions.has(PermissionFlagsBits.MentionEveryone)) throw new Error('请开启目标身份组的“允许任何人提及”，或授予 Bot“提及 @everyone、@here 和所有身份组”权限。');
    const mentions = roleIds.map((id) => '<@&' + id + '>').join(' ');
    const jumpUrl = 'https://discord.com/channels/' + proposal.guildId + '/' + proposal.approvalChannelId + '/' + proposal.approvalMessageId;
    await channel.send({ content: mentions + ' 有新的' + stageLabel + '，请点击审批卡处理：' + jumpUrl + '\n事项：' + proposal.actionLabel + '\n申请编号：' + proposal.id, allowedMentions: { parse: [], roles: roleIds } });
  } catch (error) {
    logFailure('版务办公室频道通知发送失败。', error);
  }
}
function moderationApprovalPanelEmbed(guildId) {
  const setting = settingsFor(guildId);
  return new EmbedBuilder().setColor(0x5865F2).setTitle('帖子操作与内容删除审批设置')
    .setDescription(`审批频道：${setting.moderationApprovalChannelId ? `<#${setting.moderationApprovalChannelId}>` : '未设置'}\n办公室频道：${setting.moderationOfficeChannelId ? `<#${setting.moderationOfficeChannelId}>` : '未设置'}\n操作员身份组：${setting.moderationOperatorRoleIds?.length ? setting.moderationOperatorRoleIds.map((id) => `<@&${id}>`).join('、') : '未设置'}\n审核员身份组：${setting.moderationReviewerRoleId ? `<@&${setting.moderationReviewerRoleId}>` : '未设置'}\n帖子操作员同意票数：${setting.threadOperatorVotesRequired || 2}\n删除操作员同意票数：${setting.deleteOperatorVotesRequired || 2}\n删除审核员同意票数：${setting.moderationReviewerVotesRequired || 2}\n\n锁定/关闭帖子：达到帖子操作员票数后执行。\n删除消息/帖子：先达到删除操作员票数，再由审核员身份组达到票数后执行。\n申请人自动计作 1 张操作员同意票；每人每阶段只能投一次。办公室频道会在需要投票时收到申请卡链接并提及当前阶段身份组。`);
}

function moderationApprovalPanel(guildId) {
  const setting = settingsFor(guildId);
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`modcfg-channel:${guildId}`).setPlaceholder('选择审批记录频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`modcfg-operators:${guildId}`).setPlaceholder('选择操作员身份组（可多选）').setMinValues(1).setMaxValues(10)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`modcfg-reviewer:${guildId}`).setPlaceholder('选择审核员身份组')),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`modcfg-counts:${guildId}`).setLabel('设置同意票数').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`modcfg-clear:${guildId}`).setLabel('清除审批频道').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`modcfg-office:${guildId}`).setLabel('设置办公室频道').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`modcfg-office-clear:${guildId}`).setLabel('清除办公室频道').setStyle(ButtonStyle.Secondary).setDisabled(!setting.moderationOfficeChannelId),
    ),
  ];
}

function managementDeletePanelEmbed(guildId) {
  const setting = settingsFor(guildId);
  const managerRoleId = managementTrack(setting, 'senior').roleId;
  return new EmbedBuilder().setColor(0x5865F2).setTitle('管理组删帖面板')
    .setDescription(`操作记录频道：${setting.managementDeleteApprovalChannelId ? `<#${setting.managementDeleteApprovalChannelId}>` : '尚未设置（可选）'}\n办公室提醒频道：${setting.managementDeleteOfficeChannelId ? `<#${setting.managementDeleteOfficeChannelId}>` : '尚未设置（可选）'}\n可用身份组：${managerRoleId ? `<@&${managerRoleId}>` : '请先在「管理组面板」设置主管理身份组'}\n\n主管理组成员通过右键消息「管理删帖」或使用 /管理删帖 后，会直接收到删除确认按钮。按钮等待 5 秒后启用；发起人确认后立即删除整个帖子，不再计票。取消或 5 分钟未确认都不会删除。办公室频道（如已设置）会收到提及管理组的操作提醒。\n\n管理组执行「管理锁定」时仍会先填写理由，成功后在操作所在频道公示操作人、理由和帖子链接。`);
}

function managementDeletePanel(guildId) {
  const setting = settingsFor(guildId);
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`mgmtdeletecfg-approval:${guildId}`).setPlaceholder('选择管理组删帖操作记录频道（可选）').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`mgmtdeletecfg-office:${guildId}`).setPlaceholder('选择办公室提醒频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mgmtdeletecfg-clear-approval:${guildId}`).setLabel('清除记录频道').setStyle(ButtonStyle.Secondary).setDisabled(!setting.managementDeleteApprovalChannelId),
      new ButtonBuilder().setCustomId(`mgmtdeletecfg-clear-office:${guildId}`).setLabel('清除办公室频道').setStyle(ButtonStyle.Secondary).setDisabled(!setting.managementDeleteOfficeChannelId),
    ),
  ];
}

function managementDeleteConfirmationComponents(proposalId, token, disabled = true) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mgmtdelete-confirm:${proposalId}:${token}`).setLabel('确认删除帖子').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`mgmtdelete-cancel:${proposalId}:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
  )];
}

async function notifyManagementDeleteOffice(guild, proposal) {
  const setting = settingsFor(guild.id);
  const roleId = managementTrack(setting, 'senior').roleId;
  if (!setting.managementDeleteOfficeChannelId || !roleId) return false;
  const [channel, role, botMember] = await Promise.all([
    guild.channels.fetch(setting.managementDeleteOfficeChannelId).catch(() => null),
    guild.roles.fetch(roleId).catch(() => null),
    guild.members.fetchMe(),
  ]);
  const permissions = channel?.permissionsFor(botMember);
  if (!channel?.isTextBased() || !channel.send || !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error('Bot 在办公室提醒频道缺少查看或发送消息权限。');
  }
  if (!role) throw new Error('主管理身份组不存在，请在管理组面板重新配置。');
  if (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
    throw new Error('请允许 Bot 在办公室提醒频道提及主管理身份组，或开启该身份组的“允许任何人提及”。');
  }
  const jumpUrl = proposal.approvalChannelId && proposal.approvalMessageId
    ? `\n操作记录：https://discord.com/channels/${proposal.guildId}/${proposal.approvalChannelId}/${proposal.approvalMessageId}`
    : '';
  const notice = proposal.status === 'completed'
    ? '管理组已确认并完成删帖操作。'
    : proposal.status === 'failed'
      ? '管理组删帖执行失败，请查看操作记录。'
      : '有管理组删帖操作待发起人二次确认（无需投票审批）。';
  await channel.send({
    content: `<@&${roleId}> ${notice}\n目标帖子：${proposal.targetLink}\n申请编号：${proposal.id}${jumpUrl}`,
    allowedMentions: { parse: [], roles: [roleId] },
  });
  return true;
}

function isOpenModerationProposal(proposal) {
  return proposal.status === 'executing' || ['pending_operator', 'pending_reviewer', 'pending_management', 'awaiting_management_confirmation'].includes(proposal.status);
}

function moderationVoteComponents(proposal) {
  const buttons = [
    new ButtonBuilder().setCustomId(`modvote:operator:yes:${proposal.id}`).setLabel('同意').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`modvote:operator:no:${proposal.id}`).setLabel('拒绝').setStyle(ButtonStyle.Danger),
  ];
  if (proposal.status === 'pending_reviewer') {
    buttons[0].setCustomId(`modvote:reviewer:yes:${proposal.id}`);
    buttons[1].setCustomId(`modvote:reviewer:no:${proposal.id}`);
  }
  return [new ActionRowBuilder().addComponents(buttons)];
}

function moderationProposalEmbed(proposal) {
  const operatorVotes = proposal.operatorVotes?.length || 0;
  const reviewerVotes = proposal.reviewerVotes?.length || 0;
  const phase = proposal.status === 'pending_management'
    ? '旧版投票申请已停用，请重新发起并由发起人直接确认。'
    : proposal.status === 'awaiting_management_confirmation'
      ? '等待发起人二次确认；确认后删除整个帖子。'
      : proposal.status === 'pending_operator'
        ? `操作员同意：${operatorVotes}/${proposal.operatorVotesRequired}`
        : proposal.status === 'pending_reviewer'
          ? `操作员同意：${operatorVotes}/${proposal.operatorVotesRequired}\n审核员同意：${reviewerVotes}/${proposal.reviewerVotesRequired}`
          : `结果：${proposal.status === 'completed' ? '已执行' : proposal.status === 'failed' ? `执行失败：${proposal.failure || '请检查 Bot 权限'}` : proposal.status === 'rejected' ? '已拒绝' : proposal.status === 'cancelled' ? '已取消' : proposal.status === 'executing' ? '确认通过，正在执行' : '已过期'}`;
  return new EmbedBuilder().setColor(proposal.status === 'completed' ? 0x2ECC71 : proposal.status === 'rejected' ? 0xE74C3C : 0xF1C40F)
    .setTitle(proposal.kind === 'thread-action' ? '帖子操作申请' : proposal.kind === 'management-delete' ? '管理组删帖申请' : '内容删除申请')
    .setDescription(`申请人：<@${proposal.requesterId}>\n目标：${proposal.targetLink}\n操作：${proposal.actionLabel}\n\n${phase}\n\n申请编号：${proposal.id}`)
    .setTimestamp(proposal.createdAt);
}

function reactionCleanupPanelEmbed(guildId) {
  const setting = settingsFor(guildId);
  const userIds = setting.reactionDeleteUserIds || [];
  const emojiKeys = setting.reactionDeleteEmojiKeys || [];
  const emojis = emojiKeys.map((emoji) => /^\d{17,20}$/.test(emoji) ? `自定义表情 ID \`${emoji}\`` : emoji).join('、');
  return new EmbedBuilder().setColor(0x5865F2).setTitle('表情反应自动清理面板')
    .setDescription(`监控成员：${userIds.length ? userIds.map((id) => `<@${id}>`).join('、') : '尚未设置'}\n清理表情：${emojis || '尚未设置'}\n\n当其他人给这些成员发出的消息添加指定表情时，Bot 会移除该消息上此表情的所有反应。不会删除消息或读取消息内容。\n\n请确保 Bot 在相关频道/子区有“管理消息”权限。`);
}

function reactionCleanupPanel(guildId) {
  const setting = settingsFor(guildId);
  return [
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`reactclean-users:${guildId}`)
      .setPlaceholder('选择要监控发言的成员').setMinValues(1).setMaxValues(25)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reactclean-emoji:${guildId}`).setLabel('设置要清理的表情').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`reactclean-clear-users:${guildId}`).setLabel('清除成员').setStyle(ButtonStyle.Secondary).setDisabled(!(setting.reactionDeleteUserIds || []).length),
      new ButtonBuilder().setCustomId(`reactclean-clear-emojis:${guildId}`).setLabel('清除表情').setStyle(ButtonStyle.Secondary).setDisabled(!(setting.reactionDeleteEmojiKeys || []).length),
    ),
  ];
}

function parseReactionEmojiKeys(input) {
  const values = String(input || '').split(/[\s,，]+/u).map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('请至少填写一个表情。');
  if (values.length > 25) throw new Error('一次最多配置 25 个表情。');
  const keys = values.map((value) => {
    const match = value.match(/^<a?:[^:]+:(\d+)>$/) || value.match(/^[^:]+:(\d+)$/) || value.match(/^(\d{17,20})$/);
    const key = match ? match[1] : value.normalize('NFC');
    if (!key || key.length > 100) throw new Error(`无法识别这个表情：${value}`);
    return key;
  });
  return [...new Set(keys)];
}

function reactionEmojiKey(reaction) {
  return reaction.emoji.id || reaction.emoji.name?.normalize('NFC') || '';
}

function parseDiscordMessageLink(link) {
  // Discord uses both channel URLs (/guild/channel) and message URLs
  // (/guild/channel/message). Forum/thread links can also put a thread ID
  // in the third segment, so resolve it against the guild before treating it
  // as a message ID.
  const match = String(link || '').trim().match(/^https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?(?:\/(\d+))?(?:\?.*)?\/?$/i);
  return match ? {
    guildId: match[1], channelId: match[2],
    threadId: match[4] ? match[3] : null,
    messageId: match[4] || match[3] || null,
  } : null;
}

function memberHasAnyRole(member, roleIds = []) {
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function resolveModerationTarget(guild, proposal) {
  let channel = await guild.channels.fetch(proposal.channelId);
  if (!channel || channel.guildId !== guild.id) throw new Error('目标频道或子区不存在，或不属于本服务器。');
  if (proposal.kind === 'thread-action' || proposal.deleteTargetType === 'thread') {
    const linkedThreadId = proposal.threadId || proposal.messageId;
    if (!channel.isThread() && linkedThreadId) {
      const linkedThread = await guild.channels.fetch(linkedThreadId).catch(() => null);
      if (linkedThread?.isThread() && linkedThread.guildId === guild.id && linkedThread.parentId === channel.id) channel = linkedThread;
    }
    if (!channel.isThread()) throw new Error('目标链接没有指向一个仍存在的帖子或子区。请复制帖子/子区链接，或其中一条消息的链接。');
    return { channel };
  }
  if (!proposal.messageId) throw new Error('删除单条消息需要消息链接；请复制目标消息的链接。');
  if (proposal.threadId) {
    const linkedThread = await guild.channels.fetch(proposal.threadId).catch(() => null);
    if (linkedThread?.isThread() && linkedThread.guildId === guild.id && linkedThread.parentId === channel.id) channel = linkedThread;
  }
  if (!channel.isTextBased?.() || !channel.messages) throw new Error('目标不是可读取消息的文字频道或子区。');
  const message = await channel.messages.fetch(proposal.messageId);
  return { channel, message };
}

async function executeModerationProposal(guild, proposal) {
  const { channel, message } = await resolveModerationTarget(guild, proposal);
  const botMember = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  if (proposal.kind === 'thread-action') {
    if (!permissions?.has(PermissionFlagsBits.ManageThreads)) throw new Error('Bot 缺少“管理帖子”权限。');
    const auditReason = proposal.reason
      ? `管理组操作（${proposal.id}）：${proposal.reason}`.slice(0, 500)
      : `审批通过（${proposal.id}）`;
    if (proposal.action === 'lock' || proposal.action === 'lock-close') await channel.setLocked(true, auditReason);
    if (proposal.action === 'close' || proposal.action === 'lock-close') await channel.setArchived(true, auditReason);
  } else if (proposal.deleteTargetType === 'thread') {
    if (!permissions?.has(PermissionFlagsBits.ManageThreads)) throw new Error('Bot 缺少“管理帖子”权限。');
    await channel.delete(`删除审批通过（${proposal.id}）`);
  } else {
    if (!permissions?.has(PermissionFlagsBits.ManageMessages)) throw new Error('Bot 缺少“管理消息”权限。');
    await message.delete(`删除审批通过（${proposal.id}）`);
  }
}

async function createManagementDeleteProposal(interaction, link) {
  const setting = settingsFor(interaction.guildId);
  const managerRoleId = managementTrack(setting, 'senior').roleId;
  if (!managerRoleId) {
    await interaction.editReply('尚未配置主管理身份组。请先运行 `/管理组面板` 选择管理组身份组。');
    return;
  }
  const interactionRoles = interaction.member?.roles;
  const hasManagerRole = interactionRoles?.cache?.has
    ? interactionRoles.cache.has(managerRoleId)
    : Array.isArray(interactionRoles) && interactionRoles.includes(managerRoleId);
  if (!hasManagerRole) {
    await interaction.editReply('只有主管理组成员可以发起或审批管理组删帖。');
    return;
  }
  const parsed = parseDiscordMessageLink(link);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.editReply('请提供本服务器帖子内一条消息的 Discord 链接。');
    return;
  }
  // Retire matching proposals created by the old voting workflow so a stale
  // vote card cannot block a fresh direct-confirmation request.
  let retiredLegacyProposal = false;
  const targetKey = moderationProposalResourceKey({ guildId: interaction.guildId, channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId, deleteTargetType: 'thread' });
  for (const item of guildData.moderationProposals || []) {
    const isLegacyVoteProposal = item.status === 'pending_management'
      || (item.status === 'awaiting_management_confirmation'
        && (item.managementVotesRequired || Array.isArray(item.managementVotes)));
    if (item.guildId !== interaction.guildId || item.kind !== 'management-delete' || !isLegacyVoteProposal
      || moderationProposalResourceKey(item) !== targetKey) continue;
    item.status = 'cancelled';
    item.failure = '管理组删帖现为发起人直接确认，旧投票申请已停用';
    item.pendingManagementConfirmation = null;
    retiredLegacyProposal = true;
  }
  if (retiredLegacyProposal) {
    await saveGuildData();
    for (const item of guildData.moderationProposals || []) {
      if (item.guildId === interaction.guildId && item.kind === 'management-delete' && item.status === 'cancelled'
        && item.failure === '管理组删帖现为发起人直接确认，旧投票申请已停用' && moderationProposalResourceKey(item) === targetKey) {
        await updateManagementDeleteApprovalCard(interaction.guild, item).catch(() => {});
      }
    }
  }
  const proposal = {
    id: randomBytes(6).toString('hex'), guildId: interaction.guildId, kind: 'management-delete',
    requesterId: interaction.user.id, targetLink: link, channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId,
    action: 'delete-thread', actionLabel: '删除整个帖子', deleteTargetType: 'thread',
    status: 'awaiting_management_confirmation', managementRoleId: managerRoleId,
    createdAt: Date.now(),
  };
  const now = proposal.createdAt;
  const token = randomBytes(8).toString('hex');
  proposal.pendingManagementConfirmation = { token, userId: interaction.user.id, confirmAfter: now + 5000, expiresAt: now + 5 * 60 * 1000 };
  try {
    const target = await resolveModerationTarget(interaction.guild, proposal);
    if (!target.channel.isThread()) throw new Error('链接没有指向帖子。请复制帖子内一条消息的链接，或直接复制帖子链接。');
  } catch (error) {
    await interaction.editReply(`目标无法用于管理组删帖：${error.message}`);
    return;
  }
  const duplicate = (guildData.moderationProposals || []).find((item) => item.guildId === interaction.guildId
    && isOpenModerationProposal(item) && Date.now() - item.createdAt < MODERATION_PROPOSAL_TTL
    && moderationProposalResourceKey(item) === targetKey);
  if (duplicate) {
    await interaction.editReply(`这个帖子已有未完成的操作申请（编号：${duplicate.id}），请勿重复发起。`);
    return;
  }
  const targetClaim = `${interaction.guildId}:${targetKey}`;
  if (activeModerationTargetClaims.has(targetClaim)) {
    await interaction.editReply('这个帖子正在创建申请，请稍候再试。');
    return;
  }
  activeModerationTargetClaims.add(targetClaim);
  try {
    guildData.moderationProposals ||= [];
    guildData.moderationProposals.push(proposal);
    await saveGuildData();

    // The record channel is optional and informational; it never blocks the
    // confirmation flow or counts votes.
    if (setting.managementDeleteApprovalChannelId) {
      const approvalChannel = await interaction.guild.channels.fetch(setting.managementDeleteApprovalChannelId).catch(() => null);
      const approvalPermissions = approvalChannel?.permissionsFor(await interaction.guild.members.fetchMe());
      if (approvalChannel?.isTextBased?.() && approvalChannel.send
        && approvalPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        try {
          proposal.approvalChannelId = approvalChannel.id;
          const approvalMessage = await approvalChannel.send({ embeds: [moderationProposalEmbed(proposal)], components: [], allowedMentions: { parse: [] } });
          proposal.approvalMessageId = approvalMessage.id;
          await saveGuildData();
        } catch (error) {
          logFailure('管理组删帖操作记录发送失败。', error);
        }
      } else {
        logFailure('管理组删帖记录频道不可用或 Bot 权限不足；继续显示直接确认。', new Error(`频道 ${setting.managementDeleteApprovalChannelId}`));
      }
    }

    try {
      await interaction.editReply({
        content: `⚠️ 删除警示：你确认后，Bot 会立即删除整个帖子及其中的消息，此操作无法恢复。确定吗？\n\n申请编号：${proposal.id}\n为避免误触，确认按钮将在 5 秒后启用；5 分钟内未确认会自动失效。`,
        components: managementDeleteConfirmationComponents(proposal.id, token, true),
      });
    } catch (error) {
      resetManagementDeleteConfirmation(proposal);
      proposal.failure = '确认面板发送失败，帖子没有删除';
      await saveGuildData().catch((saveError) => logFailure('确认面板失败后的管理组删帖状态保存失败。', saveError));
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch(() => {});
      throw error;
    }
    // Ephemeral interaction replies cannot be edited with channel Message.edit;
    // keep the original interaction webhook for the 5-second enable and expiry.
    scheduleManagementDeleteConfirmation(proposal, interaction);

  } finally {
    activeModerationTargetClaims.delete(targetClaim);
  }
}

async function showManagementLockReasonModal(interaction, link) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '此操作只能在服务器内使用。', flags: MessageFlags.Ephemeral });
    return;
  }
  const parsed = parseDiscordMessageLink(link);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.reply({ content: '请提供本服务器帖子内一条消息的 Discord 链接。', flags: MessageFlags.Ephemeral });
    return;
  }
  const managerRoleId = managementTrack(settingsFor(interaction.guildId), 'senior').roleId;
  if (!managerRoleId) {
    await interaction.reply({ content: '尚未配置主管理身份组。请先运行 `/管理组面板` 配置管理组身份组。', flags: MessageFlags.Ephemeral });
    return;
  }
  const requester = await interaction.guild.members.fetch(interaction.user.id);
  if (!requester.roles.cache.has(managerRoleId)) {
    await interaction.reply({ content: '只有主管理组成员可以直接锁定并关闭帖子。', flags: MessageFlags.Ephemeral });
    return;
  }

  const token = randomBytes(8).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000;
  pendingManagementLockForms.set(token, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    link,
    expiresAt,
  });
  const expiryTimer = setTimeout(() => pendingManagementLockForms.delete(token), expiresAt - Date.now());
  expiryTimer.unref?.();

  const reasonInput = new TextInputBuilder().setCustomId('reason')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(400)
    .setPlaceholder('填写锁定该帖子的原因');
  const modal = new ModalBuilder().setCustomId(`management-lock-reason:${token}`).setTitle('管理组锁定帖子')
    .addComponents(new LabelBuilder().setLabel('锁定理由').setDescription('理由会与操作人和帖子链接一起公示。').setTextInputComponent(reasonInput));
  await interaction.showModal(modal);
}

async function executeManagementThreadUnlock(interaction, link) {
  const setting = settingsFor(interaction.guildId);
  const managerRoleId = managementTrack(setting, 'senior').roleId;
  if (!managerRoleId) {
    await interaction.editReply('尚未配置主管理身份组。请先运行 `/管理组面板` 配置管理组身份组。');
    return;
  }
  const requester = await interaction.guild.members.fetch(interaction.user.id);
  if (!requester.roles.cache.has(managerRoleId)) {
    await interaction.editReply('只有主管理组成员可以解锁帖子。');
    return;
  }
  const parsed = parseDiscordMessageLink(link);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.editReply('请提供本服务器帖子内一条消息的 Discord 链接。');
    return;
  }
  const proposal = {
    id: randomBytes(6).toString('hex'), guildId: interaction.guildId, kind: 'thread-action', action: 'unlock',
    actionLabel: '解锁并重新开放帖子', requesterId: interaction.user.id, targetLink: link,
    channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId, createdAt: Date.now(),
  };
  const target = await resolveModerationTarget(interaction.guild, proposal);
  if (!target.channel.isThread()) throw new Error('链接没有指向一个仍存在的帖子或子区。');
  const botMember = await interaction.guild.members.fetchMe();
  const permissions = target.channel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.ManageThreads)) throw new Error('Bot 缺少“管理帖子”权限。');
  const auditReason = `管理组解锁（${proposal.id}），操作人 ${interaction.user.id}`;
  if (target.channel.archived) await target.channel.setArchived(false, auditReason);
  if (target.channel.locked) await target.channel.setLocked(false, auditReason);

  const announcement = new EmbedBuilder().setColor(0x2ECC71).setTitle('管理组解锁帖子公示')
    .setDescription(`操作人：<@${interaction.user.id}>\n帖子：${link}\n操作：解锁并重新开放\n操作编号：${proposal.id}`)
    .setTimestamp();
  let announcementChannel = interaction.channel?.isTextBased?.() && typeof interaction.channel.send === 'function'
    ? interaction.channel : null;
  let announcementError = null;
  const currentChannelPermissions = announcementChannel?.permissionsFor(botMember);
  if (!announcementChannel || !currentChannelPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    announcementChannel = setting.managementDeleteApprovalChannelId
      ? await interaction.guild.channels.fetch(setting.managementDeleteApprovalChannelId).catch(() => null)
      : null;
  }
  if (announcementChannel?.isTextBased?.() && typeof announcementChannel.send === 'function'
    && announcementChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    try { await announcementChannel.send({ embeds: [announcement], allowedMentions: { parse: [] } }); }
    catch (error) { announcementError = error; }
  } else {
    announcementError = new Error('没有可发送解锁公示的频道。');
  }
  const result = announcementError
    ? `帖子已解锁并重新开放（操作编号：${proposal.id}），但公示发送失败。`
    : `帖子已解锁并重新开放，操作人和帖子链接已在 <#${announcementChannel.id}> 公示（操作编号：${proposal.id}）。`;
  if (announcementError) logFailure('管理组解锁公示发送失败。', announcementError);
  await interaction.editReply(result);
}

async function executeManagementThreadLock(interaction, link, reason) {
  const setting = settingsFor(interaction.guildId);
  const managerRoleId = managementTrack(setting, 'senior').roleId;
  if (!managerRoleId) {
    await interaction.editReply('尚未配置主管理身份组。请先运行 `/管理组面板` 配置管理组身份组。');
    return;
  }
  const requester = await interaction.guild.members.fetch(interaction.user.id);
  if (!requester.roles.cache.has(managerRoleId)) {
    await interaction.editReply('只有主管理组成员可以直接锁定并关闭帖子。');
    return;
  }
  const parsed = parseDiscordMessageLink(link);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.editReply('请提供本服务器帖子内一条消息的 Discord 链接。');
    return;
  }
  const proposal = {
    id: randomBytes(6).toString('hex'), guildId: interaction.guildId, kind: 'thread-action', action: 'lock-close',
    actionLabel: '锁定并关闭帖子', requesterId: interaction.user.id, targetLink: link,
    channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId, reason, createdAt: Date.now(),
  };
  let announcementMessage = null;
  let announcedInChannelId = null;
  const announcementEmbed = (description) => new EmbedBuilder().setColor(0x5865F2)
    .setTitle('管理组锁定帖子公示')
    .setDescription(`操作人：<@${interaction.user.id}>\n帖子：${proposal.targetLink}\n操作：锁定并关闭\n锁定理由：${reason}\n操作编号：${proposal.id}\n\n${description}`)
    .setTimestamp();
  try {
    const target = await resolveModerationTarget(interaction.guild, proposal);
    if (!target.channel.isThread()) throw new Error('链接没有指向一个仍存在的帖子。');
    const sameChannelAsTarget = interaction.channelId === target.channel.id;
    let announcementError = null;
    const announcementChannel = interaction.channel?.isTextBased?.() && typeof interaction.channel.send === 'function'
      ? interaction.channel
      : null;

    // If the command is being run inside the target thread, publish before
    // archiving it; archived threads may reject new messages.
    if (sameChannelAsTarget && announcementChannel) {
      try {
        announcementMessage = await announcementChannel.send({
          embeds: [announcementEmbed('正在执行锁定并关闭。')],
          allowedMentions: { parse: [] },
        });
        announcedInChannelId = announcementChannel.id;
      } catch (error) {
        announcementError = error;
      }
    }
    await executeModerationProposal(interaction.guild, proposal);
    if (announcementMessage) {
      try {
        await announcementMessage.edit({ embeds: [announcementEmbed('帖子已锁定并关闭。')], allowedMentions: { parse: [] } });
      } catch (error) {
        announcementError ||= error;
      }
    } else {
      const panelChannel = !sameChannelAsTarget ? announcementChannel : null;
      const fallbackChannel = panelChannel || (settingsFor(interaction.guildId).managementDeleteApprovalChannelId
        ? await interaction.guild.channels.fetch(settingsFor(interaction.guildId).managementDeleteApprovalChannelId).catch(() => null)
        : null);
      const logChannel = fallbackChannel?.isTextBased?.() && typeof fallbackChannel.send === 'function' ? fallbackChannel : null;
      if (logChannel) {
        try {
          await logChannel.send({ embeds: [announcementEmbed('帖子已锁定并关闭。')], allowedMentions: { parse: [] } });
          announcedInChannelId = logChannel.id;
        } catch (error) {
          announcementError ||= error;
        }
      } else if (!announcementError) {
        announcementError = new Error('当前频道和已配置的审批频道都不可发送公示。');
      }
    }
    const result = announcementError
      ? `帖子已锁定并关闭（操作编号：${proposal.id}），但公示发送失败；请检查当前频道或管理删帖审批频道的发送权限。`
      : `帖子已锁定并关闭，操作人、理由和帖子链接已在 <#${announcedInChannelId}> 公示（操作编号：${proposal.id}）。`;
    if (announcementError) logFailure('管理组锁定公示发送失败。', announcementError);
    await interaction.editReply(result);
  } catch (error) {
    // A pre-lock notice is edited to show the failure rather than leaving a
    // misleading “in progress” entry visible to the channel.
    if (announcementMessage) {
      await announcementMessage.edit({ embeds: [announcementEmbed(`锁定失败：${error.message}`)], allowedMentions: { parse: [] } }).catch((editError) => logFailure('管理组锁定失败公示更新失败。', editError));
    }
    await interaction.editReply(`锁定并关闭失败：${error.message}`);
  }
}

async function updateManagementDeleteApprovalCard(guild, proposal) {
  if (!proposal.approvalChannelId || !proposal.approvalMessageId) return false;
  const channel = await guild.channels.fetch(proposal.approvalChannelId).catch(() => null);
  const message = channel?.isTextBased?.() && proposal.approvalMessageId
    ? await channel.messages.fetch(proposal.approvalMessageId).catch(() => null)
    : null;
  if (!message) return false;
  await message.edit({
    embeds: [moderationProposalEmbed(proposal)],
    components: [],
  });
  return true;
}

function scheduleManagementDeleteConfirmation(proposal, confirmationInteraction) {
  const proposalId = proposal.id;
  const token = proposal.pendingManagementConfirmation.token;
  const guildId = proposal.guildId;
  const enableAt = proposal.pendingManagementConfirmation.confirmAfter;
  const expiresAt = proposal.pendingManagementConfirmation.expiresAt;
  const enableTimer = setTimeout(() => {
    const current = (guildData.moderationProposals || []).find((item) => item.guildId === guildId && item.id === proposalId);
    if (current?.status === 'awaiting_management_confirmation' && current.pendingManagementConfirmation?.token === token) {
      confirmationInteraction.editReply({
        content: '5 秒等待已结束。确定删除后，Bot 会立即删除整个帖子，且无法恢复。',
        components: managementDeleteConfirmationComponents(proposalId, token, false),
      }).catch((error) => logFailure('管理组删帖确认按钮启用失败。', error));
    }
  }, Math.max(0, enableAt - Date.now()));
  enableTimer.unref?.();

  const expireTimer = setTimeout(async () => {
    const current = (guildData.moderationProposals || []).find((item) => item.guildId === guildId && item.id === proposalId);
    if (current?.status !== 'awaiting_management_confirmation' || current.pendingManagementConfirmation?.token !== token) return;
    resetManagementDeleteConfirmation(current, 'expired');
    try {
      await saveGuildData();
      const guild = await client.guilds.fetch(guildId);
      await updateManagementDeleteApprovalCard(guild, current);
      await confirmationInteraction.editReply({ content: '最终确认已过期，帖子没有删除。请重新发起管理组删帖操作。', components: [] }).catch(() => {});
    } catch (error) {
      logFailure('管理组删帖确认过期清理失败。', error);
    }
  }, Math.max(0, expiresAt - Date.now()));
  expireTimer.unref?.();
}

function resetManagementDeleteConfirmation(proposal, status = 'cancelled') {
  proposal.pendingManagementConfirmation = null;
  proposal.status = status;
}

async function handleManagementDeleteVote(interaction) {
  const [, , proposalId] = interaction.customId.split(':');
  const lockKey = `${interaction.guildId}:${proposalId}`;
  if (activeManagementDeleteVotes.has(lockKey)) {
    await interaction.reply({ content: '这项审批正在处理另一张投票，请稍后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  activeManagementDeleteVotes.add(lockKey);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const proposal = (guildData.moderationProposals || []).find((item) => item.id === proposalId && item.guildId === interaction.guildId && item.kind === 'management-delete');
    if (proposal && (proposal.status === 'pending_management'
      || (proposal.status === 'awaiting_management_confirmation' && (proposal.managementVotesRequired || Array.isArray(proposal.managementVotes))))) {
      proposal.status = 'cancelled';
      proposal.failure = '旧版投票入口已停用';
      proposal.pendingManagementConfirmation = null;
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('旧版管理组删帖卡停用失败。', error));
      await interaction.message.edit({ embeds: [moderationProposalEmbed(proposal)], components: [] }).catch(() => {});
    } else {
      await interaction.message.edit({ components: [] }).catch(() => {});
    }
    await interaction.editReply('管理组删帖不再计票，旧投票按钮已停用。请重新发起 /管理删帖，由发起人直接确认。').catch(() => {});
  } catch (error) {
    logFailure('管理组删帖投票处理失败。', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`投票没有完成：${error.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `投票没有完成：${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    activeManagementDeleteVotes.delete(lockKey);
  }
}

async function handleManagementDeleteConfirmation(interaction) {
  const [action, proposalId, token] = interaction.customId.split(':');
  if (!['mgmtdelete-confirm', 'mgmtdelete-cancel'].includes(action)) {
    await interaction.reply({ content: '无效的确认操作。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const lockKey = `${interaction.guildId}:${proposalId}`;
  try { await interaction.deferUpdate(); }
  catch (error) { logFailure('管理组删帖二次确认无法应答。', error); return; }
  if (activeManagementDeleteExecutions.has(lockKey)) {
    await interaction.followUp({ content: '这项删帖正在执行，请勿重复确认。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  activeManagementDeleteExecutions.add(lockKey);
  try {
    const proposal = (guildData.moderationProposals || []).find((item) => item.id === proposalId && item.guildId === interaction.guildId && item.kind === 'management-delete');
    const pending = proposal?.pendingManagementConfirmation;
    if (!proposal || proposal.status !== 'awaiting_management_confirmation' || pending?.token !== token || pending.userId !== interaction.user.id) {
      await interaction.editReply({ content: '这项确认已取消、过期或不属于你。', components: [] }).catch(() => {});
      return;
    }
    if (Date.now() >= pending.expiresAt) {
      resetManagementDeleteConfirmation(proposal, 'expired');
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch(() => {});
      await interaction.editReply({ content: '最终确认已过期，帖子没有删除。请重新发起管理组删帖操作。', components: [] }).catch(() => {});
      return;
    }
    if (action === 'mgmtdelete-cancel') {
      resetManagementDeleteConfirmation(proposal);
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('取消最终确认后审批卡恢复失败。', error));
      await interaction.editReply({ content: '已取消，帖子没有删除。需要删除时请重新发起管理组删帖操作。', components: [] }).catch(() => {});
      return;
    }
    if (Date.now() < pending.confirmAfter) {
      await interaction.followUp({ content: '安全等待时间尚未结束，请 5 秒后再确认。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!proposal.managementRoleId || !member.roles.cache.has(proposal.managementRoleId)) {
      resetManagementDeleteConfirmation(proposal);
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch(() => {});
      await interaction.editReply({ content: '你的主管理身份组已变更，确认失效；帖子没有删除。', components: [] }).catch(() => {});
      return;
    }
    proposal.pendingManagementConfirmation = null;
    proposal.status = 'executing';
    await saveGuildData();
    await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('执行前审批卡锁定失败。', error));
    try {
      await executeModerationProposal(interaction.guild, proposal);
      proposal.status = 'completed';
    } catch (error) {
      proposal.status = 'failed';
      proposal.failure = String(error.message || '删除失败').slice(0, 300);
      logFailure('管理组删帖执行失败。', error);
    }
    await saveGuildData();
    await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('管理组删帖最终状态更新失败。', error));
    let officeNoticeFailed = false;
    try {
      const sent = await notifyManagementDeleteOffice(interaction.guild, proposal);
      officeNoticeFailed = Boolean(settingsFor(interaction.guildId).managementDeleteOfficeChannelId && !sent);
    } catch (error) {
      officeNoticeFailed = true;
      logFailure('管理组删帖结果提醒发送失败。', error);
    }
    const officeNote = officeNoticeFailed ? ' 办公室提醒发送失败，请检查管理删帖面板配置和 Bot 提及权限。' : '';
    const result = proposal.status === 'completed'
      ? `已确认并删除整个帖子（申请编号：${proposal.id}）。${officeNote}`
      : `确认已通过，但 Bot 删除失败：${proposal.failure}${officeNote}`;
    await interaction.editReply({ content: result, components: [] }).catch(() => {});
  } catch (error) {
    logFailure('管理组删帖最终确认处理失败。', error);
    await interaction.editReply({ content: `确认没有完成：${error.message}`, components: [] }).catch(() => {});
  } finally {
    activeManagementDeleteExecutions.delete(lockKey);
  }
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
      new ButtonBuilder().setCustomId(`${prefix}-companion-config:${guildId}`).setLabel('配置配套身份组').setStyle(ButtonStyle.Secondary),
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
    .setDescription(`实时名单位置：${track.channelId ? `<#${track.channelId}>` : '尚未设置'}\n任免公示子区：${track.announcementChannelId ? `<#${track.announcementChannelId}>` : '尚未创建'}\n${track.label}身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n配套身份组：${track.companionRoleId ? `<@&${track.companionRoleId}>` : '尚未设置'}\n当前任职人数：${track.terms.filter((term) => !term.endedAt && !term.isBot).length}\n\n使用上方菜单配置频道和主管理身份组；点“配置配套身份组”选择要自动发放的身份组。选择成员可批量任命或卸任。持有主管理身份组的真人成员会自动获得配套身份组，卸任时自动移除。任免记录发送到任免公示子区，实时名单位置保持不变。Bot 账号不计入名单。`);
}

function managementCompanionRolePanel(guildId) {
  const track = managementTrack(settingsFor(guildId), 'senior');
  return {
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('主管理配套身份组')
      .setDescription(`当前主管理身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n当前配套身份组：${track.companionRoleId ? `<@&${track.companionRoleId}>` : '尚未设置'}\n\n选择身份组后，Bot 会为现有主管理成员补发，并在之后自动同步。卸任或移除主管理身份组时会一并移除配套身份组。更换配套组时，会从现有主管理成员移除旧配套组。`)],
    components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId(`mgmt-companion-role:${guildId}`).setPlaceholder('选择主管理身份组的配套身份组'))],
  };
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

async function fetchManagementMemberMap(guild, memberList = null) {
  if (!memberList) throw new Error('A member collection is required for in-memory management sync.');
  const fetched = memberList;
  const entries = fetched && typeof fetched.values === 'function'
    ? [...fetched.values()]
    : Array.isArray(fetched) ? fetched : null;
  if (!entries) throw new Error('Discord 返回的成员列表格式无效，请稍后重新同步。');

  const members = await Promise.all(entries.map(async (member) => {
    if (member?.id && member.user && member.roles?.cache?.has) return member;
    if (!member?.id) return null;
    return guild.members.fetch({ user: member.id, force: true }).catch(() => null);
  }));
  const incomplete = members.filter((member) => !member?.id || !member.user || !member.roles?.cache?.has);
  if (incomplete.length) {
    throw new Error(`Discord 返回了 ${incomplete.length} 条不完整的成员数据，无法安全读取身份组；请稍后刷新成员名单。`);
  }
  return new Map(members.map((member) => [member.id, member]));
}

async function forEachGuildMemberPage(guild, visitPage) {
  let after = null;
  while (true) {
    const query = new URLSearchParams({ limit: '1000' });
    if (after) query.set('after', after);
    const page = await client.rest.get(Routes.guildMembers(guild.id), { query });
    if (!Array.isArray(page)) throw new Error('Discord returned an invalid paginated member list.');
    if (!page.length) return;
    await visitPage(page);
    const nextAfter = page.at(-1)?.user?.id;
    if (!nextAfter || nextAfter === after) throw new Error('Discord member pagination did not advance.');
    after = nextAfter;
    if (page.length < 1000) return;
  }
}

function memberHasCachedRole(member, roleId) {
  return Boolean(member?.roles?.cache?.has?.(roleId));
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

async function syncManagementCompanionRole(guild, memberList = null) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, 'senior');
  if (!track.roleId || !track.companionRoleId) return { configured: false, granted: 0, failed: 0 };
  if (track.roleId === track.companionRoleId) throw new Error('主管理身份组和配套身份组不能相同。');
  const [mainRole, companionRole, botMember] = await Promise.all([
    guild.roles.fetch(track.roleId), guild.roles.fetch(track.companionRoleId), guild.members.fetchMe(),
  ]);
  if (!mainRole || !companionRole || companionRole.managed || companionRole.id === guild.id) {
    throw new Error('主管理或配套身份组无效。');
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot 缺少“管理身份组”权限。');
  if (companionRole.position >= botMember.roles.highest.position) throw new Error('机器人身份组必须高于配套身份组。');
  let granted = 0;
  let failed = 0;
  let holders = 0;
  const syncMember = async (member) => {
    if (!member?.user || member.user.bot || !memberHasCachedRole(member, mainRole.id)) return;
    holders += 1;
    if (memberHasCachedRole(member, companionRole.id)) return;
    try {
      await member.roles.add(companionRole, '自动同步主管理配套身份组');
      granted += 1;
    } catch (error) {
      failed += 1;
      logFailure(`无法向成员 ${member.id} 发放主管理配套身份组。`, error);
    }
  };
  if (memberList) {
    const members = await fetchManagementMemberMap(guild, memberList);
    for (const member of members.values()) await syncMember(member);
  } else {
    await forEachGuildMemberPage(guild, async (page) => {
      for (const data of page) {
        const user = data?.user;
        if (!user?.id || user.bot || !data.roles?.includes(mainRole.id)) continue;
        if (data.roles.includes(companionRole.id)) {
          holders += 1;
          continue;
        }
        try {
          const member = await guild.members.fetch({ user: user.id, force: true, cache: false });
          await syncMember(member);
        } catch (error) {
          failed += 1;
          logFailure(`无法读取成员 ${user.id} 并发放主管理配套身份组。`, error);
        }
      }
    });
  }
  return { configured: true, granted, failed, holders };
}

async function setManagementCompanionRole(member) {
  if (member.user.bot) return false;
  const track = managementTrack(settingsFor(member.guild.id), 'senior');
  if (!track.roleId || !track.companionRoleId || track.roleId === track.companionRoleId) return false;
  const mainRolePresent = member.roles.cache.has(track.roleId);
  const shouldHave = mainRolePresent;
  const role = await member.guild.roles.fetch(track.companionRoleId);
  if (!role || role.managed || role.id === member.guild.id) throw new Error('配套身份组无效。');
  const botMember = await member.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot 缺少“管理身份组”权限。');
  if (role.position >= botMember.roles.highest.position) throw new Error('机器人身份组必须高于配套身份组。');
  const currentlyHas = member.roles.cache.has(role.id);
  if (shouldHave && !currentlyHas) {
    await member.roles.add(role, '自动同步主管理配套身份组');
    return true;
  }
  if (!shouldHave && currentlyHas) {
    await member.roles.remove(role, '主管理身份组已移除，同步移除配套身份组');
    return true;
  }
  return false;
}

async function syncManagementRole(guild, tier = 'senior', memberList = null, roleId = null) {
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  if (!track.roleId || !track.channelId) return false;
  const role = await guild.roles.fetch(track.roleId);
  if (!role) return false;
  // Requires the privileged Server Members Intent in the Developer Portal.
  let members;
  let presentIds;
  if (memberList) {
    members = await fetchManagementMemberMap(guild, memberList);
    presentIds = new Set([...members.values()]
      .filter((member) => !member.user.bot && memberHasCachedRole(member, role.id))
      .map((member) => member.id));
  } else {
    const trackedIds = new Set(track.terms.filter((term) => !term.endedAt && !term.isBot).map((term) => term.userId));
    members = new Map();
    presentIds = new Set();
    await forEachGuildMemberPage(guild, async (page) => {
      for (const data of page) {
        const userId = data?.user?.id;
        if (!userId) continue;
        const hasRole = data.roles?.includes(role.id) || false;
        if (hasRole && !data.user.bot) presentIds.add(userId);
        if (hasRole || trackedIds.has(userId)) members.set(userId, { id: userId, user: { bot: Boolean(data.user.bot) } });
      }
    });
  }
  if (tier === 'senior' && track.companionRoleId) {
    await syncManagementCompanionRole(guild, memberList || undefined).catch((error) => logFailure('主管理配套身份组同步失败。', error));
  }
  const now = Date.now();
  const terms = track.terms;
  const activeTerms = terms.filter((term) => !term.endedAt && !term.isBot);
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
  if (tier === 'senior' && track.roleId && track.companionRoleId) {
    await setManagementCompanionRole(member).catch((error) => logFailure(`成员 ${member.id} 的主管理配套身份组同步失败。`, error));
  }
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
    reconcileManagementMember(member, hasRole, tier, roleId).catch((error) => logFailure(`${managementTrack(settingsFor(member.guild.id), tier, roleId).label}成员同步失败。`, error));
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
    logFailure(`${track.label}任免公示子区不可用，将尝试现有公示位置。`, error);
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
  let companionRole = null;
  if (tier === 'senior' && track.companionRoleId) {
    companionRole = await guild.roles.fetch(track.companionRoleId);
    if (!companionRole || companionRole.managed || companionRole.id === guild.id || companionRole.id === role.id) {
      throw new Error('主管理配套身份组无效，或与主管理身份组相同。');
    }
    if (companionRole.position >= botMember.roles.highest.position) throw new Error('机器人身份组必须高于配套身份组。');
  }
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
      const addRoles = [role, companionRole].filter((targetRole) => targetRole && !member.roles.cache.has(targetRole.id));
      if (addRoles.length) await member.roles.add(addRoles, `管理组任命：${reason || '未填写理由'}`);
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
    const removeRoles = [role, companionRole].filter((targetRole) => targetRole && member.roles.cache.has(targetRole.id));
    if (removeRoles.length) await member.roles.remove(removeRoles, `管理组卸任：${reason || '未填写理由'}`);
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
      console.log('A long timeout schedule ended.');
      continue;
    }
    try {
      const guild = await client.guilds.fetch(job.guildId);
      const member = await guild.members.fetch(job.userId);
      if (job.nextRefreshAt <= now) {
        const until = Math.min(job.endAt, now + TIMEOUT_REFRESH);
        await member.timeout(until - now, job.reason || 'Scheduled long timeout refresh');
        job.nextRefreshAt = until >= job.endAt ? job.endAt : until - DAY;
        console.log('A long timeout schedule was refreshed.');
      }
      active.push(job);
    } catch (error) {
      // A departed member or removed bot permission should not prevent other schedules from running.
      logFailure('Could not refresh a long timeout.', error);
      active.push(job);
    }
  }
  longTimeouts = active;
  await saveTimeouts();
}

function hasPermission(interaction, permission) {
  return interaction.memberPermissions?.has(permission) || false;
}

function isConfiguredManagementMember(interaction) {
  if (!interaction.guildId) return false;
  const setting = settingsFor(interaction.guildId);
  const managementRoleIds = new Set([
    managementTrack(setting, 'senior').roleId,
    ...Object.keys(setting.middleManagementGroups || {}),
  ].filter(Boolean));
  const memberRoleCache = interaction.member?.roles?.cache;
  const memberRoleIds = memberRoleCache?.keys
    ? new Set(memberRoleCache.keys())
    : new Set(Array.isArray(interaction.member?.roles) ? interaction.member.roles : []);
  return [...managementRoleIds].some((roleId) => memberRoleIds.has(roleId));
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});
let readyWatchdog;
client.on('shardError', (error) => logFailure('Discord 网关连接错误。', error));
client.on('shardConnecting', () => console.log('正在连接 Discord 实时网关……'));
client.on('shardDisconnect', (event, shardId) => {
  console.error(`Discord 网关已断开（错误代码 ${event.code}）。`);
});
client.on('error', (error) => logFailure('Discord 客户端错误。', error));
client.on('messageReactionAdd', async (incomingReaction, user) => {
  if (user.id === client.user?.id || user.bot) return;
  try {
    const reaction = incomingReaction.partial ? await incomingReaction.fetch() : incomingReaction;
    let message = reaction.message;
    if (message.partial) message = await message.fetch();
    const guildId = message.guildId;
    if (!guildId) return;
    const setting = guildData.settings[guildId];
    if (!setting?.reactionDeleteUserIds?.includes(message.author?.id)) return;
    if (!(setting.reactionDeleteEmojiKeys || []).includes(reactionEmojiKey(reaction))) return;

    const guild = message.guild || await client.guilds.fetch(guildId);
    const botMember = await guild.members.fetchMe();
    if (!message.channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
      logFailure('表情反应符合清理规则，但 Bot 缺少“管理消息”权限。');
      return;
    }
    const cleanupKey = `${message.channelId}:${message.id}:${reactionEmojiKey(reaction)}`;
    if (activeReactionCleanups.has(cleanupKey)) return;
    activeReactionCleanups.add(cleanupKey);
    try {
      await reaction.remove();
      console.log('已按服务器规则移除指定成员消息上的表情反应。');
    } finally {
      activeReactionCleanups.delete(cleanupKey);
    }
  } catch (error) {
    logFailure('自动清理消息表情反应失败。', error);
  }
});
client.once('clientReady', async () => {
  clearTimeout(readyWatchdog);
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await loadPlatformStorage();
    storageReady = true;
  } catch (error) {
    logFailure('Discord 私密存储初始化失败；为避免使用空数据覆盖记录，机器人不会处理指令。', error);
    client.destroy();
    process.exit(1);
    return;
  }
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
    if (!tracks.length && !(seniorTrack.roleId && seniorTrack.companionRoleId)) continue;
    for (const [tier, roleId] of tracks) {
      const track = managementTrack(setting, tier, roleId);
      await syncManagementRole(guild, tier, null, roleId).catch((error) => {
        logFailure(`${track.label}成员读取失败。请在 Developer Portal 开启 Server Members Intent。`, error);
      });
    }
    if (seniorTrack.roleId && seniorTrack.companionRoleId && !tracks.some(([tier]) => tier === 'senior')) {
      await syncManagementCompanionRole(guild).catch((error) => logFailure('主管理配套身份组同步失败。', error));
    }
  }
  setInterval(() => reconcileLongTimeouts().catch((error) => logFailure('Timeout scheduler failed.', error)), 60 * 1000);
  await processSchedules().catch((error) => logFailure('Schedule startup processing failed.', error));
  setInterval(() => processSchedules().catch((error) => logFailure('Schedule processing failed.', error)), 1000);
});
client.on('guildMemberUpdate', (oldMember, newMember) => {
  const setting = guildData.settings[newMember.guild.id];
  if (!setting) return;
  const seniorRoleId = managementTrack(setting, 'senior').roleId;
  const seniorTrack = managementTrack(setting, 'senior');
  const seniorChanged = seniorRoleId && oldMember.roles.cache.has(seniorRoleId) !== newMember.roles.cache.has(seniorRoleId);
  const companionChanged = seniorTrack.companionRoleId
    && oldMember.roles.cache.has(seniorTrack.companionRoleId) !== newMember.roles.cache.has(seniorTrack.companionRoleId);
  if (seniorRoleId && (seniorChanged || companionChanged)) {
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
  if (!storageReady) {
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '机器人正在连接私密存储，请稍后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  console.log(`收到 Discord 交互：${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.isButton() ? '按钮' : interaction.isModalSubmit() ? '表单' : interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu() ? '菜单' : '交互'}（交互 ID ${interaction.id}，PID ${process.pid}）`);
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
      logFailure('管理组理由提交失败。', error);
      await interaction.editReply(`操作未完成：${error.message}`);
    }
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modcfg-office-id:')) {
    const [, guildId, panelChannelId, panelMessageId] = interaction.customId.split(':');
    if (!interaction.inGuild() || guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有本服务器管理员可以配置办公室频道。', flags: MessageFlags.Ephemeral });
      return;
    }
    const input = interaction.fields.getTextInputValue('channel-id').trim();
    const match = input.match(/^(?:<#)?(\d{17,20})>?$/);
    if (!match) { await interaction.reply({ content: '请输入有效的本服务器频道 ID，或粘贴频道提及（<#频道ID>）。', flags: MessageFlags.Ephemeral }); return; }
    const channel = await interaction.guild.channels.fetch(match[1]).catch(() => null);
    const botMember = await interaction.guild.members.fetchMe();
    const perms = channel && channel.permissionsFor(botMember);
    if (!channel || channel.guildId !== guildId || !channel.isTextBased() || !channel.send || !perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await interaction.reply({ content: '该频道无效，或 Bot 缺少查看和发送消息权限。', flags: MessageFlags.Ephemeral });
      return;
    }
    settingsFor(guildId).moderationOfficeChannelId = channel.id;
    await saveGuildData();
    const panelChannel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
    const panelMessage = panelChannel && panelChannel.isTextBased() ? await panelChannel.messages.fetch(panelMessageId).catch(() => null) : null;
    if (panelMessage) await panelMessage.edit({ embeds: [moderationApprovalPanelEmbed(guildId)], components: moderationApprovalPanel(guildId) }).catch(() => {});
    await interaction.reply({ content: '办公室通知频道已设置为 <#' + channel.id + '>。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modcfg-counts:')) {
    const guildId = interaction.customId.split(':')[1];
    if (!interaction.inGuild() || guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有本服务器管理员可以配置审批门槛。', flags: MessageFlags.Ephemeral });
      return;
    }
    const threadCount = Number(interaction.fields.getTextInputValue('thread-count'));
    const deleteCount = Number(interaction.fields.getTextInputValue('delete-count'));
    const reviewerCount = Number(interaction.fields.getTextInputValue('reviewer-count'));
    if (![threadCount, deleteCount, reviewerCount].every((value) => Number.isInteger(value) && value >= 1 && value <= 25)) {
      await interaction.reply({ content: '同意票数必须是 1 到 25 的整数。', flags: MessageFlags.Ephemeral });
      return;
    }
    const setting = settingsFor(guildId);
    setting.threadOperatorVotesRequired = threadCount;
    setting.deleteOperatorVotesRequired = deleteCount;
    setting.moderationReviewerVotesRequired = reviewerCount;
    await saveGuildData();
    await interaction.reply({ content: '审批同意票数已保存。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('reactclean-emoji:')) {
    const [, guildId, channelId, messageId] = interaction.customId.split(':');
    if (!interaction.inGuild() || guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有本服务器管理员可以配置表情反应清理。', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const emojiKeys = parseReactionEmojiKeys(interaction.fields.getTextInputValue('emoji-list'));
      const setting = settingsFor(guildId);
      setting.reactionDeleteEmojiKeys = emojiKeys;
      await saveGuildData();
      const panelChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      const panelMessage = panelChannel?.isTextBased() ? await panelChannel.messages.fetch(messageId).catch(() => null) : null;
      if (panelMessage) await panelMessage.edit({ embeds: [reactionCleanupPanelEmbed(guildId)], components: reactionCleanupPanel(guildId) });
      await interaction.editReply(`已配置 ${emojiKeys.length} 个要移除的表情反应。只会移除匹配的那种表情，消息上的其他表情和消息本身都会保留。`);
    } catch (error) {
      await interaction.editReply(`表情设置未保存：${error.message}`);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('mgmtdelete-vote:') && interaction.inGuild()) {
    await handleManagementDeleteVote(interaction);
    return;
  }
  if (interaction.isButton()
    && (interaction.customId.startsWith('mgmtdelete-confirm:') || interaction.customId.startsWith('mgmtdelete-cancel:'))
    && interaction.inGuild()) {
    await handleManagementDeleteConfirmation(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('modvote:') && interaction.inGuild()) {
    const [, stage, choice, proposalId] = interaction.customId.split(':');
    const proposal = (guildData.moderationProposals || []).find((item) => item.id === proposalId && item.guildId === interaction.guildId);
    try { await interaction.deferUpdate(); } catch (error) { logFailure('审批投票交互无法应答。', error); return; }
    if (!proposal || proposal.status !== (stage === 'reviewer' ? 'pending_reviewer' : 'pending_operator')) {
      await interaction.followUp({ content: '这项审批已处理、已过期或当前不在这个审批阶段。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (Date.now() - proposal.createdAt > MODERATION_PROPOSAL_TTL) {
      proposal.status = 'expired';
      await saveGuildData();
      await interaction.message.edit({ embeds: [moderationProposalEmbed(proposal)], components: [] }).catch(() => {});
      await interaction.followUp({ content: '这项审批已超过 24 小时，不能再投票。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (interaction.user.id === proposal.requesterId) {
      await interaction.followUp({ content: stage === 'operator' ? '申请人已自动计作 1 张操作员同意票，不能重复投票。' : '申请人不能参与自己删除申请的审核员投票。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const setting = settingsFor(interaction.guildId);
    const authorized = stage === 'operator'
      ? memberHasAnyRole(member, setting.moderationOperatorRoleIds || [])
      : Boolean(setting.moderationReviewerRoleId && member.roles.cache.has(setting.moderationReviewerRoleId));
    if (!authorized) {
      await interaction.followUp({ content: stage === 'operator' ? '你不在已配置的操作员身份组内。' : '你不在已配置的审核员身份组内。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const votesKey = stage === 'reviewer' ? 'reviewerVotes' : 'operatorVotes';
    proposal[votesKey] ||= [];
    if (proposal[votesKey].some((vote) => vote.userId === interaction.user.id)) {
      await interaction.followUp({ content: '你已经在这个阶段投过票。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    proposal[votesKey].push({ userId: interaction.user.id, choice, votedAt: Date.now() });
    let execute = false;
    let notifyReviewers = false;
    if (choice === 'no') proposal.status = 'rejected';
    else if (stage === 'operator' && proposal.operatorVotes.filter((vote) => vote.choice === 'yes').length >= proposal.operatorVotesRequired) {
      if (proposal.kind === 'thread-action') {
        execute = true;
        proposal.status = 'executing';
      }
      else {
        proposal.status = 'pending_reviewer';
        notifyReviewers = true;
      }
    } else if (stage === 'reviewer' && proposal.reviewerVotes.filter((vote) => vote.choice === 'yes').length >= proposal.reviewerVotesRequired) {
      execute = true;
      proposal.status = 'executing';
    }
    await saveGuildData();
    if (notifyReviewers && setting.moderationReviewerRoleId) {
      await notifyModerationOffice(interaction.guild, proposal, [setting.moderationReviewerRoleId], '删除申请审核阶段');
      const approvalChannel = await interaction.guild.channels.fetch(proposal.approvalChannelId).catch(() => null);
      if (approvalChannel?.isTextBased?.() && approvalChannel.send) {
      await approvalChannel.send({ content: `<@&${setting.moderationReviewerRoleId}> 删除申请已通过操作员阶段，请前往审批卡投票：https://discord.com/channels/${proposal.guildId}/${proposal.approvalChannelId}/${proposal.approvalMessageId}（编号：${proposal.id}）。`, allowedMentions: { parse: [], roles: [setting.moderationReviewerRoleId] } }).catch((error) => logFailure('审核员阶段提及发送失败。', error));
      }
    }
    if (execute) {
      await interaction.message.edit({ embeds: [moderationProposalEmbed(proposal)], components: [] }).catch(() => {});
      try {
        await executeModerationProposal(interaction.guild, proposal);
        proposal.status = 'completed';
      } catch (error) {
        proposal.status = 'failed';
        proposal.failure = String(error.message || '操作失败').slice(0, 300);
        logFailure('审批通过后的版务操作执行失败。', error);
      }
      await saveGuildData();
    }
    await interaction.message.edit({ embeds: [moderationProposalEmbed(proposal)], components: proposal.status === 'pending_operator' || proposal.status === 'pending_reviewer' ? moderationVoteComponents(proposal) : [] }).catch((error) => logFailure('审批消息更新失败。', error));
    if (proposal.status === 'failed') await interaction.followUp({ content: `审批已通过，但 Bot 执行操作失败：${proposal.failure}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    else if (proposal.status === 'completed') await interaction.followUp({ content: '审批通过，已执行对应操作。', flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.followUp({ content: proposal.status === 'rejected' ? '申请已被拒绝。' : '投票已记录。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.isButton() && (interaction.customId.startsWith('punishment-confirm:') || interaction.customId.startsWith('punishment-cancel:'))) {
    const [action, token] = interaction.customId.split(':');
    try {
      await interaction.deferUpdate();
    } catch (error) {
      logFailure('处罚确认交互无法应答，未执行本次操作。', error);
      return;
    }
    await interaction.editReply({ components: [] }).catch((error) => logFailure('处罚确认面板无法立即锁定；服务端确认编号仍会阻止重复执行。', error));
    let pending = await readPendingPunishment(token).catch((error) => { logFailure('读取待确认处罚失败。', error); return null; });
    let recoveredFromMessage = false;
    if (!pending) {
      pending = recoverPunishmentFromConfirmationMessage(interaction);
      recoveredFromMessage = Boolean(pending);
      if (pending) console.warn('待确认处罚的存储记录不存在，已从确认消息恢复。');
    }
    if (!pending) {
      pendingPunishments.delete(token);
      console.error('待确认处罚无法恢复；尚未执行处罚。');
      await interaction.editReply({ content: '找不到这张处罚确认卡对应的数据，尚未执行处罚。请重新运行 `/处罚`；若再次出现，请检查是否有多个不同目录中的 Bot 实例。', embeds: [], components: [] });
      return;
    }
      if (pending.moderatorId && pending.moderatorId !== interaction.user.id) {
        await interaction.editReply({ content: '这张处罚确认卡只能由发起命令的人操作。', embeds: [], components: [] });
        return;
      }
      if (!isConfiguredManagementMember(interaction)) {
        await interaction.editReply({ content: '您不具备该权限。', embeds: [], components: [] });
        return;
      }
      if (pending.guildId !== interaction.guildId) {
      await interaction.editReply({ content: '处罚确认卡与当前服务器不匹配，尚未执行处罚。', embeds: [], components: [] });
      return;
    }
    if (Date.now() - pending.createdAt >= PUNISHMENT_CONFIRM_TTL) {
      pendingPunishments.delete(token);
      delete pendingPunishmentRecords[token];
      await savePlatformStorage();
      await interaction.editReply({ content: '这次处罚确认已超过 1 分钟，请重新运行 `/处罚`。', embeds: [], components: [] });
      return;
    }
    let claim;
    try { claim = await claimPendingPunishment(token, recoveredFromMessage ? pending : null); }
    catch (error) {
      logFailure('处罚确认锁定未能保存；本次没有执行处罚。', error);
      await interaction.editReply({ content: '无法安全锁定这张确认卡，因此没有执行处罚。请重新运行 `/处罚` 或 `/永封`。', embeds: [], components: [] }).catch(() => {});
      return;
    }
    if (!claim) {
      pendingPunishments.delete(token);
      const busy = pending && activePunishmentLocks.has(pending.userId);
      await interaction.editReply({ content: busy ? '这个目标正在执行另一笔处罚，本确认卡已锁定；请稍后重新运行 `/处罚` 或 `/永封`。' : '这次处罚确认已处理，请重新运行 `/处罚` 或 `/永封`。', embeds: [], components: [] });
      return;
    }
    const claimedRequest = claim.request;
    pendingPunishments.delete(token);
    if (action === 'punishment-cancel') {
      claimedPunishments.delete(token);
      activePunishmentLocks.delete(claimedRequest.userId);
      await interaction.editReply({ content: '已取消处罚，没有执行任何操作。', embeds: [], components: [] });
      return;
    }
    try {
      const summary = await executePunishmentRequest(interaction, claimedRequest, true);
      await interaction.editReply({ content: summary, embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
      logFailure('/处罚 确认执行失败。', error);
      await interaction.editReply({ content: `处罚未能执行：${error.message}`, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
    } finally {
      claimedPunishments.delete(token);
    }
    return;
  }
  if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isButton()) {
    if (interaction.customId.startsWith('reactclean-') && interaction.inGuild()) {
      const [action, guildId] = interaction.customId.split(':');
      if (guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '只有本服务器管理员可以配置表情反应清理。', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const setting = settingsFor(guildId);
      try {
        if (action === 'reactclean-emoji' && interaction.isButton()) {
          const modal = new ModalBuilder()
            .setCustomId(`reactclean-emoji:${guildId}:${interaction.channelId}:${interaction.message.id}`)
            .setTitle('设置要清理的表情')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
              .setCustomId('emoji-list').setLabel('表情（可填多个，用逗号或空格分隔）')
              .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
              .setPlaceholder('例如：😂 🧹 或 <:表情名:表情ID>')));
          await interaction.showModal(modal);
          return;
        }
        await interaction.deferUpdate();
        if (action === 'reactclean-users' && interaction.isUserSelectMenu()) {
          const members = await Promise.all(interaction.values.map((id) => interaction.guild.members.fetch(id).catch(() => null)));
          if (members.some((member) => !member || member.user.bot)) {
            await interaction.followUp({ content: '监控名单只能选择本服务器中的真人成员。', flags: MessageFlags.Ephemeral });
            return;
          }
          setting.reactionDeleteUserIds = [...new Set(members.map((member) => member.id))];
        } else if (action === 'reactclean-clear-users' && interaction.isButton()) {
          setting.reactionDeleteUserIds = [];
        } else if (action === 'reactclean-clear-emojis' && interaction.isButton()) {
          setting.reactionDeleteEmojiKeys = [];
        } else return;
        await saveGuildData();
        try {
          await interaction.message.edit({ embeds: [reactionCleanupPanelEmbed(guildId)], components: reactionCleanupPanel(guildId) });
        } catch (error) {
          if (error.code !== 10008) throw error;
          const channel = interaction.channel;
          if (!channel?.isTextBased() || typeof channel.send !== 'function') throw error;
          await channel.send({ embeds: [reactionCleanupPanelEmbed(guildId)], components: reactionCleanupPanel(guildId) });
          await interaction.followUp({ content: '设置已保存。原面板消息已失效，我已在当前频道/子区重新发送面板。', flags: MessageFlags.Ephemeral });
        }
      } catch (error) {
        logFailure('表情反应清理面板操作失败。', error);
        await interaction.followUp({ content: `设置未保存：${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if ((interaction.customId.startsWith('modcfg-')) && interaction.inGuild()) {
      const [action, guildId] = interaction.customId.split(':');
      if (guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '只有本服务器管理员可以配置版务审批。', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const setting = settingsFor(guildId);
      try {
        if (action === 'modcfg-office' && interaction.isButton()) {
          const modal = new ModalBuilder().setCustomId('modcfg-office-id:' + guildId + ':' + interaction.channelId + ':' + interaction.message.id).setTitle('设置办公室通知频道')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel-id').setLabel('频道 ID 或频道提及').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setPlaceholder('例如：123456789012345678 或 <#123456789012345678>')));
          await interaction.showModal(modal);
          return;
        }
        if (action === 'modcfg-counts' && interaction.isButton()) {
          const modal = new ModalBuilder().setCustomId(`modcfg-counts:${guildId}`).setTitle('设置审批同意票数')
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thread-count').setLabel('帖子操作员同意票数').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(setting.threadOperatorVotesRequired || 2))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('delete-count').setLabel('删除操作员同意票数').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(setting.deleteOperatorVotesRequired || 2))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reviewer-count').setLabel('删除审核员阶段同意票数').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(setting.moderationReviewerVotesRequired || 2))),
            );
          await interaction.showModal(modal);
          return;
        }
        await interaction.deferUpdate();
        if (action === 'modcfg-channel' && interaction.isChannelSelectMenu()) {
          const [channel, botMember] = await Promise.all([
            interaction.guild.channels.fetch(interaction.values[0]),
            interaction.guild.members.fetchMe(),
          ]);
          const perms = channel?.permissionsFor(botMember);
          if (!channel || channel.guildId !== guildId || !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('审批频道必须属于本服务器，并允许 Bot 查看、发送消息和嵌入链接。');
          setting.moderationApprovalChannelId = channel.id;
        } else if (action === 'modcfg-operators' && interaction.isRoleSelectMenu()) {
          setting.moderationOperatorRoleIds = [...new Set(interaction.values)];
        } else if (action === 'modcfg-reviewer' && interaction.isRoleSelectMenu()) {
          setting.moderationReviewerRoleId = interaction.values[0];
        } else if (action === 'modcfg-clear' && interaction.isButton()) {
          setting.moderationApprovalChannelId = null;
        } else if (action === 'modcfg-office-clear' && interaction.isButton()) {
          setting.moderationOfficeChannelId = null;
        } else return;
        await saveGuildData();
        await interaction.message.edit({ embeds: [moderationApprovalPanelEmbed(guildId)], components: moderationApprovalPanel(guildId) });
      } catch (error) {
        logFailure('版务审批面板操作失败。', error);
        await interaction.followUp({ content: `设置未保存：${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (interaction.customId.startsWith('mgmtdeletecfg-') && interaction.inGuild()) {
      const [action, guildId] = interaction.customId.split(':');
      if (guildId !== interaction.guildId || !hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '只有本服务器管理员可以配置管理组删帖面板。', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const setting = settingsFor(guildId);
      try {
        await interaction.deferUpdate();
        if ((action === 'mgmtdeletecfg-approval' || action === 'mgmtdeletecfg-office') && interaction.isChannelSelectMenu()) {
          const [channel, botMember] = await Promise.all([
            interaction.guild.channels.fetch(interaction.values[0]),
            interaction.guild.members.fetchMe(),
          ]);
          const permissions = channel?.permissionsFor(botMember);
          const required = action === 'mgmtdeletecfg-approval'
            ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
            : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
          if (!channel || channel.guildId !== guildId || !channel.isTextBased() || !permissions?.has(required)) {
            throw new Error(action === 'mgmtdeletecfg-approval'
              ? '审批频道必须属于本服务器，并允许 Bot 查看、发送消息和嵌入链接。'
              : '办公室频道必须属于本服务器，并允许 Bot 查看和发送消息。');
          }
          if (action === 'mgmtdeletecfg-approval') setting.managementDeleteApprovalChannelId = channel.id;
          else setting.managementDeleteOfficeChannelId = channel.id;
        } else if (action === 'mgmtdeletecfg-clear-approval' && interaction.isButton()) {
          setting.managementDeleteApprovalChannelId = null;
        } else if (action === 'mgmtdeletecfg-clear-office' && interaction.isButton()) {
          setting.managementDeleteOfficeChannelId = null;
        } else return;
        await saveGuildData();
        await interaction.message.edit({ embeds: [managementDeletePanelEmbed(guildId)], components: managementDeletePanel(guildId) });
      } catch (error) {
        logFailure('管理组删帖面板操作失败。', error);
        await interaction.followUp({ content: `设置未保存：${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
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
        if (action === 'mgmt-companion-config' && interaction.isButton() && tier === 'senior') {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能配置配套身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferUpdate();
          await interaction.followUp({ ...managementCompanionRolePanel(guildId), flags: MessageFlags.Ephemeral });
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
        if (action === 'mgmt-companion-role' && interaction.isRoleSelectMenu() && tier === 'senior') {
          const setting = settingsFor(guildId);
          const track = managementTrack(setting, 'senior');
          const role = await interaction.guild.roles.fetch(interaction.values[0]);
          const botMember = await interaction.guild.members.fetchMe();
          if (!track.roleId) {
            await interaction.followUp({ content: '请先配置主管理身份组，再选择配套身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          if (!role || role.id === guildId || role.managed || role.id === track.roleId || role.position >= botMember.roles.highest.position) {
            await interaction.followUp({ content: '请选择与主管理身份组不同的普通身份组，并确认机器人身份组高于它。', flags: MessageFlags.Ephemeral });
            return;
          }
          const previousRoleId = track.companionRoleId;
          setting.managementCompanionRoleId = role.id;
          await saveGuildData();
          let summary;
          try {
            let removedPrevious = 0;
            let failedPrevious = 0;
            if (previousRoleId && previousRoleId !== role.id) {
              const previousRole = await interaction.guild.roles.fetch(previousRoleId).catch(() => null);
              if (previousRole && !previousRole.managed && previousRole.position < botMember.roles.highest.position) {
                await forEachGuildMemberPage(interaction.guild, async (page) => {
                  for (const data of page) {
                    const user = data?.user;
                    if (!user?.id || user.bot || !data.roles?.includes(track.roleId) || !data.roles.includes(previousRole.id)) continue;
                    try {
                      const member = await interaction.guild.members.fetch({ user: user.id, force: true, cache: false });
                      await member.roles.remove(previousRole, '更换主管理配套身份组');
                      removedPrevious += 1;
                    } catch (error) {
                      failedPrevious += 1;
                      logFailure(`无法移除成员 ${user.id} 的旧主管理配套身份组。`, error);
                    }
                  }
                });
              }
            }
            summary = await syncManagementCompanionRole(interaction.guild);
            summary.removedPrevious = removedPrevious;
            summary.failedPrevious = failedPrevious;
          } catch (error) {
            logFailure('主管理配套身份组同步失败。', error);
            summary = { configured: true, granted: 0, failed: 0, removedPrevious: 0, failedPrevious: 0, error: error.message };
          }
          await interaction.editReply(managementCompanionRolePanel(guildId));
          const resultText = summary.error
            ? `设置已保存，但成员补发未完成：${summary.error}`
            : `设置已保存：当前持有主管理身份组的真人中补发 ${summary.granted} 人，失败 ${summary.failed} 人。${summary.removedPrevious ? `已从 ${summary.removedPrevious} 人移除旧配套身份组。` : ''}${summary.failedPrevious ? `移除旧身份组失败 ${summary.failedPrevious} 人。` : ''}`;
          await interaction.followUp({ content: resultText, flags: MessageFlags.Ephemeral });
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
          if (tier === 'senior' && setting.managementCompanionRoleId === role.id) {
            await interaction.followUp({ content: '主管理身份组不能与当前配套身份组相同，请先改配套组或选择另一个主管理身份组。', flags: MessageFlags.Ephemeral });
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
        logFailure('管理组面板操作失败。', error);
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
      logFailure('处罚面板交互失败。', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '设置没有保存，请检查频道和 Bot 权限后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.followUp({ content: '设置没有保存，请检查频道和 Bot 权限后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }
  const messageCommand = interaction.isMessageContextMenuCommand()
    && ['处罚', '永封', '删帖', '锁定并关闭', '管理删帖', '管理锁定', '解锁'].includes(interaction.commandName);
  const userCommand = interaction.isUserContextMenuCommand()
    && ['处罚', '永封'].includes(interaction.commandName);
  const punishmentForm = interaction.isModalSubmit()
    && interaction.customId.startsWith('message-punish:');
  const managementLockReasonForm = interaction.isModalSubmit()
    && interaction.customId.startsWith('management-lock-reason:');
  if (managementLockReasonForm) {
    const token = interaction.customId.slice('management-lock-reason:'.length);
    const pending = pendingManagementLockForms.get(token);
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (!pending || pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId || Date.now() >= pending.expiresAt) {
      pendingManagementLockForms.delete(token);
      await interaction.reply({ content: '此锁帖表单已过期或不属于你，请重新发起「管理锁定」。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (!reason) {
      await interaction.reply({ content: '请填写锁定理由。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    pendingManagementLockForms.delete(token);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await executeManagementThreadLock(interaction, pending.link, reason);
    } catch (error) {
      logFailure('管理组锁定理由表单处理失败。', error);
      const message = `锁定并关闭失败：${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  const managementLockInitiation = (messageCommand && interaction.commandName === '管理锁定')
    || (interaction.isChatInputCommand() && interaction.commandName === '管理锁定');
  if (managementLockInitiation) {
    const link = messageCommand ? interaction.targetMessage.url : interaction.options.getString('链接', true).trim();
    try {
      await showManagementLockReasonModal(interaction, link);
    } catch (error) {
      logFailure('管理组锁定理由面板打开失败。', error);
      const message = `无法打开锁帖理由面板：${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (!interaction.isChatInputCommand() && !messageCommand && !userCommand && !punishmentForm) return;
  let commandName = interaction.commandName;
  let options = interaction.options;
  try {
    if ((messageCommand || userCommand) && ['处罚', '永封'].includes(commandName)) {
      if (!isConfiguredManagementMember(interaction)) {
        await interaction.reply({ content: '您不具备该权限。', flags: MessageFlags.Ephemeral });
        return;
      }
      const ban = commandName === '永封';
      const targetUserId = userCommand ? interaction.targetUser.id : interaction.targetMessage.author.id;
      const modal = new ModalBuilder()
        .setCustomId(`message-punish:${ban ? 'ban' : 'punish'}:${targetUserId}:${interaction.user.id}`)
        .setTitle(`${commandName}${userCommand ? '成员' : '消息作者'}`);
      const field = (id, label, required, max, value) => {
        const input = new TextInputBuilder().setCustomId(id)
          .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);
        if (value) input.setValue(value);
        return new LabelBuilder().setLabel(label).setTextInputComponent(input);
      };
      modal.addComponents(field('reason', '原因', true, 400));
      if (!ban) modal.addComponents(
        new LabelBuilder().setLabel('方式').setDescription('请选择一种处罚方式')
          .setStringSelectMenuComponent(new StringSelectMenuBuilder()
            .setCustomId('mode').setPlaceholder('请选择处罚方式').setRequired(true)
            .addOptions(
              { label: '仅警告', value: 'warning' },
              { label: '仅禁言', value: 'timeout' },
              { label: '警告并禁言', value: 'both' },
            )),
        field('timeout', '禁言天数（1–90；有禁言时必填）', false, 2),
        field('warning', '警告天数（1–90；留空不自动移除）', false, 2));
      await interaction.showModal(modal);
      return;
    }
    // Each command interaction is acknowledged immediately. discord.js invokes
    // this async listener independently for every interaction, so slow API work
    // below does not put other commands into a shared queue.
    if (interaction.commandName !== '处罚面板') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    if (!interaction.inGuild()) {
      await interaction.editReply({ content: '此指令只能在服务器内使用。', allowedMentions: { parse: [] } });
      return;
    }

    // Route all entry points through the same authorization, confirmation and approval code.
    let values;
    if (punishmentForm) {
      const match = interaction.customId.match(/^message-punish:(ban|punish):(\d{17,20}):(\d{17,20})$/);
      if (!match || match[3] !== interaction.user.id) {
        await interaction.editReply('此表单不属于你，请重新从消息菜单发起。');
        return;
      }
      commandName = match[1] === 'ban' ? '永封' : '处罚';
      values = { user_id: match[2], 原因: interaction.fields.getTextInputValue('reason').trim() };
      if (!values.原因) { await interaction.editReply('请填写处罚原因。'); return; }
      if (commandName === '处罚') {
        values.方式 = interaction.fields.getStringSelectValues('mode')[0];
        if (!values.方式) { await interaction.editReply('处罚方式请填写：仅警告、仅禁言或警告并禁言。'); return; }
        for (const [id, name] of [['timeout', '禁言天数'], ['warning', '警告天数']]) {
          const input = interaction.fields.getTextInputValue(id).trim();
          if (input && (!/^\d{1,2}$/.test(input) || Number(input) < 1 || Number(input) > 90)) {
            await interaction.editReply(`${name}必须为 1 到 90 的整数。`);
            return;
          }
          values[name] = input ? Number(input) : null;
        }
      }
    } else if (messageCommand) {
      values = { 链接: interaction.targetMessage.url };
      if (commandName === '删帖') {
        commandName = '内容删除申请';
        values.目标类型 = 'thread';
      } else if (commandName === '锁定并关闭') {
        commandName = '帖子操作申请';
        values.操作 = 'lock-close';
      }
    }
    if (values) options = {
      getString: (name) => values[name] ?? null,
      getInteger: (name) => values[name] ?? null,
      getUser: () => null,
    };

    if (commandName === '处罚面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '需要“管理服务器”权限才能配置处罚面板。', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: '处罚面板已创建。请使用下方菜单配置处罚记录频道、可选留痕频道、警告身份组和二次提醒。', embeds: [punishmentPanelEmbed(interaction.guildId)], components: punishmentPanel(interaction.guildId) });
      return;
    }

    if (commandName === '版务审批面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置版务审批。');
        return;
      }
      await interaction.editReply('审批设置保存在本服务器的加密配置中。面板已发送到当前频道。');
      await interaction.followUp({ content: '请配置审批频道、办公室频道、操作员/审核员身份组和同意票数。', embeds: [moderationApprovalPanelEmbed(interaction.guildId)], components: moderationApprovalPanel(interaction.guildId) });
      return;
    }

    if (commandName === '管理删帖面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置管理组删帖面板。');
        return;
      }
      await interaction.editReply('管理组删帖设置保存在本服务器的加密配置中。独立面板已发送到当前频道。');
      await interaction.followUp({ content: '可选设置删帖操作记录频道和办公室提醒频道。主管理身份组从 `/管理组面板` 读取；删帖由发起人直接二次确认，不走投票。',
        embeds: [managementDeletePanelEmbed(interaction.guildId)], components: managementDeletePanel(interaction.guildId) });
      return;
    }

    if (commandName === '反应清理面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置表情反应清理。');
        return;
      }
      await interaction.editReply('表情清理面板已发送到当前频道。');
      await interaction.followUp({ content: '配置监控成员和要移除的表情。匹配时只移除该种表情在这条消息上的反应，其他表情和消息本身都保留。',
        embeds: [reactionCleanupPanelEmbed(interaction.guildId)], components: reactionCleanupPanel(interaction.guildId) });
      return;
    }

    if (commandName === '管理删帖') {
      await createManagementDeleteProposal(interaction, options.getString('链接', true).trim());
      return;
    }

    if (commandName === '解锁') {
      await executeManagementThreadUnlock(interaction, options.getString('链接', true).trim());
      return;
    }

    if (commandName === '帖子操作申请' || commandName === '内容删除申请') {
      const setting = settingsFor(interaction.guildId);
      const link = options.getString('链接', true).trim();
      const parsed = parseDiscordMessageLink(link);
      if (!parsed || parsed.guildId !== interaction.guildId) {
        await interaction.editReply('链接格式不正确。请复制本服务器的频道/子区链接、帖子链接，或具体消息的 Discord 链接。');
        return;
      }
      if (!setting.moderationApprovalChannelId || !setting.moderationOperatorRoleIds?.length) {
        await interaction.editReply('本服务器还没有配置审批频道和操作员身份组。请管理员先运行 `/版务审批面板`。');
        return;
      }
      const requester = await interaction.guild.members.fetch(interaction.user.id);
      if (!memberHasAnyRole(requester, setting.moderationOperatorRoleIds)) {
        await interaction.editReply('只有已配置的操作员身份组成员可以提交版务申请。');
        return;
      }
      const isThreadAction = commandName === '帖子操作申请';
      const action = isThreadAction ? options.getString('操作', true) : options.getString('目标类型', true);
      const actionLabel = isThreadAction
        ? ({ lock: '锁定帖子', close: '关闭帖子', 'lock-close': '锁定并关闭帖子' })[action]
        : action === 'thread' ? '删除整个帖子' : '删除指定消息';
      const approvalChannel = await interaction.guild.channels.fetch(setting.moderationApprovalChannelId);
      if (!approvalChannel?.isTextBased?.() || !approvalChannel.send) {
        await interaction.editReply('配置的审批频道当前不可用，请管理员检查面板设置。');
        return;
      }
      const proposal = {
        id: randomBytes(6).toString('hex'), guildId: interaction.guildId, kind: isThreadAction ? 'thread-action' : 'delete',
        requesterId: interaction.user.id, targetLink: link, channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId,
        action, actionLabel, deleteTargetType: isThreadAction ? null : action,
        status: 'pending_operator', operatorVotes: [], reviewerVotes: [],
        operatorVotesRequired: isThreadAction ? setting.threadOperatorVotesRequired || 2 : setting.deleteOperatorVotesRequired || 2,
        reviewerVotesRequired: setting.moderationReviewerVotesRequired || 2,
        createdAt: Date.now(), approvalChannelId: approvalChannel.id,
      };
      if (!isThreadAction && !setting.moderationReviewerRoleId) {
        await interaction.editReply('删除申请还需要先配置审核员身份组。');
        return;
      }
      try {
        const target = await resolveModerationTarget(interaction.guild, proposal);
        if (isThreadAction && !target.channel.isThread()) throw new Error('这个链接没有指向帖子，请粘贴帖子内消息链接。');
      } catch (error) {
        await interaction.editReply(`目标无法用于此申请：${error.message}`);
        return;
      }
      const targetKey = moderationProposalResourceKey(proposal);
      if (!targetKey) {
        await interaction.editReply('无法识别申请目标，请重新复制对应帖子或消息链接。');
        return;
      }
      const duplicate = (guildData.moderationProposals || []).find((item) => item.guildId === interaction.guildId
        && isOpenModerationProposal(item) && Date.now() - item.createdAt < MODERATION_PROPOSAL_TTL
        && moderationProposalResourceKey(item) === targetKey);
      if (duplicate) {
        await interaction.editReply('这个帖子或消息已有未完成的申请（编号：' + duplicate.id + '），请勿重复发起；请在审批频道查看现有申请。');
        return;
      }
      const targetClaim = interaction.guildId + ':' + targetKey;
      if (activeModerationTargetClaims.has(targetClaim)) {
        await interaction.editReply('这个帖子或消息正在创建申请，请稍候；请勿重复提交。');
        return;
      }
      activeModerationTargetClaims.add(targetClaim);
      try {
        guildData.moderationProposals ||= [];
        proposal.operatorVotes = [{ userId: interaction.user.id, choice: 'yes', votedAt: proposal.createdAt, requesterVote: true }];
        guildData.moderationProposals.push(proposal);
        try {
          await saveGuildData();
          const approvalMessage = await approvalChannel.send({ embeds: [moderationProposalEmbed(proposal)], components: moderationVoteComponents(proposal), allowedMentions: { parse: [] } });
          proposal.approvalMessageId = approvalMessage.id;
          if (proposal.operatorVotes.length >= proposal.operatorVotesRequired) {
            if (isThreadAction) {
              proposal.status = 'executing';
              await saveGuildData();
              await approvalMessage.edit({ embeds: [moderationProposalEmbed(proposal)], components: [] });
              try {
                await executeModerationProposal(interaction.guild, proposal);
                proposal.status = 'completed';
              } catch (error) {
                proposal.status = 'failed';
                proposal.failure = String(error.message || '操作失败').slice(0, 300);
                logFailure('达到门槛后执行帖子操作失败。', error);
              }
            } else {
              proposal.status = 'pending_reviewer';
            }
            await saveGuildData();
            await approvalMessage.edit({ embeds: [moderationProposalEmbed(proposal)], components: proposal.status === 'pending_reviewer' ? moderationVoteComponents(proposal) : [] });
            if (proposal.status === 'pending_reviewer') {
              await approvalChannel.send({ content: `<@&${setting.moderationReviewerRoleId}> 删除申请已通过操作员阶段，请前往审批卡投票：https://discord.com/channels/${proposal.guildId}/${proposal.approvalChannelId}/${proposal.approvalMessageId}（编号：${proposal.id}）。`, allowedMentions: { parse: [], roles: [setting.moderationReviewerRoleId] } }).catch((error) => logFailure('审核员阶段提及发送失败。', error));
            }
          }
          await saveGuildData();
          if (proposal.status === 'pending_operator') await notifyModerationOffice(interaction.guild, proposal, setting.moderationOperatorRoleIds || [], '版务操作员审批');
          else if (proposal.status === 'pending_reviewer' && setting.moderationReviewerRoleId) await notifyModerationOffice(interaction.guild, proposal, [setting.moderationReviewerRoleId], '删除申请审核阶段');
          await interaction.editReply(`申请已提交到 <#${approvalChannel.id}>，申请编号：${proposal.id}。`);
        } catch (error) {
          guildData.moderationProposals = guildData.moderationProposals.filter((item) => item.id !== proposal.id);
          await saveGuildData();
          throw error;
        }
      } finally {
        activeModerationTargetClaims.delete(targetClaim);
      }
      return;
    }

    if (commandName === '管理组面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置管理组面板。');
        return;
      }
      const track = managementTrack(settingsFor(interaction.guildId), 'senior');
      if (track.roleId && track.channelId) await syncManagementRole(interaction.guild, 'senior');
      else if (track.roleId && track.companionRoleId) {
        await syncManagementCompanionRole(interaction.guild).catch((error) => logFailure('主管理配套身份组同步失败。', error));
      }
      await interaction.editReply({ embeds: [managementPanelEmbed(interaction.guildId)], components: managementPanelComponents(interaction.guildId) });
      return;
    }

    if (commandName === '中层管理面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置中层管理面板。');
        return;
      }
      await interaction.editReply({ embeds: [managementPanelEmbed(interaction.guildId, 'middle')], components: managementPanelComponents(interaction.guildId, 'middle') });
      return;
    }

    if (commandName === '管理组名单' || commandName === '中层管理名单') {
      const tier = commandName === '中层管理名单' ? 'middle' : 'senior';
      const roleId = tier === 'middle' ? options.getRole('身份组', true).id : null;
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

    if (commandName === '管理组卸任' || commandName === '中层管理卸任') {
      const tier = commandName === '中层管理卸任' ? 'middle' : 'senior';
      const roleId = tier === 'middle' ? options.getRole('身份组', true).id : null;
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
      const reason = options.getString('理由')?.trim() || '';
      const rolesToRemove = [role];
      if (tier === 'senior' && track.companionRoleId) {
        const companionRole = await interaction.guild.roles.fetch(track.companionRoleId);
        if (companionRole && member.roles.cache.has(companionRole.id)) {
          if (companionRole.position >= botMember.roles.highest.position) {
            await interaction.editReply('机器人身份组必须高于配套身份组，才能一并办理卸任。');
            return;
          }
          rolesToRemove.push(companionRole);
        }
      }
      await member.roles.remove(rolesToRemove, `管理组成员自行卸任`);
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

    if (commandName === '定时提醒') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能管理定时提醒。');
        return;
      }
      const subcommand = options.getSubcommand();
      if (subcommand === '添加') {
        const channel = options.getChannel('频道', true);
        const minutes = options.getInteger('分钟后');
        const seconds = options.getInteger('秒后');
        const repeat = options.getInteger('重复间隔分钟', true);
        const user = options.getUser('提及成员');
        const usersText = options.getString('提及多人')?.trim() || '';
        const role = options.getRole('提及身份组');
        if ((minutes === null) === (seconds === null)) { await interaction.editReply('“分钟后”和“秒后”必须填写一个，而且只能填写一个；5 秒是最短首次提醒时间。'); return; }
        if ([Boolean(user), Boolean(usersText), Boolean(role)].filter(Boolean).length > 1) { await interaction.editReply('一次提醒只能选择单个成员、多人列表或一个身份组中的一种提及方式。'); return; }
        if (repeat > 0 && repeat < 10) { await interaction.editReply('重复间隔至少需要 10 分钟，或填写 0 表示只提醒一次。'); return; }
        const userIds = user ? [user.id] : [];
        if (usersText) {
          const ids = [...usersText.matchAll(/<@!?(\d+)>|(\d{17,20})/g)].map((match) => match[1] || match[2]);
          const residue = usersText.replace(/<@!?\d+>|\d{17,20}/g, '').replace(/[,，\s]+/g, '');
          if (!ids.length || residue || ids.some((id) => !/^\d{17,20}$/.test(id))) {
            await interaction.editReply('“提及多人”请粘贴成员提及或 17 到 20 位用户 ID，并用空格或逗号分隔。'); return;
          }
          userIds.push(...ids);
        }
        const uniqueUserIds = [...new Set(userIds)];
        if (uniqueUserIds.length > 25) { await interaction.editReply('一次最多提及 25 位成员。'); return; }
        if (uniqueUserIds.length) {
          const members = await Promise.all(uniqueUserIds.map((id) => interaction.guild.members.fetch(id).catch(() => null)));
          if (members.some((member) => !member)) { await interaction.editReply('多人列表里有人不在本服务器，或用户 ID 无效。'); return; }
        }
        const botMember = await interaction.guild.members.fetchMe();
        const botPerms = channel.permissionsFor(botMember);
        if (!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms.has(PermissionFlagsBits.SendMessages)) {
          await interaction.editReply('机器人在所选频道缺少查看频道或发送消息权限。'); return;
        }
        if (role && !role.mentionable && !botPerms.has(PermissionFlagsBits.MentionEveryone)) {
          await interaction.editReply('要提醒这个身份组，请将其设为可被提及，或给机器人“提及 @everyone、@here 和所有身份组”权限。'); return;
        }
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const firstDelayMs = minutes !== null ? minutes * 60_000 : seconds * 1000;
        guildData.reminders.push({ id, guildId: interaction.guildId, channelId: channel.id, userIds: uniqueUserIds,
          roleId: role?.id || null, content: options.getString('内容', true), nextAt: Date.now() + firstDelayMs, intervalMs: repeat * 60_000 });
        await saveGuildData();
        const firstDelayText = minutes !== null ? `${minutes} 分钟` : `${seconds} 秒`;
        await interaction.editReply(`已创建提醒，编号：\`${id}\`。首次提醒将在 ${firstDelayText} 后发送${repeat ? `，之后每 ${repeat} 分钟重复` : '，且只发送一次'}。`);
      } else if (subcommand === '列表') {
        const entries = guildData.reminders.filter((item) => item.guildId === interaction.guildId);
        await interaction.editReply(entries.length ? entries.map((item) => {
          const users = item.userIds || (item.userId ? [item.userId] : []);
          const targets = [...users.map((userId) => `<@${userId}>`), ...(item.roleId ? [`<@&${item.roleId}>`] : [])];
          return `编号：\`${item.id}\` · <#${item.channelId}> · <t:${Math.floor(item.nextAt / 1000)}:R> · ${item.intervalMs ? `每 ${item.intervalMs / 60000} 分钟` : '一次'} · ${targets.join('、') || '无提及'} · ${item.content}`;
        }).join('\n') : '当前没有定时提醒。');
      } else {
        const id = options.getString('编号', true);
        const before = guildData.reminders.length;
        guildData.reminders = guildData.reminders.filter((item) => !(item.guildId === interaction.guildId && item.id === id));
        await saveGuildData();
        await interaction.editReply(before === guildData.reminders.length ? '没有找到这个编号。' : `已删除提醒 \`${id}\`。`);
      }
      return;
    }

    if (commandName === '处罚' || commandName === '永封') {
      if (!isConfiguredManagementMember(interaction)) {
        await interaction.editReply('您不具备该权限。');
        return;
      }
      const isPermanentBan = commandName === '永封';
      const mode = isPermanentBan ? 'ban' : options.getString('方式', true);
      const hasBan = mode === 'ban';
      const hasWarning = !hasBan && mode !== 'timeout';
      const hasTimeout = !hasBan && mode !== 'warning';
      const selectedUser = options.getUser('成员');
      const rawUserId = options.getString('user_id')?.trim();
      if (Boolean(selectedUser) === Boolean(rawUserId)) {
        await interaction.editReply('请在“成员”和“用户 ID”中任选一项填写。目标只在另一互通服务器时请填写用户 ID 或用户提及。');
        return;
      }
      let user = selectedUser;
      if (rawUserId) {
        const match = rawUserId.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
        if (!match) {
          await interaction.editReply('用户 ID 格式不正确。请粘贴 17 到 20 位数字 ID，或用户提及。');
          return;
        }
        try { user = await client.users.fetch(match[1] || match[2]); }
        catch { await interaction.editReply('无法通过这个 ID 找到 Discord 用户，请检查 ID 是否正确。'); return; }
      }
      const reason = options.getString('原因', true);
      const timeoutDays = isPermanentBan ? null : options.getInteger('禁言天数');
      const warningDays = isPermanentBan ? null : options.getInteger('警告天数');
      if (hasTimeout && !timeoutDays) { await interaction.editReply('此处罚方式需要填写“禁言天数”。'); return; }
      if (!hasTimeout && timeoutDays) { await interaction.editReply('此处罚方式不能填写禁言天数，请更改处罚方式。'); return; }
      if (!hasWarning && warningDays) { await interaction.editReply('此处罚方式不能填写警告天数，请更改处罚方式。'); return; }
      const request = { guildId: interaction.guildId, userId: user.id, mode, reason, timeoutDays, warningDays };
      const targetId = user.id;
      const now = Date.now();
      const hasPendingForTarget = Object.values(pendingPunishmentRecords).some((item) => item.userId === targetId
        && Number.isFinite(item.createdAt) && now >= item.createdAt && now - item.createdAt < PUNISHMENT_CONFIRM_TTL);
      if (activePunishmentLocks.has(targetId) || pendingPunishmentTargetClaims.has(targetId) || hasPendingForTarget) {
        await interaction.editReply(hasPendingForTarget
          ? '这个目标已有一张待处理的处罚确认卡。确认卡 1 分钟后失效；请等待失效，或由原发起人确认/取消。'
          : '这个目标正在创建或执行另一笔处罚，请稍后重试。');
        return;
      }
      pendingPunishmentTargetClaims.add(targetId);
      try {
        const context = await validatePunishmentRequest(interaction, request);
        const token = randomBytes(8).toString('hex');
        const createdAt = Date.now();
        const pendingRequest = { ...request, userId: context.user.id, guildId: interaction.guildId, moderatorId: interaction.user.id, createdAt };
        await savePendingPunishment(token, pendingRequest);
        console.log('处罚确认已保存到 Discord 私密存储。');
        pendingPunishments.set(token, pendingRequest);
        const modeLabel = hasBan ? '封禁并踢出' : mode === 'both' ? '警告并禁言' : mode === 'timeout' ? '仅禁言' : '仅警告';
        const previousCase = context.previousCase;
        const warningExpiration = guildData.warningExpirations.find((item) => item.guildId === context.guild.id
          && item.userId === context.user.id && item.roleId === context.warningRole?.id && item.expiresAt > createdAt);
        const caseWarningEndAt = previousCase?.hasWarning && previousCase.warningDays && previousCase.createdAt
          ? previousCase.createdAt + previousCase.warningDays * DAY : 0;
        const warningEndAt = warningExpiration?.expiresAt || (caseWarningEndAt > createdAt ? caseWarningEndAt : 0);
        const warningRoleHeld = Boolean(context.warningRole && context.member?.roles.cache.has(context.warningRole.id));
        const warningActive = Boolean(warningExpiration)
          || Boolean(previousCase?.hasWarning && (!previousCase.warningDays || caseWarningEndAt > createdAt))
          || (warningRoleHeld && !previousCase?.hasWarning);
        const timeoutUntil = context.member?.communicationDisabledUntilTimestamp || 0;
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
        const otherGuildStatus = context.contexts.filter((item) => item.guild.id !== context.guild.id).map((item) => {
          const existing = item.previousCase;
          const expires = guildData.warningExpirations.find((entry) => entry.guildId === item.guild.id && entry.userId === user.id
            && entry.roleId === item.warningRole?.id && entry.expiresAt > createdAt);
          const warningHeld = Boolean(item.warningRole && item.member?.roles.cache.has(item.warningRole.id));
          const warningOngoing = Boolean(expires) || Boolean(existing?.hasWarning && (!existing.warningDays || (existing.createdAt + existing.warningDays * DAY) > createdAt))
            || (warningHeld && !existing?.hasWarning);
          const warningRemaining = expires?.expiresAt || (existing?.hasWarning && existing.warningDays ? existing.createdAt + existing.warningDays * DAY : 0);
          const muteUntil = item.member?.communicationDisabledUntilTimestamp || 0;
          const muteSchedule = longTimeouts.find((entry) => entry.guildId === item.guild.id && entry.userId === user.id && (!existing || entry.caseId === existing.id));
          const caseMuteEnd = existing?.hasTimeout && existing.timeoutDays ? existing.createdAt + existing.timeoutDays * DAY : 0;
          const muteEnd = muteSchedule?.endAt || caseMuteEnd || muteUntil;
          const membership = item.member ? '成员在服务器内' : '成员已不在服务器，仍可按 ID 封禁';
          return `${item.guild.name}：${membership}；${warningOngoing ? `警告期内（剩余 ${warningRemaining > createdAt ? remaining(warningRemaining) : '无自动到期记录'}）` : '不在警告期'}；${muteUntil > createdAt ? `当前禁言剩余 ${remaining(muteUntil)}` : muteEnd > createdAt ? `处罚禁言剩余 ${remaining(muteEnd)}` : '当前未禁言'}`;
        });
        const confirmationLines = [
          '请核对处罚内容，确认后才会执行：',
          `目标成员：<@${user.id}>`,
          `处罚方式：${modeLabel}`,
          `执行范围：${isPermanentBan ? '按 ID 在互通服务器封禁' : context.absentGuilds.length ? '单边执行，另一边仅公示' : context.contexts.length > 1 ? '双边同步执行' : '当前服务器执行'}`,
          `实际执行服务器：${context.contexts.map((item) => item.guild.name).join('、')}`,
          ...(context.absentGuilds.length ? [`仅公示服务器：${context.absentGuilds.map((guild) => guild.name).join('、')}（目标不在该服，不执行警告或禁言）`] : []),
          ...(hasWarning ? [`警告身份组：${context.warningRole}` , `警告时长：${warningDays ? `${warningDays} 天` : '不自动移除'}`] : []),
          ...(hasTimeout ? [`禁言时长：${timeoutDays} 天`] : []),
          ...(hasBan ? [`封禁效果：目标将从${context.contexts.length > 1 ? '两个服务器' : '当前服务器'}移出；撤销处罚可按编号解封。`] : []),
          `目标当前是否在警告期：${warningActive ? '是' : '否'}`,
          `当前警告剩余时长：${warningActive ? (warningEndAt > createdAt ? remaining(warningEndAt) : '无自动到期记录') : '—'}`,
          `当前处罚剩余时长：${punishmentEndAt > createdAt ? remaining(punishmentEndAt) : (timeoutUntil > createdAt ? remaining(timeoutUntil) : '当前无生效处罚期限')}`,
          `Discord 当前禁言剩余时长：${timeoutUntil > createdAt ? remaining(timeoutUntil) : '当前未禁言'}`,
          ...otherGuildStatus,
          `原因：${reason}`,
          ...context.contexts.filter((item) => item.previousCase).map((item) => `注意：确认后会覆盖“${item.guild.name}”中生效的处罚 \`${item.previousCase.id}\`。`),
          '',
          '此确认仅限你本人操作，1 分钟后失效；同一目标同时只能有一张待处理处罚确认卡。',
        ];
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`punishment-confirm:${token}`).setLabel('确认执行').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`punishment-cancel:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ content: confirmationLines.join('\n'), components: [row], allowedMentions: { parse: [] } });
      } catch (error) {
        logFailure('/处罚 准备确认卡失败。', error);
        if (error.code === 10062) {
          console.error('处罚确认数据可能已保存，但 Discord 的交互回复令牌已失效；请确认没有重复 Bot 进程，并查看私密存储中的待确认记录。');
          return;
        }
        await interaction.editReply(error.message).catch((replyError) => logFailure('/处罚 错误提示发送失败。', replyError));
      } finally {
        pendingPunishmentTargetClaims.delete(targetId);
      }
      return;
    }

    if (commandName === '撤销处罚') {
      if (!isConfiguredManagementMember(interaction)) {
        await interaction.editReply('您不具备该权限。');
        return;
      }
      const caseId = options.getString('处罚编号', true).trim();
      const pairedGuildIds = punishmentGuildIds();
      const searchableGuildIds = pairedGuildIds.includes(interaction.guildId) ? pairedGuildIds : [interaction.guildId];
      const record = guildData.punishmentCases.find((item) => searchableGuildIds.includes(item.guildId) && item.id === caseId);
      if (!record) {
        await interaction.editReply('没有找到当前服务器或互通服务器中对应的处罚 ID。旧版本产生的处罚记录无法按 ID 撤销，请先用新版重新处罚。');
        return;
      }
      if (record.status !== 'active') {
        const statusText = record.status === 'superseded' ? `这笔处罚已被新处罚 ${record.supersededBy || ''} 覆盖。` : record.status === 'revoked' ? '这笔处罚已经撤销。' : '这笔处罚当前不在生效状态。';
        await interaction.editReply(statusText);
        return;
      }
      const linkedRecords = record.syncGroupId
        ? guildData.punishmentCases.filter((item) => item.syncGroupId === record.syncGroupId && item.status === 'active')
        : [record];
      const expectedGuildIds = record.syncGuildIds || [record.guildId];
      const hasAllLinkedRecords = expectedGuildIds.every((guildId) => linkedRecords.some((item) => item.guildId === guildId));
      if (!hasAllLinkedRecords) {
        await interaction.editReply('这笔同步处罚的服务器记录不完整；为避免只撤销一边，没有执行操作。请检查 Discord 私密存储记录。');
        return;
      }
      const revokeContexts = [];
      for (const linked of linkedRecords) {
        const guild = await client.guilds.fetch(linked.guildId);
        const botMember = await guild.members.fetchMe();
        const hasBan = Boolean(linked.hasBan || linked.mode === 'ban');
        const needsMember = Boolean(linked.hasWarning || linked.hasTimeout);
        let member = null;
        if (needsMember) {
          try { member = await guild.members.fetch(linked.userId); }
          catch { await interaction.editReply(`目标成员已不在“${guild.name}”中；为保持双向一致，没有执行撤销。`); return; }
        }
        let existingBan = null;
        if (hasBan) {
          try { existingBan = await guild.bans.fetch(linked.userId); }
          catch (error) { if ((error.code ?? error.rawError?.code) !== 10026) throw error; }
        }
        if (linked.hasWarning && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          await interaction.editReply(`机器人在“${guild.name}”缺少“管理身份组”权限；没有执行撤销。`); return;
        }
        if (linked.hasTimeout && !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
          await interaction.editReply(`机器人在“${guild.name}”缺少“管理成员”权限；没有执行撤销。`); return;
        }
        if (hasBan && !botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
          await interaction.editReply(`机器人在“${guild.name}”缺少“封禁成员”权限；没有执行撤销。`); return;
        }
        if (member && member.roles.highest.position >= botMember.roles.highest.position) {
          await interaction.editReply(`机器人身份组必须高于目标成员在“${guild.name}”中的最高身份组；没有执行撤销。`); return;
        }
        const role = linked.hasWarning && linked.warningRoleId ? await guild.roles.fetch(linked.warningRoleId).catch(() => null) : null;
        if (linked.hasWarning && (!linked.warningRoleId || !role)) {
          await interaction.editReply(`“${guild.name}”中的警告身份组已不存在；没有执行撤销。`); return;
        }
        revokeContexts.push({ linked, guild, member, role, oldTimeoutUntil: member?.communicationDisabledUntilTimestamp || 0,
          hadWarning: Boolean(role && member?.roles.cache.has(role.id)), removedWarning: false, clearedTimeout: false,
          hasBan, existingBan: Boolean(existingBan), removedBan: false });
      }
      const invokingContext = revokeContexts.find((item) => item.guild.id === interaction.guildId);
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        const caller = await interaction.guild.members.fetch(interaction.user.id);
        if (invokingContext?.member && invokingContext.member.roles.highest.position >= caller.roles.highest.position) {
          await interaction.editReply('只能撤销身份组层级低于自己的成员处罚。');
          return;
        }
      }
      try {
        for (const context of revokeContexts) {
          if (context.role && context.hadWarning) {
            await context.member.roles.remove(context.role, `撤销处罚 ${record.id}（由 ${interaction.user.tag} 操作）`);
            context.removedWarning = true;
          }
          if (context.linked.hasTimeout) {
            await context.member.timeout(null, `撤销处罚 ${record.id}（由 ${interaction.user.tag} 操作）`);
            context.clearedTimeout = true;
          }
          if (context.hasBan && context.existingBan) {
            await context.guild.members.unban(context.linked.userId, `撤销处罚 ${record.id}（由 ${interaction.user.tag} 操作）`);
            context.removedBan = true;
          }
        }
      } catch (error) {
        for (const context of revokeContexts.slice().reverse()) {
          if (context.removedWarning && context.role) await context.member.roles.add(context.role, `同步撤销 ${record.id} 未能完成，回滚`).catch(() => {});
          if (context.clearedTimeout && context.oldTimeoutUntil > Date.now()) {
            await context.member.timeout(context.oldTimeoutUntil - Date.now(), `同步撤销 ${record.id} 未能完成，回滚`).catch(() => {});
          }
          if (context.removedBan) await context.guild.members.ban(context.linked.userId, { reason: `同步撤销 ${record.id} 未能完成，回滚` }).catch(() => {});
        }
        await interaction.editReply(`双向撤销未能在全部服务器完成，已尝试回滚；${error.message}`);
        return;
      }
      const revokedAt = Date.now();
      for (const context of revokeContexts) {
        context.linked.status = 'revoked';
        context.linked.revokedAt = revokedAt;
        context.linked.revokedBy = interaction.user.id;
      }
      guildData.warningExpirations = guildData.warningExpirations.filter((item) => item.caseId !== record.id);
      guildData.warningFollowups = guildData.warningFollowups.filter((item) => item.caseId !== record.id);
      longTimeouts = longTimeouts.filter((item) => item.caseId !== record.id);
      let persistenceFailed = false;
      try { await savePlatformStorage(); }
      catch (error) { persistenceFailed = true; logFailure('双向撤销已应用，但状态没有写入 Discord 私密存储。', error); }
      const logResults = await Promise.all(revokeContexts.map(({ guild, linked }) => postPunishmentRevocation(guild, linked, interaction.user)));
      const logFailures = logResults.filter((logged) => !logged.primarySent || !logged.auditSent).length;
      const syncedText = revokeContexts.length > 1 ? `已在 ${revokeContexts.length} 个服务器双向撤销处罚 \`${record.id}\`。` : `已按处罚 ID \`${record.id}\` 撤销`;
      const revokedActions = [record.hasWarning ? '警告' : null, record.hasTimeout ? '禁言' : null, record.hasBan || record.mode === 'ban' ? '封禁' : null].filter(Boolean).join('和');
      await interaction.editReply(`${syncedText}${revokeContexts.length === 1 ? `${revokedActions}。` : ''}${logFailures ? `有 ${logFailures} 个服务器的撤销记录或留痕频道写入失败。` : ''}${persistenceFailed ? '撤销状态写入 Discord 私密存储失败；请检查存储频道连接。' : ''}`);
      return;
    }

    if (commandName === '说话') {
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
      const content = options.getString('内容') || '';
      const pictures = ['图片1', '图片2', '图片3', '图片4', '图片5']
        .map((name) => options.getAttachment(name)).filter(Boolean);
      const pictureLinksInput = options.getString('图片链接') || '';
      const pictureLinks = pictureLinksInput.trim() ? pictureLinksInput.trim().split(/\s+/u) : [];
      if (!content.trim() && !pictures.length && !pictureLinks.length) {
        await interaction.editReply('请至少填写文字内容、上传一张图片或提供一个图片链接。');
        return;
      }
      if (pictures.length + pictureLinks.length > 10 || pictureLinks.length > 5) {
        await interaction.editReply('一次最多发送 10 张图片，其中图片链接最多 5 个。');
        return;
      }
      const invalidLink = pictureLinks.find((link) => {
        try {
          const url = new URL(link);
          return url.protocol !== 'https:' || !url.hostname || url.username || url.password;
        } catch { return true; }
      });
      if (invalidLink) {
        await interaction.editReply('图片链接必须是有效的 HTTPS 网址；多个链接请用空格或换行分隔。');
        return;
      }
      if (pictures.some((picture) => !/^image\/(png|jpeg|gif|webp|avif)(?:;|$)/i.test(picture.contentType || ''))) {
        await interaction.editReply('请上传 PNG、JPEG、GIF、WebP 或 AVIF 格式的图片。');
        return;
      }
      if (pictures.length && !botPermissions.has(PermissionFlagsBits.AttachFiles)) {
        await interaction.editReply('机器人在当前频道或子区缺少“附加文件”权限。');
        return;
      }
      if (pictures.some((picture) => interaction.attachmentSizeLimit && picture.size > interaction.attachmentSizeLimit)) {
        await interaction.editReply('图片超过当前服务器的附件大小限制，请压缩后重试。');
        return;
      }
      if (pictureLinks.length && !botPermissions.has(PermissionFlagsBits.EmbedLinks)) {
        await interaction.editReply('机器人在当前频道或子区缺少“嵌入链接”权限，无法预览图片链接。');
        return;
      }
      const messageContent = [content.trim(), ...pictureLinks].filter(Boolean).join('\n');
      if (messageContent.length > 2000) {
        await interaction.editReply('文字和图片链接合并后超过 Discord 的 2000 字符限制，请删减后重试。');
        return;
      }
      const mentionsEveryone = /@(everyone|here)\b/i.test(content);
      const mentionedRoleIds = [...content.matchAll(/<@&(\d{17,20})>/g)].map((match) => match[1]);
      if (mentionsEveryone && !hasPermission(interaction, PermissionFlagsBits.MentionEveryone)) {
        await interaction.editReply('只有拥有“提及 @everyone、@here 和所有身份组”权限的成员才能让机器人提及 @everyone 或 @here。');
        return;
      }
      if (mentionsEveryone && !botPermissions.has(PermissionFlagsBits.MentionEveryone)) {
        await interaction.editReply('机器人缺少“提及 @everyone、@here 和所有身份组”权限，无法发送 @everyone 或 @here 提及。');
        return;
      }
      if (mentionedRoleIds.length) {
        const roles = await Promise.all([...new Set(mentionedRoleIds)].map((roleId) => interaction.guild.roles.fetch(roleId).catch(() => null)));
        if (roles.some((role) => !role)) {
          await interaction.editReply('消息里包含无效的身份组提及，请确认该身份组仍在本服务器。');
          return;
        }
        const canMentionRestrictedRoles = hasPermission(interaction, PermissionFlagsBits.MentionEveryone)
          || isConfiguredManagementMember(interaction);
        const restrictedRole = roles.find((role) => !role.mentionable);
        if (restrictedRole && !canMentionRestrictedRoles) {
          await interaction.editReply(`你不能提及身份组“${restrictedRole.name}”：该组未开放给普通成员提及。只有拥有“提及 @everyone、@here 和所有身份组”权限的成员或管理组成员可以让 Bot 提及此类身份组。`);
          return;
        }
        if (roles.some((role) => !role.mentionable) && !botPermissions.has(PermissionFlagsBits.MentionEveryone)) {
          await interaction.editReply('机器人缺少“提及 @everyone、@here 和所有身份组”权限，无法提醒不可被普通成员提及的身份组；请为机器人开启此权限，或将目标身份组设为可被提及。');
          return;
        }
      }
      const replyLink = options.getString('回复消息链接');
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
      await target.send({ content: messageContent || undefined, ...replyOptions,
        ...(pictures.length ? { files: pictures.map((picture) => ({ attachment: picture.url, name: picture.name })) } : {}),
        allowedMentions: { parse: ['users', 'roles', ...(mentionsEveryone ? ['everyone'] : [])], repliedUser: false } });
      await interaction.editReply(replyLink ? '已由机器人在当前频道/子区回复该消息。' : '已由机器人在当前频道/子区发言。');
      return;
    }

    if (commandName === '说话转发') {
      const target = interaction.channel;
      if (!target?.isTextBased() || !target.guildId || target.guildId !== interaction.guildId || target.type === ChannelType.GuildForum) {
        await interaction.editReply('请在本服务器的文字频道或已打开的帖子内使用此指令。');
        return;
      }
      const targetBotMember = await interaction.guild.members.fetchMe();
      const targetPermissions = target.permissionsFor(targetBotMember);
      const targetSendPermission = target.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      if (!targetPermissions?.has(PermissionFlagsBits.ViewChannel) || !targetPermissions.has(targetSendPermission)) {
        await interaction.editReply('机器人在当前频道或子区缺少查看频道或发送消息的权限。');
        return;
      }

      const link = options.getString('消息链接', true).trim();
      let linkUrl;
      try { linkUrl = new URL(link); } catch {
        await interaction.editReply('消息链接格式不正确，请复制 Discord 的“复制消息链接”。');
        return;
      }
      const allowedHosts = new Set(['discord.com', 'www.discord.com', 'discordapp.com', 'www.discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
      const parsed = parseDiscordMessageLink(link);
      if (linkUrl.protocol !== 'https:' || !allowedHosts.has(linkUrl.hostname) || !parsed?.messageId || parsed.guildId !== interaction.guildId) {
        await interaction.editReply('请提供指向本服务器具体消息的 HTTPS Discord 链接。');
        return;
      }

      let sourceChannel = await interaction.guild.channels.fetch(parsed.channelId).catch(() => null);
      if (parsed.threadId) {
        const parentChannel = sourceChannel;
        const linkedThread = await interaction.guild.channels.fetch(parsed.threadId).catch(() => null);
        if (!parentChannel || !linkedThread?.isThread?.() || linkedThread.parentId !== parentChannel.id) {
          await interaction.editReply('链接中的帖子不存在，或不属于这个服务器。');
          return;
        }
        sourceChannel = linkedThread;
      }
      if (!sourceChannel?.isThread?.() && sourceChannel?.type === ChannelType.GuildForum) {
        await interaction.editReply('请复制帖子内某条具体消息的链接，不能只提供论坛帖子链接。');
        return;
      }
      if (!sourceChannel?.isTextBased?.() || !sourceChannel.messages || sourceChannel.guildId !== interaction.guildId) {
        await interaction.editReply('链接没有指向可读取的本服务器文字频道或帖子。');
        return;
      }

      const requester = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const requesterPermissions = requester && sourceChannel.permissionsFor(requester);
      const sourceBotPermissions = sourceChannel.permissionsFor(targetBotMember);
      const readPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
      if (!requesterPermissions?.has(readPermissions)) {
        await interaction.editReply('你没有查看源频道及其历史消息的权限，Bot 不会代你转发该消息。');
        return;
      }
      if (!sourceBotPermissions?.has(readPermissions)) {
        await interaction.editReply('机器人没有查看源频道及其历史消息的权限，无法转发该消息。');
        return;
      }

      const sourceMessage = await sourceChannel.messages.fetch(parsed.messageId).catch(() => null);
      if (!sourceMessage) {
        await interaction.editReply('源消息不存在或当前无法读取，请确认链接指向一条具体消息。');
        return;
      }
      try {
        await sourceMessage.forward(target);
      } catch (error) {
        logFailure('消息转发失败。', error);
        await interaction.editReply('消息读取成功，但 Discord 拒绝转发；请确认 Bot 可在目标频道发言，且源消息类型支持转发。');
        return;
      }
      await interaction.editReply('已将这条消息转发到当前频道或子区。');
      return;
    }

    if (commandName === '编辑说话') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageMessages)) {
        await interaction.editReply('你需要“管理消息”权限才能使用此指令。');
        return;
      }
      const everyonePermissions = interaction.channel?.permissionsFor(interaction.guild.roles.everyone);
      if (!everyonePermissions || everyonePermissions.has(PermissionFlagsBits.ViewChannel)) {
        await interaction.editReply('为了不在公开频道显示使用者，请在仅管理人员可见的私密频道中使用此指令。');
        return;
      }
      const link = options.getString('消息链接', true);
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
      await message.edit({ content: options.getString('新内容', true), allowedMentions: { parse: [] } });
      await interaction.editReply('已更新机器人消息。');
      return;
    }

    if (commandName === '配置身份组') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) {
        await interaction.editReply('你需要“管理身份组”权限才能使用此指令。');
        return;
      }
      const action = options.getSubcommand();
      const user = options.getUser('成员', true);
      const role = options.getRole('身份组', true);
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
    logFailure(`/${commandName} 执行失败（交互 ID ${interaction.id}，PID ${process.pid}）。`, error);
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
  if (!storageChannelId) throw new Error('请先在 .env 配置 DISCORD_STORAGE_CHANNEL_ID（私密存储频道 ID）。');
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
  logFailure('Bot startup failed.', error);
  process.exit(1);
});
