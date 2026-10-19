'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),S=require('../src/web/security');
const {WebSocket}=require('ws');
async function socket(h,actor){
 const ws=new WebSocket(h.origin.replace('http:','ws:')+'/ws',{headers:{Origin:h.origin,Cookie:'web_session='+actor.secret}}),events=[],waiters=[];
 ws.on('message',bytes=>{const event=JSON.parse(bytes);events.push(event);for(const item of [...waiters])if(item.match(event)){waiters.splice(waiters.indexOf(item),1);clearTimeout(item.timer);item.resolve(event);}});
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 return {ws,events,wait(match){const old=events.find(match);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{const item={match,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(item),1);reject(Error('No matching authorized realtime event'));},5000)};waiters.push(item);});},close(){for(const item of waiters)clearTimeout(item.timer);ws.terminate();}};
}
async function cases(t,h){
 const {app,repo,admin,player}=h,other=await app.accounts.createGroup(h.user,{name:'另一团 · 只读隔离'},crypto.randomUUID());
 const invitation=await app.accounts.invite(await app.accounts.member(other.id,h.user.id));await app.accounts.join(await app.accounts.user(player.user.id),invitation.code);
 const r1=h.group.chatRoomId,r2=other.chatRoomId,connection=await socket(h,player);
 try{
  await t.test('one account switches groups with serial acknowledgments and no identity recheck',async()=>{
   assert.equal((await h.request(player,'/rooms/'+encodeURIComponent(r1)+'/messages')).status,200);
   assert.equal((await h.request(player,'/rooms/'+encodeURIComponent(r1)+'/read',{sequence:0})).status,200);
   connection.ws.send(JSON.stringify({type:'subscribe',requestId:1,groupId:h.group.id,roomId:r1,watchGroups:[h.group.id,other.id]}));await connection.wait(e=>e.type==='subscribed'&&e.data.requestId===1);
   for(let n=2;n<=12;n++)connection.ws.send(JSON.stringify({type:'subscribe',requestId:n,groupId:n===12?other.id:h.group.id,roomId:n===12?r2:r1,watchGroups:[h.group.id,other.id]}));
   const ack=await connection.wait(e=>e.type==='subscribed'&&e.data.requestId===12);assert.equal(ack.data.groupId,other.id);assert.equal(connection.ws.readyState,WebSocket.OPEN);
   connection.ws.send(JSON.stringify({type:'subscribe',requestId:13,groupId:h.group.id,roomId:r1,watchGroups:[h.group.id,other.id]}));await connection.wait(e=>e.type==='subscribed'&&e.data.requestId===13);
  });
  await t.test('background groups send only an unread count, current group sends committed message bodies',async()=>{
   const secret='后台团正文不得进入当前订阅';await app.chat.send(h.user.id,r2,{clientId:crypto.randomUUID(),text:secret});
   const unread=await connection.wait(e=>e.type==='group-unread'&&e.data.groupId===other.id);assert.ok(unread.data.unread>0);assert.ok(!connection.events.some(e=>JSON.stringify(e).includes(secret)));
   const live='当前团实时正文';await app.chat.send(h.user.id,r1,{clientId:crypto.randomUUID(),text:live});await connection.wait(e=>e.type==='message'&&e.data.text===live);
   const groups=await h.request(player,'/groups');assert.equal(groups.status,200);assert.equal(groups.data.find(g=>g.id===other.id).chatRoomId,r2);assert.ok(groups.data.find(g=>g.id===other.id).unread>0);
   const read=await h.request(player,'/rooms/'+encodeURIComponent(r2)+'/read',{sequence:unread.data.sequence}),late=await h.request(player,'/rooms/'+encodeURIComponent(r2)+'/read',{sequence:0});
   assert.equal(read.data.unread,0);assert.equal(late.data.sequence,read.data.sequence);assert.ok(late.data.unreadVersion>read.data.unreadVersion);assert.equal(late.data.unread,0);
  });
  await t.test('GM inbox stays private and does not turn its body into player unread notifications',async()=>{
   const start=connection.events.length;await app.chat.send('system:web',h.group.gmRoomId,{clientId:crypto.randomUUID(),text:'仅GM可见的裁决',system:{kind:'webNotice'}},{system:true});
   const denied=await h.request(player,'/groups/'+h.group.id+'/inbox');assert.equal(denied.status,403);
   const gm=await h.request(admin,'/groups/'+h.group.id+'/inbox');assert.equal(gm.status,200);assert.equal(gm.data.items.at(-1).text,'仅GM可见的裁决');
   assert.ok(!JSON.stringify(connection.events.slice(start)).includes('仅GM可见的裁决'));
  });
  await t.test('revealed travel supplies celebrate only for the expedition and GM without a public chat leak',async()=>{
   const outsider=crypto.randomUUID(),secret=crypto.randomBytes(24).toString('hex');await repo.put('user',{id:outsider,name:'observer-'+outsider,displayName:'非远征成员',version:1});await repo.put('member',{id:h.group.id+':'+outsider,userId:outsider,groupId:h.group.id,active:true,role:'player',version:1},{scope:h.group.id});await repo.put('session',{id:S.hash(secret),userId:outsider,csrf:'isolated-csrf',expiresAt:Date.now()+60000},{scope:outsider});
   const denied=await socket(h,{secret}),gm=await socket(h,admin);
   try{
    for(const peer of [denied,gm]){peer.ws.send(JSON.stringify({type:'subscribe',requestId:1,groupId:h.group.id,roomId:r1}));await peer.wait(e=>e.type==='subscribed');}
    const title='旅行队私密金色补给',before=(await repo.get('room',r1)).sequence,journeyId='isolated-private-trip';
    await app.games.store.transact(h.group.id,'seed-private-trip',h.user.id,s=>{s.worldJourneys[journeyId]={id:journeyId,version:1,status:'travelling',owner:player.user.id,members:[player.user.id],characters:{[player.user.id]:s.players[player.user.id].id},nodes:[{id:'private-supply',journeyId,version:1,kind:'supply',title,stars:9,status:'pending',revealed:false,claims:{},items:[{id:'isolated-private-gold',quantity:1,snapshot:{id:'private-template',name:'仅远征队可见物资',kind:'药品',rarity:'gold',weight:0,value:0}}]}]};return{seeded:true};},'隔离受众测试',{delivery:false,lifecycle:false});
    await app.games.store.transact(h.group.id,'reveal-private-trip',h.user.id,s=>{s.worldJourneys[journeyId].nodes[0].revealed=true;s.worldJourneys[journeyId].nodes[0].version++;return{revealed:true};});await app.games.tick();
    const own=await connection.wait(e=>e.type==='rare-loot'&&e.data.rareLoot?.some(c=>c.title===title));await gm.wait(e=>e.type==='rare-loot'&&e.data.rareLoot?.some(c=>c.title===title));
    assert.equal(own.data.rareLoot[0].items[0].name,'仅远征队可见物资');assert.equal(own.data.recipientIds,undefined);assert.ok(!denied.events.some(e=>JSON.stringify(e).includes(title)));assert.equal((await repo.get('room',r1)).sequence,before);
   }finally{denied.close();gm.close();}
  });
  await t.test('removing a member revokes only that group; chat in another joined group and account login continue',async()=>{
   await app.accounts.setMember(await app.accounts.member(h.group.id,h.user.id),{userId:player.user.id,active:false,role:'player',version:(await repo.get('member',h.group.id+':'+player.user.id)).version});
   await connection.wait(e=>e.type==='subscription-error'&&e.data.groupId===h.group.id);
   assert.equal(connection.ws.readyState,WebSocket.OPEN);assert.equal((await h.request(player,'/auth/me')).status,200);assert.equal((await h.request(player,'/rooms/'+r1+'/messages')).status,403);
   connection.ws.send(JSON.stringify({type:'subscribe',requestId:14,groupId:other.id,roomId:r2,watchGroups:[other.id]}));await connection.wait(e=>e.type==='subscribed'&&e.data.requestId===14);
  });
  await t.test('20 and 50 distinct authorized senders commit concurrently, without loading game state per message',async()=>{
   for(const count of [20,50]){
    const actors=[];for(let n=0;n<count;n++){
     const id=crypto.randomUUID(),secret=crypto.randomBytes(24).toString('hex'),csrf=crypto.randomBytes(16).toString('hex');
     await repo.put('user',{id,name:'sender-'+id,displayName:'隔离并发成员',version:1});await repo.put('member',{id:other.id+':'+id,userId:id,groupId:other.id,active:true,role:'player',version:1},{scope:other.id});
     await repo.put('session',{id:S.hash(secret),userId:id,csrf,expiresAt:Date.now()+60000},{scope:id});actors.push({secret,csrf});
    }
    const times=[],rows=await Promise.all(actors.map(async(a,n)=>{const begin=performance.now(),result=await h.request(a,'/rooms/'+r2+'/messages',{clientId:crypto.randomUUID(),text:'并发群聊 '+n});times.push(performance.now()-begin);assert.equal(result.status,200,JSON.stringify(result.error));return result.data;}));
    assert.equal(new Set(rows.map(m=>m.id)).size,count);assert.equal(new Set(rows.map(m=>m.sequence)).size,count);times.sort((a,b)=>a-b);
    console.log(JSON.stringify({metric:'group-chat-http',requests:count,p95ms:Math.round(times[Math.ceil(count*.95)-1]),environment:repo.pool?'Railway private PG, loopback HTTP, pool max 5':'HTTP loopback, memory repository'}));
   }
  });
 }finally{connection.close();}
}
test('group chat HTTP and websocket contracts isolate navigation, unread, GM inbox and revoked access',async t=>{
 const h=await require('./helpers/chat-website.cjs').launch();try{await cases(t,h);}finally{await h.app.stop();}
});
test('group chat HTTP and websocket contracts on isolated real PostgreSQL',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),suffix=crypto.randomBytes(6).toString('hex'),schemas=['web_test_groupsync_'+suffix,'web_test_groupsync_content_'+suffix,'rpg_test_groupsync_'+suffix],pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:20000}),crypt=S.codec(crypto.randomBytes(32).toString('base64')),repo=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[0]}),content=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[1]}),db=require('../src/rpg/postgres').createPostgres({pool,schema:schemas[2],...S.rpgCodec(crypto.randomBytes(32).toString('base64'))});let h;
 try{await repo.init();await content.init();h=await require('./helpers/chat-website.cjs').launch({repo,content,pool,crypt,database:db});await cases(t,h);}
 finally{await h?.app.stop();for(const schema of schemas){assert.match(schema,/^(web|rpg)_test_groupsync_[a-z0-9_]+$/);await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}await db.close();}
});
