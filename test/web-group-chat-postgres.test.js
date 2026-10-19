'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg');
const S=require('../src/web/security'),GC=require('../src/web/group-chat');
test('group chat: isolated real PostgreSQL cleanup, crash recovery, concurrent messages and restore protection',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const suffix=crypto.randomBytes(6).toString('hex'),names={platform:'web_test_groupchat_'+suffix,content:'web_test_groupchat_content_'+suffix,game:'rpg_test_groupchat_'+suffix},restoreNames={platform:'web_test_restore_groupchat_'+suffix,content:'web_test_restore_groupchat_content_'+suffix,game:'rpg_test_restore_groupchat_'+suffix};
 const schemas=[...Object.values(names),...Object.values(restoreNames)],pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:20000}),crypt=S.codec(crypto.randomBytes(32).toString('base64')),repo=require('../src/web/repository').createRepository(pool,crypt,{schema:names.platform}),content=require('../src/web/repository').createRepository(pool,crypt,{schema:names.content});
 const B=require('../src/web/backup');let h;
 try{
  await repo.init();await content.init();await require('../src/rpg/postgres').createPostgres({pool,schema:names.game,...S.rpgCodec(crypto.randomBytes(32).toString('base64'))}).init();
  h=await require('./web-group-chat.test').fixture({repo});
  const before=await B.snapshot(pool,{names});
  await require('./web-group-chat.test').cases(t,h);
  await t.test('old backups cannot revive messages or chat receipt bodies; fresh backups recover cutoff and dice audit',async()=>{
   await assert.rejects(B.restore(pool,before,{names:restoreNames}),/聊天|消息|回执/);
   const fresh=await B.snapshot(pool,{names});assert.equal((await B.restore(pool,fresh,{names:restoreNames})).restored,true);
   const recovered=require('../src/web/repository').createRepository(pool,crypt,{schema:restoreNames.platform});assert.deepEqual(await recovered.list('chatDiceAudit',h.group.id),await repo.list('chatDiceAudit',h.group.id));assert.equal((await recovered.get('chatReset',GC.RESET_ID)).status,'completed');
   const oldRoom=h.rooms[0].id;assert.equal((await recovered.history(oldRoom)).length,0);assert.ok((await recovered.list('chatHistoryCutoff',h.group.id)).length>=5);
  });
  await t.test('20 concurrent messages and 50 repeated client IDs retain order and save only once',async()=>{
   const g=await repo.get('group',h.group.id);
   const many=await Promise.all(Array.from({length:20},(_,n)=>h.chat.send(h.player.id,g.publicRoomId,{clientId:'pg-many-'+String(n).padStart(8,'0'),text:'隔离并发消息 '+n})));
   assert.equal(new Set(many.map(m=>m.sequence)).size,20);
   const repeated=await Promise.all(Array.from({length:50},()=>h.chat.send(h.player.id,g.publicRoomId,{clientId:'pg-shared-duplicate',text:'同一条保存一次'})));
   assert.equal(new Set(repeated.map(m=>m.id)).size,1);
   const raw=(await pool.query('SELECT payload FROM "'+names.platform+'".messages WHERE id=$1',[repeated[0].id])).rows[0].payload;assert.ok(!raw.includes(Buffer.from('同一条保存一次')));
  });
  await t.test('a failed cleanup transaction rolls back chat and resumes the captured target without touching new groups',async()=>{
   const gc=GC.createGroupChat({repo,accounts:h.accounts,games:h.games,storage:h.storage}),id='group-chat-interruption-'+suffix;
   await gc.prepare({enabled:true,operationId:id});const captured=await repo.get('chatReset',id),cutoff=captured.groups[0].cutoffs;
   const original=repo.clearChatHistory;let once=true;repo.clearChatHistory=async(...args)=>{const result=await original(...args);if(once){once=false;throw new Error('isolated simulated disconnect before commit');}return result;};
   await assert.rejects(gc.resume(),/simulated disconnect/);assert.equal((await repo.get('chatReset',id)).status,'cleanup_error');assert.ok((await repo.history((await repo.get('group',h.group.id)).publicRoomId)).length);
   repo.clearChatHistory=original;const newer=await h.accounts.createGroup(h.admin,{name:'截点后新团'},crypto.randomUUID());
   const resumed=GC.createGroupChat({repo,accounts:h.accounts,games:h.games,storage:h.storage});await resumed.resume();assert.equal((await repo.get('chatReset',id)).status,'completed');assert.deepEqual((await repo.get('chatReset',id)).groups[0].cutoffs,cutoff);assert.equal((await repo.get('group',newer.id)).chatResetId,undefined);
  });
 }finally{for(const schema of schemas){assert.match(schema,/^(web|rpg)_test_(restore_)?groupchat_[a-z0-9_]+$/);await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}await pool.end();}
});
