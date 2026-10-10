"use strict";
const M = require("../rpg/model");

function view(state, corpse, uid) {
  const battle = state.battles[corpse.battleId], player = state.players[uid];
  const ready = battle?.status === "ended" && (!battle.exploration ||
    state.explorations[battle.exploration.mapId]?.cells[battle.exploration.cell]?.room?.encounter === "resolved");
  const blockedReason = !ready ? "战斗或探索遭遇结束后可拾取。" :
    !player || player.hp <= 0 || corpse.eligible?.[uid] !== player.id ? "仅本场参战且仍可行动的原角色可拾取。" :
    M.battleFor(state, uid) ? "当前参战期间不能拾取。" : "";
  return {
    id: corpse.id, battleId: corpse.battleId, battleName: battle?.name || "战斗",
    name: corpse.name, ready: !!ready, canClaim: uid ? !blockedReason : false,
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
module.exports = { view, forBattle, needsBackfill };
