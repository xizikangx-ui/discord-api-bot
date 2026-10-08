'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants'), M = require('./model');
const { requireThat: ok, clone, number: num } = C;

function migrateLegacy(state) {
  if (state.upgrade >= 3) return null;
  const report = { descriptions: 0, players: 0, pendingBatches: 0 };
  state.checks ||= {}; state.sessions ||= {}; state.lootPublications ||= {};
  const seeds = C.seedCatalog();
  function replace(item, ref) {
    const t = seeds[ref];
    if (t && ref.startsWith('seed_') && item.description === '现代场景中的' + t.name + '，价值为游戏内估值。') {
      item.description = t.description; report.descriptions++;
    }
  }
  for (const [ref, t] of Object.entries(state.catalog)) {
    const before = t.description; replace(t, ref);
    if (t.description !== before) t.version++;
  }
  function character(p) {
    if (!p.temporaryEffects) { p.temporaryEffects = []; report.players++; }
    p.faction ??= null;
    for (const [box, item] of Object.entries(p.pendingLoot || {})) if (!item.items) {
      p.pendingLoot[box] = { id: item.id, items: [item] }; report.pendingBatches++;
    }
    for (const item of [...Object.values(p.inventory), ...Object.values(p.pendingLoot || {}).flatMap(b => b.items)]) replace(item.snapshot, item.templateId);
  }
  for (const p of Object.values(state.players)) character(p);
  for (const b of Object.values(state.battles)) for (const a of b.actors) if (!a.userId && !a.finalCharacter) character(a.character);
  state.upgrade = 3;
  return report;
}
function migrateMaps(state) {
  if (state.upgrade >= 4) return null;
  const old = migrateLegacy(state);
  state.mapCategories ||= {}; state.roomTemplates ||= {}; state.explorations ||= {}; state.deaths ||= {}; state.corpses ||= {};
  state.config.safeRates ||= {};
  for (const t of Object.values(state.npcTemplates)) { t.humanoid ??= false; t.baseXP ??= 0; }
  for (const b of Object.values(state.battles)) for (const a of b.actors) {
    if (!a.userId) { a.humanoid ??= false; a.baseXP ??= 0; }
    else a.characterId ||= (a.finalCharacter || state.players[a.userId])?.id;
  }
  state.upgrade = 4;
  return { ...(old || {}), previous: old, maps: true, deaths: true, historicalRewards: 0 };
}
function migrate(state) {
  const maps = migrateMaps(state), roles = require('./upgrade').migrate(state), actions = require('./action-rules-upgrade').migrate(state);
  const features = require('./features-upgrade').migrate(state);
  const interaction = require('./interaction-upgrade').migrate(state);
  return maps || roles || actions || features || interaction ? { ...(maps || {}), ...(roles || {}), ...(actions || {}), ...(features || {}), ...(interaction || {}) } : null;
}
function parseBeijing(value, now = Date.now()) {
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  ok(m, '时间请按北京时间 YYYY-MM-DD HH:mm 填写。');
  const [, y, mo, d, h, mi] = m.map(Number);
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi));
  ok(y >= 2026 && y <= 2100 && local.getUTCFullYear() === y && local.getUTCMonth() === mo - 1 &&
    local.getUTCDate() === d && local.getUTCHours() === h && local.getUTCMinutes() === mi, '日期或时间无效。');
  const at = local.getTime() - 8 * 3600000;
  ok(at > now, '开团时间必须晚于现在。'); return at;
}
function beijing(at) {
  return new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}
