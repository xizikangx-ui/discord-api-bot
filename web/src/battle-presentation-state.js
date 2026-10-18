export const damageLabels = { physical: '物理', magical: '魔法', mental: '精神', heal: '治疗' };
const sum = values => Object.values(values || {}).reduce((n, value) => n + (Number(value) || 0), 0);
export function resultRows(event) {
  if (!event) return [];
  const d = event.details || {}, presentation = d.presentation || {};
  const row = (result, part = {}, index = 0) => {
    if (!result || result.skipped) return null;
    const before = result.healthBefore || result.before || (result.hpBefore !== undefined ? { hp: result.hpBefore, maxHP: result.maxHP } : null);
    const after = result.healthAfter || result.after || (result.hp !== undefined ? { hp: result.hp, maxHP: result.maxHP } : null);
    const shots = part.shots || d.shots || [];
    const perShot = result.perShot || [];
    return {
      hitId: part.id || result.id || d.hitId || d.groupId || event.id + ':' + index,
      targetId: part.targetId || result.targetId || (event.type === 'result' ? event.actorId : null),
      name: part.name || result.target || d.targetName || (['result', 'condition', 'death'].includes(event.type) ? event.actorName : '') || '目标',
      result, shots, before, after, presentation,
      damage: Number.isFinite(result.total) ? result.total : null,
      healed: result.healed ?? null,
      reserveHealed: result.reserveHealed ?? 0,
      armor: perShot.reduce((n, shot) => n + sum(shot.reduced), 0),
      perShot,
      full: !result.dodge?.success && perShot.some(shot => shot.maxRoll === true),
      killed: result.killed === true && typeof result.deathId === 'string',
      downed: !!after?.downed && !before?.downed,
      revived: !!before?.downed && !!after && !after.downed && after.hp > 0,
    };
  };
  if (d.children?.length) return d.children.map((part, i) => row(part.result, part, i)).filter(Boolean);
  if (d.results?.length && event.type === 'attack') return d.results.map((result, i) => row(result, { id: result.id, targetId: result.targetId }, i)).filter(Boolean);
  if (['result', 'death', 'condition', 'rescue', 'item'].includes(event.type) && (d.healthAfter || d.after || d.total !== undefined || d.deathId || d.healed !== undefined)) return [row(d)].filter(Boolean);
  return [];
}

export function actionStyle(presentation = {}) {
  const types = [...new Set(presentation.damageTypes || [])].filter(type => ['physical', 'magical', 'mental'].includes(type));
  const magical = types.includes('magical'), mental = types.includes('mental');
  // Chinese 枪 is a polearm; firearms are explicit published weapon types.
  const projectile = /手枪|步枪|狙击|冲锋|机枪|霰弹|榴弹|火箭|火炮|弓|弩/.test(presentation.weaponType || '');
  return { types: types.length ? types : ['physical'], magical, mental, physical: !types.length || types.includes('physical'), projectile, name: magical && mental ? '混合术式' : magical ? '魔法释放' : mental ? '心灵共振' : projectile ? '射击' : presentation.kind === 'skill' ? '武技释放' : '斩击' };
}

