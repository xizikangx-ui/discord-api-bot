export function avatarSource(message, member) {
  // A current member is authoritative, including an explicitly cleared avatar.
  const account = member ? member.avatar : message?.accountAvatar;
  const character = member ? member.characterAvatar : message?.characterAvatar;
  return message?.kind === 'rp' ? character || account || (!member && message?.avatar) || null : account || character || (!member && message?.avatar) || null;
}

export function avatarUrl(avatar, groupId) {
  if (!avatar?.webMediaId || !groupId) return '';
  return '/api/web/v1/media/' + encodeURIComponent(avatar.webMediaId) + '?groupId=' + encodeURIComponent(groupId) + '&v=' + encodeURIComponent(avatar.version || 0)+(avatar.messageId?'&messageId='+encodeURIComponent(avatar.messageId):'');
}

export function checkAvatarFile(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('头像请选择 PNG、JPEG 或 WebP 图片。');
  if (file.size > 4 * 1024 * 1024) throw Error('头像最多 4 MiB。');
  if (!file.size) throw Error('图片文件为空，请重新选择。');
}

export function mergeAvatarMembers(previous, incoming) {
  const known = new Map(previous.map(member => [member.userId, member]));
  return incoming.map(member => {
    const old = known.get(member.userId);
    return old && (old.avatarVersion || 0) > (member.avatarVersion || 0)
      ? { ...member, avatar: old.avatar, avatarVersion: old.avatarVersion }
      : member;
  });
}
