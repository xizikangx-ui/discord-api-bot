const { randomBytes } = require('node:crypto');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags, PermissionFlagsBits, ChannelType, ModalBuilder,
  LabelBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } = require('discord.js');
const { addPunishmentDurationOptions, readPunishmentDurations, formatPunishmentDuration, MAX_MINUTES } = require('./punishment-duration');

const punishmentModes = { warning: '仅警告', timeout: '仅禁言', both: '警告并禁言', ban: '永封' };
const statusLabels = { publishing: '正在发布', open: '投票中', closed: '已截止', awaiting: '投票通过，等待管理组确认',
  rejected: '投票未通过，不执行处罚', cancelled: '已取消', executing: '管理组已确认，正在执行处罚',
  completed: '已执行处罚', uncertain: '处罚结果需管理组核对，未自动重试', failed: '发布未完成' };
const pollCommand = addPunishmentDurationOptions(new SlashCommandBuilder().setName('投票').setDescription('创建不公开投票名单的普通投票或处罚投票')
  .setDefaultMemberPermissions(null)
  .addStringOption(o => o.setName('主题').setDescription('投票主题，留空直接打开创建弹窗').setMaxLength(256))
  .addStringOption(o => o.setName('类型').setDescription('默认普通投票；处罚投票通过后仍需管理组确认')
    .addChoices({ name: '普通投票', value: 'ordinary' }, { name: '处罚投票', value: 'punishment' }))
  .addStringOption(o => o.setName('选项').setDescription('普通投票的2到10项，用竖线 | 或换行分隔；留空为赞成/反对').setMaxLength(1000))
  .addIntegerOption(o => o.setName('截止分钟').setDescription('1到10080分钟，默认1440分钟（24小时）').setMinValue(1).setMaxValue(10080))
  .addUserOption(o => o.setName('成员').setDescription('处罚目标，与用户ID二选一'))
  .addStringOption(o => o.setName('user_id').setDescription('处罚目标用户ID或提及，与成员二选一').setMaxLength(32))
  .addStringOption(o => o.setName('处罚方式').setDescription('仅处罚投票填写').addChoices(...Object.entries(punishmentModes).map(([value, name]) => ({ value, name }))))
  .addStringOption(o => o.setName('处罚原因').setDescription('仅处罚投票必填').setMaxLength(400))
  .addIntegerOption(o => o.setName('最多选项').setDescription('普通投票每人最多选几项，默认可选全部；填1为单选').setMinValue(1).setMaxValue(10))
  .addStringOption(o => o.setName('说明').setDescription('投票卡片中的补充说明（可选）').setMaxLength(500)));
const pollPanelCommand = new SlashCommandBuilder().setName('投票面板').setDescription('打开投票操作面板，使用弹窗创建普通或处罚投票')
  .setDefaultMemberPermissions(null);
const row = (...items) => new ActionRowBuilder().addComponents(...items);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const clone = value => structuredClone(value);

