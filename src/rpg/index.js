'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), F = require('./forms'), U = require('./ui');
const { createStore } = require('./store');
const { commands } = require('./commands');
const { chapters } = require('./rules');
const { createHandlers } = require('./handlers');
const { requireThat: ok, number: num } = C;
const { D, E, row, button, select, payload, modal } = U;
const commandNames = new Set(commands().map(c => c.name));
const dangerous = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageThreads', 'ManageMessages',
  'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageWebhooks', 'MentionEveryone', 'ManageEvents', 'ManageGuildExpressions'];
const dangerBits = dangerous.filter(k => D.PermissionFlagsBits[k]).reduce((s, k) => s | D.PermissionFlagsBits[k], 0n);
function createRpg(deps) {
  const { client, guildIds, logFailure } = deps;
  const store = createStore(deps);
  const ready = new Set(), publishing = new Map(), roleLocks = new Set();
  let timer;
  const enabled = guild => guildIds().includes(guild);
  function snapshot(guild) { ok(ready.has(guild), '跑团存档正在读取或读取失败，暂未启用。'); return store.snapshot(guild); }
  const needGM = (s, member) => ok(U.gm(s, member), '需要本服务器配置的GM身份组。');
  const needConfig = member => ok(member.permissions.has(D.PermissionFlagsBits.ManageGuild), '配置面板需要“管理服务器”权限。');
  const owner = (i, uid) => ok(uid === i.user.id, '该个人操作面板不属于你，请重新打开自己的面板。');
  const tx = (i, fn, label) => store.transact(i.guildId, i.id, i.user.id, fn, label || i.commandName || i.customId.split(':')[1]);
  const battle = (s, battleId) => { const b = s.battles[battleId]; ok(b, '战斗不存在。'); return b; };
  function channelBattle(s, channelId) {
    const b = Object.values(s.battles).find(b => b.channelId === channelId && b.status !== 'ended');
    ok(b, '当前频道没有有效战斗，请GM /战斗 招募。'); return b;
  }
  function canActor(s, b, actorId, member, userId) {
    const a = B.actorById(b, actorId);
    ok(a.userId === userId || U.gm(s, member), '只能操作自己的角色，NPC由GM操作。');
    return a;
  }
  async function textChannel(guild, id) {
    const ch = await client.channels.fetch(id);
    ok(ch?.guildId === guild && ch.isTextBased() && ch.send, '请选择本服务器可发送消息的文字频道或子区。');
    return ch;
  }
  async function publishBattle(guild, battleId) {
    const key = guild + ':' + battleId;
    const job = (publishing.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      let s = snapshot(guild), b = battle(s, battleId);
      const ch = await textChannel(guild, b.channelId);
      if (b.messageId) {
        const message = await ch.messages.fetch(b.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (message) await message.edit(U.battleView(s, b));
        else await store.transact(guild, 'missing-board:' + b.messageId, client.user.id, st => { st.battles[b.id].messageId = null; }, '战场消息失效');
      }
      s = snapshot(guild); b = battle(s, battleId);
      if (!b.messageId) {
        const message = await ch.send(U.battleView(s, b));
        await store.transact(guild, 'board:' + message.id, client.user.id, st => { st.battles[b.id].messageId = message.id; }, '发布战场');
      }
      s = snapshot(guild); b = battle(s, battleId);
      // Persist notification intent first. Ambiguous send never repeats a ping.
      if (b.current && b.status === 'active' && b.notifiedTurn !== b.current.id) {
        const turnId = b.current.id, a = B.actorById(b, b.current.actorId);
        await store.transact(guild, 'notice:' + turnId, client.user.id, st => { st.battles[b.id].notifiedTurn = turnId; }, '行动通知');
        const roles = a.userId ? [] : s.config.gmRoleIds;
        const content = (a.userId ? '<@' + a.userId + '>' : roles.map(r => '<@&' + r + '>').join(' ')) +
          ' 轮到 **' + a.name + '** 行动，请打开战场上的个人操作面板。';
        await ch.send({ content, allowedMentions: { parse: [], users: a.userId ? [a.userId] : [], roles } });
      }
    });
    publishing.set(key, job);
    try { await job; } finally { if (publishing.get(key) === job) publishing.delete(key); }
  }
  async function tickGuild(guild) {
    if (!ready.has(guild) || store.frozen(guild)) return;
    const s = snapshot(guild), now = Date.now();
    const expiring = Object.values(s.offers).some(o => ['editing', 'ready'].includes(o.status) && o.expiresAt <= now);
    const due = Object.values(s.battles).filter(b => b.pending && b.pending.expiresAt <= now);
    if (expiring || due.length) {
      await store.transact(guild, 'timer:' + Math.floor(now / 2000), client.user.id, st => {
        M.expireOffers(st, now);
        for (const b of Object.values(st.battles)) if (b.pending && b.pending.expiresAt <= now) B.defend(st, b, b.pending.id, 'defend');
        return { expiredOffers: expiring, defense: due.map(b => b.id) };
      }, '到期交易及默认防御');
      for (const b of due) await publishBattle(guild, b.id);
    }
  }
  async function start() {
    for (const guild of guildIds()) {
      try {
        await store.load(guild); ready.add(guild);
        console.log('跑团加密存档读取正常：' + guild);
        await tickGuild(guild);
        for (const b of Object.values(snapshot(guild).battles).filter(b => b.status !== 'ended')) {
          await publishBattle(guild, b.id).catch(e => logFailure('跑团战场恢复失败。', e));
        }
      } catch (e) { logFailure('跑团初始化失败：' + guild, e); }
    }
    timer = setInterval(() => { for (const guild of ready) tickGuild(guild).catch(e => logFailure('跑团定时处理失败。', e)); }, 2000);
    timer.unref();
  }
  function configView(s) {
    const roles = ids => ids.map(r => '<@&' + r + '>').join('、') || '未配置';
    return payload('跑团配置面板', 'GM：' + roles(s.config.gmRoleIds) + '\n玩家：' + roles(s.config.playerRoleIds) +
      '\n公告频道：' + (s.config.announcementChannelId ? '<#' + s.config.announcementChannelId + '>' : '未配置') +
      '\n\nGM负责发放、录入和战斗。玩家身份组＋确认角色卡才能参与战斗。领取面板不能包含GM或危险权限角色。', [
      row(new D.RoleSelectMenuBuilder().setCustomId('rpg:config:gm').setPlaceholder('选择GM身份组').setMinValues(0).setMaxValues(10)),
      row(new D.RoleSelectMenuBuilder().setCustomId('rpg:config:player').setPlaceholder('选择玩家身份组').setMinValues(0).setMaxValues(10)),
      row(new D.ChannelSelectMenuBuilder().setCustomId('rpg:config:channel').setPlaceholder('公告频道').setChannelTypes(D.ChannelType.GuildText, D.ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1)),
      row(button('newroles', '创建领取身份组面板', D.ButtonStyle.Primary), button('rolelist:0', '已有领取面板'), button('configview', '刷新配置'))
    ]);
  }
  async function safeRoles(guild, ids, s) {
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe();
    ok(bot.permissions.has(D.PermissionFlagsBits.ManageRoles), 'Bot缺少管理身份组权限。');
    const protectedIds = new Set([...s.config.gmRoleIds, ...(deps.protectedRoles?.(guild.id) || [])]);
    for (const id of ids) {
      const role = guild.roles.cache.get(id);
      ok(role && id !== guild.id && !role.managed && role.position < bot.roles.highest.position &&
        !(role.permissions.bitfield & dangerBits) && !protectedIds.has(id),
      '身份组不可领取：不存在、托管、管理操作角色、危险权限或层级不低于Bot。');
    }
  }
  function rolePanelView(s, panel, guild) {
    const parts = panel.roleIds.map(id => button('claim:' + panel.id + ':' + id,
      panel.labels[id] || guild.roles.cache.get(id)?.name || id, D.ButtonStyle.Primary));
    const rows = [];
    rows.push(row(select('claimmulti:' + panel.id, panel.exclusive ? '选择一个身份组' : '选择要领取的身份组',
      panel.roleIds.map(id => ({ value: id, label: panel.labels[id] || guild.roles.cache.get(id)?.name || id })), 1, panel.exclusive ? 1 : panel.roleIds.length)));
    for (let n = 0; n < parts.length; n += 5) rows.push(row(...parts.slice(n, n + 5)));
    return payload(panel.title, panel.description + '\n' + (panel.exclusive ? '互斥：仅切换此面板内的身份组。' : '可领取多个身份组。') +
      (panel.allowCancel ? '再次点击已持有身份组可取消。' : '此面板不允许取消。'), rows);
  }
  async function publishRoles(i, panelId) {
    const s = snapshot(i.guildId), panel = s.rolePanels[panelId];
    ok(panel?.published, '领取面板不存在。');
    await safeRoles(i.guild, panel.roleIds, s);
    const ch = await textChannel(i.guildId, s.config.announcementChannelId || i.channelId);
    let message;
    if (panel.channelId && panel.messageId) {
      const oldCh = await textChannel(i.guildId, panel.channelId);
      message = await oldCh.messages.fetch(panel.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
      if (message) await message.edit(rolePanelView(s, panel, i.guild));
    }
    if (!message) message = await ch.send(rolePanelView(s, panel, i.guild));
    await store.transact(i.guildId, 'roleboard:' + message.id + ':' + panel.version, i.user.id, st => {
      st.rolePanels[panelId].channelId = message.channelId; st.rolePanels[panelId].messageId = message.id;
    }, '发布领取身份组面板');
  }
  async function claim(i, panelId, requested, toggle) {
    const key = i.guildId + ':' + i.user.id;
    ok(!roleLocks.has(key), '身份组领取正在处理，请稍后刷新。');
    roleLocks.add(key);
    try {
      const s = snapshot(i.guildId), panel = s.rolePanels[panelId]; ok(panel?.published, '面板已停用。');
      ok(requested.length && requested.every(id => panel.roleIds.includes(id)) && (!panel.exclusive || requested.length === 1), '选择无效。');
      await safeRoles(i.guild, panel.roleIds, s);
      const member = await i.guild.members.fetch({ user: i.user.id, force: true });
      const held = panel.roleIds.filter(id => member.roles.cache.has(id));
      let desired = panel.exclusive ? requested : [...new Set([...held, ...requested])];
      if (toggle && held.includes(requested[0])) {
        ok(panel.allowCancel, '该面板不允许取消身份组。'); desired = held.filter(id => id !== requested[0]);
      }
      const add = desired.filter(id => !held.includes(id)), remove = held.filter(id => !desired.includes(id));
      await tx(i, st => {
        st.roleClaims ||= {};
        st.roleClaims[i.id] = { userId: i.user.id, panelId, add, remove, status: 'pending', at: Date.now() };
        return { add, remove };
      }, '身份组领取请求');
      if (remove.length) await member.roles.remove(remove, '跑团领取面板互斥切换');
      if (add.length) await member.roles.add(add, '跑团领取面板');
      await store.transact(i.guildId, 'claimed:' + i.id, i.user.id, st => { st.roleClaims[i.id].status = 'completed'; }, '身份组领取完成');
      return '身份组已更新。';
    } finally { roleLocks.delete(key); }
  }
  function formView(s, formId, uid) { return F.view(s, F.owned(s, formId, uid)); }
  function offerAccess(s, offerId, member, uid) {
    const o = s.offers[offerId]; ok(o, '交易不存在。');
    ok([o.creatorId, o.targetId].includes(uid) || U.gm(s, member), '只能查看本人参与的交易。'); return o;
  }
  async function announceOffer(i, offer) {
    await i.channel.send({ content: '<@' + offer.targetId + '> 有一份待确认的' + ({ trade: '交易', transfer: '转账', buyback: 'GM收购报价' }[offer.type]) +
      '，5分钟内点击查看。', components: [row(button('offer:' + offer.id, '查看并操作交易', D.ButtonStyle.Primary))],
      allowedMentions: { parse: [], users: [offer.targetId] } });
  }
  function pickView(title, options, base, page = 0) {
    const pages = Math.max(1, Math.ceil(options.length / 25)); page = Math.max(0, Math.min(page, pages - 1));
    return payload(title, '第' + (page + 1) + '/' + pages + '页' + (options.length ? '' : '\n暂无可用选项。'), [
      ...(options.length ? [row(select(base + ':select', title, options.slice(page * 25, page * 25 + 25)))] : []),
      row(button(base + ':' + (page - 1), '上一页', undefined, page === 0), button(base + ':' + (page + 1), '下一页', undefined, page === pages - 1))
    ]);
  }
  async function autocomplete(i) {
    if (!enabled(i.guildId) || !ready.has(i.guildId)) { await i.respond([]); return; }
    const s = snapshot(i.guildId), q = i.options.getFocused().toLowerCase(), sub = i.options.getSubcommand(false);
    const fromCatalog = i.commandName === 'gm' && ['发放', '修改模板'].includes(sub);
    if (fromCatalog && !U.gm(s, i.member)) { await i.respond([]); return; }
    let entries = fromCatalog ? Object.values(s.catalog).filter(t => t.published) : Object.values(s.players[i.user.id]?.inventory || {});
    if (i.commandName === 'gm' && sub === '收购') {
      if (!U.gm(s, i.member)) { await i.respond([]); return; }
      entries = Object.values(s.players[i.options.getUser('成员')?.id]?.inventory || {});
    }
    await i.respond(entries.filter(t => ((t.snapshot?.name || t.name) + t.id).toLowerCase().includes(q)).slice(0, 25)
      .map(t => ({ name: ((t.snapshot?.name || t.name) + ' · ' + t.id).slice(0, 100), value: t.id })));
  }
  async function slash(i, member) {
    const s = snapshot(i.guildId), uid = i.user.id, name = i.commandName;
    const o = i.options, target = () => o.getUser('成员')?.id || uid;
    if (name === '跑团配置面板') { needConfig(member); return configView(s); }
    if (name === '规则') return payload('规则 · ' + (o.getString('章节') || '总览'), chapters[o.getString('章节') || '总览']);
    if (name === 'rd') {
      const result = await tx(i, () => C.dice(o.getString('骰式') || '1d100', o.getString('模式') || 'normal'), '公开掷骰');
      return payload('掷骰 · ' + result.expression, '<@' + uid + '> → **' + result.total + '**\n' +
        result.rolls.map(r => r.dice.join('/') + (r.dice.length > 1 ? '→' + r.chosen : '')).join('、') + '\n修正 ' + result.modifier);
    }
    if (name === '建卡') {
      const d = await tx(i, st => M.rollCharacter(st, uid, o.getString('名字') || i.member.displayName || i.user.username));
      return U.draftView(d);
    }
    if (name === '角色卡') return U.characterView(M.player(s, target()));
    if (name === '分配属性点') {
      await tx(i, st => { M.allocate(st, uid, o.getString('属性'), o.getInteger('点数') || 1); return { attribute: o.getString('属性'), points: o.getInteger('点数') || 1 }; });
      return U.characterView(M.player(snapshot(i.guildId), uid));
    }
    if (name === '抽卡' || name === '开箱') {
      const result = await tx(i, st => M.openLoot(st, uid, name === '抽卡' ? 'card' : o.getString('箱型')));
      const t = result.item.snapshot, r = C.RARITIES.find(r => r.id === t.rarity);
      return payload(result.pending ? '结果已保存 · 等待腾出负重领取' : '抽取结果', r.name + '色 **' + t.name + '**\n' + t.description +
        '\n重量 ' + C.kg(M.itemWeight(result.item)) + '　价值 ' + t.value + '\n编号 ' + result.item.id +
        (result.pending ? '\n未入包、未扣次数；再次开启会返回此结果。' : '\n已入包并扣除一次次数。'), [], r.color);
    }
    if (name === '背包') {
      if (target() !== uid) needGM(s, member);
      return U.inventoryView(s, target(), uid);
    }
    if (name === '丢弃') {
      const item = M.transferable(s, uid, o.getString('物品'), o.getInteger('数量') || 1);
      const token = await tx(i, st => {
        const f = { id: C.id('x'), owner: uid, kind: 'drop', itemId: item.id, quantity: o.getInteger('数量') || 1, expiresAt: Date.now() + 60000 };
        st.forms[f.id] = f; return f.id;
      });
      return payload('确认丢弃', item.snapshot.name + ' ×' + (o.getInteger('数量') || 1) + '\n不可恢复，请确认。', [row(button('dropconfirm:' + token, '确认丢弃', D.ButtonStyle.Danger))]);
    }
    if (name === '装备') {
      const operation = o.getString('操作'), ref = o.getString('物品');
      const result = await tx(i, st => {
        if (['装配', '拆下'].includes(operation)) { M.attach(st, uid, ref, o.getString('配件'), operation === '拆下'); return '配件已调整。'; }
        if (operation === '使用道具') {
          const p = M.player(st, uid), b = M.battleFor(st, uid);
          ok(M.available(st, uid, ref) > 0, '道具不存在或已被交易预留。');
          let result;
          if (b?.status === 'active') {
            const a = b.actors.find(a => a.userId === uid);
            ok(b.current?.actorId === a.id, '只能在自己的当前行动使用道具。');
            result = B.useItem(st, b, b.current.id, ref); B.nextOpportunity(st, b);
          } else result = M.consume(p, ref);
          return result.name + '已使用，恢复' + result.healed + 'HP，当前HP ' + result.hp;
        }
        if (operation.startsWith('使用')) {
          const slot = { '使用世界树之心-头部': 'head', '使用世界树之心-身体': 'body', '使用世界树之心-戒指': 'ring' }[operation];
          M.useSpecial(st, uid, ref, slot); return '槽位已扩展。';
        }
        const b = M.battleFor(st, uid);
        if (b?.status === 'active') {
          const a = b.actors.find(a => a.userId === uid);
          ok(b.current?.actorId === a.id && operation === '装备', '战斗中请在自己的当前行动面板切换武器。');
          B.switchWeapon(st, b, b.current.id, ref);
          B.nextOpportunity(st, b);
        } else M.equip(st, uid, ref, operation === '卸下');
        return '装备已调整。';
      });
      const b = M.battleFor(snapshot(i.guildId), uid); if (b) await publishBattle(i.guildId, b.id);
      return payload('装备', result);
    }
    if (name === '交易' || name === '转账') {
      const offer = await tx(i, st => M.createOffer(st, uid, target(), name === '交易' ? 'trade' : 'transfer', null, 1, o.getInteger('金额') || 0));
      await announceOffer(i, offer);
      return U.offerView(snapshot(i.guildId), offer, uid);
    }
    if (['录入物品', '录入词条', '录入异常'].includes(name)) {
      needGM(s, member);
      const kind = { '录入物品': 'item', '录入词条': 'trait', '录入异常': 'condition' }[name];
      const f = await tx(i, st => { needGM(st, member); return F.create(st, uid, kind, o.getString('类型') || '杂物'); });
      return F.view(snapshot(i.guildId), f);
    }
    if (name === 'gm') return gmSlash(i, member);
    if (name === '战斗') return battleSlash(i, member);
    throw new Error('跑团指令未识别。');
  }
  async function gmSlash(i, member) {
    const s = snapshot(i.guildId); needGM(s, member);
    const o = i.options, sub = o.getSubcommand(), uid = i.user.id, target = o.getUser('成员')?.id;
    if (sub === '恢复存档') {
      await store.recover(i.guildId); ready.add(i.guildId);
      return payload('加密存档已重新读取', '当前版本 ' + snapshot(i.guildId).revision + '。请核对背包、交易及战斗记录后继续。');
    }
    if (sub === '模板库') return catalogView(s, o.getString('类型') || '物品', 0);
    if (sub === '草稿') {
      const ref = o.getString('编号'), forms = Object.values(s.forms).filter(f => f.owner === uid && !['drop', 'delete'].includes(f.kind));
      if (ref) return formView(s, ref, uid);
      return pickView('选择持久草稿', forms.map(f => ({ value: f.id, label: f.data?.name || f.data?.title || f.kind, description: f.id })), 'drafts', 0);
    }
    if (sub === 'npc' || sub === '修改模板') {
      const ref = o.getString('物品');
      const f = await tx(i, st => { needGM(st, member); return F.create(st, uid, sub === 'npc' ? 'npc' : 'item', null, ref); });
      return F.view(snapshot(i.guildId), f);
    }
    if (sub === '销卡') {
      M.player(s, target);
      const f = await tx(i, st => {
        const form = { id: C.id('x'), owner: uid, kind: 'delete', target, characterId: M.player(st, target).id, expiresAt: Date.now() + 60000 };
        st.forms[form.id] = form; return form;
      });
      return payload('确认GM销卡', '将清空 <@' + target + '> 的角色、财产、次数和槽位扩展，取消交易并移出暂停的战斗。审计保留。', [
        row(button('deleteconfirm:' + f.id, '确认销卡', D.ButtonStyle.Danger))]);
    }
    if (sub === '收购') {
      const offer = await tx(i, st => { needGM(st, member); return M.createOffer(st, uid, target, 'buyback', o.getString('物品'), o.getInteger('数量') || 1, o.getInteger('价格')); });
      await announceOffer(i, offer); return U.offerView(snapshot(i.guildId), offer, uid);
    }
    const result = await tx(i, st => {
      needGM(st, member);
      const p = M.player(st, target), amount = o.getInteger('数量') || 1;
      if (sub === '经验') return M.grantXP(st, target, amount);
      if (sub === '属性点') { p.points = num(p.points + amount, '累计自由点', 0, 1000000); return { points: p.points }; }
      if (sub === '发放') return M.issue(st, target, o.getString('物品'), amount).map(item => ({ id: item.id, name: item.snapshot.name }));
      if (sub === '次数') {
        const type = o.getString('类型');
        if (type === '抽卡') p.tickets.card = num(p.tickets.card + amount, '抽卡次数', 0, 1000000);
        else p.tickets.boxes[type] = num((p.tickets.boxes[type] || 0) + amount, '开箱次数', 0, 1000000);
        return { type, amount };
      }
      throw new Error('GM操作未识别。');
    });
    return payload('GM' + sub + '已保存', '目标 <@' + target + '>\n' + (sub === '经验' ? '实得经验 ' + result.credited + '，等级 ' + result.before + '→' + result.level + '，获得自由点 ' + result.points :
      sub === '发放' ? result.map(item => item.name + ' · ' + item.id).join('\n') : sub === '次数' ? result.type + ' +' + result.amount : '自由点余额 ' + result.points));
  }
  function catalogView(s, type, page) {
    const source = { '物品': 'catalog', '词条': 'traits', '异常': 'conditionTemplates', 'NPC': 'npcTemplates' }[type] || 'catalog';
    const entries = Object.values(s[source]), total = Math.max(1, Math.ceil(entries.length / 12));
    page = Math.max(0, Math.min(page, total - 1));
    return payload('GM模板库 · ' + type, entries.slice(page * 12, page * 12 + 12).map(t => '**' + t.name + '** · ' + (t.kind || type) +
      '\n' + t.id + ' · v' + t.version).join('\n') + '\n\n' + (page + 1) + '/' + total, [
      row(button('catalog:' + type + ':' + (page - 1), '上一页', undefined, page === 0), button('catalog:' + type + ':' + (page + 1), '下一页', undefined, page >= total - 1)),
      ...(entries.length ? [row(select('templateedit:' + source, '选择模板修改或查看', entries.slice(page * 12, page * 12 + 12).map(t => ({ label: t.name, value: t.id }))))] : []),
    ].filter(r => r.components.length));
  }
  async function battleSlash(i, member) {
    const s = snapshot(i.guildId), o = i.options, sub = o.getSubcommand();
    if (sub === '面板') {
      const b = channelBattle(s, i.channelId);
      const a = o.getString('角色') ? canActor(s, b, o.getString('角色'), member, i.user.id) :
        b.actors.find(a => a.userId === i.user.id) || (U.gm(s, member) ? b.actors.find(a => a.id === b.current?.actorId) : null);
      return a ? U.personalView(s, b, a, i.user.id) : U.battleView(s, b);
    }
    needGM(s, member);
    const ref = await tx(i, st => {
      needGM(st, member);
      if (sub === '招募') {
        const b = B.createBattle(st, i.channelId, i.user.id, o.getString('名称'), o.getInteger('列数') || 10, o.getInteger('行数') || 10);
        b.environment = C.text(o.getString('场景') || '', '场景', 400, true); return b.id;
      }
      const b = channelBattle(st, i.channelId);
      if (sub === '开战') B.start(st, b, o.getString('偷袭'));
      else if (sub === '暂停') B.pause(b);
      else if (sub === '恢复') { B.pause(b, true); B.nextOpportunity(st, b); }
      else if (sub === '代结束') {
        ok(b.current, '没有当前行动。');
        ok(!b.pending, '请先完成防守响应。');
        if (b.status === 'paused') b.status = 'active';
        B.finish(st, b, b.current.id);
      } else if (sub === '结束') B.endBattle(st, b);
      else if (sub === '添加npc') B.addNPC(st, b, o.getString('模板'), o.getString('阵营'));
      else if (sub === '位置') B.position(b, o.getString('角色'), o.getNumber('横坐标'), o.getNumber('纵坐标'), o.getString('阵营'));
      else if (sub === '地形') B.setTerrain(b, o.getInteger('列'), o.getInteger('行'), o.getString('类型'));
      else {
        const a = B.actorById(b, o.getString('角色')), p = B.actorCharacter(st, a);
        ok(['recruiting', 'paused'].includes(b.status) && !b.pending, '调整生命、异常或阵容前请暂停，并完成待响应攻击。');
        if (sub === '生命') {
          const before = p.hp;
          p.hp = num(o.getInteger('数值'), '生命', 0, M.stats(p).maxHP);
          B.record(b, 'GM调整' + a.name + '生命 ' + before + '→' + p.hp + '。', { userId: i.user.id });
        }
        if (sub === '异常') B.record(b, a.name + '的异常施加完成。', B.applyCondition(st, p, { id: o.getString('模板'), severity: o.getString('等级') }));
        if (sub === '解除异常') {
          ok(p.conditions.some(c => c.id === o.getString('编号')), '异常编号不存在。');
          B.record(b, 'GM解除' + a.name + '的异常。', { userId: i.user.id, conditionId: o.getString('编号') });
          p.conditions = p.conditions.filter(c => c.id !== o.getString('编号')); M.syncHP(p);
        }
        if (sub === '移出') {
          b.actors = b.actors.filter(x => x.id !== a.id); b.queue = b.queue.filter(x => x.actorId !== a.id);
          if (b.current?.actorId === a.id) b.current = null; p.ap = 0; delete a.casting;
        }
      }
      return b.id;
    });
    await publishBattle(i.guildId, ref);
    if (sub === '招募' && s.config.announcementChannelId && s.config.announcementChannelId !== i.channelId) {
      const b = battle(snapshot(i.guildId), ref), ch = await textChannel(i.guildId, s.config.announcementChannelId);
      await ch.send({ content: '战斗招募：' + b.name + '\nhttps://discord.com/channels/' + i.guildId + '/' + b.channelId + '/' + b.messageId,
        allowedMentions: { parse: [] } });
    }
    return U.battleView(snapshot(i.guildId), battle(snapshot(i.guildId), ref));
  }
  const { openModal, component } = createHandlers({ snapshot, tx, needGM, needConfig, owner, battle, canActor,
    configView, safeRoles, publishRoles, claim, formView, offerAccess, catalogView, pickView, publishBattle, store, textChannel });
  async function handle(i) {
    const ours = (i.isChatInputCommand?.() || i.isAutocomplete?.()) ? commandNames.has(i.commandName) : i.customId?.startsWith('rpg:');
    if (!ours) return false;
    if (i.isAutocomplete?.()) { await autocomplete(i).catch(() => i.respond([]).catch(() => {})); return true; }
    try {
      ok(i.guildId && enabled(i.guildId), '跑团功能仅在指定跑团服务器启用。');
      if (!ready.has(i.guildId) && i.isChatInputCommand?.() && i.commandName === 'gm' && i.options.getSubcommand() === '恢复存档') {
        needConfig(i.member);
        await i.deferReply({ flags: E }); await store.recover(i.guildId); ready.add(i.guildId);
        await i.editReply(payload('跑团存档已恢复', '请 /跑团配置面板 核对GM、玩家和公告配置。')); return true;
      }
      const s = snapshot(i.guildId);
      // Modal opening itself is the initial response. Mutation is deferred on submit.
      if (i.customId && await openModal(i, s)) return true;
      const publicResult = i.isChatInputCommand?.() && ['rd', '角色卡'].includes(i.commandName);
      await i.deferReply(publicResult ? {} : { flags: E });
      const member = await i.guild.members.fetch({ user: i.user.id, force: true });
      const result = i.isChatInputCommand?.() ? await slash(i, member) : await component(i, member);
      await i.editReply(result || payload('已完成', '操作已保存。'));
    } catch (error) {
      logFailure('跑团操作失败。', error);
      const content = error.message || '操作失败，请刷新面板。';
      if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
      else await i.reply({ content, flags: E, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return true;
  }
  return { start, handle, stop: () => clearInterval(timer), store };
}
module.exports = { createRpg, commands, dangerBits };
