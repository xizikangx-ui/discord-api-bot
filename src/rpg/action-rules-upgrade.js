'use strict';
const C = require('./constants'), B = require('./combat'), Layout = require('./encounter-layout');
function migrate(state) {
  if (state.upgrade >= 6) return null;
  const report = { actionRounds: 0, obstacleTemplates: 0, preservedEncounterLayouts: 0 };
  for (const b of Object.values(state.battles)) if (b.status !== 'ended') { B.ensureActionRound(b); report.actionRounds++; }
  for (const room of Object.values(state.roomTemplates || {})) if (!room.obstacles) { room.obstacles = Layout.defaults(room); report.obstacleTemplates++; }
  for (const m of Object.values(state.explorations || {})) for (const cell of Object.values(m.cells)) {
    const room = cell.room, battle = room?.battleId && state.battles[room.battleId];
    if (battle && !room.tacticalLayout) {
      room.tacticalLayout = { version: 1, legacy: true, width: battle.width, height: battle.height, terrain: C.clone(battle.terrain), obstacles: C.clone(battle.roomObstacles || []) };
      report.preservedEncounterLayouts++;
    }
  }
  state.upgrade = 6;
  return report;
}
module.exports = { migrate };
