const { randomBytes } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const configurationCommand = new SlashCommandBuilder().setName('中层申请配置面板')
  .setDescription('主管理组添加和配置多套中层申请面板及审批流程')
  .setDefaultMemberPermissions(null);
const activeStatuses = new Set(['pending', 'executing', 'grant_failed']);
const DEFAULT_REJECTION_REASON = '本次申请未获通过，请按申请面板要求补充信息后重新申请。';
const DEFAULT_SUCCESS_REPLY = '你的中层申请已通过，欢迎加入！请遵守服务器管理规范并履行相应职责。';
const notificationLabels = { pending: '待发送', sending: '正在发送', sent: '已发送',
  failed: '发送失败，可重发', unknown: '结果未确认，须确认后重发' };
const successReplies = (app) => Object.values(app.successReplies || {});
const successSummary = (app) => successReplies(app).map((reply) =>
  `<@&${reply.roleId}>：${notificationLabels[reply.status] || '未完成'}`).join('\n');
const statusLabels = { pending: '待管理组审批', executing: '正在发放身份组', completed: '已通过并发放',
  rejected: '已拒绝', grant_failed: '审批通过，身份组发放未完成', delivery_failed: '申请卡发送未完成' };
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder()
  .setCustomId(id).setLabel(label).setStyle(style);
const hasRole = (member, roleId) => member?.roles?.cache?.has(roleId)
  || (Array.isArray(member?.roles) && member.roles.includes(roleId)) || false;
const prerequisitesMet = (member, roleIds) => roleIds.length > 0 && roleIds.every((id) => hasRole(member, id));
// Keep existing single-role configurations and pending applications readable.
const awardRoleIds = (record) => [...new Set(Array.isArray(record.roleIds)
  ? record.roleIds : [record.roleId])].filter(Boolean);
const awardMentions = (record) => awardRoleIds(record).map((id) => `<@&${id}>`).join('、') || '未设置';
const memberLockKey = (guildId, userId) => `member:${guildId}:${userId}`;