export function cuesForEvent(event, battleId) {
  if (!event?.id) return [];
  const d = event.details || {}, style = actionStyle(d.presentation), base = { eventId: event.id, battleId, actorId: d.attackerId || event.actorId, actor: d.sourceName || d.attackerName || (event.type==='result'?'攻击者':event.actorName) || '行动者', ability: d.ability || '', style, at: event.at, version: event.version || 1 };
  const rows = resultRows(event), cues = [];
  if (event.type === 'attack') {
    const parts = d.children?.length ? d.children : [{ id: d.groupId || event.id, targetId: d.targetIds?.[0], name: event.targetNames?.[0] || '目标' }];
    cues.push({ ...base, phase: 'launch', groupId: d.groupId || event.id, hits: parts.map(part => ({ id: part.id || event.id, name: part.name || '目标', targetId: part.targetId })), targets: parts.map(part => part.name || '目标'), title: d.ability || style.name, subtitle: '出手已成立 · 等待独立防守', shotCount: d.shotCount || d.shots?.length || 1, area: !!d.area });
  }
  for (const row of rows) {
    const phase = event.type === 'death' ? 'death' : row.healed !== null || row.revived || event.type === 'rescue' ? 'heal' : 'settle';
    cues.push({ ...base, phase, groupId: d.groupId || d.hitId || event.id, hits: [{ id: row.hitId, name: row.name, targetId: row.targetId }], targets: [row.name], rows: [row], title: row.killed ? '击杀确认' : phase==='death'?'死亡结算':row.downed ? '倒地' : row.revived ? '重新起身' : row.result.dodge?.success ? '闪避成功' : phase === 'heal' ? '生命恢复' : row.full ? '满伤害命中' : '结算完成', subtitle: row.name, killed: row.killed, deathIds: typeof row.result.deathId==='string'?[row.result.deathId]:[], full: row.full, downed: row.downed, revived: row.revived, dodge: !!row.result.dodge?.success, damage: row.damage, healed: row.healed, shotCount: row.perShot.length || row.shots.length || 1 });
  }
  if (!rows.length && ['casting', 'move', 'reload', 'switch', 'item', 'finish', 'pass', 'flee', 'support'].includes(event.type)) cues.push({ ...base, phase: event.type, hits: [{ id: event.id }], groupId: event.id, targets: event.targetNames || [], title: { casting: /开始吟唱/.test(event.message||'')?'开始吟唱':'吟唱已确认', move: '战术移动', reload: '装填完成', switch: '切换武器', item: '道具已使用', finish: '行动机会结束', pass: '放弃行动', flee: '撤离战场', support: '援军抵达' }[event.type], subtitle: event.message || '' });
  return cues;
}

const unwrap = input => Array.isArray(input) ? input : input?.data?.system?.event ? [{ battleId: input.data.system.battleId, event: input.data.system.event, committedAt: input.data.system.feedbackAt, deathIds: input.data.system.effectDeaths }] : input?.event ? [input] : [];
export function createBattleFeedbackTracker({ maxSeen = 2400, maxAge = 180000, clock = () => Date.now() } = {}) {
  let scope = '', ready = false, cutoff = clock();
  const seen = new Map(), versions = new Map(), launchedEvents = new Set();
  const remember = key => { seen.set(key, clock()); while (seen.size > maxSeen) seen.delete(seen.keys().next().value); };
  function keys(cue) {
    return cue.phase === 'death' ? cue.deathIds.map(id => 'death:' + id) : cue.hits.map(hit => hit.id + ':' + cue.phase);
  }
  function connect(nextScope) {
    if (scope !== nextScope) { scope = nextScope; seen.clear(); versions.clear(); launchedEvents.clear(); }
    ready = false; cutoff = clock();
  }
  function baseline(input) {
    for (const entry of unwrap(input)) {
      const eventKey = (entry.battleId || '') + ':' + (entry.eventId || entry.event?.id);
      versions.set(eventKey, Math.max(versions.get(eventKey) || 0, entry.version || entry.event?.version || 1));
      launchedEvents.add(eventKey);
      for (const id of entry.launchHitIds || []) remember(id + ':launch');
      for (const id of entry.settledHitIds || []) remember(id + ':settle');
      for (const id of entry.deathIds || []) remember('death:' + id);
      for (const cue of cuesForEvent(entry.event, entry.battleId)) { keys(cue).forEach(remember); cue.deathIds?.forEach(id => remember('death:' + id)); }
    }
    while (versions.size > maxSeen) versions.delete(versions.keys().next().value);
    while (launchedEvents.size > maxSeen) launchedEvents.delete(launchedEvents.values().next().value);
    ready = true;
  }
  function ingest(input, { source = 'socket' } = {}) {
    const output = [];
    for (const entry of unwrap(input)) {
      const e = entry.event;
      if (!e?.id) continue;
      const committedAt = entry.committedAt || e.updatedAt || e.at || 0;
      const isLive = (source === 'http' || ready) && committedAt >= cutoff && clock() - committedAt <= maxAge;
      if (!isLive || source === 'history' || source === 'reconnect' || source === 'refresh') { const wasReady = ready; baseline([entry]); ready = wasReady; continue; }
      const eventKey = (entry.battleId || '') + ':' + e.id;
      if ((versions.get(eventKey) || 0) >= (e.version || 1)) continue;
      versions.set(eventKey, e.version || 1);
      while (versions.size > maxSeen) versions.delete(versions.keys().next().value);
      for (const cue of cuesForEvent(e, entry.battleId)) {
        if (cue.phase === 'launch' && launchedEvents.has(eventKey)) continue;
        const freshHits = cue.hits.filter(hit => !seen.has(hit.id + ':' + cue.phase) && !(cue.phase === 'launch' && seen.has(hit.id + ':settle')));
        const deaths = (cue.deathIds || []).filter(id => !seen.has('death:' + id));
        if (cue.phase === 'death' ? !deaths.length : !freshHits.length) continue;
        keys(cue).forEach(remember);
        if (cue.phase === 'launch') launchedEvents.add(eventKey);
        cue.deathIds?.forEach(id => remember('death:' + id));
        output.push({ ...cue, hits: freshHits, killed: cue.killed && deaths.length > 0, title: cue.killed && !deaths.length ? cue.full ? '满伤害命中' : '结算完成' : cue.title, deathIds: deaths, id: eventKey + ':' + cue.phase + ':' + freshHits.map(hit => hit.id).join(',') });
      }
    }
    while (launchedEvents.size > maxSeen) launchedEvents.delete(launchedEvents.values().next().value);
    return mergeBattleCues(output);
  }
  return { connect, baseline, ingest, ready: () => ready, size: () => seen.size };
}

