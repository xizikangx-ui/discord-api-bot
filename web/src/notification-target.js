// Navigation is read-only and must never go through the game mutation executor.
export function notificationTarget(system, gm = false) {
  if (system?.battleId) return {tab: gm && system.kind === 'webNotice' ? 'gm' : 'battle',gmTab:'battles',id:system.battleId,type:'battle'};
  if (system?.mapId) return {tab: gm && system.kind === 'webNotice' ? 'gm' : 'explore',gmTab:'maps',id:system.mapId,type:'map',...(system.cell?{cell:system.cell}:{})};
  if (system?.source === 'checks' || system?.source === 'sessions') return {tab:'activities'};
  return null;
}
