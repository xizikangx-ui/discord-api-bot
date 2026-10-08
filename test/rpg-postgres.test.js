'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../src/rpg/constants'),M=require('../src/rpg/model'),B=require('../src/rpg/combat'),F=require('../src/rpg/forms');
const {createPostgres,digest}=require('../src/rpg/postgres'),{createStore}=require('../src/rpg/store');
const {harness,state,weapon,minRng}=require('./helpers/rpg-harness');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const npc=(s,extra={})=>{const t=B.validateNPC(s,{...F.defaults('npc'),name:'隔离测试NPC',humanoid:true,baseXP:1000,hpMax:1,...extra});t.id=C.id('t');t.version=1;t.published=true;s.npcTemplates[t.id]=t;return t;};
test('PostgreSQL isolated integration, concurrency, disconnect and recovery', {skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const schema='rpg_test_'+crypto.randomBytes(8).toString('hex'),h=harness();let lost=false;
 const db=createPostgres({connectionString:process.env.RPG_TEST_DATABASE_URL,schema,encrypt:h.deps.encrypt,decrypt:h.deps.decrypt,onLeaseLost:()=>{lost=true;}});
 let second,restored;
 try{
  await db.acquireLease('integration');
  const seed=state();require('../src/rpg/activities').migrate(seed);require('../src/rpg/skills').migrate(seed);require('../src/rpg/content-pack').install(seed);seed.config.gmRoleIds=['gm'];seed.config.playerRoleIds=['player'];
  await db.importState(seed.guildId,seed,'isolated-archive');h.deps.database=db;const st=createStore(h.deps);await st.load(seed.guildId);
  await t.test('import verifies every object and refuses overwrite or repeated content/coin migrations',async()=>{
   assert.equal(digest(await db.load(seed.guildId)),digest(seed));await assert.rejects(db.importState(seed.guildId,seed,'old-archive'));
   assert.equal(st.select(seed.guildId,s=>s.contentPackVersion),1);const imports=await db.pool.query(`SELECT revision,digest FROM "${schema}".imports`);assert.equal(imports.rows.length,1);assert.equal(imports.rows[0].digest,digest(seed));
  });
  await t.test('exclusive writer lease blocks a second instance',async()=>{second=createPostgres({connectionString:process.env.RPG_TEST_DATABASE_URL,schema,encrypt:h.deps.encrypt,decrypt:h.deps.decrypt});await assert.rejects(second.acquireLease('integration'),/另一个/);await second.close();second=null;});
  await t.test('only changed objects are rewritten, receipts/audit/outbox commit together and payloads are encrypted',async()=>{
   const query=`SELECT collection,object_id,payload FROM "${schema}".objects WHERE guild_id=$1`,before=(await db.pool.query(query,[seed.guildId])).rows;
   await st.transact(seed.guildId,'encrypted-credit','1',s=>{s.players['1'].balance=100;s.players['1'].name='DO_NOT_LOG_PRIVATE_DATA';return 100;});
   const after=(await db.pool.query(query,[seed.guildId])).rows,changed=after.filter(r=>!before.find(o=>o.collection===r.collection&&o.object_id===r.object_id&&o.payload.equals(r.payload)));
   assert.deepEqual(changed.map(r=>r.collection+':'+r.object_id),['players:1']);assert.ok(after.every(r=>!r.payload.toString().includes('DO_NOT_LOG_PRIVATE_DATA')));
   const loaded=await db.load(seed.guildId);assert.equal(loaded.receipts['encrypted-credit'].result,100);assert.ok(loaded.events.some(e=>e.id==='encrypted-credit'));
   const bid=await st.transact(seed.guildId,'atomic-battle','GM',s=>B.createBattle(s,'channel','GM','isolated').id);const checked=await db.load(seed.guildId);assert.equal(checked.deliveryJobs['battle:'+bid].status,'pending');assert.equal(checked.receipts['atomic-battle'].result,bid);
  });
  await t.test('20 concurrent confirmations debit and transfer once, stale quotes stay invalid',async()=>{
   const ref=await st.transact(seed.guildId,'trade-seed','GM',s=>{s.players['1'].balance=100;s.players['2'].balance=20;const item=M.issue(s,'1',Object.values(s.catalog).find(t=>t.kind==='杂物').id,3)[0],o=M.createOffer(s,'1','2');M.updateOffer(s,o.id,'1',[{id:item.id,quantity:2}],50);M.updateOffer(s,o.id,'2',[],15);return{id:o.id,version:o.revision,item:item.id};});
   await Promise.all(Array.from({length:20},(_,n)=>{const uid=n%2?'2':'1';return st.transact(seed.guildId,'confirmation-'+uid,uid,s=>M.confirmOffer(s,ref.id,uid,ref.version));}));
   const result=await db.load(seed.guildId);assert.equal(result.players['1'].balance,65);assert.equal(result.players['2'].balance,55);assert.equal(result.players['1'].inventory[ref.item].quantity,1);assert.equal(result.offers[ref.id].status,'completed');
   await assert.rejects(st.transact(seed.guildId,'stale-confirmation','2',s=>M.confirmOffer(s,ref.id,'2',ref.version)));
  });
  await t.test('simultaneous AOE defenses settle each target and death reward once, competing corpse claims transfer once',async()=>{
   const refs=await st.transact(seed.guildId,'area-seed','GM',s=>{const old=Object.values(s.battles).filter(b=>b.status!=='ended');for(const b of old)B.endBattle(s,b);const b=B.createBattle(s,'battle','GM','AOE'),a=B.join(s,b,'1');B.join(s,b,'2');const w=weapon(s,{weightKg:0}),template=npc(s,{itemIds:[w.id]}),n=B.addNPC(s,b,template.id,'enemy'),m=B.addNPC(s,b,template.id,'enemy');m.character.attributes.agility=2;B.position(b,n.id,50,25);B.position(b,m.id,75,25);const skill=require('../src/rpg/skills').publish(s,{...F.defaults('skill'),name:'隔离测试范围能力',damage:{physical:'100'},aoe:{mode:'selective',radius:50}}),learned=require('../src/rpg/skills').grant(s.players['1'],skill);B.start(s,b,null,minRng);const area=require('../src/rpg/aoe').preview(s,b,a,skill,{x:50,y:25});B.attack(s,b,b.current.id,learned.id,n.id,'formal',minRng,{aoe:area});return{bid:b.id,hits:require('../src/rpg/aoe').hits(b).map(h=>h.id),npc:n.id};});
   await Promise.all(Array.from({length:20},(_,n)=>{const hit=refs.hits[n%refs.hits.length];return st.transact(seed.guildId,'defense-'+hit,'GM',s=>B.defend(s,s.battles[refs.bid],hit,'none',minRng));}));
   let result=await db.load(seed.guildId);assert.equal(result.battles[refs.bid].pending,null);assert.equal(Object.keys(result.deaths).length,2);assert.ok(Object.values(result.deaths).every(d=>d.rewarded?.userId==='1'));assert.equal(result.events.filter(e=>e.id.startsWith('defense-')).length,2);
   const corpse=Object.values(result.corpses)[0];await st.transact(seed.guildId,'area-end','GM',s=>B.endBattle(s,s.battles[refs.bid]));const claims=await Promise.allSettled(Array.from({length:20},(_,n)=>{const uid=n%2?'2':'1';return st.transact(seed.guildId,'claim-'+n,uid,s=>require('../src/rpg/mortality').claim(s,corpse.id,uid,corpse.items[0].id));}));
   assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);result=await db.load(seed.guildId);assert.equal(Object.keys(result.corpses[corpse.id].claims).length,1);
  });
  await t.test('disconnect before and after COMMIT reconciles receipt or freezes without reroll',async()=>{
   const originalConnect=db.pool.connect.bind(db.pool);let fault;
   db.pool.connect=async(...args)=>{const client=await originalConnect(...args),query=client.query.bind(client);client.query=async(sql,...params)=>{if(sql==='COMMIT'&&fault){const mode=fault;fault=null;if(mode==='after')await query(sql,...params);throw Error('simulated disconnect');}return query(sql,...params);};const release=client.release.bind(client);client.release=(...args)=>{client.query=query;return release(...args);};return client;};
   try{fault='after';let rolls=0;const saved=await st.transact(seed.guildId,'after-commit','1',s=>{rolls++;s.players['1'].balance++;return 77;});assert.equal(saved,77);assert.equal(rolls,1);assert.equal(st.frozen(seed.guildId),false);
    fault='before';await assert.rejects(st.transact(seed.guildId,'before-commit','1',s=>{s.players['1'].balance++;}),/暂停/);assert.equal(st.frozen(seed.guildId),true);await st.recover(seed.guildId);assert.ok(!st.select(seed.guildId,s=>s.receipts['before-commit']));
   }finally{db.pool.connect=originalConnect;}
  });
  await t.test('20 simultaneous text actions and 50 burst writes on private PostgreSQL',async()=>{
   const samples={},metrics={observe:(k,v)=>(samples[k]||=[]).push(v),start:k=>{const at=performance.now();return()=>metrics.observe(k,performance.now()-at);},gauge(){},close(){}};
   h.deps.metrics=metrics;h.deps.renderer={decorate:async(_,v)=>{delete v.rpgMap;delete v.rpgPortraits;return v;},close(){}};const rpg=require('../src/rpg').createRpg(h.deps);await rpg.start();
   try{await Promise.all(Array.from({length:20},()=>rpg.handle(h.interaction('1','rd',{'骰式':'1d20'}))));const p95=k=>[...samples[k]].sort((a,b)=>a-b)[Math.floor((samples[k].length-1)*.95)];assert.ok(p95('interaction.ack')<1000);assert.ok(p95('interaction.result')<3000);
    const before=rpg.store.select(seed.guildId,s=>s.players['1'].balance);await Promise.all(Array.from({length:50},(_,n)=>rpg.store.transact(seed.guildId,'pg-burst-'+n,'1',s=>{s.players['1'].balance++;})));assert.equal((await db.load(seed.guildId)).players['1'].balance,before+50);console.log(JSON.stringify({test:'private-postgres-mocked-discord',clicks:20,ackP95Ms:Math.round(p95('interaction.ack')),resultP95Ms:Math.round(p95('interaction.result')),burstWrites:50}));
   }finally{rpg.stop();await rpg.drain();}
  });
  await t.test('paid round and random encounter persist once across duplicate clicks, reload and subsequent batches',async()=>{
   await st.recover(seed.guildId);const X=require('../src/rpg/exploration');let draws=0;
   const refs=await st.transact(seed.guildId,'round-layout-seed','GM',s=>{
    for(const b of Object.values(s.battles))if(b.status!=='ended')B.endBattle(s,b);
    // The earlier death tests leave both player characters alive.
    const cf=F.create(s,'GM','mapcategory');cf.data.name='隔离布局类别';const cat=F.publish(s,cf);
    const template=npc(s,{hpMax:100});const rf=F.create(s,'GM','room');Object.assign(rf.data,{name:'隔离办公室',categoryIds:[cat.id],npcIds:[template.id]});F.publish(s,rf);
    const m=X.create(s,'GM','pg-layout','隔离地图',1,3,'random',cat.id);X.generate(s,m,minRng);X.publish(s,m);X.join(s,m,'1');m.participants['1'].cell='2,0';m.revealed['2,0']=true;m.cells['2,0'].room.remainingNpcs[0].quantity=22;
    const b=B.createBattle(s,'pg-round','GM','隔离行动轮');B.join(s,b,'2');B.start(s,b,null,minRng);return{map:m.id,round:b.id};
   });
   const encounters=await Promise.all(Array.from({length:20},()=>st.transact(seed.guildId,'one-random-encounter','GM',s=>X.encounter(s,s.explorations[refs.map],'2,0',['1'],(lo)=>{draws++;return lo;}).id)));
   assert.equal(new Set(encounters).size,1);const count=draws,original=await db.load(seed.guildId),before=original.battles[refs.round].current;
   assert.equal(original.battles[encounters[0]].actors.length,20);assert.equal(before.apCost,100);
   const loaded=createStore(h.deps);await loaded.load(seed.guildId);assert.deepEqual(loaded.select(seed.guildId,s=>s.battles[refs.round]),original.battles[refs.round]);
   await Promise.all(Array.from({length:20},()=>loaded.transact(seed.guildId,'one-finish','2',s=>{B.finish(s,s.battles[refs.round],before.id,minRng);return s.battles[refs.round].current.id;})));
   const finished=await db.load(seed.guildId);assert.equal(finished.battles[refs.round].actionRound.number,2);assert.equal(finished.battles[refs.round].current.apCost,100);
   const again=createStore(h.deps);await again.load(seed.guildId);await again.transact(seed.guildId,'one-random-encounter','GM',()=>{throw Error('must not reroll');});assert.equal(draws,count);
   await again.transact(seed.guildId,'next-room-batch','GM',s=>{const m=s.explorations[refs.map];B.endBattle(s,s.battles[encounters[0]]);X.resolve(s,m,'2,0');X.encounter(s,m,'2,0',['1'],minRng);});
   const final=await db.load(seed.guildId);assert.deepEqual(final.explorations[refs.map].cells['2,0'].room.tacticalLayout,original.explorations[refs.map].cells['2,0'].room.tacticalLayout);
   assert.deepEqual(final.battles[refs.round],finished.battles[refs.round]);
   // Keep the outer store synchronized for the remaining recovery checks.
   await st.recover(seed.guildId);
  });
  await t.test('RP drafts, events and image jobs recover through commit ambiguity without reroll',async()=>{
   const Draft=require('../src/rpg/action-drafts');
   const ref=await st.transact(seed.guildId,'rp-draft-seed','1',s=>{for(const b of Object.values(s.battles))if(b.status!=='ended')B.endBattle(s,b);const b=B.createBattle(s,'rp-isolation','GM','RP恢复');B.join(s,b,'1');B.join(s,b,'2');const w=weapon(s,{weightKg:0,damage:{physical:'2d6'}}),item=M.issue(s,'1',w.id)[0];M.equip(s,'1',item.id);B.start(s,b,null,minRng);return Draft.create(s,'1',{battleId:b.id,actorId:b.current.actorId,turnId:b.current.id,action:'attack',params:{abilityKey:item.id,targetId:b.actors[1].id,action:'formal'}}).id;});
   const reload=createStore(h.deps);await reload.load(seed.guildId);assert.equal(reload.select(seed.guildId,s=>s.forms[ref].status),'ready');
   const originalConnect=db.pool.connect.bind(db.pool);let disconnected=false,rolls=0;
   db.pool.connect=async(...args)=>{const c=await originalConnect(...args),query=c.query.bind(c),release=c.release.bind(c);c.query=async(sql,...params)=>{const result=await query(sql,...params);if(sql==='COMMIT'&&!disconnected){disconnected=true;throw Error('isolated post-commit disconnect');}return result;};c.release=(...args)=>{c.query=query;c.release=release;return release(...args);};return c;};
   try{await reload.transact(seed.guildId,'action:'+ref,'1',s=>Draft.execute(s,ref,'1','加密保存的角色叙述',(lo,hi)=>{rolls++;return hi-1;}));}finally{db.pool.connect=originalConnect;}
   const calls=rolls,next=createStore(h.deps);await next.load(seed.guildId);await next.transact(seed.guildId,'action:'+ref,'1',()=>{throw Error('must not execute again');});
   const saved=await db.load(seed.guildId),f=saved.forms[ref],b=saved.battles[f.battleId];assert.equal(rolls,calls);assert.ok(calls>0);assert.equal(f.status,'done');assert.equal(b.current.formal,0);assert.equal(b.publicEvents.find(e=>e.type==='attack').rpEntries[0].text,'加密保存的角色叙述');
   const events=require('../src/rpg/battle-events').createEvents({snapshot:next.snapshot,store:next,client:h.deps.client,textChannel:async()=>h.ch,render:async(_,v)=>{delete v.rpgMap;return v;},logFailure:()=>{}});await events.publish(seed.guildId,b.id);
   const delivered=await db.load(seed.guildId),e=delivered.battles[b.id].publicEvents.find(e=>e.type==='attack'),job='eventImage:'+b.id+'/player/'+e.id;assert.equal(e.publication.status,'sent');assert.equal(delivered.deliveryJobs[job].status,'pending');
   await next.transact(seed.guildId,'rp-image-running','BOT',s=>{s.deliveryJobs[job].status='running';},'隔离任务状态',{delivery:false});const recovered=createStore(h.deps);await recovered.load(seed.guildId);assert.ok(['pending','running'].includes(recovered.select(seed.guildId,s=>s.deliveryJobs[job].status)));assert.equal(recovered.select(seed.guildId,s=>s.forms[ref].status),'done');await st.recover(seed.guildId);
  });
  await t.test('20 real RP action commits and 50 duplicate burst requests complete while animation is blocked',async()=>{
   await st.recover(seed.guildId);const Draft=require('../src/rpg/action-drafts'),refs=await st.transact(seed.guildId,'rp-load-seed','GM',s=>{
    for(const b of Object.values(s.battles))if(b.status!=='ended')B.endBattle(s,b);
    return Array.from({length:20},(_,n)=>{const uid='rp-load-'+n,p=M.newCharacter('负载角色',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5},1);p.userId=uid;s.players[uid]=p;h.members[uid]={...h.members['1'],id:uid,user:{id:uid,username:'隔离玩家'}};const b=B.createBattle(s,'rp-load-'+n,'GM','隔离负载');B.join(s,b,uid);B.start(s,b,null,minRng);const f=Draft.create(s,uid,{battleId:b.id,actorId:b.current.actorId,turnId:b.current.id,action:'move',params:{x:26,y:25}});return{uid,id:f.id,bid:b.id};});});
   const samples={},metrics={observe:(k,v)=>(samples[k]||=[]).push(v),start:k=>{const at=performance.now();return()=>metrics.observe(k,performance.now()-at);},gauge(){},close(){}};let release;const blocked=new Promise(r=>{release=r;});h.deps.metrics=metrics;h.deps.renderer={decorate:async(_,v)=>{await blocked;delete v.rpgMap;return v;},close(){}};const rpg=require('../src/rpg').createRpg(h.deps);await rpg.start();
   const p95=k=>{const a=[...samples[k]].sort((a,b)=>a-b);return a[Math.ceil(a.length*.95)-1];};
   try{await Promise.all(refs.map(({uid,id})=>rpg.handle(h.interaction(uid,null,{},'rpg:act:submit:'+id,[],{rp:'并发行动测试'}))));assert.ok(p95('interaction.ack')<1000);assert.ok(p95('interaction.result')<3000);const firstAck=p95('interaction.ack'),firstResult=p95('interaction.result');
    await Promise.all(Array.from({length:50},(_,n)=>{const f=refs[n%20];return rpg.handle(h.interaction(f.uid,null,{},'rpg:act:do:'+f.id));}));
    const saved=await db.load(seed.guildId);for(const f of refs){assert.equal(saved.forms[f.id].status,'done');assert.equal(saved.battles[f.bid].actors[0].x,26);assert.equal(saved.battles[f.bid].publicEvents[0].rpEntries.length,1);assert.equal(saved.battles[f.bid].publicEvents.length,1);}console.log(JSON.stringify({test:'private-postgres-rp-blocked-animation-mocked-discord',clicks:20,ackP95Ms:Math.round(firstAck),resultP95Ms:Math.round(firstResult),duplicateBurst:50}));
   }finally{release();rpg.stop();await rpg.drain();await st.recover(seed.guildId);}
  });
  await t.test('encrypted logical backup restores exact state into a separate namespace',async()=>{
   const exported=await db.load(seed.guildId),packed=JSON.parse(st.pack(exported)),envelope=h.deps.decrypt(packed).value,copy=JSON.parse(require('node:zlib').gunzipSync(Buffer.from(envelope.body,'base64')));
   restored=createPostgres({connectionString:process.env.RPG_TEST_DATABASE_URL,schema:schema+'_restore',encrypt:h.deps.encrypt,decrypt:h.deps.decrypt});await restored.acquireLease('restore');await restored.importState(seed.guildId,copy,'isolated-recovery-drill');assert.equal(digest(await restored.load(seed.guildId)),digest(exported));
  });
  await t.test('loss of the database session stops writes',async()=>{
   const key=crypto.createHash('sha256').update('rpg-writer:integration:'+schema).digest(),hi=key.readUInt32BE(0),lo=key.readUInt32BE(4);
   await db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND granted",[hi,lo]);
   for(let n=0;n<60&&!lost;n++)await sleep(100);assert.equal(lost,true);assert.throws(()=>db.assertLease(),/丢失/);await assert.rejects(st.transact(seed.guildId,'no-lease','1',s=>{s.players['1'].balance++;}),/丢失/);
  });
 }finally{
  if(second)await second.close();if(restored){await restored.pool.query('DROP SCHEMA "'+schema+'_restore" CASCADE');await restored.close();}
  await db.pool.query('DROP SCHEMA "'+schema+'" CASCADE');await db.close();
 }
});
