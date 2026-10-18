import React, { useEffect, useRef, useState } from 'react';
import { api, id } from './api';
import { unlockSound } from './chat-audio';
import {musicCategories as categories, playbackSignature, playbackPosition, trackPlaybackAction, musicTime, mergeMusicSnapshot} from './music-state';
import './music.css';
const fileData = f => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(Error('音频文件读取失败。')); r.readAsDataURL(f); });

export function GroupMusic({ groupId, userId, gm, event, preferences, onPreferences }) {
  const [library, Library] = useState(null), [enabled, Enabled] = useState(false), [volume, Volume] = useState(() => Number(localStorage.getItem('book-music-volume:' + userId) ?? .35)),
    [category, Category] = useState('battle'), [name, Name] = useState(''), [loop, Loop] = useState(true), [busy, Busy] = useState(false), [error, ErrorText] = useState(''), [info, Info] = useState(''), [retry, Retry] = useState(null),
    [selected, Selected] = useState(''), [filter, Filter] = useState('all'), [search, Search] = useState(''), [progress, Progress] = useState({position:0,duration:0});
  const player = useRef(null), latest = useRef(null), generation = useRef(0), request = useRef(0), uploadLock = useRef(false), scope = useRef(groupId), listening = useRef(false), source = useRef(''), applied = useRef('');
  scope.current = groupId; latest.current = library; listening.current = enabled;
  const state = library?.playback, tracks = library?.tracks || [], track = tracks.find(t => t.id === state?.trackId), chosen = tracks.find(t => t.id === selected && !t.retired);
  async function load() {
    const target = groupId, sequence = ++request.current;
    let data;try{data=await api('/groups/' + target + '/music');}catch(e){if(scope.current===target&&request.current===sequence)throw e;return;}
    if (scope.current === target && request.current === sequence) {
      Library(old=>mergeMusicSnapshot(old,{ ...data, receivedAt: Date.now() }));
      Selected(old => data.tracks.some(t => t.id === old && !t.retired) ? old : data.tracks.find(t => t.id === data.playback?.trackId && !t.retired)?.id || data.tracks.find(t=>!t.retired)?.id || '');
    }
  }
  function sync(force = false) {
    const audio = player.current, current = latest.current, s = current?.playback, currentTrack = current?.tracks.find(t=>t.id===s?.trackId && !t.retired);
    if (!audio) return;
    if (!listening.current || !s || !currentTrack || s.status === 'stopped') { audio.pause(); return; }
    const url = '/api/web/v1/groups/' + scope.current + '/music/files/' + currentTrack.id;
    if (source.current !== url) { audio.pause(); source.current = url; applied.current = ''; audio.src = url; audio.load(); force = true; }
    audio.loop = !!s.loop;
    const signature = playbackSignature(s), position = playbackPosition(current, Date.now(), audio.duration);
    // Metadata or library refreshes never restart a playing song.
    if (Number.isFinite(audio.duration) && audio.duration > 0 && (force || applied.current !== signature)) {
      if (Math.abs(audio.currentTime - position) > .65) audio.currentTime = position;
      applied.current = signature;
    }
    if (s.status !== 'playing') { audio.pause(); return; }
    if (!s.loop && Number.isFinite(audio.duration) && position >= audio.duration) { audio.pause(); Info('本曲已结束，请选择下一首。'); return; }
    if (audio.paused) void audio.play().then(() => ErrorText('')).catch(() => { if(source.current!==url||!listening.current||latest.current?.playback?.status!=='playing'||playbackSignature(latest.current.playback)!==signature)return;ErrorText('浏览器阻止了播放，请点击“收听音乐”。'); Enabled(false); listening.current=false; });
  }
  useEffect(() => {
    generation.current++; request.current++; Library(null); Enabled(false); Selected(''); ErrorText(''); Info(''); Retry(null); Busy(false); uploadLock.current = false; source.current='';applied.current='';Progress({position:0,duration:0});
    void load().catch(e => ErrorText(e.message));
    return () => { generation.current++; request.current++; listening.current=false; if (player.current) { player.current.pause(); player.current.removeAttribute('src'); player.current.load(); } };
  }, [groupId]);
  useEffect(() => { if (event?.type === 'reconnect' || event?.type === 'music' && (!event.data?.groupId || event.data.groupId === groupId || event.data.library)) void load().catch(e => ErrorText(e.message)); }, [event]);
  useEffect(() => { if (player.current) player.current.volume = Math.max(0, Math.min(1, volume)); }, [volume]);
  useEffect(() => { sync(); }, [enabled, playbackSignature(state), track?.id]);
  async function listen() {
    if (enabled) { listening.current=false; Enabled(false); player.current?.pause(); return; }
    listening.current=true; Enabled(true); ErrorText(''); void unlockSound().catch(()=>false); sync(true);
  }
  async function control(action, target, extra = {}) {
    if (uploadLock.current || !library) return;
    const targetGroup = groupId, token = generation.current, payload = { action, trackId: target?.id, baseVersion: library.playback.version, ...(target?{trackVersion:target.version}:{}), operationId: id(), ...extra };
    uploadLock.current = true; Busy(true); ErrorText(''); Info('');
    try {
      const result = await api('/groups/' + targetGroup + '/music/control', payload);
      if (generation.current === token) {
        if(result.playback)Library(old=>old?mergeMusicSnapshot(old,{...old,playback:result.playback,serverTime:result.serverTime,receivedAt:Date.now()}):old);
        Info(({pause:'全团已暂停，继续时会从暂停处播放。',resume:'全团已继续播放。',stop:'全团已停止。',retire:'已停用，曲目仍在下方“已停用曲目”中，可以恢复。',restore:'曲目已恢复到共享曲库。',play:'全团播放安排已保存。',edit:'曲目信息已保存。'})[action]||'已保存。');
        void load().catch(()=>{});
      }
    } catch (e) { if (generation.current === token) { ErrorText(e.message); void load().catch(() => {}); } }
    finally { if (generation.current === token) { Busy(false); uploadLock.current = false; } }
  }
  function playSelected(restart=false) {if(!chosen)return;const p=trackPlaybackAction(state,chosen.id,restart);void control(p.action,chosen,p.position===undefined?{}:{position:p.position});}
  async function upload(file, existing) {
    if (uploadLock.current) return;
    const token = generation.current, target = groupId;
    uploadLock.current = true; Busy(true); ErrorText(''); Info(''); Retry(null);
    let payload = existing;
    try {
      if (!payload) {
        if (file.size > (library?.library?.maxTrackBytes || 12 * 1024 * 1024)) throw Error('单首音乐最多 12 MiB，请使用 MP3、WAV 或 Ogg。');
        payload = { operationId: id(), name: name.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 80), category, loop, data: await fileData(file) };
      }
      if (generation.current !== token) return;
      const result=await api('/groups/' + target + '/music/upload', payload, { timeoutMs: 120000 });
      if (generation.current === token) { await load(); if(result.id)Selected(result.id);Info('音乐已加入全站共享曲库；请选择后播放。'); Name(''); }
    } catch (e) { if (generation.current === token) { ErrorText(e.message); if (payload && !['VALIDATION', 'FORBIDDEN', 'CONFLICT'].includes(e.code)) Retry(payload); } }
    finally { if (generation.current === token) { Busy(false); uploadLock.current = false; } }
  }
  const filtered=tracks.filter(t=>!t.retired&&(filter==='all'||filter===t.category)&&(!search.trim()||t.name.toLowerCase().includes(search.trim().toLowerCase()))), retired=tracks.filter(t=>t.retired);
  return <div className="music-dock"><details className="group-music"><summary><span>♫ {track ? track.name + (state.status === 'paused' ? ' · 全团暂停' : state.status==='playing'?' · 播放中':' · 已停止') : '音乐与提示音'}</span><small>{enabled?'正在收听':'收听已关'} ▾</small></summary>
    <div className="music-listener"><button type="button" className={enabled?'':'primary'} onClick={listen}>{enabled ? '暂停我的收听' : '收听音乐'}</button><label>我的音量 <input aria-label="音乐音量" type="range" min="0" max="1" step=".05" value={volume} onChange={e => { Volume(+e.target.value); localStorage.setItem('book-music-volume:' + userId, e.target.value); }}/></label><label><input type="checkbox" checked={preferences.messageSound === true} onChange={e => { if(e.target.checked)void unlockSound(); onPreferences({ messageSound: e.target.checked }); }}/>新消息提示音</label></div>
    <small>曲库全站共用，各团独立播放；玩家需先点击收听。我的收听和音量仅影响自己。</small>
    {track&&<div className="music-progress"><span>{musicTime(progress.position)}</span><progress max={progress.duration||1} value={progress.position}/><span>{musicTime(progress.duration)}</span></div>}
    <audio ref={player} preload="none" onLoadedMetadata={()=>sync(true)} onTimeUpdate={()=>{const a=player.current;if(a)Progress({position:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:0});}} onError={() => { if(enabled)ErrorText('音乐暂时无法读取，请检查连接或请 GM 更换音频。'); }}/>
    {gm && <div className="music-management"><h4>本团播放</h4><div className="toolbar"><button disabled={busy || state?.status !== 'playing'} onClick={() => control('pause')}>全团暂停</button><button disabled={busy || !track || state?.status!=='paused'} onClick={() => control('resume')}>从暂停处继续</button><button disabled={busy || !track} onClick={() => control('stop')}>全团停止</button></div>
      <h4>共享曲库 <small>{((library?.library?.bytes||0)/1048576).toFixed(1)} / {Math.round((library?.library?.maxBytes||300*1048576)/1048576)} MiB</small></h4>
      <div className="music-search"><input aria-label="搜索音乐" placeholder="搜索曲名" value={search} onChange={e=>Search(e.target.value)}/><select aria-label="筛选音乐用途" value={filter} onChange={e=>Filter(e.target.value)}><option value="all">全部用途</option>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>
      <select className="music-choice" aria-label="选择播放曲目" value={chosen?.id||''} onChange={e=>Selected(e.target.value)}><option value="">选择一首音乐</option>{filtered.map(t=><option key={t.id} value={t.id}>{t.name} · {categories[t.category]}</option>)}{chosen&&!filtered.some(t=>t.id===chosen.id)&&<option value={chosen.id}>{chosen.name}（当前选择）</option>}</select>
      <div className="toolbar"><button className="primary" disabled={busy||!chosen||chosen.id===track?.id&&state?.status==='playing'} onClick={()=>playSelected()}>{chosen?.id===track?.id&&state?.status==='paused'?'继续这首':chosen?.id===track?.id&&state?.status==='playing'?'正在播放这首':'播放所选音乐'}</button><button disabled={busy||!chosen} onClick={()=>playSelected(true)}>从头播放所选</button></div>
      {chosen&&<div className="music-track-edit"><b>{chosen.name}</b><small>{categories[chosen.category]} · {(chosen.bytes/1048576).toFixed(1)} MiB · {chosen.loop?'循环':'单次'}</small>{chosen.canManage&&<div className="toolbar"><select aria-label={chosen.name+'用途'} disabled={busy} value={chosen.category} onChange={e=>control('edit',chosen,{name:chosen.name,category:e.target.value,loop:chosen.loop})}>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><label><input type="checkbox" checked={chosen.loop} disabled={busy} onChange={e=>control('edit',chosen,{name:chosen.name,category:chosen.category,loop:e.target.checked})}/>循环</label><button disabled={busy} onClick={()=>control('retire',chosen)}>停用（保留曲目）</button></div>}</div>}
      {!!retired.length&&<details className="music-retired"><summary>已停用曲目 · {retired.length} 首（未删除）</summary>{retired.map(t=><div key={t.id}><span>{t.name}</span>{t.canManage?<button disabled={busy} onClick={()=>control('restore',t)}>恢复启用</button>:<small>由上传者或管理员恢复</small>}</div>)}</details>}
      <details className="music-upload-section"><summary>＋ 上传到共享曲库</summary><div className="music-upload"><label>音乐名称<input maxLength={80} value={name} onChange={e => Name(e.target.value)} placeholder="留空使用文件名"/></label><label>用途<select aria-label="上传音乐分类" value={category} onChange={e => Category(e.target.value)}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label><input type="checkbox" checked={loop} onChange={e => Loop(e.target.checked)}/>循环播放</label><label className="upload-button">{busy ? '处理中…' : '选择音频并上传'}<input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,.mp3,.wav,.ogg" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if(f)void upload(f); }}/></label></div><small>MP3／WAV／Ogg，每首最多 12 MiB；全站曲库合计 300 MiB。停用不会删除文件或释放容量。请上传有权使用的音乐。</small>{retry && <button disabled={busy} onClick={() => upload(null, retry)}>按原请求核对并重试上传</button>}</details>
    </div>}
    {error && <p role="alert">{error}</p>}{info && <p role="status">{info}</p>}
  </details></div>;
}
