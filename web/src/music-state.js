export const musicCategories = { battle: '战斗音乐', event: '事件音乐', other: '其他音乐' };
export const playbackSignature = state => state ? [state.trackId, state.status, state.startedAt, state.position, !!state.loop].join(':') : '';
export function mergeMusicSnapshot(current, incoming) {
  if (!current) return incoming;
  const currentVersion=current.playback?.version||0,incomingVersion=incoming.playback?.version||0,
    keepPlayback=incomingVersion<currentVersion||incomingVersion===currentVersion&&(incoming.playback?.libraryVersion||0)<(current.playback?.libraryVersion||0),
    keepCatalog=(incoming.library?.version||0)<(current.library?.version||0);
  return {...incoming,...(keepCatalog?{tracks:current.tracks,library:current.library}:{}),...(keepPlayback?{playback:current.playback,serverTime:current.serverTime,receivedAt:current.receivedAt}:{})};
}
export function playbackPosition(library, now = Date.now(), duration = Infinity) {
  const state = library?.playback;
  if (!state) return 0;
  const elapsed = state.status === 'playing' && Number.isFinite(state.startedAt)
    ? Math.max(0, (library.serverTime || now) - state.startedAt + now - (library.receivedAt || now)) / 1000 : 0;
  const value = Math.max(0, (state.position || 0) + elapsed);
  return Number.isFinite(duration) && duration > 0 ? (state.loop ? value % duration : Math.min(value, duration)) : value;
}
export function trackPlaybackAction(state, trackId, restart = false) {
  if (restart) return { action: 'play', trackId, position: 0 };
  return state?.trackId === trackId && ['playing', 'paused'].includes(state.status)
    ? { action: 'resume', trackId } : { action: 'play', trackId };
}
export function musicTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}
