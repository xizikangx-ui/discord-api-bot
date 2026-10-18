'use strict';
const C=require('../rpg/constants'),S=require('./security'),{createHash}=require('node:crypto');
const contains=(v,ids,seen=new WeakSet())=>typeof v==='string'?ids.has(v):v&&typeof v==='object'&&!seen.has(v)?(seen.add(v),Object.values(v).some(x=>contains(x,ids,seen))):false;
function capture(s){const maps=new Set(Object.keys(s.explorations)),battles=new Set();for(const b of Object.values(s.battles))if(b.exploration?.mapId){maps.add(b.exploration.mapId);battles.add(b.id);}for(const m of Object.values(s.explorations))for(const c of Object.values(m.cells))if(c.room?.battleId&&s.battles[c.room.battleId])battles.add(c.room.battleId);return{maps:[...maps],battles:[...battles]};}
function clear(s,target,jobId,now=Date.now()){
 S.ok(s.platform==='web','只能清理网站探索。');
 const ids=new Set([...target.maps,...target.battles]),mapSet=new Set(target.maps),battleSet=new Set(target.battles),batchIds=new Set(target.maps.flatMap(id=>Object.values(s.explorations[id]?.cells||{}).flatMap(c=>(c.room?.containers||[]).map(x=>x.batch?.id).filter(Boolean)))),report={mapIds:target.maps,battleIds:target.battles,maps:0,battles:0,corpses:0,drafts:0,jobs:0,worldBindings:0};
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const protectedState=()=>({players:digest(s.players),independentBattles:digest(Object.fromEntries(Object.entries(s.battles).filter(([id])=>!battleSet.has(id)))),awardedRewards:digest(Object.fromEntries(Object.entries(s.deaths).map(([id,d])=>[id,d.rewarded||null])))}),before=protectedState();
 s.mapTombstones||={};s.battleTombstones||={};s.sceneClearOperations||={};
 for(const id of target.maps){const m=s.explorations[id];s.mapTombstones[id]={name:m?.name||s.mapTombstones[id]?.name||'旧探索场景',at:now,jobId};if(m){delete s.explorations[id];report.maps++;}}
 for(const id of target.battles){const b=s.battles[id];if(b){s.battleTombstones[id]={name:b.name,at:now,jobId};delete s.battles[id];report.battles++;}}
 for(const [id,c]of Object.entries(s.corpses))if(battleSet.has(c.battleId)){delete s.corpses[id];report.corpses++;}
 for(const f of Object.values(s.forms))if(contains(f,ids)){if(f.result?.operationId)s.sceneClearOperations[f.result.operationId]={at:now,jobId};delete s.forms[f.id];report.drafts++;}
 for(const [op,r]of Object.entries(s.receipts))if(contains(r.result,ids))s.sceneClearOperations[op]={at:now,jobId};
 const pubIds=new Set(Object.values(s.lootPublications).filter(p=>batchIds.has(p.result?.batchId)||contains(p,ids)).map(p=>p.id));
 for(const j of Object.values(s.deliveryJobs))if(contains(j,ids)||contains(j,batchIds)||contains(j,pubIds)){j.status='done';j.cancelledAt=now;j.cancelReason='关联场景已清理';report.jobs++;}
 for(const id of pubIds)delete s.lootPublications[id];
 const detach=n=>{if(!n||typeof n!=='object')return;if(mapSet.has(n.mapId)||battleSet.has(n.battleId)){delete n.mapId;delete n.battleId;n.sceneCleared={jobId,at:now};n.needsRebind=true;n.status='pending';n.version=(n.version||0)+1;report.worldBindings++;}};
 for(const site of Object.values(s.worldSites||{}))detach(site);
 for(const j of Object.values(s.worldJourneys||{})){let count=report.worldBindings;for(const n of j.nodes||[])detach(n);if(count!==report.worldBindings)j.version++;}
 // Death and reward ledgers are intentionally retained; their former scene is explicit.
 for(const d of Object.values(s.deaths))if(battleSet.has(d.battleId))d.sceneClearedAt=now;
 const after=protectedState();S.ok(JSON.stringify(before)===JSON.stringify(after),'清理资产核对失败，整团回滚。');report.preserved=after;
 return report;
}
function publicStatus(j){return{id:j.id,status:j.status,groupCount:j.groupIds.length,completedGroups:Object.keys(j.results||{}).length,results:j.results,startedAt:j.startedAt,completedAt:j.completedAt,errorCode:j.errorCode};}
function createReset({repo,accounts,games,broadcast=()=>{}}){
 const running=new Map();let stopped=false;
 async function preview(user){accounts.admin(await accounts.user(user.id));const groups=[];for(const g of await repo.list('group'))if(!g.deleting){await games.ensure(g.id,{maintenance:true});groups.push({groupId:g.id,...games.store.select(g.id,capture)});}return{groups};}
 async function status(user,id){accounts.admin(await accounts.user(user.id));const j=await repo.get('explorationReset',id);S.ok(j,'未找到清理任务。','NOT_FOUND');return publicStatus(j);}
 async function start(user,p){accounts.admin(await accounts.user(user.id));S.ok(/^[\w-]{8,100}$/.test(p.operationId||''),'操作编号无效。');S.text(p.reason,'清理理由',1000);S.ok(p.scope==='all-existing-explorations','清理范围无效。');
 const job=await repo.tx('exploration-reset:'+p.operationId,async r=>{await r.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['web:exploration-reset-global']);accounts.admin(await accounts.user(user.id,r));const prior=await repo.get('explorationReset',p.operationId,r);if(prior)return prior;S.ok(!(await repo.list('explorationReset',undefined,r)).some(j=>j.status!=='completed'),'已有清理任务，请查询其进度。','CONFLICT');const groupIds=(await repo.list('group',undefined,r)).filter(g=>!g.deleting).map(g=>g.id),j={id:p.operationId,actorId:user.id,reason:p.reason,groupIds,status:'running',startedAt:Date.now(),results:{}};await repo.put('explorationReset',j,{},r);return j;});
 const current=await repo.get('explorationReset',job.id)||job;
 if(current.status!=='completed'){for(const group of current.groupIds)if(!current.results[group])games.setResetFence(group,'web-reset:'+current.id+':'+group);void run(current.id).catch(()=>{});}return publicStatus(current);}
 async function run(id){if(running.has(id))return running.get(id);const task=(async()=>{let j=await repo.get('explorationReset',id);if(!j||j.status==='completed')return;for(const group of j.groupIds)if(!j.results[group])games.setResetFence(group,'web-reset:'+j.id+':'+group);
 try{for(const group of j.groupIds){if(stopped)break;if(j.results[group]){games.setResetFence(group,null);continue;}const g=await repo.get('group',group);if(!g||g.deleting){j.results[group]={skipped:'团已删除'};}else{await games.ensure(group,{maintenance:true});await games.waitForPublications();const result=await games.store.transact(group,'web-reset:'+j.id+':'+group,j.actorId,s=>clear(s,capture(s),j.id),'管理员清理全部旧探索及关联战斗',{delivery:false,lifecycle:false,maintenance:true});j.results[group]=result;await repo.put('explorationReset',j);broadcast(group,{type:'scenes-cleared',data:{groupId:group,mapIds:result.mapIds,battleIds:result.battleIds}});}await repo.put('explorationReset',j);games.setResetFence(group,null);}
 if(!stopped){j.status='completed';j.completedAt=Date.now();delete j.errorCode;await repo.put('explorationReset',j);}}
 catch(e){j.status='cleanup_error';j.errorCode=e.code||'CLEANUP';await repo.put('explorationReset',j);}})();running.set(id,task);try{await task;}finally{running.delete(id);}}
 async function resume(){for(const j of await repo.list('explorationReset'))if(j.status!=='completed')await run(j.id);}
 async function restoreFences(){for(const j of await repo.list('explorationReset'))if(j.status!=='completed')for(const group of j.groupIds)if(!j.results[group])games.setResetFence(group,'web-reset:'+j.id+':'+group);}
 return{preview,start,status,resume,restoreFences,stop:async()=>{stopped=true;await Promise.allSettled([...running.values()]);}};
}
function decorate(messages,tombstones){return messages.map(m=>m.system&&(tombstones.maps[m.system.mapId]||tombstones.battles[m.system.battleId])?{...m,system:{cleared:true,kind:'sceneCleared',label:'场景已清理'},sceneCleared:true}:m);}
module.exports={capture,clear,createReset,decorate,contains};
