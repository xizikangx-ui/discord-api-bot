import { useEffect, useRef } from 'react';
import { readRestartDraft, saveRestartDraft } from './restart-drafts';
export function useRestartDraft(scope, value, restore, blocked) {
  const current = useRef(value), restoreRef = useRef(restore),blockedRef=useRef(blocked);
  current.current = value; restoreRef.current = restore;blockedRef.current=blocked;
  useEffect(() => {
    const saved = readRestartDraft(localStorage, scope,true);
    if (saved) restoreRef.current(saved);
    const persist = event => {if(blockedRef.current?.())event.preventDefault();if(!saveRestartDraft(localStorage, scope, current.current))event.preventDefault();};
    window.addEventListener('book:before-restart', persist);
    return () => window.removeEventListener('book:before-restart', persist);
  }, [scope]);
}
