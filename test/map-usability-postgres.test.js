'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg');
const C=require('../src/rpg/constants'),F=require('../src/rpg/forms'),X=require('../src/rpg/exploration'),Team=require('../src/rpg/team-movement'),G=require('../src/rpg/gm-service'),{derive}=require('../src/web/games');
test('map usability: PostgreSQL entry, automatic start, notification and stair repair recover exactly once',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const schema='rpg_test_map_ux_'+crypto.randomBytes(6).toString('hex'),pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:10000}),codec=require('../src/web/security').rpgCodec(crypto.randomBytes(32).toString('base64')),db=require('../src/rpg/postgres').createPostgres({pool,schema,...codec});
 let store;
 try{
  await db.acquireLease('map-ux-isolation');const s=require('./helpers/rpg-harness').state();s.platform='web';
  const cf=F.create(s,'GM','mapcategory');Object.assign(cf.data,{name:'隔离地图主题',mapTypes:['indoor','region']});const cat=F.publish(s,cf),nf=F.create(s,'GM','npc');Object.assign(nf.data,{name:'隔离守卫',hpMax:20});const npc=F.publish(s,nf),rf=F.create(s,'GM','room');Object.assign(rf.data,{name:'隔离安全冻结房间',categoryIds:[cat.id],npcIds:[npc.id],autoStart:false});F.publish(s,rf);
  const m=X.create(s,'GM','entry','隔离进入地图',1,3,'random',cat.id);m.autoEncounters=true;m.cells['2,0'].variantId='v1';X.generate(s,m,min=>min);X.publish(s,m);X.join(s,m,'1');m.participants['1'].cell='1,0';
  const repair=X.create(s,'GM','repair','隔离楼梯修复',4,4,'random',cat.id);for(const c of Object.values(repair.cells))c.type='stairs';repair.cells['0,0'].type='entrance';repair.cells['3,0'].type='room';repair.cells['3,0'].room=X.instantiate(s,Object.values(s.roomTemplates)[0],min=>min);repair.cells['3,0'].touched=true;repair.generated=true;repair.status='paused';
  await db.save(s.guildId,null,s);store=require('../src/rpg/store').createStore({database:db,backgroundPublications:true,deriveDelivery:derive});await store.load(s.guildId);
  await t.test('20 then 50 concurrent retries commit one room entry and one encounter',async()=>{
   for(const count of [20,50]){
    const times=[],results=await Promise.all(Array.from({length:count},async()=>{const start=performance.now(),result=await store.transact(s.guildId,'entry-once','1',st=>Team.propose(st,st.explorations[m.id],'1','2,0'));times.push(performance.now()-start);return result;}));
    assert.ok(results.every(r=>r.id===results[0].id));const saved=store.snapshot(s.guildId),room=saved.explorations[m.id].cells['2,0'].room;assert.equal(saved.battles[room.battleId].status,'active');assert.equal(Object.keys(saved.battles).length,1);assert.equal(saved.explorations[m.id].participants['1'].cell,'2,0');
    assert.equal(Object.values(saved.deliveryJobs).filter(j=>j.kind==='webBattleStart').length,1);times.sort((a,b)=>a-b);console.log(JSON.stringify({type:'map-entry-duplicate-pg',requests:count,p95ms:Math.round(times[Math.ceil(count*.95)-1]),environment:'Railway private PostgreSQL, rule transaction, pool max 5'}));
   }
  });
  await t.test('restart reads saved layout, AP, receipt and pending announcement without a second start',async()=>{
   const before=store.snapshot(s.guildId),bid=before.explorations[m.id].cells['2,0'].room.battleId;await store.recover(s.guildId);const recovered=store.snapshot(s.guildId);assert.deepEqual(recovered.battles[bid],before.battles[bid]);assert.deepEqual(recovered.players,before.players);assert.deepEqual(recovered.deliveryJobs,before.deliveryJobs);
   const repeated=await store.transact(s.guildId,'entry-once','1',()=>{throw Error('saved receipt must bypass the executor');});assert.equal(repeated.id,before.receipts['entry-once'].result.id);assert.equal(store.snapshot(s.guildId).revision,before.revision);
  });
  await t.test('repair saves only new room results and repeats/reloads without changing frozen contents',async()=>{
   const before=store.snapshot(s.guildId),frozen=before.explorations[repair.id].cells['3,0'],result=await store.transact(s.guildId,'repair-once','GM',st=>G.apply(st,'GM','map.repairStairs',{mapId:repair.id}));assert.ok(result.count>0);const saved=store.snapshot(s.guildId);assert.deepEqual(saved.explorations[repair.id].cells['3,0'],frozen);assert.deepEqual(saved.players,before.players);assert.deepEqual(saved.battles,before.battles);
   await store.recover(s.guildId);assert.deepEqual(await store.transact(s.guildId,'repair-once','GM',()=>{throw Error('must not reroll repaired rooms');}),result);assert.deepEqual(store.snapshot(s.guildId).explorations[repair.id],saved.explorations[repair.id]);assert.doesNotThrow(()=>X.validateMap(saved.explorations[repair.id]));
   const bytes=(await pool.query('SELECT payload FROM "'+schema+'".objects WHERE collection=$1',['explorations'])).rows;assert.ok(bytes.every(r=>!r.payload.includes(Buffer.from('隔离安全冻结房间'))));
  });
 }finally{await store?.drain();assert.match(schema,/^rpg_test_map_ux_[a-f0-9]{12}$/);await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await db.close();}
});
