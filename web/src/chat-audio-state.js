export function shouldSend(event, shortcut) {
  return event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229 && !event.shiftKey && !event.altKey &&
    (shortcut === 'enter' ? !event.ctrlKey && !event.metaKey : !!(event.ctrlKey || event.metaKey));
}
export function soundKey(event, self) {
  if (!['message', 'room-unread'].includes(event?.type) || event.data?.authorId === self || event.data?.deleted) return null;
  return event.data?.roomId && event.data?.sequence ? event.data.roomId + ':' + event.data.sequence : null;
}
