require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } = require('node:crypto');
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
  PermissionFlagsBits, AuditLogEvent, MessageFlags, ActionRowBuilder, ButtonBuilder,
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
const MANAGEMENT_SPEECH_TITLE = '管理组正式发言';
const MANAGEMENT_SPEECH_FOOTER = '管理组认证：';
const DEFAULT_MONITORED_PERMISSION_KEYS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageThreads', 'ManageWebhooks'];
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
const activeManagementPanelSyncs = new Map();
let scheduleProcessing = false;
const activeReactionCleanups = new Set();
const activeModerationTargetClaims = new Set();
const activeManagementDeleteVotes = new Set();
const activeManagementDeleteExecutions = new Set();
const pendingEmergencyClosures = new Map();
const pendingEmergencyOpenings = new Map();
const activeEmergencyClosures = new Set();
const timeoutFile = path.join(__dirname, '..', 'data', 'long-timeouts.json');
const guildDataFile = path.join(__dirname, '..', 'data', 'guild-settings.json');
const pendingPunishmentsDir = path.join(__dirname, '..', 'data', 'pending-punishments');
const PUNISHMENT_CONFIRM_TTL = 60 * 1000;
const MODERATION_PROPOSAL_TTL = 24 * 60 * 60 * 1000;
const ENCRYPTED_JSON_FORMAT = 'discord-api-bot-encrypted-json';
const STORAGE_MARKER = 'discord-api-bot-state-v1';
const STORAGE_FILE_NAME = 'discord-api-bot-state.json';
const storageChannelId = process.env.DISCORD_STORAGE_CHANNEL_ID || '';
const speechArchiveChannelId = process.env.DISCORD_SPEECH_ARCHIVE_CHANNEL_ID || '';
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
  ...['处罚', '永封', '删帖', '锁定并关闭', '管理删帖', '管理锁定', '解锁', '管理解锁'].map((name) =>
    new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message)),
  ...['处罚', '永封'].map((name) =>
    new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.User)),
  ...['说话', '管理说话'].map((commandName) => {
    const command = new SlashCommandBuilder()
      .setName(commandName).setDescription(commandName === '管理说话'
        ? '主管理组以可核验的管理组身份在当前频道或子区发言'
        : '让机器人以自己的身份在当前频道或子区发言')
      .addStringOption((o) => o.setName('内容').setDescription('机器人要发送的消息（与图片至少填写一项）').setRequired(false).setMaxLength(1900));
    for (const name of ['图片1', '图片2', '图片3', '图片4', '图片5']) {
      command.addAttachmentOption((o) => o.setName(name).setDescription('可选图片附件').setRequired(false));
    }
    command
      .addStringOption((o) => o.setName('图片链接').setDescription('可填多个 HTTPS 图片链接，用空格或换行分隔').setRequired(false).setMaxLength(1800))
      .addStringOption((o) => o.setName('回复消息链接').setDescription('可选：粘贴当前频道/子区中要回复的消息链接').setRequired(false).setMaxLength(200));
    return command;
  }),
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
    .setName('权限面板').setDescription('配置服务器及各频道的身份组权限，监控并恢复人工权限变更')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('版务审批面板').setDescription('配置帖子操作和内容删除的审批流程')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理删帖面板').setDescription('配置管理组删帖记录和办公室提醒')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('管理删帖').setDescription('发起需要三名主管理成员批准的删帖申请')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器帖子内一条消息的链接').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('解锁').setDescription('由管理组、中层管理或服务器管理员解锁并重新开放帖子')
    .addStringOption((o) => o.setName('链接').setDescription('粘贴本服务器帖子内一条消息的链接').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('管理解锁').setDescription('由管理组、中层管理或服务器管理员解锁并重新开放帖子')
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
    .setName('紧急频道面板').setDescription('由管理组配置位置并开设临时紧急频道'),
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
  guildData.settings[guildId].permissionAlertChannelId ??= null;
  guildData.settings[guildId].permissionRollbackEnabled ??= true;
  guildData.settings[guildId].permissionEscalationEnabled ??= true;
  guildData.settings[guildId].permissionEscalationRoleId ??= null;
  guildData.settings[guildId].permissionMonitoredKeys ||= [...DEFAULT_MONITORED_PERMISSION_KEYS];
  guildData.settings[guildId].permissionRollbackWhitelistUserIds ||= [];
  guildData.settings[guildId].permissionStrikeCounts ||= {};
  guildData.settings[guildId].permissionAllChannelRules ||= {};
  guildData.settings[guildId].emergencyCategoryId ??= null;
  guildData.settings[guildId].emergencyRecordChannelId ??= null;
  guildData.settings[guildId].emergencyChannels ||= {};
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
      group.companionRoleIds = normalizeCompanionRoleIds(group.companionRoleIds || (group.companionRoleId ? [group.companionRoleId] : []));
    }
    return { tier, roleId, channelId: group?.channelId || null, announcementChannelId: group?.announcementChannelId || null, rosterMessageId: group?.rosterMessageId || null,
      rosterMessageIds: group?.rosterMessageIds || [],
      terms: group?.terms || [], companionRoleIds: group?.companionRoleIds || [], group, label: '中层管理', prefix: 'midmgmt' };
  }
  setting.managementTerms ||= [];
  setting.managementRosterMessageIds ||= setting.managementRosterMessageId ? [setting.managementRosterMessageId] : [];
  setting.managementCompanionRoleIds = normalizeCompanionRoleIds(setting.managementCompanionRoleIds
    || (setting.managementCompanionRoleId ? [setting.managementCompanionRoleId] : []));
  setting.managementCompanionRoleId = setting.managementCompanionRoleIds[0] || null;
  return { tier: 'senior', roleId: setting.managementRoleId || null, channelId: setting.managementChannelId || null,
    announcementChannelId: setting.managementAnnouncementChannelId || null,
    companionRoleIds: setting.managementCompanionRoleIds, companionRoleId: setting.managementCompanionRoleIds[0] || null,
    rosterMessageId: setting.managementRosterMessageId || null, rosterMessageIds: setting.managementRosterMessageIds, terms: setting.managementTerms,
    label: '管理组', prefix: 'mgmt' };
}

function normalizeCompanionRoleIds(roleIds) {
  return [...new Set((Array.isArray(roleIds) ? roleIds : []).filter((roleId) => typeof roleId === 'string' && roleId))].slice(0, 4);
}

function managementTracks(setting) {
  return [
    ['senior', null, managementTrack(setting, 'senior')],
    ...Object.keys(setting.middleManagementGroups || {}).map((roleId) => ['middle', roleId, managementTrack(setting, 'middle', roleId)]),
  ];
}

function configuredCompanionRoleIds(setting, additionalRoleIds = []) {
  return new Set([
    ...managementTracks(setting).flatMap(([, , track]) => track.companionRoleIds || []),
    ...additionalRoleIds,
  ]);
}

function companionRoleIdsForMember(member, excludingManagementRoleIds = new Set()) {
  const setting = settingsFor(member.guild.id);
  const desired = new Set();
  for (const [, , track] of managementTracks(setting)) {
    if (track.roleId && !excludingManagementRoleIds.has(track.roleId) && member.roles.cache.has(track.roleId)) {
      for (const companionRoleId of track.companionRoleIds || []) desired.add(companionRoleId);
    }
  }
  return desired;
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
    .setDescription(`审批频道：${setting.managementDeleteApprovalChannelId ? `<#${setting.managementDeleteApprovalChannelId}>` : '尚未设置（必需）'}\n办公室提醒频道：${setting.managementDeleteOfficeChannelId ? `<#${setting.managementDeleteOfficeChannelId}>` : '尚未设置（可选）'}\n可用身份组：${managerRoleId ? `<@&${managerRoleId}>` : '请先在「管理组面板」设置主管理身份组'}\n\n主管理组成员通过右键消息「管理删帖」或使用 /管理删帖 发起；发起人计 1 票，需 3 名不同主管理组成员同意。第 3 票由最后一位审批者在 5 秒警示等待后再次确认，才会删除整个帖子。任何拒绝都会结束申请。办公室频道（如已设置）会在发起和最后确认阶段提及主管理组。\n\n管理组执行「管理锁定」时会先填写理由，成功后在操作所在频道公示操作人、理由和帖子链接；可使用右键「管理解锁」或 /管理解锁重新开放帖子。`);
}

function managementDeletePanel(guildId) {
  const setting = settingsFor(guildId);
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`mgmtdeletecfg-approval:${guildId}`).setPlaceholder('选择管理组删帖审批频道（必需）').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
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

function managementDeleteVoteComponents(proposal) {
  const votes = (proposal.managementVotes || []).filter((vote) => vote.choice === 'yes').length;
  const required = proposal.managementVotesRequired || 3;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mgmtdelete-vote:yes:${proposal.id}`).setLabel(`同意删帖（${votes}/${required}）`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mgmtdelete-vote:no:${proposal.id}`).setLabel('拒绝').setStyle(ButtonStyle.Secondary),
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
  const votes = (proposal.managementVotes || []).filter((vote) => vote.choice === 'yes').length;
  const notice = proposal.status === 'completed'
    ? '管理组已确认并完成删帖操作。'
    : proposal.status === 'failed'
      ? '管理组删帖执行失败，请查看操作记录。'
      : proposal.status === 'rejected'
        ? '管理组成员拒绝了删帖申请，帖子没有删除。'
      : proposal.status === 'awaiting_management_confirmation'
        ? `管理组已完成 ${votes}/${proposal.managementVotesRequired || 3} 票，等待最后一位审批者确认删除。`
        : `有管理组删帖申请待审批，目前同意 ${votes}/${proposal.managementVotesRequired || 3} 票。`;
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
  const managementVotes = proposal.managementVotes?.filter((vote) => vote.choice === 'yes').length || 0;
  const phase = proposal.status === 'pending_management'
    ? `主管理组同意：${managementVotes}/${proposal.managementVotesRequired || 3}（发起人计 1 票；需不同成员）`
    : proposal.status === 'awaiting_management_confirmation'
      ? `主管理组同意：${managementVotes}/${proposal.managementVotesRequired || 3}\n最后审批者：<@${proposal.finalApproverId || proposal.pendingManagementConfirmation?.userId || proposal.requesterId}>，等待最终确认。\n\n⚠️ 最终警示：确认后 Bot 会立即删除整个帖子及其中所有消息，无法恢复。按钮等待 5 秒后启用。`
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

function emergencyChannelPanelEmbed(guildId) {
  const setting = settingsFor(guildId);
  const managerRoleId = managementTrack(setting, 'senior').roleId;
  return new EmbedBuilder().setColor(0xE67E22).setTitle('紧急频道面板')
    .setDescription(`管理组：${managerRoleId ? `<@&${managerRoleId}>` : '尚未在 /管理组面板 配置'}\n开设位置：${setting.emergencyCategoryId ? `<#${setting.emergencyCategoryId}>` : '尚未选择分类'}\n私密记录频道：${setting.emergencyRecordChannelId ? `<#${setting.emergencyRecordChannelId}>` : '尚未选择'}\n\n开设时可选择允许进入的身份组，也可不选；仅创建者和 Bot 默认可进入。频道内可通过“拉人”按钮为指定成员开放查看、发言、创建公共子区、添加反应和查看历史消息。频道内的“记录并关闭”按钮会先要求二次确认，再将聊天记录加密发送至上述记录频道；记录成功才删除频道。管理组可点击记录卡获取仅自己可见的解密文件。附件会以链接保存在记录中。若 Discord 未提供完整消息内容，Bot 会停止删除。`);
}

const emergencyGuestPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory];

function emergencyOpeningReady(session) {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emergency-details:${session.token}`)
    .setLabel('填写频道名称和理由').setStyle(ButtonStyle.Primary))];
}

function emergencyOpeningSession(interaction, token) {
  const session = pendingEmergencyOpenings.get(token);
  if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id
    || session.expiresAt <= Date.now()) throw new Error('开设步骤已过期，请重新点击面板中的“开设紧急频道”。');
  return session;
}

function emergencyChannelPanelComponents(guildId) {
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`emergency-category:${guildId}`)
      .setPlaceholder('选择开设位置（频道分类）').setChannelTypes(ChannelType.GuildCategory)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`emergency-record:${guildId}`)
      .setPlaceholder('选择私密聊天记录频道').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emergency-create:${guildId}`)
      .setLabel('开设紧急频道').setStyle(ButtonStyle.Primary)),
  ];
}

async function emergencyManagerRole(interaction) {
  const roleId = managementTrack(settingsFor(interaction.guildId), 'senior').roleId;
  if (!roleId) throw new Error('请先在 /管理组面板 配置主管理身份组。');
  const inPayload = interaction.member?.roles?.cache?.has(roleId)
    || (Array.isArray(interaction.member?.roles) && interaction.member.roles.includes(roleId));
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const member = inPayload || isAdmin ? null : await interaction.guild.members.fetch(interaction.user.id);
  if (!inPayload && !isAdmin && !member.roles.cache.has(roleId)
    && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('只有主管理组成员或服务器管理员可以使用此功能。');
  }
  return roleId;
}

async function emergencyRecordChannel(guild, setting) {
  const channel = setting.emergencyRecordChannelId
    ? await guild.channels.fetch(setting.emergencyRecordChannelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('请在紧急频道面板设置有效的文字记录频道。');
  if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('记录频道对 @everyone 可见；请先将其设为私密频道。');
  }
  const botMember = await guild.members.fetchMe();
  if (!channel.permissionsFor(botMember)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles,
  ])) throw new Error('Bot 在记录频道缺少查看、发送消息或附加文件权限。');
  return channel;
}

async function emergencyTranscriptSources(channel) {
  const threads = new Map((await channel.threads.fetchActive()).threads);
  for (const type of ['public', 'private']) {
    let before;
    while (true) {
      const page = await channel.threads.fetchArchived({ type, fetchAll: true, limit: 100,
        ...(before ? { before } : {}) });
      for (const thread of page.threads.values()) threads.set(thread.id, thread);
      if (!page.hasMore) break;
      const last = page.threads.last();
      if (!last?.archivedAt || last.archivedAt.getTime() === before?.getTime()) {
        throw new Error('无法完整翻页读取子区列表；频道未删除。');
      }
      before = last.archivedAt;
    }
  }
  return [channel, ...threads.values()];
}

async function emergencyTranscriptUnchanged(channel, newestIds) {
  const sources = await emergencyTranscriptSources(channel);
  if (sources.length !== newestIds.size || sources.some((source) => !newestIds.has(source.id))) return false;
  for (const source of sources) {
    const latest = await source.messages.fetch({ limit: 1 });
    if ((latest.first()?.id || null) !== newestIds.get(source.id)) return false;
  }
  return true;
}

