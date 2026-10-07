'use strict';
const C = require('./constants'), A = require('./activities'), U = require('./ui');
const { requireThat: ok, clone } = C;
const { row, button, select, payload, modal, D, field } = U;
const jump = (guild, record) => 'https://discord.com/channels/' + guild + '/' + record.channelId + '/' + record.messageId;
const stateLabel = status => ({ open: '报名中', closed: '报名关闭', notified: '已提醒', overdue: '提醒过时', cancelled: '已取消' }[status] || status);
function checkView(c) {
  const results = Object.values(c.attempts).flat(), successes = results.filter(r => r.success).length;
  const result = payload('鉴定 · ' + c.name, c.description || '点击参与，按公开规则完成鉴定。', [
    row(button('activity:check:roll:' + c.id, '参与鉴定', D.ButtonStyle.Primary, c.status !== 'open'),
      button('activity:check:results:' + c.id + ':0', '查看结果'), button('activity:check:manage:' + c.id, 'GM管理'))
  ], c.status === 'open' ? 0x9b59b6 : 0x95a5a6);
  result.embeds[0].addFields(field('判定规则', c.rule === 'd20' ? '1d20' + (c.skillId?'＋'+c.skillName+'等级':c.attribute !== 'none' ? '＋有效' + C.ATTRIBUTES[c.attribute] : '') + ' ≥ ' + c.threshold :
    '1d100 ≤ ' + c.threshold, true), field('每人次数', c.maxAttempts, true), field('进度', Object.keys(c.attempts).length + '人参与 / ' + successes + '人通过', true),
    field('状态 / 发布GM', (c.status === 'open' ? '开放中' : '已结束') + ' / <@' + c.owner + '>'));
  result.embeds[0].setFooter({ text: '鉴定 ' + c.id + ' · 玩家身份组＋有效角色卡' }); return result;
}
function attemptView(c, a) {
  const result = payload('鉴定结果 · ' + c.name, '<@' + a.userId + '> · 第' + a.number + '次\n\n**' + (a.success ? '✅ 成功' : '❌ 失败') + '**',
    [], a.success ? 0x2ecc71 : 0xed4245);
  result.embeds[0].addFields(field('骰点', a.roll.total, true), field(a.skillId?'技能等级 · '+a.skillName:'属性加成', a.modifier, true),
    field('合计 / 门槛', a.total + (c.rule === 'd20' ? ' ≥ ' : ' ≤ ') + c.threshold, true));
  result.embeds[0].setFooter({ text: c.id + ' · 结果 ' + a.id }); return result;
}
function sessionView(s) {
  const editable = s.reminder.status === 'pending' && s.startsAt > Date.now();
  const result = payload('开团 · ' + s.name, s.description || '点击报名参与本次跑团。', [
    row(button('activity:session:join:' + s.id, '参与本次跑团', D.ButtonStyle.Success, s.status !== 'open' || !editable),
      button('activity:session:withdraw:' + s.id, '退出报名', undefined, s.status !== 'open' || !editable),
      button('activity:session:list:' + s.id + ':0', '查看名单'), button('activity:session:manage:' + s.id, 'GM管理'))
  ], s.status === 'cancelled' ? 0x95a5a6 : s.status === 'notified' ? 0x2ecc71 : 0x3498db);
  result.embeds[0].addFields(field('开团时间', '<t:' + Math.floor(s.startsAt / 1000) + ':F>\n<t:' + Math.floor(s.startsAt / 1000) + ':R>', true),
    field('报名人数', Object.keys(s.participants).length, true), field('GM', '<@' + s.owner + '>', true),
    field('当前状态', stateLabel(s.status) + ' · 提醒' + ({ pending: '待发送', preparing: '处理中', sent: '完成', overdue: '过时',
      failed: '失败', uncertain: '待核对' }[s.reminder.status] || s.reminder.status)));
  result.embeds[0].setFooter({ text: '开团 ' + s.id + ' · 输入时间使用北京时间' }); return result;
}
function lootView(record) {
  if (record.result.items?.length > 1) {
    const items = record.result.items;
    const view = payload(record.result.pending ? '开箱结果 · 整批待领取' : '开箱结果 · 整批已入包',
      '<@' + record.userId + '> 开启 **' + record.result.box + '**，获得 **' + items.length + '件物品**\n\n' +
      items.map((item, n) => (n + 1) + '. **' + item.snapshot.name + '** · ' + item.id).join('\n') + '\n\n' +
      (record.result.pending ? '⚠️ 总重量超限：整批未入包、未扣次数；再次开启仍是这一批物品。' : record.result.free ? '✅ 整批已入包，探索领取不消耗次数。' : '✅ 整批已入包，只消耗一次开箱次数。'));
    view.embeds[0].addFields(field('总重量', C.kg(items.reduce((sum, item) => sum + require('./model').itemWeight(item), 0)), true),
      field('物品总价值', items.reduce((sum, item) => sum + item.snapshot.value * item.quantity, 0), true));
    view.embeds[0].setFooter({ text: '批次 ' + record.result.batchId + ' · 抽取记录 ' + record.id }); return view;
  }
  const t = record.result.item.snapshot, r = C.RARITIES.find(r => r.id === t.rarity);
  const view = payload(record.result.pending ? '抽取结果 · 待领取' : '抽取结果 · 已入包',
    '<@' + record.userId + '> 抽到 **' + t.name + '**\n\n' + (t.description || '暂无描述') +
    '\n\n' + (record.result.pending ? '⚠️ 超重：未入包、未扣次数，再次开启仍是此物品。' : record.result.free ? '✅ 已保存到背包，探索领取不消耗次数。' : '✅ 已保存到背包，本次消耗一次抽取次数。'), [], r?.color);
  view.embeds[0].addFields(field('稀有度 / 分类', (r?.name || '未知') + ' / ' + t.kind, true),
    field('重量', C.kg(require('./model').itemWeight(record.result.item)), true), field('价值', t.value, true));
  view.embeds[0].setFooter({ text: record.result.item.id + (record.result.batchId ? ' · 批次 ' + record.result.batchId : '') + ' · 抽取记录 ' + record.id }); return view;
}
function lootMessages(record) {
  if (!(record.result.items?.length > 1)) return [lootView(record)];
  const messages = [lootView(record)]; let embeds = [], size = 0;
  for (const [n, item] of record.result.items.entries()) {
    const t = item.snapshot, r = C.RARITIES.find(r => r.id === t.rarity);
    const e = U.embed('开箱物品 ' + (n + 1) + '/' + record.result.items.length + ' · ' + t.name, t.description || '暂无描述', r?.color)
      .addFields(field('稀有度 / 分类', r.name + ' / ' + t.kind, true), field('重量', C.kg(require('./model').itemWeight(item)), true),
        field('价值', t.value, true), field('开箱者 / 状态', '<@' + record.userId + '> · ' + (record.result.pending ? '整批待领取' : '已入包')))
      .setFooter({ text: item.id + ' · 批次 ' + record.result.batchId });
    const j = e.toJSON(), length = j.title.length + j.description.length + j.footer.text.length + j.fields.reduce((s, f) => s + f.name.length + f.value.length, 0);
    if (embeds.length && size + length > 5500) { messages.push({ embeds, components: [], allowedMentions: { parse: [] } }); embeds = []; size = 0; }
    embeds.push(e); size += length;
  }
  if (embeds.length) messages.push({ embeds, components: [], allowedMentions: { parse: [] } });
  return messages;
}
function createActivities(context) {
  const { snapshot, tx, store, textChannel, client, needGM, logFailure } = context;
  const locks = new Map(), guildCache = new Map();
  function remember(guild) { if (guild) guildCache.set(guild.id, guild); }
  async function guildFor(id) { return client.guilds?.fetch ? client.guilds.fetch(id) : guildCache.get(id); }
  function record(state, type, ref) {
    if (type === 'check') return state.checks[ref];
    if (type === 'session') return state.sessions[ref];
    if (type === 'loot') return state.lootPublications[ref];
    if (type === 'attempt') return Object.values(state.checks).flatMap(c => Object.values(c.attempts).flat()).find(a => a.id === ref);
  }
  async function locked(key, fn) {
    const job = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn); locks.set(key, job);
    try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
  }
  async function publish(guild,type,ref,force=false){if(store.backgroundPublications&&!force){await store.enqueue(guild,type,ref);return snapshot(guild).lootPublications?.[ref]?.messageId;}return publishNow(guild,type,ref,force);}
  async function publishNow(guild, type, ref, force = false) {
    return locked(guild + ':' + type + ':' + ref, async () => {
      let s = snapshot(guild), r = record(s, type, ref); ok(r, '记录不存在。');
      if (type === 'loot' && r.result.items) return publishLoot(guild, ref, force);
      if (type === 'attempt') {
        const c = Object.values(s.checks).find(c => Object.values(c.attempts).flat().some(a => a.id === ref));
        r.channelId = c.channelId;
      }
      const ch = await textChannel(guild, r.channelId);
      const build = st => type === 'check' ? checkView(record(st, type, ref)) : type === 'session' ? sessionView(record(st, type, ref)) :
        type === 'loot' ? lootView(record(st, type, ref)) : attemptView(Object.values(st.checks).find(c =>
          Object.values(c.attempts).flat().some(a => a.id === ref)), record(st, type, ref));
      if (r.messageId) {
        const message = await ch.messages.fetch(r.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (message) { await message.edit(build(s)); return message.id; }
        ok(force, '公示消息已删除，请GM确认后重新公示。');
      }
      ok(force || !['sending', 'uncertain'].includes(r.publication?.status), '公示发送结果待核对，请先检查频道，再确认补发。');
      await store.transact(guild, 'publish-intent:' + type + ':' + ref + ':' + C.id('t'), client.user.id, st => {
        record(st, type, ref).publication = { status: 'sending', at: Date.now() }; return { ref };
      }, '公示发送请求');
      try {
        const message = await ch.send({ ...build(snapshot(guild)), nonce: type + ':' + ref, enforceNonce: true });
        await store.transact(guild, 'publish-done:' + type + ':' + ref + ':' + message.id, client.user.id, st => {
          const live = record(st, type, ref); live.messageId = message.id; live.publication = { status: 'sent', at: Date.now() }; return { messageId: message.id };
        }, '公示发送完成');
        return message.id;
      } catch (e) {
        if (!store.frozen(guild)) await store.transact(guild, 'publish-failure:' + C.id('t'), client.user.id, st => {
          record(st, type, ref).publication = { status: typeof e.code === 'number' && e.code >= 10000 ? 'failed' : 'uncertain',
            error: String(e.message).slice(0, 300), at: Date.now() };
        }, '公示失败').catch(() => {});
        throw new Error('结果已保存，但公示发送失败或待核对。请通过管理面板核对后补发；不会重新抽取或扣次数。');
      }
    });
  }
  async function publishLoot(guild, ref, force) {
    let r = snapshot(guild).lootPublications[ref];ok(r&&!r.cleanedAt,'该地图结果已清理，不能补发。');
    const ch = await textChannel(guild, r.channelId), pages = lootMessages(r), publishedPending = r.result.pending, publishedUserId = r.userId;
    if (!r.publicationParts) await store.transact(guild, 'loot-parts:' + ref, client.user.id, st => {
      const live = st.lootPublications[ref]; live.publicationParts = pages.map((_, n) => ({ id: C.id('n'), status: n === 0 && live.messageId ? 'sent' : 'pending',
        ...(n === 0 && live.messageId ? { messageId: live.messageId, pending: live.result.pending } : {}) }));
    }, '保存开箱公示分段');
    for (let n = 0; n < pages.length; n++) {
      r = snapshot(guild).lootPublications[ref]; const part = r.publicationParts[n];
      if (part.messageId) {
        const m = await ch.messages.fetch(part.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (m) {
          if (part.pending !== publishedPending || part.userId !== publishedUserId) {
            await m.edit(pages[n]);
            await store.transact(guild, 'loot-refresh:' + ref + ':' + n + ':' + publishedPending + ':' + publishedUserId, client.user.id, st => {
              st.lootPublications[ref].publicationParts[n].pending = publishedPending; st.lootPublications[ref].publicationParts[n].userId = publishedUserId;
            }, '更新整批领取公示');
          }
          continue;
        }
        ok(force, '部分公示消息已删除，请核对后补发。');
      }
      ok(force || !['sending', 'uncertain'].includes(part.status), '部分公示发送结果待核对，请检查频道后补发。');
      await store.transact(guild, 'loot-send:' + ref + ':' + n + ':' + C.id('t'), client.user.id, st => {
        st.lootPublications[ref].publicationParts[n].status = 'sending'; st.lootPublications[ref].publication = { status: 'sending' };
      }, '发送开箱公示分段');
      try {
        const message = await ch.send({ ...pages[n], nonce: part.id, enforceNonce: true });
        await store.transact(guild, 'loot-sent:' + part.id + ':' + message.id, client.user.id, st => {
          const live = st.lootPublications[ref]; live.publicationParts[n] = { ...part, status: 'sent', messageId: message.id,
            pending: publishedPending, userId: publishedUserId, sentAt: Date.now() }; if (n === 0) live.messageId = message.id;
        }, '开箱公示分段送达');
      } catch (e) {
        if (!store.frozen(guild)) await store.transact(guild, 'loot-failed:' + C.id('t'), client.user.id, st => {
          const live = st.lootPublications[ref], status = typeof e.code === 'number' && e.code >= 10000 ? 'failed' : 'uncertain';
          live.publicationParts[n].status = status; live.publication = { status, error: String(e.message).slice(0, 300) };
        }, '开箱公示分段待核对').catch(() => {});
        throw new Error('整批结果已保存，部分公示发送失败或待核对；补发只处理未送达部分，不重新抽取或扣次数。');
      }
    }
    await store.transact(guild, 'loot-complete:' + ref + ':' + r.result.pending + ':' + C.id('t'), client.user.id, st => {
      st.lootPublications[ref].publication = { status: 'sent', at: Date.now() };
    }, '开箱公示完整送达');
    return snapshot(guild).lootPublications[ref].messageId;
  }
  function selection(title, entries, base, page = 0, extra = []) {
    page = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(entries.length / 20) - 1)));
    return payload(title, '共' + entries.length + '项 · 第' + (page + 1) + '页', [
      ...(entries.length ? [row(select('activity:' + base + ':select', '选择记录', entries.slice(page * 20, page * 20 + 20)))] : []),
      row(button('activity:' + base + ':' + (page - 1), '上一页', undefined, !page),
        button('activity:' + base + ':' + (page + 1), '下一页', undefined, (page + 1) * 20 >= entries.length), ...extra)
    ]);
  }
  function sessionMenu(s, page = 0) {
    return selection('开团管理', Object.values(s.sessions).sort((a, b) => b.startsAt - a.startsAt).map(r => ({
      label: r.name + ' · ' + stateLabel(r.status), value: r.id })), 'session:menu', page,
    [button('activity:session:new', '创建开团', D.ButtonStyle.Success), button('activity:session:drafts:0', '继续发布草稿')]);
  }
  function sessionManage(s) {
    const editable = ['open', 'closed'].includes(s.status) && s.reminder.status === 'pending' && s.startsAt > Date.now();
    const uncertain = s.reminder.batches.some(b => ['sending', 'uncertain'].includes(b.status));
    const view = sessionView(s); view.components = [
      row(button('activity:session:edit:' + s.id + ':' + s.version, '修改开团', D.ButtonStyle.Primary, !editable),
        button('activity:session:close:' + s.id, '关闭报名', undefined, s.status !== 'open'),
        button('activity:session:cancel:' + s.id, '取消开团', D.ButtonStyle.Danger, ['cancelled', 'notified'].includes(s.status))),
      row(button('activity:session:remind:' + s.id, '核对后手动提醒', undefined, !['overdue', 'failed', 'uncertain'].includes(s.reminder.status)),
        button('activity:session:delivered:' + s.id, '确认已送达，标记完成', undefined, !uncertain),
        button('activity:session:repost:' + s.id, '核对后重新公示'), button('activity:session:menu:0', '返回开团列表'))
    ];
    return view;
  }
  function sessionDraft(f) {
    if (f.done) return payload('开团草稿已处理', '请打开已有开团管理，或创建新的开团。',
      [row(button('activity:session:menu:0', '返回开团列表'))]);
    return payload('开团发布预览', '**' + f.data.name + '**\n' + (f.data.description || '暂无说明') + '\n\n北京时间 ' +
      A.beijing(f.data.startsAt) + '\n报名频道 <#' + f.channelId + '>', [
      row(button('activity:session:publish:' + f.id, '确认发布', D.ButtonStyle.Success),
        button('activity:session:draftedit:' + f.id, '返回修改'), button('activity:session:discard:' + f.id, '取消发布', D.ButtonStyle.Danger))
    ]);
  }
  function checkManage(c) {
    const v = checkView(c); v.components = [
      row(button('activity:check:end:' + c.id, '结束鉴定', D.ButtonStyle.Danger, c.status !== 'open'),
        button('activity:check:repost:' + c.id, '核对后重新公示'), button('activity:check:menu:0', '返回鉴定列表'))
    ]; return v;
  }
  function lootMenu(state, uid, gm, page = 0) {
    const entries = Object.values(state.lootPublications).filter(r => !r.cleanedAt&&(gm || r.userId === uid)).sort((a, b) => b.at - a.at);
    return selection('抽取公示记录', entries.map(r => ({ value: r.id, label: (r.result.items?.length > 1 ? r.result.items.length + '件 · ' + r.result.box : r.result.item.snapshot.name) + ' · ' +
      (r.publication?.status === 'sent' ? '已公示' : '待补发') })), 'loot:menu', page);
  }
  async function openModal(i, s) {
    const parts = i.customId?.split(':').slice(1);
    if (parts?.[0] !== 'activity' || parts[1] !== 'session' || i.isModalSubmit?.()) return false;
    const action = parts[2], ref = parts[3]; if (!['new', 'edit', 'draftedit'].includes(action)) return false;
    needGM(s, i.member);
    const target = action === 'edit' ? s.sessions[ref] : action === 'draftedit' ? s.forms[ref] : null;
    if (action === 'draftedit') ok(target?.owner === i.user.id && target.kind === 'session' && !target.done, '草稿已失效。');
    if (action === 'edit') ok(target?.version === Number(parts[4]) && target.reminder.status === 'pending', '开团已经变化。');
    const data = action === 'draftedit' ? target.data : target;
    await i.showModal(modal('activity:session:value:' + (action === 'edit' ? ref : 'new') + ':' +
      (action === 'edit' ? target.version : action === 'draftedit' ? ref : '0'), '创建或修改开团', [
      { key: 'name', label: '团名', max: 80, value: data?.name || '' },
      { key: 'time', label: '北京时间 YYYY-MM-DD HH:mm', max: 16, value: data ? A.beijing(data.startsAt) : '' },
      { key: 'description', label: '说明', long: true, required: false, value: data?.description || '' }
    ])); return true;
  }
  async function slash(i, member) {
    remember(i.guild); const s = snapshot(i.guildId);
    needGM(s, member);
    if (i.commandName === '开团') return sessionMenu(s);
    if (i.commandName === '鉴定') {
      if (i.options.getSubcommand() === '管理') return selection('鉴定管理', Object.values(s.checks).map(c =>
        ({ label: c.name + ' · ' + (c.status === 'open' ? '开放中' : '已结束'), value: c.id })), 'check:menu');
      const c = await tx(i, st => A.createCheck(st, i.user.id, i.channelId, { name: i.options.getString('名称'),
        rule: i.options.getString('规则'), description: i.options.getString('说明'), threshold: i.options.getInteger('门槛'),
        attribute: i.options.getString('属性'), skillId:i.options.getString('技能'), maxAttempts: i.options.getInteger('次数') ?? 1 }), '发布鉴定');
      await publish(i.guildId, 'check', c.id);
      return checkManage(snapshot(i.guildId).checks[c.id]);
    }
    return lootMenu(s, i.user.id, true);
  }
  async function component(i, member) {
    remember(i.guild);
    const [, type, action, ref, extra] = i.customId.split(':').slice(1);
    const s = snapshot(i.guildId), uid = i.user.id;
    if (type === 'loot') {
      const gm = U.gm(s, member);
      if (action === 'menu' && ref !== 'select') return lootMenu(s, uid, gm, ref);
      const r = s.lootPublications[action === 'menu' ? i.values[0] : ref];
      ok(r && !r.cleanedAt && (r.userId === uid || gm), '只能查看本人抽取结果，其他结果由GM查看。');
      if (action === 'repost') await publish(i.guildId, 'loot', r.id, true);
      const v = lootView(r); v.components = [row(button('activity:loot:repost:' + r.id, '已核对频道，补发公示'),
        button('activity:loot:menu:0', '返回抽取记录'))]; return v;
    }
    if (type === 'check') {
      if (action === 'menu') {
        needGM(s, member);
        if (ref === 'select') return checkManage(s.checks[i.values[0]]);
        return selection('鉴定管理', Object.values(s.checks).map(c => ({ value: c.id, label: c.name })), 'check:menu', ref);
      }
      const c = s.checks[ref]; ok(c, '鉴定不存在。');
      if (action === 'results') {
        const all = Object.values(c.attempts).flat().sort((a, b) => b.at - a.at);
        const page = Math.max(0, Math.min(Number(extra) || 0, Math.max(0, Math.ceil(all.length / 10) - 1)));
        const failed = all.slice(page * 10, page * 10 + 10).filter(a => a.publication?.status !== 'sent' && (a.userId === uid || U.gm(s, member)));
        return payload('鉴定记录 · ' + c.name, all.slice(page * 10, page * 10 + 10).map(a => '<@' + a.userId + '> 第' + a.number +
          '次 · ' + a.roll.total + '+' + a.modifier + '=' + a.total + ' / 门槛' + a.threshold + ' · ' + (a.success ? '✅ 成功' : '❌ 失败')).join('\n') || '暂无结果', [
          row(button('activity:check:results:' + ref + ':' + (page - 1), '上一页', undefined, !page),
            button('activity:check:results:' + ref + ':' + (page + 1), '下一页', undefined, (page + 1) * 10 >= all.length),
            button('activity:check:view:' + ref, '返回鉴定')),
          ...(failed.length ? [row(select('activity:check:attemptrepost:' + ref, '已核对频道，补发失败结果', failed.map(a =>
            ({ label: '第' + a.number + '次 · ' + a.userId, value: a.id }))))] : [])
        ]);
      }
      if (action === 'attemptrepost') {
        const a = Object.values(c.attempts).flat().find(a => a.id === i.values[0]);
        ok(a && (a.userId === uid || U.gm(s, member)), '只能补发本人结果，其他结果由GM补发。');
        await publish(i.guildId, 'attempt', a.id, true); return attemptView(c, a);
      }
      if (action === 'view') return checkView(c);
      if (action === 'roll') {
        ok(U.playerRole(s, member), '参与鉴定需要玩家身份组和有效角色卡。');
        const result = await tx(i, st => {
          ok(U.playerRole(st, member), '需要玩家身份组。');
          const a = A.rollCheck(st, ref, uid); a.channelId = c.channelId; a.publication = { status: 'pending' }; return a;
        }, '玩家鉴定');
        let failed = false;
        try { await publish(i.guildId, 'attempt', result.id); } catch (e) { failed = true; logFailure('鉴定结果公示失败。', e); }
        await publish(i.guildId, 'check', ref).catch(e => logFailure('鉴定卡刷新失败。', e));
        const view = attemptView(c, result);
        view.components = [row(button('activity:check:results:' + ref + ':0', failed ? '核对后补发结果' : '查看全部结果'))];
        return view;
      }
      needGM(s, member);
      if (action === 'end') await tx(i, st => { st.checks[ref].status = 'ended'; st.checks[ref].version++; }, '结束鉴定');
      if (action === 'end' || action === 'repost') await publish(i.guildId, 'check', ref, action === 'repost');
      return checkManage(snapshot(i.guildId).checks[ref]);
    }
    ok(type === 'session', '活动类型无效。');
    if (action === 'join' || action === 'withdraw') {
      ok(U.playerRole(s, member), '开团报名需要玩家身份组。');
      await tx(i, st => A.sessionJoin(st, ref, uid, action === 'withdraw'), action === 'withdraw' ? '退出跑团报名' : '参与跑团报名');
      await publish(i.guildId, 'session', ref);
      return payload(action === 'withdraw' ? '已退出报名' : '已报名', s.sessions[ref].name +
        '\n到开团时间将在报名频道提及仍在名单中的玩家。');
    }
    if (action === 'list') {
      const r = s.sessions[ref]; ok(r, '开团不存在。'); const ids = Object.keys(r.participants);
      const page = Math.max(0, Math.min(Number(extra) || 0, Math.max(0, Math.ceil(ids.length / 20) - 1)));
      return payload('报名名单 · ' + r.name, ids.slice(page * 20, page * 20 + 20).map((id, n) => (page * 20 + n + 1) +
        '. <@' + id + '>').join('\n') || '暂无报名', [
        row(button('activity:session:list:' + ref + ':' + (page - 1), '上一页', undefined, !page),
          button('activity:session:list:' + ref + ':' + (page + 1), '下一页', undefined, (page + 1) * 20 >= ids.length))
      ]);
    }
    needGM(s, member);
    if (action === 'menu') return ref === 'select' ? sessionManage(s.sessions[i.values[0]]) : sessionMenu(s, ref);
    if (action === 'drafts') {
      if (ref === 'select') {
        const f = s.forms[i.values[0]]; ok(f?.owner === uid && f.kind === 'session' && !f.done, '草稿已失效。'); return sessionDraft(f);
      }
      return selection('开团发布草稿', Object.values(s.forms).filter(f => f.kind === 'session' && f.owner === uid && !f.done)
        .map(f => ({ label: f.data.name, value: f.id })), 'session:drafts', ref);
    }
    if (action === 'value') {
      const data = A.validateSession({ name: i.fields.getTextInputValue('name'), description: i.fields.getTextInputValue('description'),
        startsAt: i.fields.getTextInputValue('time') });
      if (ref !== 'new') {
        await tx(i, st => A.editSession(st, ref, data, Number(extra)), '修改开团');
        await publish(i.guildId, 'session', ref); return sessionManage(snapshot(i.guildId).sessions[ref]);
      }
      const f = await tx(i, st => {
        const previous = extra !== '0' ? st.forms[extra] : null;
        if (extra !== '0') ok(previous?.kind === 'session' && previous.owner === uid && !previous.done, '草稿已经变化。');
        const f = previous || { id: C.id('f'), kind: 'session', owner: uid, channelId: i.channelId };
        f.data = data; st.forms[f.id] = f; return f;
      }, '保存开团草稿');
      return sessionDraft(f);
    }
    if (action === 'publish' || action === 'discard') {
      const result = await tx(i, st => {
        const f = st.forms[ref]; ok(f?.owner === uid && f.kind === 'session' && !f.done, '发布已经完成或取消。');
        f.done = true;
        if (action === 'discard') return null;
        return A.createSession(st, uid, f.channelId, f.data);
      }, '确认开团发布');
      if (!result) return sessionMenu(snapshot(i.guildId));
      await publish(i.guildId, 'session', result.id); return sessionManage(snapshot(i.guildId).sessions[result.id]);
    }
    const r = s.sessions[ref]; ok(r, '开团不存在。');
    if (action === 'close' || action === 'cancel') await tx(i, st => {
      const live = st.sessions[ref]; ok(['open', 'closed', 'overdue'].includes(live.status), '开团状态已变化。');
      ok(live.reminder.status !== 'preparing', '提醒已开始发送，请稍后核对提醒结果。');
      live.status = action === 'close' ? 'closed' : 'cancelled'; live.version++;
      if (action === 'cancel') live.reminder.status = 'cancelled';
    }, '调整开团报名');
    if (action === 'remind') {
      ok(['overdue', 'failed', 'uncertain'].includes(r.reminder.status), '当前提醒无须手动处理。');
      const uncertain = r.reminder.batches.some(b => ['sending', 'uncertain'].includes(b.status));
      return payload('确认手动提醒', (uncertain ? '请先检查频道，发送状态不明确的批次可能已经送达。\n' : '') +
        '确认仍未送达后，将只发送未完成批次。', [row(button('activity:session:remindconfirm:' + ref, '确认未送达并提醒', D.ButtonStyle.Danger),
          button('activity:session:manage:' + ref, '返回管理'))]);
    }
    if (action === 'remindconfirm') {
      ok(['overdue', 'failed', 'uncertain'].includes(r.reminder.status), '提醒状态已变化，请刷新后再核对。');
      await remind(i.guildId, ref, true);
    }
    if (action === 'delivered') await tx(i, st => {
      const live = st.sessions[ref]; ok(['uncertain', 'failed'].includes(live.reminder.status), '提醒状态已变化。');
      live.reminder.batches.forEach(b => { if (['sending', 'uncertain'].includes(b.status)) b.status = 'sent'; });
      if (live.reminder.batches.every(b => b.status === 'sent')) { live.reminder.status = 'sent'; live.status = 'notified'; }
    }, 'GM核对提醒已送达');
    if (['close', 'cancel', 'repost', 'delivered'].includes(action)) await publish(i.guildId, 'session', ref, action === 'repost');
    return sessionManage(snapshot(i.guildId).sessions[ref]);
  }
  async function remind(guild, ref, manual = false, now = Date.now()) {
    return locked(guild + ':reminder:' + ref, async () => {
      let r = snapshot(guild).sessions[ref]; if (!r || ['cancelled', 'notified'].includes(r.status)) return;
      if (!manual && r.reminder.status !== 'pending') return;
      const users = await store.transact(guild, 'reminder-prepare:' + ref + ':' + r.version + (manual ? ':' + C.id('t') : ''), client.user.id,
        st => A.prepareReminder(st, ref, now, manual), '开团提醒准备');
      if (!users) { await publish(guild, 'session', ref); return; }
      try {
        r = snapshot(guild).sessions[ref];
        if (!r.reminder.batches.length) {
          const g = await guildFor(guild); ok(g, '服务器未连接。');
          const valid = [];
          for (let n = 0; n < users.length; n += 10) {
            const results = await Promise.allSettled(users.slice(n, n + 10).map(user => g.members.fetch({ user, force: true })));
            results.forEach((result, k) => { if (result.status === 'fulfilled' && result.value) valid.push(users[n + k]);
              else if (result.status === 'rejected' && result.reason?.code !== 10007) throw result.reason; });
          }
          await store.transact(guild, 'reminder-batches:' + ref, client.user.id, st => {
            const live = st.sessions[ref]; ok(live.status !== 'cancelled', '开团已取消。');
            live.reminder.batches = Array.from({ length: Math.max(1, Math.ceil(valid.length / 60)) }, (_, n) => ({
              users: valid.slice(n * 60, n * 60 + 60), status: 'pending', id: C.id('n') }));
          }, '冻结开团提醒名单');
        }
        const ch = await textChannel(guild, r.channelId);
        for (let n = 0; n < snapshot(guild).sessions[ref].reminder.batches.length; n++) {
          r = snapshot(guild).sessions[ref]; if (r.status === 'cancelled') return;
          const b = r.reminder.batches[n]; if (b.status === 'sent') continue;
          ok(manual || !['sending', 'uncertain'].includes(b.status), '提醒批次待GM核对。');
          await store.transact(guild, 'reminder-intent:' + b.id + ':' + C.id('t'), client.user.id, st => {
            ok(st.sessions[ref].status !== 'cancelled', '开团已取消。');
            st.sessions[ref].reminder.batches[n].status = 'sending';
          }, '发送开团提醒');
          try {
            const msg = await ch.send({ content: b.users.map(id => '<@' + id + '>').join(' ') + '\n📅 **' + r.name +
              '** 到开团时间了！\n' + (r.messageId ? jump(guild, r) : '开团编号 ' + r.id),
              nonce: b.id, enforceNonce: true, allowedMentions: { parse: [], users: b.users, roles: [] } });
            await store.transact(guild, 'reminder-done:' + b.id + ':' + msg.id, client.user.id, st => {
              st.sessions[ref].reminder.batches[n] = { ...b, status: 'sent', messageId: msg.id, sentAt: Date.now() };
            }, '开团提醒送达');
          } catch (e) {
            if (!store.frozen(guild)) await store.transact(guild, 'reminder-error:' + C.id('t'), client.user.id, st => {
              const live = st.sessions[ref]; live.reminder.batches[n].status = typeof e.code === 'number' && e.code >= 10000 ? 'failed' : 'uncertain';
              live.reminder.status = live.reminder.batches[n].status;
            }, '开团提醒待核对').catch(() => {});
            throw e;
          }
        }
        await store.transact(guild, 'reminder-finished:' + ref, client.user.id, st => {
          const live = st.sessions[ref]; if (live.status !== 'cancelled') { live.status = 'notified'; live.reminder.status = 'sent'; }
        }, '开团提醒完成');
      } catch (e) {
        if (!store.frozen(guild)) await store.transact(guild, 'reminder-failed:' + C.id('t'), client.user.id, st => {
          const live = st.sessions[ref]; if (live.reminder.status === 'preparing') live.reminder.status = 'failed';
        }, '开团提醒失败').catch(() => {});
        logFailure('开团提醒未完成。', e);
      }
      await publish(guild, 'session', ref).catch(e => logFailure('开团卡更新失败。', e));
    });
  }
  async function recover(guild) {
    const s = snapshot(guild), interrupted = Object.values(s.sessions).filter(r => r.reminder.status === 'preparing');
    if (interrupted.length) await store.transact(guild, 'session-recovery:' + C.id('t'), client.user.id, st => {
      for (const r of interrupted) {
        const live = st.sessions[r.id];
        live.reminder.batches.forEach(b => { if (b.status === 'sending') b.status = 'uncertain'; });
        if (live.reminder.batches.length && live.reminder.batches.every(b => b.status === 'sent')) { live.reminder.status = 'sent'; live.status = 'notified'; }
        else live.reminder.status = live.reminder.batches.some(b => b.status === 'uncertain') ? 'uncertain' : 'failed';
      }
    }, '恢复开团提醒状态');
    for (const c of Object.values(snapshot(guild).checks)) if (c.messageId) await publish(guild, 'check', c.id).catch(e => logFailure('鉴定卡恢复失败。', e));
    for (const r of Object.values(snapshot(guild).sessions)) if (r.messageId) await publish(guild, 'session', r.id).catch(e => logFailure('开团卡恢复失败。', e));
  }
  async function tick(guild, now = Date.now()) {
    for (const r of Object.values(snapshot(guild).sessions)) if (r.reminder.status === 'pending' && r.startsAt <= now && r.status !== 'cancelled') {if(store.backgroundPublications)await store.enqueue(guild,'reminder',r.id,{priority:1});else await remind(guild, r.id, false, now);}
  }
  return { openModal, slash, component, publish, publishNow, tick, recover, remember, remind, lootMenu, sessionDraft };
}
module.exports = { createActivities, checkView, attemptView, sessionView, lootView, lootMessages };
