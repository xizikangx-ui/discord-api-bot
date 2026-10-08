'use strict';
const H = require('./health');
function migrate(state) {
  if (state.upgrade >= 7) return null;
  for (const name of ['couponPools', 'couponRedemptions', 'glossaryTerms', 'bossPools']) state[name] ||= {};
  for (const [uid,p] of Object.entries(state.players)) { p.userId = uid; p.couponBalances ||= {}; p.showcase ||= []; H.ensure(p); }
  state.upgrade = 7;
  return { features: 7, players: Object.keys(state.players).length };
}
module.exports = { migrate };