function createMiddleApplications(deps) {
  const { client, settingsFor, save, managerRoleId, logFailure, afterGrant } = deps;
  const sessions = new Map();
  const retryConfirmations = new Map();
  const locks = new Set();
  const counts = new Map();
  const publicPayloads = new Map();
  const refreshTimers = new Map();
  const refreshing = new Map();
  const refreshAgain = new Set();
  const forceRefresh = new Set();
  const publicRefreshErrors = new Map();
  const publicUpdatedAt = new Map();
  const dirtyCounts = new Set();
  const manualAt = new Map();

  function configurationManager(interaction) {
    return hasRole(interaction.member, managerRoleId(interaction.guildId));
  }

  function state(guildId) {
    const setting = settingsFor(guildId);
    setting.middleApplicationPanels ||= {};
    setting.middleApplications ||= [];
    setting.middleApplicationSuccessReplies ||= {};
    return { panels: setting.middleApplicationPanels, applications: setting.middleApplications,
      replyTemplates: setting.middleApplicationSuccessReplies };
  }
  function sessionFor(interaction, token) {
    const session = sessions.get(token);
    if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id
      || session.expiresAt < Date.now()) throw new Error('配置面板已过期，请重新运行 /中层申请配置面板。');
    if (!configurationManager(interaction)) throw new Error('您不具备权限，只有已配置的主管理组成员可以配置申请面板。');
    return session;
  }
  function configFor(session) {
    const config = state(session.guildId).panels[session.panelId];
    if (!config) throw new Error('这套申请面板配置已不存在。');
    return config;
  }
  function pendingCount(guildId, configId) {
    return state(guildId).applications.filter((app) => app.panelId === configId && activeStatuses.has(app.status)).length;
  }
  function overview(session) {
    const configs = Object.values(state(session.guildId).panels);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('中层申请面板配置')
      .setDescription('可创建多套独立面板。每套设置前置身份组、通过后身份组、管理组审批频道和公开申请频道。\n前置身份组须全部持有；管理组审批通过后自动发放。');
    const components = [];
    if (configs.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`midappcfg-select:${session.token}`)
      .setPlaceholder('选择要配置的申请面板').addOptions(configs.map((config) => ({
        label: config.name.slice(0, 100), value: config.id,
        description: `${config.enabled ? '开放申请' : '暂停申请'} · 待审批 ${pendingCount(session.guildId, config.id)} 人`,
      })))));
    components.push(row(button(`midappcfg-new:${session.token}`, '新增申请面板', ButtonStyle.Primary)
      .setDisabled(configs.length >= 25)));
    return { embeds: [embed], components, content: null, allowedMentions: { parse: [] } };
  }
  function editor(session) {
    const config = configFor(session);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(config.name)
      .setDescription(`${config.description || '未填写说明'}\n\n前置身份组（全部必需）：${config.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、') || '未设置'}\n通过后发放：${awardMentions(config)}\n审批频道：${config.approvalChannelId ? `<#${config.approvalChannelId}>` : '未设置'}\n公开申请频道：${config.channelId ? `<#${config.channelId}>` : '未设置'}\n审批：${config.votesRequired} 名不同主管理同意；任一主管理拒绝即结束\n状态：${config.enabled ? '开放申请' : '暂停申请'}\n已发布面板：${config.messages.length} 个\n\n审批身份组由 /管理组面板 的主管理身份组决定。通过后会同步已有中层身份组的配套身份。`);
    embed.addFields({ name: '新申请是否提及主管理组', value: config.mentionManagers !== false ? '提及' : '不提及' },
      { name: '默认拒绝理由', value: config.rejectionReasonDefault || DEFAULT_REJECTION_REASON });
    return { content: null, embeds: [embed], allowedMentions: { parse: [] }, components: [
      row(new RoleSelectMenuBuilder().setCustomId(`midappcfg-prerequisite:${session.token}`)
        .setPlaceholder('选择前置身份组（最多 10 个，必须全部持有）').setMinValues(1).setMaxValues(10)),
      row(new RoleSelectMenuBuilder().setCustomId(`midappcfg-role:${session.token}`)
        .setPlaceholder('选择审批通过后发放的身份组（最多 10 个）').setMinValues(1).setMaxValues(10)),
      row(new ChannelSelectMenuBuilder().setCustomId(`midappcfg-approval:${session.token}`)
        .setPlaceholder('选择管理组审批频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(new ChannelSelectMenuBuilder().setCustomId(`midappcfg-channel:${session.token}`)
        .setPlaceholder('选择公开申请频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(button(`midappcfg-edit:${session.token}`, '名称/说明/票数/通知设置'),
        button(`midappcfg-replies:${session.token}`, '通过回信设置'),
        button(`midappcfg-publish:${session.token}`, '发布申请面板', ButtonStyle.Primary),
        button(`midappcfg-more:${session.token}`, '更多操作'),
        button(`midappcfg-back:${session.token}`, '其他面板')),
    ] };
  }
  function morePayload(session) {
    const config = configFor(session);
    return { content: null, embeds: [new EmbedBuilder().setTitle(`${config.name} · 更多操作`)],
      components: [row(button(`midappcfg-toggle:${session.token}`, config.enabled ? '暂停申请' : '开放申请'),
        button(`midappcfg-delete:${session.token}`, '删除配置', ButtonStyle.Danger),
        button(`midappcfg-select-back:${session.token}`, '返回配置'))], allowedMentions: { parse: [] } };
  }
  function selectedReplyRole(session, roleId = session.replyRoleId) {
    if (!roleId || !awardRoleIds(configFor(session)).includes(roleId)) throw new Error('请先选择本面板的发放身份组。');
    return roleId;
  }
  function replyBody(guildId, roleId) {
    return state(guildId).replyTemplates[roleId] || DEFAULT_SUCCESS_REPLY;
  }
  function replyEditor(session, guild) {
    const config = configFor(session);
    const ids = awardRoleIds(config);
    if (!ids.includes(session.replyRoleId)) session.replyRoleId = null;
    const roleId = session.replyRoleId;
    const components = [];
    if (ids.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`midappcfg-reply-role:${session.token}`)
      .setPlaceholder('选择要设置通过回信的发放身份组').addOptions(ids.map((id) => ({
        label: (guild.roles.cache.get(id)?.name || id).slice(0, 100), value: id, default: id === roleId,
      })))));
    components.push(row(button(`midappcfg-reply-edit:${session.token}:${roleId || 'none'}`, '编辑正文').setDisabled(!roleId),
      button(`midappcfg-reply-preview:${session.token}:${roleId || 'none'}`, '预览').setDisabled(!roleId),
      button(`midappcfg-reply-reset:${session.token}:${roleId || 'none'}`, '恢复默认').setDisabled(!roleId),
      button(`midappcfg-select-back:${session.token}`, '返回配置')));
    return { content: null, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('通过回信设置')
      .setDescription(`同一服务器内，同一身份组在所有申请面板共用回信正文（最多 2000 字）。每个申请目标身份组一封私信，配套身份组不另发信。\n新配置不改变已通过申请的回信快照。${roleId ? `\n\n当前身份组：<@&${roleId}>\n内容来源：${state(session.guildId).replyTemplates[roleId] ? '自定义' : '默认'}\n\n${replyBody(session.guildId, roleId)}` : '\n\n请选择一个发放身份组。'}`)],
    components, allowedMentions: { parse: [] } };
  }
  function successPayload(app, reply, preview = false) {
    return { embeds: [new EmbedBuilder().setColor(0x2ECC71).setTitle(preview ? '通过回信预览' : '中层申请已通过')
      .setDescription(reply.body).addFields(
        { name: '服务器', value: reply.guildName.slice(0, 200) },
        { name: '申请面板', value: reply.panelName.slice(0, 200) },
        { name: '获批身份组', value: `${reply.roleName.slice(0, 200)} (${reply.roleId})` })
      .setFooter({ text: preview ? '仅预览，不发送私信' : `申请 ${app.id} · 可在“我的申请”查看回信` })],
    allowedMentions: { parse: [] } };
  }
  function freezeSuccessReplies(guild, app) {
    // Only an approval performed by this version opts in. Historical completed
    // records remain untouched; companion roles are intentionally excluded.
    if (app.successReplyVersion !== 1 || app.successReplies) return;
    app.successReplies = Object.fromEntries(awardRoleIds(app).map((roleId) => [roleId, {
      roleId, roleName: guild.roles.cache.get(roleId)?.name || roleId,
      guildName: guild.name, panelName: app.panelName, body: replyBody(guild.id, roleId),
      status: 'pending', frozenAt: Date.now(),
    }]));
  }
  function successViewComponents(app) {
    const replies = successReplies(app);
    return replies.length ? [row(new StringSelectMenuBuilder().setCustomId(`midapp-success-view:${app.id}`)
      .setPlaceholder('按获批身份组查看通过回信').addOptions(replies.map((reply) => ({
        label: reply.roleName.slice(0, 100), value: reply.roleId,
        description: notificationLabels[reply.status] || '未完成',
      }))))] : [];
  }
  function form(token, config) {
    const field = (id, label, style, max, value) => new LabelBuilder().setLabel(label)
      .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max)
        .setRequired(true).setValue(value));
    return new ModalBuilder().setCustomId(`midappcfg-form:${token}:${config?.id || 'new'}`).setTitle(config ? '编辑中层申请面板' : '新增中层申请面板')
      .addComponents(field('name', '面板名称', TextInputStyle.Short, 80, config?.name || '中层申请'),
        field('description', '面板说明', TextInputStyle.Paragraph, 800, config?.description || '请填写申请理由，提交后由管理组审批。'),
        field('votes', '需要多少名不同管理组成员同意（1–10）', TextInputStyle.Short, 2, String(config?.votesRequired || 1)),
        field('rejectionReasonDefault', '默认拒绝理由（每次拒绝时仍可修改）', TextInputStyle.Paragraph, 400,
          config?.rejectionReasonDefault || DEFAULT_REJECTION_REASON),
        new LabelBuilder().setLabel('新申请是否提及主管理组')
          .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('mentionManagers')
            .setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
              { label: '提及主管理组', value: 'yes', default: config?.mentionManagers !== false },
              { label: '不提及主管理组', value: 'no', default: config?.mentionManagers === false })));
  }
  function publicPayload(guildId, config) {
    const current = counts.get(guildId);
    const roleIds = awardRoleIds(config);
    const countText = roleIds.map((id) => {
      const count = current?.values.get(id);
      const failure = current?.error || current?.roleErrors?.get(id);
      const value = count === undefined ? (failure ? '读取失败，请主管理点击刷新人数' : '正在读取')
        : `${count} 人${failure ? '（上次结果，更新失败）' : ''}`;
      return `${roleIds.length > 1 ? `<@&${id}>：` : ''}${value}`;
    }).join('\n') || '未设置发放身份组';
    const failure = current?.error || roleIds.map((id) => current?.roleErrors?.get(id)).find(Boolean);
    return { embeds: [new EmbedBuilder().setColor(config.enabled ? 0x5865F2 : 0x95A5A6).setTitle(config.name)
      .setDescription(`${config.description}\n\n前置身份组：${config.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、')}（须全部持有）\n通过后身份组：${awardMentions(config)}\n当前人数：${countText}\n待审批：${pendingCount(guildId, config.id)} 人\n审批门槛：${config.votesRequired} 名管理组成员同意\n${config.enabled ? '点击下方按钮填写申请理由。' : '当前暂停新申请。'}${failure ? `\n人数读取失败说明：${failure}` : ''}`)
      .setFooter({ text: `申请面板 ${config.id} · Discord 身份组人数（含 Bot），随成员变更更新` })],
    components: [row(button(`midapp-apply:${config.id}`, '填写申请理由', ButtonStyle.Primary).setDisabled(!config.enabled),
      button(`midapp-status:${config.id}`, '我的申请'), button(`midapp-refresh:${config.id}`, '刷新人数'))], allowedMentions: { parse: [] } };
  }
  function approvalPayload(app) {
    return { embeds: [new EmbedBuilder().setColor(app.status === 'completed' ? 0x2ECC71 : app.status === 'rejected' ? 0xE74C3C : 0x5865F2)
      .setTitle(`中层申请：${app.panelName}`).setDescription(`申请人：<@${app.userId}> (${app.userId})\n申请身份组：${awardMentions(app)}\n前置身份组：${app.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、')}\n\n申请理由：\n${app.reason}\n\n状态：${statusLabels[app.status] || app.status}\n同意票：${app.approverIds.length}/${app.votesRequired}\n已同意：${app.approverIds.map((id) => `<@${id}>`).join('、') || '无'}${app.decidedBy && app.status !== 'rejected' ? `\n处理人（仅内部审批卡）：<@${app.decidedBy}>` : ''}${app.rejectionReason ? `\n拒绝理由：${app.rejectionReason}` : ''}${app.rejectionNotification ? `\n申请人私信通知：${notificationLabels[app.rejectionNotification.status] || '未完成'}` : ''}${app.failure ? `\n失败说明：${app.failure.slice(0, 500)}` : ''}`)
      .addFields(...(successReplies(app).length ? [{ name: '通过回信投递状态', value: successSummary(app) }] : []))
      .setFooter({ text: `申请 ${app.id} · 申请人不能审批自己的申请` }).setTimestamp(app.createdAt)],
    components: ['pending', 'grant_failed'].includes(app.status) ? [row(
      button(`midapp-approve:${app.id}`, app.status === 'grant_failed' ? '重试发放身份组' : '同意', ButtonStyle.Success),
      button(`midapp-reject:${app.id}`, '拒绝并填写理由', ButtonStyle.Danger))]
      : app.status === 'rejected' && app.rejectionReason && app.rejectionNotification?.status !== 'sent'
        ? [row(button(`midapp-notify:${app.id}`, '重发拒绝通知'))]
        : app.status === 'completed' && successReplies(app).some((reply) => ['pending', 'failed', 'unknown'].includes(reply.status))
          ? [row(button(`midapp-success-retry:${app.id}`, '重发未送达回信'))] : [], allowedMentions: { parse: [] } };
  }
  function applicantPayload(app) {
    return { embeds: [new EmbedBuilder().setTitle(`我的申请：${app.panelName}`)
      .setColor(app.status === 'rejected' ? 0xE74C3C : app.status === 'completed' ? 0x2ECC71 : 0x5865F2)
      .setDescription(`申请身份组：${awardMentions(app)}\n状态：${statusLabels[app.status] || app.status}\n同意票：${app.approverIds.length}/${app.votesRequired}\n\n申请理由：\n${app.reason}${app.status === 'rejected' ? `\n\n拒绝理由：\n${app.rejectionReason || '未填写，请联系管理组。'}` : ''}`)
      .addFields(...(successReplies(app).length ? [{ name: '通过回信', value: successSummary(app) }] : []))
      .setFooter({ text: `申请 ${app.id}` }).setTimestamp(app.createdAt)],
    components: app.status === 'completed' ? successViewComponents(app) : [], allowedMentions: { parse: [] } };
  }
  async function notifySuccess(guild, app, { retry = false, allowUnknown = false } = {}) {
    if (app.status !== 'completed' || app.successReplyVersion !== 1) return;
    for (const reply of successReplies(app)) {
      if (!(reply.status === 'pending' || (retry && reply.status === 'failed')
        || (allowUnknown && reply.status === 'unknown'))) continue;
      const previous = { ...reply };
      Object.assign(reply, { status: 'sending', attemptedAt: Date.now(), attempts: (reply.attempts || 0) + 1 });
      delete reply.code;
      try { await save(); } catch (error) {
        Object.keys(reply).forEach((key) => delete reply[key]); Object.assign(reply, previous);
        logFailure('通过回信发送状态保存失败，尚未发送。', error);
        break;
      }
      try {
        const user = await client.users.fetch(app.userId);
        const message = await user.send(successPayload(app, reply));
        Object.assign(reply, { status: 'sent', deliveredAt: Date.now(), messageId: message.id });
      } catch (error) {
        // A definite 4xx rejection can be retried. A lost response/5xx could
        // already have delivered the DM and requires explicit confirmation.
        const definiteFailure = error.status >= 400 && error.status < 500
          || [50007, 10013].includes(Number(error.code));
        Object.assign(reply, { status: definiteFailure ? 'failed' : 'unknown', code: error.code || null,
          failedAt: Date.now() });
        logFailure(`中层申请 ${app.id} 身份组 ${reply.roleId} 的通过回信未确认送达。`, error);
      }
      try { await save(); } catch (error) {
        // Preserve confirmed success in memory; persisted "sending" becomes
        // "unknown" on restart rather than blindly sending another copy.
        logFailure('通过回信发送结果保存失败，重启后须手动确认。', error);
        break;
      }
    }
  }
  async function notifyRejection(guild, app) {
    if (app.rejectionNotification?.status === 'sent') return true;
    const previous = app.rejectionNotification;
    app.rejectionNotification = { status: 'sending', attemptedAt: Date.now() };
    try { await save(); } catch (error) {
      app.rejectionNotification = previous || { status: 'pending' };
      logFailure('拒绝私信发送状态保存失败，尚未发送。', error);
      return false;
    }
    try {
      const user = await client.users.fetch(app.userId);
      const roleName = awardRoleIds(app).map((id) => guild.roles.cache.get(id)?.name || `身份组 ${id}`).join('、');
      const message = await user.send({ embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('中层申请未通过')
        .setDescription(`服务器：${guild.name}\n申请面板：${app.panelName}\n申请身份组：${roleName}\n\n拒绝理由：\n${app.rejectionReason}`)
        .setFooter({ text: `申请 ${app.id} · 可在原申请面板查看进度` }).setTimestamp()], allowedMentions: { parse: [] } });
      app.rejectionNotification = { status: 'sent', deliveredAt: Date.now(), messageId: message.id };
    } catch (error) {
      app.rejectionNotification = { status: 'failed', attemptedAt: Date.now(), code: error.code || null };
      logFailure(`中层申请 ${app.id} 的拒绝私信发送失败。`, error);
    }
    await save().catch((error) => logFailure('拒绝私信发送结果保存失败。', error));
    return app.rejectionNotification.status === 'sent';
  }
  async function channelFor(guild, id) {
    const channel = id && await guild.channels.fetch(id).catch(() => null);
    const me = await guild.members.fetchMe();
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
      || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error('频道不存在，或 Bot 缺少查看、发言、嵌入链接、读取历史权限。');
    return channel;
  }
  async function grantableRole(guild, id) {
    const [role, me] = await Promise.all([guild.roles.fetch(id).catch(() => null), guild.members.fetchMe()]);
    if (!role || role.id === guild.id || role.managed || id === managerRoleId(guild.id)
      || !me.permissions.has(PermissionFlagsBits.ManageRoles) || role.comparePositionTo(me.roles.highest) >= 0) {
      throw new Error('发放身份组必须是普通身份组、不同于主管理组，且层级低于 Bot；Bot 需要“管理身份组”权限。');
    }
    return role;
  }
  async function manager(guild, userId) {
    const member = await guild.members.fetch({ user: userId, force: true });
    return member.permissions.has(PermissionFlagsBits.Administrator) || hasRole(member, managerRoleId(guild.id));
  }
  async function refreshCounts(guild, force = false) {
    let current = counts.get(guild.id);
    const roleIds = new Set(Object.values(state(guild.id).panels).flatMap(awardRoleIds));
    if (!roleIds.size) return;
    if (current?.loading) {
      await current.loading;
      if([...roleIds].every(id=>current.values.has(id)||current.roleErrors.has(id)))return;
    }
    const cooldown=force?60000:15*60000;
    if (current && Date.now()-(current.attemptedAt||current.updatedAt)<cooldown) return;
    current ||= { values: new Map(), roleErrors: new Map(), updatedAt: 0 };
    current.attemptedAt=Date.now();
    counts.set(guild.id, current);
    current.loading = (async () => {
      try {
        const totals = await guild.roles.fetchMemberCounts();
        const values = new Map();
        const errors = new Map();
        for (const id of roleIds) {
          const value = totals.get(id);
          if (Number.isInteger(value) && value >= 0) values.set(id, value);
          else errors.set(id, 'Discord 未返回该身份组的统计，请检查身份组是否仍存在。');
        }
        current.values = values;
        current.roleErrors = errors;
        current.updatedAt = Date.now();
        current.error = null; dirtyCounts.delete(guild.id);
      } catch (error) {
        current.error = `Discord 人数请求失败${error.code ? `（${error.code}）` : ''}，请稍后重试。`;
        throw error;
      }
    })();
    try { await current.loading; } finally { current.loading = null; }
  }
  async function refreshPublic(guild, force = false) {
    if(!force&&Date.now()-(publicUpdatedAt.get(guild.id)||0)<15*60000){scheduleRefresh(guild);return;}
    if (refreshing.has(guild.id)) {
      refreshAgain.add(guild.id);
      if (force) forceRefresh.add(guild.id);
      return refreshing.get(guild.id);
    }
    const work = (async () => {
      await refreshCounts(guild).catch((error) => logFailure('中层申请人数读取失败。', error));
      publicUpdatedAt.set(guild.id,Date.now());
      let pruned = false;
      for (const config of Object.values(state(guild.id).panels)) {
        const payload=publicPayload(guild.id,config),signature=JSON.stringify(payload);
        for (const ref of [...config.messages]) {
          const key = `${guild.id}:${ref.channelId}:${ref.messageId}`;
          // Counts and pending applications can stay unchanged for hours. A
          // periodic check should not spend message API quota on identical edits.
          if(publicPayloads.get(key)===signature)continue;
          try {
            const channel = await guild.channels.fetch(ref.channelId);
            if (!channel) {
              const error = new Error('公开申请频道已不存在。');
              error.code = 10003;
              throw error;
            }
            const message = await channel.messages.fetch(ref.messageId);
            await message.edit(payload);
            publicPayloads.set(key,signature);
            if(publicPayloads.size>1000)publicPayloads.delete(publicPayloads.keys().next().value);
            publicRefreshErrors.delete(key);
          } catch (error) {
            if ([10008, 10003].includes(Number(error.code ?? error.rawError?.code))) {
              // Prune only the missing reference, preserving the panel's settings and applications.
              const live = state(guild.id).panels[config.id];
              if (live) {
                const before = live.messages.length;
                live.messages = live.messages.filter(item => item.channelId !== ref.channelId || item.messageId !== ref.messageId);
                pruned ||= before !== live.messages.length;
              }
              publicRefreshErrors.delete(key);
              publicPayloads.delete(key);
              console.log(`已清理失效的中层申请公开面板引用：${key}，可在配置面板重新发布。`);
            } else if (Date.now() - (publicRefreshErrors.get(key) || 0) > 5 * 60 * 1000) {
              publicRefreshErrors.set(key, Date.now());
              logFailure('中层申请公开面板更新失败（同一消息每5分钟最多记录一次）。', error);
              if (publicRefreshErrors.size > 1000) publicRefreshErrors.delete(publicRefreshErrors.keys().next().value);
            }
          }
        }
      }
      if (pruned) await save();
    })();
    refreshing.set(guild.id, work);
    try { await work; } finally {
      refreshing.delete(guild.id);
      if (refreshAgain.delete(guild.id)) scheduleRefresh(guild, forceRefresh.has(guild.id));
    }
  }
  function scheduleRefresh(guild, force = false) {
    if (!Object.keys(state(guild.id).panels).length) return;
    if (force) forceRefresh.add(guild.id);
    if (refreshTimers.has(guild.id)) return;
    refreshTimers.set(guild.id, setTimeout(() => {
      refreshTimers.delete(guild.id);
      refreshPublic(guild, forceRefresh.delete(guild.id)).catch((error) => logFailure('中层申请人数更新失败。', error));
    }, Math.max(1000,15*60000-(Date.now()-(publicUpdatedAt.get(guild.id)||0)))));
    refreshTimers.get(guild.id)?.unref?.();
  }
  function onMember(member, removed = false, previousMember = null) {
    const ids = Object.values(state(member.guild.id).panels).flatMap(awardRoleIds);
    if (removed || ids.some((id) => previousMember
      ? hasRole(previousMember, id) !== hasRole(member, id) : hasRole(member, id))) {
      dirtyCounts.add(member.guild.id); scheduleRefresh(member.guild);
    }
  }
  function onRaw(packet) {
    if (!['GUILD_MEMBER_REMOVE', 'GUILD_MEMBER_UPDATE'].includes(packet.t)) return;
    const guild = client.guilds.cache.get(packet.d?.guild_id);
    if (!guild) return;
    // Removed or uncached members may not produce a discord.js member event.
    if (packet.t === 'GUILD_MEMBER_REMOVE' || (Array.isArray(packet.d.roles)
      && !guild.members.cache.has(packet.d.user?.id))) {dirtyCounts.add(guild.id); scheduleRefresh(guild);}
  }
  async function updateApproval(guild, app) {
    if (!app.approvalMessageId) return;
    const channel = await guild.channels.fetch(app.approvalChannelId);
    const message = await channel.messages.fetch(app.approvalMessageId);
    await message.edit(approvalPayload(app));
  }
  async function submit(interaction, config) {
    config = JSON.parse(JSON.stringify(config));
    const applications = state(interaction.guildId).applications;
    const key = memberLockKey(interaction.guildId, interaction.user.id);
    if (locks.has(key)) throw new Error('你的申请正在处理，请稍后查看“我的申请”。');
    locks.add(key);
    try {
      if (!config.enabled) throw new Error('这套面板已暂停申请。');
      const roleIds = awardRoleIds(config);
      if (!roleIds.length || roleIds.length > 10) throw new Error('请配置 1–10 个发放身份组。');
      if (applications.some((app) => app.userId === interaction.user.id && awardRoleIds(app).some((id) => roleIds.includes(id))
        && activeStatuses.has(app.status))) throw new Error('同一身份组已有待处理申请，请勿重复提交。');
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      if (member.user.bot || !prerequisitesMet(member, config.prerequisiteRoleIds)) throw new Error('你必须持有本面板要求的全部前置身份组。');
      if (roleIds.every((id) => hasRole(member, id))) throw new Error('你已持有全部目标身份组，无需申请。');
      for (const id of roleIds) await grantableRole(interaction.guild, id);
      const channel = await channelFor(interaction.guild, config.approvalChannelId);
      const roleId = managerRoleId(interaction.guildId);
      if (!roleId) throw new Error('请先配置 /管理组面板 的主管理身份组。');
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!reason) throw new Error('请填写申请理由。');
      const app = { id: randomBytes(8).toString('hex'), panelId: config.id, panelName: config.name,
        userId: member.id, roleId: roleIds[0], roleIds, prerequisiteRoleIds: [...config.prerequisiteRoleIds],
        reason, votesRequired: config.votesRequired, approverIds: [], status: 'pending',
        createdAt: Date.now(), approvalChannelId: channel.id, approvalMessageId: null };
      applications.push(app);
      try { await save(); } catch (error) { applications.splice(applications.indexOf(app), 1); throw error; }
      try {
        const mentionManagers = config.mentionManagers !== false;
        const message = await channel.send({ ...approvalPayload(app),
          content: `${mentionManagers ? `<@&${roleId}> ` : ''}有新的中层申请待审批。`,
          allowedMentions: { parse: [], roles: mentionManagers ? [roleId] : [] } });
        app.approvalMessageId = message.id;
        await save();
      } catch (error) {
        app.status = 'delivery_failed';
        app.failure = error.message;
        await save().catch((failure) => logFailure('申请发送失败状态保存失败。', failure));
        await updateApproval(interaction.guild, app).catch(() => {});
        throw new Error('申请卡未能完整保存到审批频道，请检查 Bot 权限和存储连接后重新申请。');
      }
      scheduleRefresh(interaction.guild);
      await interaction.editReply(`申请已提交（${app.id}）。管理组审批通过后会自动发放身份组；你可点击公开面板的“我的申请”查看进度。`);
    } finally { locks.delete(key); }
  }
  async function review(interaction, app, reject, rejectionReason, sourceMessageId = interaction.message?.id) {
    const key = memberLockKey(interaction.guildId, app.userId);
    if (locks.has(key)) throw new Error('这项申请正在处理另一项操作，请稍后重试。');
    locks.add(key);
    try {
      if (!['pending', 'grant_failed'].includes(app.status)) throw new Error('这项申请已处理或正在发放，请勿重复审批。');
      if (app.approvalChannelId !== interaction.channelId || app.approvalMessageId !== sourceMessageId) throw new Error('请在原审批卡上操作。');
      if (app.userId === interaction.user.id) throw new Error('不能审批自己的申请。');
      if (!(await manager(interaction.guild, interaction.user.id))) throw new Error('只有主管理组成员或服务器管理员可以审批。');
      const previous = JSON.parse(JSON.stringify(app));
      if (reject) {
        const reason = String(rejectionReason || '').trim();
        if (!reason || reason.length > 400) throw new Error('请填写 1–400 字的拒绝理由。');
        app.status = 'rejected'; app.decidedBy = interaction.user.id; app.decidedAt = Date.now();
        app.rejectionReason = reason;
        app.rejectionNotification = { status: 'pending' };
        delete app.failure;
      } else {
        const validVoters = [];
        for (const id of app.approverIds) {
          if (id !== app.userId && await manager(interaction.guild, id).catch(() => false)) validVoters.push(id);
        }
        const duplicate = validVoters.includes(interaction.user.id);
        app.approverIds = [...new Set([...validVoters, interaction.user.id])];
        if (duplicate && app.status === 'pending' && app.approverIds.length < app.votesRequired) throw new Error('你已同意过，每人只算一票。');
        if (app.approverIds.length >= app.votesRequired) {
          app.status = 'executing'; app.decidedBy = interaction.user.id; app.decidedAt = Date.now(); delete app.failure;
          app.successReplyVersion = 1;
        } else app.status = 'pending';
      }
      try { await save(); } catch (error) { Object.keys(app).forEach((key) => delete app[key]); Object.assign(app, previous); throw error; }
      if (app.status === 'rejected') await notifyRejection(interaction.guild, app);
      await updateApproval(interaction.guild, app).catch((error) => logFailure('中层申请审批卡更新失败。', error));
      if (app.status === 'executing') {
        try {
          const roleIds = awardRoleIds(app);
          if (!roleIds.length || roleIds.length > 10) throw new Error('申请记录中的发放身份组无效。');
          for (const id of roleIds) await grantableRole(interaction.guild, id);
          let member = await interaction.guild.members.fetch({ user: app.userId, force: true });
          if (!prerequisitesMet(member, app.prerequisiteRoleIds)) throw new Error('申请人已不再持有全部前置身份组，未发放。');
          // Single-role PUTs preserve unrelated roles changed concurrently; retries
          // only deliver missing roles if an earlier batch stopped partway through.
          for (const id of roleIds) if (!hasRole(member, id)) {
            member = await member.roles.add(id, `中层申请 ${app.id} 由 ${interaction.user.id} 审批通过`);
          }
          app.status = 'completed';
          freezeSuccessReplies(interaction.guild, app);
          await save();
          await afterGrant(member, roleIds).catch((error) => logFailure('中层申请配套身份同步失败。', error));
          onMember(member);
        } catch (error) {
          // If role delivery succeeded but persistence failed, keep an executing
          // record so restart recovery checks membership instead of granting twice.
          if (app.status === 'completed') app.status = 'executing';
          else app.status = 'grant_failed';
          app.failure = error.message;
          await save().catch((failure) => logFailure('身份发放结果保存失败。', failure));
        }
      }
      // DM failures cannot roll back a completed approval or awarded roles.
      if (app.status === 'completed') await notifySuccess(interaction.guild, app);
      await updateApproval(interaction.guild, app).catch((error) => logFailure('中层申请结果卡更新失败。', error));
      scheduleRefresh(interaction.guild);
      await interaction.editReply(app.status === 'completed' ? `审批通过，已自动发放身份组。通过回信已送达 ${successReplies(app).filter((reply) => reply.status === 'sent').length}/${successReplies(app).length} 封；未送达回信可在审批卡重发，申请人也可在“我的申请”读取。`
        : app.status === 'rejected' ? (app.rejectionNotification?.status === 'sent'
          ? '已拒绝申请，并私信告知理由。私信和申请人进度页不显示处理人。'
          : '已拒绝申请并保存理由，但私信未发送成功。申请人可能关闭了私信，可在内部审批卡重发；申请人也可在“我的申请”查看理由。')
          : ['grant_failed', 'executing'].includes(app.status) ? `身份组发放或记录保存未完成：${app.failure || '请稍后查看状态'}。`
            : `已记录同意票（${app.approverIds.length}/${app.votesRequired}）。`);
    } finally { locks.delete(key); }
  }

  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && interaction.commandName === '中层申请配置面板';
    const customId = interaction.customId || '';
    if (!command && !customId.startsWith('midapp')) return false;
    let privateReply = false;
    let configurationLock;
    try {
      if (!interaction.inGuild()) throw new Error('中层申请只能在服务器中使用。');
      if (command) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        privateReply = true;
        if (!configurationManager(interaction)) throw new Error('您不具备权限，只有已配置的主管理组成员可以配置申请面板。');
        for (const [token, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(token);
        const token = randomBytes(8).toString('hex');
        const session = { token, guildId: interaction.guildId, userId: interaction.user.id, expiresAt: Date.now() + 30 * 60 * 1000 };
        sessions.set(token, session);
        await interaction.editReply(overview(session)); return true;
      }
      const [action, reference, anchor] = customId.split(':');
      if (action.startsWith('midappcfg-')) {
        const session = sessionFor(interaction, reference);
        if (action === 'midappcfg-reply-edit' && interaction.isButton()) {
          const id = selectedReplyRole(session, anchor);
          await interaction.showModal(new ModalBuilder().setCustomId(`midappcfg-reply-form:${reference}:${id}`)
            .setTitle('编辑身份组通过回信').addComponents(new LabelBuilder().setLabel('回信正文（系统另附服务器、面板和获批身份组）')
              .setTextInputComponent(new TextInputBuilder().setCustomId('body').setStyle(TextInputStyle.Paragraph)
                .setRequired(true).setMaxLength(2000).setValue(replyBody(interaction.guildId, id)))));
          return true;
        }
        if (['midappcfg-replies', 'midappcfg-reply-role', 'midappcfg-reply-form',
          'midappcfg-reply-preview', 'midappcfg-reply-reset', 'midappcfg-more'].includes(action)) {
          if (action === 'midappcfg-reply-form' || action === 'midappcfg-reply-preview') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
          } else await interaction.deferUpdate();
          if (action === 'midappcfg-more') { await interaction.editReply(morePayload(session)); return true; }
          configFor(session);
          if (action === 'midappcfg-reply-role') session.replyRoleId = selectedReplyRole(session, interaction.values[0]);
          if (['midappcfg-reply-form', 'midappcfg-reply-preview', 'midappcfg-reply-reset'].includes(action)) {
            const id = selectedReplyRole(session, anchor);
            const role = await interaction.guild.roles.fetch(id);
            if (!role) throw new Error('该身份组已不存在，请重新选择发放身份组。');
            session.replyRoleId = id;
            if (action === 'midappcfg-reply-preview') {
              await interaction.editReply(successPayload({}, { roleId: id, roleName: role.name,
                guildName: interaction.guild.name, panelName: configFor(session).name,
                body: replyBody(interaction.guildId, id) }, true)); return true;
            }
            configurationLock = `replycfg:${interaction.guildId}:${id}`;
            if (locks.has(configurationLock)) { configurationLock = null; throw new Error('该身份组回信正在保存，请稍后重试。'); }
            locks.add(configurationLock);
            const templates = state(interaction.guildId).replyTemplates;
            const previous = templates[id];
            if (action === 'midappcfg-reply-form') {
              const body = interaction.fields.getTextInputValue('body').trim();
              if (!body || body.length > 2000) throw new Error('请填写 1–2000 字的回信正文。');
              templates[id] = body;
            } else delete templates[id];
            try { await save(); } catch (error) {
              if (previous === undefined) delete templates[id]; else templates[id] = previous;
              throw error;
            }
          }
          await interaction.editReply(replyEditor(session, interaction.guild)); return true;
        }
        if (['midappcfg-new', 'midappcfg-edit'].includes(action) && interaction.isButton()) {
          session.editingId = action === 'midappcfg-edit' ? configFor(session).id : null;
          if (!session.editingId && Object.keys(state(interaction.guildId).panels).length >= 25) throw new Error('最多配置 25 套申请面板。');
          await interaction.showModal(form(reference, session.editingId ? configFor(session) : null)); return true;
        }
        if (action === 'midappcfg-form' && interaction.isModalSubmit()) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          privateReply = true;
          const editingId = anchor === 'new' ? null : anchor;
          if (!anchor) throw new Error('配置表单已失效，请重新打开。');
          configurationLock = `cfg:${interaction.guildId}:${editingId || 'new'}`;
          if (locks.has(configurationLock)) { configurationLock = null; throw new Error('配置正在保存，请稍后重试。'); }
          locks.add(configurationLock);
          const name = interaction.fields.getTextInputValue('name').trim();
          const description = interaction.fields.getTextInputValue('description').trim();
          const votesInput = interaction.fields.getTextInputValue('votes').trim();
          const rejectionReasonDefault = interaction.fields.getTextInputValue('rejectionReasonDefault').trim();
          const mentionChoice = interaction.fields.getStringSelectValues('mentionManagers')[0];
          if (!['yes', 'no'].includes(mentionChoice)) throw new Error('请选择是否提及主管理组。');
          if (!name || !description || !rejectionReasonDefault || !/^(?:[1-9]|10)$/.test(votesInput)) throw new Error('请填写名称、说明、默认拒绝理由和 1–10 的审批人数。');
          const panels = state(interaction.guildId).panels;
          if (editingId && !panels[editingId]) throw new Error('这套配置已被删除。');
          if (!editingId && Object.keys(panels).length >= 25) throw new Error('最多配置 25 套申请面板。');
          const id = editingId || randomBytes(6).toString('hex');
          const previous = panels[id] && JSON.parse(JSON.stringify(panels[id]));
          panels[id] ||= { id, prerequisiteRoleIds: [], roleId: null, approvalChannelId: null, channelId: null,
            enabled: true, messages: [] };
          Object.assign(panels[id], { name, description, rejectionReasonDefault, mentionManagers: mentionChoice === 'yes', votesRequired: Number(votesInput) });
          try { await save(); } catch (error) { if (previous) panels[id] = previous; else delete panels[id]; throw error; }
          session.panelId = id;
          await interaction.editReply(editor(session)); scheduleRefresh(interaction.guild); return true;
        }
        await interaction.deferUpdate();
        if (action === 'midappcfg-select') session.panelId = interaction.values[0];
        else if (action === 'midappcfg-back') { await interaction.editReply(overview(session)); return true; }
        else {
          const config = configFor(session);
          configurationLock = `cfg:${interaction.guildId}:${config.id}`;
          if (locks.has(configurationLock)) { configurationLock = null; throw new Error('这套配置正在处理，请稍后重试。'); }
          locks.add(configurationLock);
          const previous = JSON.parse(JSON.stringify(config));
          let posted;
          if (action === 'midappcfg-prerequisite') {
            const ids = [...new Set(interaction.values)];
            if (ids.includes(interaction.guildId) || ids.some((id) => awardRoleIds(config).includes(id))) throw new Error('前置身份组不能是 @everyone 或待发放身份组。');
            config.prerequisiteRoleIds = ids;
          } else if (action === 'midappcfg-role') {
            const ids = [...new Set(interaction.values)];
            if (!ids.length || ids.length > 10) throw new Error('请选择 1–10 个发放身份组。');
            if (ids.some((id) => config.prerequisiteRoleIds.includes(id))) throw new Error('发放身份组不能同时作为前置身份组。');
            for (const id of ids) await grantableRole(interaction.guild, id);
            config.roleIds = ids;
            config.roleId = ids[0];
          } else if (action === 'midappcfg-approval' || action === 'midappcfg-channel') {
            const channel = await channelFor(interaction.guild, interaction.values[0]);
            config[action === 'midappcfg-approval' ? 'approvalChannelId' : 'channelId'] = channel.id;
          } else if (action === 'midappcfg-toggle') config.enabled = !config.enabled;
          else if (action === 'midappcfg-delete') {
            if (pendingCount(interaction.guildId, config.id)) throw new Error('还有待处理申请，请先审批或拒绝，再删除配置。');
            await interaction.editReply({ content: `确定删除“${config.name}”的配置？已有公开面板将停用，历史审批记录保留。`, embeds: [],
              components: [row(button(`midappcfg-delete-confirm:${reference}`, '确定删除配置', ButtonStyle.Danger),
                button(`midappcfg-select-back:${reference}`, '取消'))] }); return true;
          } else if (action === 'midappcfg-delete-confirm') {
            if (pendingCount(interaction.guildId, config.id)) throw new Error('还有待处理申请，不能删除。');
            config.enabled = false;
            await refreshPublic(interaction.guild);
            delete state(interaction.guildId).panels[config.id];
            try { await save(); } catch (error) { state(interaction.guildId).panels[config.id] = previous; throw error; }
            session.panelId = null; await interaction.editReply(overview(session)); return true;
          } else if (action === 'midappcfg-publish') {
            if (!config.prerequisiteRoleIds.length || !awardRoleIds(config).length || !config.approvalChannelId || !config.channelId
              || !managerRoleId(interaction.guildId)) throw new Error('请设置前置身份组、发放身份组、审批频道、公开频道和主管理身份组。');
            for (const id of config.prerequisiteRoleIds) if (!(await interaction.guild.roles.fetch(id))) throw new Error('前置身份组已不存在。');
            for (const id of awardRoleIds(config)) await grantableRole(interaction.guild, id);
            await channelFor(interaction.guild, config.approvalChannelId);
            const channel = await channelFor(interaction.guild, config.channelId);
            const existing = config.messages.find((ref) => ref.channelId === channel.id);
            const message = existing && await channel.messages.fetch(existing.messageId).catch(() => null);
            if (message) await message.edit(publicPayload(interaction.guildId, config));
            else {
              posted = await channel.send(publicPayload(interaction.guildId, config));
              if (existing) existing.messageId = posted.id;
              else config.messages.push({ channelId: channel.id, messageId: posted.id });
            }
          } else if (action !== 'midappcfg-select-back') throw new Error('未知配置操作。');
          try { await save(); } catch (error) {
            state(interaction.guildId).panels[config.id] = previous;
            if (posted) await posted.edit({ content: '申请面板发布未完成，请管理员重新发布。', embeds: [], components: [] }).catch(() => {});
            scheduleRefresh(interaction.guild);
            throw error;
          }
          scheduleRefresh(interaction.guild);
        }
        await interaction.editReply(editor(session)); return true;
      }
      const { panels, applications } = state(interaction.guildId);
      if (['midapp-success-view', 'midapp-success-status'].includes(action)) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
        const app = applications.find((item) => item.id === reference);
        if (!app || app.userId !== interaction.user.id || app.status !== 'completed') throw new Error('只能查看自己的已通过申请。');
        if (action === 'midapp-success-status') await interaction.editReply(applicantPayload(app));
        else {
          const reply = app.successReplies?.[interaction.values[0]];
          if (!reply) throw new Error('该身份组没有可查看的通过回信。');
          await interaction.editReply({ ...successPayload(app, reply), components: [...successViewComponents(app),
            row(button(`midapp-success-status:${app.id}`, '返回申请进度'))] });
        }
        return true;
      }
      if (['midapp-success-retry', 'midapp-success-confirm'].includes(action) && interaction.isButton()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
        for (const [token, confirmation] of retryConfirmations) if (confirmation.expiresAt < Date.now()) retryConfirmations.delete(token);
        const confirmation = action === 'midapp-success-confirm' && retryConfirmations.get(reference);
        if (action === 'midapp-success-confirm' && (!confirmation || confirmation.guildId !== interaction.guildId
          || confirmation.userId !== interaction.user.id || confirmation.channelId !== interaction.channelId)) throw new Error('确认已过期，请从原审批卡重新操作。');
        const app = applications.find((item) => item.id === (confirmation ? confirmation.appId : reference));
        if (!app || app.status !== 'completed' || !successReplies(app).length) throw new Error('没有可重发的通过回信。');
        if (app.approvalChannelId !== interaction.channelId
          || (!confirmation && app.approvalMessageId !== interaction.message.id)
          || (confirmation && app.approvalMessageId !== confirmation.messageId)) throw new Error('请从原审批卡操作。');
        if (app.userId === interaction.user.id || !(await manager(interaction.guild, interaction.user.id))) throw new Error('只有其他主管理组成员或服务器管理员可以重发回信。');
        const key = memberLockKey(interaction.guildId, app.userId);
        if (locks.has(key)) throw new Error('申请正在处理，请稍后重试。');
        locks.add(key);
        try {
          if (!confirmation && successReplies(app).some((reply) => reply.status === 'unknown')) {
            const token = randomBytes(8).toString('hex');
            retryConfirmations.set(token, { guildId: interaction.guildId, channelId: interaction.channelId,
              userId: interaction.user.id, appId: app.id, messageId: app.approvalMessageId, expiresAt: Date.now() + 60 * 1000 });
            await interaction.editReply({ content: '部分回信发送结果不确定，申请人可能已经收到。确认重发可能产生重复私信；已记录成功的回信仍会跳过。是否确认重发？（1 分钟内有效）',
              components: [row(button(`midapp-success-confirm:${token}`, '确认重发未送达回信', ButtonStyle.Danger))], allowedMentions: { parse: [] } });
            return true;
          }
          if (confirmation) retryConfirmations.delete(reference);
          await notifySuccess(interaction.guild, app, { retry: true, allowUnknown: Boolean(confirmation) });
          await updateApproval(interaction.guild, app).catch((error) => logFailure('通过回信审批卡更新失败。', error));
          await interaction.editReply({ content: `通过回信送达情况：\n${successSummary(app)}\n已成功发送的回信不会重复发送；申请人可在“我的申请”读取内容。`, allowedMentions: { parse: [] } });
        } finally { locks.delete(key); }
        return true;
      }
      if (action === 'midapp-reject' && interaction.isButton()) {
        const app = applications.find((item) => item.id === reference);
        if (!app || !['pending', 'grant_failed'].includes(app.status)) throw new Error('申请已处理或正在发放，请勿重复操作。');
        if (app.approvalChannelId !== interaction.channelId || app.approvalMessageId !== interaction.message.id) throw new Error('请在原审批卡操作。');
        if (app.userId === interaction.user.id) throw new Error('不能审批自己的申请。');
        if (!configurationManager(interaction) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new Error('只有主管理组成员或服务器管理员可以审批。');
        const defaultReason = panels[app.panelId]?.rejectionReasonDefault || DEFAULT_REJECTION_REASON;
        await interaction.showModal(new ModalBuilder().setCustomId(`midapp-rejectreason:${app.id}:${app.approvalMessageId}`)
          .setTitle('填写拒绝理由并私信通知申请人').addComponents(new LabelBuilder().setLabel('拒绝理由（不显示处理人，请勿填写姓名）')
            .setTextInputComponent(new TextInputBuilder().setCustomId('rejectionReason').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(400).setValue(defaultReason))));
        return true;
      }
      if (action === 'midapp-notify' && interaction.isButton()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
        const app = applications.find((item) => item.id === reference);
        if (!app || app.status !== 'rejected' || !app.rejectionReason) throw new Error('没有可发送的拒绝通知。');
        if (app.approvalChannelId !== interaction.channelId || app.approvalMessageId !== interaction.message.id) throw new Error('请在原审批卡操作。');
        if (app.userId === interaction.user.id || !(await manager(interaction.guild, interaction.user.id))) throw new Error('只有其他主管理组成员或服务器管理员可以重发通知。');
        const key = memberLockKey(interaction.guildId, app.userId);
        if (locks.has(key)) throw new Error('申请正在处理，请稍后重试。');
        locks.add(key);
        try {
          if (app.rejectionNotification?.status === 'sent') throw new Error('通知已发送，请勿重复发送。');
          const sent = await notifyRejection(interaction.guild, app);
          await updateApproval(interaction.guild, app).catch((error) => logFailure('拒绝通知审批卡更新失败。', error));
          await interaction.editReply(sent ? '已私信告知拒绝理由，不显示处理人。' : '私信仍未发送成功，请让申请人开启私信；他可在“我的申请”查看理由。');
        } finally { locks.delete(key); }
        return true;
      }
      if (action === 'midapp-approve' || (action === 'midapp-rejectreason' && interaction.isModalSubmit())) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        privateReply = true;
        const app = applications.find((item) => item.id === reference);
        if (!app) throw new Error('申请记录已不存在。');
        const reject = action === 'midapp-rejectreason';
        await review(interaction, app, reject, reject ? interaction.fields.getTextInputValue('rejectionReason') : null,
          reject ? anchor : interaction.message?.id); return true;
      }
      const config = panels[reference];
      if (!config) throw new Error('申请面板已停用或配置已删除。');
      const messageId = interaction.isModalSubmit() ? anchor : interaction.message?.id;
      if (!config.messages.some((ref) => ref.channelId === interaction.channelId && ref.messageId === messageId)) throw new Error('请从当前有效的公开申请面板操作。');
      if (action === 'midapp-apply' && interaction.isButton()) {
        if (!config.enabled || !prerequisitesMet(interaction.member, config.prerequisiteRoleIds)) throw new Error('申请暂停，或你未持有全部前置身份组。');
        await interaction.showModal(new ModalBuilder().setCustomId(`midapp-submit:${config.id}:${messageId}`)
          .setTitle('填写中层申请理由').addComponents(new LabelBuilder().setLabel('申请理由')
            .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(1000)))); return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      privateReply = true;
      if (action === 'midapp-submit' && interaction.isModalSubmit()) await submit(interaction, config);
      else if (action === 'midapp-refresh' && interaction.isButton()) {
        if (!configurationManager(interaction)) throw new Error('只有主管理组成员可以手动刷新人数。');
        if(Date.now()-(manualAt.get(interaction.guildId)||0)<60000)throw Error('本服刚刚刷新过，请至少等待60秒再刷新。');
        manualAt.set(interaction.guildId,Date.now());
        await refreshCounts(interaction.guild, true).catch((error) => logFailure('手动读取中层申请人数失败。', error));
        await refreshPublic(interaction.guild,true);
        const current = counts.get(interaction.guildId);
        const ids = awardRoleIds(config);
        const error = current?.error || ids.map((id) => current?.roleErrors.get(id)).find(Boolean);
        if (error) throw new Error(error);
        await interaction.editReply({ content: `人数已刷新（含 Bot）：\n${ids.map((id) => `<@&${id}>：${current?.values.get(id) ?? '未读取'} 人`).join('\n')}`, allowedMentions: { parse: [] } });
      }
      else if (action === 'midapp-status' && interaction.isButton()) {
        const app = applications.filter((item) => item.panelId === config.id && item.userId === interaction.user.id).at(-1);
        if (!app) await interaction.editReply('你还没有向此面板提交申请。');
        else await interaction.editReply(applicantPayload(app));
      } else throw new Error('未知申请操作。');
    } catch (error) {
      logFailure('中层申请面板操作失败。', error);
      const content = `操作未完成：${error.message}`;
      if (privateReply) await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    } finally {
      if (configurationLock) locks.delete(configurationLock);
    }
    return true;
  }
  async function recover(guild, refreshCards = false) {
    for (const app of state(guild.id).applications) {
      const key = memberLockKey(guild.id, app.userId);
      if (locks.has(key)) continue;
      locks.add(key);
      try {
        let changed = false;
        if (app.status === 'executing') {
          const previous = JSON.parse(JSON.stringify(app));
          const member = await guild.members.fetch({ user: app.userId, force: true }).catch(() => null);
          const ids = awardRoleIds(app);
          app.status = ids.length && ids.every((id) => hasRole(member, id)) ? 'completed' : 'grant_failed';
          if (app.status === 'grant_failed') app.failure = '部署重启后未确认身份组已发放；请管理组重试。';
          else { delete app.failure; freezeSuccessReplies(guild, app); }
          try { await save(); } catch (error) {
            Object.keys(app).forEach((field) => delete app[field]); Object.assign(app, previous); throw error;
          }
          changed = true;
          if (app.status === 'completed' && member) await afterGrant(member, ids).catch((error) => logFailure('恢复中层申请配套身份失败。', error));
        }
        if (app.status === 'pending' && !app.approvalMessageId) {
          app.status = 'delivery_failed'; app.failure = '申请提交期间重启，申请卡未完整保存；请重新提交。'; await save();
          changed = true;
        }
        if (app.status === 'rejected' && app.rejectionReason) {
          if (app.rejectionNotification?.status === 'sending') {
            app.rejectionNotification.status = 'unknown';
            await save(); changed = true;
          } else if (app.rejectionNotification?.status === 'pending') {
            await notifyRejection(guild, app); changed = true;
          }
        }
        if (app.status === 'completed' && app.successReplyVersion === 1 && successReplies(app).length) {
          const interrupted = successReplies(app).filter((reply) => reply.status === 'sending');
          if (interrupted.length) {
            for (const reply of interrupted) reply.status = 'unknown';
            try { await save(); } catch (error) {
              for (const reply of interrupted) reply.status = 'sending';
              throw error;
            }
            changed = true;
          }
          if (successReplies(app).some((reply) => reply.status === 'pending')) {
            await notifySuccess(guild, app); changed = true;
          }
        }
        if ((changed || (refreshCards && (['pending', 'grant_failed', 'rejected'].includes(app.status)
          || (app.status === 'completed' && successReplies(app).length))))
          && app.approvalMessageId) await updateApproval(guild, app).catch((error) => logFailure('恢复中层申请审批卡失败。', error));
      } catch (error) { logFailure(`中层申请 ${app.id} 恢复失败。`, error); }
      finally { locks.delete(key); }
    }
  }
  function start() {
    let running = false;
    const reconcile = async (refreshCards = false) => {
      if (running) return;
      running = true;
      try {
        for (const guild of client.guilds.cache.values()) {
          const { panels, applications } = state(guild.id);
          if (!refreshCards && !Object.keys(panels).length && !applications.some((app) =>
            app.status === 'executing'
            || (app.status === 'rejected' && ['pending', 'sending'].includes(app.rejectionNotification?.status))
            || (app.status === 'completed' && successReplies(app).some((reply) => ['pending', 'sending'].includes(reply.status))))) continue;
          try { await recover(guild, refreshCards); await refreshPublic(guild); }
          catch (error) { logFailure('中层申请启动/定期同步失败。', error); }
        }
      } finally { running = false; }
    };
    void reconcile(true);
    setInterval(() => void reconcile(), 15 * 60 * 1000).unref();
  }
  return { handle, onMember, onRaw, start };
}

module.exports = { createMiddleApplications, configurationCommand, prerequisitesMet };
