"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg'),S=require('../src/web/security');
test('book invitations: real PostgreSQL atomic counters, permissions, HTTP and recovery',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const suffix=crypto.randomBytes(6).toString('hex'),schemas=['web_test_invite_'+suffix,'web_test_invite_content_'+suffix,'rpg_test_invite_'+suffix],pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5}),crypt=S.codec(crypto.randomBytes(32).toString('base64')),gameCrypt=S.rpgCodec(crypto.randomBytes(32).toString('base64'));
 const makeRepo=schema=>require('../src/web/repository').createRepository(pool,crypt,{schema}),repo=makeRepo(schemas[0]),content=makeRepo(schemas[1]),db=require('../src/rpg/postgres').createPostgres({pool,schema:schemas[2],...gameCrypt});
 const app=require('../src/web/server').createWeb({pool,database:db,repository:repo,contentRepository:content,crypt,gameCrypt,bootstrapHash:S.hash('isolated-book-bootstrap'),allowHttp:true,renderer:{queue:()=>new Promise(()=>{}),close(){}}});
 let origin,admin,group,other,a,shared,first;
 const call=async(auth,path,p)=>{const r=await fetch(origin+'/api/web/v1'+path,{method:p===undefined?'GET':'POST',headers:{Origin:origin,'content-type':'application/json',...(auth?{cookie:'web_session='+auth.secret,'x-web-csrf':auth.csrf}:{})},body:p===undefined?undefined:JSON.stringify(p)});return {status:r.status,...await r.json()};};
 async function seed(n){const user={id:crypto.randomUUID(),name:'seed_'+n,displayName:'隔离成员'+n,createdAt:Date.now(),version:1},secret=S.token(),csrf=S.token();await repo.put('user',user,{lookup:S.hash(user.name)});await repo.put('session',{id:S.hash(secret),userId:user.id,csrf,expiresAt:Date.now()+3600000},{scope:user.id});return {user,secret,csrf};}
 try{
  origin='http://127.0.0.1:'+(await app.start(0)).port;
  admin=await app.accounts.register({name:'book_admin',password:'isolated book password',token:'isolated-book-bootstrap'},true);group=await app.accounts.createGroup(await app.accounts.user(admin.user.id),{name:'多人码隔离团'},crypto.randomUUID());other=await app.accounts.createGroup(await app.accounts.user(admin.user.id),{name:'其他团'},crypto.randomUUID());a=await app.accounts.member(group.id,admin.user.id);
  await t.test('old HTTP creation remains single-use; concurrent registration has one winner',async()=>{
   const result=await call(admin,'/groups/'+group.id+'/invite',{});assert.equal(result.status,200);assert.equal(result.data.mode,'single');
   const attempts=await Promise.allSettled(['book_one','book_two'].map(name=>app.accounts.register({name,password:'isolated book password',invite:result.data.code})));assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);first=attempts.find(r=>r.status==='fulfilled').value;
   assert.equal((await repo.get('invite',result.data.id)).usedCount,1);
  });
  await t.test('20 concurrent and 50 burst joins retain every successful count, never duplicate membership',async()=>{
   shared=(await call(admin,'/groups/'+group.id+'/invite',{mode:'multi24h'})).data;
   for(const count of [20,50]){const users=[];for(let n=0;n<count;n++)users.push(await seed(count+'_'+n));const at=performance.now(),times=[];const results=await Promise.all(users.map(async u=>{const start=performance.now(),r=await call(u,'/groups/join',{code:shared.code});times.push(performance.now()-start);return r;}));assert.ok(results.every(r=>r.status===200));times.sort((a,b)=>a-b);console.log(JSON.stringify({type:'multi-invite-private-pg',requests:count,resultP95ms:Math.round(times[Math.ceil(times.length*.95)-1]),elapsedMs:Math.round(performance.now()-at),transport:'loopback HTTP / Railway private PG isolated namespace'}));}
   assert.equal((await repo.get('invite',shared.id)).usedCount,70);await Promise.all(Array.from({length:20},()=>call(first,'/groups/join',{code:shared.code})));assert.equal((await repo.get('invite',shared.id)).usedCount,70);assert.equal((await repo.list('member',group.id)).length,72);
  });
  await t.test('one unlimited code supports multiple real scrypt registrations; invalid registration leaves no account',async()=>{
   const created=await Promise.all(['multi_registered_a','multi_registered_b'].map(name=>app.accounts.register({name,password:'isolated book password',invite:shared.code})));assert.equal(created.length,2);assert.equal((await repo.get('invite',shared.id)).usedCount,72);
   await assert.rejects(app.accounts.register({name:'never_created',password:'isolated book password',invite:'invalid-code'}));assert.equal(await repo.lookup('user',S.hash('never_created')),null);
  });
  await t.test('removed members need a fresh single invite, and their active role is never rewritten by duplicate join',async()=>{
   const m=await repo.get('member',group.id+':'+first.user.id);m.active=false;await repo.put('member',m,{scope:group.id});assert.equal((await call(first,'/groups/join',{code:shared.code})).status,403);
   const single=await app.accounts.invite(a);assert.equal((await call(first,'/groups/join',{code:single.code})).status,200);assert.equal((await app.accounts.member(group.id,first.user.id)).role,'player');
   const adminMember=await repo.get('member',group.id+':'+admin.user.id),version=adminMember.version;await call(admin,'/groups/join',{code:shared.code});assert.equal((await repo.get('member',adminMember.id)).version,version);
  });
  await t.test('list/revoke endpoints enforce role, group, expiry and repeated revoke',async()=>{
   const list=await call(admin,'/groups/'+group.id+'/invites');assert.equal(list.status,200);assert.ok(list.data.items.some(i=>i.id===shared.id&&i.usedCount===72));assert.ok(!JSON.stringify(list.data).includes(shared.code));
   assert.equal((await call(first,'/groups/'+group.id+'/invites')).status,403);assert.equal((await call(admin,'/groups/'+other.id+'/invites/'+shared.id+'/revoke',{operationId:crypto.randomUUID()})).status,404);
   const op=crypto.randomUUID();for(let n=0;n<2;n++)assert.equal((await call(admin,'/groups/'+group.id+'/invites/'+shared.id+'/revoke',{operationId:op})).status,200);assert.equal((await call(await seed('revoked'),'/groups/join',{code:shared.code})).status,422);
   const expired=await app.accounts.invite(a,{mode:'multi24h'}),record=await repo.get('invite',expired.id);record.expiresAt=Date.now();await repo.put('invite',record,{scope:group.id});assert.equal((await call(await seed('expired'),'/groups/join',{code:expired.code})).status,422);
  });
  await t.test('current issuer GM/disabled status and deleting group reject admission, including after restart',async()=>{
   const issuer=await seed('issuer');await repo.put('member',{id:group.id+':'+issuer.user.id,groupId:group.id,userId:issuer.user.id,role:'gm',active:true,version:1},{scope:group.id});const gi=await app.accounts.invite(await app.accounts.member(group.id,issuer.user.id),{mode:'multi24h'});const m=await repo.get('member',group.id+':'+issuer.user.id);m.role='player';await repo.put('member',m,{scope:group.id});await assert.rejects(app.accounts.join((await seed('noauth')).user,gi.code),/GM/);m.role='gm';await repo.put('member',m,{scope:group.id});const u=await repo.get('user',issuer.user.id);u.disabled=true;await repo.put('user',u);await assert.rejects(app.accounts.join((await seed('disabled')).user,gi.code),/停用/);
   const last=await app.accounts.invite(a,{mode:'multi24h'}),g=await repo.get('group',group.id);g.deleting=true;await repo.put('group',g);await assert.rejects(app.accounts.join(first.user,last.code),/不存在/);
   const fresh=makeRepo(schemas[0]);assert.equal((await fresh.get('invite',shared.id)).usedCount,72);assert.ok((await fresh.get('invite',shared.id)).revokedAt);const raw=(await pool.query('SELECT payload FROM "'+schemas[0]+'".records WHERE kind=$1 AND id=$2',['invite',shared.id])).rows[0].payload;assert.ok(!raw.includes(Buffer.from(shared.code)));
  });
 }finally{await app.stop();for(const schema of schemas)await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await db.close();}
});
