'use strict';
const C = require('./constants'), M = require('./model'), U = require('./ui');
const { requireThat: ok } = C;
function availability(state, uid, item) {
  const quantity = Math.max(0, M.available(state, uid, item.id));
  try { M.transferable(state, uid, item.id, 1); return { quantity, reason: null }; }
  catch (e) { return { quantity: 0, reason: e.message }; }
}
function createBuyback({ snapshot, tx, needGM, announceOffer }) {
  const { row, button, select, payload, modal, D } = U;
  function list(state, target, page = 0) {
    const p = M.player(state, target), entries = Object.values(p.inventory), pages = Math.max(1, Math.ceil(entries.length / 15));
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const slice = entries.slice(page * 15, page * 15 + 15), options = slice.filter(item => !availability(state, target, item).reason);
    return payload('GM收购 · ' + p.name, '玩家 <@' + target + '> · 第' + (page + 1) + '/' + pages + '页\n\n' +
      (slice.map(item => { const a = availability(state, target, item); return '**' + item.snapshot.name + '** · ' + item.id +
        '\n' + (a.reason ? '不可出售：' + a.reason : '可出售 ' + a.quantity + ' / 持有 ' + item.quantity); }).join('\n\n') || '背包为空。'), [
      ...(options.length ? [row(select('buyback:pick:' + target + ':' + page, '选择收购物品', options.map(item =>
        ({ label: item.snapshot.name, value: item.id, description: item.id + ' · 可售 ' + availability(state, target, item).quantity }))))] : []),
      row(button('buyback:page:' + target + ':' + (page - 1), '上一页', undefined, !page),
        button('buyback:page:' + target + ':' + (page + 1), '下一页', undefined, page >= pages - 1),
        button('buyback:page:' + target + ':' + page, '刷新背包'), button('buyback:exit', '取消收购'))
    ]);
  }
  function draft(state, ref, uid, version) {
    const f = state.forms[ref];
    ok(f?.kind === 'buyback' && f.owner === uid && !f.done && f.expiresAt > Date.now() &&
      (version === undefined || f.version === Number(version)), '收购步骤已失效，请重新 /gm 收购。');
    ok(M.player(state, f.target).id === f.characterId, '玩家角色卡已变化，请重新收购。'); return f;
  }
  function view(state, f) {
    const item = M.player(state, f.target).inventory[f.itemId];
    ok(item, '物品已不在玩家背包中。');
    const a = availability(state, f.target, item);
    return payload(f.priced ? 'GM收购 · 报价预览' : 'GM收购 · 填写报价', '<@' + f.target + '>\n**' + item.snapshot.name + '** · ' + item.id +
      '\n' + (item.snapshot.description || '').slice(0, 1800) + '\n\n' + (a.reason || '当前可出售 ' + a.quantity) +
      (f.priced ? '\n数量 **' + f.quantity + '** · 总价 **' + f.price + '** 游戏币\n玩家确认后才移除物品并入账。' : '\n请填写数量和收购总价。'), [
      row(button('buyback:edit:' + f.id + ':' + f.version, '填写 / 修改报价', D.ButtonStyle.Primary),
        button('buyback:confirm:' + f.id + ':' + f.version, '确认并向玩家报价', D.ButtonStyle.Success, !f.priced || !!a.reason || a.quantity < f.quantity)),
      row(button('buyback:back:' + f.id + ':' + f.version, '返回选物'), button('buyback:cancel:' + f.id + ':' + f.version, '取消收购'))
    ]);
  }
  async function openModal(i, state) {
    if (i.isModalSubmit?.() || !i.customId?.startsWith('rpg:buyback:edit:')) return false;
    needGM(state, i.member);
    const [, , ref, version] = i.customId.split(':').slice(1), f = draft(state, ref, i.user.id, version);
    await i.showModal(modal('buyback:value:' + f.id + ':' + f.version, 'GM收购报价', [
      { key: 'quantity', label: '收购数量', value: f.quantity }, { key: 'price', label: '收购总价（游戏币）', value: f.price }
    ])); return true;
  }
  async function component(i, member) {
    const [, action, ref, arg] = i.customId.split(':').slice(1), s = snapshot(i.guildId), uid = i.user.id;
    needGM(s, member);
    if (action === 'notify') {
      const offer = s.offers[ref]; ok(offer?.type === 'buyback' && M.activeOffer(offer), '收购报价已失效。');
      await announceOffer(i, offer); return U.offerView(snapshot(i.guildId), offer, uid);
    }
    if (action === 'exit') return payload('已取消收购', '没有创建报价，也没有转移资产。');
    if (action === 'page') return list(s, ref, arg);
    if (action === 'pick') {
      const f = await tx(i, st => {
        needGM(st, member); const p = M.player(st, ref), itemId = i.values[0]; M.transferable(st, ref, itemId, 1);
        const f = { id: C.id('f'), kind: 'buyback', owner: uid, target: ref, characterId: p.id, itemId, page: Number(arg) || 0,
          quantity: 1, price: 0, priced: false, version: 1, expiresAt: C.confirmationDeadline(15 * 60000) };
        st.forms[f.id] = f; return f;
      }, '选择GM收购物品'); return view(snapshot(i.guildId), f);
    }
    const f = draft(s, ref, uid, arg);
    if (action === 'value') {
      const result = await tx(i, st => {
        needGM(st, member); const live = draft(st, ref, uid, arg);
        const quantity = C.number(i.fields.getTextInputValue('quantity'), '收购数量', 1, 100000);
        const price = C.number(i.fields.getTextInputValue('price'), '收购总价', 0, C.MAX_MONEY);
        M.transferable(st, live.target, live.itemId, quantity);
        Object.assign(live, { quantity, price, priced: true, version: live.version + 1 }); return live;
      }, '保存GM收购报价'); return view(snapshot(i.guildId), result);
    }
    if (action === 'back' || action === 'cancel') {
      await tx(i, st => { const live = draft(st, ref, uid, arg); live.done = true; live.version++; }, '取消未提交收购选择');
      return action === 'back' ? list(snapshot(i.guildId), f.target, f.page) : payload('已取消收购', '没有创建报价，也没有转移资产。');
    }
    ok(action === 'confirm', '收购操作无效。');
    const offer = await tx(i, st => {
      needGM(st, member); const live = draft(st, ref, uid, arg); ok(live.priced, '请先填写报价。');
      const offer = M.createOffer(st, uid, live.target, 'buyback', live.itemId, live.quantity, live.price);
      live.done = true; live.offerId = offer.id; return offer;
    }, '发送GM收购报价');
    try { await announceOffer(i, offer); }
    catch { const v = U.offerView(snapshot(i.guildId), offer, uid); v.content = '报价已保存，通知发送失败或待核对。核对频道后可补发同一份报价通知。';
      v.components.push(row(button('buyback:notify:' + offer.id, '核对后补发报价通知'))); return v; }
    return U.offerView(snapshot(i.guildId), offer, uid);
  }
  return { list, openModal, component };
}
module.exports = { availability, createBuyback };
