"use strict";
const M = require("../rpg/model");
function ready(state, battle) {
  return !!(battle?.status === 'ended' && (!battle.exploration ||
    state.explorations[battle.exploration.mapId]?.cells[battle.exploration.cell]?.room?.encounter === 'resolved'));
}

function view(state, corpse, uid) {
  const battle = state.battles[corpse.battleId], player = state.players[uid];
  const available = ready(state, battle);
  const blockedReason = !available ? "战斗或探索遭遇结束后可拾取。" :
    !player || player.hp <= 0 || corpse.eligible?.[uid] !== player.id ? "仅本场参战且仍可行动的原角色可拾取。" :
    M.battleFor(state, uid) ? "当前参战期间不能拾取。" : "";
  return {
    id: corpse.id, battleId: corpse.battleId, battleName: battle?.name || "战斗",
    name: corpse.name, ready: available, canClaim: uid ? !blockedReason : false,
    blockedReason: uid ? blockedReason : "仅本场参战角色可拾取。",
    items: corpse.items.map(i => ({ id: i.id, name: i.snapshot?.name || i.name || "物品", quantity: i.quantity || 1, rarity: i.snapshot?.rarity })),
    claims: Object.fromEntries(Object.entries(corpse.claims || {}).map(([id, claim]) => [id, {
      name: state.players[claim.userId]?.id === claim.characterId ? state.players[claim.userId].name : "队友",
    }])),
  };
}
function forBattle(state, battleId, uid) {
  return Object.values(state.corpses || {}).filter(c => c.battleId === battleId).map(c => view(state, c, uid));
}
function needsBackfill(state) {
  return Object.values(state.corpses || {}).some(c => state.battles[c.battleId]?.status === "ended" &&
    c.items.some(i => !c.claims?.[i.id]) && !state.deliveryJobs?.["web:corpses:" + c.battleId]);
}
function rewardSummary(state, battleId) {
  const deaths = Object.values(state.deaths || {}).filter(d => d.battleId === battleId && d.kind === 'npc' && d.team === 'enemy');
  const credited = deaths.filter(d => d.rewarded).reduce((n, d) => n + (d.rewarded.result?.credited || 0), 0);
  const pending = deaths.filter(d => !d.rewarded && d.baseXP > 0).length;
  const lines = [];
  if (credited) lines.push('经验已自动入账：' + credited + '，无需手动领取。');
  else if (deaths.length && deaths.every(d => !d.baseXP)) lines.push('本场敌方基础经验为 0，无经验可领取。');
  else if (deaths.some(d => d.rewarded)) lines.push('经验已结算，实际入账 0；无需手动领取。');
  else if (!pending) lines.push('本场没有已登记的敌方击杀经验。');
  if (pending) lines.push(pending + ' 条击杀经验尚未归属，需 GM 在死亡奖励中指定领取角色。');
  const corpses = Object.values(state.corpses || {}).filter(c => c.battleId === battleId), remaining = corpses.reduce((n, c) => n + c.items.filter(i => !c.claims?.[i.id]).length, 0);
  if (remaining) lines.push('剩余 ' + remaining + ' 项战利品：' + (ready(state, state.battles[battleId]) ? '可在本频道的“战后战利品”卡快速拾取，也可打开战斗面板。' : '探索遭遇全部结束后开放拾取。'));
  else if (corpses.some(c => c.items.length)) lines.push('本场战利品已全部领取。');
  else {
    lines.push('本场无可拾取物品。');
    if (deaths.length) lines.push('掉落规则：仅人形 NPC 掉落已配置的随身实物；非人形 NPC 不掉落随身物品。');
  }
  return lines.join('\n');
}
module.exports = { view, forBattle, needsBackfill, rewardSummary };
