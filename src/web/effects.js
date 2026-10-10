'use strict';
// Present only confirmed new enemy deaths. An area attack waits for every target.
function killIds(value) {
  const ids=new Set();
  const walk=v=>{if(!v||typeof v!=='object')return;if(v.killed===true&&typeof v.deathId==='string')ids.add(v.deathId);for(const c of Object.values(v))if(c&&typeof c==='object')walk(c);};
  walk(value);return [...ids];
}
function eventDeaths(state,battle,event) {
  if(event.type==='attack'&&event.details.children?.some(c=>!c.result))return [];
  const ids=killIds(event);
  return ids.filter(id=>{
    const death=state.deaths[id];
    if(!death||death.team!=='enemy'||death.battleId!==battle.id)return false;
    if(event.type!=='attack'&&battle.publicEvents.some(e=>e.type==='attack'&&killIds(e).includes(id)))return false;
    return true;
  });
}
module.exports={killIds,eventDeaths};
