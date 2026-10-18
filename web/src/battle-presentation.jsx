import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { actionStyle, battleStatus, createBattleFeedbackTracker, damageLabels, defenseRemaining, mergeBattleCues, resultRows } from './battle-presentation-state';
import './battle-presentation.css';

const noop = () => {}, emptyController = { configure: noop, reconnect: noop, baseline: noop, ingest: noop,clear:noop,ready:()=>false }, modes = { full: '完整动效', reduced: '简化动效', off: '关闭动效' };
const Feedback = createContext({ controller: emptyController, mode: 'full', effectiveMode: 'full', setMode: noop, current: null, last: null, waiting: [] });
const modeKey = scope => 'yichang-battle-motion:' + scope;
export function BattlePresentationProvider({ children }) {
  const tracker = useRef(createBattleFeedbackTracker()), scope = useRef(''), waitingRef = useRef(new Map()), clearedRef=useRef(new Set()),modeRef = useRef('full'), onModeChange = useRef(null);
  const [queue, Queue] = useState([]), [last, Last] = useState(null), [waiting, Waiting] = useState([]), [mode, Mode] = useState('full');
  const [systemReduced, SystemReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { if (typeof matchMedia === 'undefined') return; const media = matchMedia('(prefers-reduced-motion: reduce)'), update = () => SystemReduced(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  modeRef.current = mode;
  const setMode = useCallback(next => { if (!modes[next]) return;modeRef.current=next; Mode(next); if (next === 'off') Queue([]); try { localStorage.setItem(modeKey(scope.current), next); } catch {} onModeChange.current?.(next); }, []);
  useEffect(()=>{if(mode==='off')Queue([]);},[mode]);
  const controller = useMemo(() => ({
    configure(next, options = {}) {
      onModeChange.current = options.onModeChange || null;
      if (scope.current === next) { if (modes[options.mode]) Mode(options.mode); return; }
      scope.current = next; tracker.current.connect(next); waitingRef.current.clear();clearedRef.current.clear(); Waiting([]); Queue([]); Last(null);
      let saved; try { saved = localStorage.getItem(modeKey(next)); } catch {}
      Mode(modes[options.mode] ? options.mode : modes[saved] ? saved : 'full');
    },
    reconnect() { tracker.current.connect(scope.current); Queue([]); Last(null); waitingRef.current.clear(); Waiting([]); },
    baseline(items) { tracker.current.baseline(items || []);let changed=false;for(const entry of items||[])for(const id of entry.settledHitIds||[])changed=waitingRef.current.delete(entry.battleId+':'+id)||changed;if(changed)Waiting([...waitingRef.current.values()]); },
    ready() { return tracker.current.ready(); },
    clear(battleIds) { const removed=new Set(battleIds);for(const id of removed)clearedRef.current.add(id);while(clearedRef.current.size>1000)clearedRef.current.delete(clearedRef.current.values().next().value);Queue(old=>old.filter(c=>!removed.has(c.battleId)));Last(old=>removed.has(old?.battleId)?null:old);for(const [key,hit] of waitingRef.current)if(removed.has(hit.battleId))waitingRef.current.delete(key);Waiting([...waitingRef.current.values()]); },
    ingest(items, options) {
      const cues = tracker.current.ingest(items, options).filter(cue=>!clearedRef.current.has(cue.battleId));
      if (!cues.length) return;
      for (const cue of cues) for (const hit of cue.hits) {
        const key = cue.battleId + ':' + hit.id;
        if (cue.phase === 'launch') waitingRef.current.set(key, { ...hit, battleId: cue.battleId, ability: cue.ability });
        else if (['settle', 'heal', 'death'].includes(cue.phase)) waitingRef.current.delete(key);
      }
      while (waitingRef.current.size > 40) waitingRef.current.delete(waitingRef.current.keys().next().value);
      Waiting([...waitingRef.current.values()]); Last(cues.findLast(cue=>cue.killed)||cues.findLast(cue=>['settle','death','heal'].includes(cue.phase))||cues.at(-1));
      if (modeRef.current !== 'off') Queue(old => {
        if (!old.length) return mergeBattleCues(cues, 8);
        return [old[0], ...mergeBattleCues([...old.slice(1), ...cues], 7)];
      });
    },
  }), []);
  const current = queue[0] || null, effectiveMode = mode === 'off' ? 'off' : systemReduced ? 'reduced' : mode;
  useEffect(() => { if (!current) return; const timer = setTimeout(() => Queue(old => old[0]?.id === current.id ? old.slice(1) : old), effectiveMode === 'reduced' ? 850 : 1800); return () => clearTimeout(timer); }, [current?.id, effectiveMode]);
  return <Feedback.Provider value={{ controller, mode, effectiveMode, setMode, current, last, waiting, systemReduced }}>{children}</Feedback.Provider>;
}
export const useBattleFeedback = () => useContext(Feedback).controller;

export function BattleEffectsSettings({ compact = false }) {
  const { mode, setMode, systemReduced } = useContext(Feedback);
  return <label className={'battle-motion-setting ' + (compact ? 'compact' : '')}><span>战斗表现</span><select aria-label="战斗动效" value={mode} onChange={e => setMode(e.target.value)}>{Object.entries(modes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{systemReduced && mode === 'full' && <small>已遵循系统“减少动态效果”</small>}</label>;
}

function Figure({ side, hit = false, downed = false, dead = false, shield = false }) {
  return <g className={'combat-figure ' + side + (hit ? ' hit' : '') + (downed ? ' downed' : '') + (dead ? ' dead' : '')} transform={side === 'attacker' ? 'translate(145 95)' : 'translate(565 95)'}><ellipse cx="0" cy="65" rx="43" ry="9" fill="currentColor" opacity=".17"/><g className="figure-body"><path d="M-20 14 Q0 2 20 14 L31 48 13 43 11 63 -5 63 -10 38 -25 48Z" fill="currentColor" opacity=".8"/><circle cy="-2" r="14" fill="currentColor"/><path d="M-9-4 1-8 12-3" fill="none" stroke="#eaf8ff" strokeWidth="2"/><path d="M-15 18-34 43M17 18 37 32" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round"/><path d={side === 'attacker' ? 'M32 26 61 5 66 9 40 34' : 'M-31 23-45 1-49 3-41 34'} fill="#cad5f2"/></g>{shield && <path className="combat-shield" d="M-44-14 Q0-31 44-14 L38 36 Q0 76-38 36Z" fill="#9fe6ff18" stroke="#a8eaff" strokeWidth="2"/>}</g>;
}

export function CombatArtwork({ cue, animated = true, reduced = false }) {
  const style = cue.style || actionStyle(), settled = ['settle', 'death', 'heal'].includes(cue.phase), shoot = style.projectile && cue.phase === 'launch', strike = !style.projectile && style.physical && cue.phase === 'launch', healing = cue.phase === 'heal';
  const id = 'battle-art-' + String(cue.id || cue.eventId || 'still').replace(/[^a-zA-Z0-9]/g, '').slice(-44);
  const targetNames = cue.targets?.slice(0, 3).join('、') || '目标';
  const number = cue.dodge ? '闪避' : cue.phase === 'death' ? cue.killed?'击杀':'死亡' : healing ? '+' + ((cue.healed || 0) + (cue.rows?.[0]?.reserveHealed || 0)) : settled && cue.damage !== null ? '−' + (cue.damage || 0) : '';
  return <svg className={'combat-artwork phase-' + cue.phase + (animated ? ' is-animating' : ' is-still') + (reduced ? ' motion-reduced' : '') + (cue.killed ? ' confirmed-kill' : '') + (cue.full ? ' full-damage' : '') + (healing ? ' healing' : '')} viewBox="0 0 720 224" role="img" aria-label={cue.title + '：' + cue.actor + ' → ' + targetNames}>
    <defs><linearGradient id={id + 'ground'} x2="1" y2="1"><stop stopColor="#151d3c"/><stop offset="1" stopColor="#0b1729"/></linearGradient><radialGradient id={id + 'burst'}><stop stopColor={healing ? '#ccffe6' : cue.killed ? '#fff4c2' : style.magical ? '#f9c7ff' : '#e5f9ff'} stopOpacity=".85"/><stop offset=".38" stopColor={healing ? '#55e5c1' : cue.killed ? '#ff4a7e' : '#ab7bff'} stopOpacity=".35"/><stop offset="1" stopColor="#a4c7ff" stopOpacity="0"/></radialGradient><linearGradient id={id + 'beam'}><stop stopColor="#a1dfff" stopOpacity="0"/><stop offset=".6" stopColor={style.mental ? '#d996ff' : '#c6f5ff'}/><stop offset="1" stopColor="#fff"/></linearGradient><pattern id={id + 'grid'} width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#9bafe0" strokeOpacity=".09"/></pattern></defs>
    <rect width="720" height="224" rx="18" fill={'url(#' + id + 'ground)'}/><rect width="720" height="224" rx="18" fill={'url(#' + id + 'grid)'}/><path d="M0 175 118 159 271 177 440 151 610 169 720 153V224H0Z" fill="#121e36"/><ellipse cx="360" cy="178" rx="290" ry="24" fill="none" stroke="#a9c0ef" strokeOpacity=".16"/>
    <g className="combat-stars" fill="#c5dbff">{[44,111,208,277,349,427,503,618,676].map((x, i) => <circle key={x} cx={x} cy={28 + i * 17 % 82} r={i % 3 === 0 ? 1.8 : 1}/>)}</g>
    <text className="combat-actor-name" x="145" y="204" textAnchor="middle">{cue.actor.slice(0, 13)}</text><text className="combat-actor-name target-name" x="565" y="204" textAnchor="middle">{targetNames.slice(0, 18)}{cue.targets?.length > 3 ? ' 等' + cue.targets.length + '人' : ''}</text>
    <Figure side="attacker"/><Figure side="target" hit={settled && !cue.dodge && !healing} downed={cue.downed} dead={cue.killed||cue.phase==='death'} shield={cue.dodge}/>
    {style.magical && <g className="spell-sigil" transform="translate(350 106)"><g className="sigil-rotation"><circle r="66"/><circle r="54" strokeDasharray="3 8"/><path d="M0-63 55 32-55 32ZM0 63-55-32H55Z"/><path d="M-78 0H78M0-78V78" opacity=".55"/><g className="rune-letters">{['✧','ᚨ','ᚱ','ᚷ','✦','ᚹ'].map((r, i) => <text key={i} x={Math.cos(i * Math.PI / 3) * 79} y={Math.sin(i * Math.PI / 3) * 79 + 5} textAnchor="middle">{r}</text>)}</g></g><circle className="spell-core" r="22"/></g>}
    {style.mental && <g className="mental-waves" transform="translate(399 110)">{[0,1,2,3].map(i => <ellipse key={i} cx={i * 24 - 46} rx={26 + i * 8} ry={40 + i * 11} style={{ '--wave': i }}/>) }<path d="M-100 0Q-72-32-45 0T10 0T66 0T120 0"/><path d="M-100 8Q-72 40-45 8T10 8T66 8T120 8" className="mental-secondary"/></g>}
    {shoot && <g className="bullet-stream">{Array.from({ length: Math.min(5, cue.shotCount || 1) }, (_, i) => <g key={i} style={{ '--shot': i }}><path d={'M198 ' + (102 + i % 3 * 5) + 'H554'} stroke={'url(#' + id + 'beam)'} strokeWidth={i ? '2' : '4'}/><path d="M200 98 223 105 201 112 207 105Z" fill="#fff2ab"/></g>)}</g>}
    {strike && <g className="slash-arcs"><path d="M259 27Q468 48 515 154Q383 133 259 27Z"/><path d="M251 51Q443 93 503 179Q362 140 251 51Z"/><path d="M302 18Q461 71 518 142" fill="none"/></g>}
    {healing && <g className="healing-glyph" transform="translate(565 108)"><circle r="56"/><path d="M-10-33H10V-10H33V10H10V33H-10V10H-33V-10H-10Z"/>{[0,1,2,3].map(i => <path key={i} d="M-4-10H4V-4H10V4H4V10H-4V4H-10V-4H-4Z" transform={'translate(' + (-65 + i * 42) + ' ' + (35 - i % 2 * 75) + ') scale(.45)'} className="healing-mote"/>)}</g>}
    {settled && !cue.dodge && !healing && <g className="impact-burst" transform="translate(565 108)"><circle r="104" fill={'url(#' + id + 'burst)'}/><path d="M0-55 9-17 38-39 20-8 60 0 18 9 36 39 8 19 0 60-8 17-38 39-18 8-57 0-17-8-36-38-8-17Z"/><circle className="shock-ring" r="57" fill="none"/>{Array.from({ length: reduced ? 5 : 12 }, (_, i) => <path key={i} d="M0-63 2-83-2-76Z" transform={'rotate(' + i * 30 + ')'} className="impact-spark"/>)}</g>}
    {cue.area && <ellipse className="area-ring" cx="565" cy="158" rx="106" ry="34" fill="none" strokeDasharray="6 4"/>}
    {number && <g className="damage-float"><text x="565" y="84" textAnchor="middle">{number}</text>{cue.full && <text className="full-label" x="565" y="111" textAnchor="middle">满骰伤害</text>}</g>}
    {cue.killed && <g transform="translate(345 105)"><g className="kill-seal"><path d="M-100-35H100L112 0 100 35H-100L-112 0Z"/><text textAnchor="middle" y="9">击杀确认</text><path d="M-117-45-105-32M117 45 105 32M-117 45-105 32M117-45 105-32"/></g></g>}
    {cue.downed && <text className="downed-label" x="565" y="48" textAnchor="middle">倒地 · 尚未死亡</text>}{cue.revived && <text className="revived-label" x="565" y="48" textAnchor="middle">重新起身</text>}
  </svg>;
}

export function DefenseClock({ expiresAt }) {
  const [now, Now] = useState(Date.now());
  useEffect(() => { Now(Date.now()); const timer = setInterval(() => Now(Date.now()), 1000); return () => clearInterval(timer); }, [expiresAt]);
  const remaining = defenseRemaining(expiresAt, now);
  return <span className={'defense-countdown ' + (remaining <= 20 ? 'urgent' : '')} aria-label={'防守剩余' + remaining + '秒'}><span aria-hidden="true">◷</span> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}<small>{remaining ? '后自动按原规则结算' : '已到截止时间，正在核对结算'}</small></span>;
}

function MiniHealth({ row }) {
  if (!row.after) return null;
  const max = row.after.maxHP || row.before?.maxHP || row.result.maxHP || 1;
  return <div className="result-health"><div><span>正常 HP</span><strong>{row.before?.hp ?? '—'} <i>→</i> {row.after.hp} <small>/ {max}</small></strong></div><span className="result-health-track"><i style={{ '--from': Math.min(100, (row.before?.hp || 0) / max * 100) + '%', '--to': Math.min(100, (row.after.hp || 0) / max * 100) + '%' }}/></span>{row.after.reserveHP !== undefined && <><div><span>{row.after.downed ? '倒地 HP · 已启用' : '倒地 HP · 待用'}</span><strong>{row.before?.reserveHP ?? '—'} <i>→</i> {row.after.reserveHP} <small>/ {max}</small></strong></div><span className="result-health-track reserve"><i style={{ '--from': Math.min(100, (row.before?.reserveHP || 0) / max * 100) + '%', '--to': Math.min(100, (row.after.reserveHP || 0) / max * 100) + '%' }}/></span></>}</div>;
}

export function BattleStage({ battle, userId, selectedTargetId, compact = false }) {
  const { current, last, waiting, effectiveMode } = useContext(Feedback),cue = (!battle&&last&&['settle','death','heal'].includes(last.phase)?[last,current]:[current,last]).find(c => c && (!battle || c.battleId === battle.id)),status=battleStatus(battle,userId,cue), target = battle?.actors?.find(a => a.id === selectedTargetId), pending = waiting.filter(hit => (!battle || hit.battleId === battle.id)&&battle?.pendingCount!==0);
  if (!battle && !cue) return null;
  const show = effectiveMode !== 'off' && cue, animating = current?.id === cue?.id;
  return <section className={'battle-live-stage ' + (compact ? 'compact ' : '') + 'state-' + status.state} aria-label="战斗实时反馈"><header><div><small>战场实况</small><strong>{status.title}</strong></div><BattleEffectsSettings compact/></header><div className="battle-focus-row"><span>当前行动：<b>{status.actor?.name || '等待安排'}</b></span>{target && <span className="selected-target">已选目标：<b>{target.name}</b></span>}{pending.length > 0 && <span className="awaiting-defense">攻击已保存 · 等待 {pending.length} 个目标防守</span>}</div>
    {show ? <div className={'combat-viewport'+(animating&&effectiveMode==='full'?' is-playing':'')} key={cue.id}><CombatArtwork cue={cue} animated={animating} reduced={effectiveMode === 'reduced'}/>{cue.rows?.some(row=>row.after)&&<div className="stage-health">{cue.rows.filter(row=>row.after).slice(0,3).map(row=><div key={row.hitId}><strong>{row.name}</strong><MiniHealth row={row}/></div>)}</div>}<div className={'combat-caption ' + (cue.killed ? 'kill' : cue.full ? 'maximum' : '')} role="status"><b>{cue.title}</b><span>{cue.phase === 'launch' ? '攻击成立；伤害尚未结算' : cue.rows?.length > 1 ? '已保存 ' + cue.rows.length + ' 个目标结果，逐项详情见下方记录' : cue.subtitle}</span></div></div> : <div className="battle-stage-quiet"><span aria-hidden="true">✧</span><p>{status.state === 'turn' ? '选择目标与动作，一次点击执行。' : status.state === 'defense' ? '请选择防守方式；动画不会延长防守期限。' : effectiveMode === 'off' ? '动画已关闭，文字结果和操作照常更新。' : '每次真实操作后，出手与结算将在这里呈现。'}</p></div>}
    {status.pending.length > 0 && <div className="battle-stage-deadlines">{status.pending.slice(0, 3).map(hit => <span key={hit.id}>{hit.attackName || '待防守攻击'} <DefenseClock expiresAt={hit.expiresAt}/></span>)}{status.pending.length > 3 && <small>另有 {status.pending.length - 3} 个目标待处理</small>}</div>}
  </section>;
}

function ShotResults({ row }) {
  const [page, Page] = useState(0), count = Math.max(row.shots.length, row.perShot.length), pages = Math.max(1, Math.ceil(count / 4));
  useEffect(() => Page(0), [row.hitId]);
  if (!count) return null;
  return <div className="combat-shot-results"><h5>逐发 / 逐击 · 已保存骰点</h5>{Array.from({ length: Math.min(4, count - page * 4) }, (_, i) => {
    const n = page * 4 + i, shot = row.shots[n] || {}, result = row.perShot[n];
    return <div key={n} className="combat-shot"><b>第 {n + 1} 发 / 击</b><span>{shot.hit!==undefined&&<span>命中值 {shot.hit} · </span>}{Object.entries(shot.rolls || {}).map(([type, roll]) => <span key={type}>{damageLabels[type] || type} {roll.expression || '固定值'} [{(roll.rolls || []).map(r => r.chosen ?? r.dice?.join('/')).join(', ')}]{roll.ammunition ? ' ＋弹药 '+(roll.ammunition.expression||'固定值')+' ['+(roll.ammunition.rolls||[]).map(r=>r.chosen??r.dice?.join('/')).join(', ')+'] = ' + roll.ammunition.total : ''} = {shot.damage?.[type] ?? roll.total} </span>)}</span>{result && <strong>{result.maxRoll && !row.result.dodge?.success ? '✦ 满骰 · ' : ''}实际 {result.total} · 护甲减免 {Object.values(result.reduced || {}).reduce((n, v) => n + Number(v || 0), 0)}</strong>}</div>;
  })}{pages > 1 && <div className="toolbar"><button type="button" disabled={page === 0} onClick={() => Page(p => p - 1)}>前四发</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => Page(p => p + 1)}>后四发</button></div>}</div>;
}

export function BattleEventDetails({ event }) {
  const [page, Page] = useState(0), resolvedRows = resultRows(event), d = event.details || {}, parts = d.children || [],rows=parts.length?parts.map((part,index)=>resolvedRows.find(row=>row.hitId===(part.id||event.id+':'+index))||{pending:true,hitId:part.id||event.id+':'+index,name:part.name||'目标',shots:part.shots||d.shots||[],perShot:[],result:{}}):resolvedRows.length?resolvedRows:event.type==='attack'?[{pending:true,hitId:d.groupId||event.id,name:event.targetNames?.join('、')||'目标',shots:d.shots||[],perShot:[],result:{}}]:[], current = rows[Math.min(page, Math.max(0, rows.length - 1))], presentation = actionStyle(d.presentation);
  useEffect(() => Page(0), [event.id]);
  const waiting = event.type === 'attack' ? rows.filter(row=>row.pending).length : 0;
  return <div className="battle-event-results">
    {d.ability && <div className="combat-ability"><span aria-hidden="true">{presentation.magical ? '✧' : presentation.mental ? '◈' : presentation.projectile ? '⌖' : '⟋'}</span><strong className="art-title">{d.ability}</strong><small>{presentation.name}</small></div>}
    {waiting > 0 && <p className="attack-waiting" role="status">出手已成立 · 等待 {waiting} 个目标防守后结算</p>}
    {rows.length > 1 && <div className="combat-target-pages"><button type="button" disabled={page === 0} onClick={() => Page(p => p - 1)}>上一目标 / 件次</button><strong>{page + 1} / {rows.length} · {current?.name}</strong><button type="button" disabled={page + 1 >= rows.length} onClick={() => Page(p => p + 1)}>下一目标 / 件次</button></div>}
    {current?.pending&&<article className="combat-result-card"><h4>{current.name}</h4><p className="attack-waiting">等待防守；以下为出手时已经保存的骰点，尚未产生实际伤害。</p><ShotResults row={current}/></article>}
    {current && !current.pending&&<article className={'combat-result-card ' + (current.killed ? 'kill' : current.full ? 'maximum' : current.revived ? 'revived' : '')}>
      <div className="combat-result-head"><div><small>{current.name}</small><h4>{current.killed ? '击杀确认' : current.downed ? '倒地 · 尚未死亡' : current.revived ? '重新起身' : current.result.dodge?.success ? '成功闪避' : current.healed !== null ? '治疗已完成' : '伤害已结算'}</h4></div><strong className="combat-result-number">{current.result.dodge?.success ? '闪避' : current.healed !== null ? '+' + ((current.healed || 0) + current.reserveHealed) : current.damage === null ? '—' : '−' + current.damage}<small>{current.healed !== null ? '实际恢复' : '实际伤害'}</small></strong></div>
      {current.full && <p className="max-callout">✦ 满伤害 · 本击全部伤害骰取最大值</p>}
      <div className="combat-result-facts">{current.damage !== null && <span>护甲减免 <b>{current.armor}</b></span>}{Object.entries(current.result.breakdown || {}).map(([type, value]) => <span key={type}>{damageLabels[type] || type} <b>{value}</b></span>)}{current.result.choice && <span>防守：{({ defend: '纯防御', dodge: '闪避', both: '同时防守', none: '放弃防守' })[current.result.choice]}</span>}{current.result.dodge && <span>闪避检定 <b>{current.result.dodge.total}</b></span>}</div>
      <MiniHealth row={current}/>
      {current.result.saves?.length > 0 && <div className="combat-conditions">{current.result.saves.map((save, i) => <span className={save.save?.success ? '' : 'applied'} key={i}>{save.name} · {save.save?.total} / {save.save?.difficulty} · {save.save?.success ? '豁免成功' : '异常生效'}</span>)}</div>}
      {current.result.armorDamage?.length > 0 && <p>装备耐久：{current.result.armorDamage.map(a => a.name + ' −' + a.lost + '（剩余 ' + a.durability + '）').join('；')}</p>}
      {current.result.reward && <p className="combat-reward">✦ 奖励已确认：经验 +{current.result.reward.credited ?? current.result.reward.xp ?? 0}{current.result.reward.levelUp ? ' · 等级提升' : ''}</p>}
      <ShotResults row={current}/>
    </article>}
    {event.rpEntries?.map((rp, i) => <blockquote className="combat-roleplay" key={rp.operationId || i}>{rp.text}</blockquote>)}
    {d.opportunity && <p className="combat-resource-cost">第 {d.opportunity.roundNumber} 轮 · 本行动机会{d.opportunity.free ? '免费' : '已扣 ' + d.opportunity.apCost + ' AP'} · 快速剩余 {d.opportunity.quick} / 正式剩余 {d.opportunity.formal}</p>}
    {d.ammoRemaining !== undefined && d.ammoRemaining !== null && <p className={d.ammoEmpty ? 'error' : 'combat-resource-cost'}>剩余载弹 {d.ammoRemaining} 发{d.ammoEmpty ? ' · 弹夹已空，请装填' : ''}</p>}
  </div>;
}
