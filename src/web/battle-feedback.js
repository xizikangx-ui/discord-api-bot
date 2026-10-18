'use strict';
function ids(e){const d=e.details||{},children=d.children||[],launchHitIds=[...new Set([d.hitId,...children.map(c=>c.id)].filter(Boolean))],settledHitIds=[],deathIds=[];
 const add=(r,id)=>{if(!r)return;if(id)settledHitIds.push(id);if(r.killed&&r.deathId)deathIds.push(r.deathId);};
 if(e.type==='result')add(d,d.hitId);for(const c of children)add(c.result,c.id);for(const r of d.results||[])add(r,r.id||r.hitId);if(e.type==='death'&&d.deathId)deathIds.push(d.deathId);
 return{launchHitIds,settledHitIds:[...new Set(settledHitIds)],deathIds:[...new Set(deathIds)]};}
function baseline(battles){return battles.flatMap(b=>(b.publicEvents||[]).slice(-100).map(e=>({battleId:b.id,eventId:e.id,version:e.version,at:e.at,...ids(e)})));}
module.exports={ids,baseline};