function validateCheck(raw) {
  const data = clone(raw);
  data.name = C.text(data.name, '鉴定名称', 80);
  data.description = C.text(data.description || '', '任务说明', 2000, true);
  ok(['d20', 'd100'].includes(data.rule), '请选择d20或d100鉴定。');
  data.threshold = num(data.threshold, '鉴定门槛', 1, data.rule === 'd100' ? 100 : 1000000);
  data.attribute = data.rule === 'd20' ? data.attribute || 'none' : 'none';
  ok(data.attribute === 'none' || C.ATTRIBUTES[data.attribute], '鉴定属性无效。');
  data.maxAttempts = num(data.maxAttempts ?? 1, '每人次数', 1, 10);
  return data;
}
function createCheck(state, owner, channelId, raw) {
  if(raw.skillId){
    const skill=state.checkSkillTemplates?.[raw.skillId];ok(skill?.published,'鉴定技能未发布。');ok(raw.rule==='d20','技能鉴定使用d20规则。');
    ok(!raw.attribute||raw.attribute==='none','技能等级与属性不叠加，请将属性设为无。');
    raw={...raw,skillName:skill.name,skillVersion:skill.version,attribute:'none'};
  }
  const c = { ...validateCheck(raw), id: C.id('q'), owner, channelId, status: 'open', version: 1,
    attempts: {}, createdAt: Date.now(), messageId: null };
  state.checks[c.id] = c; return c;
}
function rollCheck(state, ref, userId, rng = randomInt) {
  const c = state.checks[ref]; ok(c?.status === 'open', '鉴定已结束。');
  const p = M.player(state, userId), attempts = c.attempts[userId] || [];
  ok(!attempts.some(a => a.success), '已经成功完成本次鉴定。');
  ok(attempts.length < c.maxAttempts, '本次鉴定的次数已经用完。');
  M.expireEffects(p);
  const skill=c.skillId?p.checkSkills?.[c.skillId]:null;
  ok(!c.skillId||skill,'尚未学习本次鉴定需要的技能，请GM发放。');
  const roll = C.dice(c.rule === 'd20' ? '1d20' : '1d100', 'normal', rng);
  const modifier = skill?skill.level:c.attribute === 'none' ? 0 : M.stats(p).attributes[c.attribute];
  const total = roll.total + modifier;
  const attempt = { id: C.id('r'), userId, characterId: p.id, at: Date.now(), roll, modifier, total,
    ...(skill?{skillId:c.skillId,skillName:skill.name,skillLevel:skill.level}:{}),
    threshold: c.threshold, success: c.rule === 'd20' ? total >= c.threshold : total <= c.threshold, number: attempts.length + 1 };
  c.attempts[userId] = [...attempts, attempt]; return attempt;
}
function createSession(state, owner, channelId, raw, now = Date.now()) {
  const data = validateSession(raw, now);
  const s = { ...data, id: C.id('s'), owner, channelId, status: 'open', version: 1,
    participants: {}, messageId: null, createdAt: now, reminder: { status: 'pending', batches: [] } };
  state.sessions[s.id] = s; return s;
}
function validateSession(raw, now = Date.now()) {
  return { name: C.text(raw.name, '团名', 80), description: C.text(raw.description || '', '说明', 2000, true),
    startsAt: typeof raw.startsAt === 'string' ? parseBeijing(raw.startsAt, now) : num(raw.startsAt, '开团时间', now + 1, Date.UTC(2101, 0, 1)) };
}
function sessionJoin(state, ref, userId, withdraw = false, now = Date.now()) {
  const s = state.sessions[ref]; ok(s?.status === 'open' && s.startsAt > now, '报名已经关闭。');
  if (withdraw) { delete s.participants[userId]; return false; }
  if (!s.participants[userId]) s.participants[userId] = { userId, at: now };
  return true;
}
function editSession(state, ref, raw, version, now = Date.now()) {
  const s = state.sessions[ref]; ok(s && ['open', 'closed'].includes(s.status) && s.reminder.status === 'pending' &&
    s.startsAt > now && s.version === version, '开团状态或版本已经变化，不能修改。');
  Object.assign(s, validateSession(raw, now)); s.version++; return s;
}
function prepareReminder(state, ref, now = Date.now(), manual = false) {
  const s = state.sessions[ref];
  ok(s && !['cancelled', 'notified'].includes(s.status), '开团已取消或提醒完成。');
  ok(manual || s.startsAt <= now, '尚未到开团时间。');
  if (!manual && now - s.startsAt > 15 * 60000) {
    if (s.reminder.status === 'pending') { s.status = 'overdue'; s.reminder.status = 'overdue'; }
    return null;
  }
  ok(['pending', 'overdue', 'failed', 'uncertain'].includes(s.reminder.status), '提醒正在处理。');
  s.status = 'closed'; s.reminder.status = 'preparing';
  s.reminder.users ||= Object.keys(s.participants);
  return clone(s.reminder.users);
}
function expireAll(state, now = Date.now()) {
  const changed = new Set();
  for (const p of Object.values(state.players)) if (M.expireEffects(p, now).length) changed.add(p.id);
  for (const b of Object.values(state.battles)) if (b.status !== 'ended') {
    for (const a of b.actors) if (!a.userId && !a.deathId && M.expireEffects(a.character, now).length) changed.add(a.character.id);
    if (b.current) {
      const a = b.actors.find(a => a.id === b.current.actorId), p = a?.userId ? state.players[a.userId] : a?.character;
      if (p) {
        const remaining = Math.max(0, C.round2(M.stats(p).move - (b.current.moveSpent || 0)));
        b.current.move = changed.has(p.id) ? remaining : Math.min(b.current.move, remaining);
      }
    }
  }
  return [...changed];
}
module.exports = { migrate, parseBeijing, beijing, validateCheck, createCheck, rollCheck, createSession, validateSession,
  sessionJoin, editSession, prepareReminder, expireAll };
