'use strict';
function migrate(s, now = Date.now()) {
  s.merchantTemplates ||= {}; s.merchantTrades ||= {};
  if (s.upgrade >= 8) return null;
  let deadlines=0, images=0;
  const extend=f=>{if(f&&!f.done&&!['done','cancelled','expired','rejected','completed'].includes(f.status)&&Number.isFinite(f.expiresAt)&&f.expiresAt>now){f.expiresAt+=60000;deadlines++;}};
  for(const f of Object.values(s.forms||{}))if(!f.battleId||s.battles?.[f.battleId]?.status!=='ended')extend(f);
  for(const o of Object.values(s.offers||{}))if(['editing','ready'].includes(o.status))extend(o);
  for(const m of Object.values(s.explorations||{}))for(const r of Object.values(m.moves||{}))if(r.status==='pending')extend(r);
  for(const b of Object.values(s.battles||{}))if(b.status!=='ended'){
    for(const h of require('./aoe').hits(b))extend(h);
    if(b.pending?.kind==='aoe')b.pending.expiresAt=Math.max(...b.pending.hits.map(h=>h.expiresAt));
    for(const slot of [...(b.publicEvents||[]),...Object.values(b.npcCards||{})])if(slot.imagePublication&&slot.imagePublication.status!=='sent')slot.imagePublication.status='disabled';
  }
  for(const j of Object.values(s.deliveryJobs||{}))if(j.kind==='eventImage'&&j.status!=='done'){j.status='done';j.disabledReason='文字操作卡';images++;}
  s.upgrade=8;return {interaction:8,deadlines,images};
}
module.exports={migrate};
