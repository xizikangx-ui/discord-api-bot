'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../src/rpg/constants'),S=require('../src/web/security'),GC=require('../src/web/group-chat');
async function fixture({repo=require('./helpers/web-demo.cjs').memoryRepository(),storage=require('./helpers/chat-website.cjs').objectStorage()}={}){
 const accounts=require('../src/web/accounts').createAccounts(repo),admin={id:'group-admin',name:'gm',displayName:'GM',admin:true,version:1},player={id:'group-player',name:'player',displayName:'玩家',version:1};
 await repo.put('user',admin);await repo.put('user',player);
 const group={id:'legacy-group',name:'旧营地',owner:admin.id,version:1};await repo.put('group',group);
 for(const user of [admin,player])await repo.put('member',{id:group.id+':'+user.id,userId:user.id,groupId:group.id,role:user.admin?'gm':'player',active:true,version:1},{scope:group.id});
 const rooms=[{id:'old-room-chat',kind:'chat'},{id:'old-room-rp',kind:'rp'},{id:'old-room-system',kind:'system'},{id:'old-room-gm',kind:'gm'},{id:'dm:legacy-pair',kind:'dm',participants:[admin.id,player.id]}].map(r=>({...r,groupId:group.id,name:r.kind,sequence:0,version:1}));
 for(const room of rooms)await repo.put('room',room,{scope:group.id});
 const broadcasts=[],chat=require('../src/web/chat').createChat(repo,accounts,{broadcast:(room,event)=>broadcasts.push({room,event})});
 await chat.send(player.id,rooms[0].id,{clientId:'old-chat-message',text:'应被清理的公开正文'});
 await chat.send(admin.id,rooms[3].id,{clientId:'old-secret-message',text:'应被清理的GM秘密'});
 await chat.send(player.id,rooms[4].id,{clientId:'old-direct-message',text:'应被清理的私聊正文'});
 const dice=await chat.send(player.id,rooms[0].id,{clientId:'old-dice-message',kind:'dice',expression:'1d6',text:''});
 await chat.upsertSystem(rooms[2].id,'web:fixture-old',8,{text:'历史结算正文',system:{battleId:'old-battle'}});
 const state=C.newState(group.id);state.platform='web';state.revision=12;state.config.announcementChannelId=rooms[2].id;
 state.players.player={id:'hero',hp:7,ap:123,inventory:{item:{snapshot:{name:'珍藏'}}},avatar:{webMediaId:'shared-image'}};
 state.battles.old={id:'old-battle',name:'旧战斗',channelId:rooms[2].id,status:'ended',actors:[],publicEvents:[{id:'saved',rolls:[6]}]};
 state.deaths.dead={id:'dead',rewarded:{money:31}};state.deliveryJobs={old:{key:'old',kind:'webEvent',status:'pending',text:'旧任务不再发布'}};
 const fences=new Map(),games={ensure:async()=>{},waitForPublications:async()=>{},setResetFence:(id,v)=>v?fences.set(id,v):fences.delete(id),store:{select:(id,fn)=>C.clone(fn(state)),async transact(id,op,actor,fn){if(state.receipts[op])return C.clone(state.receipts[op].result);const result=await fn(state);state.receipts[op]={at:Date.now(),result:C.clone(result)};state.revision++;return C.clone(result);}}};
 const reset=GC.createGroupChat({repo,accounts,games,storage,broadcast:(group,event)=>broadcasts.push({group,event})});
 return{repo,accounts,admin,player,group,rooms,chat,dice,state,games,fences,broadcasts,storage,reset};
}
async function cases(t,h){const {repo,group,rooms,chat,admin,player,state}=h;
 await t.test('an explicit gate fixes the original target and blocks writes while keeping game assets',async()=>{
  assert.equal(await h.reset.prepare(),null);assert.equal((await chat.history(player.id,rooms[0].id,{after:0,before:999})).length,2);
  const before=C.clone({players:state.players,deaths:state.deaths,rolls:state.battles.old.publicEvents});h.protectedBefore=before;
  const j=await h.reset.prepare({enabled:true});assert.equal(j.groups.length,1);assert.equal(h.fences.size,1);
  await assert.rejects(chat.send(player.id,rooms[0].id,{clientId:'during-cleanup',text:'不应该写入'}),/正在整理/);
  const cut=await repo.get('chatReset',GC.RESET_ID);assert.equal(cut.groups[0].cutoffs.length,5);
 });
 await t.test('all old public, GM and private messages are erased; dice and protected rules data remain',async()=>{
  for(const id of ['unused-image','shared-image']){await repo.put('media',{id,groupId:group.id,owner:player.id,roomId:rooms[0].id,kind:'chat',status:'ready',key:'media/'+id,at:1},{scope:group.id});h.storage.objects.set('media/'+id,Buffer.from(id));}
  await repo.put('media',{id:'portrait-image',groupId:group.id,owner:admin.id,kind:'portrait',key:'portrait',status:'ready'},{scope:group.id});
  await repo.put('media',{id:'music-image',groupId:group.id,owner:admin.id,kind:'music',key:'music',status:'ready'},{scope:group.id});
  await h.reset.resume();const g=await repo.get('group',group.id);
  assert.equal(g.groupChatVersion,1);assert.equal(g.chatRoomId,g.publicRoomId);assert.equal(g.chatResetActive,undefined);
  for(const r of rooms)assert.deepEqual(await repo.history(r.id),[]);
  assert.equal((await repo.list('chatDiceAudit',group.id))[0].id,h.dice.id);assert.deepEqual((await repo.list('chatDiceAudit',group.id))[0].dice,h.dice.dice);
  for(const receipt of await repo.list('receipt'))if(['chat:','card:'].some(p=>receipt.id.startsWith(p)))assert.ok(!JSON.stringify(receipt).includes('正文'));
  assert.deepEqual(state.players,h.protectedBefore.players);assert.deepEqual(state.deaths,h.protectedBefore.deaths);assert.deepEqual(state.battles.old.publicEvents,h.protectedBefore.rolls);
  assert.equal(state.battles.old.channelId,g.publicRoomId);assert.equal(state.deliveryJobs.old.status,'done');assert.equal(h.fences.size,0);
  assert.equal(await repo.get('media','unused-image'),null);assert.ok(!h.storage.objects.has('media/unused-image'));
  assert.ok(await repo.get('media','shared-image'));assert.ok(await repo.get('media','portrait-image'));assert.ok(await repo.get('media','music-image'));
 });
 await t.test('the group has one visible public chat, a GM workbench and participant-only private rooms',async()=>{
  const visible=await chat.rooms(group.id,player.id);assert.equal(visible.filter(r=>r.kind!=='dm').length,1);assert.ok(visible.every(r=>r.kind!=='gm'));
  const g=await repo.get('group',group.id);await assert.rejects(chat.access(player.id,g.gmRoomId),/GM权限/);
  const gm=await h.accounts.member(group.id,admin.id);assert.equal((await chat.rooms(group.id,admin.id,undefined,gm,{includeWorkbench:true})).filter(r=>r.kind==='gm').length,1);
  await assert.rejects(chat.create(gm,{name:'又一频道',kind:'chat'}),/每团使用一个群聊/);
  await assert.rejects(chat.access('outside-user',visible[0].id));
 });
 await t.test('cleared clients, card receipts and old jobs cannot republish; new messages and revision updates work',async()=>{
  const g=await repo.get('group',group.id);await assert.rejects(chat.send(player.id,g.publicRoomId,{clientId:'old-chat-message',text:'应被清理的公开正文'}),/历史已清理/);
  const first=await chat.send(player.id,g.publicRoomId,{clientId:'fresh-message',text:'新消息保留'});assert.equal(first.sequence,1);
  const count=h.broadcasts.length,old=await chat.upsertSystem(rooms[2].id,'web:fixture-old',8,{text:'不得复活'});assert.equal(old.cleared,true);assert.equal(h.broadcasts.length,count);
  const fresh=await chat.upsertSystem(g.publicRoomId,'web:fresh',state.revision+10,{text:'新的真实结算'});assert.equal(fresh.text,'新的真实结算');
  await h.reset.prepare({enabled:true});await h.reset.resume();assert.equal((await repo.history(g.publicRoomId)).length,2);
 });
}
test('group chat migration is fenced, recoverable, private and preserves game audit',async t=>{const h=await fixture();await cases(t,h);});
test('new groups are born with exactly one public chat and one hidden GM workbench',async()=>{const repo=require('./helpers/web-demo.cjs').memoryRepository(),accounts=require('../src/web/accounts').createAccounts(repo),u={id:'new-admin',admin:true};await repo.put('user',u);const g=await accounts.createGroup(u,{name:'新营地'},crypto.randomUUID()),rooms=await repo.list('room',g.id);assert.equal(rooms.length,2);assert.ok(rooms.some(r=>r.groupChat&&r.id===g.chatRoomId));assert.ok(rooms.some(r=>r.workbenchOnly&&r.id===g.gmRoomId));});
test('fixed cutoffs never remove newer messages and interrupted cleanup resumes the same target',async()=>{const h=await fixture();await h.reset.prepare({enabled:true});const target=await h.repo.get('chatReset',GC.RESET_ID),room=await h.repo.get('room',h.rooms[4].id);const newer={id:'newer-than-cutoff',roomId:room.id,authorId:h.player.id,clientId:'post-cutoff-message',sequence:++room.sequence,text:'新消息',kind:'text'};await h.repo.message(room.id,newer);await h.repo.put('room',room,{scope:h.group.id});const restored=GC.createGroupChat({repo:h.repo,accounts:h.accounts,games:h.games,storage:h.storage});await restored.resume();assert.deepEqual((await h.repo.history(room.id)).map(m=>m.id),[newer.id]);assert.deepEqual((await h.repo.get('chatReset',GC.RESET_ID)).groups,target.groups);});
test('restricted legacy scenes and their rebuilt notices never become public, while historical snapshots stay frozen',async()=>{
 const h=await fixture(),privateRoom={id:'legacy-restricted-room',groupId:h.group.id,kind:'chat',name:'小队秘密',members:[h.admin.id],sequence:0,version:1};await h.repo.put('room',privateRoom,{scope:h.group.id});
 h.state.battles.private={id:'private-battle',name:'秘密战斗',channelId:privateRoom.id,status:'active',current:{id:'private-turn',actorId:'private-actor'},actors:[{id:'private-actor',name:'秘密角色',userId:h.player.id}],publicEvents:[{id:'frozen',snapshot:{channelId:privateRoom.id,rolls:[6]}}]};
 await h.reset.prepare({enabled:true});await h.reset.resume();const g=await h.repo.get('group',h.group.id),b=h.state.battles.private;
 assert.equal(b.channelId,g.gmRoomId);assert.equal(h.state.deliveryJobs['web:turn:private-battle:private-turn'].roomId,g.gmRoomId);assert.equal((await h.repo.get('room',privateRoom.id)).supersededBy,g.gmRoomId);assert.equal(b.publicEvents[0].snapshot.channelId,privateRoom.id);assert.deepEqual(b.publicEvents[0].snapshot.rolls,[6]);
});
test('failed attachment deletion remains durable and a resumed cleanup retries it without erasing avatars',async()=>{
 const h=await fixture();await h.repo.put('media',{id:'retry-chat-file',groupId:h.group.id,owner:h.player.id,kind:'chat',roomId:h.rooms[0].id,key:'media/retry',at:1},{scope:h.group.id});h.storage.objects.set('media/retry',Buffer.from('encrypted test image'));
 const send=h.storage.client.send;let fail=true;h.storage.client.send=async command=>{if(command instanceof h.storage.commands.DeleteObjectCommand&&fail)throw Error('isolated storage unavailable');return send(command);};
 await h.reset.prepare({enabled:true});await h.reset.resume();assert.equal((await h.repo.list('mediaCleanup')).length,1);assert.equal(await h.repo.get('media','retry-chat-file'),null);fail=false;await h.reset.resume();assert.equal((await h.repo.list('mediaCleanup')).length,0);assert.ok(!h.storage.objects.has('media/retry'));
});
module.exports={fixture,cases};