async function emergencyTranscriptFiles(channel, caseId) {
  const sources = await emergencyTranscriptSources(channel);
  const messages = [];
  const newestIds = new Map();
  for (const source of sources) {
    let before;
    let newestId = null;
    while (true) {
      const page = await source.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!page.size) break;
      if (!newestId) newestId = page.first().id;
      messages.push(...page.values());
      if (messages.length > 5000) throw new Error('紧急频道及子区合计超过 5000 条消息；频道未删除。');
      before = page.last().id;
      if (page.size < 100) break;
    }
    newestIds.set(source.id, newestId);
  }
  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp || left.id.localeCompare(right.id));
  const lines = [`紧急频道聊天记录\n频道：${channel.name} (${channel.id})\n记录编号：${caseId}\n导出时间：${new Date().toISOString()}\n频道及子区数量：${sources.length}\n消息数量：${messages.length}\n`];
  for (const message of messages) {
    if (!message.author?.bot && (message.type === 0 || message.type === 19)
      && !message.content && !message.attachments.size && !message.stickers?.size) {
      throw new Error('Discord 未提供部分成员的消息内容；请先取得 Message Content Intent 后重试。频道未删除。');
    }
    const attachments = [...message.attachments.values()].map((item) => `${item.name || '附件'}: ${item.url}`);
    const embeds = message.embeds.map((embed) => JSON.stringify(embed.toJSON()));
    lines.push(`[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || message.author?.id || '未知用户'} (${message.author?.id || '未知'})\n所在位置：${message.channel?.name || message.channelId} (${message.channelId})\n消息 ID：${message.id}\n${message.content || '[无文字]'}${attachments.length ? `\n${attachments.join('\n')}` : ''}${embeds.length ? `\n嵌入内容：${embeds.join('\n')}` : ''}\n`);
  }
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const addition = `${line}\n`;
    if (Buffer.byteLength(addition, 'utf8') > 4 * 1024 * 1024) throw new Error('单条消息过大，无法安全导出。频道未删除。');
    if (current && Buffer.byteLength(current + addition, 'utf8') > 4 * 1024 * 1024) {
      chunks.push(current);
      current = '';
    }
    current += addition;
  }
  if (current) chunks.push(current);
  if (chunks.length > 10) throw new Error('聊天记录超过 10 个附件，无法一次完整保存。频道未删除。');
  return { count: messages.length, newestIds,
    files: chunks.map((content, index) => ({
      attachment: Buffer.from(encryptJson({ kind: 'emergency-transcript', caseId, part: index + 1, content }), 'utf8'),
      name: `emergency-${caseId}-${index + 1}.json.enc`,
    })) };
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
  const requester = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!requester?.roles.cache.has(managerRoleId)) {
    await interaction.editReply('只有当前主管理组成员可以发起或审批管理组删帖。');
    return;
  }
  if (!setting.managementDeleteApprovalChannelId) {
    await interaction.editReply('尚未设置管理组删帖审批频道。请先运行 `/管理删帖面板`，选择一个 Bot 可发消息的审批频道。');
    return;
  }
  const approvalChannel = await interaction.guild.channels.fetch(setting.managementDeleteApprovalChannelId).catch(() => null);
  const botMember = await interaction.guild.members.fetchMe();
  const approvalPermissions = approvalChannel?.permissionsFor(botMember);
  if (!approvalChannel?.isTextBased?.() || !approvalChannel.send
    || !approvalPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await interaction.editReply('管理组删帖审批频道不可用，或 Bot 缺少查看、发送消息和嵌入链接权限。请在 `/管理删帖面板` 重新配置。');
    return;
  }
  const parsed = parseDiscordMessageLink(link);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.editReply('请提供本服务器帖子内一条消息的 Discord 链接。');
    return;
  }
  const proposal = {
    id: randomBytes(6).toString('hex'), guildId: interaction.guildId, kind: 'management-delete',
    requesterId: interaction.user.id, targetLink: link, channelId: parsed.channelId, threadId: parsed.threadId, messageId: parsed.messageId,
    action: 'delete-thread', actionLabel: '删除整个帖子', deleteTargetType: 'thread',
    status: 'pending_management', managementRoleId: managerRoleId, managementVotesRequired: 3,
    managementVotes: [{ userId: interaction.user.id, choice: 'yes', votedAt: Date.now(), requesterVote: true }],
    createdAt: Date.now(),
  };
  try {
    const target = await resolveModerationTarget(interaction.guild, proposal);
    if (!target.channel.isThread()) throw new Error('链接没有指向帖子。请复制帖子内一条消息的链接，或直接复制帖子链接。');
    // Store a canonical thread identity so links copied from the parent forum,
    // from inside a thread, and from a thread message all deduplicate alike.
    proposal.channelId = target.channel.parentId || target.channel.id;
    proposal.threadId = target.channel.id;
    proposal.messageId = null;
  } catch (error) {
    await interaction.editReply(`目标无法用于管理组删帖：${error.message}`);
    return;
  }
  const targetKey = moderationProposalResourceKey(proposal);

  // Invalidate pre-three-person, one-click management delete confirmations.
  // Leaving their buttons alive would let an old card bypass the current rule.
  const legacyConfirmations = (guildData.moderationProposals || []).filter((item) =>
    item.guildId === interaction.guildId && item.kind === 'management-delete'
    && item.status === 'awaiting_management_confirmation'
    && (!item.managementVotesRequired || (item.managementVotes || []).filter((vote) => vote.choice === 'yes').length < 3));
  for (const legacy of legacyConfirmations) {
    resetManagementDeleteConfirmation(legacy, 'cancelled');
    legacy.failure = '旧版单人确认流程已作废；请重新发起三人管理组审批。';
  }
  if (legacyConfirmations.length) {
    await saveGuildData();
    await Promise.all(legacyConfirmations.map((legacy) => updateManagementDeleteApprovalCard(interaction.guild, legacy).catch(() => {})));
  }
  const duplicate = (guildData.moderationProposals || []).find((item) => item.guildId === interaction.guildId
    && isOpenModerationProposal(item) && Date.now() - item.createdAt < MODERATION_PROPOSAL_TTL
    && (moderationProposalResourceKey(item) === targetKey
      || (item.kind === 'management-delete'
        && [item.threadId, item.messageId, item.channelId].includes(proposal.threadId))));
  if (duplicate) {
    await interaction.editReply(`这个帖子已有未完成的操作申请（编号：${duplicate.id}），当前同意 ${duplicate.managementVotes?.filter((vote) => vote.choice === 'yes').length || 0}/${duplicate.managementVotesRequired || 3} 票；请到审批频道继续处理。`);
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
    try {
      proposal.approvalChannelId = approvalChannel.id;
      const approvalMessage = await approvalChannel.send({
        embeds: [moderationProposalEmbed(proposal)],
        components: managementDeleteVoteComponents(proposal),
        allowedMentions: { parse: [] },
      });
      proposal.approvalMessageId = approvalMessage.id;
      await saveGuildData();
      await notifyManagementDeleteOffice(interaction.guild, proposal).catch((error) => logFailure('管理组删帖办公室提醒发送失败。', error));
      await interaction.editReply(`管理组删帖申请已提交至 <#${approvalChannel.id}>。发起人已计 1 票，需 3 名不同主管理组成员同意（申请编号：${proposal.id}）。`);
    } catch (error) {
      guildData.moderationProposals = guildData.moderationProposals.filter((item) => item.id !== proposal.id);
      await saveGuildData().catch((saveError) => logFailure('管理组删帖申请发送失败后的状态清理失败。', saveError));
      throw error;
    }
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
  const requester = await interaction.guild.members.fetch(interaction.user.id);
  const allowedRoleIds = configuredManagementRoleIds(setting);
  const hasManagerRole = [...allowedRoleIds].some((roleId) => requester.roles.cache.has(roleId));
  const hasServerAdminPermission = requester.permissions.has(PermissionFlagsBits.Administrator)
    || requester.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!hasManagerRole && !hasServerAdminPermission) {
    await interaction.editReply(allowedRoleIds.size
      ? '您不具备该权限：需要管理组/中层管理身份组，或“管理服务器”权限。'
      : '尚未配置管理组或中层管理身份组。请先运行 `/管理组面板` 配置；服务器管理员仍可执行解锁。');
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
  const parentChannel = target.channel.parentId
    ? await interaction.guild.channels.fetch(target.channel.parentId).catch(() => null)
    : null;
  const permissions = target.channel.permissionsFor(botMember);
  const parentPermissions = parentChannel?.permissionsFor(botMember);
  const botCanManageThreads = botMember.permissions.has(PermissionFlagsBits.Administrator)
    || permissions?.has(PermissionFlagsBits.ManageThreads)
    || parentPermissions?.has(PermissionFlagsBits.ManageThreads);
  if (!botCanManageThreads) throw new Error('Bot 在目标帖子或所属父频道缺少“管理帖子”权限；请检查父论坛/文字频道的权限覆盖。');
  const auditReason = `管理组解锁（${proposal.id}），操作人 ${interaction.user.id}`;
  if (target.channel.archived || target.channel.locked) {
    try {
      await target.channel.edit({ archived: false, locked: false, reason: auditReason });
    } catch (error) {
      if ((error.code ?? error.rawError?.code) === 50013) {
        throw new Error('Discord 拒绝了解锁请求（Missing Permissions）。请确认 Bot 在帖子所属父频道拥有“管理帖子”权限，并且能访问该帖子。');
      }
      throw error;
    }
  }

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
  const announcementEmbed = (description = '') => new EmbedBuilder().setColor(0x5865F2)
    .setTitle('管理组锁定帖子公示')
    .setDescription(`操作人：<@${interaction.user.id}>\n帖子：${proposal.targetLink}\n操作：锁定并关闭\n锁定理由：${reason}\n操作编号：${proposal.id}${description ? `\n\n${description}` : ''}`)
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
    if (sameChannelAsTarget && announcementChannel && !target.channel.archived) {
      try {
        announcementMessage = await announcementChannel.send({
          embeds: [announcementEmbed()],
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
        // The complete notice was posted before archiving. Discord can reject
        // edits to archived threads even when the lock itself succeeded.
        if ((error.code ?? error.rawError?.code) !== 50083) announcementError ||= error;
      }
    } else {
      const panelChannel = !sameChannelAsTarget && !(announcementChannel?.isThread() && announcementChannel.archived)
        ? announcementChannel : null;
      const fallbackChannel = panelChannel || (settingsFor(interaction.guildId).managementDeleteApprovalChannelId
        ? await interaction.guild.channels.fetch(settingsFor(interaction.guildId).managementDeleteApprovalChannelId).catch(() => null)
        : null);
      const logChannel = fallbackChannel?.isTextBased?.() && typeof fallbackChannel.send === 'function'
        && !(fallbackChannel.isThread() && fallbackChannel.archived) ? fallbackChannel : null;
      if (logChannel) {
        try {
          await logChannel.send({ embeds: [announcementEmbed('帖子已锁定并关闭。')], allowedMentions: { parse: [] } });
          announcedInChannelId = logChannel.id;
          announcementError = null;
        } catch (error) {
          announcementError ||= error;
        }
      } else if (!announcementError) {
        announcementError = new Error('当前帖子已归档，且没有可发送公示的非归档频道。');
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
    components: proposal.status === 'pending_management'
      ? managementDeleteVoteComponents(proposal)
      : proposal.status === 'awaiting_management_confirmation' && proposal.pendingManagementConfirmation
        ? managementDeleteConfirmationComponents(proposal.id, proposal.pendingManagementConfirmation.token,
          Date.now() < proposal.pendingManagementConfirmation.confirmAfter)
        : [],
  });
  return true;
}

function schedulePersistedManagementDeleteConfirmations() {
  const now = Date.now();
  const retired = [];
  let changed = false;
  for (const proposal of guildData.moderationProposals || []) {
    if (proposal.kind !== 'management-delete' || proposal.status !== 'awaiting_management_confirmation') continue;
    const yesVoterIds = new Set((proposal.managementVotes || []).filter((vote) => vote.choice === 'yes').map((vote) => vote.userId));
    const pending = proposal.pendingManagementConfirmation;
    if (!proposal.managementVotesRequired || yesVoterIds.size < 3 || !proposal.finalApproverId || pending?.userId !== proposal.finalApproverId) {
      resetManagementDeleteConfirmation(proposal, 'cancelled');
      proposal.failure = '旧版单人确认卡不符合三人审批规则，已自动作废；请重新发起。';
      retired.push(proposal);
      changed = true;
      continue;
    }
    pending.confirmAfter = Number(pending.confirmAfter || now);
    pending.expiresAt = Number(pending.expiresAt || now + 5 * 60 * 1000);
    scheduleManagementDeleteConfirmation(proposal, null);
  }
  if (changed) {
    saveGuildData()
      .then(() => Promise.all(retired.map((proposal) => client.guilds.fetch(proposal.guildId)
        .then((guild) => updateManagementDeleteApprovalCard(guild, proposal))
        .catch((error) => logFailure('旧版管理组删帖确认卡作废失败。', error)))))
      .catch((error) => logFailure('旧版管理组删帖确认流程作废状态保存失败。', error));
  }
}

function scheduleManagementDeleteConfirmation(proposal, confirmationInteraction) {
  const proposalId = proposal.id;
  const token = proposal.pendingManagementConfirmation.token;
  const enableAt = proposal.pendingManagementConfirmation.confirmAfter;
  const expiresAt = proposal.pendingManagementConfirmation.expiresAt;
  const enableTimer = setTimeout(() => {
    const current = (guildData.moderationProposals || []).find((item) => item.guildId === proposal.guildId && item.id === proposalId);
    if (current?.status === 'awaiting_management_confirmation' && current.pendingManagementConfirmation?.token === token) {
      client.guilds.fetch(proposal.guildId).then((guild) => updateManagementDeleteApprovalCard(guild, current))
        .catch((error) => logFailure('管理组删帖最终确认按钮启用失败。', error));
      if (confirmationInteraction) confirmationInteraction.editReply({
        content: '5 秒等待已结束。请前往审批卡完成最终确认。',
        components: [],
      }).catch((error) => logFailure('管理组删帖确认提示更新失败。', error));
    }
  }, Math.max(0, enableAt - Date.now()));
  enableTimer.unref?.();

  const expireTimer = setTimeout(async () => {
    const current = (guildData.moderationProposals || []).find((item) => item.guildId === proposal.guildId && item.id === proposalId);
    if (current?.status !== 'awaiting_management_confirmation' || current.pendingManagementConfirmation?.token !== token) return;
    resetManagementDeleteConfirmation(current, 'expired');
    try {
      await saveGuildData();
      const guild = await client.guilds.fetch(proposal.guildId);
      await updateManagementDeleteApprovalCard(guild, current);
      if (confirmationInteraction) await confirmationInteraction.editReply({ content: '最终确认已过期，帖子没有删除。请重新发起管理组删帖操作。', components: [] }).catch(() => {});
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
  const [, choice, proposalId] = interaction.customId.split(':');
  if (!['yes', 'no'].includes(choice)) {
    await interaction.reply({ content: '无效的投票操作。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const lockKey = `${interaction.guildId}:${proposalId}`;
  if (activeManagementDeleteVotes.has(lockKey)) {
    await interaction.reply({ content: '这项审批正在处理另一张投票，请稍后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  activeManagementDeleteVotes.add(lockKey);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const proposal = (guildData.moderationProposals || []).find((item) => item.id === proposalId && item.guildId === interaction.guildId && item.kind === 'management-delete');
    if (!proposal || proposal.status !== 'pending_management') {
      await interaction.editReply('这项管理组删帖审批已处理、过期或不在投票阶段。').catch(() => {});
      return;
    }
    // Migrate still-open requests from the older configurable-vote schema to
    // the fixed three-person policy before accepting another approval.
    proposal.managementVotesRequired = 3;
    proposal.managementVotes ||= [];
    if (!proposal.managementVotes.some((vote) => vote.userId === proposal.requesterId)) {
      proposal.managementVotes.unshift({ userId: proposal.requesterId, choice: 'yes', votedAt: proposal.createdAt, requesterVote: true });
    }
    if (Date.now() - proposal.createdAt > MODERATION_PROPOSAL_TTL) {
      proposal.status = 'expired';
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch(() => {});
      await interaction.editReply('这项管理组删帖审批已超过 24 小时，不能再投票。').catch(() => {});
      return;
    }
    const setting = settingsFor(interaction.guildId);
    const currentManagerRoleId = managementTrack(setting, 'senior').roleId;
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !currentManagerRoleId || currentManagerRoleId !== proposal.managementRoleId || !member.roles.cache.has(currentManagerRoleId)) {
      await interaction.editReply('只有当前主管理组成员可以审批此删帖申请。').catch(() => {});
      return;
    }
    proposal.managementVotes ||= [];
    if (proposal.managementVotes.some((vote) => vote.userId === interaction.user.id)) {
      await interaction.editReply('你已经对此帖子投过票，不能重复计票。').catch(() => {});
      return;
    }
    proposal.managementVotes.push({ userId: interaction.user.id, choice, votedAt: Date.now() });
    if (choice === 'no') {
      proposal.status = 'rejected';
      proposal.failure = '主管理组成员拒绝了删帖申请';
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('拒绝后的管理组删帖卡更新失败。', error));
      await notifyManagementDeleteOffice(interaction.guild, proposal).catch((error) => logFailure('管理组删帖结果提醒发送失败。', error));
      await interaction.editReply('已记录拒绝票，申请已结束，帖子没有删除。').catch(() => {});
      return;
    }
    const yesVotes = proposal.managementVotes.filter((vote) => vote.choice === 'yes').length;
    if (yesVotes >= (proposal.managementVotesRequired || 3)) {
      const now = Date.now();
      const token = randomBytes(8).toString('hex');
      proposal.status = 'awaiting_management_confirmation';
      proposal.finalApproverId = interaction.user.id;
      proposal.pendingManagementConfirmation = { token, userId: interaction.user.id, confirmAfter: now + 5000, expiresAt: now + 5 * 60 * 1000 };
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('第三票后的管理组删帖确认卡更新失败。', error));
      scheduleManagementDeleteConfirmation(proposal, null);
      await notifyManagementDeleteOffice(interaction.guild, proposal).catch((error) => logFailure('管理组删帖最终确认提醒发送失败。', error));
      const approvalUrl = proposal.approvalChannelId && proposal.approvalMessageId
        ? `\n最终确认卡：https://discord.com/channels/${proposal.guildId}/${proposal.approvalChannelId}/${proposal.approvalMessageId}` : '';
      await interaction.editReply(`已记录第 3 张同意票。请由你作为最后审批者，在审批频道的警示卡等待 5 秒后点击最终确认；确认后帖子会立即被删除，无法恢复。${approvalUrl}`).catch(() => {});
      return;
    }
    await saveGuildData();
    await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch((error) => logFailure('管理组删帖投票卡更新失败。', error));
    await interaction.editReply(`已记录同意票：${yesVotes}/${proposal.managementVotesRequired || 3}。帖子尚未删除。`).catch(() => {});
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
    const configuredManagerRoleId = managementTrack(settingsFor(interaction.guildId), 'senior').roleId;
    const yesVotes = proposal.managementVotes?.filter((vote) => vote.choice === 'yes') || [];
    if (!proposal.managementRoleId || configuredManagerRoleId !== proposal.managementRoleId
      || !member.roles.cache.has(proposal.managementRoleId) || interaction.user.id !== proposal.finalApproverId
      || yesVotes.length < (proposal.managementVotesRequired || 3)) {
      resetManagementDeleteConfirmation(proposal);
      await saveGuildData();
      await updateManagementDeleteApprovalCard(interaction.guild, proposal).catch(() => {});
      await interaction.editReply({ content: '最终审批者身份组或三人审批条件已失效；帖子没有删除。', components: [] }).catch(() => {});
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
        new ButtonBuilder().setCustomId(`${prefix}-companion-config:${guildId}`).setLabel('配置配套身份组').setStyle(ButtonStyle.Secondary),
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
    const groupLines = groups.map((group) => `${group.roleId ? `<@&${group.roleId}>` : '身份组未设置'} · 配套 ${managementTrack(setting, 'middle', group.roleId).companionRoleIds.map((id) => `<@&${id}>`).join('、') || '无'} · 实时名单 ${group.channelId ? `<#${group.channelId}>` : '未创建'} · 任免公示 ${group.announcementChannelId ? `<#${group.announcementChannelId}>` : '首次变更时自动创建'}`);
    const list = groupLines.length
      ? `${groupLines.slice(0, 15).join('\n')}${groupLines.length > 15 ? `\n……另有 ${groupLines.length - 15} 个身份组` : ''}`
      : '尚未配置中层身份组。';
    return new EmbedBuilder().setColor(0x5865F2).setTitle('中层管理公示与任命面板')
      .setDescription(`每个中层身份组分别管理实时名单子区、任免公示子区和最多 4 个配套身份组；卸任时会一起移除该组配套身份。\n\n已配置身份组：${groups.length}\n${list}\n\n先选择要配置的中层身份组，再点“配置配套身份组”选择最多 4 个角色。`);
  }
  const track = managementTrack(setting, tier);
  return new EmbedBuilder().setColor(0x5865F2).setTitle(`${track.label}任命面板`)
    .setDescription(`实时名单位置：${track.channelId ? `<#${track.channelId}>` : '尚未设置'}\n任免公示子区：${track.announcementChannelId ? `<#${track.announcementChannelId}>` : '尚未创建'}\n${track.label}身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n配套身份组：${track.companionRoleIds.map((id) => `<@&${id}>`).join('、') || '尚未设置'}\n当前任职人数：${track.terms.filter((term) => !term.endedAt && !term.isBot).length}\n\n使用上方菜单配置频道和管理组身份组；点“配置配套身份组”最多选择 4 个身份组。任命时自动发放，卸任时一并移除。任免记录发送到任免公示子区，实时名单位置保持不变。Bot 账号不计入名单。`);
}

function managementCompanionRolePanel(guildId, tier = 'senior', roleId = null) {
  const setting = settingsFor(guildId);
  const track = managementTrack(setting, tier, roleId);
  const guild = client.guilds.cache.get(guildId);
  const selectedRoleIds = (track.companionRoleIds || []).filter((id) => guild?.roles.cache.has(id));
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`${track.prefix}-companion-roles:${guildId}:${track.roleId || ''}`)
    .setPlaceholder('选择 0 到 4 个配套身份组')
    .setMinValues(0).setMaxValues(4);
  if (selectedRoleIds.length) roleSelect.setDefaultRoles(...selectedRoleIds);
  return {
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${track.label}配套身份组`)
      .setDescription(`管理身份组：${track.roleId ? `<@&${track.roleId}>` : '尚未设置'}\n当前配套身份组：${track.companionRoleIds.map((id) => `<@&${id}>`).join('、') || '无'}\n\n选择最多 4 个配套身份组后，Bot 会为现有在任成员补发。之后任命会自动发放，卸任或移除管理身份时会一并移除不再需要的配套身份组。此设置会替换该管理身份组当前的配套列表。`)],
    components: [new ActionRowBuilder().addComponents(roleSelect)],
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

async function syncManagementCompanionRolesForMember(member, previousRoleIds = [], botMember = null) {
  if (!member?.user || member.user.bot) return { granted: 0, removed: 0 };
  const setting = settingsFor(member.guild.id);
  const managedRoleIds = configuredCompanionRoleIds(setting, previousRoleIds);
  const desiredRoleIds = companionRoleIdsForMember(member);
  const addRoleIds = [...desiredRoleIds].filter((roleId) => !member.roles.cache.has(roleId));
  const removeRoleIds = [...managedRoleIds].filter((roleId) => !desiredRoleIds.has(roleId) && member.roles.cache.has(roleId));
  if (!addRoleIds.length && !removeRoleIds.length) return { granted: 0, removed: 0 };

  const bot = botMember || await member.guild.members.fetchMe();
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot 缺少“管理身份组”权限。');
  const roles = await Promise.all([...new Set([...addRoleIds, ...removeRoleIds])]
    .map((roleId) => member.guild.roles.fetch(roleId).catch(() => null)));
  if (roles.some((role) => !role || role.managed || role.id === member.guild.id || role.position >= bot.roles.highest.position)) {
    throw new Error('配套身份组无效或层级不低于 Bot；无法同步发放/移除。');
  }
  if (addRoleIds.length) await member.roles.add(addRoleIds, '自动同步管理身份组配套身份');
  if (removeRoleIds.length) await member.roles.remove(removeRoleIds, '管理身份已变更，移除不再适用的配套身份组');
  return { granted: addRoleIds.length, removed: removeRoleIds.length };
}

async function syncManagementCompanionRoles(guild, previousRoleIds = []) {
  const setting = settingsFor(guild.id);
  const tracks = managementTracks(setting).filter(([, , track]) => track.roleId);
  const managedRoleIds = configuredCompanionRoleIds(setting, previousRoleIds);
  if (!managedRoleIds.size) return { configured: false, granted: 0, removed: 0, failed: 0, holders: 0 };
  const mainRoleIds = new Set(tracks.map(([, , track]) => track.roleId));
  for (const [, , track] of tracks) {
    if ((track.companionRoleIds || []).some((roleId) => mainRoleIds.has(roleId))) {
      throw new Error(`${track.label}配套身份组不能同时作为管理身份组使用。`);
    }
  }
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot 缺少“管理身份组”权限。');
  let granted = 0;
  let removed = 0;
  let failed = 0;
  let holders = 0;
  await forEachGuildMemberPage(guild, async (page) => {
    for (const data of page) {
      const user = data?.user;
      if (!user?.id || user.bot) continue;
      const memberRoleIds = new Set(data.roles || []);
      const desiredRoleIds = new Set(tracks
        .filter(([, , track]) => memberRoleIds.has(track.roleId))
        .flatMap(([, , track]) => track.companionRoleIds || []));
      const needsSync = [...desiredRoleIds].some((roleId) => !memberRoleIds.has(roleId))
        || [...managedRoleIds].some((roleId) => memberRoleIds.has(roleId) && !desiredRoleIds.has(roleId));
      if (!needsSync) {
        if (desiredRoleIds.size) holders += 1;
        continue;
      }
      try {
        const member = await guild.members.fetch({ user: user.id, force: true, cache: false });
        const result = await syncManagementCompanionRolesForMember(member, previousRoleIds, botMember);
        granted += result.granted;
        removed += result.removed;
        if (desiredRoleIds.size) holders += 1;
      } catch (error) {
        failed += 1;
        logFailure(`无法同步成员 ${user.id} 的管理组配套身份组。`, error);
      }
    }
  });
  return { configured: true, granted, removed, failed, holders };
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

function queueManagementPanelSync(guild, work, label) {
  // Large guilds may need longer than Discord's 15-minute interaction-token
  // lifetime to enumerate members. Never use that token after starting a scan.
  const previous = activeManagementPanelSyncs.get(guild.id) || Promise.resolve();
  const sync = previous.catch(() => {}).then(work);
  activeManagementPanelSyncs.set(guild.id, sync);
  void sync.then((summary) => console.log(`${label}已完成。${summary ? ` ${JSON.stringify(summary)}` : ''}`))
    .catch((error) => logFailure(`${label}失败。`, error))
    .finally(() => {
      if (activeManagementPanelSyncs.get(guild.id) === sync) activeManagementPanelSyncs.delete(guild.id);
    });
}

async function reconcileManagementMember(member, hasRole, tier = 'senior', roleId = null) {
  if (member.user.bot) return;
  const guild = member.guild;
  const setting = settingsFor(guild.id);
  const track = managementTrack(setting, tier, roleId);
  await syncManagementCompanionRolesForMember(member).catch((error) => logFailure(`成员 ${member.id} 的管理组配套身份组同步失败。`, error));
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
  const companionRoleResults = await Promise.all((track.companionRoleIds || []).map((id) => guild.roles.fetch(id).catch(() => null)));
  const companionRoles = companionRoleResults.filter(Boolean);
  const invalidCompanionRole = action === '任命'
    ? companionRoleResults.some((companionRole) => !companionRole)
      || companionRoles.some((companionRole) => companionRole.managed || companionRole.id === guild.id || companionRole.id === role.id
        || companionRole.position >= botMember.roles.highest.position)
    : members.some((member) => companionRoles.some((companionRole) => member.roles.cache.has(companionRole.id)
      && (companionRole.managed || companionRole.id === guild.id || companionRole.id === role.id
        || companionRole.position >= botMember.roles.highest.position)));
  if (invalidCompanionRole) {
    throw new Error(`${track.label}配套身份组无效；请选择不受集成管理、不同于管理身份组且层级低于 Bot 的身份组。`);
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
      const addRoles = [role, ...companionRoles].filter((targetRole) => !member.roles.cache.has(targetRole.id));
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
    const futureCompanionRoleIds = companionRoleIdsForMember(member, new Set([role.id]));
    const removeRoles = [role, ...companionRoles.filter((companionRole) => !futureCompanionRoleIds.has(companionRole.id))]
      .filter((targetRole) => member.roles.cache.has(targetRole.id));
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

async function roleMentionOverMemberLimit(guild, roles, limit) {
  const counts = new Map(roles.map((role) => [role.id, 0]));
  let after;
  while (true) {
    const members = await guild.members.list({ limit: 1000, ...(after ? { after } : {}), cache: false });
    for (const member of members.values()) {
      for (const role of roles) {
        if (!member.roles.cache.has(role.id)) continue;
        const count = counts.get(role.id) + 1;
        if (count > limit) return role;
        counts.set(role.id, count);
      }
    }
    if (members.size < 1000) return null;
    const nextAfter = members.lastKey();
    if (!nextAfter || nextAfter === after) throw new Error('成员列表分页未能继续读取。');
    after = nextAfter;
  }
}

async function resolveSpeechArchiveChannel() {
  if (!speechArchiveChannelId) throw new Error('尚未配置 DISCORD_SPEECH_ARCHIVE_CHANNEL_ID。');
  const channel = await client.channels.fetch(speechArchiveChannelId);
  if (!channel || channel.type !== ChannelType.GuildText || !storageChannel?.guildId
    || channel.guildId !== storageChannel.guildId || channel.id === storageChannelId) {
    throw new Error('说话留档频道必须是信息存储服务器内独立的文字频道。');
  }
  const permissions = channel.permissionsFor(client.user);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles])) {
    throw new Error('Bot 在说话留档频道缺少查看、发言、读取历史或附加文件权限。');
  }
  if (channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('说话留档频道对 @everyone 可见；请先把它设为私密频道。');
  }
  return channel;
}

function speechArchiveSummary(interaction, archiveId, managementSpeech, status, messageUrl) {
  return `说话留档 ${archiveId}\n操作人：<@${interaction.user.id}> (${interaction.user.id})\n指令：/${managementSpeech ? '管理说话' : '说话'}\n原频道：<#${interaction.channelId}> (${interaction.channelId})\n状态：${status}${messageUrl ? `\n已发送消息：${messageUrl}` : ''}\n发言正文与图片链接保存在本消息的加密附件中。`;
}

async function beginSpeechArchive(interaction, managementSpeech, messageContent, pictures, replyLink) {
  const channel = await resolveSpeechArchiveChannel();
  const archiveId = randomBytes(8).toString('hex');
  const data = {
    kind: 'speech-archive', archiveId, guildId: interaction.guildId, channelId: interaction.channelId,
    operatorId: interaction.user.id, command: managementSpeech ? '管理说话' : '说话',
    interactionId: interaction.id, recordedAt: new Date().toISOString(), content: messageContent,
    replyLink: replyLink || null,
    pictures: pictures.map((picture) => ({ name: picture.name, url: picture.url, size: picture.size })),
  };
  const message = await channel.send({
    content: speechArchiveSummary(interaction, archiveId, managementSpeech, '准备发送'),
    files: [{ attachment: Buffer.from(encryptJson(data), 'utf8'), name: `speech-archive-${archiveId}.json.enc` }],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`speech-archive-view:${archiveId}`).setLabel('查看加密记录').setStyle(ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  });
  return { archiveId, message };
}

async function updateSpeechArchive(interaction, archive, managementSpeech, status, messageUrl) {
  await archive.message.edit({
    content: speechArchiveSummary(interaction, archive.archiveId, managementSpeech, status, messageUrl),
    attachments: [...archive.message.attachments.values()].map((attachment) => ({ id: attachment.id })),
    allowedMentions: { parse: [] },
  });
}

function imitatesManagementSpeech(content) {
  const normalized = String(content || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
  return normalized.includes(MANAGEMENT_SPEECH_TITLE)
    || normalized.includes('管理组认证')
    || normalized.includes('点击核验管理组发言')
    || normalized.includes('认证通过这条消息由管理组成员');
}

function managementSpeechSignature(guildId, channelId, actorId, nonce, body) {
  return createHmac('sha256', encryptionKey())
    .update(JSON.stringify(['management-speech-v1', guildId, channelId, actorId, nonce, body]))
    .digest('hex');
}

function isConfiguredManagementMember(interaction) {
  if (!interaction.guildId) return false;
  const setting = settingsFor(interaction.guildId);
  const managementRoleIds = configuredManagementRoleIds(setting);
  const memberRoleCache = interaction.member?.roles?.cache;
  const memberRoleIds = memberRoleCache?.keys
    ? new Set(memberRoleCache.keys())
    : new Set(Array.isArray(interaction.member?.roles) ? interaction.member.roles : []);
  return [...managementRoleIds].some((roleId) => memberRoleIds.has(roleId));
}

function isConfiguredSeniorManagementMember(interaction) {
  if (!interaction.guildId) return false;
  const roleId = managementTrack(settingsFor(interaction.guildId), 'senior').roleId;
  if (!roleId) return false;
  const roles = interaction.member?.roles;
  return roles?.cache?.has(roleId) || (Array.isArray(roles) && roles.includes(roleId)) || false;
}

function configuredManagementRoleIds(setting) {
  return new Set([
    managementTrack(setting, 'senior').roleId,
    ...Object.keys(setting.middleManagementGroups || {}),
  ].filter(Boolean));
}

const permissionGroups = {
  administration: {
    label: '服务器管理',
    keys: ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ViewAuditLog', 'ViewGuildInsights', 'ManageWebhooks', 'ManageEmojisAndStickers', 'ManageGuildExpressions', 'ManageEvents', 'CreateEvents', 'ManageThreads', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ChangeNickname', 'CreateInstantInvite', 'ViewCreatorMonetizationAnalytics', 'CreateGuildExpressions'],
  },
  text: {
    label: '文字与论坛',
    keys: ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'ManageMessages', 'PinMessages', 'AddReactions', 'EmbedLinks', 'AttachFiles', 'MentionEveryone', 'UseExternalEmojis', 'UseExternalStickers', 'CreatePublicThreads', 'CreatePrivateThreads', 'UseApplicationCommands', 'UseExternalApps', 'SendTTSMessages', 'SendVoiceMessages', 'SendPolls', 'BypassSlowmode'],
  },
  voice: {
    label: '语音与舞台',
    keys: ['Connect', 'Speak', 'Stream', 'PrioritySpeaker', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'UseVAD', 'RequestToSpeak', 'UseEmbeddedActivities', 'UseSoundboard', 'UseExternalSounds', 'SetVoiceChannelStatus'],
  },
};

// Build the panel from every permission flag shipped by the installed discord.js
// API definitions. The hand-curated groups only provide readable organization;
// they must never limit which Discord permissions the panel can expose.
const allDiscordPermissionKeys = Object.keys(PermissionFlagsBits);
const assignedPermissionKeys = new Set();
for (const group of Object.values(permissionGroups)) {
  group.keys = group.keys.filter((key) => allDiscordPermissionKeys.includes(key) && !assignedPermissionKeys.has(key));
  for (const key of group.keys) assignedPermissionKeys.add(key);
}
const unassignedPermissionKeys = allDiscordPermissionKeys.filter((key) => !assignedPermissionKeys.has(key));
for (let offset = 0, index = 1; offset < unassignedPermissionKeys.length; offset += 25, index += 1) {
  permissionGroups['discovered_' + index] = {
    label: unassignedPermissionKeys.length > 25 ? '其他权限（自动发现 ' + index + '）' : '其他权限（自动发现）',
    keys: unassignedPermissionKeys.slice(offset, offset + 25),
  };
}

const permissionLabels = {
  CreateInstantInvite: '创建邀请', KickMembers: '踢出成员', BanMembers: '封禁成员',
  Administrator: '管理员（绕过频道限制）', ManageChannels: '管理频道', ManageGuild: '管理服务器',
  AddReactions: '添加表情反应', ViewAuditLog: '查看审计日志', PrioritySpeaker: '优先发言',
  Stream: '视频/直播', ViewChannel: '查看频道', SendMessages: '发送消息',
  SendTTSMessages: '发送 TTS 消息', ManageMessages: '管理消息', EmbedLinks: '嵌入链接',
  AttachFiles: '附加文件', ReadMessageHistory: '读取消息历史', MentionEveryone: '提及 @everyone',
  UseExternalEmojis: '使用外部表情', ViewGuildInsights: '查看服务器数据分析', Connect: '连接语音',
  Speak: '语音发言', MuteMembers: '语音静音成员', DeafenMembers: '语音拒听成员',
  MoveMembers: '移动语音成员', UseVAD: '使用语音活动检测', ChangeNickname: '修改自己的昵称',
  ManageNicknames: '管理昵称', ManageRoles: '管理身份组', ManageWebhooks: '管理 Webhook',
  ManageEmojisAndStickers: '管理表情和贴纸', ManageGuildExpressions: '管理表情、贴纸和音效',
  UseApplicationCommands: '使用应用命令', RequestToSpeak: '申请舞台发言',
  ManageEvents: '管理活动', ManageThreads: '管理帖子', CreatePublicThreads: '创建公开帖子',
  CreatePrivateThreads: '创建私密帖子', UseExternalStickers: '使用外部贴纸',
  SendMessagesInThreads: '在帖子中发言', UseEmbeddedActivities: '使用应用活动',
  ModerateMembers: '管理超时', ViewCreatorMonetizationAnalytics: '查看创作者收益数据',
  UseSoundboard: '使用音效板', CreateGuildExpressions: '创建表情、贴纸和音效',
  CreateEvents: '创建活动', UseExternalSounds: '使用外部音效', SendVoiceMessages: '发送语音消息',
  SetVoiceChannelStatus: '设置语音频道状态', SendPolls: '发送投票', UseExternalApps: '使用外部应用',
  PinMessages: '置顶消息', BypassSlowmode: '绕过慢速模式',
};

function permissionLabel(key) {
  return permissionLabels[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// These permissions exist only at server/member level and cannot be meaningfully
// set as per-channel overwrites. All other installed Discord permission flags
// remain available in channel scopes, including flags added by newer discord.js.
const serverOnlyPermissionKeys = new Set([
  'Administrator', 'KickMembers', 'BanMembers', 'ManageGuild', 'ViewAuditLog',
  'ViewGuildInsights', 'ChangeNickname', 'ManageNicknames', 'ModerateMembers',
  'ViewCreatorMonetizationAnalytics', 'CreateEvents', 'CreateGuildExpressions', 'ManageGuildExpressions',
]);
const permissionPanelSessions = new Map();
const pendingPunishmentRecordRemovals = new Map();
const permissionKeyToCategory = new Map(Object.entries(permissionGroups).flatMap(([category, group]) => group.keys.map((key) => [key, category])));

function channelPermissionsFor(channel, categoryKey) {
  if (!channel?.permissionOverwrites || !permissionGroups[categoryKey]) return [];
  // Overwrites are stored as permission bitsets, not separate text/voice lists.
  // Expose every non-server-only bit for each channel so newer flags and less
  // common channel types are not silently omitted from the control panel.
  return permissionGroups[categoryKey].keys.filter((key) => !serverOnlyPermissionKeys.has(key));
}

function permissionPanelEmbed(guild, session = {}) {
  const setting = settingsFor(guild.id);
  const role = session.roleId ? guild.roles.cache.get(session.roleId) : null;
  const scopeLabel = session.scope === 'guild' ? '服务器身份组权限'
    : session.scope === 'all' ? '所有现有频道（并应用到新频道）'
      : session.scope === 'channel' ? (session.channelId ? '<#' + session.channelId + '>' : '选择单个频道') : '请选择范围';
  const category = permissionGroups[session.category || 'administration'];
  let current = '尚未选择身份组';
  if (role && session.scope === 'guild') {
    const currentKeys = category.keys.filter((key) => role.permissions.has(PermissionFlagsBits[key]));
    current = currentKeys.map(permissionLabel).join('、') || '此分类当前没有已授予的权限';
  } else if (role && session.scope === 'all') {
    current = '全频道当前权限可能各不相同。批量操作会覆盖所选权限，并保存同一规则供新建频道使用。';
  } else if (role && session.channelId) {
    const channel = guild.channels.cache.get(session.channelId);
    const keys = channel ? channelPermissionsFor(channel, session.category || 'administration') : [];
    const overwrite = channel?.permissionOverwrites?.cache?.get(role.id);
    const allowed = keys.filter((key) => overwrite?.allow.has(PermissionFlagsBits[key])).map(permissionLabel);
    const denied = keys.filter((key) => overwrite?.deny.has(PermissionFlagsBits[key])).map(permissionLabel);
    current = '允许：' + (allowed.join('、') || '无') + '\n拒绝：' + (denied.join('、') || '无') + '\n未覆盖的权限沿用服务器/分类设置。';
  } else if (role && session.scope && session.scope !== 'guild') {
    current = '选择频道后可查看该身份组当前允许、拒绝和继承的权限。';
  }
  const description = '已读取本服务器 ' + guild.channels.cache.size + ' 个频道/分类、' + guild.roles.cache.size + ' 个身份组和 ' + allDiscordPermissionKeys.length + ' 项 Discord 权限定义。权限清单从当前 discord.js/Discord API 权限位自动枚举，不限于 Bot 命令使用的权限。选择身份组、权限范围、分类和权限，再点按钮应用。\n\n'
    + '身份组：' + (role ? '<@&' + role.id + '>' : '尚未选择') + '\n范围：' + scopeLabel + '\n权限分类：' + category.label
    + '\n\n**当前权限概览**\n' + current.slice(0, 900)
    + '\n\n频道权限遵循 Discord 合并规则：管理员身份组会绕过频道覆盖；成员持有多个身份组时，频道允许/拒绝会按 Discord 规则合并；帖子继承父频道权限。'
    + '\n高危权限审计：' + (setting.permissionAlertChannelId ? '<#' + setting.permissionAlertChannelId + '>' : '未设置告警频道')
    + '\n自动扳回开关：' + (setting.permissionRollbackEnabled ? '开启（仅扳回已勾选的监控权限；审计事件到达后恢复，无法阻止保存瞬间生效）' : '关闭')
    + '\n单项监控权限：' + (setting.permissionMonitoredKeys.length ? setting.permissionMonitoredKeys.map(permissionLabel).join('、').slice(0, 500) : '未选择（不会因权限变更扳回）')
    + '\n扳回/警告白名单：' + (setting.permissionRollbackWhitelistUserIds.length ? setting.permissionRollbackWhitelistUserIds.map((id) => '<@' + id + '>').join('、') : '无')
    + '\n其他机器人：一律忽略权限变更'
    + '\n高危违规私信/处置策略：' + (setting.permissionEscalationEnabled ? '开启（前两次私信提醒；第三次移除可管理身份组并发放指定身份组）' : '关闭')
    + '\n第三次处置身份组：' + (setting.permissionEscalationRoleId ? '<@&' + setting.permissionEscalationRoleId + '>' : '未配置')
    + '\n处罚档案：可按处罚 ID 清除 Bot 内部档案；需二次确认，不会撤销已执行处罚或删除已发送的频道公示。';
  return new EmbedBuilder().setColor(0x5865F2).setTitle('服务器权限鉴定与配置面板').setDescription(description);
}

function permissionPanelComponents(session) {
  if (session.waitingFor === 'guard') {
    const setting = settingsFor(session.guild.id);
    const categoryKey = session.guardCategory || 'administration';
    const category = permissionGroups[categoryKey];
    const keys = category.keys;
    return [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('permission-guard-category:' + session.token).setPlaceholder('选择要单独设置的权限分类')
        .addOptions(Object.entries(permissionGroups).map(([value, group]) => ({ label: group.label, value, description: group.keys.length + ' 项权限' })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('permission-guard-flags:' + session.token)
        .setPlaceholder('勾选自动监控/扳回的权限（可多选）').setMinValues(0).setMaxValues(Math.min(25, keys.length || 1))
        .addOptions(keys.map((key) => ({ label: permissionLabel(key), value: key, default: (session.guardSelectedPermissions || setting.permissionMonitoredKeys).includes(key) })))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-guard-save:' + session.token).setLabel('保存单项监控权限').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('permission-back:' + session.token).setLabel('返回').setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  if (session.waitingFor === 'whitelist') {
    const setting = settingsFor(session.guild.id);
    return [
      new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
        .setCustomId('permission-whitelist-users:' + session.token)
        .setPlaceholder('选择要添加或移出白名单的成员')
        .setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-whitelist-add:' + session.token).setLabel('添加所选成员').setStyle(ButtonStyle.Success).setDisabled(!session.whitelistUserId),
        new ButtonBuilder().setCustomId('permission-whitelist-remove:' + session.token).setLabel('移出所选成员').setStyle(ButtonStyle.Secondary).setDisabled(!session.whitelistUserId || !setting.permissionRollbackWhitelistUserIds.includes(session.whitelistUserId)),
        new ButtonBuilder().setCustomId('permission-whitelist-clear:' + session.token).setLabel('清空').setStyle(ButtonStyle.Danger).setDisabled(!setting.permissionRollbackWhitelistUserIds.length),
        new ButtonBuilder().setCustomId('permission-back:' + session.token).setLabel('返回').setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  if (session.waitingFor === 'channel' || session.waitingFor === 'alert') {
    const customId = session.waitingFor === 'alert' ? 'permission-alert-channel:' + session.token : 'permission-channel:' + session.token;
    const select = new ChannelSelectMenuBuilder().setCustomId(customId)
      .setPlaceholder(session.waitingFor === 'alert' ? '选择高危权限告警频道或子区' : '选择要单独配置的频道')
      .setMinValues(1).setMaxValues(1)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
        ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory, ChannelType.PublicThread,
        ChannelType.PrivateThread, ChannelType.AnnouncementThread);
    const rows = [new ActionRowBuilder().addComponents(select)];
    if (session.waitingFor === 'alert') {
      const setting = settingsFor(session.guild.id);
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-toggle-rollback:' + session.token)
          .setLabel('非 Bot 变更自动恢复：' + (setting.permissionRollbackEnabled ? '开' : '关'))
          .setStyle(setting.permissionRollbackEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('permission-toggle-escalation:' + session.token)
          .setLabel('违规提醒/身份组处置：' + (setting.permissionEscalationEnabled ? '开' : '关'))
          .setStyle(setting.permissionEscalationEnabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('permission-back:' + session.token).setLabel('返回权限面板').setStyle(ButtonStyle.Secondary),
      ));
      rows.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('permission-sanction-role:' + session.token)
          .setPlaceholder(setting.permissionEscalationRoleId ? '第三次处置身份组：已配置' : '选择第三次处置后要发放的身份组')
          .setMinValues(1).setMaxValues(1),
      ));
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-open-guard:' + session.token).setLabel('单项监控权限').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('permission-open-whitelist:' + session.token).setLabel('编辑白名单（' + setting.permissionRollbackWhitelistUserIds.length + '）').setStyle(ButtonStyle.Secondary),
      ));
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-clear-sanction-role:' + session.token)
          .setLabel('清除第三次处置身份组').setStyle(ButtonStyle.Secondary).setDisabled(!setting.permissionEscalationRoleId),
      ));
    } else {
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('permission-back:' + session.token).setLabel('返回权限面板').setStyle(ButtonStyle.Secondary)));
    }
    return rows;
  }
  let permissionKeys = permissionGroups[session.category || 'administration'].keys;
  if (session.scope === 'all') {
    permissionKeys = permissionKeys.filter((key) => !serverOnlyPermissionKeys.has(key));
  } else if (session.scope && session.scope !== 'guild' && session.channelId) {
    permissionKeys = channelPermissionsFor(session.guild.channels.cache.get(session.channelId) || { type: ChannelType.GuildText }, session.category || 'administration');
  }
  const roleSelect = new RoleSelectMenuBuilder().setCustomId('permission-role:' + session.token).setPlaceholder('选择要配置的身份组').setMinValues(1).setMaxValues(1);
  const scopeSelect = new StringSelectMenuBuilder().setCustomId('permission-scope:' + session.token).setPlaceholder('选择权限范围').addOptions(
    { label: '服务器身份组权限', value: 'guild', description: '修改身份组本身的服务器权限' },
    { label: '所有频道', value: 'all', description: '覆盖全部现有频道，并应用到新频道' },
    { label: '单独频道', value: 'channel', description: '为身份组设置单个频道覆盖' },
  );
  const categorySelect = new StringSelectMenuBuilder().setCustomId('permission-category:' + session.token).setPlaceholder('选择权限分类').addOptions(
    Object.entries(permissionGroups).map(([value, group]) => ({ label: group.label, value, description: group.keys.length + ' 项权限' })),
  );
  const flagsSelect = new StringSelectMenuBuilder().setCustomId('permission-flags:' + session.token)
    .setPlaceholder(permissionKeys.length ? '选择要调整的权限（可多选）' : '此频道类型没有该分类的权限')
    .setMinValues(0).setMaxValues(Math.min(25, permissionKeys.length || 1))
    .addOptions(permissionKeys.slice(0, 25).map((key) => ({
      label: permissionLabel(key), value: key,
      description: session.scope === 'guild' ? '服务器身份组权限' : '频道权限覆盖',
      default: (session.selectedPermissions || []).includes(key),
    })))
    .setDisabled(!permissionKeys.length);
  return [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(scopeSelect),
    new ActionRowBuilder().addComponents(categorySelect),
    new ActionRowBuilder().addComponents(flagsSelect),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('permission-allow:' + session.token).setLabel(session.scope === 'guild' ? '授予所选权限' : '允许所选权限').setStyle(ButtonStyle.Success).setDisabled(!session.roleId),
      new ButtonBuilder().setCustomId('permission-deny:' + session.token).setLabel(session.scope === 'guild' ? '移除所选权限' : '拒绝所选权限').setStyle(ButtonStyle.Danger).setDisabled(!session.roleId),
      new ButtonBuilder().setCustomId('permission-reset:' + session.token).setLabel(session.scope === 'guild' ? '移除所选权限' : '恢复继承').setStyle(ButtonStyle.Secondary).setDisabled(!session.roleId),
      new ButtonBuilder().setCustomId('permission-pick-alert:' + session.token).setLabel('告警/扳回规则').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('permission-remove-case:' + session.token).setLabel('清除处罚档案').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function channelKindsForBulkPermission(channel) {
  return !channel.isThread?.() && channel.permissionOverwrites && [
    ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
    ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory,
  ].includes(channel.type);
}

async function applyPermissionPanelAction(guild, session, action, actorId) {
  const setting = settingsFor(guild.id);
  const role = session.roleId ? await guild.roles.fetch(session.roleId).catch(() => null) : null;
  const botMember = await guild.members.fetchMe();
  if (!role || role.managed || role.position >= botMember.roles.highest.position) throw new Error('该身份组由集成管理、不可修改，或层级不低于 Bot。');
  if (!session.selectedPermissions?.length) throw new Error('请先在权限列表中选择至少一项。');
  if (!botMember.permissions.has(PermissionFlagsBits.Administrator) && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot 缺少“管理身份组”权限。');
  const reason = '服务器权限面板操作人 ' + actorId;
  const selected = session.selectedPermissions.filter((key) => PermissionFlagsBits[key]);
  if (!selected.length) throw new Error('所选权限无效。');
  if (session.scope === 'guild') {
    const current = role.permissions.bitfield;
    const bits = selected.reduce((sum, key) => sum | PermissionFlagsBits[key], 0n);
    const updated = action === 'allow' ? current | bits : current & ~bits;
    await role.setPermissions(updated, reason);
    return '已更新身份组 ' + role.name + ' 的服务器权限：' + selected.map(permissionLabel).join('、');
  }
  const patch = Object.fromEntries(selected.map((key) => [key, action === 'allow' ? true : action === 'deny' ? false : null]));
  if (session.scope === 'all') {
    setting.permissionAllChannelRules[role.id] ||= {};
    for (const key of selected) {
      if (action === 'reset') delete setting.permissionAllChannelRules[role.id][key];
      else setting.permissionAllChannelRules[role.id][key] = action === 'allow';
    }
    if (!Object.keys(setting.permissionAllChannelRules[role.id]).length) delete setting.permissionAllChannelRules[role.id];
    await saveGuildData();
    const channels = await guild.channels.fetch();
    let updatedCount = 0;
    const failures = [];
    for (const channel of channels.values()) {
      if (!channelKindsForBulkPermission(channel)) continue;
      const channelKeys = selected.filter((key) => channelPermissionsFor(channel, permissionKeyToCategory.get(key) || session.category).includes(key));
      if (!channelKeys.length) continue;
      try {
        await channel.permissionOverwrites.edit(role.id, Object.fromEntries(channelKeys.map((key) => [key, patch[key]])), reason);
        updatedCount += 1;
      } catch (error) {
        failures.push(channel.name + ': ' + (error.message || '失败'));
      }
    }
    await saveGuildData();
    if (failures.length) return '全频道规则已保存并将应用到新频道；本次成功更新 ' + updatedCount + ' 个频道/分类，' + failures.length + ' 个失败：' + failures.slice(0, 3).join('；');
    return '已为身份组 ' + role.name + ' 在 ' + updatedCount + ' 个现有频道/分类设置权限；规则也会应用到新建频道。';
  }
  if (session.scope !== 'channel' || !session.channelId) throw new Error('请先选择单独频道，或将范围改为“所有频道”。');
  const channel = await guild.channels.fetch(session.channelId).catch(() => null);
  if (!channelKindsForBulkPermission(channel)) throw new Error('所选频道不存在，或该频道类型不支持单独权限覆盖。');
  const applicable = selected.filter((key) => channelPermissionsFor(channel, permissionKeyToCategory.get(key) || session.category).includes(key));
  if (!applicable.length) throw new Error('这些权限不适用于所选频道类型。');
  await channel.permissionOverwrites.edit(role.id, Object.fromEntries(applicable.map((key) => [key, patch[key]])), reason);
  return '已更新身份组 ' + role.name + ' 在 <#' + channel.id + '> 的权限：' + applicable.map(permissionLabel).join('、');
}

async function handlePermissionPanelInteraction(interaction) {
  if (!(interaction.isButton() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isModalSubmit())
    || !interaction.customId.startsWith('permission-')) return false;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '权限面板只能在服务器内使用。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  const removalConfirmation = interaction.customId.match(/^permission-remove-case-(confirm|cancel):([a-f0-9]{16})$/);
  if (interaction.isButton() && removalConfirmation) {
    const pending = pendingPunishmentRecordRemovals.get(removalConfirmation[2]);
    if (!pending || pending.guildId !== interaction.guildId || pending.userId !== interaction.user.id || Date.now() >= pending.expiresAt) {
      pendingPunishmentRecordRemovals.delete(removalConfirmation[2]);
      await interaction.reply({ content: '这次处罚档案清除确认已过期或不属于你，请重新从“/权限面板”发起。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以清除处罚档案。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    pendingPunishmentRecordRemovals.delete(removalConfirmation[2]);
    await interaction.deferUpdate();
    if (removalConfirmation[1] === 'cancel') {
      await interaction.editReply({ content: '已取消；处罚档案未更改。', embeds: [], components: [] });
      return true;
    }
    const previousCases = guildData.punishmentCases;
    const retainedCases = previousCases.filter((item) => !(pending.guildIds.includes(item.guildId) && item.id === pending.caseId));
    const removedCount = previousCases.length - retainedCases.length;
    if (!removedCount) {
      await interaction.editReply({ content: '没有找到这笔处罚档案；可能已被其他管理员清除。', embeds: [], components: [] });
      return true;
    }
    guildData.punishmentCases = retainedCases;
    try {
      await saveGuildData();
    } catch (error) {
      guildData.punishmentCases = previousCases;
      logFailure('清除处罚档案时保存加密存储失败，已恢复内存中的原记录。', error);
      await interaction.editReply({ content: '加密存储写入失败，处罚档案没有清除；请稍后重试。', embeds: [], components: [] });
      return true;
    }
    await interaction.editReply({
      content: `已从 Bot 的加密处罚档案中移除处罚 ID \`${pending.caseId}\`（${removedCount} 条服务器记录）。这不会撤销已执行的警告、禁言或封禁，也不会删除已发送到频道的处罚通知；仍有效处罚的自动期限会继续运行，但该 ID 将无法再用于“/撤销处罚”。`,
      embeds: [], components: [], allowedMentions: { parse: [] },
    });
    return true;
  }
  const token = interaction.customId.split(':')[1];
  const session = permissionPanelSessions.get(token);
  if (!session || session.guildId !== interaction.guildId || session.creatorId !== interaction.user.id
    || Date.now() - session.updatedAt > 30 * 60 * 1000) {
    permissionPanelSessions.delete(token);
    await interaction.reply({ content: '这个权限面板已过期，请重新运行“/权限面板”。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以配置权限面板。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  session.updatedAt = Date.now();
  try {
    if (interaction.isButton() && interaction.customId.startsWith('permission-remove-case:')) {
      const caseIdInput = new TextInputBuilder().setCustomId('case-id').setStyle(TextInputStyle.Short)
        .setRequired(true).setMinLength(12).setMaxLength(32).setPlaceholder('粘贴处罚通知卡上的处罚 ID');
      const modal = new ModalBuilder().setCustomId('permission-remove-case:' + session.token).setTitle('清除指定处罚档案')
        .addComponents(new LabelBuilder().setLabel('处罚 ID').setDescription('只清除 Bot 内部档案；不会撤销处罚或删除频道公示。').setTextInputComponent(caseIdInput));
      await interaction.showModal(modal);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('permission-remove-case:')) {
      const caseId = interaction.fields.getTextInputValue('case-id').trim().toLowerCase();
      if (!/^[a-f0-9]{12}$/i.test(caseId)) {
        await interaction.reply({ content: '处罚 ID 格式不正确；请从处罚通知卡复制 12 位十六进制 ID。', flags: MessageFlags.Ephemeral });
        return true;
      }
      const configuredGuildIds = punishmentGuildIds();
      const guildIds = configuredGuildIds.includes(interaction.guildId) ? configuredGuildIds : [interaction.guildId];
      const records = guildData.punishmentCases.filter((item) => guildIds.includes(item.guildId) && item.id === caseId);
      if (!records.length) {
        await interaction.reply({ content: '没有找到当前服务器或处罚互通服务器中的这个处罚 ID。', flags: MessageFlags.Ephemeral });
        return true;
      }
      const record = records[0];
      const statuses = [...new Set(records.map((item) => ({ active: '生效中', revoked: '已撤销', superseded: '已被覆盖', announced_only: '仅公示' }[item.status] || '非生效记录')))];
      const penaltyTypes = [...new Set(records.map((item) => [
        item.hasBan || item.mode === 'ban' ? '封禁' : null,
        item.hasWarning ? '警告' : null,
        item.hasTimeout ? '禁言' : null,
      ].filter(Boolean).join(' + ') || '未知类型'))];
      const guildNames = await Promise.all([...new Set(records.map((item) => item.guildId))].map(async (guildId) => {
        const guild = guildId === interaction.guildId ? interaction.guild : await client.guilds.fetch(guildId).catch(() => null);
        return guild?.name || guildId;
      }));
      const nonce = randomBytes(8).toString('hex');
      const expiresAt = Date.now() + 5 * 60 * 1000;
      pendingPunishmentRecordRemovals.set(nonce, { guildId: interaction.guildId, userId: interaction.user.id, caseId, guildIds, expiresAt });
      const expiryTimer = setTimeout(() => pendingPunishmentRecordRemovals.delete(nonce), expiresAt - Date.now());
      expiryTimer.unref?.();
      const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('确认清除处罚档案')
        .setDescription(`处罚 ID：\`${caseId}\`\n成员：<@${record.userId}>\n处罚类型：${penaltyTypes.join('、')}\n状态：${statuses.join('、')}\n服务器：${guildNames.join('、')}\n\n确认后只会从 Bot 的加密处罚档案中移除记录。不会撤销实际处罚、删除频道通知或停止警告/禁言的自动期限。${records.some((item) => item.status === 'active') ? '\n\n⚠️ 此记录仍有生效中的处罚；清除后不能再按该 ID 使用“/撤销处罚”。' : ''}`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('permission-remove-case-confirm:' + nonce).setLabel('确认清除档案').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('permission-remove-case-cancel:' + nonce).setLabel('取消').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('permission-role:')) {
      session.roleId = interaction.values[0];
      session.selectedPermissions = [];
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('permission-sanction-role:')) {
      const role = await interaction.guild.roles.fetch(interaction.values[0]).catch(() => null);
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
      if (!role || role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position
        || (!botMember.permissions.has(PermissionFlagsBits.Administrator) && !botMember.permissions.has(PermissionFlagsBits.ManageRoles))) {
        throw new Error('处置身份组必须是 Bot 有权限管理的普通身份组，并且层级低于 Bot。');
      }
      const setting = settingsFor(interaction.guildId);
      setting.permissionEscalationRoleId = role.id;
      await saveGuildData();
      await interaction.update({ content: '第三次违规后发放的身份组已保存。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('permission-whitelist-users:')) {
      session.whitelistUserId = interaction.values[0];
      await interaction.update({ content: '已选择 <@' + session.whitelistUserId + '>。点“添加所选成员”或“移出所选成员”完成修改。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-whitelist-add:')) {
      if (!session.whitelistUserId) throw new Error('请先选择要添加的成员。');
      await interaction.deferUpdate();
      const member = await interaction.guild.members.fetch(session.whitelistUserId).catch(() => null);
      if (!member || member.user.bot) throw new Error('白名单只接受本服务器中的真实成员，不接受机器人。');
      const setting = settingsFor(interaction.guildId);
      if (!setting.permissionRollbackWhitelistUserIds.includes(member.id)) {
        if (setting.permissionRollbackWhitelistUserIds.length >= 25) throw new Error('白名单最多 25 人，请先移除不需要的成员。');
        setting.permissionRollbackWhitelistUserIds.push(member.id);
      }
      await saveGuildData();
      await interaction.editReply({ content: '已添加 <@' + member.id + '> 到白名单。名单成员的权限变更不会自动扳回、计入违规或触发违规处置。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-whitelist-remove:')) {
      if (!session.whitelistUserId) throw new Error('请先选择要移出的成员。');
      const setting = settingsFor(interaction.guildId);
      setting.permissionRollbackWhitelistUserIds = setting.permissionRollbackWhitelistUserIds.filter((id) => id !== session.whitelistUserId);
      await saveGuildData();
      await interaction.update({ content: '已从白名单移出 <@' + session.whitelistUserId + '>。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('permission-scope:')) {
      session.scope = interaction.values[0];
      session.channelId = null;
      session.selectedPermissions = [];
      session.waitingFor = session.scope === 'channel' ? 'channel' : null;
      const text = session.waitingFor ? '选择一个频道或分类。' : '';
      await interaction.update({ content: text, embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('permission-category:')) {
      session.category = interaction.values[0];
      session.selectedPermissions = [];
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('permission-guard-category:')) {
      session.guardCategory = interaction.values[0];
      session.guardSelectedPermissions = settingsFor(interaction.guildId).permissionMonitoredKeys
        .filter((key) => permissionGroups[session.guardCategory].keys.includes(key));
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('permission-guard-flags:')) {
      session.guardSelectedPermissions = interaction.values;
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('permission-flags:')) {
      session.selectedPermissions = interaction.values;
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-pick-channel:')) {
      session.scope = 'channel';
      session.channelId = null;
      session.waitingFor = 'channel';
      await interaction.update({ content: '选择要单独配置的频道。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-pick-alert:')) {
      session.waitingFor = 'alert';
      await interaction.update({ content: '选择你新建的告警频道或子区。请确保 Bot 可查看并发送消息。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-open-guard:')) {
      const setting = settingsFor(interaction.guildId);
      session.waitingFor = 'guard';
      session.guardCategory = session.guardCategory || 'administration';
      session.guardSelectedPermissions = setting.permissionMonitoredKeys.filter((key) => permissionGroups[session.guardCategory].keys.includes(key));
      await interaction.update({ content: '选择哪些具体权限需要被自动监控和扳回；未勾选的权限不会被本功能阻止。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-guard-save:')) {
      const setting = settingsFor(interaction.guildId);
      const category = permissionGroups[session.guardCategory || 'administration'];
      const retained = setting.permissionMonitoredKeys.filter((key) => !category.keys.includes(key));
      setting.permissionMonitoredKeys = [...new Set([...retained, ...(session.guardSelectedPermissions || [])])];
      await saveGuildData();
      session.waitingFor = 'alert';
      await interaction.update({ content: '已保存所选权限的单项监控规则。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-open-whitelist:')) {
      session.waitingFor = 'whitelist';
      session.whitelistUserId = null;
      await interaction.update({ content: '白名单成员的权限调整不会自动扳回、计入违规或触发处置。每次选择一名成员后，可以单独添加或移出；最多 25 人。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-whitelist-clear:')) {
      settingsFor(interaction.guildId).permissionRollbackWhitelistUserIds = [];
      await saveGuildData();
      await interaction.update({ content: '白名单已清空。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-toggle-rollback:')) {
      const setting = settingsFor(interaction.guildId);
      setting.permissionRollbackEnabled = !setting.permissionRollbackEnabled;
      await saveGuildData();
      await interaction.update({ content: '非 Bot 权限变更自动恢复已' + (setting.permissionRollbackEnabled ? '开启' : '关闭') + '。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-toggle-escalation:')) {
      const setting = settingsFor(interaction.guildId);
      setting.permissionEscalationEnabled = !setting.permissionEscalationEnabled;
      await saveGuildData();
      await interaction.update({ content: '高危权限违规私信提醒及第三次身份组处置策略已' + (setting.permissionEscalationEnabled ? '开启' : '关闭') + '。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-clear-sanction-role:')) {
      const setting = settingsFor(interaction.guildId);
      setting.permissionEscalationRoleId = null;
      await saveGuildData();
      await interaction.update({ content: '第三次处置身份组已清除。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('permission-back:')) {
      session.waitingFor = session.waitingFor === 'guard' || session.waitingFor === 'whitelist' ? 'alert' : null;
      await interaction.update({ content: '', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('permission-alert-channel:')) {
      const channel = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
      const botMember = await interaction.guild.members.fetchMe();
      const sendPermission = channel?.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased?.()
        || !channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])) {
        throw new Error('告警目标必须是本服务器中 Bot 可查看、发送消息和嵌入链接的文字频道或子区。');
      }
      settingsFor(interaction.guildId).permissionAlertChannelId = channel.id;
      await saveGuildData();
      session.waitingFor = null;
      await interaction.update({ content: '权限警告频道已设置为 <#' + channel.id + '>。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('permission-channel:')) {
      const channel = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
      if (!channel || channel.guildId !== interaction.guildId || !channelKindsForBulkPermission(channel)) {
        throw new Error('请选择本服务器中支持权限覆盖的频道或分类。');
      }
      session.channelId = channel.id;
      session.scope = 'channel';
      session.waitingFor = null;
      session.selectedPermissions = [];
      await interaction.update({ content: '已选择 <#' + channel.id + '>。', embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    if (interaction.isButton() && ['permission-allow:', 'permission-deny:', 'permission-reset:'].some((prefix) => interaction.customId.startsWith(prefix))) {
      const action = interaction.customId.startsWith('permission-allow:') ? 'allow'
        : interaction.customId.startsWith('permission-deny:') ? (session.scope === 'guild' ? 'remove' : 'deny') : 'reset';
      await interaction.deferUpdate();
      const result = await applyPermissionPanelAction(interaction.guild, session, action === 'remove' ? 'deny' : action, interaction.user.id);
      await interaction.editReply({ content: result, embeds: [permissionPanelEmbed(interaction.guild, session)], components: permissionPanelComponents(session) });
      return true;
    }
    await interaction.reply({ content: '这个权限面板操作无法识别，请重新运行“/权限面板”。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  } catch (error) {
    logFailure('权限面板操作失败。', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: '设置未完成：' + error.message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: '设置未完成：' + error.message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return true;
  }
}

const guardedPermissionKeys = [...DEFAULT_MONITORED_PERMISSION_KEYS];
const escalationPermissionKeys = new Set(guardedPermissionKeys);

function monitoredPermissionBits(bits, setting) {
  const enabled = new Set(setting.permissionMonitoredKeys || DEFAULT_MONITORED_PERMISSION_KEYS);
  return permissionNamesForBits(bits).filter((key) => enabled.has(key))
    .reduce((sum, key) => sum | PermissionFlagsBits[key], 0n);
}

function permissionInteger(value) {
  try { return BigInt(value || 0); } catch { return 0n; }
}

function changedPermissionBits(oldValue, newValue) {
  return permissionInteger(oldValue) ^ permissionInteger(newValue);
}

function permissionNamesForBits(bits) {
  return Object.keys(PermissionFlagsBits).filter((key) => (bits & PermissionFlagsBits[key]) !== 0n);
}

async function restoreRolePermissionChanges(guild, entry, permissionChange) {
  const oldBits = permissionInteger(permissionChange.old);
  const newBits = permissionInteger(permissionChange.new);
  const setting = settingsFor(guild.id);
  const changed = monitoredPermissionBits(oldBits ^ newBits, setting);
  if (!changed || !setting.permissionRollbackEnabled || entry.executorId === client.user.id) return { changed, restored: 0n };
  if (!entry.targetId) return { changed, restored: 0n, error: '审计日志缺少目标身份组 ID' };
  const role = guild.roles.cache.get(entry.targetId) || await guild.roles.fetch(entry.targetId).catch(() => null);
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!role || role.managed || role.position >= botMember.roles.highest.position) {
    return { changed, restored: 0n, error: '目标身份组在 Bot 层级之上、由集成管理或无法读取' };
  }
  const current = role.permissions.bitfield;
  const restored = (current & ~changed) | (oldBits & changed);
  await role.setPermissions(restored, '恢复 Bot 面板之外的身份组权限变更；审计编号 ' + entry.id);
  return { changed, restored: changed };
}

async function restoreChannelOverwriteChanges(guild, entry, overwriteChanges) {
  const allowChange = overwriteChanges.find((change) => change.key === 'allow');
  const denyChange = overwriteChanges.find((change) => change.key === 'deny');
  // Audit entries contain only changed fields. An absent side is the empty bitset;
  // an absent field did not change and contributes no bits to the diff.
  const oldAllow = allowChange ? permissionInteger(allowChange.old) : 0n;
  const newAllow = allowChange ? permissionInteger(allowChange.new) : 0n;
  const oldDeny = denyChange ? permissionInteger(denyChange.old) : 0n;
  const newDeny = denyChange ? permissionInteger(denyChange.new) : 0n;
  const setting = settingsFor(guild.id);
  const changed = monitoredPermissionBits((oldAllow ^ newAllow) | (oldDeny ^ newDeny), setting);
  if (!changed || !setting.permissionRollbackEnabled || entry.executorId === client.user.id) return { changed, restored: 0n };
  const overwriteTarget = entry.extra?.id ? entry.extra : null;
  const channel = entry.targetId
    ? (guild.channels.cache.get(entry.targetId) || await guild.channels.fetch(entry.targetId).catch(() => null))
    : null;
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!overwriteTarget || !channel?.permissionOverwrites || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
    return { changed, restored: 0n, error: '无法读取权限覆盖目标/频道，或 Bot 缺少“管理身份组”权限' };
  }
  const patch = {};
  for (const key of permissionNamesForBits(changed)) {
    const bit = PermissionFlagsBits[key];
    patch[key] = (oldAllow & bit) !== 0n ? true : (oldDeny & bit) !== 0n ? false : null;
  }
  await channel.permissionOverwrites.edit(overwriteTarget.id, patch, '恢复 Bot 面板之外的频道权限变更；审计编号 ' + entry.id);
  return { changed, restored: changed };
}

async function sendPermissionAlert(guild, embed) {
  const setting = settingsFor(guild.id);
  if (!setting.permissionAlertChannelId) {
    console.warn('服务器 ' + guild.id + ' 未设置权限告警频道；变更已在控制台记录。');
    return false;
  }
  const channel = await guild.channels.fetch(setting.permissionAlertChannelId).catch(() => null);
  const botMember = await guild.members.fetchMe();
  const sendPermission = channel?.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const permissions = channel?.permissionsFor(botMember);
  if (!channel?.isTextBased?.() || !channel.send || !permissions?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])) {
    throw new Error('权限告警频道不可用，或 Bot 缺少查看、发送消息和嵌入链接权限。');
  }
  if (channel.isThread?.() && channel.archived) {
    if (channel.locked && !permissions.has(PermissionFlagsBits.ManageThreads)) throw new Error('告警子区已锁定且 Bot 缺少“管理帖子”权限，无法重新打开。');
    await channel.setArchived(false, '发布服务器权限变更警告');
  }
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return true;
}

async function applyPermissionEscalationRoleSanction(guild, executorId, setting, auditEntryId) {
  const roleId = setting.permissionEscalationRoleId;
  if (!roleId) return '未配置第三次处置身份组，无法执行身份组处置。';

  const [member, role] = await Promise.all([
    guild.members.fetch(executorId).catch(() => null),
    guild.roles.fetch(roleId).catch(() => null),
  ]);
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!member) return '操作者不在服务器，无法调整身份组。';
  if (member.id === guild.ownerId) return '操作者是服务器所有者，Discord 不允许 Bot 调整其身份组。';
  if (!role || role.id === guild.id || role.managed || role.position >= botMember.roles.highest.position) {
    return '配置的处置身份组已失效、由集成管理或层级不低于 Bot，未能发放。';
  }
  if (!botMember.permissions.has(PermissionFlagsBits.Administrator) && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Bot 缺少“管理身份组”权限，未能执行身份组处置。';
  }

  const removableRoleIds = member.roles.cache
    .filter((memberRole) => memberRole.id !== guild.id && memberRole.id !== role.id
      && !memberRole.managed && memberRole.position < botMember.roles.highest.position)
    .map((memberRole) => memberRole.id);
  const unmanageableCount = member.roles.cache.filter((memberRole) => memberRole.id !== guild.id
    && memberRole.id !== role.id && (memberRole.managed || memberRole.position >= botMember.roles.highest.position)).size;

  let removalError = null;
  if (removableRoleIds.length) {
    try {
      await member.roles.remove(removableRoleIds, '第 3 次触发服务器管理权限警告策略；审计编号 ' + auditEntryId);
    } catch (error) {
      removalError = error?.rawError?.message || error?.message || '移除身份组失败';
    }
  }

  let assignmentError = null;
  if (!member.roles.cache.has(role.id)) {
    try {
      await member.roles.add(role, '第 3 次触发服务器管理权限警告策略；审计编号 ' + auditEntryId);
    } catch (error) {
      assignmentError = error?.rawError?.message || error?.message || '发放处置身份组失败';
    }
  }

  const result = [];
  if (!removalError) result.push('已移除 ' + removableRoleIds.length + ' 个 Bot 可管理的身份组');
  else result.push('移除身份组失败：' + removalError);
  if (!assignmentError) result.push('已发放处置身份组 <@&' + role.id + '>');
  else result.push('发放处置身份组失败：' + assignmentError);
  if (unmanageableCount) result.push(unmanageableCount + ' 个由集成管理或层级高于 Bot 的身份组无法移除');
  return result.join('；') + '。';
}

async function applyPermissionViolationPolicy(guild, entry, changedProtectedPermissions, restoreResult) {
  const setting = settingsFor(guild.id);
  if (!setting.permissionEscalationEnabled || !entry.executorId || entry.executorId === client.user?.id || !changedProtectedPermissions.length) return null;

  let user = entry.executor || null;
  if (!user) user = await client.users.fetch(entry.executorId).catch(() => null);
  const counts = setting.permissionStrikeCounts;
  const previous = Number(counts[entry.executorId]?.count || 0);
  const strike = previous + 1;
  counts[entry.executorId] = { count: strike, lastAt: Date.now(), lastAuditEntryId: entry.id };
  await saveGuildData();
  const serverName = guild.name || '该服务器';
  const changedLabels = changedProtectedPermissions.map(permissionLabel).join('、');
  const rollbackText = restoreResult?.restored
    ? 'Bot 已将权限恢复到操作前状态。'
    : restoreResult?.error
      ? 'Bot 自动恢复失败：' + restoreResult.error + '。请立即联系 ADMIN 处理。'
      : '自动扳回未执行；请立即联系 ADMIN 检查面板中的自动恢复设置。';
  const dmText = strike < 3
    ? '检测到你在「' + serverName + '」修改了受保护的服务器管理/频道管理权限（' + changedLabels + '）。' + rollbackText + '请联系服务器 ADMIN，由其在“/权限面板”中把权限设为所需的 X（允许、拒绝或继承）；请勿直接修改。当前为第 ' + strike + ' 次提醒。' + (strike === 2 ? '再次触发将移除你所有可管理身份组并发放配置的处置身份组。' : '')
    : '检测到你在「' + serverName + '」第 3 次修改受保护的服务器管理/频道管理权限（' + changedLabels + '）。' + rollbackText + 'Bot 将尝试移除你所有可管理的身份组，并发放服务器权限面板配置的处置身份组。';
  const dmSent = Boolean(user && await user.send({ content: dmText, allowedMentions: { parse: [] } }).then(() => true).catch(() => false));

  if (strike < 3) {
    return { strike, dmSent, action: '已记录第 ' + strike + ' 次违规' + (dmSent ? '并私信警告' : '；私信发送失败') + '。' };
  }

  const sanctionResult = await applyPermissionEscalationRoleSanction(guild, entry.executorId, setting, entry.id);
  return { strike, dmSent, action: '第 3 次违规，' + sanctionResult + (dmSent ? '' : '私信发送失败。') };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildModeration],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});
let readyWatchdog;
client.on('shardError', (error) => logFailure('Discord 网关连接错误。', error));
client.on('shardConnecting', () => console.log('正在连接 Discord 实时网关……'));
client.on('shardDisconnect', (event, shardId) => {
  console.error(`Discord 网关已断开（错误代码 ${event.code}）。`);
});
client.on('error', (error) => logFailure('Discord 客户端错误。', error));
const handledPermissionAuditEntries = new Set();
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
  if (handledPermissionAuditEntries.has(entry.id)) return;
  handledPermissionAuditEntries.add(entry.id);
  if (handledPermissionAuditEntries.size > 2000) handledPermissionAuditEntries.clear();
  try {
    if (entry.executorId === client.user?.id || entry.executor?.bot) return;
    const setting = settingsFor(guild.id);
    if (entry.executorId && setting.permissionRollbackWhitelistUserIds.includes(entry.executorId)) return;
    let changedBits = 0n;
    let targetDescription = '';
    let restoreResult = { changed: 0n, restored: 0n };
    let roleForLog = null;
    let channelForLog = null;
    let overwriteTargetForLog = null;
    if (entry.action === AuditLogEvent.RoleUpdate) {
      const permissionChange = entry.changes.find((change) => change.key === 'permissions');
      if (!permissionChange) return;
      changedBits = monitoredPermissionBits(changedPermissionBits(permissionChange.old, permissionChange.new), setting);
      if (!changedBits) return;
      // Restore immediately from the audit entry's before/after values. Delay
      // all actor and display-name lookups until the permission is back in place.
      try {
        restoreResult = await restoreRolePermissionChanges(guild, entry, permissionChange);
      } catch (error) {
        restoreResult = { changed: changedBits, restored: 0n, error: error?.rawError?.message || error?.message || 'Discord API 恢复失败' };
      }
      roleForLog = guild.roles.cache.get(entry.targetId) || null;
    } else if ([AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete].includes(entry.action)) {
      const permissionChanges = entry.changes.filter((change) => change.key === 'allow' || change.key === 'deny');
      if (!permissionChanges.length) return;
      const allowChange = permissionChanges.find((change) => change.key === 'allow');
      const denyChange = permissionChanges.find((change) => change.key === 'deny');
      const oldAllow = allowChange ? permissionInteger(allowChange.old) : 0n;
      const newAllow = allowChange ? permissionInteger(allowChange.new) : 0n;
      const oldDeny = denyChange ? permissionInteger(denyChange.old) : 0n;
      const newDeny = denyChange ? permissionInteger(denyChange.new) : 0n;
      changedBits = monitoredPermissionBits((oldAllow ^ newAllow) | (oldDeny ^ newDeny), setting);
      if (!changedBits) return;
      try {
        restoreResult = await restoreChannelOverwriteChanges(guild, entry, permissionChanges);
      } catch (error) {
        restoreResult = { changed: changedBits, restored: 0n, error: error?.rawError?.message || error?.message || 'Discord API 恢复失败' };
      }
      channelForLog = guild.channels.cache.get(entry.targetId) || null;
      overwriteTargetForLog = entry.extra;
    } else return;

    const permissionNames = permissionNamesForBits(changedBits);
    const criticalNames = permissionNames.filter((key) => guardedPermissionKeys.includes(key));
    let escalation = null;
    let escalationError = null;
    try {
      escalation = await applyPermissionViolationPolicy(
        guild,
        entry,
        permissionNames.filter((key) => escalationPermissionKeys.has(key)),
        restoreResult,
      );
    } catch (error) {
      escalationError = error?.rawError?.message || error?.message || '操作者警告策略执行失败';
      logFailure('权限违规计数或操作者处置失败。', error);
    }
    if (entry.action === AuditLogEvent.RoleUpdate) {
      targetDescription = roleForLog
        ? '身份组：' + roleForLog.name + '（<@&' + roleForLog.id + '>）'
        : '身份组 ID：' + entry.targetId;
    } else {
      const principal = overwriteTargetForLog?.id
        ? ((overwriteTargetForLog.type === 1 || overwriteTargetForLog.user) ? '成员 ID：' + overwriteTargetForLog.id : '身份组：<@&' + overwriteTargetForLog.id + '>')
        : '身份组或成员覆盖';
      targetDescription = '频道：' + (channelForLog ? '<#' + channelForLog.id + '>' : entry.targetId) + '\n对象：' + principal;
    }
    const executorLabel = entry.executor?.tag || entry.executor?.username || (entry.executorId ? '<@' + entry.executorId + '>' : '未知操作者');
    const restoreText = restoreResult.error
      ? '自动恢复失败：' + restoreResult.error
      : restoreResult.restored ? '已快速恢复到操作前的权限值。'
        : settingsFor(guild.id).permissionRollbackEnabled ? '未执行恢复。' : '自动恢复已关闭。';
    const embed = new EmbedBuilder()
      .setColor(criticalNames.length ? 0xED4245 : 0xF0B132)
      .setTitle(criticalNames.length ? '高危管理权限变更警告' : '服务器权限变更提醒')
      .setDescription('操作者：' + executorLabel + '\n' + targetDescription
        + '\n操作：' + entry.actionType
        + '\n变更权限：' + permissionNames.map(permissionLabel).join('、')
        + (criticalNames.length ? '\n高危项目：' + criticalNames.map(permissionLabel).join('、') : '')
        + '\n处理结果：' + restoreText
        + (escalation ? '\n违规次数：' + escalation.strike + '/3\n升级处置：' + escalation.action : '')
        + (escalationError ? '\n违规处置策略错误：' + escalationError : '')
        + '\n审计编号：' + entry.id
        + (entry.reason ? '\n原操作理由：' + entry.reason : ''))
      .setTimestamp(entry.createdAt);
    await sendPermissionAlert(guild, embed);
    console.warn('服务器 ' + guild.id + ' 检测到非本 Bot 发起的权限变更；审计编号 ' + entry.id + '；' + restoreText);
  } catch (error) {
    logFailure('权限变更监控、恢复或公告失败。', error);
  }
});
client.on('channelCreate', async (channel) => {
  if (!channel.guild || !channelKindsForBulkPermission(channel)) return;
  if (channel.topic?.startsWith('discord-api-bot-emergency:')) return;
  const setting = guildData.settings[channel.guild.id];
  const rules = setting?.permissionAllChannelRules || {};
  if (!Object.keys(rules).length) return;
  try {
    const botMember = await channel.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.Administrator) && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return;
    for (const [roleId, configured] of Object.entries(rules)) {
      const role = await channel.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.position >= botMember.roles.highest.position || role.managed) continue;
      const patch = {};
      for (const [key, allow] of Object.entries(configured)) {
        if (allow === null || !PermissionFlagsBits[key]) continue;
        const category = permissionKeyToCategory.get(key);
        if (category && channelPermissionsFor(channel, category).includes(key)) patch[key] = allow;
      }
      if (Object.keys(patch).length) {
        await channel.permissionOverwrites.edit(role.id, patch, '应用权限面板全频道规则到新频道');
      }
    }
  } catch (error) {
    logFailure('新频道自动应用权限面板规则失败。', error);
  }
});
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
    if (Number(error.code ?? error.rawError?.code) === 10008) return;
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
  schedulePersistedManagementDeleteConfirmations();
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
    if (!tracks.length && !configuredCompanionRoleIds(setting).size) continue;
    for (const [tier, roleId] of tracks) {
      const track = managementTrack(setting, tier, roleId);
      await syncManagementRole(guild, tier, null, roleId).catch((error) => {
        logFailure(`${track.label}成员读取失败。请在 Developer Portal 开启 Server Members Intent。`, error);
      });
    }
    await syncManagementCompanionRoles(guild).catch((error) => logFailure('管理组配套身份组同步失败。', error));
  }
  setInterval(() => reconcileLongTimeouts().catch((error) => logFailure('Timeout scheduler failed.', error)), 60 * 1000);
  await processSchedules().catch((error) => logFailure('Schedule startup processing failed.', error));
  setInterval(() => processSchedules().catch((error) => logFailure('Schedule processing failed.', error)), 1000);
});
client.on('guildMemberUpdate', (oldMember, newMember) => {
  const setting = guildData.settings[newMember.guild.id];
  if (!setting) return;
  for (const [tier, roleId, track] of managementTracks(setting)) {
    if (!track.roleId) continue;
    const mainRoleChanged = oldMember.roles.cache.has(track.roleId) !== newMember.roles.cache.has(track.roleId);
    const companionChanged = (track.companionRoleIds || []).some((companionRoleId) =>
      oldMember.roles.cache.has(companionRoleId) !== newMember.roles.cache.has(companionRoleId));
    if (mainRoleChanged || companionChanged) {
      scheduleManagementMemberSync(newMember, newMember.roles.cache.has(track.roleId), tier, roleId);
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

async function handleManagementSpeechVerification(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('management-speech-verify:')) return false;
  const match = interaction.customId.match(/^management-speech-verify:(\d{17,20}):([a-f0-9]{24})$/);
  const actorId = match?.[1];
  const nonce = match?.[2];
  const embed = interaction.message?.embeds?.find((item) => item.title === MANAGEMENT_SPEECH_TITLE);
  const footer = embed?.footer?.text || '';
  const signature = footer.startsWith(MANAGEMENT_SPEECH_FOOTER)
    ? footer.slice(MANAGEMENT_SPEECH_FOOTER.length) : '';
  let valid = false;
  try {
    if (match && interaction.inGuild() && interaction.message?.author?.id === client.user.id
      && embed?.description === '此消息由 Bot 在核对主管理组身份后发布。点击下方按钮可验证来源。'
      && embed?.fields?.some((field) => field.name === '发言人' && field.value === `<@${actorId}>`)
      && /^[a-f0-9]{64}$/.test(signature)) {
      const expected = managementSpeechSignature(interaction.guildId, interaction.channelId, actorId, nonce,
        interaction.message.content || '');
      valid = timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    }
  } catch (error) { logFailure('管理组发言核验失败。', error); }
  await interaction.reply({ content: valid
    ? `认证通过：这条消息由管理组成员 <@${actorId}> 通过 /管理说话 发出，内容未被修改。`
    : '认证失败：此消息并非有效的管理组正式发言，或内容已被修改。',
  flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  return true;
}

async function handleSpeechArchiveView(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('speech-archive-view:')) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const archiveId = interaction.customId.slice('speech-archive-view:'.length);
    if (!/^[a-f0-9]{16}$/.test(archiveId) || !interaction.inGuild()
      || interaction.channelId !== speechArchiveChannelId
      || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.message?.author?.id !== client.user.id) {
      throw new Error('只有留档服务器的管理员能在指定留档频道查看此记录。');
    }
    const attachment = [...interaction.message.attachments.values()]
      .find((item) => item.name === `speech-archive-${archiveId}.json.enc`);
    if (!attachment) throw new Error('加密记录附件已不存在。');
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`无法读取留档附件（HTTP ${response.status}）。`);
    const decrypted = decryptJson(await response.json());
    if (!decrypted.encrypted || decrypted.value?.kind !== 'speech-archive'
      || decrypted.value.archiveId !== archiveId) throw new Error('留档内容与当前记录不匹配。');
    await interaction.editReply({ content: `说话留档 ${archiveId} 的内容仅向你显示。`,
      files: [{ attachment: Buffer.from(JSON.stringify(decrypted.value, null, 2), 'utf8'),
        name: `speech-archive-${archiveId}.json` }] });
  } catch (error) {
    logFailure('读取说话留档失败。', error);
    await interaction.editReply(`无法读取说话留档：${error.message}`);
  }
  return true;
}

async function handleEmergencyChannelInteraction(interaction) {
  const command = interaction.isChatInputCommand() && interaction.commandName === '紧急频道面板';
  const customId = interaction.customId || '';
  if (!command && !customId.startsWith('emergency-')) return false;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '紧急频道功能只能在服务器中使用。', flags: MessageFlags.Ephemeral });
    return true;
  }
  try {
    if (command) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      await interaction.editReply({ embeds: [emergencyChannelPanelEmbed(interaction.guildId)],
        components: emergencyChannelPanelComponents(interaction.guildId) });
      return true;
    }
    const [action, reference] = customId.split(':');
    if (action === 'emergency-create' && interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (reference !== interaction.guildId) throw new Error('面板不属于当前服务器。');
      await emergencyManagerRole(interaction);
      for (const [token, session] of pendingEmergencyOpenings) {
        if (session.expiresAt <= Date.now()) pendingEmergencyOpenings.delete(token);
      }
      const token = randomBytes(8).toString('hex');
      pendingEmergencyOpenings.set(token, { token, guildId: interaction.guildId, userId: interaction.user.id,
        expiresAt: Date.now() + 10 * 60 * 1000, roleIds: null });
      await interaction.editReply({ content: '选择可进入紧急频道的身份组，或点“不分配身份组”。只有创建者和 Bot 会默认进入。',
        components: [
          new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`emergency-roles:${token}`)
            .setPlaceholder('选择可进入的身份组（最多 10 个）').setMinValues(1).setMaxValues(10)),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emergency-no-roles:${token}`)
            .setLabel('不分配身份组').setStyle(ButtonStyle.Secondary)),
        ] });
      return true;
    }
    if (action === 'emergency-roles' && interaction.isRoleSelectMenu()) {
      await interaction.deferUpdate();
      await emergencyManagerRole(interaction);
      const session = emergencyOpeningSession(interaction, reference);
      session.roleIds = [...new Set(interaction.values)].filter((id) => id !== interaction.guildId);
      if (!session.roleIds.length) throw new Error('不能选择 @everyone；请选择其他身份组或“不分配身份组”。');
      await interaction.editReply({ content: `已选择 ${session.roleIds.map((id) => `<@&${id}>`).join('、')}。下一步填写名称和理由。`,
        components: emergencyOpeningReady(session), allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'emergency-no-roles' && interaction.isButton()) {
      await interaction.deferUpdate();
      await emergencyManagerRole(interaction);
      const session = emergencyOpeningSession(interaction, reference);
      session.roleIds = [];
      await interaction.editReply({ content: '不分配身份组；只有创建者和 Bot 默认可进入。下一步填写名称和理由。',
        components: emergencyOpeningReady(session) });
      return true;
    }
    if (action === 'emergency-details' && interaction.isButton()) {
      await emergencyManagerRole(interaction);
      const session = emergencyOpeningSession(interaction, reference);
      if (!Array.isArray(session.roleIds)) throw new Error('请先选择身份组或“不分配身份组”。');
      await interaction.showModal(new ModalBuilder().setCustomId(`emergency-open:${reference}`)
        .setTitle('开设紧急频道').addComponents(
          new LabelBuilder().setLabel('频道名称').setTextInputComponent(new TextInputBuilder()
            .setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
          new LabelBuilder().setLabel('开设理由').setTextInputComponent(new TextInputBuilder()
            .setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400))));
      return true;
    }
    if (action === 'emergency-open' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      const session = emergencyOpeningSession(interaction, reference);
      if (!Array.isArray(session.roleIds)) throw new Error('请先选择频道可进入的身份组。');
      pendingEmergencyOpenings.delete(reference);
      const roleIds = session.roleIds;
      const roles = await Promise.all(roleIds.map((id) => interaction.guild.roles.fetch(id).catch(() => null)));
      if (roles.some((role) => !role || role.id === interaction.guildId)) throw new Error('所选身份组已失效，请重新开设。');
      const setting = settingsFor(interaction.guildId);
      const category = setting.emergencyCategoryId
        ? await interaction.guild.channels.fetch(setting.emergencyCategoryId).catch(() => null) : null;
      if (!category || category.type !== ChannelType.GuildCategory) throw new Error('请先在 /紧急频道面板 选择频道分类。');
      await emergencyRecordChannel(interaction.guild, setting);
      if (!(await interaction.guild.members.fetchMe()).permissions.has(PermissionFlagsBits.ManageChannels)) {
        throw new Error('Bot 缺少“管理频道”权限。');
      }
      const inputName = interaction.fields.getTextInputValue('name').normalize('NFKC').trim();
      const name = inputName.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 50);
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!name || !reason) throw new Error('请填写有效的频道名称和开设理由。');
      const caseId = randomBytes(6).toString('hex');
      const channel = await interaction.guild.channels.create({
        name: `紧急-${name}`, type: ChannelType.GuildText, parent: category.id,
        topic: `discord-api-bot-emergency:${caseId}`,
        permissionOverwrites: [
          { id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] },
          ...roleIds.map((id) => ({ id, allow: emergencyGuestPermissions })),
          { id: interaction.user.id, allow: [...emergencyGuestPermissions, PermissionFlagsBits.UseApplicationCommands] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles, PermissionFlagsBits.AttachFiles] },
        ], reason: `紧急频道 ${caseId}，创建人 ${interaction.user.id}`,
      });
      setting.emergencyChannels[channel.id] = { caseId, createdBy: interaction.user.id,
        createdAt: Date.now(), name: channel.name, reason, accessRoleIds: roleIds };
      try { await saveGuildData(); }
      catch (error) {
        delete setting.emergencyChannels[channel.id];
        await channel.delete('紧急频道设置保存失败，撤销刚创建的空频道').catch(() => {});
        throw error;
      }
      try {
        await channel.send({ embeds: [new EmbedBuilder().setColor(0xE67E22).setTitle('紧急频道')
          .setDescription(`编号：${caseId}\n创建人：<@${interaction.user.id}>\n可进入的身份组：${roleIds.length ? roleIds.map((id) => `<@&${id}>`).join('、') : '无'}\n理由：${reason}\n\n管理组可拉人，或点击“记录并关闭”导出聊天记录并关闭。`)
          .setTimestamp()], components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`emergency-invite:${channel.id}`).setLabel('拉人').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`emergency-close:${channel.id}`).setLabel('记录并关闭').setStyle(ButtonStyle.Danger))],
          allowedMentions: { parse: [] } });
      } catch (error) {
        await channel.delete('紧急频道关闭面板无法发送，撤销刚创建的空频道').catch(() => {});
        delete setting.emergencyChannels[channel.id];
        await saveGuildData().catch((saveError) => logFailure('清理未完成紧急频道索引失败。', saveError));
        throw error;
      }
      await interaction.editReply(`已创建紧急频道：<#${channel.id}>。`);
      return true;
    }
    if ((action === 'emergency-category' || action === 'emergency-record') && interaction.isChannelSelectMenu()) {
      await interaction.deferUpdate();
      if (reference !== interaction.guildId) throw new Error('面板不属于当前服务器。');
      await emergencyManagerRole(interaction);
      const setting = settingsFor(interaction.guildId);
      const channel = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
      if (!channel || channel.guildId !== interaction.guildId) throw new Error('请选择本服务器的频道。');
      if (action === 'emergency-category') {
        if (channel.type !== ChannelType.GuildCategory) throw new Error('请选择频道分类。');
        setting.emergencyCategoryId = channel.id;
      } else {
        if (channel.type !== ChannelType.GuildText) throw new Error('请选择普通文字记录频道。');
        const previous = setting.emergencyRecordChannelId;
        setting.emergencyRecordChannelId = channel.id;
        try { await emergencyRecordChannel(interaction.guild, setting); }
        catch (error) { setting.emergencyRecordChannelId = previous; throw error; }
      }
      await saveGuildData();
      await interaction.editReply({ embeds: [emergencyChannelPanelEmbed(interaction.guildId)],
        components: emergencyChannelPanelComponents(interaction.guildId) });
      return true;
    }
    if (action === 'emergency-invite' && interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      if (reference !== interaction.channelId || !settingsFor(interaction.guildId).emergencyChannels[reference]) {
        throw new Error('只能在紧急频道内邀请成员。');
      }
      if (activeEmergencyClosures.has(reference)) throw new Error('频道正在归档，暂不能邀请成员。');
      await interaction.editReply({ content: '选择要拉进本频道的成员。Bot 将开放查看消息、发言、创建公共子区、添加反应和查看历史消息。',
        components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
          .setCustomId(`emergency-users:${reference}`).setPlaceholder('选择成员（最多 10 人）').setMinValues(1).setMaxValues(10))] });
      return true;
    }
    if (action === 'emergency-users' && interaction.isUserSelectMenu()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      const caseData = settingsFor(interaction.guildId).emergencyChannels[reference];
      if (reference !== interaction.channelId || !caseData) throw new Error('只能在紧急频道内邀请成员。');
      if (activeEmergencyClosures.has(reference)) throw new Error('频道正在归档，暂不能邀请成员。');
      const channel = await interaction.guild.channels.fetch(reference).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error('紧急频道已不存在。');
      const botMember = await interaction.guild.members.fetchMe();
      if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('Bot 在紧急频道缺少“管理身份组”权限，无法设置成员频道权限。');
      }
      const granted = [];
      const failed = [];
      for (const userId of [...new Set(interaction.values)]) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) { failed.push(`${userId}（不在服务器）`); continue; }
        try {
          await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true, SendMessages: true, CreatePublicThreads: true,
            AddReactions: true, ReadMessageHistory: true,
          }, `紧急频道 ${caseData.caseId}：${interaction.user.id} 邀请成员`);
          granted.push(`<@${userId}>`);
        } catch (error) {
          failed.push(`${userId}（${error?.rawError?.message || error.message}）`);
        }
      }
      await interaction.editReply({ content: `已拉入：${granted.length ? granted.join('、') : '无'}${failed.length ? `\n失败：${failed.join('；')}` : ''}`,
        allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'emergency-view' && interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      if (interaction.channelId !== settingsFor(interaction.guildId).emergencyRecordChannelId) {
        throw new Error('只能从配置的私密记录频道读取紧急频道记录。');
      }
      const attachments = [...interaction.message.attachments.values()]
        .filter((item) => item.name?.startsWith(`emergency-${reference}-`) && item.name.endsWith('.json.enc'));
      if (!attachments.length) throw new Error('记录附件不存在或已被移除。');
      const files = [];
      for (const attachment of attachments) {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`无法读取加密记录附件（HTTP ${response.status}）。`);
        const decrypted = decryptJson(await response.json());
        const payload = decrypted.value;
        if (!decrypted.encrypted || payload?.kind !== 'emergency-transcript' || payload.caseId !== reference
          || !Number.isInteger(payload.part) || typeof payload.content !== 'string') {
          throw new Error('记录附件内容与当前案件不匹配。');
        }
        files.push({ attachment: Buffer.from(payload.content, 'utf8'), name: `emergency-${reference}-${payload.part}.txt` });
      }
      files.sort((left, right) => Number(left.name.match(/-(\d+)\.txt$/)?.[1]) - Number(right.name.match(/-(\d+)\.txt$/)?.[1]));
      await interaction.editReply({ content: `紧急频道 ${reference} 的聊天记录仅向你显示。`, files });
      return true;
    }
    if (action === 'emergency-close' && interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await emergencyManagerRole(interaction);
      if (reference !== interaction.channelId || !settingsFor(interaction.guildId).emergencyChannels[reference]) {
        throw new Error('这个频道不是由紧急频道面板创建，或关闭面板不在原频道。');
      }
      const setting = settingsFor(interaction.guildId);
      await emergencyRecordChannel(interaction.guild, setting);
      for (const [token, pending] of pendingEmergencyClosures) {
        if (pending.expiresAt <= Date.now()) pendingEmergencyClosures.delete(token);
      }
      const token = randomBytes(8).toString('hex');
      pendingEmergencyClosures.set(token, { guildId: interaction.guildId, channelId: reference,
        userId: interaction.user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
      await interaction.editReply({ content: `确认后会把本频道全部可读消息加密保存至 <#${setting.emergencyRecordChannelId}>，成功后永久删除本频道。附件以链接记录。确定继续吗？`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`emergency-confirm:${token}`).setLabel('导出记录并删除频道').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`emergency-cancel:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary))],
      });
      return true;
    }
    if ((action === 'emergency-confirm' || action === 'emergency-cancel') && interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pending = pendingEmergencyClosures.get(reference);
      if (!pending || pending.guildId !== interaction.guildId || pending.userId !== interaction.user.id
        || pending.expiresAt <= Date.now()) throw new Error('确认已过期或不属于你，请重新点击频道内的关闭按钮。');
      pendingEmergencyClosures.delete(reference);
      if (action === 'emergency-cancel') { await interaction.editReply('已取消；频道保持开放。'); return true; }
      await emergencyManagerRole(interaction);
      const setting = settingsFor(interaction.guildId);
      const caseData = setting.emergencyChannels[pending.channelId];
      const channel = await interaction.guild.channels.fetch(pending.channelId).catch(() => null);
      if (!caseData || !channel || channel.type !== ChannelType.GuildText) throw new Error('紧急频道已不存在或记录未找到。');
      const recordChannel = await emergencyRecordChannel(interaction.guild, setting);
      if (!(await interaction.guild.members.fetchMe()).permissions.has(PermissionFlagsBits.ManageChannels)) {
        throw new Error('Bot 缺少删除频道所需的“管理频道”权限。');
      }
      if (activeEmergencyClosures.has(channel.id)) throw new Error('此频道正在由另一名管理员归档，请勿重复操作。');
      activeEmergencyClosures.add(channel.id);
      let recorded = false;
      const lockedOverwrites = [];
      try {
        for (const overwrite of channel.permissionOverwrites.cache.values()) {
          if (overwrite.id === client.user.id || overwrite.id === interaction.guildId
            || !overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;
          const original = {};
          for (const key of ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads']) {
            const bit = PermissionFlagsBits[key];
            original[key] = overwrite.allow.has(bit) ? true : overwrite.deny.has(bit) ? false : null;
          }
          await channel.permissionOverwrites.edit(overwrite.id, {
            SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false,
          },
            `紧急频道 ${caseData.caseId} 正在导出记录`);
          lockedOverwrites.push({ id: overwrite.id, original });
        }
        const transcript = await emergencyTranscriptFiles(channel, caseData.caseId);
        if (!(await emergencyTranscriptUnchanged(channel, transcript.newestIds))) {
          throw new Error('导出期间频道或子区出现新消息；已停止删除，请重试。');
        }
        await recordChannel.send({ content: `紧急频道记录 ${caseData.caseId}\n原频道：${caseData.name} (${channel.id})\n创建人：<@${caseData.createdBy}>\n关闭人：<@${interaction.user.id}>\n开设理由：${caseData.reason}\n消息数量：${transcript.count}\n聊天正文已加密保存；管理组可点击按钮查看。附件原件不随记录复制，记录中保留原链接。`,
          files: transcript.files,
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emergency-view:${caseData.caseId}`)
            .setLabel('查看聊天记录').setStyle(ButtonStyle.Secondary))],
          allowedMentions: { parse: [] } });
        recorded = true;
        if (!(await emergencyTranscriptUnchanged(channel, transcript.newestIds))) {
          throw new Error('上传记录期间频道或子区出现新消息；频道未删除，请重新导出。');
        }
        await channel.delete(`紧急频道 ${caseData.caseId} 已导出记录，由 ${interaction.user.id} 关闭`);
        delete setting.emergencyChannels[channel.id];
        await saveGuildData().catch((error) => logFailure('紧急频道删除后保存索引失败。', error));
      } catch (error) {
        for (const overwrite of lockedOverwrites) {
          await channel.permissionOverwrites.edit(overwrite.id, overwrite.original,
            '紧急频道关闭失败，恢复原有发言权限').catch(() => {});
        }
        if (recorded) throw new Error(`聊天记录已发送至 <#${recordChannel.id}>，频道仍保留：${error.message}`);
        throw error;
      } finally {
        activeEmergencyClosures.delete(channel.id);
      }
      await interaction.editReply(`聊天记录已发送至 <#${recordChannel.id}>，紧急频道已删除。`)
        .catch((error) => logFailure('紧急频道已关闭，但无法更新私密确认消息。', error));
      return true;
    }
    throw new Error('未知的紧急频道操作。');
  } catch (error) {
    logFailure('紧急频道操作失败。', error);
    const message = `紧急频道操作失败：${error.message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, components: [], embeds: [] }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!storageReady) {
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '机器人正在连接私密存储，请稍后重试。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  console.log(`收到 Discord 交互：${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.isContextMenuCommand() ? `右键/${interaction.commandName}` : interaction.isButton() ? '按钮' : interaction.isModalSubmit() ? '表单' : interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu() ? '菜单' : '交互'}（交互 ID ${interaction.id}，PID ${process.pid}）`);
  if (await handleManagementSpeechVerification(interaction)) return;
  if (await handleSpeechArchiveView(interaction)) return;
  if (await handleEmergencyChannelInteraction(interaction)) return;
  if (await handlePermissionPanelInteraction(interaction)) return;
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
          if (configuredCompanionRoleIds(setting).has(role.id)) {
            await interaction.followUp({ content: '这个身份组已被配置为配套身份组，不能同时用作中层管理身份组。', flags: MessageFlags.Ephemeral });
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
          if (configuredCompanionRoleIds(setting).has(role.id)) {
            await interaction.editReply('这个身份组已被配置为配套身份组，不能同时用作中层管理身份组。');
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
              await interaction.editReply({ content: `身份组 <@&${role.id}> 的实时名单仍位于 <#${oldChannelId}>；任免公示子区为 ${announcementThread}。成员正在后台同步。`,
                embeds: [managementPanelEmbed(guildId, 'middle')], components: managementPanelComponents(guildId, 'middle') });
              queueManagementPanelSync(interaction.guild, async () => {
                await syncManagementRole(interaction.guild, 'middle', null, role.id);
                return syncManagementCompanionRoles(interaction.guild);
              }, '中层管理成员同步');
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
          await interaction.editReply({ content: `已为 <@&${role.id}> 创建实时名单子区 ${thread} 和任免公示子区 ${announcementThread}，现有成员正在后台同步。`,
            embeds: [managementPanelEmbed(guildId, 'middle')], components: managementPanelComponents(guildId, 'middle') });
          queueManagementPanelSync(interaction.guild, async () => {
            await syncManagementRole(interaction.guild, 'middle', null, role.id);
            return syncManagementCompanionRoles(interaction.guild);
          }, '中层管理成员同步');
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
        if (action === 'mgmt-companion-config' && interaction.isButton()) {
          if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '需要“管理服务器”权限才能配置配套身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          const roleId = tier === 'middle' ? session.roleId : null;
          const track = managementTrack(settingsFor(guildId), tier, roleId);
          if (!track.roleId) {
            await interaction.reply({ content: tier === 'middle' ? '请先在面板选择一个已配置的中层管理身份组。' : '请先在面板配置管理组身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferUpdate();
          await interaction.followUp({ ...managementCompanionRolePanel(guildId, tier, roleId), flags: MessageFlags.Ephemeral });
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
          const panelUpdated = await editManagementPanelSource(interaction, guildId, tier);
          if (!panelUpdated) await interaction.followUp({ content: '设置已保存，但原面板消息已不存在。请重新运行对应的管理面板指令。', flags: MessageFlags.Ephemeral });
          await interaction.followUp({ content: '公示频道设置已保存；成员和配套身份组正在后台同步。', flags: MessageFlags.Ephemeral });
          queueManagementPanelSync(interaction.guild, async () => {
            if (track.roleId) await syncManagementRole(interaction.guild, tier, null, track.roleId);
            else await updateManagementRoster(interaction.guild, tier);
            return syncManagementCompanionRoles(interaction.guild);
          }, '管理组公示频道成员同步');
          return;
        }
        if (action === 'mgmt-companion-roles' && interaction.isRoleSelectMenu()) {
          const setting = settingsFor(guildId);
          const selectedRoleId = interaction.customId.split(':')[2] || null;
          const roleId = tier === 'middle' ? selectedRoleId : null;
          const track = managementTrack(setting, tier, roleId);
          const botMember = await interaction.guild.members.fetchMe();
          if (!track.roleId) {
            await interaction.followUp({ content: `请先配置${track.label}身份组，再选择配套身份组。`, flags: MessageFlags.Ephemeral });
            return;
          }
          const selectedRoleIds = [...new Set(interaction.values)];
          if (selectedRoleIds.length > 4) {
            await interaction.followUp({ content: '最多只能选择 4 个配套身份组。', flags: MessageFlags.Ephemeral });
            return;
          }
          const mainRoleIds = new Set(managementTracks(setting).map(([, , item]) => item.roleId).filter(Boolean));
          const selectedRoles = await Promise.all(selectedRoleIds.map((id) => interaction.guild.roles.fetch(id).catch(() => null)));
          if (selectedRoles.some((role) => !role || role.id === guildId || role.managed || mainRoleIds.has(role.id)
            || role.position >= botMember.roles.highest.position)) {
            await interaction.followUp({ content: '请选择普通身份组；配套身份组不能与任何管理身份组相同，且必须低于 Bot。', flags: MessageFlags.Ephemeral });
            return;
          }
          const previousRoleIds = [...(track.companionRoleIds || [])];
          track.companionRoleIds = selectedRoleIds;
          if (tier === 'middle') track.group.companionRoleIds = selectedRoleIds;
          else {
            setting.managementCompanionRoleIds = selectedRoleIds;
            setting.managementCompanionRoleId = selectedRoleIds[0] || null;
          }
          try {
            await saveGuildData();
          } catch (error) {
            track.companionRoleIds = previousRoleIds;
            if (tier === 'middle') track.group.companionRoleIds = previousRoleIds;
            else {
              setting.managementCompanionRoleIds = previousRoleIds;
              setting.managementCompanionRoleId = previousRoleIds[0] || null;
            }
            throw error;
          }
          await interaction.editReply(managementCompanionRolePanel(guildId, tier, roleId));
          await interaction.followUp({ content: '配套身份组设置已保存。现有成员的补发和移除正在后台同步；大型服务器可能需要较长时间。', flags: MessageFlags.Ephemeral });
          queueManagementPanelSync(interaction.guild,
            () => syncManagementCompanionRoles(interaction.guild, previousRoleIds), `${track.label}配套身份组同步`);
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
          if (configuredCompanionRoleIds(setting).has(role.id)) {
            await interaction.followUp({ content: '管理身份组不能与任何当前配套身份组相同，请先调整配套组或选择另一个身份组。', flags: MessageFlags.Ephemeral });
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
          const panelUpdated = await editManagementPanelSource(interaction, guildId, tier);
          if (!panelUpdated) await interaction.followUp({ content: '设置已保存，但原面板消息已不存在。请重新运行对应的管理面板指令。', flags: MessageFlags.Ephemeral });
          await interaction.followUp({ content: '管理身份组设置已保存；现有成员和配套身份组正在后台同步。', flags: MessageFlags.Ephemeral });
          queueManagementPanelSync(interaction.guild, async () => {
            if (track.channelId) await syncManagementRole(interaction.guild, tier);
            return syncManagementCompanionRoles(interaction.guild);
          }, '管理身份组成员同步');
          return;
        }
        if (action === 'mgmt-refresh' && interaction.isButton()) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const track = managementTrack(settingsFor(guildId), tier, tier === 'middle' ? session.roleId : null);
          if (!track.roleId || !track.channelId) {
            await interaction.editReply('尚未设置可用的公示频道或管理组身份组，请先完成配置。');
            return;
          }
          await interaction.editReply('已开始后台刷新管理组名单及配套身份组；大型服务器可能需要较长时间。');
          queueManagementPanelSync(interaction.guild, async () => {
            await syncManagementRole(interaction.guild, tier, null, track.roleId);
            return syncManagementCompanionRoles(interaction.guild);
          }, '管理组名单刷新');
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
    && ['处罚', '永封', '删帖', '锁定并关闭', '管理删帖', '管理锁定', '解锁', '管理解锁'].includes(interaction.commandName);
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

    if (commandName === '权限面板') {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('需要“管理服务器”权限才能配置权限面板。');
        return;
      }
      await interaction.guild.channels.fetch();
      await interaction.guild.roles.fetch();
      const session = {
        token: randomBytes(8).toString('hex'),
        guild: interaction.guild,
        guildId: interaction.guildId,
        creatorId: interaction.user.id,
        scope: 'guild',
        category: 'administration',
        selectedPermissions: [],
        updatedAt: Date.now(),
      };
      permissionPanelSessions.set(session.token, session);
      const message = await interaction.editReply({
        content: '权限配置仅在此处对你可见。',
        embeds: [permissionPanelEmbed(interaction.guild, session)],
        components: permissionPanelComponents(session),
      });
      session.messageId = message.id;
      return;
    }

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
      await interaction.followUp({ content: '可选设置删帖操作记录频道和办公室提醒频道。主管理身份组从 `/管理组面板` 读取；发起人计 1 票，需 3 名不同主管理组成员同意，第三票后由最后审批者等待 5 秒再确认。',
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
      const link = messageCommand ? interaction.targetMessage.url : options.getString('链接', true).trim();
      await createManagementDeleteProposal(interaction, link);
      return;
    }

    if (['解锁', '管理解锁'].includes(commandName)) {
      const link = messageCommand ? interaction.targetMessage.url : options.getString('链接', true).trim();
      await executeManagementThreadUnlock(interaction, link);
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
      const companionRoleResults = await Promise.all(track.companionRoleIds.map((id) => interaction.guild.roles.fetch(id).catch(() => null)));
      const companionRoles = companionRoleResults.filter(Boolean);
      if (companionRoles.some((companionRole) => (companionRole.managed || companionRole.position >= botMember.roles.highest.position)
        && member.roles.cache.has(companionRole.id))) {
        await interaction.editReply('机器人身份组必须高于全部配套身份组，才能一并办理卸任。');
        return;
      }
      const remainingCompanionRoleIds = companionRoleIdsForMember(member, new Set([role.id]));
      const rolesToRemove = [role, ...companionRoles.filter((companionRole) => !remainingCompanionRoleIds.has(companionRole.id))]
        .filter((targetRole) => member.roles.cache.has(targetRole.id));
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

    if (commandName === '说话' || commandName === '管理说话') {
      const managementSpeech = commandName === '管理说话';
      if (managementSpeech) {
        try { await emergencyManagerRole(interaction); }
        catch (error) { await interaction.editReply(error.message); return; }
      }
      const target = interaction.channel;
      if (!target?.isTextBased() || !target.guildId || target.guildId !== interaction.guildId) {
        await interaction.editReply('请在本服务器的文字频道或子区中使用此指令。');
        return;
      }
      if (target.type === ChannelType.GuildForum) {
        await interaction.editReply(`请先打开要发言的论坛帖子，再在该帖子内使用 \`/${commandName}\`。`);
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
      if (!managementSpeech && imitatesManagementSpeech(content)) {
        await interaction.editReply('普通 /说话 不能冒用管理组正式发言或认证标记。请让主管理组成员使用 /管理说话。');
        return;
      }
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
        if (!managementSpeech && !isConfiguredSeniorManagementMember(interaction)) {
          let oversizedRole;
          try {
            oversizedRole = await roleMentionOverMemberLimit(interaction.guild, roles, 100);
          } catch (error) {
            logFailure('无法核实 /说话 所提及身份组的人数。', error);
            await interaction.editReply('无法读取完整的服务器成员列表，因此不能核实身份组人数；这次 /说话 未发送。请检查 Bot 的 Server Members Intent 后重试。');
            return;
          }
          if (oversizedRole) {
            await interaction.editReply(`普通 /说话 不能提及身份组“${oversizedRole.name}”：该组成员超过 100 人。请减少提及范围或由管理组使用 /管理说话。`);
            return;
          }
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
      const sendOptions = { content: messageContent || undefined, ...replyOptions,
        ...(pictures.length ? { files: pictures.map((picture) => ({ attachment: picture.url, name: picture.name })) } : {}),
        allowedMentions: { parse: ['users', 'roles', ...(mentionsEveryone ? ['everyone'] : [])], repliedUser: false } };
      if (managementSpeech) {
        const nonce = randomBytes(12).toString('hex');
        const signature = managementSpeechSignature(interaction.guildId, target.id, interaction.user.id, nonce, messageContent);
        sendOptions.embeds = [new EmbedBuilder().setColor(0x5865F2).setTitle(MANAGEMENT_SPEECH_TITLE)
          .setDescription('此消息由 Bot 在核对主管理组身份后发布。点击下方按钮可验证来源。')
          .addFields({ name: '发言人', value: `<@${interaction.user.id}>` })
          .setFooter({ text: `${MANAGEMENT_SPEECH_FOOTER}${signature}` })];
        sendOptions.components = [new ActionRowBuilder().addComponents(new ButtonBuilder()
          .setCustomId(`management-speech-verify:${interaction.user.id}:${nonce}`)
          .setLabel('核验管理组发言').setStyle(ButtonStyle.Secondary))];
      }
      let archive;
      try {
        archive = await beginSpeechArchive(interaction, managementSpeech, messageContent, pictures, replyLink);
      } catch (error) {
        logFailure('说话留档写入失败，未发送原消息。', error);
        await interaction.editReply(`说话留档未完成，Bot 没有发言：${error.message}`);
        return;
      }
      let sent;
      try {
        sent = await target.send(sendOptions);
      } catch (error) {
        await updateSpeechArchive(interaction, archive, managementSpeech, '发送失败').catch((archiveError) =>
          logFailure('原消息发送失败后无法更新留档状态。', archiveError));
        throw error;
      }
      let archiveStatusFailed = false;
      try {
        await updateSpeechArchive(interaction, archive, managementSpeech, '已发送', sent.url);
      } catch (error) {
        archiveStatusFailed = true;
        logFailure('Bot 已发言，但留档消息链接更新失败。', error);
      }
      const result = managementSpeech
        ? '已发布可点击核验的管理组正式发言。'
        : replyLink ? '已由机器人在当前频道/子区回复该消息。' : '已由机器人在当前频道/子区发言。';
      await interaction.editReply(`${result}${archiveStatusFailed ? '加密留档已保存，但留档状态和消息链接更新失败，请检查留档频道。' : '操作人和发言内容已留档。'}`);
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
      if (message.embeds.some((embed) => embed.title === MANAGEMENT_SPEECH_TITLE
        || embed.footer?.text?.startsWith(MANAGEMENT_SPEECH_FOOTER))) {
        await interaction.editReply('管理组正式发言不允许通过 /编辑说话 修改；请由管理组重新发布。');
        return;
      }
      const newContent = options.getString('新内容', true);
      if (imitatesManagementSpeech(newContent)) {
        await interaction.editReply('不能把普通机器人消息编辑成管理组正式发言格式。');
        return;
      }
      await message.edit({ content: newContent, allowedMentions: { parse: [] } });
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
    const managementCommands = ['管理删帖', '管理锁定', '管理解锁', '解锁'];
    const message = managementCommands.includes(commandName)
      ? `${commandName}执行失败：${error.message || '未知错误'}。请检查管理组身份组、审批/公示频道配置和 Bot 权限。`
      : '操作失败。请检查机器人权限、身份组层级和控制台错误信息。';
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
