'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants');
const DEFAULT_SAFE_RATES = {
  小型保险: [30, 30, 25, 11, 3, 1], 保险箱: [20, 25, 30, 18, 5, 2],
  军需保险箱: [10, 20, 35, 25, 7, 3], 武库保险箱: [5, 15, 35, 30, 10, 5]
};
const COLORS = ['white', 'green', 'blue', 'purple', 'gold', 'red'];
function validateRates(values) {
  C.requireThat(Array.isArray(values) && values.length === 6, '按白、绿、蓝、紫、金、红填写六个概率。');
  const weights = values.map(v => {
    const n = C.number(v, '概率', 0, 100, false);
    C.requireThat(Math.abs(n * 100 - Math.round(n * 100)) < 1e-7, '概率最多两位小数。');
    return Math.round(n * 100);
  });
  C.requireThat(weights.reduce((a, b) => a + b, 0) === 10000, '六色概率之和必须为100%。');
  return weights.map(n => n / 100);
}
function rates(state, box) { return C.clone(state.config.safeRates?.[box] || DEFAULT_SAFE_RATES[box] || null); }
function setRates(state, box, values) {
  C.requireThat(DEFAULT_SAFE_RATES[box], '只能单独配置四种保险箱。');
  state.config.safeRates ||= {}; state.config.safeRates[box] = validateRates(values);
}
function rarity(state, box, rng = randomInt) {
  const values = rates(state, box);
  if (!values) return C.rarity(rng);
  let draw = rng(0, 10000);
  for (let n = 0; n < values.length; n++) {
    draw -= Math.round(values[n] * 100);
    if (draw < 0) return C.RARITIES.find(r => r.id === COLORS[n]);
  }
  throw new Error('保险箱概率配置无效。');
}
// The same generator is used by personal tickets and free, shared map containers.
function generate(state, box, rng = randomInt) {
  const M = require('./model');
  C.requireThat(box === 'card' || C.BOXES.includes(box), '箱型无效。');
  const batch = { id: C.id('z'), items: [], rates: rates(state, box), createdAt: Date.now() };
  const size = box === 'card' ? 1 : rng(1, 7);
  for (let n = 0; n < size; n++) {
    const r = rarity(state, box, rng);
    let pool = Object.values(state.catalog).filter(t => t.published && t.rarity === r.id &&
      (box === 'card' ? t.kind === '卡牌' : (t.boxes || []).includes(box)));
    if (!pool.length && box === 'card') pool = [{ id: 'blank_' + r.id, version: 1, kind: '卡牌', name: r.name + '色空白卡牌',
      rarity: r.id, weight: 0, value: 0, effects: [], traitIds: [], uniqueText: '等待GM定义能力。', description: '同色占位卡牌。' }];
    C.requireThat(pool.length, '该箱型的' + r.name + '色掉落池未配置。');
    const item = M.makeItem(pool[rng(0, pool.length)]);
    if (box !== 'card') item.snapshot.value = rng(r.min, r.max + 1);
    batch.items.push(item);
  }
  return batch;
}
module.exports = { DEFAULT_SAFE_RATES, COLORS, validateRates, rates, setRates, rarity, generate };
