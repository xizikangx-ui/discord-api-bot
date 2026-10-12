'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, MessageFlags, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const key = 'managementAnnouncementExemptUserIds';
const versionKey = 'managementAnnouncementExemptionVersion';
const ids = setting => Array.isArray(setting[key]) ? setting[key] : [];
function isExempt(setting, operatorId) { return !!operatorId && ids(setting).includes(operatorId); }
function usesAudit(setting) { return ids(setting).length > 0; }
function button(guildId) {
  return new ButtonBuilder().setCustomId('notice-exempt:open:' + guildId).setLabel('通告豁免').setStyle(ButtonStyle.Secondary);
}
function panel(guild, setting) {
  const current = ids(setting), version = setting[versionKey] || 0;
  const select = new UserSelectMenuBuilder().setCustomId('notice-exempt:users:' + guild.id + ':' + version)
    .setPlaceholder('选择不记录身份组变更通告的操作者（可清空）').setMinValues(0).setMaxValues(25);
  if (current.length) select.setDefaultUsers(current);
  return { content: '通告豁免（按操作者）\n' + (current.length ? current.map(id => '<@' + id + '>').join('、') : '尚未设置') +
    '\n所选操作者修改身份组时，不发送 Bot 的任免公示或权限变更通告。其他人的操作照常公示。实际身份组、当前名单、任期及权限恢复／处罚规则仍正常运行。Discord 原生审计日志不受此设置影响。\n选择后直接保存，最多 25 人；Bot 需有“查看审计日志”权限以核实操作者。',
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('notice-exempt:clear:' + guild.id + ':' + version).setLabel('清空豁免').setStyle(ButtonStyle.Secondary).setDisabled(!current.length),
      button(guild.id).setLabel('刷新设置'))], allowedMentions: { parse: [] } };
}
function createExemptions({ client, settingsFor, save, logFailure }) {
  const busy = new Set();
  async function handle(i) {
    if (!i.customId?.startsWith('notice-exempt:')) return false;
    const [, action, guildId, version] = i.customId.split(':');
    if (!i.inGuild() || guildId !== i.guildId || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || i.message?.author?.id !== client.user.id) {
      await i.reply({ content: '需要本服务器的“管理服务器”权限才能设置通告豁免。', flags: MessageFlags.Ephemeral });return true;
    }
    if (action === 'open' && i.isButton()) {
      const body = panel(i.guild, settingsFor(guildId));
      if (i.message.flags?.has(MessageFlags.Ephemeral)) await i.update(body);
      else await i.reply({ ...body, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!(action === 'clear' && i.isButton() || action === 'users' && i.isUserSelectMenu())) return true;
    if (busy.has(guildId)) {
      await i.reply({ content: '通告豁免设置正在保存，请稍后刷新。', flags: MessageFlags.Ephemeral });return true;
    }
    busy.add(guildId);
    try {
      await i.deferUpdate();
      const setting = settingsFor(guildId);
      if (String(setting[versionKey] || 0) !== version) throw new Error('豁免设置已被其他管理员修改，请刷新后重新选择。');
      const values = action === 'clear' ? [] : [...new Set(i.values)];
      if (values.length > 25) throw new Error('通告豁免最多选择 25 位操作者。');
      for (const id of values) {
        const selected = await i.guild.members.fetch({ user: id, force: true, cache: false });
        if (!selected) throw new Error('请选择仍在本服务器的操作者。');
      }
      const member = await i.guild.members.fetch({ user: i.user.id, force: true, cache: false });
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('你已失去“管理服务器”权限，设置未保存。');
      if (values.length) {
        const bot = await i.guild.members.fetchMe({ force: true });
        if (!bot.permissions.has(PermissionFlagsBits.ViewAuditLog)) throw new Error('Bot 需要“查看审计日志”权限才能按操作者豁免；设置未保存。');
      }
      const previous = setting[key], previousVersion = setting[versionKey];
      setting[key] = values;setting[versionKey] = (setting[versionKey] || 0) + 1;
      try { await save(); } catch (e) { setting[key] = previous;setting[versionKey] = previousVersion;throw e; }
      await i.editReply(panel(i.guild, setting));
    } catch (e) {
      logFailure('通告豁免设置未完成。', e);
      const reply = { content: e.message || '设置未保存，请刷新后重试。', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
      if (i.deferred || i.replied) await i.followUp(reply);else await i.reply(reply);
    } finally { busy.delete(guildId); }
    return true;
  }
  return { handle };
}
// Audit entries carry the real executor and exact changed roles. No timing-based
// attribution, member-cache assumptions or audit polling is used.
function createAuditPublisher({ client, settingsFor, tracks, announce, reconcile, formatTenure, logFailure }) {
  async function handle(entry, guild) {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate) return false;
    const setting = settingsFor(guild.id);
    if (!usesAudit(setting)) return false;
    if (isExempt(setting, entry.executorId)) return true;
    // Manual panel actions already publish with the initiating human identity.
    if (entry.executorId === client.user.id && /^管理组(?:任命|卸任)：/.test(entry.reason || '')) return true;
    const affected = [];
    for (const change of entry.changes || []) {
      if (!['$add', '$remove'].includes(change.key)) continue;
      const roles = change.new || change.old || [];
      for (const role of Array.isArray(roles) ? roles : [])
        for (const [tier, roleId, track] of tracks(setting))
          if (track.roleId === role.id) affected.push({ tier, roleId, track, action: change.key === '$add' ? '任命' : '卸任' });
    }
    if (!affected.length) return true;
    if (!entry.executorId || !entry.targetId) {
      logFailure('任免审计缺少操作者或目标，未推测归属或发布通告。', { code: 'AUDIT_IDENTITY_MISSING' });return true;
    }
    const member = await guild.members.fetch({ user: entry.targetId, force: true, cache: false }).catch(e => {
      if (Number(e.code) === 10007) return { id: entry.targetId, guild, user: entry.target?.user || entry.target || {} };
      throw e;
    });
    if (member.user?.bot) return true;
    const at = entry.createdTimestamp || Date.now();
    for (const { tier, roleId, track, action } of affected) {
      // Persist the current roster before scheduling publication. Gateway audit
      // and member events may arrive in either order, including for uncached users.
      if (reconcile) await reconcile(member, !!member.roles?.cache?.has(track.roleId), tier, roleId);
      const term = [...track.terms].reverse().find(t => t.userId === member.id && (!t.startedAt || t.startedAt <= at));
      await announce(guild, { action, tier, roleId, records: [{ member, tenure: term?.startedAt ? formatTenure(Math.max(0, at - term.startedAt)) : '任命时间未记录' }], moderator: { id: entry.executorId }, startedAt: at, endedAt: at, showReason: false });
    }
    return true;
  }
  return { handle };
}
module.exports = { button, panel, isExempt, usesAudit, createExemptions, createAuditPublisher };
