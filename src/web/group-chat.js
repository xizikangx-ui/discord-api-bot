'use strict';
const S=require('./security');
const POLICY=1, RESET_ID='group-chat-history-v1';
const roomIds=groupId=>({publicRoomId:'group:'+S.hash(groupId),gmRoomId:'gm:'+S.hash(groupId)});
async function bootstrapGroup(repo,group,r){
 const ids=roomIds(group.id);
 for(const [id,kind,name,extra] of [[ids.publicRoomId,'chat',group.name+' · 群聊',{groupChat:true}],[ids.gmRoomId,'gm','GM 待办',{workbenchOnly:true}]]){
  const old=await repo.get('room',id,r);
  if(!old)await repo.put('room',{id,groupId:group.id,name,kind,sequence:0,version:1,...extra},{scope:group.id},r);
 }
 Object.assign(group,ids,{chatRoomId:ids.publicRoomId,groupChatVersion:POLICY});
 await repo.put('group',group,{},r);return ids;
}
function remapState(s,{publicRoomId,gmRoomId,rooms=[],resetId=RESET_ID,at=Date.now()}){
 S.ok(s.platform==='web','只能迁移网站团群聊。');
 const hidden=r=>r.kind==='gm'||r.restricted||r.members?.length;
 const publicIds=new Set(rooms.filter(r=>r.kind!=='dm'&&!hidden(r)).map(r=>r.id)),gmIds=new Set(rooms.filter(hidden).map(r=>r.id));
 const historical=new Set(['receipts','events','publicEvents','snapshot','result','rolls','dice','history','audit']);
 const walk=(v)=>{if(!v||typeof v!=='object')return;for(const [key,value]of Object.entries(v)){if(historical.has(key))continue;if(typeof value==='string'&&/(?:channelId|ChannelId|roomId)$/.test(key)){if(publicIds.has(value))v[key]=publicRoomId;else if(gmIds.has(value))v[key]=gmRoomId;}else if(value&&typeof value==='object')walk(value);}};
 // Snapshots, rolls, audits and completed receipts remain byte-for-byte. Only
 // live destinations are re-pointed; historical records are never replayed.
 for(const key of ['config','battles','explorations','checks','sessions','worldSettings','worldJourneys','forms'])walk(s[key]);
 s.config.announcementChannelId=publicRoomId;s.config.gmChannelId=gmRoomId;
 s.deliveryJobs||={};
 for(const j of Object.values(s.deliveryJobs))if(j.kind?.startsWith('web')&&j.status!=='done')Object.assign(j,{status:'done',cancelledAt:at,cancelReason:'旧聊天历史已清理',chatResetId:resetId});
 const add=j=>{s.deliveryJobs[j.key]={...j,status:'pending',desiredRevision:s.revision+1,chatResetId:resetId,suppressCelebration:true};};
 for(const b of Object.values(s.battles||{})){
  if(b.status==='active'){
   for(const h of require('../rpg/aoe').hits(b)){const target=b.actors.find(a=>a.id===h.targetId);if(target?.userId&&h.expiresAt>at)add({key:'web:defense:'+b.id+':'+h.id,kind:'webDefense',roomId:b.channelId||publicRoomId,battleId:b.id,targetId:target.id,hitId:h.id,expiresAt:h.expiresAt,text:target.name+'受到攻击，请打开战斗面板防守。',priority:0});}
   const actor=b.actors.find(a=>a.id===b.current?.actorId);if(actor?.userId)add({key:'web:turn:'+b.id+':'+b.current.id,kind:'webTurn',roomId:b.channelId||publicRoomId,battleId:b.id,targetId:actor.id,turnId:b.current.id,priority:1});
  }
  if(b.judgment&&b.status!=='ended')add({key:'web:judgment:'+b.id,kind:'webNotice',roomId:gmRoomId,battleId:b.id,text:'全队倒地，等待GM裁决。',priority:0});
  if(b.status==='ended'&&Object.values(s.corpses||{}).some(c=>c.battleId===b.id&&c.items?.some(i=>!c.claims?.[i.id])))add({key:'web:corpses:'+b.id,kind:'webCorpses',roomId:b.channelId||publicRoomId,battleId:b.id,priority:2});
 }
 for(const m of Object.values(s.explorations||{})){
  const pendingMove=Object.values(m.moves||{}).some(x=>x.status==='pending'&&x.expiresAt>at);
  if(pendingMove)add({key:'web:map:'+m.id,kind:'webMap',roomId:m.channelId||publicRoomId,mapId:m.id,priority:1});
  for(const rp of Object.values(m.rps||{}))if(rp.status==='pending')add({key:'web:rp:'+m.id+':'+rp.id,kind:'webNotice',roomId:gmRoomId,mapId:m.id,rpId:rp.id,text:'环境描述待GM发布：'+rp.name,priority:1});
  for(const [cell,c]of Object.entries(m.cells||{}))if(c.room?.bossRequest?.status==='pending')add({key:'web:boss:'+m.id+':'+cell,kind:'webNotice',roomId:gmRoomId,mapId:m.id,cell,text:'BOSS房等待GM确认。',priority:0});
 }
 s.groupChatMigration={version:POLICY,resetId,at,publicRoomId,gmRoomId};
 return{remapped:true,publicRoomId,gmRoomId,gameRevision:s.revision};
}
function referencedMedia(value,id,seen=new WeakSet()){
 if(!value||typeof value!=='object'||seen.has(value))return false;seen.add(value);
 return Object.entries(value).some(([k,v])=>typeof v==='string'?(['webMediaId','mediaId','portraitMediaId','avatarMediaId'].includes(k)&&v===id):v&&typeof v==='object'&&referencedMedia(v,id,seen));
}
function createGroupChat({repo,accounts,games,storage={},broadcast=()=>{}}){
 let running,stopped=false;
 const publicStatus=j=>({id:j.id,status:j.status,startedAt:j.startedAt,completedAt:j.completedAt,groups:j.groups.map(g=>({groupId:g.groupId,status:j.results?.[g.groupId]?.status||'pending',messages:j.results?.[g.groupId]?.messages||0})),errorCode:j.errorCode});
 async function prepare({enabled=false,operationId=RESET_ID}={}){
  const old=await repo.get('chatReset',operationId);if(old)return publicStatus(old);if(!enabled)return null;
  const j=await repo.tx('chat-reset-prepare:'+operationId,async r=>{
   await r.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['web:chat-reset-global']);
   const prior=await repo.get('chatReset',operationId,r);if(prior)return prior;
   const groups=[];for(const hint of await repo.list('group',undefined,r)){const g=await repo.get('group',hint.id,r,true);if(!g||g.deleting)continue;const rooms=await repo.list('room',g.id,r);groups.push({groupId:g.id,rooms:rooms.map(x=>({id:x.id,kind:x.kind,restricted:!!x.members?.length})),cutoffs:rooms.map(x=>({roomId:x.id,sequence:x.sequence||0}))});g.chatResetActive=operationId;await repo.put('group',g,{},r);}
   const value={id:operationId,status:'running',startedAt:Date.now(),groups,results:{}};await repo.put('chatReset',value,{},r);return value;
  });
  for(const g of j.groups)if(!j.results[g.groupId])games?.setResetFence?.(g.groupId,'web-chat-reset:'+j.id+':'+g.groupId);
  return publicStatus(j);
 }
 async function cleanMedia(j,target,r){
  const rooms=new Set(target.cutoffs.map(c=>c.roomId));let count=0;
  const candidates=(await repo.list('media',undefined,r)).filter(f=>(f.kind==='chat'||(!f.kind&&f.roomId))&&rooms.has(f.roomId)&&(f.at||0)<=j.startedAt);
  const records=[];for(const kind of ['user','group','npc','draft'])records.push(...await repo.list(kind,undefined,r));
  let game;try{game=games?.store?.select(target.groupId,s=>s);}catch{}
  for(const f of candidates){if(await repo.hasMediaReference?.(f.id,r)||records.some(v=>referencedMedia(v,f.id))||referencedMedia(game,f.id))continue;
   // A newer message may use an existing staged upload. Preserve it if it does.
   const linked=f.messageId&&await repo.findMessage(f.messageId,r);if(linked&&!linked.deleted)continue;
   await repo.put('mediaCleanup',{id:'chat-reset:'+j.id+':'+f.id,key:f.key,groupId:f.groupId,chatResetId:j.id,mediaId:f.id}, {},r);
   await repo.remove('media',f.id,r);count++;
  }return count;
 }
 async function cleanupObjects(){for(const f of await repo.list('mediaCleanup'))if(f.chatResetId){if(!storage.client||!storage.bucket||!storage.commands?.DeleteObjectCommand)continue;try{await storage.client.send(new storage.commands.DeleteObjectCommand({Bucket:storage.bucket,Key:f.key}));await repo.remove('mediaCleanup',f.id);}catch{/* Durable deletion resumes on the next pass. */}}}
 async function run(id){let j=await repo.get('chatReset',id);if(!j||j.status==='completed')return j;
  try{for(const target of j.groups){if(stopped)break;const group=target.groupId;if(j.results[group]?.status==='completed'){games?.setResetFence?.(group,null);continue;}
   games?.setResetFence?.(group,'web-chat-reset:'+j.id+':'+group);await games?.waitForPublications?.();
   const g=await repo.get('group',group);if(!g||g.deleting){j.results[group]={status:'completed',skipped:'团已删除'};await repo.put('chatReset',j);games?.setResetFence?.(group,null);continue;}
   const ids=roomIds(group);let gameResult={gameRevision:0};
   if(games){await games.ensure(group,{maintenance:true});gameResult=await games.store.transact(group,'web-chat-reset:'+j.id+':'+group,'system:web',s=>remapState(s,{...ids,rooms:target.rooms,resetId:j.id,at:j.startedAt}),'迁移独立团群聊',{delivery:false,lifecycle:false,maintenance:true});}
   const result=await repo.tx('chat-reset-group:'+j.id+':'+group,async r=>{
    const live=await repo.get('group',group,r,true);if(!live||live.deleting)return{status:'completed',skipped:'团已删除'};
    const cleared=await repo.clearChatHistory(group,target.cutoffs,j.id,r);
    await bootstrapGroup(repo,live,r);
    for(const room of await repo.list('room',group,r))if(room.kind!=='dm'&&room.id!==ids.publicRoomId&&room.id!==ids.gmRoomId){room.archived=true;room.supersededBy=room.kind==='gm'||room.members?.length?ids.gmRoomId:ids.publicRoomId;room.chatResetId=j.id;room.version=(room.version||0)+1;await repo.put('room',room,{scope:group},r);}
    live.chatResetId=j.id;live.chatResetAt=j.startedAt;live.historyGameRevision=gameResult.gameRevision||0;delete live.chatResetActive;await repo.put('group',live,{},r);
    const media=await cleanMedia(j,target,r);return{status:'completed',...cleared,media};
   });j.results[group]=result;await repo.put('chatReset',j);games?.setResetFence?.(group,null);broadcast(group,{type:'chat-reset',data:{groupId:group,...ids,resetId:j.id}});
  }
  if(!stopped){j.status='completed';j.completedAt=Date.now();delete j.errorCode;await repo.put('chatReset',j);}await cleanupObjects();return j;
  }catch(e){j.status='cleanup_error';j.errorCode=e.code||'CHAT_RESET';await repo.put('chatReset',j);throw e;}
 }
 async function resume(){if(running)return running;stopped=false;running=(async()=>{for(const j of await repo.list('chatReset'))if(j.status!=='completed')await run(j.id);await cleanupObjects();})().finally(()=>{running=null;});return running;}
 async function route(roomId){const room=await repo.get('room',roomId);return room?.supersededBy||roomId;}
 async function bootstrap(groupId){return repo.tx('group-chat-bootstrap:'+groupId,async r=>{const group=await repo.get('group',groupId,r,true);S.ok(group&&!group.deleting,'跑团不存在。','NOT_FOUND');return bootstrapGroup(repo,group,r);});}
 return{prepare,resume,route,bootstrapGroup:bootstrap,cleanupObjects,status:async()=>{const j=await repo.get('chatReset',RESET_ID);return j?publicStatus(j):null;},stop:async()=>{stopped=true;await running;}};
}
module.exports={POLICY,RESET_ID,roomIds,bootstrapGroup,remapState,createGroupChat,referencedMedia};
