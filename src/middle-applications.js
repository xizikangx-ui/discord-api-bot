const { randomBytes } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const configurationCommand = new SlashCommandBuilder().setName('中层申请配置面板')
  .setDescription('添加和配置多套中层申请面板及管理组审批流程')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const activeStatuses = new Set(['pending', 'executing', 'grant_failed']);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder()
  .setCustomId(id).setLabel(label).setStyle(style);
const hasRole = (member, roleId) => member?.roles?.cache?.has(roleId)
  || (Array.isArray(member?.roles) && member.roles.includes(roleId)) || false;
const prerequisitesMet = (member, roleIds) => roleIds.length > 0 && roleIds.every((id) => hasRole(member, id));

function createMiddleApplications(deps) {
  const { client, settingsFor, save, managerRoleId, forEachMemberPage, logFailure, afterGrant } = deps;
  const sessions = new Map();
  const locks = new Set();
  const counts = new Map();
  const refreshTimers = new Map();
  const refreshing = new Map();
  const refreshAgain = new Set();

  function state(guildId) {
    const setting = settingsFor(guildId);
    setting.middleApplicationPanels ||= {};
    setting.middleApplications ||= [];
    return { panels: setting.middleApplicationPanels, applications: setting.middleApplications };
  }
  function sessionFor(interaction, token) {
    const session = sessions.get(token);
    if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id
      || session.expiresAt < Date.now()) throw new Error('配置面板已过期，请重新运行 /中层申请配置面板。');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('需要“管理服务器”权限。');
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
      .setDescription(`${config.description || '未填写说明'}\n\n前置身份组（全部必需）：${config.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、') || '未设置'}\n通过后发放：${config.roleId ? `<@&${config.roleId}>` : '未设置'}\n审批频道：${config.approvalChannelId ? `<#${config.approvalChannelId}>` : '未设置'}\n公开申请频道：${config.channelId ? `<#${config.channelId}>` : '未设置'}\n审批：${config.votesRequired} 名不同主管理同意；任一主管理拒绝即结束\n状态：${config.enabled ? '开放申请' : '暂停申请'}\n已发布面板：${config.messages.length} 个\n\n审批身份组由 /管理组面板 的主管理身份组决定。通过后会同步已有中层身份组的配套身份。`);
    return { content: null, embeds: [embed], allowedMentions: { parse: [] }, components: [
      row(new RoleSelectMenuBuilder().setCustomId(`midappcfg-prerequisite:${session.token}`)
        .setPlaceholder('选择前置身份组（最多 10 个，必须全部持有）').setMinValues(1).setMaxValues(10)),
      row(new RoleSelectMenuBuilder().setCustomId(`midappcfg-role:${session.token}`).setPlaceholder('选择审批通过后发放的身份组')),
      row(new ChannelSelectMenuBuilder().setCustomId(`midappcfg-approval:${session.token}`)
        .setPlaceholder('选择管理组审批频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(new ChannelSelectMenuBuilder().setCustomId(`midappcfg-channel:${session.token}`)
        .setPlaceholder('选择公开申请频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(button(`midappcfg-edit:${session.token}`, '名称/说明/票数'),
        button(`midappcfg-publish:${session.token}`, '发布申请面板', ButtonStyle.Primary),
        button(`midappcfg-toggle:${session.token}`, config.enabled ? '暂停申请' : '开放申请'),
        button(`midappcfg-delete:${session.token}`, '删除配置', ButtonStyle.Danger),
        button(`midappcfg-back:${session.token}`, '其他面板')),
    ] };
  }
  function form(token, config) {
    const field = (id, label, style, max, value) => new LabelBuilder().setLabel(label)
      .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max)
        .setRequired(true).setValue(value));
    return new ModalBuilder().setCustomId(`midappcfg-form:${token}:${config?.id || 'new'}`).setTitle(config ? '编辑中层申请面板' : '新增中层申请面板')
      .addComponents(field('name', '面板名称', TextInputStyle.Short, 80, config?.name || '中层申请'),
        field('description', '面板说明', TextInputStyle.Paragraph, 800, config?.description || '请填写申请理由，提交后由管理组审批。'),
        field('votes', '需要多少名不同管理组成员同意（1–10）', TextInputStyle.Short, 2, String(config?.votesRequired || 1)));
  }
  function publicPayload(guildId, config) {
    const count = counts.get(guildId)?.sets.get(config.roleId)?.size;
    return { embeds: [new EmbedBuilder().setColor(config.enabled ? 0x5865F2 : 0x95A5A6).setTitle(config.name)
      .setDescription(`${config.description}\n\n前置身份组：${config.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、')}（须全部持有）\n通过后身份组：<@&${config.roleId}>\n当前人数：${count === undefined ? '正在读取' : `${count} 人`}\n待审批：${pendingCount(guildId, config.id)} 人\n审批门槛：${config.votesRequired} 名管理组成员同意\n${config.enabled ? '点击下方按钮填写申请理由。' : '当前暂停新申请。'}`)
      .setFooter({ text: `申请面板 ${config.id} · 人数随身份组变更更新` })],
    components: [row(button(`midapp-apply:${config.id}`, '填写申请理由', ButtonStyle.Primary).setDisabled(!config.enabled),
      button(`midapp-status:${config.id}`, '我的申请'))], allowedMentions: { parse: [] } };
  }
  function approvalPayload(app) {
    const labels = { pending: '待管理组审批', executing: '正在发放身份组', completed: '已通过并发放',
      rejected: '已拒绝', grant_failed: '审批通过，身份组发放未完成', delivery_failed: '申请卡发送未完成' };
    return { embeds: [new EmbedBuilder().setColor(app.status === 'completed' ? 0x2ECC71 : app.status === 'rejected' ? 0xE74C3C : 0x5865F2)
      .setTitle(`中层申请：${app.panelName}`).setDescription(`申请人：<@${app.userId}> (${app.userId})\n申请身份组：<@&${app.roleId}>\n前置身份组：${app.prerequisiteRoleIds.map((id) => `<@&${id}>`).join('、')}\n\n申请理由：\n${app.reason}\n\n状态：${labels[app.status] || app.status}\n同意票：${app.approverIds.length}/${app.votesRequired}\n已同意：${app.approverIds.map((id) => `<@${id}>`).join('、') || '无'}${app.decidedBy ? `\n处理人：<@${app.decidedBy}>` : ''}${app.failure ? `\n失败说明：${app.failure.slice(0, 500)}` : ''}`)
      .setFooter({ text: `申请 ${app.id} · 申请人不能审批自己的申请` }).setTimestamp(app.createdAt)],
    components: ['pending', 'grant_failed'].includes(app.status) ? [row(
      button(`midapp-approve:${app.id}`, app.status === 'grant_failed' ? '重试发放身份组' : '同意', ButtonStyle.Success),
      button(`midapp-reject:${app.id}`, '拒绝', ButtonStyle.Danger))] : [], allowedMentions: { parse: [] } };
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
    const roleIds = new Set(Object.values(state(guild.id).panels).map((config) => config.roleId).filter(Boolean));
    if (current?.loading) { await current.loading; return refreshCounts(guild, force); }
    if (!force && current && [...roleIds].every((id) => current.sets.has(id))) return;
    current ||= { sets: new Map(), events: new Map() };
    counts.set(guild.id, current);
    const sets = new Map([...roleIds].map((id) => [id, new Set()]));
    current.events.clear();
    current.loading = (async () => {
      await forEachMemberPage(guild, async (page) => {
        for (const data of page) {
          if (data.user?.bot || !data.user?.id) continue;
          for (const id of roleIds) if (data.roles?.includes(id)) sets.get(id).add(data.user.id);
        }
      });
      for (const [userId, ids] of current.events) {
        for (const [roleId, users] of sets) {
          if (ids.has(roleId)) users.add(userId); else users.delete(userId);
        }
      }
      current.sets = sets;
    })();
    try { await current.loading; } finally { current.loading = null; current.events.clear(); }
  }
  async function refreshPublic(guild) {
    if (refreshing.has(guild.id)) { refreshAgain.add(guild.id); return refreshing.get(guild.id); }
    const work = (async () => {
      await refreshCounts(guild);
      for (const config of Object.values(state(guild.id).panels)) {
        for (const ref of config.messages) {
          try {
            const channel = await guild.channels.fetch(ref.channelId);
            const message = await channel.messages.fetch(ref.messageId);
            await message.edit(publicPayload(guild.id, config));
          } catch (error) { logFailure('中层申请公开面板更新失败。', error); }
        }
      }
    })();
    refreshing.set(guild.id, work);
    try { await work; } finally {
      refreshing.delete(guild.id);
      if (refreshAgain.delete(guild.id)) scheduleRefresh(guild);
    }
  }
  function scheduleRefresh(guild) {
    if (!Object.keys(state(guild.id).panels).length) return;
    if (refreshTimers.has(guild.id)) clearTimeout(refreshTimers.get(guild.id));
    refreshTimers.set(guild.id, setTimeout(() => {
      refreshTimers.delete(guild.id);
      refreshPublic(guild).catch((error) => logFailure('中层申请人数更新失败。', error));
    }, 1000));
  }
  function onMember(member, removed = false) {
    if (member.user.bot) return;
    const current = counts.get(member.guild.id);
    const ids = removed ? new Set() : new Set(member.roles.cache.keys());
    if (current?.loading) current.events.set(member.id, ids);
    let changed = !current;
    if (current) for (const [roleId, users] of current.sets) {
      if (users.has(member.id) !== ids.has(roleId)) changed = true;
      if (ids.has(roleId)) users.add(member.id); else users.delete(member.id);
    }
    if (changed) scheduleRefresh(member.guild);
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
    const key = `${interaction.guildId}:${interaction.user.id}:${config.roleId}`;
    if (locks.has(key)) throw new Error('你的申请正在处理，请稍后查看“我的申请”。');
    locks.add(key);
    try {
      if (!config.enabled) throw new Error('这套面板已暂停申请。');
      if (applications.some((app) => app.userId === interaction.user.id && app.roleId === config.roleId
        && activeStatuses.has(app.status))) throw new Error('同一身份组已有待处理申请，请勿重复提交。');
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      if (member.user.bot || !prerequisitesMet(member, config.prerequisiteRoleIds)) throw new Error('你必须持有本面板要求的全部前置身份组。');
      if (hasRole(member, config.roleId)) throw new Error('你已持有目标身份组，无需申请。');
      await grantableRole(interaction.guild, config.roleId);
      const channel = await channelFor(interaction.guild, config.approvalChannelId);
      const roleId = managerRoleId(interaction.guildId);
      if (!roleId) throw new Error('请先配置 /管理组面板 的主管理身份组。');
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!reason) throw new Error('请填写申请理由。');
      const app = { id: randomBytes(8).toString('hex'), panelId: config.id, panelName: config.name,
        userId: member.id, roleId: config.roleId, prerequisiteRoleIds: [...config.prerequisiteRoleIds],
        reason, votesRequired: config.votesRequired, approverIds: [], status: 'pending',
        createdAt: Date.now(), approvalChannelId: channel.id, approvalMessageId: null };
      applications.push(app);
      try { await save(); } catch (error) { applications.splice(applications.indexOf(app), 1); throw error; }
      try {
        const message = await channel.send({ ...approvalPayload(app), content: `<@&${roleId}> 有新的中层申请待审批。`,
          allowedMentions: { parse: [], roles: [roleId] } });
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
  async function review(interaction, app, reject) {
    const key = `${interaction.guildId}:${app.userId}:${app.roleId}`;
    if (locks.has(key)) throw new Error('这项申请正在处理另一项操作，请稍后重试。');
    locks.add(key);
    try {
      if (!['pending', 'grant_failed'].includes(app.status)) throw new Error('这项申请已处理或正在发放，请勿重复审批。');
      if (app.approvalChannelId !== interaction.channelId || app.approvalMessageId !== interaction.message.id) throw new Error('请在原审批卡上操作。');
      if (app.userId === interaction.user.id) throw new Error('不能审批自己的申请。');
      if (!(await manager(interaction.guild, interaction.user.id))) throw new Error('只有主管理组成员或服务器管理员可以审批。');
      const previous = JSON.parse(JSON.stringify(app));
      if (reject) {
        app.status = 'rejected'; app.decidedBy = interaction.user.id; app.decidedAt = Date.now();
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
        } else app.status = 'pending';
      }
      try { await save(); } catch (error) { Object.keys(app).forEach((key) => delete app[key]); Object.assign(app, previous); throw error; }
      await updateApproval(interaction.guild, app).catch((error) => logFailure('中层申请审批卡更新失败。', error));
      if (app.status === 'executing') {
        try {
          await grantableRole(interaction.guild, app.roleId);
          let member = await interaction.guild.members.fetch({ user: app.userId, force: true });
          if (!prerequisitesMet(member, app.prerequisiteRoleIds)) throw new Error('申请人已不再持有全部前置身份组，未发放。');
          if (!hasRole(member, app.roleId)) member = await member.roles.add(app.roleId, `中层申请 ${app.id} 由 ${interaction.user.id} 审批通过`);
          app.status = 'completed';
          await save();
          await afterGrant(member, app.roleId).catch((error) => logFailure('中层申请配套身份同步失败。', error));
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
      await updateApproval(interaction.guild, app).catch((error) => logFailure('中层申请结果卡更新失败。', error));
      scheduleRefresh(interaction.guild);
      await interaction.editReply(app.status === 'completed' ? '审批通过，已自动发放身份组。'
        : app.status === 'rejected' ? '已拒绝申请。'
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
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('需要“管理服务器”权限。');
        for (const [token, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(token);
        const token = randomBytes(8).toString('hex');
        const session = { token, guildId: interaction.guildId, userId: interaction.user.id, expiresAt: Date.now() + 30 * 60 * 1000 };
        sessions.set(token, session);
        await interaction.editReply(overview(session)); return true;
      }
      const [action, reference, anchor] = customId.split(':');
      if (action.startsWith('midappcfg-')) {
        const session = sessionFor(interaction, reference);
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
          if (!name || !description || !/^(?:[1-9]|10)$/.test(votesInput)) throw new Error('请填写名称、说明和 1–10 的审批人数。');
          const panels = state(interaction.guildId).panels;
          if (editingId && !panels[editingId]) throw new Error('这套配置已被删除。');
          if (!editingId && Object.keys(panels).length >= 25) throw new Error('最多配置 25 套申请面板。');
          const id = editingId || randomBytes(6).toString('hex');
          const previous = panels[id] && JSON.parse(JSON.stringify(panels[id]));
          panels[id] ||= { id, prerequisiteRoleIds: [], roleId: null, approvalChannelId: null, channelId: null,
            enabled: true, messages: [] };
          Object.assign(panels[id], { name, description, votesRequired: Number(votesInput) });
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
            if (ids.includes(interaction.guildId) || ids.includes(config.roleId)) throw new Error('前置身份组不能是 @everyone 或待发放身份组。');
            config.prerequisiteRoleIds = ids;
          } else if (action === 'midappcfg-role') {
            const role = await grantableRole(interaction.guild, interaction.values[0]);
            const caller = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
            if (!caller.permissions.has(PermissionFlagsBits.Administrator)
              && (!caller.permissions.has(PermissionFlagsBits.ManageRoles) || role.comparePositionTo(caller.roles.highest) >= 0)) {
              throw new Error('配置发放身份组需要“管理身份组”权限，且该组层级须低于你。');
            }
            if (config.prerequisiteRoleIds.includes(role.id)) throw new Error('发放身份组不能同时作为前置身份组。');
            config.roleId = role.id;
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
            if (!config.prerequisiteRoleIds.length || !config.roleId || !config.approvalChannelId || !config.channelId
              || !managerRoleId(interaction.guildId)) throw new Error('请设置前置身份组、发放身份组、审批频道、公开频道和主管理身份组。');
            for (const id of config.prerequisiteRoleIds) if (!(await interaction.guild.roles.fetch(id))) throw new Error('前置身份组已不存在。');
            await grantableRole(interaction.guild, config.roleId);
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
      if (action === 'midapp-approve' || action === 'midapp-reject') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        privateReply = true;
        const app = applications.find((item) => item.id === reference);
        if (!app) throw new Error('申请记录已不存在。');
        await review(interaction, app, action === 'midapp-reject'); return true;
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
      else if (action === 'midapp-status' && interaction.isButton()) {
        const app = applications.filter((item) => item.panelId === config.id && item.userId === interaction.user.id).at(-1);
        if (!app) await interaction.editReply('你还没有向此面板提交申请。');
        else { const payload = approvalPayload(app); payload.components = []; await interaction.editReply(payload); }
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
  async function recover(guild) {
    for (const app of state(guild.id).applications) {
      if (locks.has(`${guild.id}:${app.userId}:${app.roleId}`)) continue;
      let changed = false;
      if (app.status === 'executing') {
        const member = await guild.members.fetch({ user: app.userId, force: true }).catch(() => null);
        app.status = hasRole(member, app.roleId) ? 'completed' : 'grant_failed';
        if (app.status === 'grant_failed') app.failure = '部署重启后未确认身份组已发放；请管理组重试。';
        else delete app.failure;
        await save();
        changed = true;
        if (app.status === 'completed' && member) await afterGrant(member, app.roleId).catch((error) => logFailure('恢复中层申请配套身份失败。', error));
      }
      if (app.status === 'pending' && !app.approvalMessageId) {
        app.status = 'delivery_failed'; app.failure = '申请提交期间重启，申请卡未完整保存；请重新提交。'; await save();
        changed = true;
      }
      if (changed && app.approvalMessageId) await updateApproval(guild, app).catch((error) => logFailure('恢复中层申请审批卡失败。', error));
    }
  }
  function start() {
    let running = false;
    const reconcile = async () => {
      if (running) return;
      running = true;
      try {
        for (const guild of client.guilds.cache.values()) {
          if (!Object.keys(state(guild.id).panels).length) continue;
          try { await recover(guild); await refreshCounts(guild, true); await refreshPublic(guild); }
          catch (error) { logFailure('中层申请启动/定期同步失败。', error); }
        }
      } finally { running = false; }
    };
    void reconcile();
    setInterval(() => void reconcile(), 10 * 60 * 1000).unref();
  }
  return { handle, onMember, start };
}

module.exports = { createMiddleApplications, configurationCommand, prerequisitesMet };
