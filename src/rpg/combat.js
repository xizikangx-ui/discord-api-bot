'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants');
const M = require('./model');
const { requireThat: ok, number: num, clone, id } = C;

function actorCharacter(state, actor) { return actor.finalCharacter || (actor.userId ? M.player(state, actor.userId) : actor.character); }
function actorById(battle, actorId) {
  const actor = battle.actors.find(a => a.id === actorId);
  ok(actor, '参战者已不存在。'); return actor;
}
function record(battle, message, details) {
  const entry = { at: Date.now(), message, ...(details ? { details } : {}) };
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
  const next = { id: old?.id || id('z'), templateId: ref.id, template: clone(template), severity, source };
  p.conditions = p.conditions.filter(c => c.templateId !== ref.id);
  p.conditions.push(next);
  stageModifiers(next, p, rng);
  return { name: template.name, severity, save };
}
function beginConditions(p, battle, actor, rng) {
  for (const condition of p.conditions) {
    if (condition.template.effectType !== 'numeric') continue;
    for (const e of condition.template.levels[condition.severity].effects.filter(e => e.target === 'hp')) {
      const roll = C.dice(e.amount, 'normal', rng);
      p.hp = Math.max(0, p.hp - Math.max(0, roll.total));
      record(battle, actor.name + '因' + condition.template.name + '损失' + Math.max(0, roll.total) + 'HP。', { roll });
    }
  }
  M.syncHP(p);
}
function endConditions(p, battle, actor, rng) {
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
  const actor = { id: id('a'), userId, name: p.name, team: 'ally', x: 25, y: 25, retreated: false };
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
  t.itemIds ||= [];
  for (const ref of t.itemIds) ok(state.catalog[ref]?.published, 'NPC装备或技能未发布。');
  t.itemQuantities = {};
  for (const line of (t.quantities || '').split('\n').filter(Boolean)) {
    const match = line.trim().match(/^(\S+)\s+(\d+)$/);
    ok(match && t.itemIds.includes(match[1]), 'NPC数量每行填写已选模板编号和数量。');
    t.itemQuantities[match[1]] = num(match[2], 'NPC物品数量', 1, 100);
  }
  t.loadout = t.itemIds.map(ref => ({ template: clone(state.catalog[ref]), quantity: t.itemQuantities[ref] || 1 }));
  return t;
}
function addNPC(state, battle, templateId, team) {
  ok(['recruiting', 'paused'].includes(battle.status), '添加NPC前请暂停战斗。');
  const template = state.npcTemplates[templateId];
  ok(template?.published, 'NPC模板不存在。');
  ok(battle.actors.length < 20, '当前战斗最多20名参战者。');
  ok(['ally', 'enemy'].includes(team), '阵营无效。');
  const p = M.newCharacter(template.name, clone(template.attributes));
  p.points = 0; p.hpMaxOverride = template.hpMax; p.hp = template.hpMax;
  for (const entry of template.loadout || template.itemIds.map(ref => ({ template: state.catalog[ref], quantity: 1 }))) {
    const stateful = ['武器', '防具', '饰品', '卡牌', '配件', '弹夹', '技能'].includes(entry.template.kind);
    for (let n = 0; n < (stateful ? entry.quantity : 1); n++) {
    const item = M.makeItem(entry.template, stateful ? 1 : entry.quantity);
    for (const part of M.bundleItems(item)) { p.inventory[part.id] = part; delete part.bundle; }
    if (item.snapshot.kind === '武器') p.equipped.weapon = item.id;
    if (item.snapshot.kind === '防具') {
      const occupied = p.equipped.armor.flatMap(i => C.ARMOR_COVERAGE[p.inventory[i].snapshot.armorType]);
      ok(!C.ARMOR_COVERAGE[item.snapshot.armorType].some(k => occupied.includes(k)), 'NPC防具槽位冲突。');
      p.equipped.armor.push(item.id);
    }
    if (item.snapshot.kind === '饰品') {
      const slot = item.snapshot.accessoryType;
      ok(p.equipped.accessories.filter(i => p.inventory[i].snapshot.accessoryType === slot).length < p.slots[slot], 'NPC饰品槽位冲突。');
      p.equipped.accessories.push(item.id);
    }
    if (item.snapshot.kind === '卡牌') { ok(p.equipped.cards.length < 5, 'NPC卡牌超过5张。'); p.equipped.cards.push(item.id); }
    }
  }
  const actor = { id: id('a'), templateId, name: template.name, team, character: p, retreated: false,
    x: team === 'enemy' ? battle.width * 50 - 25 : 25, y: team === 'enemy' ? battle.height * 50 - 25 : 25 };
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
    beginConditions(p, b, a, rng);
    if (p.hp <= 0) { endConditions(p, b, a, rng); record(b, a.name + '失能，跳过主动行动。'); continue; }
    b.current = { id: id('u'), actorId: a.id, quick: 1, formal: 1, move: M.stats(p).move, moveSpent: 0, startedAt: Date.now(), free: queued.free };
    record(b, '轮到' + a.name + '行动。');
    return;
  }
  b.status = 'paused'; b.pauseReason = '无法产生有效行动，请GM检查状态。';
}
function start(state, b, surpriseTeam, rng = randomInt) {
  ok(b.status === 'recruiting' && b.actors.length, '请先招募至少一名参战者。');
  for (const a of b.actors) { actorCharacter(state, a).ap = 0; a.retreated = false; }
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
  ok(p.hp > 0 && !a.retreated, '角色已经失能或离场。');
  b.current.move = C.round2(Math.max(0, Math.min(b.current.move, M.stats(p).move - (b.current.moveSpent || 0))));
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
  record(b, actor.name + '移动至(' + actor.x + ',' + actor.y + ')。');
}
const UNARMED = { id: 'unarmed', name: '徒手', kind: '武器', weaponType: '其他', melee: true, supernatural: false,
  hit: 10, damage: { physical: '0' }, primary: 'physical', range: 0, conditions: [] };
