import React, { useEffect, useRef, useState } from 'react';
import { api, id } from './api';
import { unlockSound } from './chat-audio';
import './music.css';
const categories = { battle: '战斗音乐', event: '事件音乐', other: '其他音乐' };
const fileData = f => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(Error('音频文件读取失败。')); r.readAsDataURL(f); });

export function GroupMusic({ groupId, userId, gm, event, preferences, onPreferences }) {
  const [library, Library] = useState(null), [enabled, Enabled] = useState(false), [volume, Volume] = useState(() => Number(localStorage.getItem('book-music-volume:' + userId) ?? .35)),
    [category, Category] = useState('battle'), [name, Name] = useState(''), [loop, Loop] = useState(true), [busy, Busy] = useState(false), [error, ErrorText] = useState(''), [info, Info] = useState(''), [retry, Retry] = useState(null);
  const player = useRef(null), latest = useRef(null), generation = useRef(0), request = useRef(0), uploadLock = useRef(false), scope = useRef(groupId);
  scope.current = groupId; latest.current = library;
  async function load() {
    const target = groupId, sequence = ++request.current;
    const data = await api('/groups/' + groupId + '/music');
    if (scope.current === target && request.current === sequence) Library({ ...data, receivedAt: Date.now() });
  }
  useEffect(() => { generation.current++; Library(null); Enabled(false); ErrorText(''); Info(''); Retry(null); Busy(false); uploadLock.current = false; void load().catch(e => ErrorText(e.message)); return () => { generation.current++; if (player.current) { player.current.pause(); player.current.removeAttribute('src'); player.current.load(); } }; }, [groupId]);
  useEffect(() => { if (event?.type === 'reconnect' || (event?.type === 'music' && event.data?.groupId === groupId)) void load().catch(e => ErrorText(e.message)); }, [event]);
  const state = library?.playback, track = library?.tracks.find(t => t.id === state?.trackId);
  function sync() {
    const audio = player.current, current = latest.current, s = current?.playback;
    if (!audio || !enabled || !s || s.status !== 'playing' || !track) { audio?.pause(); return; }
    const offset = s.position + Math.max(0, current.serverTime - s.startedAt + Date.now() - current.receivedAt) / 1000;
    audio.loop = !!s.loop;
    if(!s.loop&&Number.isFinite(audio.duration)&&offset>=audio.duration){audio.pause();audio.currentTime=audio.duration;Info('本曲已播放完，等待 GM 安排下一首。');return;}
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = s.loop ? offset % audio.duration : Math.min(offset, audio.duration);
    void audio.play().then(() => ErrorText('')).catch(() => { ErrorText('浏览器暂停了音乐，请点击“收听音乐”重新启用。'); Enabled(false); });
  }
  useEffect(() => { if (player.current) player.current.volume = Math.max(0, Math.min(1, volume)); }, [volume]);
  useEffect(() => { sync(); }, [enabled, state?.version]);
  async function listen() {
    if (enabled) { Enabled(false); player.current?.pause(); return; }
    await unlockSound().catch(() => false);
    // Call play inside the user gesture; metadata will seek to the authoritative position.
    if (track && player.current) { player.current.src = '/api/web/v1/groups/' + groupId + '/music/files/' + track.id; void player.current.play().catch(() => {}); }
    Enabled(true);
  }
  async function control(action, target, extra = {}) {
    if (uploadLock.current || !library) return;
    const targetGroup = groupId, token = generation.current, payload = { action, trackId: target?.id, baseVersion: library.playback.version, operationId: id(), ...extra };
    uploadLock.current = true; Busy(true); ErrorText(''); Info('');
    try { await api('/groups/' + targetGroup + '/music/control', payload); if (generation.current === token) { await load(); Info('音乐安排已保存。'); } }
    catch (e) { if (generation.current === token) { ErrorText(e.message); void load().catch(() => {}); } }
    finally { if (generation.current === token) { Busy(false); uploadLock.current = false; } }
  }
  async function upload(file, existing) {
    if (uploadLock.current) return;
    const token = generation.current, target = groupId;
    uploadLock.current = true; Busy(true); ErrorText(''); Info(''); Retry(null);
    let payload = existing;
    try {
      if (!payload) {
        if (file.size > 12 * 1024 * 1024) throw Error('单首音乐最多 12 MiB，请使用 MP3、WAV 或 Ogg。');
        payload = { operationId: id(), name: name.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 80), category, loop, data: await fileData(file) };
      }
      if (generation.current !== token) return;
      await api('/groups/' + target + '/music/upload', payload, { timeoutMs: 120000 });
      if (generation.current === token) { await load(); Info('音乐已加入本团曲库。'); Name(''); }
    } catch (e) { if (generation.current === token) { ErrorText(e.message); if (payload && !['VALIDATION', 'FORBIDDEN', 'CONFLICT'].includes(e.code)) Retry(payload); } }
    finally { if (generation.current === token) { Busy(false); uploadLock.current = false; } }
  }
  return <div className="music-dock"><details className="group-music"><summary>♫ {track ? track.name + (state.status === 'paused' ? ' · 已暂停' : ' · 播放中') : '团内音乐与提示音'}{enabled ? ' · 收听已开' : ''}</summary>
    <div className="music-listener"><button type="button" onClick={listen}>{enabled ? '关闭收听' : '收听音乐'}</button><label>我的音量 <input aria-label="音乐音量" type="range" min="0" max="1" step=".05" value={volume} onChange={e => { Volume(+e.target.value); localStorage.setItem('book-music-volume:' + userId, e.target.value); }}/></label><label><input type="checkbox" checked={preferences.messageSound === true} onChange={e => { if(e.target.checked)void unlockSound(); onPreferences({ messageSound: e.target.checked }); }}/>新消息提示音</label></div>
    <small>点击收听后跟随 GM 播放；音量只影响你自己。刷新页面后需再次启用。音乐属于本团，不向其他团或 Discord 播放。</small>

    <audio ref={player} src={enabled && track ? '/api/web/v1/groups/' + groupId + '/music/files/' + track.id : undefined} preload="none" onLoadedMetadata={sync} onDurationChange={sync} onError={() => { if(enabled)ErrorText('音乐暂时无法读取，请检查连接或请 GM 更换音频。'); }}/>
    {gm && <div className="music-management"><h4>GM 音乐安排</h4><div className="toolbar"><button disabled={busy || state?.status !== 'playing'} onClick={() => control('pause')}>全团暂停</button><button disabled={busy || !track || state?.status!=='paused'} onClick={() => control('play', track)}>继续播放</button><button disabled={busy || !track} onClick={() => control('stop')}>全团停止</button></div><div className="music-upload"><label>音乐名称<input maxLength={80} value={name} onChange={e => Name(e.target.value)} placeholder="留空使用文件名"/></label><label>用途<select aria-label="音乐分类" value={category} onChange={e => Category(e.target.value)}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label><input type="checkbox" checked={loop} onChange={e => Loop(e.target.checked)}/>循环播放</label><label className="upload-button">{busy ? '处理中…' : '上传音乐'}<input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,.mp3,.wav,.ogg" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if(f)void upload(f); }}/></label></div><small>MP3／WAV／Ogg，每首最多 12 MiB；每团最多 30 首、合计 120 MiB。请上传你有权使用的音乐。</small>{retry && <button disabled={busy} onClick={() => upload(null, retry)}>按原请求核对并重试上传</button>}<div className="music-tracks">{library?.tracks.filter(t => !t.retired).map(t => <div key={t.id}><div><b>{t.name}</b><small>{categories[t.category]} · {(t.bytes / 1048576).toFixed(1)} MiB{t.loop ? ' · 循环' : ''}</small></div><button disabled={busy} onClick={() => control('play', t, { position: 0 })}>播放给全团</button><select aria-label={t.name + '用途'} value={t.category} disabled={busy} onChange={e => control('edit', t, { name: t.name, category: e.target.value, loop: t.loop })}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button disabled={busy} onClick={() => control('retire', t)}>停用</button></div>)}</div>{library?.tracks.some(t=>t.retired)&&<details><summary>已停用曲目</summary>{library.tracks.filter(t=>t.retired).map(t=><div key={t.id}>{t.name} <button disabled={busy} onClick={()=>control('restore',t)}>恢复曲目</button></div>)}</details>}</div>}
    {error && <p role="alert">{error}</p>}{info && <p role="status">{info}</p>}
  </details></div>;
}
