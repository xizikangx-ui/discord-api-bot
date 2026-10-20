'use strict';
const B=require('../rpg/combat'),A=require('../rpg/aoe'),AI=require('../rpg/npc-auto'),Team=require('../rpg/team-movement');
const pending=o=>['editing','ready'].includes(o.status);
function effects(s){return Object.values(s.players).concat(Object.values(s.battles).filter(b=>b.status!=='ended').flatMap(b=>b.actors.filter(a=>!a.userId&&!a.deathId).map(a=>a.character))).filter(Boolean).flatMap(p=>p.temporaryEffects||[]).filter(e=>e.duration?.kind==='minutes'&&Number.isFinite(e.expiresAt));}
function due(s,now,lifecycle){return lifecycle(s)||Object.values(s.offers).some(o=>pending(o)&&o.expiresAt<=now)||effects(s).some(e=>e.expiresAt<=now)||Object.values(s.sessions).some(x=>x.status!=='cancelled'&&x.reminder.status==='pending'&&x.startsAt<=now)||Object.values(s.worldJourneys||{}).some(j=>['confirming','approval'].includes(j.status)&&j.expiresAt<=now)||Object.values(s.explorations).some(m=>m.status==='active'&&(Team.pendingAuto(s,m)||Object.values(m.moves||{}).some(r=>r.status==='pending'&&r.expiresAt<=now)))||Object.values(s.battles).some(b=>b.status==='active'&&(AI.due(s,b)||A.hits(b).some(h=>h.expiresAt<=now)));}
function processDue(s,now){
 require('../rpg/model').expireOffers(s,now);
 require('../rpg/activities').expireAll(s,now);require('./world').expire(s,now);
 for(const x of Object.values(s.sessions))if(x.status!=='cancelled'&&x.startsAt<=now&&x.reminder.status==='pending'){x.status='notified';x.reminder.status='sent';x.reminder.webDeliveredAt=now;x.version++;}
 for(const m of Object.values(s.explorations))Team.expire(s,m,now);
 for(const b of Object.values(s.battles))if(b.status==='active'){for(const h of [...A.hits(b)])if(h.expiresAt<=now&&A.hit(b,h.id))B.defend(s,b,h.id,'defend');if(AI.due(s,b))AI.step(s,b);}
 Team.autoEncounters(s);return {tick:true};
}
function delay(s,now,lifecycle){
 if(due(s,now,lifecycle))return 100;
 let at=now+30000;const add=t=>{if(Number.isFinite(t))at=Math.min(at,t);};
 for(const b of Object.values(s.battles))if(b.status==='active'){for(const h of A.hits(b))add(h.expiresAt);if(b.current&&!b.pending&&b.actors.some(a=>a.id===b.current.actorId&&!a.userId&&AI.config(a.ai).mode==='auto'))add(now+1000);}
 for(const o of Object.values(s.offers))if(pending(o))add(o.expiresAt);
 for(const e of effects(s))add(e.expiresAt);
 for(const x of Object.values(s.sessions))if(x.status!=='cancelled'&&x.reminder.status==='pending')add(x.startsAt);
 for(const m of Object.values(s.explorations))if(m.status==='active')for(const r of Object.values(m.moves||{}))if(r.status==='pending')add(r.expiresAt);
 for(const j of Object.values(s.worldJourneys||{}))if(['confirming','approval'].includes(j.status))add(j.expiresAt);
 for(const j of Object.values(s.deliveryJobs||{}))if(j.kind.startsWith('web')&&j.status==='pending')add(Math.max(now+1000,j.availableAt||0));
 return Math.max(100,at-now);
}
module.exports={due,processDue,delay};
