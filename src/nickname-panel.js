const { randomBytes } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const nicknameCommand = new SlashCommandBuilder().setName('违规改名面板')
  .setDescription('配置违规成员昵称锁定，或将指定成员昵称改成数字用户 ID');
const row = (component) => new ActionRowBuilder().addComponents(component);
const hasRole = (member, id) => Boolean(id && member.roles.cache.has(id));

function createNicknamePanel({ client, settingsFor, save, logFailure }) {
  const sessions = new Map();
  const pending = new Map();
  const actions = new Set();
  const enforcing = new Map();
  const dirty = new Set();
  const configActions = new Set();
  const memberTimers = new Map();

  function policy(guildId) {
    const setting = settingsFor(guildId);
    setting.nicknamePolicy ||= { enabled: false, operatorRoleIds: [], violationRoleId: null, locks: {} };
    return setting.nicknamePolicy;
  }
  function operator(member, config) {
    return config.operatorRoleIds.some((id) => hasRole(member, id));
  }
  async function access(interaction, configure = false) {
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (configure ? !member.permissions.has(PermissionFlagsBits.ManageGuild) : !operator(member, policy(interaction.guildId))) {
      throw new Error(configure ? '配置需要“管理服务器”权限。' : '你必须持有面板指定的操作身份组；ADMIN 也需持有该组。');
    }
    return member;
  }
  function sessionFor(interaction, token) {
    const session = sessions.get(token);
    if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id
      || session.expiresAt < Date.now()) throw new Error('面板已过期，请重新运行 /违规改名面板。');
    return session;
  }
  function payload(guildId, session, configure) {
    const config = policy(guildId);
    const roleText = config.operatorRoleIds.map((id) => `<@&${id}>`).join('、') || '未设置';
    const embed = new EmbedBuilder().setTitle('违规成员改名与昵称锁定').setColor(0xE67E22)
      .setDescription(`状态：${config.enabled ? '已启用' : '已暂停（不执行改名或自动改回）'}\n操作身份组（持有任意一个）：${roleText}\n目标必需违规身份组：${config.violationRoleId ? `<@&${config.violationRoleId}>` : '未设置'}\n当前锁定记录：${Object.keys(config.locks).length} 人\n\n只能修改服务器昵称，不能修改用户 ID 或账号名。操作员选中目标并填写理由后，昵称改为该成员的数字用户 ID；再次修改昵称会自动改回。移除违规身份组或解除锁定后停止改回，原昵称不会自动恢复。Bot 的身份组必须高于目标，并具有“管理昵称”权限。`);
    const components = [];
    if (configure) {
      const roles = new RoleSelectMenuBuilder().setCustomId(`nickcfg-operators:${session.token}`)
        .setPlaceholder('设置操作身份组（最多 10 个，可清空）').setMinValues(0).setMaxValues(10);
      const guildRoles = client.guilds.cache.get(guildId)?.roles.cache;
      const defaults = config.operatorRoleIds.filter((id) => guildRoles?.has(id));
      if (defaults.length) roles.setDefaultRoles(...defaults);
      const violation = new RoleSelectMenuBuilder().setCustomId(`nickcfg-target:${session.token}`)
        .setPlaceholder('设置目标必需的违规身份组（更换将解除已有锁定）');
      if (guildRoles?.has(config.violationRoleId)) violation.setDefaultRoles(config.violationRoleId);
      components.push(row(roles), row(violation), row(new ButtonBuilder().setCustomId(`nickcfg-toggle:${session.token}`)
        .setLabel(config.enabled ? '暂停改名与自动改回' : '启用改名与自动改回').setStyle(ButtonStyle.Secondary)));
    }
    components.push(row(new UserSelectMenuBuilder().setCustomId(`nick-target:${session.token}`)
      .setPlaceholder('选择违规成员：填写理由后改成数字 ID 并锁定').setDisabled(!config.enabled)),
    row(new UserSelectMenuBuilder().setCustomId(`nick-release:${session.token}`).setPlaceholder('选择成员：解除昵称锁定')));
    return { content: null, embeds: [embed], components, allowedMentions: { parse: [] } };
  }
  async function editable(member) {
    const me = await member.guild.members.fetchMe();
    if (member.user.bot || member.id === member.guild.ownerId || !member.manageable
      || !me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      throw new Error('Bot 无法修改该成员昵称：请检查“管理昵称”权限和身份组层级；不能操作服务器所有者或 Bot。');
    }
  }
  function queue(guild, userId) {
    const key = `${guild.id}:${userId}`;
    if (actions.has(key) || enforcing.has(key)) { dirty.add(key); return; }
    const work = (async () => {
      do {
        dirty.delete(key);
        const config = policy(guild.id);
        const record = config.locks[userId];
        if (!record) return;
        const member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
          if (Number(error.code) === 10007) return null;
          throw error;
        });
        if (policy(guild.id) !== config || config.locks[userId] !== record) { dirty.add(key); continue; }
        if (!member || !hasRole(member, record.violationRoleId)) {
          delete config.locks[userId];
          try { await save(); } catch (error) { config.locks[userId] = record; throw error; }
          return;
        }
        if (!config.enabled || member.nickname === member.id) return;
        await editable(member);
        // Re-check the persisted lock after awaiting Discord permission/member reads.
        if (policy(guild.id) !== config || !config.enabled || config.locks[userId] !== record) return;
        await member.setNickname(member.id, `恢复违规昵称锁定；操作人 ${record.operatorId}`);
      } while (dirty.has(key));
    })();
    enforcing.set(key, work);
    void work.catch((error) => logFailure(`违规昵称自动锁定失败（${userId}）。`, error))
      .finally(() => { enforcing.delete(key); if (dirty.delete(key)) queue(guild, userId); });
  }
  function onMember(member) {
    if (!policy(member.guild.id).locks[member.id]) return;
    const key=member.guild.id+':'+member.id;
    if(memberTimers.has(key))return;
    const timer=setTimeout(()=>{memberTimers.delete(key);queue(member.guild,member.id);},30000);timer.unref();memberTimers.set(key,timer);
  }
  function start() {
    const reconcile = () => {
      for (const guild of client.guilds.cache.values()) {
        for (const id of Object.keys(policy(guild.id).locks)) queue(guild, id);
      }
    };
    reconcile();
    setInterval(reconcile, 30 * 60 * 1000).unref();
  }

  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && interaction.commandName === '违规改名面板';
    const customId = interaction.customId || '';
    if (!command && !customId.startsWith('nick-') && !customId.startsWith('nickcfg-')) return false;
    let privateReply = false;
    let actionKey;
    let configKey;
    try {
      if (!interaction.inGuild()) throw new Error('请在服务器中使用。');
      const [action, token] = customId.split(':');
      if (command) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
        const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        const configure = member.permissions.has(PermissionFlagsBits.ManageGuild);
        if (!configure && !operator(member, policy(interaction.guildId))) throw new Error('你不具备操作或配置权限。');
        for (const [key, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(key);
        for (const [key, request] of pending) if (request.expiresAt < Date.now()) pending.delete(key);
        const session = { token: randomBytes(8).toString('hex'), guildId: interaction.guildId,
          userId: interaction.user.id, expiresAt: Date.now() + 30 * 60 * 1000 };
        sessions.set(session.token, session);
        await interaction.editReply(payload(interaction.guildId, session, configure)); return true;
      }
      if (action.startsWith('nickcfg-')) {
        const session = sessionFor(interaction, token);
        await interaction.deferUpdate();
        await access(interaction, true);
        configKey = interaction.guildId;
        if (configActions.has(configKey)) { configKey = null; throw new Error('配置正在保存，请稍后重试。'); }
        configActions.add(configKey);
        if ([...actions, ...enforcing.keys()].some((key) => key.startsWith(`${interaction.guildId}:`))) throw new Error('有成员改名正在执行，请稍后调整配置。');
        const config = policy(interaction.guildId);
        const previous = JSON.parse(JSON.stringify(config));
        if (action === 'nickcfg-operators') {
          if (interaction.values.includes(interaction.guildId)) throw new Error('操作身份组不能使用 @everyone。');
          config.operatorRoleIds = [...new Set(interaction.values)];
          if (!config.operatorRoleIds.length) config.enabled = false;
        } else if (action === 'nickcfg-target') {
          const id = interaction.values[0];
          const role = await interaction.guild.roles.fetch(id);
          if (!role || role.id === interaction.guildId) throw new Error('违规身份组不能是 @everyone。');
          if (config.violationRoleId !== role.id) config.locks = {};
          config.violationRoleId = role.id;
        } else if (action === 'nickcfg-toggle') {
          if (!config.enabled && (!config.operatorRoleIds.length || !config.violationRoleId)) throw new Error('请先设置操作身份组和违规身份组。');
          config.enabled = !config.enabled;
        } else throw new Error('未知配置操作。');
        try { await save(); } catch (error) { settingsFor(interaction.guildId).nicknamePolicy = previous; throw error; }
        await interaction.editReply(payload(interaction.guildId, session, true));
        for (const id of Object.keys(config.locks)) queue(interaction.guild, id);
        return true;
      }
      if (action === 'nick-target') {
        sessionFor(interaction, token);
        // A modal must be acknowledged before any potentially slow member fetches.
        const id = interaction.values[0];
        const requestToken = randomBytes(8).toString('hex');
        pending.set(requestToken, { guildId: interaction.guildId, userId: interaction.user.id, targetId: id,
          expiresAt: Date.now() + 5 * 60 * 1000 });
        await interaction.showModal(new ModalBuilder().setCustomId(`nick-confirm:${requestToken}`)
          .setTitle('强制改名并锁定为数字 ID').addComponents(new LabelBuilder().setLabel('改名理由（提交后执行；目标须持有违规组）')
            .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph)
              .setPlaceholder(`目标 ID：${id}；请填写改名理由`).setRequired(true).setMaxLength(400))));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); privateReply = true;
      await access(interaction);
      if (action === 'nick-release') {
        sessionFor(interaction, token);
        const id = interaction.values[0];
        const config = policy(interaction.guildId);
        actionKey = `${interaction.guildId}:${id}`;
        if (configActions.has(interaction.guildId)) { actionKey = null; throw new Error('配置正在调整，请稍后重试。'); }
        if (actions.has(actionKey) || enforcing.has(actionKey)) { actionKey = null; throw new Error('该成员的昵称正在处理，请稍后重试。'); }
        actions.add(actionKey);
        const previous = config.locks[id];
        if (!previous) throw new Error('该成员没有昵称锁定记录。');
        delete config.locks[id];
        try { await save(); } catch (error) { config.locks[id] = previous; throw error; }
        await interaction.editReply({ content: `已解除 <@${id}> 的昵称锁定；当前昵称保留，可另行修改。`, allowedMentions: { parse: [] } });
        return true;
      }
      if (action !== 'nick-confirm' || !interaction.isModalSubmit()) throw new Error('未知改名操作。');
      const request = pending.get(token);
      if (!request || request.guildId !== interaction.guildId || request.userId !== interaction.user.id
        || request.expiresAt < Date.now()) throw new Error('改名申请已过期，请重新选择成员。');
      const config = policy(interaction.guildId);
      if (!config.enabled) throw new Error('违规改名功能尚未启用或已暂停。');
      actionKey = `${interaction.guildId}:${request.targetId}`;
      if (configActions.has(interaction.guildId)) { actionKey = null; throw new Error('配置正在调整，请稍后重新提交。'); }
      if (actions.has(actionKey) || enforcing.has(actionKey)) { actionKey = null; throw new Error('该成员的昵称正在处理，请勿重复操作。'); }
      actions.add(actionKey);
      let member = await interaction.guild.members.fetch({ user: request.targetId, force: true });
      if (!hasRole(member, config.violationRoleId)) throw new Error('目标成员必须持有面板指定的违规身份组。');
      await editable(member);
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!reason) throw new Error('请填写改名理由。');
      if (!config.enabled || !operator(await interaction.guild.members.fetch({ user: interaction.user.id, force: true }), config)) {
        throw new Error('配置或你的操作权限已发生变化，请重新操作。');
      }
      if (config.locks[member.id]) throw new Error('该成员已被锁定，无需重复操作。');
      const record = { userId: member.id, operatorId: interaction.user.id, violationRoleId: config.violationRoleId,
        reason, createdAt: Date.now() };
      config.locks[member.id] = record;
      try { await save(); } catch (error) { delete config.locks[member.id]; throw error; }
      try {
        await access(interaction);
        member = await interaction.guild.members.fetch({ user: request.targetId, force: true });
        if (!hasRole(member, record.violationRoleId)) throw new Error('目标已失去指定违规身份组，已取消本次锁定。');
        await editable(member);
        await member.setNickname(member.id, `违规昵称锁定；操作人 ${interaction.user.id}；${reason}`);
      } catch (error) {
        delete config.locks[member.id];
        await save().catch((failure) => logFailure('违规昵称失败状态保存失败。', failure));
        throw error;
      }
      pending.delete(token);
      await interaction.editReply({ content: `已将 <@${member.id}> 的服务器昵称改为 ${member.id} 并持续锁定。移除指定违规身份组或在面板解除锁定后停止改回。`, allowedMentions: { parse: [] } });
    } catch (error) {
      logFailure('违规改名面板操作失败。', error);
      const reply = { content: `操作未完成：${error.message}`, allowedMentions: { parse: [] } };
      if (privateReply) await interaction.editReply(reply).catch(() => {});
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ ...reply, flags: MessageFlags.Ephemeral }).catch(() => {});
      else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral }).catch(() => {});
    } finally {
      if (configKey) configActions.delete(configKey);
      if (actionKey) {
        actions.delete(actionKey);
        const id = actionKey.split(':')[1];
        if (dirty.delete(actionKey)) queue(interaction.guild, id);
      }
    }
    return true;
  }
  function onRaw(packet){if(!['GUILD_MEMBER_UPDATE','GUILD_MEMBER_REMOVE','GUILD_MEMBER_ADD'].includes(packet.t))return;const guild=client.guilds.cache.get(packet.d?.guild_id),id=packet.d?.user?.id;if(guild&&id)onMember({guild,id});}
  return { handle, onMember, onRaw, start };
}

module.exports = { createNicknamePanel, nicknameCommand };
