'use strict';
const C = require('./constants');
const ONE_HAND = new Set(['刀', '剑', '斧', '匕首', '手枪', '其他']);
function hands(t) {
  return t.handedness === 'one' ? 1 : t.handedness === 'two' ? 2 : ONE_HAND.has(t.weaponType) ? 1 : 2;
}
const label = t => hands(t) === 2 ? '双手武器' : '单手武器';
function equipped(p) {
  const main = p.inventory[p.equipped.weapon];
  return [...new Set([p.equipped.weapon, ...(main && hands(main.snapshot) === 2 ? [] : [p.equipped.offhand])])]
    .filter(id => p.inventory[id]?.snapshot.kind === '武器');
}
function set(p, id, slot = 'auto', remove = false) {
  C.requireThat(['main', 'off', 'auto'].includes(slot), '请选择主手或副手。');
  if (!id) { p.equipped.weapon = null; p.equipped.offhand = null; return; }
  C.requireThat(p.inventory[id]?.snapshot.kind === '武器', '武器不可用。');
  if (remove) {
    if (p.equipped.weapon === id) p.equipped.weapon = null;
    if (p.equipped.offhand === id) p.equipped.offhand = null;
    return;
  }
  if (hands(p.inventory[id].snapshot) === 2) { p.equipped.weapon = id; p.equipped.offhand = null; return; }
  if (slot === 'auto' && equipped(p).includes(id)) return;
  if (p.inventory[p.equipped.weapon] && hands(p.inventory[p.equipped.weapon].snapshot) === 2) p.equipped.weapon = null;
  if (slot === 'auto') slot = !p.equipped.weapon ? 'main' : !p.equipped.offhand ? 'off' : 'main';
  if (p.equipped.weapon === id) p.equipped.weapon = null;
  if (p.equipped.offhand === id) p.equipped.offhand = null;
  p.equipped[slot === 'main' ? 'weapon' : 'offhand'] = id;
}
function describe(p) {
  const main = p.inventory[p.equipped.weapon], off = p.inventory[p.equipped.offhand];
  return '主手：' + (main ? main.snapshot.name + '（' + label(main.snapshot) + '）' : '空') + '\n副手：' +
    (main && hands(main.snapshot) === 2 ? '由双手武器占用' : off?.snapshot.name || '空');
}
module.exports = { hands, label, equipped, set, describe };