function createPolls(deps) {
  const { client, settingsFor, guildIds, save, encrypt, decrypt, archiveChannelId, archiveGuildId,
    manager, scopeFor, validatePunishment, executePunishment } = deps;
  const logFailure = (label, error) => deps.logFailure(label, { code: error?.code ?? error?.rawError?.code,
    message: '请检查留档可访问性及Bot权限；不在运行日志输出投票人或选择。' });
  // The shared operational snapshot stores pointers only. Voter IDs and choices live
  // exclusively in the encrypted per-poll attachment in the designated archive channel.
  const cache = new Map();
  const queues = new Map();
  const confirmations = new Map();
  const drafts = new Map();
  const ticking = new Set();
  const retryAt = new Map();
  let started = false;
  const indexes = guildId => (settingsFor(guildId).pollIndexes ||= []);
  const allIndexes = () => guildIds().flatMap(indexes);
  const sameScope = (a, b) => a.length === b.length && a.every(id => b.includes(id));
  const filename = id => `poll-${id}.json.enc`;
  function enqueue(id, action) {
    const previous = queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(id, next);
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }
  async function archiveChannel() {
    const channel = await client.channels.fetch(archiveChannelId);
    if (channel?.guildId !== archiveGuildId || channel.type !== ChannelType.GuildText) throw new Error('投票留档频道不可用。');
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles])) throw new Error('Bot缺少投票留档频道的查看、发送、读取历史或附加文件权限。');
    if (channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new Error('投票留档频道必须对 @everyone 关闭查看权限。');
    }
    return channel;
  }
  function archivePayload(data) {
    return { content: `投票加密记录 ${data.id}\n类型：${data.type === 'punishment' ? '处罚投票' : '普通投票'}\n状态：${statusLabels[data.status]}\n${data.messageId ? `投票消息：https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}\n` : ''}投票人、选择及操作记录仅保存在加密附件中。`,
      files: [{ attachment: Buffer.from(encrypt(data), 'utf8'), name: filename(data.id) }],
      components: [row(button(`poll-record:${data.id}`, '查看加密投票记录'))], allowedMentions: { parse: [] } };
  }
  async function load(meta) {
    if (cache.has(meta.id)) return cache.get(meta.id);
    const channel = await archiveChannel();
    const message = await channel.messages.fetch({ message: meta.archiveMessageId, force: true });
    if (message.author.id !== client.user.id) throw new Error('投票记录不是本Bot创建的，已停止处理。');
    const attachment = message.attachments.find(item => item.name === filename(meta.id));
    if (!attachment) throw new Error('加密投票记录附件已不存在，已停止处理。');
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`读取投票记录失败（HTTP ${response.status}）。`);
    const result = decrypt(await response.json());
    const data = result.value;
    if (!result.encrypted || data?.kind !== 'anonymous-poll' || data.id !== meta.id || data.guildId !== meta.guildId
      || data.channelId !== meta.channelId || !Array.isArray(data.options) || !data.votes || !Array.isArray(data.events)) {
      throw new Error('加密投票记录格式或身份不匹配，已停止处理。');
    }
    cache.set(meta.id, data);
    return data;
  }
  async function store(meta, data) {
    try {
      const channel = await archiveChannel();
      const message = await channel.messages.fetch({ message: meta.archiveMessageId, force: true });
      if (message.author.id !== client.user.id) throw new Error('投票记录作者不匹配。');
      await message.edit({ ...archivePayload(data), attachments: [] });
      cache.set(meta.id, data);
      meta.status = data.status;
    } catch (error) {
      // An interrupted HTTP response may conceal a successful write. Reload the
      // canonical attachment on the next attempt rather than overwrite from memory.
      cache.delete(meta.id);
      throw error;
    }
  }
  function choicesFor(vote, data) {
    return [...new Set(Array.isArray(vote?.choices) ? vote.choices : [vote?.choice])]
      .filter(choice => Number.isInteger(choice) && choice >= 0 && choice < data.options.length).sort((a, b) => a - b);
  }
  const maxChoices = data => data.type === 'punishment' ? 1 : Math.max(1, Math.min(data.options.length, data.maxChoices || 1));
  function totals(data) {
    const counts = data.options.map(() => 0);
    for (const vote of Object.values(data.votes)) for (const choice of choicesFor(vote, data)) counts[choice]++;
    return counts;
  }
  function publicPayload(data) {
    const counts = totals(data);
    const total = counts.reduce((a, b) => a + b, 0);
    const participants = Object.values(data.votes).filter(vote => choicesFor(vote, data).length).length;
    const limit = maxChoices(data);
    const color = ['cancelled', 'failed'].includes(data.status) ? 0x747F8D
      : ['rejected', 'uncertain'].includes(data.status) ? 0xED4245
        : ['awaiting', 'executing'].includes(data.status) ? 0xFEE75C : data.status === 'open' ? 0x5865F2 : 0x57F287;
    const embed = new EmbedBuilder().setAuthor({ name: data.type === 'punishment' ? '⚖️ 处罚联动投票' : '🗳️ 社区投票' })
      .setTitle(data.title).setColor(color)
      .setDescription(data.description || (limit > 1 ? `可同时选择最多 **${limit}项**，重新提交会替换你的全部选择。` : '请选择一个选项，重新提交可修改选择。'))
      .addFields({ name: '📌 状态', value: statusLabels[data.status], inline: true },
        { name: '👥 参与情况', value: `**${participants}人** · ${total}票次`, inline: true },
        { name: '⏳ 截止', value: `<t:${Math.floor(data.endsAt / 1000)}:R>\n<t:${Math.floor(data.endsAt / 1000)}:f>`, inline: true });
    data.options.forEach((option, index) => {
      const percent = participants ? Math.round(counts[index] / participants * 100) : 0;
      const filled = Math.round(percent / 10);
      embed.addFields({ name: `${String(index + 1).padStart(2, '0')} · ${escapeMarkdown(option)}`,
        value: `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  **${percent}%**\n${counts[index]}票`, inline: false });
    });
    embed.addFields({ name: '🔒 投票规则', value: `${limit > 1 ? `每人最多选${limit}项，同一项只计一票` : '每人只选一项'} · 可修改或撤回\n只展示汇总结果，不公开投票人名单。${limit > 1 ? '\n百分比按参与人数计算，合计可能超过100%。' : ''}` })
      .setFooter({ text: `投票编号 ${data.id}` }).setTimestamp(data.createdAt);
    if (data.type === 'punishment') embed.addFields({ name: '处罚目标', value: `<@${data.userId}> (${data.userId})` },
      { name: '处罚方式', value: punishmentModes[data.mode], inline: true }, { name: '原因', value: data.reason },
      { name: '通过条件', value: '投票截止后，赞成票多于反对票才通过；通过后仍需管理组确认，不自动处罚。' });
    if (data.timeoutDays) embed.addFields({ name: '禁言时长', value: formatPunishmentDuration(data.timeoutDays), inline: true });
    if (data.type === 'punishment' && ['warning', 'both'].includes(data.mode)) {
      embed.addFields({ name: '警告时长', value: data.warningDays ? formatPunishmentDuration(data.warningDays) : '不自动移除', inline: true });
    }
    if (data.type === 'ordinary' && data.status === 'closed') {
      const highest = Math.max(...counts);
      embed.addFields({ name: '结果', value: total ? `得票最高：${data.options.filter((_, i) => counts[i] === highest).join('、')}` : '没有有效票。' });
    }
    if (data.caseId && ['completed', 'uncertain', 'executing'].includes(data.status)) embed.addFields({ name: '处罚编号', value: data.caseId });
    const components = [];
    if (data.status === 'open') {
      components.push(row(new StringSelectMenuBuilder().setCustomId(`poll-vote:${data.id}`)
        .setPlaceholder(limit > 1 ? `选择1到${limit}项，选好后提交` : '选择一个选项')
        .setMinValues(1).setMaxValues(limit)
        .addOptions(data.options.map((label, index) => ({ label, value: String(index) })))));
      components.push(row(button(`poll-withdraw:${data.id}`, '撤回投票'), button(`poll-mine:${data.id}`, '查看我的选择', ButtonStyle.Primary),
        button(`poll-refresh:${data.id}`, '刷新结果'), button(`poll-cancel:${data.id}`, '取消投票')));
    } else if (data.status === 'awaiting') components.push(row(button(`poll-approve:${data.id}`, '管理组确认处罚', ButtonStyle.Danger),
      button(`poll-cancel:${data.id}`, '取消处罚联动'), button(`poll-refresh:${data.id}`, '刷新结果')));
    else components.push(row(button(`poll-refresh:${data.id}`, '刷新结果')));
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
  }
  async function refresh(meta, data) {
    if (!meta.messageId || meta.publicMissing) return;
    try {
      const channel = await client.channels.fetch(meta.channelId);
      const message = await channel.messages.fetch(meta.messageId);
      await message.edit(publicPayload(data));
    } catch (error) {
      if ([10008, 10003].includes(Number(error.code ?? error.rawError?.code))) {
        meta.publicMissing = true;
        await save();
      } else throw error;
    }
  }
  const publicTimers = new Map(), publicAt = new Map();
  async function refreshAfter(meta, data, coalesce=false) {
    if(coalesce){
      if(publicTimers.has(meta.id))return;
      const timer=setTimeout(()=>{publicTimers.delete(meta.id);void enqueue(meta.id,async()=>refreshAfter(meta,await load(meta))).catch(error=>logFailure('投票统计刷新失败。',error));},Math.max(1,60000-(Date.now()-(publicAt.get(meta.id)||Date.now()))));
      timer.unref();publicTimers.set(meta.id,timer);return;
    }
    clearTimeout(publicTimers.get(meta.id));publicTimers.delete(meta.id);publicAt.set(meta.id,Date.now());
    await refresh(meta, data).catch(error => logFailure('投票记录已保存，公开面板刷新失败。', error));
  }
  async function closeIfDue(meta, data) {
    if (data.status !== 'open' || Date.now() < data.endsAt) return data;
    const next = clone(data);
    const counts = totals(next);
    next.status = next.type === 'ordinary' ? 'closed' : counts[0] > counts[1] ? 'awaiting' : 'rejected';
    next.closedAt = Date.now();
    next.events.push({ action: 'deadline', at: next.closedAt, totals: counts, status: next.status });
    await store(meta, next);
    await save().catch(error => logFailure('投票索引状态保存失败；加密投票记录已保存。', error));
    await refreshAfter(meta, next);
    return next;
  }
  async function memberFor(interaction) {
    if (!interaction.guild || interaction.user.bot) throw new Error('只有本服务器真人成员能操作投票。');
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true, cache: false });
    if (!member || member.user.bot) throw new Error('只有本服务器真人成员能操作投票。');
    return member;
  }
  async function isManager(interaction) {
    const member = await memberFor(interaction);
    return manager({ guildId: interaction.guildId, member });
  }
  async function create(interaction, o = interaction.options) {
    await memberFor(interaction);
    const type = o.getString('类型') || 'ordinary';
    const title = o.getString('主题', true).trim();
    if (!title) throw new Error('投票主题不能为空。');
    const mode = o.getString('处罚方式');
    const selected = o.getUser('成员');
    const raw = o.getString('user_id')?.trim();
    const reason = o.getString('处罚原因')?.trim();
    const { timeoutDays, warningDays } = readPunishmentDurations(o);
    const requestedMax = o.getInteger('最多选项');
    let options;
    let userId;
    if (type === 'punishment') {
      if (requestedMax && requestedMax !== 1) throw new Error('处罚投票只能赞成或反对二选一。');
      if (o.getString('选项')) throw new Error('处罚投票固定为“赞成处罚 / 反对处罚”，不能另填选项。');
      if (!punishmentModes[mode] || !reason) throw new Error('处罚投票需要填写处罚方式及处罚原因。');
      if (Boolean(selected) === Boolean(raw)) throw new Error('处罚目标请在成员和user_id中任选一项。');
      const match = raw?.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
      if (raw && !match) throw new Error('目标用户ID格式不正确。');
      userId = selected?.id || match[1] || match[2];
      if (['timeout', 'both'].includes(mode) !== Boolean(timeoutDays)) throw new Error('禁言和警告并禁言须填写禁言时长，其他方式不能填写。');
      if (!['warning', 'both'].includes(mode) && warningDays) throw new Error('此方式不能填写警告时长。');
      await validatePunishment(interaction, { guildId: interaction.guildId, userId, mode, reason, timeoutDays, warningDays });
      options = ['赞成处罚', '反对处罚'];
    } else {
      if (mode || selected || raw || reason || timeoutDays || warningDays) throw new Error('普通投票不能填写处罚相关参数。');
      options = (o.getString('选项') || '赞成|反对').split(/[|\n]/).map(value => value.trim()).filter(Boolean);
      if (options.length < 2 || options.length > 10 || new Set(options).size !== options.length || options.some(value => value.length > 100)) {
        throw new Error('请提供2到10个不重复选项，每项最多100字，用 | 或换行分隔。');
      }
      if (requestedMax && requestedMax > options.length) throw new Error('最多选项不能超过实际选项数量。');
    }
    const channel = interaction.channel || await client.channels.fetch(interaction.channelId);
    const send = channel?.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (!channel?.isTextBased() || channel.guildId !== interaction.guildId || channel.archived
      || !channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks])) {
      throw new Error('Bot无法在当前频道发投票，请检查频道权限或帖子归档状态。');
    }
    const archive = await archiveChannel();
    const now = Date.now();
    const data = { kind: 'anonymous-poll', version: 1, id: randomBytes(8).toString('hex'), guildId: interaction.guildId,
      channelId: interaction.channelId, creatorId: interaction.user.id, title, type, options, userId, mode, reason,
      timeoutDays, warningDays, scopeGuildIds: scopeFor(interaction.guildId), createdAt: now,
      endsAt: now + (o.getInteger('截止分钟') || 1440) * 60000,
      maxChoices: type === 'punishment' ? 1 : requestedMax || options.length, description: o.getString('说明')?.trim() || '',
      status: 'publishing', votes: {},
      events: [{ action: 'create', actorId: interaction.user.id, at: now }] };
    const record = await archive.send(archivePayload(data));
    const meta = { id: data.id, guildId: data.guildId, channelId: data.channelId, archiveMessageId: record.id,
      status: 'publishing', endsAt: data.endsAt, createdAt: now, messageId: null };
    indexes(data.guildId).push(meta);
    cache.set(data.id, data);
    await enqueue(meta.id, async () => {
      let published;
      try {
        await save();
        published = await channel.send(publicPayload({ ...data, status: 'open' }));
        meta.messageId = published.id;
        data.messageId = published.id; data.status = 'open';
        await store(meta, data);
        await save();
      } catch (error) {
        const failed = { ...data, status: 'failed' };
        await store(meta, failed).catch(archiveError => logFailure('投票发布失败状态留档未完成。', archiveError));
        meta.status = 'failed';
        await save().catch(indexError => logFailure('投票发布失败索引保存未完成。', indexError));
        await refreshAfter(meta, failed);
        throw error;
      }
      // A failed ephemeral delivery must not invalidate an already published poll.
      await interaction.editReply(`投票已发布：${published.url}\n${data.maxChoices > 1 ? `每人最多选${data.maxChoices}项` : '每人只选一项'}，可修改或撤回，不公开名单。`);
    });
  }
  async function recordView(interaction, id) {
    const member = await memberFor(interaction);
    if (interaction.guildId !== archiveGuildId || interaction.channelId !== archiveChannelId
      || !member.permissions.has(PermissionFlagsBits.ManageGuild) || interaction.message?.author?.id !== client.user.id) {
      throw new Error('只有存储服务器的管理员可在指定留档频道解密投票记录。');
    }
    const meta = allIndexes().find(item => item.id === id && item.archiveMessageId === interaction.message.id);
    if (!meta) throw new Error('找不到该投票记录索引。');
    // Always decrypt the current attachment, rather than trust a stale runtime copy.
    cache.delete(id);
    const data = await load(meta);
    await interaction.editReply({ content: `投票 ${id} 的记录仅向你显示。`,
      files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), name: `poll-${id}.json` }], allowedMentions: { parse: [] } });
  }
  async function approve(interaction, meta, data) {
    if (data.status !== 'awaiting' || data.type !== 'punishment') throw new Error('此投票尚未通过或已处理，不能执行处罚。');
    if (!await isManager(interaction)) throw new Error('投票无需身份组，但执行处罚必须由管理组确认。');
    if (!sameScope(data.scopeGuildIds, scopeFor(data.guildId))) throw new Error('互通服务器配置已改变，请重新发起处罚投票。');
    await validatePunishment(interaction, data);
    const token = randomBytes(8).toString('hex');
    confirmations.set(token, { id: meta.id, guildId: meta.guildId, userId: interaction.user.id, expiresAt: Date.now() + 60000 });
    await interaction.editReply({ content: `确定执行这笔投票处罚吗？\n目标：<@${data.userId}> (${data.userId})\n方式：${punishmentModes[data.mode]}\n原因：${data.reason}\n${data.timeoutDays ? `禁言：${formatPunishmentDuration(data.timeoutDays)}\n` : ''}确认后会实际处罚，此确认卡1分钟有效。`,
      allowedMentions: { parse: [] }, components: [row(button(`poll-execute:${token}`, '确认执行处罚', ButtonStyle.Danger), button(`poll-abort:${token}`, '返回，不执行'))] });
  }
  async function execute(interaction, meta, data) {
    if (data.status !== 'awaiting') throw new Error('该投票已由其他人处理，未重复执行。');
    if (!await isManager(interaction)) throw new Error('您不具备管理组确认权限。');
    if (!sameScope(data.scopeGuildIds, scopeFor(data.guildId))) throw new Error('互通配置已改变，请重新发起投票。');
    // Use the vote's source channel even if the private confirmation has a new reply.
    const context = { guild: interaction.guild, guildId: data.guildId, user: interaction.user,
      member: interaction.member, channelId: data.channelId, channel: await client.channels.fetch(data.channelId) };
    if (context.channel?.isThread() && context.channel.archived) {
      context.channel = await interaction.guild.channels.fetch(settingsFor(data.guildId).logChannelId);
      context.channelId = context.channel?.id;
    }
    await validatePunishment(context, data);
    const executing = clone(data);
    executing.status = 'executing'; executing.caseId = randomBytes(6).toString('hex');
    executing.approvedBy = interaction.user.id; executing.executionStartedAt = Date.now();
    executing.events.push({ action: 'approve', actorId: interaction.user.id, at: executing.executionStartedAt, caseId: executing.caseId });
    await store(meta, executing); // Durable marker before the first punitive API call.
    await save().catch(error => logFailure('处罚投票执行索引保存失败；执行标记已加密留档。', error));
    await refreshAfter(meta, executing);
    let finished = clone(executing);
    try {
      finished.result = await executePunishment(context, { ...data, caseId: executing.caseId });
      finished.status = 'completed'; finished.finishedAt = Date.now();
      finished.events.push({ action: 'punishment-completed', at: finished.finishedAt, caseId: finished.caseId });
    } catch (error) {
      finished.status = 'uncertain'; finished.error = String(error.message).slice(0, 1000); finished.finishedAt = Date.now();
      finished.events.push({ action: 'punishment-uncertain', at: finished.finishedAt, caseId: finished.caseId });
      logFailure('投票处罚执行未完成，请按处罚编号核对；未自动重试。', error);
    }
    try { await store(meta, finished); }
    catch (error) {
      finished.status = 'uncertain'; finished.error = '处罚结果留档未确认，请核对处罚编号；不会自动重试。';
      cache.set(meta.id, finished); meta.status = 'uncertain';
      logFailure('投票处罚结果留档失败。', error);
    }
    await save().catch(error => logFailure('投票处罚结果索引保存失败。', error));
    await refreshAfter(meta, finished);
    await interaction.editReply({ content: finished.status === 'completed' ? finished.result
      : `结果需要人工核对，处罚编号：${finished.caseId}。未自动重试，请检查日志及实际处罚状态。`, components: [], allowedMentions: { parse: [] } });
  }
  const optionAdapter = values => ({ getString: name => values[name] ?? null, getInteger: name => values[name] ?? null,
    getUser: name => values[name] ?? null });
  function draftFor(interaction, token) {
    const draft = drafts.get(token);
    if (!draft || draft.userId !== interaction.user.id || draft.guildId !== interaction.guildId
      || draft.channelId !== interaction.channelId || Date.now() >= draft.expiresAt) {
      throw new Error('创建面板已过期或不属于你，请重新运行 /投票 或 /投票面板。');
    }
    return draft;
  }
  function input(id, label, maxLength, value = '', required = true, paragraph = false) {
    const field = new TextInputBuilder().setCustomId(id).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(required).setMaxLength(maxLength);
    if (String(value)) field.setValue(String(value));
    return new LabelBuilder().setLabel(label).setTextInputComponent(field);
  }
  function composeForm(token, draft) {
    const v = draft.values;
    const modal = new ModalBuilder().setCustomId(`poll-form:${token}`)
      .setTitle(v['类型'] === 'punishment' ? '创建处罚投票 · 基本信息' : '创建社区投票');
    if (v['类型'] === 'punishment') return modal.addComponents(
      input('title', '投票主题', 256, v['主题'] || ''),
      input('target', '目标用户数字ID（可以不在当前服务器）', 32, v['成员']?.id || v['user_id'] || ''),
      input('reason', '处罚原因', 400, v['处罚原因'] || '', true, true),
      input('minutes', '多少分钟后截止（1–10080）', 5, v['截止分钟'] || 1440),
      new LabelBuilder().setLabel('处罚方式').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('mode')
        .setRequired(true).setMinValues(1).setMaxValues(1).addOptions(Object.entries(punishmentModes).map(([value, label]) =>
          ({ value, label, default: value === (v['处罚方式'] || 'warning') })))));
    return modal.addComponents(input('title', '投票主题', 256, v['主题'] || ''),
      input('options', '投票选项（每行一项或用 | 分隔，2–10项）', 1000, v['选项'] || '赞成\n反对', true, true),
      input('minutes', '多少分钟后截止（1–10080）', 5, v['截止分钟'] || 1440),
      input('max', '每人最多选几项（留空可选全部，1为单选）', 2, v['最多选项'] || '', false),
      input('description', '补充说明（可选）', 500, v['说明'] || '', false, true));
  }
  async function showCompose(interaction, type, initial = {}) {
    if (!interaction.guildId || !interaction.member || interaction.user.bot) throw new Error('请在服务器内使用投票面板。');
    const token = randomBytes(8).toString('hex');
    const draft = { userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId,
      expiresAt: Date.now() + 10 * 60000, values: { ...initial, '类型': type } };
    drafts.set(token, draft);
    await interaction.showModal(composeForm(token, draft));
  }
  function integerText(interaction, field, label, min, max, fallback = null) {
    const text = interaction.fields.getTextInputValue(field).trim();
    if (!text) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}请填${min}到${max}的整数。`);
    return value;
  }
  async function submitForm(interaction, token, duration = false) {
    const draft = draftFor(interaction, token);
    const v = draft.values;
    if (duration) {
      const unit = interaction.fields.fields.has('durationUnit') ? interaction.fields.getStringSelectValues('durationUnit')[0] : 'days';
      if (!['minutes', 'days'].includes(unit)) throw new Error('请选择有效时长单位。');
      const suffix = unit === 'minutes' ? '分钟' : '天数';
      const timeout = integerText(interaction, 'timeout', `禁言${suffix}`, 1, unit === 'minutes' ? MAX_MINUTES : 90);
      const warning = integerText(interaction, 'warning', `警告${suffix}`, 1, unit === 'minutes' ? MAX_MINUTES : 90);
      for (const name of ['禁言天数', '警告天数', '禁言分钟', '警告分钟']) v[name] = null;
      v[`禁言${suffix}`] = timeout; v[`警告${suffix}`] = warning;
    } else {
      v['主题'] = interaction.fields.getTextInputValue('title').trim();
      if (!v['主题']) throw new Error('投票主题不能为空。');
      v['截止分钟'] = integerText(interaction, 'minutes', '截止分钟', 1, 10080, 1440);
      if (v['类型'] === 'ordinary') {
        v['选项'] = interaction.fields.getTextInputValue('options');
        v['最多选项'] = integerText(interaction, 'max', '最多选项', 1, 10);
        v['说明'] = interaction.fields.getTextInputValue('description').trim();
      } else {
        v['成员'] = null; v['user_id'] = interaction.fields.getTextInputValue('target').trim();
        v['处罚原因'] = interaction.fields.getTextInputValue('reason').trim();
        if (!v['处罚原因']) throw new Error('处罚原因不能为空。');
        v['处罚方式'] = interaction.fields.getStringSelectValues('mode')[0];
        if (v['处罚方式'] !== 'ban') {
          await interaction.editReply({ content: '基本信息已填写。点击下方按钮填写处罚时长并发布；这一步不会执行处罚。',
            embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle(v['主题']).setDescription(`方式：${punishmentModes[v['处罚方式']]}\n原因：${v['处罚原因']}`)],
            components: [row(button(`poll-duration:${token}`, '填写时长并发布', ButtonStyle.Primary))], allowedMentions: { parse: [] } });
          return;
        }
        v['禁言天数'] = null; v['警告天数'] = null; v['禁言分钟'] = null; v['警告分钟'] = null;
      }
    }
    // Consume before creating so two modal submissions cannot publish twice.
    drafts.delete(token);
    await create(interaction, optionAdapter(v));
  }
  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && ['投票', '投票面板'].includes(interaction.commandName);
    const component = (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith('poll-');
    if (!command && !component) return false;
    try {
      if (!started) throw new Error('投票功能正在恢复加密记录，请稍后再试。');
      const [action, id] = (interaction.customId || '').split(':');
      if (command && interaction.commandName === '投票' && !interaction.options.getString('主题')) {
        const initial = {};
        for (const name of ['选项', 'user_id', '处罚方式', '处罚原因', '说明']) initial[name] = interaction.options.getString(name);
        for (const name of ['截止分钟', '禁言天数', '警告天数', '禁言分钟', '警告分钟', '最多选项']) initial[name] = interaction.options.getInteger(name);
        initial['成员'] = interaction.options.getUser('成员');
        await showCompose(interaction, interaction.options.getString('类型') || 'ordinary', initial); return true;
      }
      if (interaction.isButton() && action === 'poll-open') {
        if (!['ordinary', 'punishment'].includes(id)) throw new Error('投票类型无效。');
        await showCompose(interaction, id); return true;
      }
      if (interaction.isButton() && action === 'poll-duration') {
        const draft = draftFor(interaction, id);
        const { timeoutDays, warningDays } = readPunishmentDurations(optionAdapter(draft.values));
        await interaction.showModal(new ModalBuilder().setCustomId(`poll-duration-form:${id}`).setTitle('处罚投票 · 时长设置')
          .addComponents(input('timeout', '禁言时长（按下方单位，禁言方式必填）', 6, timeoutDays ? Math.round(timeoutDays * 1440) : '', false),
            input('warning', '警告时长（按下方单位，留空不自动移除）', 6, warningDays ? Math.round(warningDays * 1440) : '', false),
            new LabelBuilder().setLabel('时长单位（最低1分钟，最高90天）').setStringSelectMenuComponent(
              new StringSelectMenuBuilder().setCustomId('durationUnit').setRequired(true).addOptions(
                { label: '分钟', value: 'minutes', default: true }, { label: '天', value: 'days' }))));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (command && interaction.commandName === '投票面板') {
        await memberFor(interaction);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🗳️ 投票操作面板')
          .setDescription('选择投票类型，弹窗填写后发布到当前频道。\n普通投票支持多选，处罚投票通过后由管理组确认。\n公开只显示票数，投票名单加密留档。')],
          components: [row(button('poll-open:ordinary', '创建普通投票', ButtonStyle.Primary), button('poll-open:punishment', '创建处罚投票'))] });
        return true;
      }
      if (command) { await create(interaction); return true; }
      if (interaction.isModalSubmit() && ['poll-form', 'poll-duration-form'].includes(action)) {
        await submitForm(interaction, id, action === 'poll-duration-form'); return true;
      }
      if (action === 'poll-record') { await enqueue(id, () => recordView(interaction, id)); return true; }
      if (action === 'poll-execute' || action === 'poll-abort') {
        const session = confirmations.get(id);
        if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || Date.now() >= session.expiresAt) {
          throw new Error('确认卡已过期或不属于你，请从投票卡重新确认。');
        }
        confirmations.delete(id);
        if (action === 'poll-abort') { await interaction.editReply('未执行处罚。'); return true; }
        const meta = indexes(session.guildId).find(item => item.id === session.id);
        if (!meta) throw new Error('投票索引已不存在。');
        await enqueue(meta.id, async () => execute(interaction, meta, await load(meta)));
        return true;
      }
      const meta = indexes(interaction.guildId).find(item => item.id === id);
      if (!meta || meta.messageId !== interaction.message?.id || meta.channelId !== interaction.channelId
        || interaction.message.author.id !== client.user.id) throw new Error('投票卡不属于当前服务器或原投票消息。');
      await enqueue(meta.id, async () => {
        await memberFor(interaction);
        let data = await closeIfDue(meta, await load(meta));
        if (action === 'poll-approve') { await approve(interaction, meta, data); return; }
        if (action === 'poll-refresh') { await refreshAfter(meta, data,true); await interaction.editReply(`当前记录：${statusLabels[data.status]}。公开统计每分钟合并更新。`); return; }
        if (action === 'poll-mine') {
          const vote = data.votes[interaction.user.id];
          const selected = choicesFor(vote, data);
          await interaction.editReply(selected.length ? `你的选择：${selected.map(choice => data.options[choice]).join('、')}。` : '你当前没有有效投票。'); return;
        }
        if (action === 'poll-cancel') {
          const allowed = data.type === 'ordinary' ? data.creatorId === interaction.user.id || await isManager(interaction) : await isManager(interaction);
          if (!allowed) throw new Error(data.type === 'ordinary' ? '只有发起人或管理组可取消此投票。' : '处罚联动只能由管理组取消。');
          if (!['open', 'awaiting'].includes(data.status)) throw new Error('投票已经处理，不能取消或撤销实际处罚。');
          const next = clone(data);
          next.status = 'cancelled'; next.cancelledAt = Date.now();
          next.events.push({ action: 'cancel', actorId: interaction.user.id, at: next.cancelledAt });
          await store(meta, next); await save().catch(error => logFailure('投票取消索引保存失败；记录已保存。', error));
          await refreshAfter(meta, next); await interaction.editReply('投票已取消，不会执行联动处罚。'); return;
        }
        if (data.status !== 'open' || Date.now() >= data.endsAt) throw new Error('投票已截止或关闭，不能再投票。');
        const next = clone(data);
        if (action === 'poll-withdraw') {
          if (!next.votes[interaction.user.id]) { await interaction.editReply('你当前没有有效投票。'); return; }
          delete next.votes[interaction.user.id];
          next.events.push({ action: 'withdraw', actorId: interaction.user.id, at: Date.now() });
        } else if (action === 'poll-vote') {
          const choices = [...new Set(interaction.values.map(Number))].sort((a, b) => a - b);
          if (!choices.length || choices.length > maxChoices(next) || choices.some(choice => !Number.isInteger(choice) || !next.options[choice])) {
            throw new Error(`请选择1到${maxChoices(next)}个有效选项。`);
          }
          if (JSON.stringify(choicesFor(next.votes[interaction.user.id], next)) === JSON.stringify(choices)) {
            await interaction.editReply('已投给这些选项，同一项不会重复计票。'); return;
          }
          next.votes[interaction.user.id] = { choices, at: Date.now() };
          next.events.push({ action: 'vote', actorId: interaction.user.id, choices, at: Date.now() });
        } else throw new Error('投票操作无效。');
        await store(meta, next);
        await refreshAfter(meta, next, true);
        await interaction.editReply(action === 'poll-withdraw' ? '已撤回你的投票。' : `已记录你的选择：${choicesFor(next.votes[interaction.user.id], next).map(choice => next.options[choice]).join('、')}。其他人看不到投票名单。`);
      });
    } catch (error) {
      // Do not put voter IDs or selected choices in production logs.
      if (error.code || error.cause) logFailure('投票操作失败，详见私密加密记录及频道权限。', error);
      const payload = { content: String(error.message || '操作未完成，请稍后重试。').slice(0, 1800), components: [], allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return true;
  }
  async function reconcile(meta) {
    let data = await load(meta);
    const repaired = Boolean(data.messageId && meta.messageId !== data.messageId);
    if (repaired) { meta.messageId = data.messageId; await save(); }
    if (data.status === 'executing') {
      data = clone(data); data.status = 'uncertain';
      data.error = 'Bot重启时正在执行处罚，必须人工核对处罚编号，未自动重复执行。';
      data.events.push({ action: 'restart-uncertain', at: Date.now(), caseId: data.caseId });
      await store(meta, data); await save(); await refreshAfter(meta, data);
    } else if (data.status === 'publishing') {
      data = clone(data); data.status = 'failed'; data.error = 'Bot重启时发布未完成，请重新创建投票。';
      await store(meta, data); await save(); await refreshAfter(meta, data);
    } else {
      meta.status = data.status;
      if (data.status === 'open') data = await closeIfDue(meta, data);
      if (repaired) await refreshAfter(meta, data);
    }
  }
  function tick() {
    for (const [token, session] of confirmations) if (session.expiresAt < Date.now()) confirmations.delete(token);
    for (const [token, draft] of drafts) if (draft.expiresAt < Date.now()) drafts.delete(token);
    for (const meta of allIndexes()) {
      if (!['open', 'publishing', 'executing'].includes(meta.status) || ticking.has(meta.id)
        || (meta.status === 'open' && Date.now() < meta.endsAt) || Date.now() < (retryAt.get(meta.id) || 0)) continue;
      ticking.add(meta.id);
      void enqueue(meta.id, () => reconcile(meta)).catch(error => {
        retryAt.set(meta.id, Date.now() + 60000);
        logFailure('投票截止或恢复失败；未执行任何自动处罚。', error);
      }).finally(() => ticking.delete(meta.id));
    }
  }
  async function start() {
    if (started) return;
    // Load only unresolved polls. Closed records remain in the designated channel.
    for (const meta of allIndexes().filter(item => ['open', 'publishing', 'executing', 'awaiting', 'uncertain'].includes(item.status))) {
      try { await enqueue(meta.id, async () => { await reconcile(meta); await refreshAfter(meta, await load(meta)); }); }
      catch (error) { retryAt.set(meta.id, Date.now() + 60000); logFailure('投票加密记录恢复失败，此投票停止处理。', error); }
    }
    started = true;
    const timer = setInterval(tick, 5000); timer.unref();
    console.log('匿名名单投票已启动：投票记录仅留存在指定频道，处罚投票通过后仍需管理组确认。');
  }
  return { handle, start };
}

module.exports = { createPolls, pollCommand, pollPanelCommand };
