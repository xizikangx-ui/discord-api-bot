'use strict';
const C = require('./constants'), M = require('./model'), U = require('./ui');
const { requireThat: ok } = C;
const MAX_TARGETS = 25, MAX_ITEMS = 25, MAX_QUANTITY = 100;
const Categories = require('./item-categories');
function owned(state, id, uid, version, editable = true) {
  const f = state.forms[id];
  ok(f?.kind === 'bulkissue' && f.owner === uid, '批量发放面板不属于你。');
  if (editable) {
    ok(!f.done && f.expiresAt > Date.now(), '批量发放已完成或过期，请重新打开。');
    ok(f.version === Number(version), '发放清单已经变化，请重新打开最新步骤。');
  }
  return f;
}
function validate(state, f) {
  ok(f.targets.length && f.targets.length <= MAX_TARGETS, '请选择1至25个目标玩家。');
  ok(f.items.length && f.items.length <= MAX_ITEMS, '请选择1至25种物品。');
  ok(new Set(f.targets.map(t => t.uid)).size === f.targets.length && new Set(f.items.map(t => t.ref)).size === f.items.length, '发放清单有重复选择。');
  for (const e of f.items) {
    C.number(e.quantity, '每人发放数量', 1, MAX_QUANTITY);
    const template = state.catalog[e.ref];
    ok(template?.published && template.version === e.version, '物品模板已更新或移除，请重新选择物品。');
    ok(template.kind !== '杂物', '发放清单不再包含杂物，请重新选择物品。');
  }
  ok(f.items.reduce((n, e) => n + e.quantity, 0) <= MAX_QUANTITY, '每人一次最多发放100件，请减少数量或分批操作。');
}
// Each recipient is atomic. A capacity failure never leaves part of their list
// granted, while another recipient can still receive the complete list.
function execute(state, f) {
  ok(!f.done && f.expiresAt > Date.now(), '批量发放已经完成或过期。');
  validate(state, f);
  const results = [];
  for (const t of f.targets) {
    try {
      const p = M.player(state, t.uid);
      ok(p.id === t.characterId, '目标角色已变化，请重新选择。');
      const staged = { ...state, players: { ...state.players, [t.uid]: C.clone(p) } };
      const issued = f.items.flatMap(e => M.issue(staged, t.uid, e.ref, e.quantity)
        .map(item => ({ id: item.id, name: item.snapshot.name, quantity: item.quantity })));
      state.players[t.uid] = staged.players[t.uid];
      results.push({ uid: t.uid, characterId: t.characterId, success: true, issued });
    } catch (e) {
      results.push({ uid: t.uid, characterId: t.characterId, success: false, reason: String(e.message || '发放失败').slice(0, 200) });
    }
  }
  f.done = true; f.completedAt = Date.now(); f.results = results;
  return results;
}
function createBulkIssue({ snapshot, tx, needGM }) {
  const route = (f, action, extra = '') => 'bulkgive:' + action + ':' + f.id + ':' + f.version + (extra ? ':' + extra : '');
  const summary = f => '目标 **' + f.targets.length + '/25** · 物品 **' + f.items.length + '/25**\n' +
    '每位玩家收到相同清单，每人最多100件。\n' +
    (f.items.map(e => e.name.slice(0, 60) + ' ×' + e.quantity).join('\n') || '尚未选择物品。');
  function home(f) {
    return U.payload('GM批量发放', summary(f), [U.row(
      U.button(route(f, 'targets', '0'), '选择多个玩家'), U.button(route(f, 'items', '0'), '选择多个物品'),
      U.button(route(f, 'quantities'), '设置各物品数量', undefined, !f.items.length),
      U.button(route(f, 'preview'), '预览发放', U.D.ButtonStyle.Primary, !f.targets.length || !f.items.length),
      U.button(route(f, 'cancel'), '取消'))]);
  }
  function options(s, field, category = 'all') {
    return field === 'targets' ? Object.values(s.players).map(p => ({ value: p.userId, label: p.name,
      description: '玩家 ' + p.userId + ' · ' + C.kg(M.stats(p).carried) + '/' + C.kg(M.stats(p).limit) })) :
      Object.values(s.catalog).filter(t => t.published && Categories.matches(t, category)).map(t => ({ value: t.id, label: t.name, description: t.kind + ' · v' + t.version + ' · ' + t.id }));
  }
  function list(s, f, field, page) {
    const all = options(s, field, f.itemCategory), pages = Math.max(1, Math.ceil(all.length / 25));
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const part = all.slice(page * 25, page * 25 + 25), selected = f[field].map(e => field === 'targets' ? e.uid : e.ref);
    return U.payload(field === 'targets' ? '选择目标玩家' : '选择发放物品', summary(f) + '\n\n第' + (page + 1) + '/' + pages + '页；本页可多选，其他页选择保留。' + (!part.length ? '\n暂无可选对象。' : ''), [
      ...(field === 'items' ? [Categories.row(route(f, 'category'), f.itemCategory)] : []),
      ...(part.length ? [U.row(U.select(route(f, 'select' + field, String(page)), '下拉多选（最多25项）',
        part.map(o => ({ ...o, default: selected.includes(o.value) })), 0, part.length))] : []),
      U.row(U.button(route(f, field, String(page - 1)), '上一页', undefined, page === 0),
        U.button(route(f, field, String(page + 1)), '下一页', undefined, page === pages - 1), U.button(route(f, 'home'), '返回发放面板'))
    ]);
  }
  function quantities(f) {
    return U.payload('设置每人发放数量', summary(f) + '\n下拉选择物品，弹窗填写该物品每人收到的数量（1至100）。', [
      ...(f.items.length ? [U.row(U.select(route(f, 'amount'), '选择要调整数量的物品', f.items.map(e => ({ value: e.ref, label: e.name, description: '每人 ×' + e.quantity }))))] : []),
      U.row(U.button(route(f, 'home'), '返回发放面板'), U.button(route(f, 'preview'), '预览发放', U.D.ButtonStyle.Primary, !f.targets.length || !f.items.length))
    ]);
  }
  function preview(s, f) {
    validate(s, f);
    return U.payload('确认批量发放', summary(f) + '\n\n目标：' + f.targets.map(t => '<@' + t.uid + '>').join('、') +
      '\n\n确认后逐人校验并保存。超重或角色变化的玩家整份跳过，不会只收到部分物品；结果仅GM可见。', [U.row(
      U.button(route(f, 'confirm'), '确认发放给所有目标', U.D.ButtonStyle.Success), U.button(route(f, 'home'), '返回修改'), U.button(route(f, 'cancel'), '取消'))]);
  }
  function result(f, page = 0) {
    const rows = f.results || [], pages = Math.max(1, Math.ceil(rows.length / 10));
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    return U.payload('批量发放已保存', '成功 **' + rows.filter(r => r.success).length + '** · 跳过 **' + rows.filter(r => !r.success).length + '**\n' +
      '批次 ' + f.id + ' · 第' + (page + 1) + '/' + pages + '页\n\n' + rows.slice(page * 10, page * 10 + 10)
        .map(r => (r.success ? '✅ ' : '⚠️ ') + '<@' + r.uid + '> ' + (r.success ? '清单已全部发放' : r.reason)).join('\n') +
      '\n\n失败目标未收到本批次物品；腾出负重后可重新发起。成功目标请勿再次重复发放。', [U.row(
      U.button(route(f, 'result', String(page - 1)), '上一页', undefined, page === 0), U.button(route(f, 'result', String(page + 1)), '下一页', undefined, page === pages - 1))]);
  }
  async function start(i, member) {
    const f = await tx(i, s => {
      needGM(s, member);
      const uid = i.options.getUser('成员')?.id, ref = i.options.getString('物品');
      const p = uid ? M.player(s, uid) : null, t = ref ? s.catalog[ref] : null;
      ok(!ref || (t?.published && t.kind !== '杂物'), '请选择已发布的非杂物模板。');
      const f = { id: C.id('f'), kind: 'bulkissue', owner: i.user.id, version: 0, expiresAt: C.confirmationDeadline(14 * 60000),
        targets: p ? [{ uid, characterId: p.id }] : [], items: t ? [{ ref, version: t.version, name: t.name, quantity: i.options.getInteger('数量') || 1 }] : [] };
      s.forms[f.id] = f; return f;
    }, '打开GM批量发放面板');
    return home(f);
  }
  async function openModal(i, s) {
    if (i.isModalSubmit?.() || !i.customId?.startsWith('rpg:bulkgive:amount:')) return false;
    const [, , , id, version] = i.customId.split(':');
    needGM(s, i.member);
    const f = owned(s, id, i.user.id, version), item = f.items.find(e => e.ref === i.values[0]);
    ok(item, '物品选择已变化。');
    await i.showModal(U.modal(route(f, 'amountsave', item.ref), '每位玩家收到的数量', [{ key: 'quantity', label: item.name.slice(0, 35) + '（1至100）', value: item.quantity }]));
    return true;
  }
  async function component(i, member) {
    const [, , action, id, version, arg] = i.customId.split(':'), s = snapshot(i.guildId);
    needGM(s, member);
    const f = owned(s, id, i.user.id, version, action !== 'result');
    if (action === 'result') { ok(f.done && f.results, '本次发放尚未完成。'); return result(f, arg); }
    if (action === 'home') return home(f);
    if (['targets', 'items'].includes(action)) return list(s, f, action, arg);
    if (action === 'quantities') return quantities(f);
    if (action === 'preview') return preview(s, f);
    const saved = await tx(i, st => {
      needGM(st, member); const live = owned(st, id, i.user.id, version);
      if (action === 'confirm') { execute(st, live); return C.clone(live); }
      if (action === 'cancel') { live.done = true; return null; }
      if (action === 'category') {
        ok(Categories.valid(i.values[0]), '物品分类无效。'); live.itemCategory = i.values[0];
      } else
      if (['selecttargets', 'selectitems'].includes(action)) {
        const field = action.slice(6), page = C.number(arg, '页码', 0, 100000), pageIds = options(st, field, live.itemCategory).slice(page * 25, page * 25 + 25).map(o => o.value);
        ok(i.values.every(v => pageIds.includes(v)) && new Set(i.values).size === i.values.length, '选择已变化，请重新打开。');
        const key = field === 'targets' ? 'uid' : 'ref', previous = live[field];
        live[field] = previous.filter(e => !pageIds.includes(e[key])).concat(i.values.map(v => {
          const prior = previous.find(e => e[key] === v);
          if (field === 'targets') return { uid: v, characterId: M.player(st, v).id };
          const t = st.catalog[v]; return { ref: v, version: t.version, name: t.name, quantity: prior?.quantity || 1 };
        }));
        ok(live[field].length <= (field === 'targets' ? MAX_TARGETS : MAX_ITEMS), '一次最多选择25项，请取消部分选择或分批发放。');
      } else if (action === 'amountsave') {
        const item = live.items.find(e => e.ref === arg); ok(item, '物品选择已变化。');
        item.quantity = C.number(i.fields.getTextInputValue('quantity'), '每人发放数量', 1, MAX_QUANTITY);
      } else throw new Error('批量发放步骤无效。');
      live.version++; return C.clone(live);
    }, action === 'confirm' ? 'GM批量发放物品' : '编辑GM批量发放清单');
    if (!saved) return U.payload('已取消批量发放', '没有发放任何物品。');
    if (action === 'confirm') return result(saved);
    if (action === 'amountsave') return quantities(saved);
    if (action === 'category') return list(snapshot(i.guildId), saved, 'items', 0);
    return list(snapshot(i.guildId), saved, action.slice(6), arg);
  }
  return { start, openModal, component };
}
module.exports = { createBulkIssue, execute, validate };
