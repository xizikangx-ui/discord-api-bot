import { useLayoutEffect, useRef, useState } from 'react';
import { nearLatest, newMessageCount } from './chat-scroll';

export function useChatScroll(roomId, messages, visible) {
  const list = useRef(null), content = useRef(null), state = useRef({}), latest = useRef(0);
  const [unseen, Unseen] = useState(0);
  latest.current = messages.at(-1)?.sequence || 0;
  if (state.current.roomId !== roomId) state.current = { roomId, pinned: true, initialized: false, seen: 0 };
  function followLatest() {
    state.current.pinned = true;
    state.current.seen = latest.current;
    Unseen(0);
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }
  function onScroll() {
    if (!list.current || !visible) return;
    state.current.pinned = nearLatest(list.current);
    if (state.current.pinned) { state.current.seen = latest.current; Unseen(0); }
  }
  function preserveHistory() {
    const view = list.current;
    if (!view) return;
    const top = view.getBoundingClientRect().top;
    const anchor = [...view.querySelectorAll('[data-message-id]')].find(el => el.getBoundingClientRect().bottom > top);
    if (anchor) state.current.anchor = { id: anchor.dataset.messageId, offset: anchor.getBoundingClientRect().top - top };
  }
  useLayoutEffect(() => {
    const view = list.current, s = state.current;
    if (!view || !visible) return;
    if (s.anchor) {
      const anchor = [...view.querySelectorAll('[data-message-id]')].find(el => el.dataset.messageId === s.anchor.id);
      if (anchor) view.scrollTop += anchor.getBoundingClientRect().top - view.getBoundingClientRect().top - s.anchor.offset;
      s.anchor = null;
    } else if (!s.initialized || s.pinned) followLatest();
    if (messages.length) s.initialized = true;
    Unseen(s.pinned ? 0 : newMessageCount(messages, s.seen));
  }, [roomId, messages, visible]);
  useLayoutEffect(() => {
    if (!visible || !list.current || !content.current) return;
    // Images, expanded result cards and viewport changes can grow the list after the message render.
    const observer = new ResizeObserver(() => { if (state.current.pinned) followLatest(); });
    observer.observe(content.current); observer.observe(list.current);
    return () => observer.disconnect();
  }, [roomId, visible]);
  return { list, content, unseen, followLatest, onScroll, preserveHistory };
}
