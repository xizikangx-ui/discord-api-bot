'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),C=require('../src/rpg/constants'),S=require('../src/web/security');
test('expired trades are processed once; cancelled reminders and turn effects cannot cause a hot loop',async()=>{
 const scheduler=require('../src/web/game-scheduler'),s=C.newState('scheduler');s.offers.x={status:'ready',expiresAt:1};s.sessions.x={status:'cancelled',startsAt:1,reminder:{status:'pending'}};
 const p=require('../src/rpg/model').newCharacter('测试',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5});p.temporaryEffects=[{duration:{kind:'turns',turns:3},expiresAt:1,effects:[]}];s.players.u=p;
 assert.equal(scheduler.due(s,Date.now(),()=>false),true);scheduler.processDue(s,Date.now());assert.equal(s.offers.x.status,'expired');assert.equal(scheduler.due(s,Date.now(),()=>false),false);assert.equal(scheduler.delay(s,Date.now(),()=>false),30000);
});
test('a background task that becomes unnecessary while queued does not clone, save, audit or wake',async()=>{
 const s=C.newState('guard'),db={assertLease(){},load:async()=>C.clone(s),save:async()=>{throw Error('unexpected write');}},store=require('../src/rpg/store').createStore({database:db,systemActorId:'system'});s.upgrade=9;s.conditionPackVersion=1;s.supplyContainersVersion=1;await store.load('guard');let woke=0;store.onCommit(()=>woke++);const before=store.snapshot('guard');await store.transact('guard','skip','system',()=>{throw Error('unexpected execution');},'test',{when:()=>false,skipResult:{tick:false}});assert.deepEqual(store.snapshot('guard'),before);assert.equal(woke,0);
});
test('full persistence changes include publication fields omitted by display fingerprints',()=>{
 const a=C.newState('diff');a.battles.b={id:'b',status:'ended',publicEvents:[]};const b=C.clone(a);b.battles.b.publicEvents.push({id:'event',message:'saved'});assert.equal(require('../src/rpg/gm-service').fingerprint(a.battles.b),require('../src/rpg/gm-service').fingerprint(b.battles.b));assert.equal(require('../src/rpg/changes').changes(a,b).get('battles').has('b'),true);
});
test('streaming encryption preserves authenticated v1 format across arbitrary byte boundaries',async()=>{
 const crypt=S.codec(crypto.randomBytes(32).toString('base64')),data=Buffer.from(JSON.stringify({text:'异常之书'.repeat(1000)}));async function* chunks(){for(let n=0;n<data.length;n+=17)yield data.subarray(n,n+17);}const output=[];for await(const x of crypt.sealStream('backup','fixture',chunks()))output.push(Buffer.from(x));const bytes=Buffer.concat(output);assert.deepEqual(crypt.open('backup','fixture',bytes),JSON.parse(data));assert.throws(()=>crypt.open('backup','wrong',bytes));
});
test('disabled Discord RPG does not import its implementation and handles obsolete controls privately',async()=>{
 const before=new Set(Object.keys(require.cache)),off=require('../src/discord-rpg').createDisabled(),sent=[];assert.equal(await off.handle({commandName:'战斗',reply:async p=>sent.push(p)}),true);assert.equal(await off.handle({customId:'rpg:move:old',reply:async p=>sent.push(p)}),true);assert.equal(await off.handle({commandName:'禁言'}),false);assert.ok(sent.every(p=>p.flags===64));assert.deepEqual(off.renderStats(),{workers:0,queued:0,cacheBytes:0,cacheEntries:0});assert.ok(!Object.keys(require.cache).filter(k=>!before.has(k)).some(k=>/[\\/]rpg[\\/]index\.js$/.test(k)));
});
