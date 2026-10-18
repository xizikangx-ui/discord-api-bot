'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg'),S=require('../src/web/security'),Backup=require('../src/web/backup');
test('exploration cleanup: isolated real PostgreSQL transactions and recovery',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const suffix=crypto.randomBytes(6).toString('hex'),names=['web_test_reset_'+suffix,'web_test_reset_content_'+suffix,'rpg_test_reset_'+suffix],restored=['web_test_restore_reset_'+suffix,'web_test_restore_reset_content_'+suffix,'rpg_test_restore_reset_'+suffix];
 const pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:10000}),key=crypto.randomBytes(32).toString('base64'),crypt=S.codec(key),gameCrypt=S.rpgCodec(key),repo=require('../src/web/repository').createRepository(pool,crypt,{schema:names[0]}),content=require('../src/web/repository').createRepository(pool,crypt,{schema:names[1]}),database=require('../src/rpg/postgres').createPostgres({pool,schema:names[2],...gameCrypt});
 let app,oldArchive;
 try{
  await repo.init();await content.init();
  const h=await require('./helpers/chat-website.cjs').launch({pool,repo,content,crypt,database,onApp:a=>app=a});
  const sourceNames={platform:names[0],content:names[1],game:names[2]},restoreNames={platform:restored[0],content:restored[1],game:restored[2]};
  const {id}=await require('./helpers/exploration-reset.cjs').cases(t,h,{beforeStart:async()=>{oldArchive=await Backup.snapshot(pool,{names:sourceNames});}});
  const saved=await database.load(h.group.id);
  assert.equal(saved.players['1'].balance,307);assert.equal(saved.mapTombstones.old.jobId,id);assert.equal(saved.battles.linked,undefined);assert.ok(saved.battles.independent);assert.ok(saved.explorations.futuremap);assert.equal((await repo.get('explorationReset',id)).status,'completed');
  await t.test('a pre-cleanup backup cannot resurrect a tombstoned map',async()=>{
   assert.ok(oldArchive.namespaces.game.objects.some(x=>x.collection==='explorations'&&x.object_id==='old'));
   await assert.rejects(Backup.restore(pool,oldArchive,{names:restoreNames}),/已清理的旧探索地图/);
   assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[restored[2]])).rowCount,0);
  });
  await t.test('an archive with only orphaned exploration battles cannot bypass cleanup markers',async()=>{
   const orphan=structuredClone(oldArchive);orphan.namespaces.game.objects=orphan.namespaces.game.objects.filter(x=>x.collection!=='explorations');
   assert.ok(orphan.namespaces.game.objects.some(x=>x.collection==='battles'&&x.object_id==='linked'));
   await assert.rejects(Backup.restore(pool,orphan,{names:restoreNames}),/已清理的探索战斗/);
  });
  await t.test('a fresh encrypted backup restores cleanup markers, assets and future maps',async()=>{
   const archive=await Backup.snapshot(pool,{names:sourceNames});
   await Backup.restore(pool,archive,{names:restoreNames});
   const recovered=require('../src/rpg/postgres').createPostgres({pool,schema:restored[2],...gameCrypt});
   assert.deepEqual(await recovered.load(h.group.id),await database.load(h.group.id));
   const restoredRepo=require('../src/web/repository').createRepository(pool,crypt,{schema:restored[0]});
   assert.equal((await restoredRepo.get('explorationReset',id)).status,'completed');
  });
  await t.test('a fresh web process resumes a persisted cleanup before accepting gameplay writes',async()=>{
   const operationId='restart-'+crypto.randomUUID();
   await repo.put('explorationReset',{id:operationId,actorId:h.user.id,reason:'隔离进程重启恢复',groupIds:[h.group.id],status:'running',startedAt:Date.now(),results:{}});
   app.games.setResetFence(h.group.id,'web-reset:'+operationId+':'+h.group.id);
   await app.stop();
   app=require('../src/web/server').createWeb({pool,repository:require('../src/web/repository').createRepository(pool,crypt,{schema:names[0]}),contentRepository:require('../src/web/repository').createRepository(pool,crypt,{schema:names[1]}),database,storage:h.storage,crypt,gameCrypt,bootstrapHash:S.hash('closed-isolated-bootstrap'),allowHttp:true,renderer:{queue:()=>Promise.reject(Error('isolated renderer blocked')),close(){}}});
   await app.start(0);
   const recovered=await database.load(h.group.id);
   assert.equal((await repo.get('explorationReset',operationId)).status,'completed');
   assert.equal(recovered.explorations.futuremap,undefined);assert.ok(recovered.mapTombstones.futuremap);assert.equal(recovered.players['1'].balance,307);assert.ok(recovered.battles.independent);
   await app.games.store.transact(h.group.id,'write-after-restart-cleanup',h.user.id,()=>({ok:true}),'isolated write',{delivery:false,lifecycle:false});
  });
 }finally{
  await app?.stop();
  for(const name of [...names,...restored]){assert.match(name,/^(web|rpg)_test_(reset|restore_reset)[a-z0-9_]+$/);await pool.query('DROP SCHEMA IF EXISTS "'+name+'" CASCADE');}
  await database.close();
 }
});
