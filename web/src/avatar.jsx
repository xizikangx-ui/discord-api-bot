import React, { useEffect, useRef, useState } from 'react';
import { api, id } from './api';
import { avatarUrl, checkAvatarFile } from './avatar-state';
import './avatar.css';

export function Avatar({ avatar, groupId, name = '', symbol, className = '' }) {
  const src = avatarUrl(avatar, groupId), [failed, Failed] = useState('');
  return <span className={'avatar portrait-avatar ' + className} aria-label={symbol ? undefined : name + '的头像'}>{src && failed !== src ? <img key={src} src={src} alt="" loading="lazy" decoding="async" onError={() => Failed(src)} /> : symbol || name.slice(0, 1) || '◇'}</span>;
}

const readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(Error('图片读取失败，请重新选择。'));
  reader.readAsDataURL(file);
});

export function AccountAvatar({ me, groupId, member, onSaved }) {
  const [busy, Busy] = useState(false), [error, ErrorText] = useState(''), [notice, Notice] = useState(''), [retry, Retry] = useState(null);
  const scope = me.user.id + ':' + groupId, active = useRef(scope), generation = useRef(0), locked = useRef(false), alive = useRef(true);
  active.current = scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { generation.current++; locked.current = false; Busy(false); ErrorText(''); Notice(''); Retry(null); }, [scope]);
  const current = member ? member.avatar : me.user.avatar;
  async function save(file, existing, clear = false) {
    if (locked.current) return;
    const target = scope, currentGeneration = generation.current;
    const isCurrent = () => alive.current && active.current === target && generation.current === currentGeneration;
    locked.current = true; Busy(true); ErrorText(''); Notice(''); Retry(null);
    let payload = existing;
    try {
      if (!payload) {
        if (file) checkAvatarFile(file);
        payload = { operationId: id(), baseVersion: member?.avatarVersion ?? me.user.avatarVersion ?? 0, ...(clear ? { clear: true } : { uploadId: id(), data: await readFile(file) }) };
      }
      if (!isCurrent()) return;
      const response = await api('/groups/' + groupId + '/avatar', payload);
      onSaved(response, groupId, me.user.id);
      if (isCurrent()) Notice(clear || payload.clear ? '聊天头像已移除。没有账号头像时使用角色头像。' : '聊天头像已更新，成员列表和聊天会同步显示。');
    } catch (e) {
      if (isCurrent()) {
        ErrorText(e.message || '头像暂时无法更新，请稍后重试。');
        if (payload && !['VALIDATION', 'CONFLICT', 'FORBIDDEN'].includes(e.code)) Retry(payload);
      }
    } finally {
      if (isCurrent()) { locked.current = false; Busy(false); }
    }
  }
  return <section className="panel account-avatar-settings"><h3>聊天头像</h3><div className="account-avatar-row"><Avatar avatar={current} groupId={groupId} name={me.user.displayName || me.user.name} className="account-avatar-preview"/><div><p>玩家和 GM 都可以设置，无需先创建角色。普通聊天优先显示此头像，角色 RP 优先显示角色头像。</p><div className="toolbar"><label className={'upload-button ' + (busy ? 'disabled' : '')}>{busy ? '正在保存头像…' : '上传聊天头像'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void save(file); }}/></label>{current && <button type="button" disabled={busy} onClick={() => save(null, null, true)}>移除聊天头像</button>}</div><small>PNG／JPEG／WebP，最多 4 MiB。此头像随网站账号使用。</small></div></div>{error && <p className="banner error" role="alert">{error}</p>}{retry && <button type="button" disabled={busy} onClick={() => save(null, retry)}>按原请求重试头像保存</button>}{notice && <p role="status">{notice}</p>}</section>;
}
