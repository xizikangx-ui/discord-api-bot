const prefix = 'yichang-restart-draft:';
// Only called for explicit, non-secret form state. It never saves passwords or tokens.
export function readRestartDraft(storage, scope, consume = false) {
  try { const value = JSON.parse(storage.getItem(prefix + scope) || 'null');if(consume)storage.removeItem(prefix+scope); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
export function saveRestartDraft(storage, scope, value) {
  try { storage.setItem(prefix + scope, JSON.stringify(value)); return true; } catch { return false; }
}
export function clearSceneMessages(messages, { mapIds = [], battleIds = [] } = {}) {
  const maps = new Set(mapIds), battles = new Set(battleIds);
  return messages.map(message => maps.has(message.system?.mapId) || battles.has(message.system?.battleId) ? { ...message, system: { cleared: true, kind: 'sceneCleared', label: '场景已清理' } } : message);
}
export function clearSceneGame(game, { mapIds = [], battleIds = [] } = {}) {
  if(!game)return game;
  const maps=new Set(mapIds),battles=new Set(battleIds),next={...game};
  if(Array.isArray(game.maps))next.maps=game.maps.filter(map=>!maps.has(map.id));
  if(Array.isArray(game.battles))next.battles=game.battles.filter(battle=>!battles.has(battle.id));
  if(Array.isArray(game.corpses))next.corpses=game.corpses.filter(corpse=>!battles.has(corpse.battleId));
  if(game.dashboard)next.dashboard={...game.dashboard,map:maps.has(game.dashboard.map?.id)?null:game.dashboard.map,battle:battles.has(game.dashboard.battle?.id)?null:game.dashboard.battle};
  return next;
}
