export function initialExploreView(game, navigation) {
  if (navigation?.type === 'map') return 'current';
  if (navigation?.type === 'world') return 'world';
  const player = game?.player;
  return player && game.maps?.some(m => ['active', 'paused'].includes(m.status) && m.participants?.[player.userId]?.characterId === player.id) ? 'current' : 'world';
}
