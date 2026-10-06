'use strict';
const C = require('./constants'), M = require('./model'), X = require('./exploration'), F = require('./forms'), U = require('./ui');
const L = require('./loot'), DTH = require('./mortality');
const { requireThat: ok, clone } = C;
const { row, button, select, payload, modal, D } = U;
const location = ref => { const [x,y] = X.xy(ref); return (y+1) + 'F · 第' + (x+1) + '格'; };
const labels = { draft: '草稿', active: '探索中', paused: '已暂停', ended: '已结束' };
function grid(m, full = false) {
  const icons = { room: '□', corridor: '·', stairs: '↕', entrance: '入', wall: '■' };
  const lines = [];
  for (let y = m.floors - 1; y >= 0; y--) {
    let line = String(y + 1).padStart(2, '0') + 'F ';
    for (let x = 0; x < m.width; x++) {
      const ref = X.key(x, y), c = m.cells[ref];
      line += !full && !m.revealed[ref] ? '？' : !c ? ' ' : Object.values(m.participants).some(p => p.cell === ref) ? '人' : icons[c.type];
    }
    lines.push(line);
  }
  return '```\n' + lines.join('\n') + '\n```\n入 入口 · 走廊 □ 房间 ↕ 楼梯 ■ 墙 ？迷雾';
}
function board(m) {
  const v = payload('探索地图 · ' + m.name, '**' + labels[m.status] + '** · ' + Object.keys(m.participants).length + '人参与\n' + grid(m), [
    row(button('map:join:' + m.id, '参与探索', D.ButtonStyle.Success, m.status !== 'active'),
      button('map:personal:' + m.id, '探索操作', D.ButtonStyle.Primary), button('map:manage:' + m.id, 'GM管理'))
  ], 0x2e8b57);
  v.embeds[0].setFooter({ text: m.id + ' · 全队共享迷雾 · 只有进入过的格子公开' }); return v;
}
function corpseView(state, corpse, page = 0) {
  const items = corpse.items.filter(i => !corpse.claims[i.id]);
  page = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(items.length / 15) - 1)));
  const part = items.slice(page * 15, page * 15 + 15), b = state.battles[corpse.battleId];
  return payload('人形NPC掉落 · ' + corpse.name, (b.status === 'ended' ? '战斗已结束，存活参战角色可领取。' : '战斗结束后开放领取。') +
    '\n剩余' + items.length + '项\n\n' + part.map(i => '**' + i.snapshot.name + '** ×' + i.quantity + ' · ' + C.kg(M.itemWeight(i)) +
      '\n' + i.snapshot.description.slice(0, 100) + '\n' + i.id).join('\n'), [
    ...(part.length ? [row(select('map:corpseclaim:' + corpse.id, '选择一件领取（超重时保留）', part.map(i => ({ label: i.snapshot.name, value: i.id }))))] : []),
    row(button('map:corpse:' + corpse.id + ':' + (page - 1), '上一页', undefined, !page),
      button('map:corpse:' + corpse.id + ':' + (page + 1), '下一页', undefined, (page + 1) * 15 >= items.length), button('map:corpse:' + corpse.id + ':' + page, '刷新'))
  ], 0xe67e22);
}
function createExploration({ snapshot, store, tx: transact, textChannel, client, needGM, activities, publishBattle, gmUI, logFailure }) {
  const jobs = new Map();
  const tx = (i, fn, label) => transact(i, st => { if (i.rpgMapGM) needGM(st, i.rpgMapMember || i.member); return fn(st); }, label);
  function map(s, ref) { const m = s.explorations[ref]; ok(m, '地图不存在。'); return m; }
  function picker(title, entries, base, page = 0, extras = []) {
    page = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(entries.length / 20) - 1)));
    return payload(title, '共' + entries.length + '项 · 第' + (page + 1) + '页', [
      ...(entries.length ? [row(select('map:' + base + ':pick', '选择一项', entries.slice(page * 20, page * 20 + 20)))] : []),
      row(button('map:' + base + ':' + (page - 1), '上一页', undefined, !page),
        button('map:' + base + ':' + (page + 1), '下一页', undefined, (page + 1) * 20 >= entries.length), ...extras)
    ]);
  }
  const back = () => button('map:config', '返回地图配置');
  function config(s) {
    return payload('GM地图与掉落配置', '先录入地图大类，再录入房间。房间可含容器、固定物资、NPC与钥匙。\n保险箱概率与钥匙次数可独立调整。', [
      row(button('map:newcategory', '录入大类', D.ButtonStyle.Primary), button('map:newroom', '录入房间', D.ButtonStyle.Primary), button('map:library:category:0', '已有大类'), button('map:library:room:0', '已有房间')),
      row(button('map:rates', '保险箱爆率'), button('map:keys', '玩家钥匙次数'), button('map:deaths:0', '指定击杀经验'), button('map:home', '地图列表')),
      row(button('map:corpselist:0', 'NPC掉落公示 / 补发'))
    ]);
  }
  function home(s, member) {
    const gm = U.gm(s, member), entries = Object.values(s.explorations).filter(m => gm || ['active', 'paused'].includes(m.status));
    return picker('探索地图', entries.map(m => ({ label: m.name + ' · ' + labels[m.status], value: m.id })), 'list', 0,
      gm ? [button('map:createcategory:0', '创建地图', D.ButtonStyle.Primary), back()] : []);
  }
  function manage(s, m) {
    return payload('GM地图 · ' + m.name, labels[m.status] + '\n' + grid(m, true) + '\n已探索' + Object.keys(m.revealed).length + '格 · 房间内容请在格子详情核对。', [
      row(button('map:celltype:' + m.id, '添加 / 修改 / 删除格子', D.ButtonStyle.Primary, !['draft', 'paused'].includes(m.status)),
        button('map:generate:' + m.id + ':' + m.version, '生成 / 重新抽取', undefined, m.status !== 'draft'),
        button('map:publish:' + m.id + ':' + m.version, '确认发布', D.ButtonStyle.Success, m.status !== 'draft' || !m.generated)),
      row(button('map:toggle:' + m.id + ':' + m.version, m.status === 'paused' ? '恢复探索' : '暂停探索', undefined, !['active', 'paused'].includes(m.status)),
        button('map:gmroom:' + m.id + ':0', '房间 / 遭遇 / 待领取'), button('map:players:' + m.id + ':0', '队员 / 位置'),
        button('map:endpreview:' + m.id, '结束探索', D.ButtonStyle.Danger, m.status === 'ended')),
      row(button('map:manage:' + m.id, '刷新'), button('map:repost:' + m.id, '核对后补发地图', undefined, m.status === 'draft'), button('map:home', '返回地图列表'), button('map:celldraft:' + m.id, '继续格子草稿', undefined, !Object.keys(m.cellDrafts || {}).length))
    ]);
  }
  function personal(s, m, uid) {
    const part = m.participants[uid], p = s.players[uid]; ok(part && p?.id === part.characterId, '先参加探索。');
    const c = m.cells[part.cell], r = c?.room;
    const rows = [];
    const dirs = X.neighbors(m, part.cell).map(to => {
      const [x, y] = X.xy(to), [ox, oy] = X.xy(part.cell);
      const name = x < ox ? '向左' : x > ox ? '向右' : y > oy ? '上楼' : '下楼';
      return button('map:move:' + m.id + ':' + to, name, D.ButtonStyle.Primary, m.status !== 'active');
    });
    if (dirs.length) rows.push(row(...dirs));
    const available = r?.containers.filter(c => c.status !== 'claimed') || [];
    if (available.length) rows.push(row(button('map:containers:' + m.id + ':0', '房间容器（免费）')));
    if (r?.supplies.length) rows.push(row(button('map:supplies:' + m.id + ':0', '固定物资')));
    rows.push(row(button('map:personal:' + m.id, '刷新'), button('map:mapview:' + m.id, '查看共享地图'), button('map:leave:' + m.id, '退出探索')));
    return payload('探索操作 · ' + p.name, m.name + ' · ' + labels[m.status] + '\n位置：' + location(part.cell) + '\n' +
      (r ? '**' + r.snapshot.name + '**\n' + r.snapshot.description + '\n遭遇：' + ({ pending: '等待GM确认', battle: '战斗中', resolved: '已解除' }[r.encounter]) : X.TYPES[c.type]) +
      '\n负重 ' + C.kg(M.weight(p)) + '/' + C.kg(M.stats(p).limit), rows, 0x2e8b57);
  }
  async function publish(guild, ref, force = false) {
    const key = guild + ':' + ref; if (jobs.has(key)) return jobs.get(key);
    const job = (async () => {
      let m = map(snapshot(guild), ref); const ch = await textChannel(guild, m.channelId);
      if (m.messageId) {
        const old = await ch.messages.fetch(m.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (old) { await old.edit(board(m)); return; }
        ok(force, '地图公示已删除，GM核对后补发。');
      }
      ok(force || !['sending', 'uncertain'].includes(m.publication?.status), '地图发送结果待核对，请GM检查后补发。');
      await store.transact(guild, 'map-send:' + C.id('n'), client.user.id, st => { st.explorations[ref].publication = { status: 'sending' }; }, '保存地图公示意图');
      try {
        m = map(snapshot(guild), ref); const message = await ch.send({ ...board(m), nonce: ref, enforceNonce: true });
        await store.transact(guild, 'map-sent:' + message.id, client.user.id, st => {
          st.explorations[ref].messageId = message.id; st.explorations[ref].publication = { status: 'sent' };
        }, '地图公示送达');
      } catch (e) {
        if (!store.frozen(guild)) await store.transact(guild, 'map-failed:' + C.id('n'), client.user.id, st => {
          st.explorations[ref].publication = { status: typeof e.code === 'number' ? 'failed' : 'uncertain' };
        }, '地图公示待核对'); throw e;
      }
    })(); jobs.set(key, job); try { await job; } finally { jobs.delete(key); }
  }
  async function publishCorpsesInner(guild, battleId, force = false) {
    const s = snapshot(guild), b = s.battles[battleId];
    for (const c of Object.values(s.corpses).filter(c => c.battleId === battleId)) {
      const ch = await textChannel(guild, b.channelId);
      const remaining = c.items.filter(i => !c.claims[i.id]);
      const card = payload('NPC掉落 · ' + c.name, '可拾取' + remaining.length + '项实物。战斗结束后开放领取；探索遭遇须GM解除。\n\n' +
        remaining.slice(0,15).map(i => '**' + i.snapshot.name + '** ×' + i.quantity + ' · ' + C.kg(M.itemWeight(i)) + '\n' + i.snapshot.description.slice(0,60)).join('\n') + (remaining.length > 15 ? '\n更多物品通过下方面板分页查看。' : ''),
        [row(button('map:corpse:' + c.id + ':0', '查看共享掉落', D.ButtonStyle.Primary))], 0xe67e22);
      if (c.messageId) { const message = await ch.messages.fetch(c.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (message) { await message.edit(card); continue; } ok(force, '尸体公示已删除，请GM核对后补发。'); }
      ok(force || !['sending', 'uncertain'].includes(c.publication.status), '尸体公示结果待核对，请GM核对后补发。');
      await store.transact(guild, 'corpse-send:' + C.id('n'), client.user.id, st => { st.corpses[c.id].publication.status = 'sending'; }, '尸体公示意图');
      try { const message = await ch.send({ ...card, nonce: c.id, enforceNonce: true });
        await store.transact(guild, 'corpse-sent:' + message.id, client.user.id, st => { st.corpses[c.id].messageId = message.id; st.corpses[c.id].publication.status = 'sent'; }, '尸体公示送达');
      } catch (e) { if (!store.frozen(guild)) await store.transact(guild, 'corpse-failed:' + C.id('n'), client.user.id, st => {
        st.corpses[c.id].publication.status = typeof e.code === 'number' ? 'failed' : 'uncertain';
      }, '尸体公示待核对'); throw e; }
    }
  }
  async function publishCorpses(guild, battleId, force = false) {
    const key = 'corpses:' + guild + ':' + battleId;
    const job = (jobs.get(key) || Promise.resolve()).catch(() => {}).then(() => publishCorpsesInner(guild, battleId, force));
    jobs.set(key, job); try { await job; } finally { if (jobs.get(key) === job) jobs.delete(key); }
  }
  async function openModal(i, s) {
    if (i.isModalSubmit?.() || !i.customId?.startsWith('rpg:map:')) return false;
    const [, action, ref, arg] = i.customId.split(':').slice(1);
    if (!['createnamed', 'coord', 'rateedit', 'keyedit', 'teleport'].includes(action)) return false;
    needGM(s, i.member);
    let fields;
    if (action === 'createnamed') fields = [{ key: 'name', label: '地图名称' }, { key: 'floors', label: '楼层1—20', value: '3' }, { key: 'width', label: '每层格数1—20', value: '9' }];
    if (action === 'coord' || action === 'teleport') fields = [{ key: 'x', label: '列1—20' }, { key: 'y', label: '楼层1—20' }];
    if (action === 'rateedit') fields = [{ key: 'values', label: '白 绿 蓝 紫 金 红（空格分隔，合计100）', value: L.rates(s, ref).join(' ') }];
    if (action === 'keyedit') { const item = M.player(s, ref).inventory[arg]; ok(item?.snapshot.kind === '钥匙', '钥匙已不存在。'); fields = [{ key: 'charges', label: '剩余次数（设置绝对值，0—100000）', value: item.keyCharges }]; }
    await i.showModal(modal('map:' + action + 'submit:' + ref + (arg ? ':' + arg : ''), 'GM配置', fields)); return true;
  }
  async function component(i, member) {
    const [, action, ref, arg, extra] = i.customId.split(':').slice(1), s = snapshot(i.guildId), uid = i.user.id;
    const gm = U.gm(s, member);
    if (action === 'home') return home(s, member);
    if (action === 'list') return ref === 'pick' ? (gm ? manage(s, map(s, i.values[0])) : board(map(s, i.values[0]))) :
      picker('探索地图', Object.values(s.explorations).filter(m => gm || ['active', 'paused'].includes(m.status)).map(m => ({ label: m.name + ' · ' + labels[m.status], value: m.id })), 'list', ref);
    if (action === 'corpse') { const c = s.corpses[ref]; ok(c, '掉落记录不存在。'); return corpseView(s, c, arg); }
    if (action === 'corpseclaim') {
      ok(U.playerRole(s, member), '需要玩家身份组。'); const c = s.corpses[ref];
      await tx(i, st => { ok(U.playerRole(st, member), '需要玩家身份组。'); return DTH.claim(st, ref, uid, i.values[0]); }, '领取NPC掉落'); await publishCorpses(i.guildId, c.battleId);
      return corpseView(snapshot(i.guildId), snapshot(i.guildId).corpses[ref]);
    }
    if (['join', 'personal', 'move', 'unlock', 'open', 'containers', 'take', 'supplies', 'mapview', 'leave'].includes(action)) {
      const m = map(s, ref); ok(U.playerRole(s, member), '需要玩家身份组。');
      if (action === 'containers' || (action === 'open' && arg !== 'pick')) return picker('房间容器', X.currentRoom(s, m, uid).r.containers.filter(c => c.status !== 'claimed').map(c => ({ label: c.box + ' · ' + c.status, value: c.id })), 'open:' + ref, arg, [button('map:personal:' + ref, '返回房间')]);
      if (action === 'personal') return personal(s, m, uid);
      if (action === 'mapview') return { ...board(m), components: [row(button('map:personal:' + m.id, '返回探索操作'))] };
      if (action === 'supplies') return picker('固定物资', m.cells[m.participants[uid]?.cell]?.room?.supplies.map(x => ({ label: x.snapshot.name + ' · ' + C.kg(M.itemWeight(x)), value: x.id })) || [], 'take:' + ref, arg, [button('map:personal:' + ref, '返回房间')]);
      if (action === 'take' && arg !== 'pick') return picker('固定物资', X.currentRoom(s, m, uid).r.supplies.map(x => ({ label: x.snapshot.name, value: x.id })), 'take:' + ref, arg);
      if (action === 'move' && m.cells[arg]?.room && !m.cells[arg].room.unlocked) {
        const { p } = X.participant(s, m, uid), required = m.cells[arg].room.snapshot.keyIds[0];
        const keys = Object.values(p.inventory).filter(x => x.templateId === required && x.keyCharges > 0 && M.available(s, uid, x.id) > 0);
        return payload('房门上锁', '首次开门消耗匹配钥匙一次，此后全队永久解锁。', [
          ...(keys.length ? [row(select('map:unlock:' + ref + ':' + arg, '选择钥匙', keys.slice(0, 25).map(k => ({ label: k.snapshot.name + ' · 剩余' + k.keyCharges, value: k.id }))))] : []),
          row(button('map:personal:' + ref, keys.length ? '取消开门' : '缺少可用钥匙，返回'))
        ]);
      }
      const result = await tx(i, st => {
        const live = map(st, ref); ok(U.playerRole(st, member), '需要玩家身份组。');
        if (action === 'join') X.join(st, live, uid);
        if (action === 'leave') { ok(!M.battleFor(st, uid), '战斗期间请GM移出。'); delete live.participants[uid]; live.version++; }
        if (action === 'move' || action === 'unlock') return { encountered: X.move(st, live, uid, arg, i.values?.[0]), cell: arg };
        if (action === 'open') return X.open(st, live, uid, i.values[0]);
        if (action === 'take') {
          const item = X.take(st, live, uid, i.values[0]), record = { id: C.id('l'), userId: uid, channelId: live.channelId, at: Date.now(),
            result: { box: '房间物资', batchId: item.id, items: [clone(item)], item: clone(item), pending: false, free: true }, publication: {status:'pending'} };
          st.lootPublications[record.id] = record; return { publicationId: record.id };
        }
      }, '地图玩家操作');
      await publish(i.guildId, ref);
      if (result?.publicationId) await activities.publish(i.guildId, 'loot', result.publicationId, false).catch(e => logFailure('地图容器公示失败，GM可从抽取公示补发。', e));
      if (result?.item) await i.channel.send(payload('探索物资已领取', '<@' + uid + '> 获得 **' + result.item.snapshot.name + '** ×' + result.item.quantity + '\n' + result.item.snapshot.description));
      if (result?.encountered) {
        const room = map(snapshot(i.guildId), ref).cells[result.cell].room;
        await i.channel.send({ ...payload('房间遭遇 · ' + room.snapshot.name, '玩家进入了怪物房，请GM确认阵容后开战。', [row(button('map:room:' + ref + ':' + result.cell, 'GM处理遭遇'))]),
          content: s.config.gmRoleIds.map(r => '<@&' + r + '>').join(' '), allowedMentions: { parse: [], roles: s.config.gmRoleIds } });
      }
      return action === 'leave' ? home(snapshot(i.guildId), member) : personal(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid);
    }
    needGM(s, member); i.rpgMapGM = true; i.rpgMapMember = member;
    if (action === 'config') return config(s);
    if (action === 'newcategory' || action === 'newroom') {
      const f = await tx(i, st => F.create(st, uid, action === 'newcategory' ? 'mapcategory' : 'room'), '创建地图模板草稿'); return F.view(snapshot(i.guildId), f);
    }
    if (action === 'library') {
      const source = ref === 'category' ? 'mapCategories' : 'roomTemplates';
      if (arg === 'pick') { const f = await tx(i, st => F.create(st, uid, ref === 'category' ? 'mapcategory' : 'room', null, i.values[0]), '修改地图模板'); return F.view(snapshot(i.guildId), f); }
      return picker('已有' + (ref === 'category' ? '大类' : '房间'), Object.values(s[source]).map(t => ({ label: t.name, value: t.id })), 'library:' + ref, arg, [back()]);
    }
    if (action === 'rates') return payload('保险箱爆率', '每件独立抽取；已生成结果不受修改影响。', [
      row(select('map:ratepick', '选择保险箱', Object.keys(L.DEFAULT_SAFE_RATES).map(b => ({ label: b, value: b })))), row(back())
    ]);
    if (action === 'ratepick' || action === 'rateview') { const box = action === 'ratepick' ? i.values[0] : ref; return payload(box + ' · 概率',
      '白／绿／蓝／紫／金／红：\n' + L.rates(s, box).join('% ／ ') + '%', [row(button('map:rateedit:' + box, '修改概率'), button('map:ratereset:' + box, '恢复默认'), button('map:rates', '返回'))]); }
    if (action === 'rateeditsubmit' || action === 'ratereset') {
      await tx(i, st => L.setRates(st, ref, action === 'ratereset' ? L.DEFAULT_SAFE_RATES[ref] : i.fields.getTextInputValue('values').trim().split(/\s+/).map(Number)), '修改保险箱爆率'); return config(snapshot(i.guildId));
    }
    if (action === 'keys') return payload('GM钥匙次数', '选择持有钥匙的玩家。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:keyuser').setPlaceholder('选择玩家')), row(back())]);
    if (action === 'keyuser' || action === 'keylist') { const target = action === 'keyuser' ? i.values[0] : ref; return picker('玩家钥匙', Object.values(M.player(s, target).inventory).filter(k => k.snapshot.kind === '钥匙').map(k => ({ label: k.snapshot.name + ' · 剩余' + k.keyCharges, value: k.id })), 'keychoose:' + target, arg, [back()]); }
    if (action === 'keychoose') { if (arg === 'pick') return payload('钥匙次数', '编号 ' + i.values[0], [row(button('map:keyedit:' + ref + ':' + i.values[0], '设置剩余次数'), button('map:keylist:' + ref + ':0', '返回'))]); return picker('玩家钥匙', Object.values(M.player(s, ref).inventory).filter(k => k.snapshot.kind === '钥匙').map(k => ({ label: k.snapshot.name, value: k.id })), 'keychoose:' + ref, arg); }
    if (action === 'keyeditsubmit') { await tx(i, st => { const item = M.player(st, ref).inventory[arg]; ok(item?.snapshot.kind === '钥匙' && M.available(st, ref, arg) > 0, '钥匙不存在或被预留。'); item.keyCharges = C.number(i.fields.getTextInputValue('charges'), '次数', 0, 100000); }, 'GM调整钥匙次数'); return config(snapshot(i.guildId)); }
    if (action === 'createcategory') {
      if (ref === 'pick') return payload('选择生成方式', '随机从大类房间抽选；固定逐格指定。', [row(select('map:createmode:' + i.values[0], '地图方式', [{ label: '随机', value: 'random' }, { label: '固定', value: 'fixed' }])), row(button('map:home', '取消'))]);
      return picker('选择地图大类', Object.values(s.mapCategories).map(t => ({ label: t.name, value: t.id })), 'createcategory', ref, [back()]);
    }
    if (action === 'createmode') return payload('创建地图', '模式 ' + i.values[0] + '，填写大小后进入可编辑预览。', [row(button('map:createnamed:' + ref + ':' + i.values[0], '填写名称与大小'), button('map:home', '取消'))]);
    if (action === 'createnamedsubmit') { const m = await tx(i, st => X.create(st, uid, i.channelId, i.fields.getTextInputValue('name'), i.fields.getTextInputValue('floors'), i.fields.getTextInputValue('width'), arg, ref), '创建地图草稿'); return manage(snapshot(i.guildId), m); }
    if (action === 'deaths') {
      if (ref === 'pick') return payload('指定击杀经验', '选择获得经验的有效玩家角色。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:rewarduser:' + i.values[0])), row(back())]);
      return picker('未结算击杀经验', Object.values(s.deaths).filter(d => d.kind === 'npc' && d.team === 'enemy' && !d.rewarded).map(d => ({ label: d.name + ' · 基础经验' + d.baseXP, value: d.id })), 'deaths', ref, [back()]);
    }
    if (action === 'rewarduser') return payload('确认击杀归属', '<@' + i.values[0] + '> 将获得该NPC经验，仅能结算一次。', [row(button('map:reward:' + ref + ':' + i.values[0], '确认发放', D.ButtonStyle.Success), back())]);
    if (action === 'reward') { const death = s.deaths[ref]; ok(death, '死亡记录不存在。'); await tx(i, st => DTH.reward(st, st.battles[death.battleId], st.deaths[ref], arg), 'GM指定击杀经验'); return config(snapshot(i.guildId)); }
    if (action === 'corpselist') {
      if (ref === 'pick') return payload('NPC掉落公示', '核对频道后可补发已有掉落卡，不重新生成物品。', [row(button('map:corpserepost:' + i.values[0], '核对后补发'), button('map:corpse:' + i.values[0] + ':0', '查看掉落'), back())]);
      return picker('NPC掉落记录', Object.values(s.corpses).map(c => ({ label: c.name + ' · ' + c.publication.status, value: c.id })), 'corpselist', ref, [back()]);
    }
    if (action === 'corpserepost') { ok(s.corpses[ref], '掉落不存在。'); await publishCorpses(i.guildId, s.corpses[ref].battleId, true); return config(snapshot(i.guildId)); }
    const m = map(s, ref);
    if (action === 'manage') return manage(s, m);
    if (action === 'celltype') return payload('编辑格子 · 选择类型', '已有交互的格子不能替换。', [row(select('map:typepick:' + ref, '格子类型', [...Object.entries(X.TYPES).map(([value, label]) => ({ value, label })), { label: '删除格子', value: 'empty' }])), row(button('map:manage:' + ref, '返回'))]);
    if (action === 'typepick') return payload('编辑格子 · 填写位置', X.TYPES[i.values[0]] || '删除格子', [row(button('map:coord:' + ref + ':' + i.values[0], '填写列与楼层'), button('map:manage:' + ref, '取消'))]);
    if (action === 'coordsubmit') {
      await tx(i, st => { const live = map(st, ref); ok(['draft', 'paused'].includes(live.status), '请暂停地图。');
        live.cellDrafts ||= {}; live.cellDrafts[uid] = { x: C.number(i.fields.getTextInputValue('x'), '列', 1, 20), y: C.number(i.fields.getTextInputValue('y'), '楼层', 1, 20), type: arg, categoryId: live.categoryId, templateId: null, version: live.version };
      }, '保存格子编辑草稿'); return cellDraft(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid);
    }
    if (action === 'celldraft') return cellDraft(s, m, uid);
    if (action === 'cellcategory' || action === 'cellroom') {
      const d = m.cellDrafts?.[uid]; ok(d, '重新填写格子坐标。');
      if (arg === 'pick') { await tx(i, st => { const d = map(st, ref).cellDrafts[uid];
        if (action === 'cellcategory') { d.categoryId = i.values[0]; d.templateId = null; } else d.templateId = i.values[0];
      }, '编辑格子选择'); return cellDraft(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid); }
      const entries = Object.values(action === 'cellcategory' ? s.mapCategories : s.roomTemplates).filter(t => action === 'cellcategory' || t.categoryIds[0] === d.categoryId);
      return picker('选择' + (action === 'cellcategory' ? '大类' : '固定房间'), entries.map(t => ({ label: t.name, value: t.id })), action + ':' + ref, arg, [button('map:celldraft:' + ref, '返回编辑')]);
    }
    if (action === 'cellapply') { await tx(i, st => { const live = map(st, ref), d = live.cellDrafts?.[uid]; ok(d && d.version === live.version, '地图已有变更，请重新编辑格子。'); X.editCell(st, live, d.x, d.y, d.type, d.categoryId, d.templateId); live.generated = live.status === 'draft' ? false : live.generated; delete live.cellDrafts[uid]; }, '保存地图格子'); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'cellcancel') { await tx(i, st => { delete map(st, ref).cellDrafts?.[uid]; }, '取消格子编辑'); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'endpreview') return payload('确认结束探索', '保留地图和掉落记录，关闭玩家操作。', [row(button('map:end:' + ref + ':' + m.version, '确认结束', D.ButtonStyle.Danger), button('map:manage:' + ref, '取消'))]);
    if (['generate', 'publish', 'toggle', 'end'].includes(action)) {
      await tx(i, st => { const live = map(st, ref); ok(live.version === Number(arg), '地图已变化，请刷新。');
        if (action === 'generate') X.generate(st, live);
        if (action === 'publish') X.publish(st, live);
        if (action === 'toggle') { ok(['active', 'paused'].includes(live.status), '地图状态已变化。'); if (live.status === 'paused') { live.entrance = X.validateMap(live); live.revealed[live.entrance] = true; } live.status = live.status === 'paused' ? 'active' : 'paused'; live.version++; }
        if (action === 'end') { ok(!Object.values(st.battles).some(b => b.exploration?.mapId === ref && b.status !== 'ended'), '先结束关联战斗。'); live.status = 'ended'; live.version++; }
      }, 'GM地图管理'); const next = map(snapshot(i.guildId), ref); if (next.status !== 'draft') await publish(i.guildId, ref); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref));
    }
    if (action === 'repost') { await publish(i.guildId, ref, true); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'gmroom') { if (arg === 'pick') return roomGM(s, m, i.values[0]);
      return picker('房间详情', Object.entries(m.cells).filter(([, c]) => c.room).map(([cell, c]) => ({ label: location(cell) + ' · ' + c.room.snapshot.name, value: cell })), 'gmroom:' + ref, arg, [button('map:manage:' + ref, '返回')]); }
    if (action === 'room') return roomGM(s, m, arg);
    if (action === 'roster') {
      const r = m.cells[arg]?.room; ok(r?.encounter === 'pending', '遭遇已变化。');
      const players = Object.entries(m.participants).filter(([, p]) => p.cell === arg).map(([uid]) => ({ label: s.players[uid]?.name || uid, value: uid }));
      return payload('确认遭遇阵容', '选择同房间玩家，随后生成战斗招募；通过战斗GM面板正式开战。', [
        ...(players.length ? [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:encounter:' + ref + ':' + arg)
          .setPlaceholder('选择当前房间的参战玩家').setMinValues(1).setMaxValues(Math.min(20, players.length)))] : []), row(button('map:room:' + ref + ':' + arg, '返回房间'))
      ]);
    }
    if (action === 'encounter') { const b = await tx(i, st => X.encounter(st, map(st, ref), arg, i.values), 'GM确认房间战斗'); await publish(i.guildId, ref); await publishBattle(i.guildId, b.id); return gmUI.view(snapshot(i.guildId), snapshot(i.guildId).battles[b.id]); }
    if (action === 'resolve') { await tx(i, st => X.resolve(st, map(st, ref), arg), 'GM解除房间遭遇'); await publish(i.guildId, ref); return roomGM(snapshot(i.guildId), map(snapshot(i.guildId), ref), arg); }
    if (action === 'transferpick') { return picker('待领取容器', m.cells[arg]?.room?.containers.filter(c => c.status === 'pending').map(c => ({ label: c.box + ' · ' + c.batch.id, value: c.id })) || [], 'transferchoose:' + ref + ':' + arg, extra, [button('map:room:' + ref + ':' + arg, '返回房间')]); }
    if (action === 'transferchoose') {
      if (extra !== 'pick') return picker('待领取容器', m.cells[arg]?.room?.containers.filter(c => c.status === 'pending').map(c => ({ label: c.box, value: c.id })) || [], 'transferchoose:' + ref + ':' + arg, extra);
      return payload('转交原批次', '地图暂停时才能转交，接收者必须参加本地图。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:transfer:' + ref + ':' + arg + ':' + i.values[0])), row(button('map:room:' + ref + ':' + arg, '取消'))]);
    }
    if (action === 'transfer') { await tx(i, st => X.transfer(st, map(st, ref), arg, extra, i.values[0]), '转交原容器批次'); return roomGM(snapshot(i.guildId), map(snapshot(i.guildId), ref), arg); }
    if (action === 'players') {
      if (arg === 'pick') return payload('GM玩家调整', '<@' + i.values[0] + '>', [row(button('map:teleport:' + ref + ':' + i.values[0], '调整位置'), button('map:remove:' + ref + ':' + i.values[0], '移出探索'), button('map:manage:' + ref, '返回'))]);
      return picker('探索队员', Object.entries(m.participants).map(([uid, p]) => ({ label: (s.players[uid]?.name || uid) + ' · ' + location(p.cell), value: uid })), 'players:' + ref, arg, [button('map:manage:' + ref, '返回')]);
    }
    if (action === 'teleportsubmit' || action === 'remove') { await tx(i, st => { const live = map(st, ref); ok(live.status === 'paused', '先暂停地图。'); ok(live.participants[arg] && !M.battleFor(st, arg), '玩家不存在或仍在战斗。');
      if (action === 'remove') delete live.participants[arg];
      else { const to = X.key(C.number(i.fields.getTextInputValue('x'), '列', 1, 20) - 1, C.number(i.fields.getTextInputValue('y'), '楼层', 1, 20) - 1), c = live.cells[to]; ok(c && c.type !== 'wall' && (!c.room || c.room.unlocked), '目标格不存在、是墙或房门未解锁。'); live.participants[arg].cell = to; live.revealed[to] = true; c.touched = true; }
      live.version++;
    }, 'GM调整探索队员'); await publish(i.guildId, ref); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    throw new Error('地图操作已失效，请重新打开。');
  }
  function cellDraft(s, m, uid) {
    const d = m.cellDrafts?.[uid]; ok(d, '没有格子编辑草稿。');
    return payload('格子编辑预览', '第' + d.y + '层，第' + d.x + '列 · ' + (X.TYPES[d.type] || '删除') + '\n大类：' + s.mapCategories[d.categoryId]?.name +
      '\n房间：' + (s.roomTemplates[d.templateId]?.name || '随机抽取（固定模式必须选择）'), [
      ...(d.type === 'room' ? [row(button('map:cellcategory:' + m.id + ':0', '选择大类'), button('map:cellroom:' + m.id + ':0', '指定房间'))] : []),
      row(button('map:cellapply:' + m.id, '确认保存', D.ButtonStyle.Success), button('map:cellcancel:' + m.id, '取消'), button('map:manage:' + m.id, '返回地图'))
    ]);
  }
  function roomGM(s, m, cell) {
    const r = m.cells[cell]?.room; ok(r, '房间不存在，请先生成。');
    return payload('GM房间 · ' + r.snapshot.name, '位置 ' + location(cell) + ' · 遭遇 ' + r.encounter + '\n' + r.snapshot.description +
      '\n\nNPC：' + (r.snapshot.npcs.map(n => n.template.name + ' ×' + n.quantity).join('、') || '无') +
      '\n钥匙：' + (r.snapshot.keyIds.map(k => s.catalog[k]?.name || k).join('、') || '无需钥匙') +
      '\n容器：' + r.containers.map(c => c.box + ' · ' + c.status).join('、') + '\n物资：' + r.supplies.map(i => i.snapshot.name + ' ×' + i.quantity).join('、'), [
      row(button('map:roster:' + m.id + ':' + cell, '确认玩家 / 开战', D.ButtonStyle.Primary, r.encounter !== 'pending'),
        button('map:resolve:' + m.id + ':' + cell, 'GM解除遭遇', undefined, r.encounter === 'resolved'), button('map:transferpick:' + m.id + ':' + cell + ':0', '转交待领取容器')),
      row(button('map:manage:' + m.id, '返回地图'))
    ]);
  }
  async function recover(guild) {
    for (const m of Object.values(snapshot(guild).explorations).filter(m => !['draft', 'ended'].includes(m.status))) await publish(guild, m.id).catch(e => logFailure('探索地图恢复失败。', e));
  }
  return { config, home, manage, personal, component, openModal, publish, publishCorpses, recover };
}
module.exports = { grid, board, corpseView, createExploration };
