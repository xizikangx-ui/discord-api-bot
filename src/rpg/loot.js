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
function rates(state, box) { const K=require('./containers');if(state.contentPackVersion===1&&box!=='card'){const d=K.get(state,box);C.requireThat(d,'箱型无效。');return C.clone(state.config.containerRates?.[d.grade]||K.DEFAULTS[d.grade]);}return C.clone(state.config.safeRates?.[box] || DEFAULT_SAFE_RATES[box] || (K.ALL.includes(box)?K.DEFAULTS[K.grade(box)]:null)); }
function setGradeRates(state, grade, values){const K=require('./containers');C.requireThat(K.DEFAULTS[grade],'档位无效。');state.config.containerRates||=C.clone(K.DEFAULTS);state.config.containerRates[grade]=validateRates(values);}
function setRates(state, box, values) {
  C.requireThat(DEFAULT_SAFE_RATES[box], '只能单独配置四种保险箱。');
  state.config.safeRates ||= {}; state.config.safeRates[box] = validateRates(values);
}
function adjustedRates(state, box, luck = 1) {
  const base = rates(state, box) || COLORS.map(id => C.RARITIES.find(r => r.id === id).weight / 10);
  const k = Math.abs(Math.max(-9, Math.min(11, Math.floor(luck))) - 1);
  const boost = .5 * Math.min(k,4) + .25 * Math.min(Math.max(k-4,0),4) + .1 * Math.min(Math.max(k-8,0),2);
  const recipients = COLORS.map((_,i)=>i).filter(i=>base[i]>0 && (luck>1 ? i>=3 : luck<1 ? i<3 : false));
  const donors = COLORS.map((_,i)=>i).filter(i=>!recipients.includes(i));
  const sum = donors.reduce((s,i)=>s+base[i],0), delta = recipients.length ? Math.min(boost,sum/recipients.length) : 0;
  const raw = base.map((v,i)=>100*(recipients.includes(i) ? v+delta : sum ? v*(sum-recipients.length*delta)/sum : v));
  const weights = raw.map(v=>Math.max(0,Math.floor(v+1e-9)));
  const order = COLORS.map((_,i)=>i).filter(i=>base[i]>0).sort((a,b)=>(raw[b]-weights[b])-(raw[a]-weights[a])||a-b);
  for (let n=10000-weights.reduce((a,b)=>a+b,0),i=0;n>0;n--,i++) weights[order[i%order.length]]++;
  return weights.map(v=>v/100);
}
function rarity(state, box, rng = randomInt, luck = 1, frozenRates) {
  const values = frozenRates || adjustedRates(state, box, luck);
  let draw = rng(0, 10000);
  for (let n = 0; n < values.length; n++) {
    draw -= Math.round(values[n] * 100);
    if (draw < 0) return C.RARITIES.find(r => r.id === COLORS[n]);
  }
  throw new Error('保险箱概率配置无效。');
}
// The same generator is used by personal tickets and free, shared map containers.
function generate(state, box, rng = randomInt, luck = 1, existingContainer = false) {
  const M = require('./model');
  C.requireThat(box === 'card' || C.BOXES.includes(box), '箱型无效。');
  C.requireThat(box==='card'||existingContainer||require('./containers').get(state,box)?.enabled!==false,'该容器已停用。');
  const batch = { id: C.id('z'), items: [], containerGrade:box==='card'?null:require('./containers').get(state,box).grade, luck, rates: adjustedRates(state, box, luck), createdAt: Date.now() };
  const size = box === 'card' ? 1 : rng(1, 7);
  for (let n = 0; n < size; n++) {
    const r = rarity(state, box, rng, luck, batch.rates);
    let pool = Object.values(state.catalog).filter(t => t.published && t.rarity === r.id &&
      (box === 'card' ? t.kind === '卡牌' : (t.boxes || []).includes(box)));
    if (!pool.length && box === 'card') pool = [{ id: 'blank_' + r.id, version: 1, kind: '卡牌', name: r.name + '色空白卡牌',
      rarity: r.id, weight: 0, value: 0, effects: [], traitIds: [], uniqueText: '等待GM定义能力。', description: '同色占位卡牌。' }];
    C.requireThat(pool.length, '该箱型的' + r.name + '色掉落池未配置。');
    const item = M.makeItem(pool[rng(0, pool.length)]);
    batch.items.push(item);
  }
  return batch;
}
module.exports = { DEFAULT_SAFE_RATES, COLORS, validateRates, rates, setRates, adjustedRates, rarity, generate, setGradeRates };
