'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),C=require('../src/rpg/constants'),M=require('../src/rpg/model');
const op=()=>crypto.randomUUID();
function privateFieldsAbsent(value){const json=JSON.stringify(value);for(const token of ['"layout"','"roster"','"characters"','hidden-room-marker','private_map_layout_marker','不应公开的怪物模板'])assert.ok(!json.includes(token),token);}
async function cases(t,h){
 const group=h.group.id,prefix='/groups/'+group,owner=h.admin,other=h.player,source='acl-region',child='acl-inside';
 // Existing restricted bindings still need permission tests after new groups
 // stopped offering channel creation. Seed a legacy record, not a new UI path.
 const privateRoom={id:op(),groupId:group,name:'秘密目标频道名不得进入错误提示',kind:'chat',members:[owner.user.id],sequence:0,version:1};await h.repo.put('room',privateRoom,{scope:group});
 async function reset(targetChannel=h.room.id){
  await h.app.games.store.transact(group,op(),h.user.id,s=>{
   if(!s.players[owner.user.id]){const p=M.newCharacter('领队',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5});p.userId=owner.user.id;s.players[p.userId]=p;}
   s.players[owner.user.id].inventory.sentinel={id:'sentinel',templateId:'sentinel-key',quantity:1,keyCharges:5,snapshot:{name:'保留的钥匙',kind:'钥匙',weight:0,value:1}};
   s.explorations[source]={id:source,channelId:h.room.id,name:'公开区域',mapType:'region',status:'active',width:3,floors:1,entrance:'0,0',version:1,generated:true,cells:{'0,0':{type:'entrance'},'1,0':{type:'building',buildingMapId:child},'2,0':{type:'room',room:{id:'hidden-room-marker',snapshot:{name:'不应公开的怪物模板',description:'private_map_layout_marker',autoStart:false},encounter:'pending',npcs:[],remainingNpcs:[],containers:[],supplies:[]}}},revealed:{'0,0':true,'1,0':true},participants:Object.fromEntries([owner,other].map(a=>[a.user.id,{characterId:s.players[a.user.id].id,cell:'1,0'}])),moves:{},rps:{}};
   s.explorations[child]={id:child,channelId:targetChannel,name:'内部地图',mapType:'indoor',status:'active',width:1,floors:1,entrance:'0,0',version:1,generated:true,cells:{'0,0':{type:'entrance'}},revealed:{'0,0':true},participants:{},moves:{},rps:{}};
   return{reset:true};
  });
 }
 async function execute(actor,command,params,operationId=op()){
  const v=await h.request(actor,prefix+'/game?sections=core,explore');assert.equal(v.status,200,JSON.stringify(v.error));
  return h.request(actor,prefix+'/game/execute',{command,params,versions:v.data.versions,operationId});
 }
 const state=()=>h.app.games.store.snapshot(group);
 function unchanged(before){const after=state();assert.deepEqual(after.players,before.players);assert.deepEqual(after.explorations,before.explorations);assert.deepEqual(after.forms,before.forms);assert.equal(after.players[owner.user.id].inventory.sentinel.keyCharges,5);}
 await t.test('a leader cannot propose entry when another team member cannot read the target channel',async()=>{
  await reset(privateRoom.id);const before=state(),r=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.equal(r.status,403,JSON.stringify(r));assert.ok(!JSON.stringify(r.error).includes(privateRoom.name));unchanged(before);
 });
 await t.test('permission loss after proposal rejects final consent without changing votes or moving characters',async()=>{
  await reset();const proposal=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.equal(proposal.status,200,JSON.stringify(proposal.error));const requestId=proposal.data.result.id;
  // Keep the source readable while revoking only the target permission.
  await h.app.games.store.transact(group,op(),h.user.id,s=>{s.explorations[child].channelId=privateRoom.id;return{restricted:true};});
  const before=state(),r=await execute(other,'map.vote',{mapId:source,requestId,yes:true});assert.equal(r.status,403,JSON.stringify(r));assert.deepEqual(state().explorations[source].moves[requestId].yes,[owner.user.id]);unchanged(before);
 });
 await t.test('old preview drafts recheck every member before committing a linked-map proposal',async()=>{
  await reset();const preview=await h.request(owner,prefix+'/game/preview',{command:'map.link',params:{mapId:source,kind:'enter'},clientId:op()});assert.equal(preview.status,200,JSON.stringify(preview.error));
  await h.app.games.store.transact(group,op(),h.user.id,s=>{s.explorations[child].channelId=privateRoom.id;return{restricted:true};});
  const before=state(),r=await h.request(owner,prefix+'/game/commit',{draftId:preview.data.id});assert.equal(r.status,403,JSON.stringify(r));assert.equal(state().forms[preview.data.id].status,'ready');unchanged(before);
 });
 await t.test('the locked executor resolves the actual target from its transaction state, not a stale preflight snapshot',async()=>{
  await reset();const original=h.app.games.store.transact;let injected=false;
  h.app.games.store.transact=function(g,id,actor,fn,label,options){return original.call(this,g,id,actor,async s=>{if(g===group&&id.startsWith('web-direct:')&&!injected){injected=true;s.explorations[child].channelId=privateRoom.id;}return fn(s);},label,options);};
  const before=state();try{const r=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.ok(injected);assert.equal(r.status,403,JSON.stringify(r));unchanged(before);}finally{h.app.games.store.transact=original;}
 });
 await t.test('cross-group target channels are rejected even when both teammates belong to that other group',async()=>{
  const foreign=await h.app.accounts.createGroup(h.user,{name:'另一权限测试团'},op()),room=(await h.repo.list('room',foreign.id)).find(r=>r.kind==='chat');await h.repo.put('member',{id:foreign.id+':'+other.user.id,groupId:foreign.id,userId:other.user.id,role:'player',active:true,version:1},{scope:foreign.id});
  await reset(room.id);const before=state(),r=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.equal(r.status,403,JSON.stringify(r));unchanged(before);
 });
 await t.test('removed members cannot be carried into a child map by a still-authorized leader',async()=>{
  await reset();const member=await h.repo.get('member',group+':'+other.user.id);await h.repo.put('member',{...member,active:false},{scope:group});
  const before=state();try{const r=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.equal(r.status,403,JSON.stringify(r));unchanged(before);}finally{await h.repo.put('member',member,{scope:group});}
 });
 await t.test('ordinary in-map movement is unaffected by a private child binding',async()=>{
  await reset(privateRoom.id);const r=await execute(owner,'map.move',{mapId:source,cell:'0,0'});assert.equal(r.status,200,JSON.stringify(r.error));privateFieldsAbsent(r.data);const voted=await execute(other,'map.vote',{mapId:source,requestId:r.data.result.id,yes:true});assert.equal(voted.status,200,JSON.stringify(voted.error));privateFieldsAbsent(voted.data);assert.equal(state().explorations[source].participants[owner.user.id].cell,'0,0');
 });
 await t.test('authorized team entry and return use the original confirmation flow once',async()=>{
  await reset();const r=await execute(owner,'map.link',{mapId:source,kind:'enter'});assert.equal(r.status,200,JSON.stringify(r.error));const voteOp=op(),vote=await execute(other,'map.vote',{mapId:source,requestId:r.data.result.id,yes:true},voteOp);assert.equal(vote.status,200,JSON.stringify(vote.error));assert.equal(state().explorations[child].participants[owner.user.id].cell,'0,0');assert.equal(Object.keys(state().explorations[source].participants).length,0);
  const entered=state(),again=await execute(other,'map.vote',{mapId:source,requestId:r.data.result.id,yes:true},voteOp);assert.deepEqual(again.data,vote.data);unchanged(entered);
  const back=await execute(owner,'map.link',{mapId:child,kind:'exit'});assert.equal(back.status,200,JSON.stringify(back.error));assert.equal((await execute(other,'map.vote',{mapId:child,requestId:back.data.result.id,yes:true})).status,200);assert.equal(state().explorations[source].participants[owner.user.id].cell,'1,0');assert.equal(Object.keys(state().explorations[child].participants).length,0);assert.equal(state().players[owner.user.id].inventory.sentinel.keyCharges,5);
 });
 await t.test('single-player immediate entry retries return the saved result without a second move',async()=>{
  await reset();await h.app.games.store.transact(group,op(),h.user.id,s=>{delete s.explorations[source].participants[other.user.id];return{solo:true};});
  const operationId=op(),first=await execute(owner,'map.link',{mapId:source,kind:'enter'},operationId);assert.equal(first.status,200,JSON.stringify(first.error));assert.equal(first.data.result.status,'completed');const before=state();
  const replay=await execute(owner,'map.link',{mapId:source,kind:'enter'},operationId);assert.equal(replay.status,200,JSON.stringify(replay.error));assert.deepEqual(replay.data,first.data);unchanged(before);
  assert.equal((await execute(owner,'map.link',{mapId:source,kind:'exit'},operationId)).status,409);
 });
 await t.test('old map results are sanitized in direct receipts, legacy commits and action history without rewriting their audit',async()=>{
  await reset();const operationId=op(),r=await execute(owner,'map.move',{mapId:source,cell:'0,0'},operationId);assert.equal(r.status,200,JSON.stringify(r.error));
  const preview=await h.request(owner,prefix+'/game/preview',{command:'map.move',params:{mapId:source,cell:'0,0'},clientId:op()});assert.equal(preview.status,200,JSON.stringify(preview.error));const direct='wd_'+require('../src/web/security').hash(owner.user.id+':'+operationId).slice(0,32);
  await h.app.games.store.transact(group,op(),h.user.id,s=>{
   const raw=C.clone(s.explorations[source].moves[r.data.result.id]);
   s.forms[direct].result.result=raw;
   const legacy=s.forms[preview.data.id];legacy.status='done';legacy.result={operationId:'web-action:'+owner.user.id+':'+legacy.id,status:'committed',result:C.clone(raw)};s.receipts[legacy.result.operationId]={at:Date.now(),result:C.clone(legacy.result)};
   return {oldRecord:true};
  });
  for(const response of [await h.request(owner,prefix+'/game/operations/'+operationId),await h.request(owner,prefix+'/game/receipt/'+direct),await h.request(owner,prefix+'/game?sections=history'),await h.request(owner,prefix+'/game/commit',{draftId:preview.data.id}),await execute(owner,'map.move',{mapId:source,cell:'0,0'},operationId)]){assert.equal(response.status,200,JSON.stringify(response.error));privateFieldsAbsent(response.data);}
  assert.ok(state().forms[direct].result.result.layout.includes('hidden-room-marker'));assert.ok(state().explorations[source].moves[r.data.result.id].layout.includes('hidden-room-marker'));
 });
 await t.test('stale direct and legacy map confirmations return safe summaries rather than raw hidden maps',async()=>{
  await reset();const versions=(await h.request(owner,prefix+'/game?sections=core,explore')).data.versions,preview=await h.request(owner,prefix+'/game/preview',{command:'map.move',params:{mapId:source,cell:'0,0'},clientId:op()});assert.equal(preview.status,200,JSON.stringify(preview.error));
  await h.app.games.store.transact(group,op(),h.user.id,s=>{s.explorations[source].version++;s.explorations[source].cells['2,0'].room.snapshot.description+='新秘密';return{updated:true};});const before=state();
  const direct=await h.request(owner,prefix+'/game/execute',{command:'map.move',params:{mapId:source,cell:'0,0'},versions,operationId:op()}),legacy=await h.request(owner,prefix+'/game/commit',{draftId:preview.data.id});
  for(const response of [direct,legacy]){assert.equal(response.status,409,JSON.stringify(response.error));privateFieldsAbsent(response.error);assert.ok(response.error.details.length);for(const detail of response.error.details)assert.deepEqual(Object.keys(detail.current||{}).sort(),['status','version']);}unchanged(before);
 });
}
test('linked exploration maps enforce every teammate current channel permission before changing state',async t=>{const h=await require('./helpers/chat-website.cjs').launch();try{await cases(t,h);}finally{await h.app.stop();}});
module.exports={cases};
