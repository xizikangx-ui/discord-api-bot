'use strict';
const { randomInt } = require('node:crypto');
const Dur=require('./durability');
const W=require('./weapons');
const C = require('./constants');
const M = require('./model');
const { requireThat: ok, number: num, clone, id } = C;

function actorCharacter(state, actor) { return actor.finalCharacter || (actor.userId ? M.player(state, actor.userId) : actor.character); }
function actorById(battle, actorId) {
  const actor = battle.actors.find(a => a.id === actorId);
  ok(actor, '参战者已不存在。'); return actor;
}
function record(battle, message, details) {
  const entry = { id:id('e'), at: Date.now(), message, ...(details ? { details:JSON.parse(JSON.stringify(details)) } : {}) };
  require('./battle-events').capture(battle,entry);
  battle.recent.push(entry);
  battle.history ||= [];
  battle.history.push(clone(entry));
  battle.recent = battle.recent.slice(-30);
}
function validateCondition(raw) {
  const t = clone(raw);
  t.name = C.text(t.name, '异常名称', 80);
  ok(C.DAMAGE_TYPES[t.type], '异常类型选择物理、魔法或精神。');
  ok(['numeric', 'text'].includes(t.effectType), '请选择数值扣除或文本记录。');
  t.description = C.text(t.description || '', '描述', 2000, true);
  const levels = C.SEVERITIES.filter(s => t.levels?.[s]);
  ok(levels.length, '至少填写一个异常等级。');
  for (const severity of levels) {
    const level = t.levels[severity];
    level.difficulty = num(level.difficulty, '豁免难度', 1, 1000000);
    ok(['actions', 'battle', 'until'].includes(level.duration?.kind), '请选择持续时间类型。');
    if (level.duration.kind === 'actions') level.duration.count = num(level.duration.count, '持续行动次数', 1, 10000);
    level.worsenAfter = num(level.worsenAfter || 0, '恶化行动次数（0不恶化）', 0, 10000);
    level.description = C.text(level.description || '', '等级效果描述', 2000, true);
    level.effects ||= [];
    ok(Array.isArray(level.effects) && level.effects.length <= 20, '每级最多20项效果。');
    if (t.effectType === 'numeric') ok(level.effects.length, '数值型异常须填写扣除项。');
    for (const e of level.effects) {
      ok(C.CONDITION_TARGETS.includes(e.target), '异常扣除目标无效。');
      const result = C.dice(e.amount, 'normal', min => min);
      ok(result.total >= 0, '扣除数值须非负。');
    }
  }
  return t;
}
function stageModifiers(condition, p, rng) {
  condition.elapsed = 0;
  const stage = condition.template.levels[condition.severity];
  condition.remaining = stage.duration.kind === 'actions' ? stage.duration.count : null;
  condition.modifiers = [];
  condition.rolls = [];
  if (condition.template.effectType === 'text') return;
  for (const effect of stage.effects) {
    if (effect.target === 'hp') continue;
    const roll = C.dice(effect.amount, 'normal', rng);
    condition.rolls.push({ target: effect.target, roll });
    const value = -Math.max(0, roll.total);
    if (effect.target === 'ap') p.ap = Math.max(0, p.ap + value);
    else condition.modifiers.push({ target: effect.target, op: 'add', value });
  }
  M.syncHP(p);
}
function saveRoll(p, template, severity, rng) {
  const s = M.stats(p);
  const attribute = template.type === 'physical' ? 'constitution' : 'mind';
  const roll = C.dice('1d20', 'normal', rng);
  const total = roll.total + s.attributes[attribute] + s.resist[template.type];
  return { roll, total, difficulty: template.levels[severity].difficulty, success: total >= template.levels[severity].difficulty };
}
function applyCondition(state, p, ref, rng = randomInt, source = null) {
  const template = ref.template || state.conditionTemplates[ref.id];
  ok(template?.published && template.levels[ref.severity], '异常模板或等级不存在。');
  const save = saveRoll(p, template, ref.severity, rng);
  if (save.success) return { name: template.name, severity: ref.severity, save };
  const old = p.conditions.find(c => c.templateId === ref.id);
  const severity = old && C.SEVERITIES.indexOf(old.severity) > C.SEVERITIES.indexOf(ref.severity) ? old.severity : ref.severity;
  if (old && severity === old.severity) {
    old.elapsed = 0;
    const stage = old.template.levels[old.severity];
    old.remaining = stage.duration.kind === 'actions' ? stage.duration.count : null;
    return { name: old.template.name, severity: old.severity, save, refreshed: true };
  }
  const next = { id: old?.id || id('z'), templateId: ref.id, template: clone(template), severity,
    source: typeof source === 'object' ? source?.actorId || null : source, sourceIdentity: typeof source === 'object' ? clone(source) : null };
  p.conditions = p.conditions.filter(c => c.templateId !== ref.id);
  p.conditions.push(next);
  stageModifiers(next, p, rng);
  return { name: template.name, severity, save };
}
function beginConditions(p, battle, actor, rng, state) {
  for (const e of M.expireEffects(p)) record(battle, actor.name + '的' + e.name + '持续效果已到期。');
  for (const condition of p.conditions) {
    if (condition.template.effectType !== 'numeric') continue;
    for (const e of condition.template.levels[condition.severity].effects.filter(e => e.target === 'hp')) {
      const roll = C.dice(e.amount, 'normal', rng);
      p.hp = Math.max(0, p.hp - Math.max(0, roll.total));
      record(battle, actor.name + '因' + condition.template.name + '损失' + Math.max(0, roll.total) + 'HP。', { roll });
      if (p.hp <= 0 && state) { require('./mortality').settle(state, battle, actor, condition.sourceIdentity || condition.source); return; }
    }
  }
  M.syncHP(p);
}
function endConditions(p, battle, actor, rng) {
  for (const e of M.finishEffects(p, battle.current?.actorId === actor.id ? battle.current.id : null)) record(battle, actor.name + '的' + e.name + '持续效果已到期。');
  const expired = [];
  for (const condition of p.conditions) {
    condition.elapsed++;
    const stage = condition.template.levels[condition.severity];
    const levels = C.SEVERITIES.filter(s => condition.template.levels[s]);
    const next = levels[levels.indexOf(condition.severity) + 1];
    if (next && stage.worsenAfter && condition.elapsed >= stage.worsenAfter) {
      const save = saveRoll(p, condition.template, next, rng);
      if (save.success) {
        condition.elapsed = 0;
        condition.remaining = stage.duration.kind === 'actions' ? stage.duration.count : null;
        record(battle, actor.name + '抵抗了' + condition.template.name + '恶化。', { save });
      } else {
        condition.severity = next;
        stageModifiers(condition, p, rng);
        record(battle, actor.name + '的' + condition.template.name + '恶化为' + next + '。', { save });
      }
      continue;
    }
    if (condition.remaining !== null && --condition.remaining <= 0) expired.push(condition.id);
  }
  for (const ref of expired) record(battle, actor.name + '的' + p.conditions.find(c => c.id === ref).template.name + '已到期。');
  p.conditions = p.conditions.filter(c => !expired.includes(c.id));
  M.syncHP(p);
}
function createBattle(state, channelId, creatorId, name, width = 10, height = 10) {
  ok(!Object.values(state.battles).some(b => b.channelId === channelId && b.status !== 'ended'), '当前频道已有战斗。');
  const b = { id: id('b'), channelId, creatorId, name: C.text(name, '战斗名', 80),
    width: num(width, '地图列数', 1, 20), height: num(height, '地图行数', 1, 20),
    terrain: {}, environment: '', status: 'recruiting', actors: [], queue: [], current: null, pending: null,
    wave: 0, priority: [], recent: [], messageId: null, createdAt: Date.now(), surpriseTeam: null };
  state.battles[b.id] = b;
  return b;
}
function join(state, battle, userId) {
  ok(battle.status === 'recruiting', 'GM已经开战，报名已关闭。');
  ok(!M.battleFor(state, userId), '已经参加战斗，请先退出原招募或由GM移出。');
  const p = M.player(state, userId);
  ok(battle.actors.length < 20, '当前战斗最多20名参战者。');
  const actor = { id: id('a'), userId, characterId: p.id, name: p.name, team: 'ally', x: 25, y: 25, retreated: false };
  battle.actors.push(actor); record(battle, p.name + '参加战斗。');
  return actor;
}
function withdraw(state, battle, userId) {
  ok(battle.status === 'recruiting', '开战后请使用逃跑或联系GM。');
  const a = battle.actors.find(a => a.userId === userId);
  ok(a, '尚未参加。');
  battle.actors = battle.actors.filter(x => x !== a);
}
function validateNPC(state, raw) {
  const t = clone(raw);
  t.name = C.text(t.name, 'NPC名', 80);
  t.description = C.text(t.description || '', 'NPC描述', 2000, true);
  t.attributes = Object.fromEntries(Object.keys(C.ATTRIBUTES).map(k => [k, num(t.attributes?.[k] ?? 1, C.ATTRIBUTES[k], 0, 100000)]));
  t.hpMax = num(t.hpMax || t.attributes.constitution * 3 || 1, 'HP上限', 1, 10000000);
  t.humanoid = !!t.humanoid; t.baseXP = num(t.baseXP ?? 0, '基础击杀经验', 0, 1000000000);
  t.skillIds||=[];t.skillSnapshots=t.skillIds.map(ref=>{const skill=state.skillTemplates?.[ref];ok(skill?.published,'NPC战斗技能尚未发布。');return clone(skill);});
  t.itemIds ||= [];
  for (const ref of t.itemIds) ok(state.catalog[ref]?.published, 'NPC装备或技能未发布。');
  t.itemQuantities = require('./room-settings').quantities(t.quantities || t.itemQuantities,t.itemIds,100);
  t.loadout = t.itemIds.map(ref => ({ template: clone(state.catalog[ref]), quantity: t.itemQuantities[ref] || 1 }));
  Object.assign(t,require('./npc-strength').validate(t));
  t.ai = require('./npc-auto').validate(t.ai);
  if (t.equipmentPreset !== undefined) require('./npc-equipment').create(t, state.catalog);
  return t;
}
function addNPC(state, battle, templateId, team, frozenTemplate = null) {
  ok(['recruiting', 'paused'].includes(battle.status), '添加NPC前请暂停战斗。');
  const original = frozenTemplate || state.npcTemplates[templateId];
  const template = original && require('./npc-strength').freeze(original, randomInt);
  ok(template?.published, 'NPC模板不存在。');
  ok(battle.actors.length < 20, '当前战斗最多20名参战者。');
  ok(['ally', 'enemy'].includes(team), '阵营无效。');
  const p = require('./npc-equipment').create(template, state.catalog);
  const actor = { id: id('a'), templateId, humanoid: !!template.humanoid, baseXP: template.baseXP || 0, templateVersion: template.version, name: template.name, team, character: p, retreated: false,
    x: team === 'enemy' ? battle.width * 50 - 25 : 25, y: team === 'enemy' ? battle.height * 50 - 25 : 25 };
  actor.ai = require('./npc-auto').config(template.ai);
  battle.actors.push(actor); return actor;
}
function position(battle, actorId, x, y, team) {
  ok(['recruiting', 'paused'].includes(battle.status) && !battle.pending, '调整位置或阵营前请暂停且完成待响应攻击。');
  const a = actorById(battle, actorId);
  a.x = C.round2(num(x, '横向米数', 0, battle.width * 50 - 0.01, false));
  a.y = C.round2(num(y, '纵向米数', 0, battle.height * 50 - 0.01, false));
  if (team) { ok(['ally', 'enemy'].includes(team), '阵营无效。'); a.team = team; }
  ok(battle.terrain[Math.floor(a.x / 50) + ',' + Math.floor(a.y / 50)] !== 'blocked', '不能放在阻挡格。');
}
function setTerrain(battle, x, y, type) {
  ok(['recruiting', 'paused'].includes(battle.status), '设置地形前请暂停。');
  x = num(x, '列（从1开始）', 1, battle.width) - 1;
  y = num(y, '行（从1开始）', 1, battle.height) - 1;
  ok(['normal', 'difficult', 'blocked'].includes(type), '地形无效。');
  ok(type !== 'blocked' || !battle.actors.some(a => Math.floor(a.x / 50) === x && Math.floor(a.y / 50) === y), '该格已有参战者。');
  battle.terrain[x + ',' + y] = type;
}
function liveActors(state, b) { return b.actors.filter(a => !a.retreated && actorCharacter(state, a).hp > 0); }
function order(state, b, actors, rng) {
  const scores = new Map(actors.map(a => [a.id, { agility: M.stats(actorCharacter(state, a)).attributes.agility, tie: [] }]));
  for (let attempt = 0; attempt < 100; attempt++) {
    const groups = new Map();
    for (const a of actors) {
      const score = scores.get(a.id);
      const key = score.agility + ':' + score.tie.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const tied = [...groups.values()].filter(g => g.length > 1);
    if (!tied.length) break;
    if (attempt === 99) throw new Error('先攻骰连续同点，请GM恢复后重试。');
    for (const group of tied) for (const a of group) scores.get(a.id).tie.push(rng(1, 21));
  }
  const result = actors.map(a => a.id).sort((a, c) => {
    const x = scores.get(a), y = scores.get(c);
    if (x.agility !== y.agility) return y.agility - x.agility;
    for (let i = 0; i < x.tie.length; i++) if (x.tie[i] !== y.tie[i]) return y.tie[i] - x.tie[i];
    return a.localeCompare(c);
  });
  record(b, '先攻顺序已确定。', { order: result, scores: Object.fromEntries(scores) });
  return result;
}
function advance(state, b, rng) {
  const actors = liveActors(state, b);
  if (!actors.length) { b.status = 'paused'; b.pauseReason = '没有可行动参战者。'; return; }
  for (let attempts = 0; attempts < 100; attempts++) {
    b.wave++;
    const gains = [];
    for (const a of [...actors].sort((x, y) => M.stats(actorCharacter(state, y)).attributes.agility - M.stats(actorCharacter(state, x)).attributes.agility)) {
      const p = actorCharacter(state, a); const die = C.dice('1d20', 'normal', rng);
      const effective = M.stats(p);
      const gain = Math.floor(M.modify(effective.effects, 'apGain', die.total + effective.attributes.agility * 5));
      ok(Number.isSafeInteger(p.ap + gain) && p.ap + gain <= C.MAX_MONEY, '动作点超出范围。');
      p.ap += gain; gains.push({ actorId: a.id, roll: die.total, gain });
    }
    record(b, '自动推进第' + b.wave + '次动作点。', { gains });
    if (actors.some(a => actorCharacter(state, a).ap >= 100)) {
      b.priority = order(state, b, actors, rng);
      b.queue = b.priority.filter(ref => actorCharacter(state, actorById(b, ref)).ap >= 100).map(actorId => ({ actorId, free: false }));
      return;
    }
  }
  b.status = 'paused'; b.pauseReason = '动作点推进达到安全上限，请GM检查角色。';
}
function nextOpportunity(state, b, rng = randomInt) {
  if (b.status !== 'active' || b.pending) return;
  if (b.current) {
    const actor = b.actors.find(a => a.id === b.current.actorId);
    if (actor && !actor.retreated && actorCharacter(state, actor).hp > 0) return;
    if (actor) endConditions(actorCharacter(state, actor), b, actor, rng);
    b.current = null;
  }
  for (let attempts = 0; attempts < 200; attempts++) {
    if (!b.queue.length) {
      const eligible = liveActors(state, b).filter(a => actorCharacter(state, a).ap >= 100);
      if (eligible.length) {
        const ordered = b.priority.filter(ref => eligible.some(a => a.id === ref));
        for (const a of eligible) if (!ordered.includes(a.id)) ordered.push(a.id);
        b.queue = ordered.map(actorId => ({ actorId, free: false }));
      } else advance(state, b, rng);
      if (b.status !== 'active') return;
    }
    const queued = b.queue.shift();
    if (!queued) continue;
    const a = b.actors.find(a => a.id === queued.actorId);
    if (!a || a.retreated) continue;
    const p = actorCharacter(state, a);
    if (p.hp <= 0 || (!queued.free && p.ap < 100)) continue;
    if (!queued.free) p.ap -= 100;
    if (a.casting && a.casting.count < a.casting.required) a.casting.count++;
    beginConditions(p, b, a, rng, state);
    if (p.hp <= 0) { endConditions(p, b, a, rng); record(b, a.name + (a.deathId ? '已死亡，跳过主动行动。' : '失能，跳过主动行动。')); continue; }
    b.current = { id: id('u'), actorId: a.id, quick: 1, formal: 1, move: M.stats(p).move, moveSpent: 0, startedAt: Date.now(), free: queued.free };
    record(b, '轮到' + a.name + '行动。');
    return;
  }
  b.status = 'paused'; b.pauseReason = '无法产生有效行动，请GM检查状态。';
}
function start(state, b, surpriseTeam, rng = randomInt) {
  ok(b.status === 'recruiting' && b.actors.length, '请先招募至少一名参战者。');
  for (const a of b.actors) {if(!a.userId&&!a.initialAmmoLoaded){a.initialAmmoLoaded=true;const loaded=require('./ammunition').primeNPC(actorCharacter(state,a));if(loaded.length)record(b,a.name+'开战前补弹：'+loaded.map(e=>e.name+' '+e.current+'/'+e.capacity+'发').join('、'));}actorCharacter(state, a).ap = 0; a.retreated = false; }
  b.status = 'active'; b.startedAt = Date.now();
  if (surpriseTeam) {
    ok(['ally', 'enemy'].includes(surpriseTeam), '偷袭阵营无效。');
    b.surpriseTeam = surpriseTeam;
    b.priority = order(state, b, liveActors(state, b), rng);
    b.queue = b.priority.filter(ref => actorById(b, ref).team === surpriseTeam).map(actorId => ({ actorId, free: true }));
  }
  nextOpportunity(state, b, rng);
}
function current(state, b, turnId) {
  ok(b.status === 'active' && b.current && b.current.id === turnId, '当前行动已变化或战斗暂停，请重新打开面板。');
  const a = actorById(b, b.current.actorId); const p = actorCharacter(state, a);
  const expired = M.expireEffects(p);
  ok(p.hp > 0 && !a.retreated, '角色已经失能或离场。');
  const remaining = C.round2(Math.max(0, M.stats(p).move - (b.current.moveSpent || 0)));
  b.current.move = expired.length ? remaining : Math.min(b.current.move, remaining);
  return { actor: a, p, turn: b.current };
}
function finish(state, b, turnId, rng = randomInt) {
  ok(b.status === 'active' && b.current?.id === turnId, '行动已变化，请刷新。');
  const actor = actorById(b, b.current.actorId), p = actorCharacter(state, actor);
  ok(!b.pending, '请先完成待响应攻击。');
  endConditions(p, b, actor, rng); b.current = null;
  nextOpportunity(state, b, rng);
}
function pass(state, b, turnId, type, rng = randomInt) {
  const { turn } = current(state, b, turnId);
  ok(!b.pending && ['quick', 'formal'].includes(type), '当前不能放弃该行动。');
  turn[type] = 0;
  if (!turn.quick && !turn.formal && turn.move <= 0) finish(state, b, turnId, rng);
}
function movementCost(b, from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const ts = [0, 1];
  for (const axis of ['x', 'y']) {
    if (to[axis] === from[axis]) continue;
    const min = Math.min(from[axis], to[axis]), max = Math.max(from[axis], to[axis]);
    for (let line = Math.floor(min / 50) * 50 + 50; line < max; line += 50) ts.push((line - from[axis]) / (to[axis] - from[axis]));
  }
  ts.sort((a, c) => a - c);
  let cost = 0;
  for (let i = 1; i < ts.length; i++) {
    const mid = (ts[i - 1] + ts[i]) / 2;
    const x = Math.floor((from.x + (to.x - from.x) * mid) / 50);
    const y = Math.floor((from.y + (to.y - from.y) * mid) / 50);
    const type = b.terrain[x + ',' + y];
    ok(type !== 'blocked', '路径穿过阻挡地形。');
    cost += distance * (ts[i] - ts[i - 1]) * (type === 'difficult' ? 2 : 1);
  }
  return Math.ceil((cost - 0.0000001) * 100) / 100;
}
function move(state, b, turnId, x, y) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && !M.stats(p).overloaded, '等待攻防响应或超重时无法移动。');
  const to = { x: C.round2(num(x, '横向米数', 0, b.width * 50 - 0.01, false)),
    y: C.round2(num(y, '纵向米数', 0, b.height * 50 - 0.01, false)) };
  ok(b.terrain[Math.floor(to.x / 50) + ',' + Math.floor(to.y / 50)] !== 'blocked', '不能进入阻挡格。');
  const cost = movementCost(b, actor, to);
  ok(cost <= turn.move + 0.000001, '移动预算不足，需要' + cost + '米。');
  actor.x = C.round2(to.x); actor.y = C.round2(to.y); turn.move = C.round2(turn.move - cost);
  turn.moveSpent = C.round2((turn.moveSpent || 0) + cost);
  record(b, actor.name + '移动至(' + actor.x + ',' + actor.y + ')。',{actorId:actor.id,turnId,position:{x:actor.x,y:actor.y},remaining:turn.move});
}
function abilities(p) {
  require('./ammunition').normalize(p);
  const weapons = W.equipped(p).filter(ref => Dur.usable(p.inventory[ref]));
  const hasWeapon=weapons.length>0;
  const result = weapons.map(ref => ({ key: ref, attack: p.inventory[ref].snapshot }));
  for (const item of Object.values(p.inventory)) if (item.snapshot.kind === '技能'&&hasWeapon) result.push({key:item.id,attack:{...item.snapshot,requiresWeapon:item.snapshot.requiresWeapon??true}});
  for(const e of Object.values(p.learnedSkills||{}))if(!e.snapshot.requiresWeapon||hasWeapon)result.push({key:e.id,attack:e.snapshot});
  for (const ref of p.equipped.cards) {
    const item = p.inventory[ref];
    for (const [n, skill] of (item?.snapshot.skills || []).entries()) if(!skill.requiresWeapon||hasWeapon)result.push({ key: ref + '~' + n, attack: skill });
  }
  return result;
}
function attack(state, b, turnId, abilityKey, targetId, action = 'formal', rng = randomInt, firing = {}) {
  const {actor,p,turn}=current(state,b,turnId),A=require('./aoe'),AM=require('./ammunition');
  ok(!b.pending,'已有攻击等待防守。');
  const ability=abilities(p).find(a=>a.key===abilityKey);ok(ability,'武器／技能当前不可用。');const t=ability.attack;
  ok(t.kind==='技能'&&!t.requiresWeapon || W.equipped(p).some(ref=>Dur.usable(p.inventory[ref])),'必须先装备可用武器才能攻击或释放此技能。');
  ok(['quick','formal'].includes(action)&&turn[action]>0,'该行动次数已用完。');
  if(t.kind==='技能')ok(action===(t.action||'formal'),'技能须使用指定的行动类型。');else if(action==='quick')ok(t.supernatural,'普通武器攻击需要正式行动。');
  let area=null,targets;
  if(A.validate(t.aoe).mode!=='single') {ok(firing.aoe,'范围攻击需要先预览中心与名单。');area=A.preview(state,b,actor,t,firing.aoe.center,A.validate(t.aoe).mode==='selective'?firing.aoe.targets:undefined);targets=area.targets.map(ref=>actorById(b,ref));ok(targets.length,'范围内没有目标。');}
  else {const target=actorById(b,targetId);ok(actor.id!==target.id&&actorCharacter(state,target).hp>0&&!target.retreated,'目标不可用。');
    if(t.melee)ok(Math.floor(actor.x/50)===Math.floor(target.x/50)&&Math.floor(actor.y/50)===Math.floor(target.y/50),'近战必须同格。');
    else ok(Math.hypot(actor.x-target.x,actor.y-target.y)<=M.modify(M.stats(p).effects,'range',t.rangeMeters??t.range*50)+.000001,'目标超出有效射程。');targets=[target];}
  if(t.kind==='技能'&&t.casting){if(!actor.casting){turn[action]--;actor.casting={key:abilityKey,name:t.name,required:t.casting,count:1,confirmed:false};record(b,actor.name+'开始吟唱'+t.name+'。',{actorId:actor.id,portrait:p.portraits?.avatar,ability:t.name});return {casting:true};}
    ok(actor.casting.key===abilityKey&&actor.casting.confirmed,'请先完成并用快速行动确认吟唱。');}
  const weapon=p.inventory[abilityKey],firearm=C.FIREARMS.includes(t.weaponType),magazineWeapon=AM.usesMagazine(t),mode=firing.mode||'semi';
  ok(['semi','auto'].includes(mode),'射击模式无效。');const count=mode==='auto'?num(firing.count,'连射发数',1,10000):1;
  ok(mode==='semi'||firearm,'只有枪械可以全自动射击。');
  if(magazineWeapon){ok((t.fireModes||['semi']).includes(mode),'这把枪械不支持所选射击模式。');ok(weapon?.loaded?.current>=count,'无弹药或剩余弹药不足，请装填或减少连射发数。');}
  if(weapon&&t.kind==='武器')ok(Dur.current(weapon)>=count,'武器耐久不足，请修复或减少连射发数。');
  const rounds=[];
  for(let n=0;n<count;n++){let round={};if(magazineWeapon){round=weapon.loaded.rounds?.shift()||{};weapon.loaded.current--;}
    else if(t.weaponType==='弓'){const ammo=Object.values(p.inventory).find(i=>i.snapshot.kind==='弹药'&&AM.ammoCompatible(t,i.snapshot)&&(actor.userId?M.available(state,actor.userId,i.id)>0:i.quantity>0));ok(ammo,'缺少对应箭矢。');round=AM.round(ammo.snapshot);ammo.quantity--;if(!ammo.quantity)delete p.inventory[ammo.id];}rounds.push(round);}
  if(magazineWeapon)p.ammoVersion=(p.ammoVersion||0)+1;turn[action]--;if(t.kind==='技能'&&t.casting)actor.casting=null;
  const empty=magazineWeapon&&weapon.loaded.current===0,groupId=id('h'),expiresAt=Date.now()+60000;
  const pendingHits=targets.map(target=>{const targetP=actorCharacter(state,target),targetStats=M.stats(targetP),shots=[],damage={},rolls={},conditions=clone(t.conditions||[]);
    for(const round of rounds){const stats=M.stats(p,round.effects||[]),part={},shotRolls={};
      for(const type of Object.keys(C.DAMAGE_TYPES)){const expr=t.damage[type],extra=round.damage?.[type];if(!expr&&!extra)continue;const roll=expr?C.dice(expr,'normal',rng):null,bonus=extra?C.dice(extra,'normal',rng):null;
        shotRolls[type]={...(roll||{total:0}),...(bonus?{ammunition:bonus}:{})};let base=Math.max(0,(roll?.total||0)+(bonus?.total||0));if(t.melee&&type===t.primary)base+=stats.attributes.strength;base=M.modify(stats.effects,'attack:'+type,base);if(type!=='physical')base*=1+stats.attributes.intelligence*.1;part[type]=Math.max(0,base);damage[type]=(damage[type]||0)+part[type];}
      for(const ref of round.conditions||[]){const previous=conditions.find(c=>c.id===ref.id);if(!previous)conditions.push(clone(ref));else if(C.SEVERITIES.indexOf(ref.severity)>C.SEVERITIES.indexOf(previous.severity))Object.assign(previous,clone(ref));}
      shots.push({damage:part,rolls:shotRolls,hit:M.modify(stats.effects,'hit',t.hit)});if(shots.length===1)Object.assign(rolls,shotRolls);
    }
    return {id:area?id('h'):groupId,groupId,turnId,attackerId:actor.id,attackerCharacterId:p.id,targetId:target.id,targetCharacterId:targetP.id,attackName:t.name,hit:shots[0]?.hit??t.hit,damage,rolls,shots,conditions,armorWeakening:clone(t.armorWeakening||{type:'physical',amount:0}),fireMode:mode,shotCount:count,ammoRemaining:magazineWeapon?weapon.loaded.current:null,ammoEmpty:empty,defenses:clone(targetStats.defenses),agility:M.signedModifier(targetStats.effects,'dodge',targetStats.attributes.agility),expiresAt};
  });
  if(weapon&&t.kind==='武器')Dur.drain(weapon,count);
  b.pending=area?{kind:'aoe',id:groupId,attackerId:actor.id,turnId,area:clone(area),hits:pendingHits,expiresAt}:pendingHits[0];
  record(b,actor.name+'使用'+t.name+(firearm?'，'+(mode==='auto'?'全自动连射':'半自动')+count+'发':'')+'攻击'+targets.map(a=>a.name).join('、')+'，等待防守。'+(empty?' ⚠️ 弹夹已空：无弹药，请装填。':''),{actorId:actor.id,portrait:p.portraits?.avatar,groupId,children:area?pendingHits.map(h=>({id:h.id,targetId:h.targetId,name:actorById(b,h.targetId).name,shots:clone(h.shots)})):null,targetIds:targets.map(a=>a.id),ability:t.name,hit:pendingHits[0].hit,damage:pendingHits[0].damage,shots:pendingHits[0].shots,ammoEmpty:empty,ammoRemaining:magazineWeapon?weapon.loaded.current:null,shotCount:count,mode,area});
  return b.pending;
}
function defend(state, b, pendingId, choice, rng = randomInt) {
  const hit=require('./aoe').hit(b,pendingId);
  ok(['active','paused'].includes(b.status)&&hit,'攻防已结算，请刷新。');
  ok(['defend', 'dodge', 'both', 'none'].includes(choice), '防守方式无效。');
  const group=b.pending, target = actorById(b, hit.targetId); const p = actorCharacter(state, target);
  ok(!target.deathId&&(!hit.targetCharacterId||p.id===hit.targetCharacterId),'该目标角色已变化。');
  const hpBefore=p.hp;
  const defaulted = hit.expiresAt <= Date.now();
  if (defaulted) choice = 'defend';
  let dodge = null;
  if (['dodge', 'both'].includes(choice)) {
    dodge = C.dice('1d20', 'disadvantage', rng);
    dodge.total += hit.agility; dodge.success = p.hp > 0 && dodge.total > hit.hit;
  }
  let total = 0; const breakdown = {}; const saves = [];const armorDamage=[];
  if (!dodge?.success) {
    const fraction = choice === 'both' ? 0.5 : choice === 'defend' ? 1 : 0;
    let defenses=hit.defenses;for(const shot of hit.shots||[{damage:hit.damage}]){for(const [type,value] of Object.entries(shot.damage)){const amount=Math.max(0,Math.floor(value-defenses[type]*fraction));breakdown[type]=(breakdown[type]||0)+amount;total+=amount;}armorDamage.push(...Dur.weaken(p,hit.armorWeakening));defenses=M.stats(p).defenses;}
    p.hp = Math.max(0, p.hp - total);
    for (const ref of hit.conditions) {
      const attacker = actorById(b, hit.attackerId), origin = actorCharacter(state, attacker);
      saves.push(applyCondition(state, p, ref, rng, { actorId: attacker.id, userId: attacker.userId || null, characterId: origin.id }));
    }
  }
  M.syncHP(p);
  record(b, target.name + (dodge?.success ? '成功闪避。' : '受到' + total + '伤害，剩余' + p.hp + 'HP。'),
    {actorId:target.id,portrait:p.portraits?.avatar,attackerId:hit.attackerId,ability:hit.attackName,choice,dodge,breakdown,saves,armorDamage,hpBefore,hp:p.hp,maxHP:M.stats(p).maxHP,shots:hit.shots,rolls:hit.rolls,total,hitId:hit.id});
  if(armorDamage.length)record(b,'护甲削弱：'+armorDamage.map(d=>d.name+'耐久 -'+d.lost+'（剩余'+d.durability+'）').join('、'));
  M.syncHP(p);
  hit.result={target:target.name,total,dodge,breakdown,saves,armorDamage,hp:p.hp,defaulted};
  require('./battle-events').settle(b,hit);
  if(group.kind!=='aoe'||!require('./aoe').hits(b).length)b.pending=null;
  if (p.hp <= 0) require('./mortality').settle(state, b, target, hit.attackerId);
  const result = { target: target.name, total, dodge, breakdown, saves, armorDamage,hp: p.hp, defaulted };
  if (b.status === 'active' && b.current && !b.pending) {
    const active = actorById(b, b.current.actorId);
    if (actorCharacter(state, active).hp <= 0) {
      endConditions(actorCharacter(state, active), b, active, rng);
      b.current = null; nextOpportunity(state, b, rng);
    }
  }
  if(b.status==='active'&&!b.pending&&!b.current)nextOpportunity(state,b,rng);
  return result;
}
function confirmCasting(state, b, turnId) {
  const { actor, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0 && actor.casting && actor.casting.count >= actor.casting.required, '吟唱未完成或快速行动已用完。');
  turn.quick--; actor.casting.confirmed = true;
  record(b, actor.name + '确认吟唱完成。',{actorId:actor.id,portrait:actorCharacter(state,actor).portraits?.avatar});
}
function reload() { throw new Error('旧直接装填已停用，请使用弹夹管理：先填弹夹，再更换弹夹。'); }
function switchWeapon(state, b, turnId, itemId, hand = 'auto') {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0, '快速行动不可用。');
  if (itemId) {
    ok(p.inventory[itemId]?.snapshot.kind === '武器', '武器不可用。');
    if (actor.userId) ok(M.available(state, actor.userId, itemId) > 0, '武器已被交易预留。');
  }
  W.set(p, itemId, hand); turn.quick--; M.syncHP(p);record(b,actor.name+'切换武器：'+(itemId?p.inventory[itemId].snapshot.name:'卸下武器'),{actorId:actor.id,portrait:p.portraits?.avatar});
}
function useItem(state, b, turnId, itemId, rng = randomInt, repairTarget) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0, '快速行动不可用。');
  const item = p.inventory[itemId];
  ok([...C.CONSUMABLES,'修复道具'].includes(item?.snapshot.kind), '该道具没有已录入的使用效果。');
  if (actor.userId) ok(M.available(state, actor.userId, itemId) > 0, '道具已预留。');
  if(p.inventory[itemId]?.snapshot.kind==='修复道具'){if(actor.userId)ok(M.available(state,actor.userId,repairTarget)>0,'装备已被预留。');const result=Dur.repair(p,itemId,repairTarget);turn.quick--;M.syncHP(p);turn.move=Math.max(0,C.round2(M.stats(p).move-(turn.moveSpent||0)));record(b,actor.name+'使用'+result.name+'修复'+result.target+' '+result.repaired+'点耐久。',{...result,actorId:actor.id,portrait:p.portraits?.avatar});return result;}
  const result = M.consume(p, itemId, rng, turnId);
  turn.move = Math.max(0, C.round2(M.stats(p).move - (turn.moveSpent || 0)));
  turn.quick--; record(b, actor.name + '使用' + result.name + '，恢复' + result.healed + 'HP。', {...result,hp:p.hp,maxHP:M.stats(p).maxHP,actorId:actor.id,portrait:p.portraits?.avatar});
  return result;
}
function flee(state, b, turnId, rng = randomInt) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.formal > 0, '正式行动不可用。');
  turn.formal--; actor.retreated = true;
  record(b, actor.name + '离开战斗。');
  endConditions(p, b, actor, rng); b.current = null;
  nextOpportunity(state, b, rng);
}
function pause(b, resume = false) {
  if (resume) { ok(b.status === 'paused', '战斗未暂停。'); b.status = 'active'; delete b.pauseReason; }
  else { ok(b.status === 'active', '战斗未进行。'); b.status = 'paused'; }
}
function endBattle(state, b) {
  ok(b.status !== 'ended', '战斗已结束。');
  b.status = 'ended'; b.endedAt = Date.now(); b.pending = null; b.current = null; b.queue = [];
  for (const a of b.actors) {
    const p = actorCharacter(state, a);
    p.conditions = p.conditions.filter(c => c.template.levels[c.severity].duration.kind !== 'battle');
    p.ap = 0; delete a.casting; M.syncHP(p);
    a.finalCharacter = clone(p);
  }
  record(b, 'GM结束了战斗。');
}
module.exports = { actorCharacter, actorById, record, validateCondition, applyCondition, beginConditions, endConditions,
  createBattle, join, withdraw, validateNPC, addNPC, position, setTerrain, liveActors, order, advance,
  nextOpportunity, start, current, finish, pass, movementCost, move, abilities, attack, defend,
  confirmCasting, reload, switchWeapon, useItem, flee, pause, endBattle };
