'use strict';
const C = require('./constants'), M = require('./model');
const { requireThat: ok, clone } = C;
function record(b, message, details) { const entry = { at: Date.now(), message, details }; b.recent.push(entry); b.recent = b.recent.slice(-30); (b.history ||= []).push(clone(entry)); }
function character(state, a) { return a.finalCharacter || (a.userId ? state.players[a.userId] : a.character); }
function reward(state, b, death, uid) {
  ok(death.kind === 'npc' && death.team === 'enemy' && !death.rewarded, '该死亡记录不能重复发放经验。');
  const p = M.player(state, uid);
  ok(p.hp > 0, '不能向死亡角色发放击杀经验。');
  const result = death.baseXP ? M.grantXP(state, uid, death.baseXP) : { xp: 0 };
  death.rewarded = { userId: uid, characterId: p.id, at: Date.now(), result: clone(result) };
  record(b, death.name + '击杀奖励已结算给' + p.name + '，基础经验' + death.baseXP + '，实得' + (result.credited || 0) + '。', { deathId: death.id, characterId: p.id });
  return result;
}
function equipmentRoots(p) {
  const attached = new Set(Object.values(p.inventory).flatMap(i => [...(i.attachments || []), ...(i.magazineId ? [i.magazineId] : [])]));
  const visit = (ref, seen = new Set()) => {
    ok(!seen.has(ref), 'NPC装配关系出现循环。'); seen.add(ref);
    const i = clone(p.inventory[ref]); ok(i, 'NPC装配物品缺失。');
    const parts = [...(i.attachments || []), ...(i.magazineId ? [i.magazineId] : [])];
    if (parts.length) i.bundle = parts.map(id => visit(id, new Set(seen)));
    return i;
  };
  return Object.values(p.inventory).filter(i => i.snapshot.kind !== '技能' && !attached.has(i.id)).map(i => visit(i.id));
}
function settle(state, b, a, sourceReference = null) {
  const sourceId = typeof sourceReference === 'object' ? sourceReference?.actorId || null : sourceReference;
  const p = character(state, a);
  if (!p || p.hp > 0 || a.deathId) return null;
  state.deaths ||= {}; state.corpses ||= {};
  const source = b.actors.find(x => x.id === sourceId), killer = source && character(state, source);
  const killerUserId = sourceReference?.userId || source?.userId, killerCharacterId = sourceReference?.characterId || killer?.id;
  const d = { id: C.id('d'), battleId: b.id, actorId: a.id, characterId: p.id, name: a.name, kind: a.userId ? 'player' : 'npc',
    userId: a.userId || null, team: a.team, baseXP: a.userId ? 0 : a.baseXP || 0, sourceId,
    killerCharacterId: killerCharacterId || null, at: Date.now(), snapshot: clone(p), rewarded: null };
  state.deaths[d.id] = d; a.deathId = d.id; a.retreated = true; a.finalCharacter = clone(p);
  if (!a.userId && a.humanoid) {
    const items = equipmentRoots(p);
    const corpse = { id: C.id('o'), battleId: b.id, deathId: d.id, name: a.name, items, claims: {},
      eligible: Object.fromEntries(b.actors.filter(x => x.userId && !x.deathId).map(x => [x.userId, character(state, x)?.id])),
      createdAt: Date.now(), publication: { status: 'pending' } };
    state.corpses[corpse.id] = corpse; d.corpseId = corpse.id;
    a.character.inventory = {}; a.character.equipped = { weapon: null, armor: [], accessories: [], cards: [] };
  }
  b.queue = (b.queue || []).filter(q => q.actorId !== a.id);
  if (b.current?.actorId === a.id) { b.current = null; delete a.casting; }
  if (b.pending?.attackerId === a.id || b.pending?.targetId === a.id) b.pending = null;
  if (a.userId) {
    for (const offer of Object.values(state.offers)) if (['editing', 'ready'].includes(offer.status) && [offer.creatorId, offer.targetId].includes(a.userId)) offer.status = 'cancelled';
    for (const map of Object.values(state.explorations || {})) if (map.participants?.[a.userId]?.characterId === p.id) delete map.participants[a.userId];
    delete state.players[a.userId]; delete state.characterDrafts[a.userId];
  } else if (a.team === 'enemy' && killerUserId && state.players[killerUserId]?.id === killerCharacterId && state.players[killerUserId].hp > 0) reward(state, b, d, killerUserId);
  record(b, a.name + (a.userId ? '死亡，角色及资产已清空，可重新建卡。' : '死亡。'), { deathId: d.id });
  return d;
}
// Catch non-attack HP changes at the transaction boundary; historical zero HP is untouched.
function reconcile(state, before) {
  for (const b of Object.values(state.battles)) if (b.status !== 'ended' || before.battles[b.id]?.status !== 'ended') {
    for (const a of b.actors) {
      const p = character(state, a), old = before.battles[b.id]?.actors.find(x => x.id === a.id);
      const previous = old && character(before, old);
      if (p?.hp <= 0 && previous?.hp > 0 && !a.deathId) settle(state, b, a);
    }
  }
  for (const [uid, p] of Object.entries(state.players)) if (p.hp <= 0 && before.players[uid]?.id === p.id && before.players[uid].hp > 0) {
    // Noncombat death shares the same cleanup without creating an active battle.
    const actor = { id: C.id('a'), userId: uid, name: p.name, team: 'ally' };
    settle(state, { id: null, actors: [actor], queue: [], recent: [], history: [] }, actor);
  }
  for (const b of Object.values(state.battles)) if (b.status === 'active' && !b.current && !b.pending)
    require('./combat').nextOpportunity(state, b);
}
function claim(state, corpseId, uid, itemId) {
  const c = state.corpses[corpseId], p = M.player(state, uid), b = c && state.battles[c.battleId];
  ok(c && b?.status === 'ended', '战斗结束后才能领取尸体物品。');
  ok(!b.exploration || state.explorations[b.exploration.mapId]?.cells[b.exploration.cell]?.room?.encounter === 'resolved', '探索遭遇尚未解除。');
  ok(p.hp > 0 && c.eligible[uid] === p.id, '仅存活且参加该战斗的原角色可领取。');
  ok(!M.battleFor(state, uid), '参战期间不能领取物资。');
  const item = c.items.find(i => i.id === itemId); ok(item && !c.claims[itemId], '该物品已经领取。');
  M.receive(p, clone(item)); c.claims[itemId] = { userId: uid, characterId: p.id, at: Date.now() };
  return clone(item);
}
module.exports = { character, reward, equipmentRoots, settle, reconcile, claim };
