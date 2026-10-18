'use strict';
// Website-only, one-time request to turn existing NPCs automatic. Future
// explicit GM choices are authoritative; this is never a refresh-time default.
function migrate(state){
 if(state.platform!=='web'||state.webNpcAutoVersion===1)return null;
 const report={version:1,templates:0,actors:0,snapshots:0},seen=new WeakSet();
 function automatic(target,kind){if(!target||typeof target!=='object'||seen.has(target))return;seen.add(target);if(target.ai?.mode!=='auto'){target.ai={...(target.ai||{}),mode:'auto'};report[kind]++;}}
 function room(value){
  if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
  for(const key of ['npcs','remainingNpcs','randomNpcs'])for(const entry of value[key]||[])automatic(entry.template,'snapshots');
  if(value.snapshot)room(value.snapshot);
  for(const variant of value.variants||[])if(variant.overrides)room(variant.overrides);
 }
 for(const t of Object.values(state.npcTemplates||{}))automatic(t,'templates');
 for(const b of Object.values(state.battles||{}))if(b.status!=='ended')for(const a of b.actors||[])if(!a.userId)automatic(a,'actors');
 for(const r of Object.values(state.roomTemplates||{}))room(r);
 for(const m of Object.values(state.explorations||{}))if(m.status!=='ended')for(const c of Object.values(m.cells||{})){room(c.room);room(c.bossOriginal);}
 state.webNpcAutoVersion=1;return report;
}
module.exports={migrate};
