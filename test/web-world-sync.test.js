'use strict';
const {contentHash}=require('../src/web/world-library');
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/rpg/constants'),W=require('../src/web/world'),{atlas}=require('../src/web/world-atlas'),{fixture,params}=require('./helpers/world-fixture.cjs');
function nextAtlas(routeId){const a=C.clone(atlas);a.version=2;a.cities['ever-city-002'].name='望山新城';a.cities['ever-city-002'].x+=15;a.cities['ever-city-002'].version=2;a.cities['ever-city-003'].name='守望新城';a.cities['ever-city-003'].version=2;a.routes[routeId].fee+=10;a.routes[routeId].version=2;return a;}
async function publishFixture(repo,a){for(const c of Object.values(a.cities))await repo.put('worldCity',c,{scope:a.id});for(const r of Object.values(a.routes))await repo.put('worldRoute',r,{scope:a.id});const {cities,routes,...meta}=a;await repo.put('worldAtlas',{...meta,contentHash:contentHash({cities,routes})});}
test('public content hashes are stable for sorted, reversed and reordered repository rows',async()=>{
 const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value;
 assert.equal(contentHash(atlas),contentHash(reverseKeys(atlas)));
 for(const mode of ['sorted','reverse','nested']){
  const repo=require('./helpers/web-demo.cjs').memoryRepository(),list=repo.list;
  repo.list=async(...args)=>{const rows=(await list(...args)).sort((a,b)=>a.id.localeCompare(b.id));return mode==='sorted'?rows:mode==='reverse'?rows.reverse():rows.reverse().map(reverseKeys);};
  const lib=require('../src/web/world-library').createWorldLibrary(repo);await lib.install({id:'a',admin:true},{operationId:'world_hash_'+mode});const loaded=await lib.refresh();assert.equal(loaded.version,1);assert.equal(contentHash(loaded),contentHash(atlas));
  const c=await repo.get('worldCity','ever-city-002');await repo.put('worldCity',{...c,name:c.name+'篡改'},{scope:atlas.id});await assert.rejects(lib.refresh(),/校验失败/);
 }
});
test('catalogue sync preserves full local overrides and departed snapshots; unmodified cities upgrade',()=>{
 const {s,routeId}=fixture(),before=C.clone(s.worldLocations),oldOrigin=s.worldSettings.main.originCityId;
 const j=W.apply(s,'1','world.propose',params(s,routeId),false,{rng:lo=>lo}),saved=C.clone(s.worldJourneys[j.id]);
 W.apply(s,'GM','world.city.save',{cityId:'ever-city-002',baseVersion:1,data:{...W.city(s,'ever-city-002'),name:'本团望山'}},true);
 W.apply(s,'GM','world.route.save',{routeId,baseVersion:1,data:{...W.road(s,routeId),fee:99}},true);
 const oldPosition=W.city(s,'ever-city-002').x,latest=nextAtlas(routeId),pinned=C.clone(s);W.setPublished(latest,[atlas]);
 assert.equal(W.city(pinned,'ever-city-003').name,atlas.cities['ever-city-003'].name);
 const sync=W.sync(s);assert.equal(sync.version,2);assert.equal(sync.conflicts.length,2);
 assert.equal(W.city(s,'ever-city-002').name,'本团望山');assert.equal(W.city(s,'ever-city-002').x,oldPosition);assert.equal(W.road(s,routeId).fee,99);assert.equal(W.city(s,'ever-city-003').name,'守望新城');
 assert.deepEqual(s.worldJourneys[j.id],saved);assert.deepEqual(s.worldLocations,before);assert.equal(s.worldSettings.main.originCityId,oldOrigin);
 W.sync(s);assert.equal(s.worldSettings.main.conflicts.length,2);assert.equal(W.city(s,'ever-city-002').x,oldPosition);
});
test('automatic world sync observes the daily boundary and does not repeat an installed version',()=>{
 const {s,routeId}=fixture(),at=s.worldSettings.main.lastSyncAt;W.setPublished(nextAtlas(routeId),[atlas]);assert.equal(W.syncDue(s.worldSettings.main,at+86400000-1),false);assert.equal(W.syncDue(s.worldSettings.main,at+86400000),true);W.sync(s,at+86400000);assert.equal(W.syncDue(s.worldSettings.main,at+172800000),false);
});
test('public revisions survive process restart for groups whose automatic sync is disabled',async()=>{
 const repo=require('./helpers/web-demo.cjs').memoryRepository(),lib=require('../src/web/world-library').createWorldLibrary(repo);await lib.install({id:'a',admin:true},{operationId:'world_version_install'});
 const {s,routeId}=fixture(),saved=C.clone(s);assert.equal((await repo.list('worldAtlasRevision',atlas.id)).length,1);
 await publishFixture(repo,nextAtlas(routeId));W.setPublished(null);await lib.refresh();
 assert.equal(W.publishedVersion(),2);assert.equal(W.ready(saved).version,1);assert.equal(W.city(saved,'ever-city-002').name,atlas.cities['ever-city-002'].name);W.sync(saved);assert.equal(W.ready(saved).version,2);
 await assert.rejects(lib.install({id:'a',admin:true},{operationId:'world_version_downgrade',baseVersion:2}),/不能回退/);assert.equal((await repo.get('worldAtlas',atlas.id)).version,2);
});
test('background sync honors the group switch, retains local conflicts and never places existing characters',async()=>{
 const h=await require('./helpers/world-website.cjs').launch();try{
  const old=h.app.games.store.select(h.group.id,C.clone),routeId=Object.values(atlas.routes).find(r=>r.from==='ever-city-001').id;
  await h.app.games.store.transact(h.group.id,'world-daily-setup',h.user.id,s=>{s.worldSettings.main.lastSyncAt=0;delete s.worldLocations[h.player.user.id];W.apply(s,h.user.id,'world.route.save',{routeId,baseVersion:1,data:{...W.road(s,routeId),fee:77}},true);return{setup:true};});
  const group=await h.repo.get('group',h.group.id);group.autoSync=false;await h.repo.put('group',group);await publishFixture(h.content,nextAtlas(routeId));await require('../src/web/world-library').createWorldLibrary(h.content).refresh();await h.app.games.tick();assert.equal(h.app.games.store.select(h.group.id,C.clone).worldSettings.main.catalogVersion,1);
  group.autoSync=true;await h.repo.put('group',group);await h.app.games.tick();const after=h.app.games.store.select(h.group.id,C.clone);assert.equal(after.worldSettings.main.catalogVersion,2);assert.equal(after.worldRoutes[routeId].fee,77);assert.equal(after.worldSettings.main.conflicts.length,1);assert.equal(after.worldLocations[h.player.user.id],undefined);assert.equal(after.players[h.player.user.id].balance,old.players[h.player.user.id].balance);
 }finally{await h.app.stop();W.setPublished(atlas);}
});
