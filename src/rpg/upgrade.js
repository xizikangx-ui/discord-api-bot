'use strict';
const C = require('./constants');
const PRICES = { white: 10, green: 60, blue: 300, purple: 1000, gold: 3750, red: 165000 };
// Per-item estimates in game yuan; rarity is a band, not a random price roll.
const SEED_PRICES = [
  [3,45,240,850,3200,180000], [5,35,180,1100,2300,140000],
  [2,55,200,900,2800,210000], [4,70,160,1400,4200,130000],
  [6,65,350,1200,5500,250000], [8,80,300,1450,5800,170000],
  [12,40,150,600,1800,30000], [15,95,450,1500,3600,200000],
  [10,50,320,800,4500,220000], [9,75,120,750,5000,240000],
  [7,85,280,1000,4000,160000], [5,100,400,1300,3000,290000]
];
function seedPrice(id) {
  const m = /^seed_(\d+)_(white|green|blue|purple|gold|red)$/.exec(id || '');
  return m && SEED_PRICES[Number(m[1])]?.[['white','green','blue','purple','gold','red'].indexOf(m[2])];
}
function migrate(state) {
  if (state.upgrade >= 5) return null;
  const report = { balancesReset: 0, prices: 0, ranges: 0, cancelledOffers: 0 };
  for (const p of Object.values(state.players)) {
    p.balance = 0; p.luck ??= 1; p.gender ??= null; p.profile ||= {}; p.portraits ||= {};
    p.allocationVersion ??= 0; p.profileVersion ??= 0; report.balancesReset++;
  }
  for (const o of Object.values(state.offers)) if (['editing','ready'].includes(o.status)) {
    o.status = 'cancelled'; o.cancelReason = '物价升级，余额清零，请重新报价'; report.cancelledOffers++;
  }
  const seen = new Set();
  function walk(value, ref) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.kind && value.rarity && Object.hasOwn(value,'value')) {
      if (value.value !== 0) value.value = (seedPrice(value.id) ?? seedPrice(ref) ?? require('./modern-props').catalog()[value.id||ref]?.value) ?? PRICES[value.rarity] ?? value.value;
      report.prices++;
    }
    if (['武器','技能'].includes(value.kind) || (value.damage && Object.hasOwn(value,'range'))) {
      value.rangeMeters ??= (value.range ?? 1) * 50; report.ranges++;
    }
    if (value.snapshot) walk(value.snapshot, value.templateId);
    for (const [key, child] of Object.entries(value)) if (!['snapshot','history','recent','finalCharacter'].includes(key)) walk(child, key);
  }
  // Historical events, deaths and completed publication payloads are immutable.
  for (const root of ['catalog','players','characterDrafts','forms','npcTemplates','roomTemplates','explorations','corpses']) walk(state[root]);
  for(const b of Object.values(state.battles))if(b.status!=='ended')walk(b);
  state.economyMigration = { version: 1, at: Date.now(), ...report };
  state.upgrade = 5;
  return report;
}
module.exports = { PRICES, SEED_PRICES, seedPrice, migrate };
