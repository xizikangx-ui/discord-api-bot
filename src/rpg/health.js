'use strict';
const C = require('./constants');
const maximum = p => require('./model').stats(p).maxHP;
function ensure(p) {
  if (!p.userId) return;
  p.life ||= { state: p.hp > 0 ? 'standing' : 'downed', reserveHP: maximum(p), version: 0 };
  sync(p);
  return p.life;
}
function sync(p) {
  if (p.life) { const previous=p.life.reserveHP; p.life.reserveHP = p.life.state==='standing' ? maximum(p) : Math.max(0, Math.min(p.life.reserveHP, maximum(p))); if(p.life.state==='downed'&&previous>0&&!p.life.reserveHP){p.life.state='dead';p.life.version++;} }
}
const downed = p => !!p && p.hp <= 0 && p.life?.state === 'downed';
const alive = p => !!p && (p.hp > 0 || downed(p));
const canAct = p => !!p && p.hp > 0 && p.life?.state !== 'dead';
function requireAction(p) { C.requireThat(canAct(p), '角色已倒地，暂不能行动或操作资产，请等待同伴或GM救援。'); }
function snapshot(p) { return { hp: p.hp, maxHP: maximum(p), ...(p.userId ? { reserveHP: p.life?.reserveHP ?? maximum(p), downed: downed(p) } : {}) }; }
function enter(p, round = null) {
  const life = ensure(p);
  if (!life || life.state === 'dead') return false;
  p.hp = 0; life.reserveHP = maximum(p); life.state = life.reserveHP>0?'downed':'dead'; life.version++;
  life.downRound = round; return true;
}
// One call is one strike: damage types combine, burst shots call separately.
function damage(p, amount, round = null) {
  amount = C.number(amount, '伤害', 0, Number.MAX_SAFE_INTEGER);
  ensure(p); const before = snapshot(p); let entered = false, ignored = 0;
  if (p.hp > 0) {
    const loss = Math.min(p.hp, amount); p.hp -= loss;
    if (!p.hp && p.userId) { entered = enter(p, round); ignored = amount - loss; }
  } else if (downed(p)) {
    p.life.reserveHP = Math.max(0, p.life.reserveHP - amount); p.life.version++;
    if (!p.life.reserveHP) p.life.state = 'dead';
  }
  return { before, after: snapshot(p), entered, ignored, hpLoss: before.hp - p.hp,
    reserveLoss: before.downed ? before.reserveHP - p.life.reserveHP : 0 };
}
function heal(p, amount) {
  amount = C.number(amount, '治疗量', 0, Number.MAX_SAFE_INTEGER);
  ensure(p); const before = snapshot(p);
  C.requireThat(alive(p), '已经死亡的角色不能治疗。');
  let remaining = amount;
  if (downed(p)) { const restored = Math.min(remaining, maximum(p) - p.life.reserveHP); p.life.reserveHP += restored; remaining -= restored; }
  p.hp = Math.min(maximum(p), p.hp + remaining);
  if (p.life) { if (p.hp > 0) p.life.state = 'standing'; p.life.version++; }
  return { before, after: snapshot(p), healed: Math.max(0, p.hp - before.hp),
    reserveHealed: p.userId ? p.life.reserveHP - before.reserveHP : 0, revived: before.downed && p.hp > 0 };
}
function set(p, value, bar = 'normal', round = null) {
  ensure(p); value = C.number(value, '生命', 0, maximum(p));
  if (bar === 'reserve') { C.requireThat(downed(p), '只有倒地玩家可调整倒地血条。'); p.life.reserveHP = value; if (!value) p.life.state = 'dead'; p.life.version++; }
  else { const previous = p.hp; p.hp = value; if (!value && previous > 0 && p.userId) enter(p, round); else if (value > 0 && p.life) { p.life.state = 'standing'; p.life.version++; } }
  return snapshot(p);
}
function forceDeath(p) { p.hp = 0; if (p.userId) { ensure(p); p.life.state = 'dead'; p.life.reserveHP = 0; p.life.version++; } }
function text(p) { const h = snapshot(p); return '正常 HP '+h.hp+'/'+h.maxHP+(p.userId ? ' · 倒地 HP '+h.reserveHP+'/'+h.maxHP+(h.downed?' **倒地**':'（待用）') : ''); }
module.exports = { ensure, sync, alive, downed, canAct, requireAction, snapshot, enter, damage, heal, set, forceDeath, text };
