export function nearLatest(view, tolerance = 72) {
  return view.scrollHeight - view.clientHeight - view.scrollTop <= tolerance;
}

export function newMessageCount(messages, sequence) {
  return messages.filter(m => m.sequence > sequence && !m.superseded && !m.deleted).length;
}
