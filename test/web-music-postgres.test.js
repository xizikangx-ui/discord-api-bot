'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg'),S=require('../src/web/security');
test('shared music: real PostgreSQL atomic quotas, recovery and duplicate controls',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const suffix=crypto.randomBytes(6).toString('hex'),schemas=['web_test_music_'+suffix,'web_test_music_content_'+suffix,'rpg_test_music_'+suffix,'web_test_restore_music_platform_'+suffix,'web_test_restore_music_content_'+suffix,'rpg_test_restore_music_'+suffix],pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:10000}),key=crypto.randomBytes(32).toString('base64'),crypt=S.codec(key),gameCrypt=S.rpgCodec(key),repo=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[0]}),content=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[1]}),db=require('../src/rpg/postgres').createPostgres({pool,schema:schemas[2],...gameCrypt});
 let h,app;
 try{
  await repo.init();await content.init();h=await require('./helpers/chat-website.cjs').launch({pool,repo,content,crypt,database:db,onApp:a=>app=a});await require('./web-music.test').cases(t,h);
  await t.test('20 and 50 simultaneous retries commit once and replay one authoritative result',async()=>{
   for(const count of [20,50]){
    const prefix='/groups/'+h.group.id+'/music',state=(await h.request(h.admin,prefix)).data.playback,p={operationId:crypto.randomUUID(),action:'stop',baseVersion:state.version},times=[];
    const results=await Promise.all(Array.from({length:count},async()=>{const start=performance.now(),r=await h.request(h.admin,prefix+'/control',p);times.push(performance.now()-start);return r;}));
    assert.ok(results.every(r=>r.status===200),JSON.stringify(results.filter(r=>r.status!==200)));assert.ok(results.every(r=>r.data.playback.version===state.version+1));assert.equal((await repo.get('musicState',h.group.id)).version,state.version+1);
    times.sort((a,b)=>a-b);console.log(JSON.stringify({type:'shared-music-duplicate-pg',requests:count,p95ms:Math.round(times[Math.ceil(count*.95)-1]),environment:'Railway private PostgreSQL, HTTP loopback, pool max 5'}));
   }
  });
  await t.test('fresh repositories decrypt shared music metadata and preserve its global scope in backup recovery',async()=>{
   const fresh=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[0]}),scope=require('../src/web/music').MUSIC_SCOPE;
   assert.deepEqual(await fresh.list('media',scope),await repo.list('media',scope));
   const rows=(await pool.query('SELECT payload FROM "'+schemas[0]+'".records WHERE kind=$1',['media'])).rows;assert.ok(rows.every(r=>!r.payload.includes(Buffer.from('共享战斗主题'))));
   const B=require('../src/web/backup'),CLI=require('../src/web/backup-cli'),record=await B.createBackups({pool,repo,crypt,storage:h.storage,names:{platform:schemas[0],content:schemas[1],game:schemas[2]}}).run(true),archive=await CLI.readArchive(h.storage,crypt,record);
   await B.restore(pool,archive,{names:{platform:schemas[3],content:schemas[4],game:schemas[5]}});const restored=require('../src/web/repository').createRepository(pool,crypt,{schema:schemas[3]});
   await CLI.restoreImages(h.storage,crypt,archive,restored,'recovery/shared_music/'+suffix+'/');const media=await restored.list('media',scope);assert.equal(media.length,(await repo.list('media',scope)).length);
   for(const f of media){const data=crypt.open('audio',f.id,h.storage.objects.get(f.key));assert.equal(S.hash(Buffer.from(data.data,'base64')),f.hash);}
  });
 }finally{await app?.stop();for(const schema of schemas){assert.match(schema,/^(web|rpg)_test_(music_[a-z0-9_]+|restore_music_[a-z0-9_]+)$/);await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}await db.close();}
});