function abilities(p) {
  const result = [{ key: 'unarmed', attack: UNARMED }];
  if (p.equipped.weapon && p.inventory[p.equipped.weapon]) result.push({ key: p.equipped.weapon, attack: p.inventory[p.equipped.weapon].snapshot });
  for (const item of Object.values(p.inventory)) if (item.snapshot.kind === '技能') result.push({ key: item.id, attack: item.snapshot });
  for (const ref of p.equipped.cards) {
    const item = p.inventory[ref];
    for (const [n, skill] of (item?.snapshot.skills || []).entries()) result.push({ key: ref + '~' + n, attack: skill });
  }
  return result;
}
function attack(state, b, turnId, abilityKey, targetId, action = 'formal', rng = randomInt) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending, '已有攻击等待防守。');
  const ability = abilities(p).find(a => a.key === abilityKey);
  ok(ability, '武器／技能当前不可用。');
  const t = ability.attack; const target = actorById(b, targetId); const targetP = actorCharacter(state, target);
  ok(actor.id !== target.id && targetP.hp > 0 && !target.retreated, '目标不可用。');
  ok(['quick', 'formal'].includes(action) && turn[action] > 0, '该行动次数已用完。');
  if (t.kind === '技能') ok(action === (t.action || 'formal'), '技能须使用指定的行动类型。');
  else if (action === 'quick') ok(t.supernatural, '普通武器攻击需要正式行动。');
  if (t.melee) ok(Math.floor(actor.x / 50) === Math.floor(target.x / 50) && Math.floor(actor.y / 50) === Math.floor(target.y / 50), '近战必须同格。');
  else ok(Math.hypot(actor.x - target.x, actor.y - target.y) <= t.range * 50 + 0.000001, '目标超出有效射程。');
  if (t.kind === '技能' && t.casting) {
    if (!actor.casting) {
      turn[action]--; actor.casting = { key: abilityKey, name: t.name, required: t.casting, count: 1, confirmed: false };
      record(b, actor.name + '开始吟唱' + t.name + '。');
      return { casting: true };
    }
    ok(actor.casting.key === abilityKey && actor.casting.confirmed, '请先完成并用快速行动确认吟唱。');
    actor.casting = null;
  }
  const weapon = p.inventory[abilityKey];
  let ammoEffects = [];
  if (C.FIREARMS.includes(t.weaponType)) {
    ok(weapon?.loaded?.current > 0, '弹药已空，请装填。');
    if (weapon.loaded.rounds) ammoEffects = clone(weapon.loaded.rounds.shift().effects || []);
    weapon.loaded.current--;
  } else if (['弓', '弩'].includes(t.weaponType)) {
    const ammunition = Object.values(p.inventory).find(i => i.snapshot.kind === '弹药' && i.snapshot.ammoType === t.ammoType &&
      (actor.userId ? M.available(state, actor.userId, i.id) > 0 : i.quantity > 0));
    ok(ammunition, '缺少对应箭矢。'); ammoEffects = clone(ammunition.snapshot.effects || []);
    ammunition.quantity--; if (!ammunition.quantity) delete p.inventory[ammunition.id];
  }
  turn[action]--;
  const s = M.stats(p, ammoEffects); const targetStats = M.stats(targetP);
  const damage = {}; const rolls = {};
  for (const [type, expression] of Object.entries(t.damage)) {
    if (!expression) continue;
    const roll = C.dice(expression, 'normal', rng); rolls[type] = roll;
    let base = Math.max(0, roll.total);
    if (t.melee && type === t.primary) base += s.attributes.strength;
    base = M.modify(s.effects, 'attack:' + type, base);
    if (type !== 'physical') base *= 1 + s.attributes.intelligence * 0.1;
    damage[type] = Math.max(0, base);
  }
  const pending = { id: id('h'), turnId, attackerId: actor.id, targetId, attackName: t.name,
    hit: M.modify(s.effects, 'hit', t.hit), damage, rolls, conditions: clone(t.conditions || []),
    defenses: clone(targetStats.defenses), agility: M.signedModifier(targetStats.effects, 'dodge', targetStats.attributes.agility), expiresAt: Date.now() + 60000 };
  b.pending = pending;
  record(b, actor.name + '使用' + t.name + '攻击' + target.name + '，等待防守。', { hit: pending.hit, damage, rolls });
  return pending;
}
function defend(state, b, pendingId, choice, rng = randomInt) {
  ok(['active', 'paused'].includes(b.status) && b.pending?.id === pendingId, '攻防已结算，请刷新。');
  ok(['defend', 'dodge', 'both', 'none'].includes(choice), '防守方式无效。');
  const hit = b.pending; const target = actorById(b, hit.targetId); const p = actorCharacter(state, target);
  const defaulted = hit.expiresAt <= Date.now();
  if (defaulted) choice = 'defend';
  let dodge = null;
  if (['dodge', 'both'].includes(choice)) {
    dodge = C.dice('1d20', 'disadvantage', rng);
    dodge.total += hit.agility; dodge.success = p.hp > 0 && dodge.total > hit.hit;
  }
  let total = 0; const breakdown = {}; const saves = [];
  if (!dodge?.success) {
    const fraction = choice === 'both' ? 0.5 : choice === 'defend' ? 1 : 0;
    for (const [type, value] of Object.entries(hit.damage)) {
      breakdown[type] = Math.max(0, Math.floor(value - hit.defenses[type] * fraction)); total += breakdown[type];
    }
    p.hp = Math.max(0, p.hp - total);
    for (const ref of hit.conditions) saves.push(applyCondition(state, p, ref, rng, hit.attackerId));
  }
  record(b, target.name + (dodge?.success ? '成功闪避。' : '受到' + total + '伤害，剩余' + p.hp + 'HP。'),
    { choice, dodge, breakdown, saves });
  b.pending = null;
  const result = { target: target.name, total, dodge, breakdown, saves, hp: p.hp, defaulted };
  if (b.status === 'active' && b.current) {
    const active = actorById(b, b.current.actorId);
    if (actorCharacter(state, active).hp <= 0) {
      endConditions(actorCharacter(state, active), b, active, rng);
      b.current = null; nextOpportunity(state, b, rng);
    }
  }
  return result;
}
function confirmCasting(state, b, turnId) {
  const { actor, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0 && actor.casting && actor.casting.count >= actor.casting.required, '吟唱未完成或快速行动已用完。');
  turn.quick--; actor.casting.confirmed = true;
  record(b, actor.name + '确认吟唱完成。');
}
function reload(state, b, turnId, ammunitionId, magazineId) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0, '快速行动不可用。');
  const weapon = p.inventory[p.equipped.weapon]; const ammo = p.inventory[ammunitionId];
  ok(weapon?.loaded && ammo?.snapshot.kind === '弹药' && ammo.snapshot.ammoType === weapon.snapshot.ammoType, '武器和弹药不兼容。');
  if (magazineId) {
    const magazine = p.inventory[magazineId];
    ok(magazine?.snapshot.kind === '弹夹' && magazine.snapshot.magazineType === weapon.snapshot.magazineType &&
      magazine.snapshot.ammoType === weapon.snapshot.ammoType && magazine.snapshot.capacity >= weapon.loaded.capacity, '弹夹与武器不兼容。');
    ok(!M.isAttached(p, magazineId) || weapon.magazineId === magazineId, '弹夹已装到其他武器。');
    if (actor.userId) ok(M.available(state, actor.userId, magazineId) > 0, '弹夹已被预留。');
    weapon.magazineId = magazineId;
  }
  ok(weapon.magazineId && p.inventory[weapon.magazineId]?.snapshot.kind === '弹夹', '缺少已装配的兼容弹夹。');
  const quantity = Math.min(weapon.loaded.capacity - weapon.loaded.current,
    actor.userId ? M.available(state, actor.userId, ammunitionId) : ammo.quantity);
  ok(quantity > 0, '载弹已满或可用弹药不足。');
  weapon.loaded.rounds ||= Array.from({ length: weapon.loaded.current }, () => ({ weight: weapon.loaded.weight, effects: [] }));
  weapon.loaded.rounds.push(...Array.from({ length: quantity }, () => ({ weight: ammo.snapshot.weight, effects: clone(ammo.snapshot.effects || []) })));
  weapon.loaded.current += quantity; weapon.loaded.weight = ammo.snapshot.weight;
  ammo.quantity -= quantity; if (!ammo.quantity) delete p.inventory[ammunitionId];
  turn.quick--;
  M.syncHP(p);
  record(b, actor.name + '装填' + quantity + '发弹药。');
}
function switchWeapon(state, b, turnId, itemId) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0, '快速行动不可用。');
  if (itemId) {
    ok(p.inventory[itemId]?.snapshot.kind === '武器', '武器不可用。');
    if (actor.userId) ok(M.available(state, actor.userId, itemId) > 0, '武器已被交易预留。');
  }
  p.equipped.weapon = itemId || null; turn.quick--; M.syncHP(p);
}
function useItem(state, b, turnId, itemId, rng = randomInt) {
  const { actor, p, turn } = current(state, b, turnId);
  ok(!b.pending && turn.quick > 0, '快速行动不可用。');
  const item = p.inventory[itemId];
  ok(item?.snapshot.kind === '消耗品', '该道具没有已录入的使用效果。');
  if (actor.userId) ok(M.available(state, actor.userId, itemId) > 0, '道具已预留。');
  const result = M.consume(p, itemId, rng);
  turn.quick--; record(b, actor.name + '使用' + result.name + '，恢复' + result.healed + 'HP。', result);
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
  nextOpportunity, start, current, finish, pass, movementCost, move, UNARMED, abilities, attack, defend,
  confirmCasting, reload, switchWeapon, useItem, flee, pause, endBattle };
