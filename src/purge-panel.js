const { randomBytes } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, Routes,
} = require('discord.js');

const purgeCommand = new SlashCommandBuilder().setName('冲水面板')
  .setDescription('按用户清理全服或指定频道消息，配置操作身份组和豁免频道').setDefaultMemberPermissions(null);
const selectableTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
  ChannelType.GuildMedia, ChannelType.GuildCategory, ChannelType.GuildVoice, ChannelType.GuildStageVoice,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
const row = (...items) => new ActionRowBuilder().addComponents(...items);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const hasRole = (member, id) => Boolean(id && (member?.roles?.cache?.has(id)
  || (Array.isArray(member?.roles) && member.roles.includes(id))));
const active = new Set(['discovering', 'running', 'pausing']);
const statusText = { discovering: '正在查找频道和帖子', running: '正在清理', pausing: '正在停止', paused: '已暂停',
  completed: '扫描完成', failed: '任务未完成' };
const snowflakeAt = (time) => (BigInt(time - 1420070400000) << 22n).toString();
const channelList = (ids) => ids.slice(0, 20).map((id) => `<#${id}>`).join('、')
  + (ids.length > 20 ? ` 等 ${ids.length} 个位置` : '') || '无';

function createPurgePanel({ client, settingsFor, save, logFailure, protectedChannelIds = [] }) {
  const sessions = new Map();
  const confirmations = new Map();
  const running = new Map();
  const mutations = new Set();

  function state(guildId) {
    const setting = settingsFor(guildId);
    setting.purgePolicy ||= { operatorRoleIds: [], exemptChannelIds: [] };
    setting.purgeJobs ||= [];
    return { config: setting.purgePolicy, jobs: setting.purgeJobs };
  }
  function canConfigure(member, guildId) {
    return member.permissions.has(PermissionFlagsBits.Administrator)
      || hasRole(member, settingsFor(guildId).managementRoleId);
  }
  async function access(interaction, configure = false) {
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (configure ? !canConfigure(member, interaction.guildId)
      : !state(interaction.guildId).config.operatorRoleIds.some((id) => hasRole(member, id))) {
      throw new Error(configure ? '只有主管理组或 ADMIN 可以配置冲水面板。'
        : '您不具备冲水权限，请先在面板配置并持有操作身份组；ADMIN 也需持有指定组。');
    }
    return member;
  }
  function sessionFor(interaction, token) {
    const session = sessions.get(token);
    if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id
      || Date.now() > session.expiresAt) throw new Error('面板已过期，请重新运行 /冲水面板。');
    return session;
  }
  function latestJob(guildId) {
    const jobs = state(guildId).jobs;
    return jobs.find((job) => active.has(job.status)) || jobs.reduce((latest, job) =>
      !latest || (job.updatedAt || job.startedAt) > (latest.updatedAt || latest.startedAt) ? job : latest, null);
  }
  function jobEmbed(job) {
    const embed = new EmbedBuilder().setTitle(`冲水任务 ${job.id}${job.status === 'completed' && (job.issueCount || job.failedMessages) ? '（部分位置/消息未清理，见明细）' : ''}`)
      .setColor(job.status === 'completed' && !job.issueCount && !job.failedMessages ? 0x2ECC71 : 0xE67E22)
      .setDescription(`目标：<@${job.targetId}> (${job.targetId})\n操作人：<@${job.operatorId}>\n状态：${statusText[job.status]}\n范围：${job.mode === 'all' ? '全服' : channelList(job.selectedChannelIds)}\n删除首楼：${job.includeStarter ? '是（仅删除首楼消息）' : '否'}\n已处理位置：${job.index}/${job.channels.length}\n当前扫描：${job.channels[job.index] ? `<#${job.channels[job.index]}>` : '无'}\n已读取：${job.scanned} 条\n已删除：${job.deleted} 条\n已不存在：${job.missing} 条\n保留首楼/系统消息：${job.preserved} 条\n删除失败：${job.failedMessages} 条\n跳过位置：${job.skippedChannels} 个\n枚举/读取问题：${job.issueCount} 次${job.failure ? `\n暂停说明：${job.failure}` : ''}`)
      .setFooter({ text: '仅匹配消息作者 ID，不删除或编辑任何频道、帖子；记录不含正文或图片' }).setTimestamp(job.updatedAt || job.startedAt);
    if (job.issues.length) embed.addFields({ name: '问题明细（前 5 条）', value: job.issues.slice(0, 5)
      .map((item) => `${item.channelId ? `<#${item.channelId}> ` : ''}${item.stage}：${item.code || ''} ${item.message}`).join('\n').slice(0, 1024) });
    return embed;
  }
  function payload(session, configure = false) {
    const { config } = state(session.guildId);
    const embed = new EmbedBuilder().setTitle(configure ? '冲水权限与豁免配置' : '按成员清理消息').setColor(0xE67E22)
      .setDescription(`操作身份组：${config.operatorRoleIds.map((id) => `<@&${id}>`).join('、') || '未设置'}\n豁免频道/论坛/分类：${channelList(config.exemptChannelIds)}\n\n${configure ? '选择操作身份组后保存。豁免选择器可添加或移除多个位置，论坛和分类的下属帖子、频道继承豁免。'
        : `目标：${session.targetId ? `<@${session.targetId}> (${session.targetId})` : '未选择'}\n手动范围：${channelList(session.selectedChannelIds)}\n删除首楼：${session.includeStarter ? '是' : '否'}\n\n全服冲水包含可读取频道、子区及归档帖子；手动冲水仅清理所选位置及其下属子区。两种方式都遵守豁免。`}`)
      .addFields({ name: '删除规则', value: '只删目标用户自己发送的消息，包括附带图片。保留其他作者、Bot 代发和系统消息。默认保留首楼；开启后仅删除可独立删除的首楼消息。不会删除、解锁或重新开放帖子。扫描任务开始前的历史消息，期间新发言不在本次范围内。' });
    const channels = (id, hint) => new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(hint)
      .setMinValues(1).setMaxValues(25).setChannelTypes(...selectableTypes);
    const components = configure ? [
      row(new RoleSelectMenuBuilder().setCustomId(`purgecfg-roles:${session.token}`).setPlaceholder('设置操作身份组（最多 10 个，可清空）').setMinValues(0).setMaxValues(10)),
      row(channels(`purgecfg-add:${session.token}`, '添加豁免频道、论坛、分类或帖子（可多次添加）')),
      row(channels(`purgecfg-remove:${session.token}`, '移除指定豁免（不清空其他豁免）')),
      row(button(`purge-back:${session.token}`, '返回冲水面板', ButtonStyle.Primary)),
    ] : [
      row(new UserSelectMenuBuilder().setCustomId(`purge-target:${session.token}`).setPlaceholder('选择要清理消息的成员')),
      row(channels(`purge-scope-add:${session.token}`, '添加手动范围：频道/论坛/分类/帖子（可分批添加）')),
      row(channels(`purge-scope-remove:${session.token}`, '移除某些手动范围（保留其他所选范围）')),
      row(button(`purge-id:${session.token}`, '填写用户 ID'), button(`purge-starter:${session.token}`, session.includeStarter ? '首楼：删除' : '首楼：保留'),
        button(`purge-config:${session.token}`, '权限和豁免配置'), button(`purge-status:${session.token}`, '查看任务/刷新进度')),
      row(button(`purge-all:${session.token}`, '全服冲水', ButtonStyle.Danger), button(`purge-manual:${session.token}`, '手动范围冲水', ButtonStyle.Danger),
        button(`purge-pause:${session.token}`, '停止当前任务'), button(`purge-resume:${session.token}`, '继续未完成任务')),
    ];
    return { content: null, embeds: [embed], components, allowedMentions: { parse: [] } };
  }
  function relatedIds(channel, guild) {
    const ids = [channel.id];
    let parentId = channel.parentId;
    const seen = new Set(ids);
    while (parentId && !seen.has(parentId)) {
      ids.push(parentId); seen.add(parentId);
      parentId = guild.channels.cache.get(parentId)?.parentId;
    }
    return ids;
  }
  function exempt(channel, guild, job) {
    const ids = new Set([...protectedChannelIds, ...job.exemptChannelIds, ...state(guild.id).config.exemptChannelIds]);
    return relatedIds(channel, guild).some((id) => ids.has(id));
  }
  function inScope(channel, guild, job) {
    return !exempt(channel, guild, job) && (job.mode === 'all'
      || relatedIds(channel, guild).some((id) => job.selectedChannelIds.includes(id)));
  }
  function issue(job, channelId, stage, error) {
    job.issueCount++;
    if (job.issues.length < 100) job.issues.push({ channelId, stage, code: error?.code || null,
      message: String(error?.message || error).slice(0, 180) });
  }
  async function checkpoint(job) {
    job.updatedAt = Date.now();
    try { await save(); } catch (error) { error.purgePersistenceFailure = true; throw error; }
  }
  function halted(job) { return job.status === 'pausing' || job.status === 'paused'; }

  async function discover(guild, job) {
    job.status = 'discovering'; job.channels = []; job.index = 0;
    await checkpoint(job);
    const channels = await guild.channels.fetch();
    const me = await guild.members.fetchMe();
    const found = new Set();
    const add = (channel) => {
      if (channel?.messages && inScope(channel, guild, job)) found.add(channel.id);
    };
    for (const channel of channels.values()) add(channel);
    try { const threads = await guild.channels.fetchActiveThreads(); for (const thread of threads.threads.values()) add(thread); }
    catch (error) { issue(job, null, '活动帖子枚举', error); }
    // Explicit thread selections include threads absent from the active lists.
    for (const id of job.selectedChannelIds) {
      if (halted(job)) return;
      try { add(await guild.channels.fetch(id)); } catch (error) { issue(job, id, '手动范围读取', error); }
    }
    for (const parent of channels.values()) {
      if (halted(job)) return;
      if (!parent?.threads || exempt(parent, guild, job)) continue;
      const directScope = inScope(parent, guild, job);
      // When only a particular thread is selected, there is no need to enumerate
      // every sibling thread. Forum/category selections include all descendants.
      if (!directScope) continue;
      const perms = parent.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        issue(job, parent.id, '帖子枚举', new Error('缺少查看频道/读取历史权限')); continue;
      }
      const types = ['public'];
      if (parent.type === ChannelType.GuildText) types.push('private');
      for (const type of types) {
        let before;
        const fetchAll = type === 'private' && perms.has(PermissionFlagsBits.ManageThreads);
        try {
          do {
            if (halted(job)) return;
            const result = await parent.threads.fetchArchived({ type, fetchAll, limit: 100, ...(before ? { before } : {}) });
            for (const thread of result.threads.values()) add(thread);
            job.discovered = found.size;
            await checkpoint(job);
            if (!result.hasMore) break;
            const values = [...result.threads.values()];
            const next = type === 'private' && !fetchAll
              ? values.reduce((id, t) => !id || BigInt(t.id) < BigInt(id) ? t.id : id, null)
              : values.map((t) => t.archiveTimestamp).filter(Number.isFinite).sort((a, b) => a - b)[0];
            if (!next || String(next) === String(before)) throw new Error('归档分页游标未推进，枚举未完成');
            before = type === 'private' && !fetchAll ? next : new Date(next).toISOString();
          } while (true);
          if (type === 'private' && !fetchAll) issue(job, parent.id, '私密帖子覆盖', new Error('无管理帖子权限，仅可枚举 Bot 已加入的归档私密帖子'));
        } catch (error) {
          if (error.purgePersistenceFailure) throw error;
          issue(job, parent.id, `${type}归档帖子枚举`, error);
        }
      }
    }
    if (halted(job)) return;
    job.channels = [...found]; job.planned = true; job.discovered = found.size; job.status = 'running';
    await checkpoint(job);
  }

  async function deletePage(guild, channel, messages, job) {
    const candidates = [];
    for (const message of messages.values()) {
      // Never infer authorship from a quote, forwarding snapshot, slash caller,
      // attachment URL or webhook name. Only the actual author field counts.
      if (message.author?.id !== job.targetId || message.webhookId || message.author.bot) continue;
      const starter = channel.isThread() ? message.id === channel.id
        : message.hasThread || guild.channels.cache.get(message.id)?.isThread();
      const exemptIds = new Set([...protectedChannelIds, ...job.exemptChannelIds, ...state(guild.id).config.exemptChannelIds]);
      // A text-thread's original message lives in the parent channel. Exempting
      // that thread also protects its original message in the parent history.
      if (starter && exemptIds.has(message.id)) { job.preserved++; continue; }
      if (message.system || (!job.includeStarter && starter)) { job.preserved++; continue; }
      if (!message.deletable) { job.failedMessages++; issue(job, channel.id, '消息不可删除', new Error(`消息 ${message.id}`)); continue; }
      candidates.push(message);
    }
    const reason = `冲水任务 ${job.id}；目标 ${job.targetId}；操作人 ${job.currentOperatorId || job.operatorId}`;
    const recent = candidates.filter((m) => Date.now() - m.createdTimestamp < 14 * 86400000 - 60000);
    const recentIds = new Set(recent.map((m) => m.id));
    const singles = candidates.filter((m) => !recentIds.has(m.id));
    if (recent.length > 1 && !halted(job) && inScope(channel, guild, job)) {
      try {
        await client.rest.post(Routes.channelBulkDelete(channel.id), { body: { messages: recent.map((m) => m.id) }, reason });
        job.deleted += recent.length;
      } catch (error) {
        // Fall back to individual DELETEs, still using the exact author-filtered
        // IDs. A bulk failure must never trigger deletion by numeric count.
        issue(job, channel.id, '批量删除转逐条删除', error); singles.push(...recent);
      }
    } else singles.push(...recent);
    for (const message of singles) {
      if (halted(job) || !inScope(channel, guild, job)) return false;
      try { await client.rest.delete(Routes.channelMessage(channel.id, message.id), { reason }); job.deleted++; }
      catch (error) {
        if (Number(error.code) === 10008) { job.missing++; continue; }
        job.failedMessages++; issue(job, channel.id, `删除消息 ${message.id}`, error);
        if ([50001, 50013, 50083, 10003].includes(Number(error.code))) throw error;
      }
    }
    return !halted(job);
  }
  async function run(guild, job) {
    try {
      if (!job.planned) await discover(guild, job);
      if (halted(job)) { job.status = 'paused'; await checkpoint(job); return; }
      job.status = 'running'; await checkpoint(job);
      while (job.index < job.channels.length) {
        if (halted(job)) break;
        const id = job.channels[job.index];
        let channel;
        try {
          channel = await guild.channels.fetch(id, { force: true });
          if (channel?.parentId && !guild.channels.cache.has(channel.parentId)) await guild.channels.fetch(channel.parentId);
          const me = await guild.members.fetchMe();
          if (!channel?.messages || !inScope(channel, guild, job)
            || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages])) {
            job.skippedChannels++;
            if (channel && inScope(channel, guild, job)) issue(job, id, '频道跳过', new Error('Bot 缺少查看、读取历史或管理消息权限'));
          } else {
            while (!halted(job) && inScope(channel, guild, job)) {
              const page = await channel.messages.fetch({ limit: 100, before: job.cursor || job.upperBound, cache: false });
              if (!page.size) break;
              // Persist the last completed page before beginning irreversible work.
              await checkpoint(job);
              if (!await deletePage(guild, channel, page, job)) break;
              job.scanned += page.size;
              const next = [...page.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
              if (next === job.cursor) throw new Error('消息分页游标未推进');
              job.cursor = next;
              await checkpoint(job);
              if (page.size < 100) break;
            }
          }
        } catch (error) {
          // Failure to persist must stop, never continue deleting with stale state.
          if (error.purgePersistenceFailure || !error.code) throw error;
          job.skippedChannels++; issue(job, id, '频道扫描未完成', error);
        }
        if (halted(job)) break;
        job.index++; job.cursor = null; await checkpoint(job);
      }
      job.status = halted(job) ? 'paused' : 'completed';
      if (job.status === 'completed') job.finishedAt = Date.now();
      await checkpoint(job);
    } catch (error) {
      job.status = 'failed'; job.failure = String(error.message).slice(0, 200);
      await checkpoint(job).catch((failure) => logFailure('冲水任务停止状态保存失败。', failure));
      logFailure(`冲水任务 ${job.id} 已停止。`, error);
    }
  }
  function launch(guild, job) {
    const work = run(guild, job);
    running.set(guild.id, work);
    void work.finally(() => { if (running.get(guild.id) === work) running.delete(guild.id); });
  }
  async function start() {
    let changed = false;
    for (const guild of client.guilds.cache.values()) {
      for (const job of state(guild.id).jobs) if (active.has(job.status)) {
        job.status = 'paused'; job.failure = '部署重启后已暂停；请有操作身份组者重新确认继续。'; changed = true;
      }
    }
    if (changed) await save();
  }
  function confirmPayload(session, request) {
    const job = request.resumeId && state(session.guildId).jobs.find((item) => item.id === request.resumeId);
    return { content: null, embeds: [new EmbedBuilder().setTitle('确认删除该用户的消息？').setColor(0xE74C3C)
      .setDescription(`目标：<@${request.targetId}> (${request.targetId})\n范围：${request.mode === 'all' ? '全服可读取位置' : channelList(request.selectedChannelIds)}\n豁免：${channelList(request.exemptChannelIds)}\n删除首楼：${request.includeStarter ? '是，仅删除首楼消息，不删除帖子' : '否，保留首楼'}\n\n仅删除这个人直接发送的消息，包括图片。其他人、Bot 代发消息和系统消息保留。删除无法恢复。${job ? `\n继续任务：${job.id}，保留原扫描时间范围及进度。` : '\n扫描本次确认开始前的历史消息；历史较多时会持续运行。'}\n\n确认 1 分钟内有效；可在面板查看进度和停止。`)],
    components: [row(button(`purge-confirm:${session.token}:${request.id}`, '确认冲水', ButtonStyle.Danger),
      button(`purge-back:${session.token}`, '取消'))], allowedMentions: { parse: [] } };
  }
  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && interaction.commandName === '冲水面板';
    if (!command && !(interaction.customId || '').startsWith('purge')) return false;
    let mutationKey;
    try {
      if (!interaction.inGuild()) throw new Error('只能在服务器中使用。');
      if (command) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        const config = state(interaction.guildId).config;
        if (!canConfigure(member, interaction.guildId) && !config.operatorRoleIds.some((id) => hasRole(member, id))) throw new Error('您不具备使用权限。');
        for (const [id, session] of sessions) if (Date.now() > session.expiresAt) sessions.delete(id);
        for (const [id, request] of confirmations) if (Date.now() > request.expiresAt) confirmations.delete(id);
        const session = { token: randomBytes(8).toString('hex'), guildId: interaction.guildId, userId: interaction.user.id,
          selectedChannelIds: [], includeStarter: false, expiresAt: Date.now() + 30 * 60 * 1000 };
        sessions.set(session.token, session);
        await interaction.editReply(payload(session, !config.operatorRoleIds.length && canConfigure(member, interaction.guildId))); return true;
      }
      const [action, token, requestId] = interaction.customId.split(':');
      const session = sessionFor(interaction, token);
      if (action === 'purge-id' && interaction.isButton()) {
        await interaction.showModal(new ModalBuilder().setCustomId(`purge-idform:${token}`).setTitle('填写目标用户 ID（支持离服成员）')
          .addComponents(new LabelBuilder().setLabel('Discord 数字用户 ID').setTextInputComponent(new TextInputBuilder()
            .setCustomId('userId').setStyle(TextInputStyle.Short).setMinLength(17).setMaxLength(20).setRequired(true)))); return true;
      }
      if (interaction.isModalSubmit()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else await interaction.deferUpdate();
      if (action.startsWith('purgecfg-')) {
        await access(interaction, true);
        mutationKey = `config:${interaction.guildId}`;
        if (mutations.has(mutationKey)) { mutationKey = null; throw new Error('配置正在保存，请稍后重试。'); }
        mutations.add(mutationKey);
        const config = state(interaction.guildId).config;
        const previous = JSON.parse(JSON.stringify(config));
        if (action === 'purgecfg-roles') {
          const ids = [...new Set(interaction.values)];
          if (ids.length > 10 || ids.includes(interaction.guildId)) throw new Error('最多 10 个操作身份组，不能选择 @everyone。');
          config.operatorRoleIds = ids;
        } else {
          if (!['purgecfg-add', 'purgecfg-remove'].includes(action)) throw new Error('未知配置操作。');
          for (const id of interaction.values) {
            const channel = await interaction.guild.channels.fetch(id);
            if (!channel || !selectableTypes.includes(channel.type)) throw new Error('请选择本服务器的频道、分类或帖子。');
          }
          config.exemptChannelIds = action === 'purgecfg-add' ? [...new Set([...config.exemptChannelIds, ...interaction.values])]
            : config.exemptChannelIds.filter((id) => !interaction.values.includes(id));
        }
        try { await save(); } catch (error) { Object.assign(config, previous); throw error; }
        await interaction.editReply(payload(session, true)); return true;
      }
      if (action === 'purge-config') { await access(interaction, true); await interaction.editReply(payload(session, true)); return true; }
      if (action === 'purge-back') {
        for (const [id, request] of confirmations) if (request.token === token) confirmations.delete(id);
        await interaction.editReply(payload(session)); return true;
      }
      await access(interaction);
      if (action === 'purge-target') session.targetId = interaction.values[0];
      else if (action === 'purge-idform') {
        const id = interaction.fields.getTextInputValue('userId').trim();
        if (!/^[0-9]{17,20}$/.test(id)) throw new Error('请输入有效数字用户 ID。');
        const user = await client.users.fetch(id);
        if (user.bot) throw new Error('冲水面板只操作真人账号。');
        session.targetId = id;
      } else if (action === 'purge-scope-add' || action === 'purge-scope-remove') {
        for (const id of interaction.values) {
          const channel = await interaction.guild.channels.fetch(id);
          if (!channel || !selectableTypes.includes(channel.type)) throw new Error('请选择有效频道或帖子。');
        }
        session.selectedChannelIds = action === 'purge-scope-add' ? [...new Set([...session.selectedChannelIds, ...interaction.values])]
          : session.selectedChannelIds.filter((id) => !interaction.values.includes(id));
      } else if (action === 'purge-starter') session.includeStarter = !session.includeStarter;
      else if (action === 'purge-status') {
        const job = latestJob(interaction.guildId);
        await interaction.editReply(job ? { ...payload(session), embeds: [jobEmbed(job)] } : { ...payload(session), content: '还没有冲水任务。' }); return true;
      } else if (action === 'purge-pause') {
        const job = latestJob(interaction.guildId);
        if (!job || !active.has(job.status)) throw new Error('没有运行中的任务。');
        job.status = 'pausing'; await checkpoint(job);
        await interaction.editReply({ ...payload(session), content: '已请求停止；当前已发送的删除请求可能仍会完成。', embeds: [jobEmbed(job)] }); return true;
      } else if (['purge-all', 'purge-manual', 'purge-resume'].includes(action)) {
        if (running.has(interaction.guildId) || state(interaction.guildId).jobs.some((job) => active.has(job.status))) throw new Error('本服务器有任务正在运行，请先停止或等待完成。');
        const old = action === 'purge-resume' ? [...state(interaction.guildId).jobs].reverse()
          .find((job) => ['paused', 'failed'].includes(job.status)) : null;
        if (action === 'purge-resume' && (!old || !['paused', 'failed'].includes(old.status))) throw new Error('没有可继续的未完成任务。');
        const targetId = old?.targetId || session.targetId;
        if (!targetId) throw new Error('请先选择目标成员或填写用户 ID。');
        if ((await client.users.fetch(targetId)).bot) throw new Error('冲水面板只操作真人账号。');
        const selectedChannelIds = old?.selectedChannelIds || [...session.selectedChannelIds];
        const mode = old?.mode || (action === 'purge-all' ? 'all' : 'manual');
        if (mode === 'manual' && !selectedChannelIds.length) throw new Error('手动冲水请先选择范围。');
        const request = { id: randomBytes(8).toString('hex'), token, targetId, mode, selectedChannelIds,
          includeStarter: old?.includeStarter ?? session.includeStarter,
          exemptChannelIds: [...new Set([...(old?.exemptChannelIds || []), ...state(interaction.guildId).config.exemptChannelIds])],
          resumeId: old?.id, expiresAt: Date.now() + 60000 };
        confirmations.set(request.id, request);
        await interaction.editReply(confirmPayload(session, request)); return true;
      } else if (action === 'purge-confirm') {
        mutationKey = `launch:${interaction.guildId}`;
        if (mutations.has(mutationKey)) { mutationKey = null; throw new Error('任务正在启动，请勿重复确认。'); }
        mutations.add(mutationKey);
        const request = confirmations.get(requestId);
        if (!request || request.token !== token || Date.now() > request.expiresAt) throw new Error('确认已过期或已经使用，请重新发起。');
        if (running.has(interaction.guildId) || state(interaction.guildId).jobs.some((job) => active.has(job.status))) throw new Error('本服务器已有运行中的任务。');
        confirmations.delete(requestId);
        const jobs = state(interaction.guildId).jobs;
        const job = request.resumeId ? jobs.find((item) => item.id === request.resumeId) : {
          id: randomBytes(8).toString('hex'), targetId: request.targetId, mode: request.mode,
          selectedChannelIds: request.selectedChannelIds, exemptChannelIds: request.exemptChannelIds,
          includeStarter: request.includeStarter, startedAt: Date.now(), upperBound: snowflakeAt(Date.now()),
          channels: [], index: 0, cursor: null, scanned: 0, deleted: 0, missing: 0, preserved: 0,
          failedMessages: 0, skippedChannels: 0, issueCount: 0, issues: [], planned: false,
        };
        if (!job || (request.resumeId && !['paused', 'failed'].includes(job.status))) throw new Error('任务已处理，请刷新。');
        const previous = JSON.parse(JSON.stringify(job));
        if (!request.resumeId) jobs.push(job);
        job.status = job.planned ? 'running' : 'discovering';
        job.operatorId ||= interaction.user.id;
        if (request.resumeId) { job.resumptions ||= []; job.resumptions.push({ userId: interaction.user.id, resumedAt: Date.now() }); }
        job.currentOperatorId = interaction.user.id;
        job.exemptChannelIds = request.exemptChannelIds; delete job.failure;
        try { await checkpoint(job); } catch (error) {
          if (request.resumeId) Object.assign(job, previous); else jobs.splice(jobs.indexOf(job), 1); throw error;
        }
        launch(interaction.guild, job);
        await interaction.editReply({ ...payload(session), content: '冲水任务已启动。可随时重新打开面板查看进度或停止。', embeds: [jobEmbed(job)] }); return true;
      } else throw new Error('未知冲水操作。');
      await interaction.editReply(payload(session));
    } catch (error) {
      logFailure('冲水面板操作未完成。', error);
      const reply = { content: `操作未完成：${error.message}`, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    } finally { if (mutationKey) mutations.delete(mutationKey); }
    return true;
  }
  return { handle, start };
}

module.exports = { createPurgePanel, purgeCommand };
