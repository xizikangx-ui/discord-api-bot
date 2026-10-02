const { randomBytes } = require('node:crypto');
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const DAY = 24 * 60 * 60 * 1000;
const modes = { warning: '仅警告', timeout: '仅禁言', both: '警告并禁言', ban: '永封' };
const statuses = { pending: '等待执行，可解除', preparing: '正在检查执行条件', executing: '正在执行',
  cancelled: '已解除，不执行', completed: '已执行', failed: '检查或保存失败，未执行', uncertain: '执行结果需要人工核对，未自动重试' };
const commands = [
  new SlashCommandBuilder().setName('预约处罚').setDescription('预约24小时后执行处罚，期间可解除').setDefaultMemberPermissions(null)
    .addStringOption(o => o.setName('方式').setDescription('到期执行的处罚方式').setRequired(true)
      .addChoices(...Object.entries(modes).map(([value, name]) => ({ value, name }))))
    .addStringOption(o => o.setName('原因').setDescription('处罚原因').setRequired(true).setMaxLength(400))
    .addUserOption(o => o.setName('成员').setDescription('目标成员，与用户ID二选一'))
    .addStringOption(o => o.setName('user_id').setDescription('目标用户ID或提及，与成员二选一').setMaxLength(32))
    .addIntegerOption(o => o.setName('禁言天数').setDescription('禁言或警告并禁言必填，1到90天').setMinValue(1).setMaxValue(90))
    .addIntegerOption(o => o.setName('警告天数').setDescription('警告保留天数，留空不自动移除').setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder().setName('解除预约处罚').setDescription('按预约编号解除尚未到期的预约处罚').setDefaultMemberPermissions(null)
    .addStringOption(o => o.setName('编号').setDescription('预约卡或预约处罚列表中的编号').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder().setName('预约处罚列表').setDescription('查看本服及互通服务器的预约处罚与最近结果').setDefaultMemberPermissions(null),
];

function createScheduledPunishments(deps) {
  const { client, settingsFor, guildIds, scopeFor, authorized, validate, execute, save, hasCase, targetBusy, logFailure } = deps;
  const confirmations = new Map();
  const locks = new Set();
  let timer;
  let started = false;
  const records = guildId => (settingsFor(guildId).scheduledPunishments ||= []);
  const allRecords = () => guildIds().flatMap(records);
  const sameScope = (a, b) => a.length === b.length && a.every(id => b.includes(id));
  const visible = (job, guildId) => job.scopeGuildIds.includes(guildId);
  const active = job => ['pending', 'preparing', 'executing', 'uncertain'].includes(job.status);
  const clipped = text => String(text).slice(0, 1000);
  function payload(job) {
    const embed = new EmbedBuilder().setTitle('预约处罚通知').setColor(job.status === 'completed' ? 0xED4245 : job.status === 'cancelled' ? 0x57F287 : 0xFEE75C)
      .addFields({ name: '成员', value: `<@${job.userId}> (${job.userId})` },
        { name: '发起人', value: `<@${job.moderatorId}>`, inline: true }, { name: '方式', value: modes[job.mode], inline: true },
        { name: '原因', value: job.reason }, { name: '执行时间', value: `<t:${Math.floor(job.dueAt / 1000)}:F> · <t:${Math.floor(job.dueAt / 1000)}:R>` },
        { name: '状态', value: statuses[job.status] || job.status }, { name: '预约编号', value: job.id });
    if (job.timeoutDays) embed.addFields({ name: '禁言时长', value: `${job.timeoutDays} 天`, inline: true });
    if (['warning', 'both'].includes(job.mode)) embed.addFields({ name: '警告时长', value: job.warningDays ? `${job.warningDays} 天` : '不自动移除', inline: true });
    if (job.cancelledBy) embed.addFields({ name: '解除人', value: `<@${job.cancelledBy}>` });
    if (job.startedAt) embed.addFields({ name: '执行处罚编号', value: job.caseId });
    if (job.result) embed.addFields({ name: '执行结果', value: clipped(job.result) });
    if (job.error) embed.addFields({ name: '详情', value: clipped(job.error) });
    return { embeds: [embed], allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`scheduled-cancel:${job.id}`)
        .setLabel(job.status === 'uncertain' ? '关闭需核对预约（不撤销实际处罚）' : '解除预约处罚').setStyle(ButtonStyle.Secondary)
        .setDisabled(job.status !== 'uncertain' && (job.status !== 'pending' || Date.now() >= job.dueAt)))] };
  }
  async function updateNotice(job) {
    if (!job.noticeMessageId) return;
    try {
      const channel = await client.channels.fetch(job.noticeChannelId);
      const message = await channel.messages.fetch(job.noticeMessageId);
      await message.edit(payload(job));
    } catch (error) {
      if ([10008, 10003].includes(Number(error.code ?? error.rawError?.code))) {
        job.noticeMessageId = null;
        await save();
      } else logFailure('预约处罚通知更新失败。', error);
    }
  }
  async function actor(interaction) {
    if (!interaction.guildId) throw new Error('请在服务器内使用。');
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true, cache: false });
    if (!authorized({ guildId: interaction.guildId, member })) throw new Error('您不具备该权限。');
  }
  function requestFor(interaction) {
    const options = interaction.options;
    const selected = options.getUser('成员');
    const raw = options.getString('user_id')?.trim();
    if (Boolean(selected) === Boolean(raw)) throw new Error('请在“成员”和“user_id”中任选一项填写。');
    const match = raw?.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
    if (raw && !match) throw new Error('请填写17到20位数字用户ID或用户提及。');
    const mode = options.getString('方式', true);
    const timeoutDays = options.getInteger('禁言天数');
    const warningDays = options.getInteger('警告天数');
    const hasTimeout = ['timeout', 'both'].includes(mode);
    const hasWarning = ['warning', 'both'].includes(mode);
    if (!modes[mode]) throw new Error('处罚方式无效。');
    if (hasTimeout && !timeoutDays) throw new Error('禁言或警告并禁言需要填写禁言天数。');
    if (!hasTimeout && timeoutDays) throw new Error('该方式不能填写禁言天数。');
    if (!hasWarning && warningDays) throw new Error('该方式不能填写警告天数。');
    return { guildId: interaction.guildId, userId: selected?.id || match[1] || match[2], mode,
      reason: options.getString('原因', true).trim(), timeoutDays, warningDays };
  }
  function noDuplicate(request, scope) {
    const existing = allRecords().find(job => job.userId === request.userId && active(job)
      && job.scopeGuildIds.some(id => scope.includes(id)));
    if (existing) throw new Error(`该目标已有预约 ${existing.id}（${statuses[existing.status]}），请先处理原预约。`);
  }
  async function cancel(interaction, id) {
    const job = allRecords().find(item => item.id === id && visible(item, interaction.guildId));
    if (!job) throw new Error('找不到此服务器或互通服务器的预约编号。');
    const closingUncertain = job.status === 'uncertain';
    if (locks.has(job.id) || (!closingUncertain && (job.status !== 'pending' || Date.now() >= job.dueAt))) {
      throw new Error(`这笔预约已到期或已处理，当前状态：${statuses[job.status]}。解除预约不能撤销已经执行的处罚。`);
    }
    locks.add(job.id);
    try {
      const previousStatus = job.status;
      job.status = 'cancelled'; job.cancelledBy = interaction.user.id; job.cancelledAt = Date.now();
      try { await save(); }
      catch (error) { job.status = previousStatus; delete job.cancelledBy; delete job.cancelledAt; throw error; }
      await updateNotice(job).catch(error => logFailure('预约解除已保存，公示更新失败。', error));
      await interaction.editReply(closingUncertain
        ? `预约 ${job.id} 已关闭，不会再自动执行。请核对处罚编号 ${job.caseId}；此操作没有撤销任何已实际执行的处罚，撤销请使用 /撤销处罚。`
        : `预约 ${job.id} 已解除，不会自动执行处罚。`);
    } finally { locks.delete(job.id); }
  }
  async function book(interaction, token) {
    const session = confirmations.get(token);
    if (!session || session.guildId !== interaction.guildId || session.moderatorId !== interaction.user.id
      || Date.now() > session.expiresAt) throw new Error('这张预约确认卡已过期，请重新运行 /预约处罚。');
    // Consume before any await so a second click cannot create another appointment.
    confirmations.delete(token);
    const scope = scopeFor(interaction.guildId);
    if (!sameScope(scope, session.scopeGuildIds)) throw new Error('互通服务器配置已改变，请重新发起预约。');
    await validate(interaction, session.request);
    noDuplicate(session.request, scope);
    const now = Date.now();
    const job = { ...session.request, id: randomBytes(8).toString('hex'), caseId: randomBytes(6).toString('hex'),
      moderatorId: interaction.user.id, scopeGuildIds: scope, createdAt: now, dueAt: now + DAY,
      status: 'pending', sourceChannelId: interaction.channelId };
    // Insert synchronously before persistence; concurrent confirmations see this reservation.
    const list = records(job.guildId);
    list.push(job);
    locks.add(job.id);
    try {
      try { await save(); }
      catch (error) { list.splice(list.indexOf(job), 1); throw error; }
      let noticeError = '';
      try {
        const message = await interaction.channel.send(payload(job));
        job.noticeChannelId = message.channelId; job.noticeMessageId = message.id;
        await save();
      } catch (error) { noticeError = '公示卡发送或保存失败，请用 /预约处罚列表 查看并用 /解除预约处罚 解除。'; logFailure('预约已保存，公示卡发送或保存失败。', error); }
      await interaction.editReply({ content: `已预约，编号：${job.id}。24小时内可点击公示卡解除，或使用 /解除预约处罚。\n${noticeError}`, embeds: [payload(job).embeds[0]], components: [] });
    } finally { locks.delete(job.id); }
  }
  async function run(job) {
    if (locks.has(job.id) || job.status !== 'pending' || Date.now() < job.dueAt || targetBusy(job.userId)) return;
    locks.add(job.id);
    job.status = 'preparing';
    let externalStarted = false;
    let executionReturned = false;
    try {
      if (!sameScope(job.scopeGuildIds, scopeFor(job.guildId))) throw new Error('互通服务器配置已改变，预约未执行，请重新预约。');
      const guild = await client.guilds.fetch(job.guildId);
      const member = await guild.members.fetch({ user: job.moderatorId, force: true, cache: false });
      const user = member.user;
      const context = { guild, guildId: guild.id, user, member, channelId: job.sourceChannelId };
      if (!authorized(context)) throw new Error('原发起人已不具备管理组或中层权限，预约未执行。');
      let channel = await guild.channels.fetch(job.sourceChannelId).catch(error => {
        if (Number(error.code ?? error.rawError?.code) === 10003) return null;
        throw error;
      });
      // A temporary channel may have been deleted or archived during the 24-hour wait.
      if (!channel || (channel.isThread() && channel.archived)) channel = await guild.channels.fetch(settingsFor(guild.id).logChannelId);
      context.channel = channel; context.channelId = channel?.id;
      await validate(context, job);
      if (targetBusy(job.userId)) { job.status = 'pending'; return; }
      job.status = 'executing'; job.startedAt = Date.now();
      await save(); // No punishment is sent until the execution marker is durable.
      externalStarted = true;
      job.result = await execute(context, job);
      executionReturned = true;
      job.status = 'completed'; job.finishedAt = Date.now();
      await save();
    } catch (error) {
      // Never retry an ambiguous external action: restarting must not punish twice.
      job.status = externalStarted ? (executionReturned ? 'completed' : 'uncertain') : 'failed';
      job.error = clipped(error.message || error); job.finishedAt = Date.now();
      logFailure(externalStarted ? '预约处罚执行结果需核对。' : '预约处罚执行前检查失败，未执行。', error);
      await save().catch(saveError => logFailure('预约处罚结果保存失败。', saveError));
    } finally {
      locks.delete(job.id);
      if (job.status !== 'pending') await updateNotice(job).catch(error => logFailure('预约处罚状态通知失败。', error));
    }
  }
  function tick() {
    for (const [token, session] of confirmations) if (Date.now() > session.expiresAt) confirmations.delete(token);
    for (const job of allRecords()) {
      if (job.status === 'pending' && Date.now() >= job.dueAt) void run(job).catch(error => logFailure('预约处罚后台任务失败。', error));
    }
  }
  async function start() {
    if (started) return;
    let changed = false;
    const recovered = [];
    for (const job of allRecords()) {
      if (job.status === 'preparing') { job.status = 'pending'; changed = true; }
      if (job.status === 'executing') {
        job.status = 'uncertain';
        job.error = `Bot重启时此预约处于执行阶段${hasCase(job.caseId) ? '，已发现处罚记录' : ''}，请按处罚编号核对；不会自动重复执行。`;
        changed = true; recovered.push(job);
      }
    }
    if (changed) await save();
    started = true;
    for (const job of recovered) await updateNotice(job).catch(error => logFailure('预约处罚恢复通知失败。', error));
    timer = setInterval(tick, 5000); timer.unref();
    tick();
    console.log('预约处罚调度已启动（24小时等待，每5秒检查；执行中断不自动重试）。');
  }
  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && commands.some(item => item.name === interaction.commandName);
    const component = interaction.isButton() && interaction.customId.startsWith('scheduled-');
    if (!command && !component) return false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!started) throw new Error('预约调度未就绪，请检查私密存储连接后重启Bot。');
      await actor(interaction);
      if (component) {
        const [action, token] = interaction.customId.split(':');
        if (action === 'scheduled-book') await book(interaction, token);
        else if (action === 'scheduled-abort') {
          const session = confirmations.get(token);
          if (session?.moderatorId !== interaction.user.id || session.guildId !== interaction.guildId) throw new Error('只能取消自己的预约确认卡。');
          confirmations.delete(token); await interaction.editReply('已取消确认，未创建预约。');
        } else if (action === 'scheduled-cancel') await cancel(interaction, token);
      } else if (interaction.commandName === '解除预约处罚') {
        await cancel(interaction, interaction.options.getString('编号', true).trim());
      } else if (interaction.commandName === '预约处罚列表') {
        const jobs = allRecords().filter(job => visible(job, interaction.guildId));
        const pending = jobs.filter(active).sort((a, b) => a.dueAt - b.dueAt);
        const recent = jobs.filter(job => !active(job)).sort((a, b) => b.createdAt - a.createdAt);
        const selected = [...pending, ...recent].slice(0, 12);
        await interaction.editReply({ content: `当前有效或待核对预约：${pending.length} 笔。显示前12笔（有效预约优先）。`,
          embeds: [new EmbedBuilder().setTitle('预约处罚列表').setDescription(selected.map(job =>
            `\`${job.id}\` · <@${job.userId}> · ${modes[job.mode]}\n${statuses[job.status]} · <t:${Math.floor(job.dueAt / 1000)}:F>`).join('\n\n') || '没有预约。')], allowedMentions: { parse: [] } });
      } else {
        const request = requestFor(interaction);
        if (!request.reason) throw new Error('请填写处罚原因。');
        const scope = scopeFor(interaction.guildId);
        noDuplicate(request, scope);
        await validate(interaction, request);
        const token = randomBytes(8).toString('hex');
        confirmations.set(token, { request, moderatorId: interaction.user.id, guildId: interaction.guildId,
          scopeGuildIds: scope, expiresAt: Date.now() + 60000 });
        const preview = { ...request, id: '确认后生成', moderatorId: interaction.user.id, dueAt: Date.now() + DAY, status: 'pending' };
        await interaction.editReply({ content: '请确认：点击后开始24小时等待，不会立即处罚。此确认卡1分钟内有效；到期按当时成员所在服务器执行，永封仍按ID双服执行。',
          embeds: [payload(preview).embeds[0]], allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`scheduled-book:${token}`).setLabel('确认预约24小时后处罚').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`scheduled-abort:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary))] });
      }
    } catch (error) {
      logFailure('预约处罚操作未完成。', error);
      await interaction.editReply({ content: clipped(error.message || error), embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
    }
    return true;
  }
  return { handle, start };
}

module.exports = { createScheduledPunishments, scheduledPunishmentCommands: commands };