export function mergeBattleCues(cues, limit = 8) {
  const merged = [];
  for (const cue of cues) {
    const last = merged.at(-1);
    if (last && last.battleId === cue.battleId && last.groupId === cue.groupId && last.phase === cue.phase) {
      const rows = [...(last.rows || []), ...(cue.rows || [])], hits = [...last.hits, ...cue.hits];
      merged[merged.length - 1] = { ...last, rows, hits, targets: [...new Set([...(last.targets || []), ...(cue.targets || [])])], killed: last.killed || cue.killed, deathIds: [...(last.deathIds || []), ...(cue.deathIds || [])], full: last.full || cue.full, downed: last.downed || cue.downed, revived: last.revived || cue.revived, title: last.killed || cue.killed ? '击杀确认' : last.downed || cue.downed ? '倒地' : last.full || cue.full ? '满伤害命中' : last.title, damage: rows.reduce((n, row) => n + (row.damage || 0), 0), id: last.id + '+' + cue.id };
    } else merged.push(cue);
  }
  // Keep the latest state; the complete event text is retained in chat.
  return merged.slice(-limit);
}

export function defenseRemaining(expiresAt, now = Date.now()) { return Math.max(0, Math.ceil((Number(expiresAt) - now) / 1000)) || 0; }
export function battleStatus(battle, userId, cue) {
  if (!battle) return cue?{title:cue.killed?'击杀确认 · 结算已保存':cue.phase==='launch'?'攻击已保存 · 等待防守':cue.phase==='death'?'死亡结算已保存':['settle','heal'].includes(cue.phase)?'结算完成':cue.title,state:'resolved',actor:{name:cue.actor},pending:[]}:{ title: '战场待命', state: 'idle', actor: null, pending: [] };
  const actor = battle.actors?.find(a => a.id === battle.current?.actorId), self = battle.actors?.find(a => a.userId === userId), pending = battle.pending || [];
  if (battle.status === 'ended') return { title: '战斗已结束', state: 'ended', actor, self, pending: [] };
  if (battle.status === 'paused') return { title: 'GM 已暂停战斗', state: 'paused', actor, self, pending };
  if (pending.length) return { title: '你有待防守攻击', state: 'defense', actor, self, pending };
  if (battle.pendingCount > 0) return { title: '攻击已提交 · 等待目标防守', state: 'waiting', actor, self, pending };
  if (self?.id === actor?.id) return { title: '轮到你行动', state: 'turn', actor, self, pending };
  return { title: actor ? actor.name + ' 正在行动' : '等待行动机会', state: 'waiting', actor, self, pending };
}
