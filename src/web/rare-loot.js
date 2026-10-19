'use strict';
// Display metadata comes only from saved random results, never chat text or
// client-supplied rarity. Keep the payload small and safe for public cards.
const C=require('../rpg/constants'),Loot=require('./battle-loot'),crypto=require('node:crypto');
function items(values){return (values||[]).filter(i=>['gold','red'].includes((i.snapshot||i).rarity)).map(i=>{
 const t=i.snapshot||i;return {id:i.id,templateId:i.templateId||t.id,name:t.name,rarity:t.rarity,kind:t.kind,quantity:i.quantity||1};
});}
function event(state,ref,values,now=Date.now()){
 const rare=items(values);if(!rare.length)return null;
 return {id:'rare:'+ref.id,groupId:state.guildId||state.guild,channelId:ref.channelId||state.config?.announcementChannelId,visibility:ref.visibility||'room',
  committedAt:now,kind:ref.kind,title:ref.title,pending:!!ref.pending,items:rare,
  ...Object.fromEntries(['uid','mapId','battleId','journeyId','nodeId','cell'].filter(k=>ref[k]!==undefined).map(k=>[k,ref[k]]))};
}
function text(state,uid,result){return (state.players?.[uid]?.name||'角色')+'开启'+(result.box==='card'?'抽卡':result.box)+'：\n'+result.items.map(i=>i.snapshot.name+' ×'+i.quantity).join('\n')+(result.pending?'\n超重，整批等待领取。':'');}
function openJob(state,uid,result,{channelId,mapId,cell,first=true,now=Date.now()}={}){
 const key='web:loot:'+result.batchId,old=state.deliveryJobs?.[key],rare=first&&!old?event(state,{id:'batch:'+result.batchId,kind:result.box==='card'?'card':'container',title:result.box==='card'?'抽卡发现珍藏':result.box+' · 稀有发现',pending:result.pending,channelId,uid,mapId,cell},result.items,now):null;
 state.deliveryJobs||={};state.deliveryJobs[key]={key,kind:'webLoot',uid,...Object.fromEntries(Object.entries({roomId:channelId,mapId,cell}).filter(([,v])=>v!==undefined)),status:'pending',desiredRevision:state.revision+1,priority:4,text:text(state,uid,result),items:C.clone(result.items),...(old?.rareLoot?{rareLoot:old.rareLoot}:rare?{rareLoot:[rare]}:{})};
 return rare;
}
function worldNodes(state){return [...Object.values(state.worldSites||{}).filter(n=>!n.id.includes(':archive:')),...Object.values(state.worldJourneys||{}).flatMap(j=>(j.nodes||[]).map(n=>({...n,journeyId:j.id})))];}
function derive(before,next,now=Date.now()){
 next.deliveryJobs||={};
 // Exploration had a saved publication but no website delivery worker. The
 // same batch now publishes both its textual result and its rare metadata.
 for(const [id,p]of Object.entries(next.lootPublications||{})){
  if(!p.result?.batchId)continue;
  const old=before.lootPublications?.[id];
  if(old&&JSON.stringify(old.result)===JSON.stringify(p.result))continue;
  const map=Object.values(next.explorations||{}).find(m=>Object.values(m.cells||{}).some(c=>c.room?.containers?.some(b=>b.batch?.id===p.result.batchId)));
  const cell=map&&Object.keys(map.cells).find(ref=>map.cells[ref].room?.containers?.some(b=>b.batch?.id===p.result.batchId));
  openJob(next,p.userId,p.result,{channelId:p.channelId,mapId:map?.id,cell,first:!old,now});
 }
 const previous=new Map(worldNodes(before).map(n=>[n.id,n]));
 for(const n of worldNodes(next)){
  if(!n.revealed||n.kind!=='supply'||previous.get(n.id)?.revealed)continue;
  const batch=crypto.createHash('sha256').update((n.items||[]).map(i=>i.id).sort().join(':')).digest('hex').slice(0,20),ref=n.id+':'+batch;
  const trip=n.journeyId&&next.worldJourneys?.[n.journeyId];if(n.journeyId&&!trip)continue;
  const rare=event(next,{id:'world:'+ref,kind:'world',title:n.title||'旅途物资',journeyId:n.journeyId,nodeId:n.id,pending:true,visibility:trip?'audience':'room'},n.items,now);
  if(!rare)continue;const key='web:rare-world:'+ref;
  if(trip){rare.recipientIds=[...trip.members];rare.gm=true;}
  next.deliveryJobs[key]={key,kind:trip?'webRarePrivate':'webWorld',...(n.journeyId?{journeyId:n.journeyId}:{}),nodeId:n.id,...(trip?{members:[...trip.members],gm:true}:{}),status:'pending',desiredRevision:next.revision,priority:4,...(!trip?{text:(n.title||'旅途物资')+'已揭示：\n'+n.items.map(i=>i.snapshot.name+' ×'+i.quantity).join('\n')+'\n团队共享，等待领取。'}:{}),rareLoot:[rare]};
 }
 for(const battle of Object.values(next.battles||{})){
  if(!Loot.ready(next,battle)||Loot.ready(before,before.battles?.[battle.id]))continue;
  const corpses=Object.values(next.corpses||{}).filter(c=>c.battleId===battle.id),rare=event(next,{id:'battle:'+battle.id,kind:'battle',title:battle.name+' · 战利品解锁',channelId:battle.channelId,battleId:battle.id,pending:true},corpses.flatMap(c=>c.items.filter(i=>!c.claims?.[i.id])),now);
  const job=next.deliveryJobs['web:corpses:'+battle.id];if(rare&&job&&!job.suppressCelebration)job.rareLoot=[rare];
 }
}
function attachReceipt(before,next){
 const fresh=Object.entries(next.deliveryJobs||{}).flatMap(([key,j])=>(j.rareLoot||[]).filter(e=>!(before.deliveryJobs?.[key]?.rareLoot||[]).some(old=>old.id===e.id)));
 if(!fresh.length)return;
 const last=next.events?.at(-1),op=last?.id,receipt=next.receipts?.[op];
 if(!receipt?.result||typeof receipt.result!=='object')return;
 const merge=result=>{result.rareLoot=[...new Map([...(result.rareLoot||[]),...fresh].map(e=>[e.id,e])).values()];};
 merge(receipt.result);merge(last.result);
 for(const f of Object.values(next.forms||{}))if(f.result?.operationId===op)merge(f.result);
}
module.exports={items,event,text,openJob,worldNodes,derive,attachReceipt};
