import { useEffect, useRef } from 'react';
import { soundKey } from './chat-audio-state';
let context;
export async function unlockSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return false;
  context ||= new AudioContext();
  await context.resume();
  return context.state === 'running';
}
export function useMessageSound(userId, enabled) {
  const prefs = useRef({}), seen = useRef(new Set()), last = useRef(0);
  prefs.current = { userId, enabled };
  useEffect(() => { seen.current.clear(); }, [userId]);
  useEffect(() => {
    if (!enabled) return;
    const unlock = () => { void unlockSound().catch(() => {}); };
    document.addEventListener('pointerdown', unlock); document.addEventListener('keydown', unlock);
    return () => { document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock); };
  }, [enabled]);
  return event => {
    const key = soundKey(event, prefs.current.userId);
    if (!key || seen.current.has(key)) return;
    seen.current.add(key);
    if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value);
    if (!prefs.current.enabled || context?.state !== 'running' || Date.now() - last.current < 1200) return;
    last.current = Date.now();
    for (const [offset, frequency] of [[0, 660], [.1, 880]]) {
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + offset;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.075, start + .015); gain.gain.exponentialRampToValueAtTime(.001, start + .15);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + .17);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  };
}
