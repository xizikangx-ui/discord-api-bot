'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/rpg/constants'),X=require('../src/rpg/exploration'),F=require('../src/rpg/forms'),B=require('../src/rpg/combat'),G=require('../src/rpg/gm-service'),Team=require('../src/rpg/team-movement'),Layout=require('../src/rpg/random-layout'),P=require('../src/web/game-service'),{derive}=require('../src/web/games');
const {state,fight}=require('./helpers/rpg-harness');
function seeded(seed){return(lo,hi)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return lo+seed%(hi-lo);};}
function fixture(){
 const s=state();s.platform='web';const f=F.create(s,'GM','mapcategory');Object.assign(f.data,{name:'交互验收主题',mapTypes:['indoor','region']});const cat=F.publish(s,f);
 const n=F.create(s,'GM','npc');Object.assign(n.data,{name:'守卫',hpMax:20});const npc=F.publish(s,n);
 const r=F.create(s,'GM','room');Object.assign(r.data,{name:'已保存房间',categoryIds:[cat.id],npcIds:[npc.id],npcQuantities:{[npc.id]:2},autoStart:false});const room=F.publish(s,r);
 return {s,cat,npc,room};
}
function mapFixture({auto=true,two=false}={}){
 const f=fixture(),m=X.create(f.s,'GM','channel','互动地图',1,3,'random',f.cat.id);m.autoEncounters=auto;for(const c of Object.values(m.cells))if(c.type==='room')c.variantId='v1';X.generate(f.s,m,min=>min);X.publish(f.s,m);for(const uid of two?['1','2']:['1'])X.join(f.s,m,uid);
 return {...f,m};
}
test('default narrow indoor layouts keep a room on every floor instead of almost all stairs',()=>{
 const {s,cat}=fixture();
 for(let seed=1;seed<=60;seed++)for(const width of [2,3,4,8,20]){
  const m=Layout.create(s,'GM','channel','室内', 'indoor','manual',cat.id,4,width,{blockedPercent:30,stairsMin:1,stairsMax:3},seeded(seed));
  assert.doesNotThrow(()=>X.validateMap(m));
  for(let y=0;y<m.floors;y++)assert.ok(Object.entries(m.cells).some(([ref,c])=>X.xy(ref)[1]===y&&c.type==='room'),'room missing on floor '+y+' width '+width);
  if(width===3)assert.ok(Object.values(m.cells).filter(c=>c.type==='stairs').length<=7);
 }
});
test('explicit minimum stair connections retain their meaning and remain connected',()=>{
 const {s,cat}=fixture();for(const minimum of [1,2,3])for(let seed=1;seed<=12;seed++){
  const m=Layout.create(s,'GM','channel','楼梯', 'indoor','manual',cat.id,8,minimum+1,{blockedPercent:0,stairsMin:minimum,stairsMax:3},seeded(seed));
  for(let y=1;y<m.floors;y++){
   let links=0;for(let x=0;x<m.width;x++)if(['stairs','entrance'].includes(m.cells[x+','+(y-1)]?.type)&&['stairs','entrance'].includes(m.cells[x+','+y]?.type))links++;
   assert.ok(links>=minimum);assert.ok(Object.entries(m.cells).some(([ref,c])=>X.xy(ref)[1]===y&&c.type==='room'));
  }
 }
});
test('regional terrain no longer instantiates a content room on nearly every tile',()=>{
 const {s,cat}=fixture();for(let seed=1;seed<=80;seed++){
  const m=Layout.create(s,'GM','channel','区域', 'region','manual',cat.id,6,8,{blockedPercent:15},seeded(seed));
  X.generate(s,m,seeded(seed+1));const cells=Object.values(m.cells),contents=cells.filter(c=>c.room);
  assert.ok(contents.length>=1);assert.ok(contents.length<=Math.floor((cells.length-1)/2));assert.ok(cells.some(c=>X.passable(c)&&!c.room&&c.type!=='entrance'));
  assert.equal(cells.some(c=>c.type==='stairs'),false);assert.doesNotThrow(()=>X.validateMap(m));
 }
});
test('repairing an old stair-heavy map preserves visited tiles, frozen rooms, characters and required links',()=>{
 const {s,cat}=fixture(),m=X.create(s,'GM','channel','旧楼梯',4,4,'random',cat.id);
 for(const c of Object.values(m.cells))c.type='stairs';m.cells['0,0'].type='entrance';m.cells['3,0'].type='room';m.cells['3,0'].room=X.instantiate(s,s.roomTemplates[Object.keys(s.roomTemplates)[0]],min=>min);m.cells['3,0'].touched=true;m.cells['1,1'].touched=true;
 m.generated=true;m.status='paused';m.entrance='0,0';m.participants['1']={characterId:s.players['1'].id,cell:'3,0'};m.revealed['3,0']=true;
 const room=C.clone(m.cells['3,0']),players=C.clone(s.players),result=Layout.repairStairs(s,m,min=>min);
 assert.ok(result.count>0);assert.deepEqual(m.cells['3,0'],room);assert.equal(m.cells['1,1'].type,'stairs');assert.deepEqual(s.players,players);assert.doesNotThrow(()=>X.validateMap(m));
 for(const ref of result.changed){assert.equal(m.cells[ref].type,'room');assert.ok(m.cells[ref].room);assert.notEqual(m.cells[ref].room.id,room.room.id);}
 for(let y=1;y<m.floors;y++)assert.ok(Array.from({length:m.width},(_,x)=>x).some(x=>['stairs','entrance'].includes(m.cells[x+','+(y-1)].type)&&['stairs','entrance'].includes(m.cells[x+','+y].type)));
});
test('stair repair stages new room draws atomically and never rewrites an active map',()=>{
 const {s,cat}=fixture(),m=X.create(s,'GM','channel','旧楼梯',3,3,'random',cat.id);for(const c of Object.values(m.cells))c.type='stairs';m.cells['0,0'].type='entrance';m.generated=true;m.status='active';const before=C.clone(m);
 assert.throws(()=>Layout.repairStairs(s,m),/暂停/);assert.deepEqual(m,before);m.status='paused';s.roomTemplates={};const paused=C.clone(m);assert.throws(()=>Layout.repairStairs(s,m),/房间/);assert.deepEqual(m,paused);
});
test('a random source failing after partial stair repair leaves every map field and saved room unchanged',()=>{
 const {s,cat}=fixture(),m=X.create(s,'GM','channel','原子楼梯',4,4,'random',cat.id);for(const c of Object.values(m.cells))c.type='stairs';m.cells['0,0'].type='entrance';m.generated=true;m.status='paused';const before=C.clone(s);let calls=0;
 assert.throws(()=>Layout.repairStairs(s,m,(lo,hi)=>{if(++calls===5)throw Error('模拟随机源中断');return lo;}),/随机源中断/);assert.equal(calls,5);assert.deepEqual(s,before);
});
test('new quick maps default to automatic encounters, while old manual rooms and explicit overrides stay manual',()=>{
 const {s,cat}=fixture(),params={name:'快捷',channelId:'channel',mapType:'indoor',mode:'manual',categoryId:cat.id,rows:4,width:3};
 const a=G.apply(s,'GM','map.quickCreate',params),m=s.explorations[a.id],room=Object.values(m.cells).find(c=>c.room).room;assert.equal(room.snapshot.autoStart,false);assert.equal(Team.automatic(m,room),true);
 room.autoStart=false;assert.equal(Team.automatic(m,room),false);G.apply(s,'GM','map.autoAll',{mapId:m.id,enabled:true});assert.equal(Team.automatic(m,room),true);
 room.boss={poolId:'reserved'};assert.equal(Team.automatic(m,room),false);
 const manual=G.apply(s,'GM','map.quickCreate',{...params,name:'手动',autoEncounters:false});assert.equal(s.explorations[manual.id].autoEncounters,false);
 const old={snapshot:{autoStart:false}};assert.equal(Team.automatic({},old),false);assert.equal(Team.pendingAuto(s,m),false);
});
test('moving into a room completes the entry and starts one saved encounter after all players agree',()=>{
 const {s,m}=mapFixture({two:true});for(const uid of ['1','2'])m.participants[uid].cell='1,0';const before=C.clone(s),r=Team.propose(s,m,'1','2,0');assert.equal(r.status,'pending');assert.equal(Object.keys(s.battles).length,0);
 Team.vote(s,m,r.id,'2',true);require('../src/rpg/mortality').reconcile(s,before);const room=m.cells['2,0'].room,b=s.battles[room.battleId];assert.equal(room.encounter,'battle');assert.equal(b.status,'active');assert.ok(b.actors.some(a=>a.userId==='1'));assert.ok(b.actors.some(a=>a.userId==='2'));assert.equal(b.actors.filter(a=>a.team==='enemy').length,2);
 const saved=C.clone({layout:room.tacticalLayout,history:b.history,remaining:room.remainingNpcs});Team.autoEncounters(s);require('../src/rpg/mortality').reconcile(s,C.clone(s));assert.equal(Object.keys(s.battles).length,1);assert.deepEqual({layout:room.tacticalLayout,history:b.history,remaining:room.remainingNpcs},saved);
});
test('ready automatic recruiting encounters resume without re-creating enemies or charging a second start',()=>{
 const {s,m}=mapFixture();m.participants['1'].cell='2,0';m.revealed['2,0']=true;const b=X.encounter(s,m,'2,0',['1'],min=>min),actors=b.actors.map(a=>a.id);assert.equal(b.status,'recruiting');assert.equal(Team.pendingAuto(s,m),true);
 Team.autoEncounters(s);assert.equal(b.status,'active');assert.deepEqual(b.actors.map(a=>a.id),actors);const current=C.clone(b.current),counts=C.clone(b.actionRound.counts);Team.autoEncounters(s);assert.deepEqual(b.current,current);assert.deepEqual(b.actionRound.counts,counts);
});
test('unentered enemy rooms do not keep scheduling game writes, and manual/RP/paused encounters never auto-start',()=>{
 const {s,m}=mapFixture();assert.equal(Team.pendingAuto(s,m),false);m.participants['1'].cell='2,0';m.revealed['2,0']=true;assert.equal(Team.pendingAuto(s,m),true);
 m.rps={rp:{status:'pending'}};m.rpPendingId='rp';assert.equal(Team.pendingAuto(s,m),false);Team.autoEncounters(s);assert.equal(Object.keys(s.battles).length,0);delete m.rps.rp;
 m.autoEncounters=false;assert.equal(Team.pendingAuto(s,m),false);Team.autoEncounters(s);assert.equal(Object.keys(s.battles).length,0);m.autoEncounters=true;m.status='paused';assert.equal(Team.pendingAuto(s,m),false);
});
test('an interrupted automatic start restores all staged rules and pauses without a half-started battle',()=>{
 for(const recruiting of [false,true]){
  const {s,m}=mapFixture();m.participants['1'].cell='2,0';m.revealed['2,0']=true;if(recruiting)X.encounter(s,m,'2,0',['1'],min=>min);const before=C.clone(s),start=B.start;
  try{B.start=(...args)=>{start(...args);args[0].forms.injected={kind:'battleAction'};throw Error('模拟开战中断');};Team.autoEncounters(s);}finally{B.start=start;}
  assert.deepEqual(s.players,before.players);assert.deepEqual(s.battles,before.battles);assert.deepEqual(s.forms,before.forms);assert.deepEqual(s.explorations[m.id].cells,before.explorations[m.id].cells);assert.equal(s.explorations[m.id].status,'paused');assert.match(s.explorations[m.id].lastEvent,/模拟开战中断/);
 }
});
test('battle start and player turn notifications are durable, deduplicated and linked to the exact turn',()=>{
 const {s,b}=fight(),before=C.clone(s);before.battles={};derive(before,s);const start=s.deliveryJobs['web:start:'+b.id],turn=s.deliveryJobs['web:turn:'+b.id+':'+b.current.id];assert.equal(start.kind,'webBattleStart');assert.equal(turn.kind,'webTurn');assert.equal(turn.turnId,b.current.id);assert.equal(turn.targetId,b.current.actorId);
 start.status='done';turn.status='done';const committed=C.clone(s);derive(committed,s);assert.equal(s.deliveryJobs[start.key].status,'done');assert.equal(s.deliveryJobs[turn.key].status,'done');
 B.finish(s,b,b.current.id,min=>min);derive(committed,s);assert.ok(s.deliveryJobs['web:turn:'+b.id+':'+b.current.id]);
});
test('movement confirmations publish a map update before movement completes',()=>{
 const {s,m}=mapFixture({two:true}),before=C.clone(s),request=Team.propose(s,m,'1','1,0');assert.equal(request.status,'pending');assert.ok(m.version>before.explorations[m.id].version);derive(before,s);assert.equal(s.deliveryJobs['web:map:'+m.id].kind,'webMap');
});
test('automatic encounter notices actually reach chat and repeated background delivery keeps one start card',async()=>{
 const {s,m}=mapFixture();m.channelId='entry';m.participants['1'].cell='1,0';for(const entry of m.cells['2,0'].room.remainingNpcs)entry.template.ai={mode:'manual'};
 const repo=require('./helpers/web-demo.cjs').memoryRepository(),group={id:s.guildId,name:'隔离团',autoSync:false};await repo.put('group',group);await repo.put('room',{id:'entry',groupId:group.id,name:'系统记录',kind:'system',sequence:0},{scope:group.id});
 const accounts={member:async(g,uid)=>({group,user:{id:uid},role:'player'}),gm:a=>assert.ok(a.role==='gm')},chat=require('../src/web/chat').createChat(repo,accounts);let canonical=C.clone(s);
 const database={assertLease(){},load:async()=>C.clone(canonical),save:async(g,b,n)=>{canonical=C.clone(n);}},games=require('../src/web/games').createGames({database,repo,accounts,library:{published:async()=>[]},chat});
 try{
  await games.ensure(group.id);await games.store.transact(group.id,'notice-entry','1',st=>Team.propose(st,st.explorations[m.id],'1','2,0'));
  await games.tick();const history=await repo.history('entry',{limit:100}),start=history.filter(v=>v.system?.kind==='webBattleStart');assert.equal(start.length,1);assert.match(start[0].text,/战斗开始/);assert.ok(start[0].system.battleId);
  const jobs=games.store.snapshot(group.id).deliveryJobs;assert.ok(Object.values(jobs).filter(j=>j.kind==='webBattleStart').every(j=>j.status==='done'));
  await games.tick();assert.equal((await repo.history('entry',{limit:100})).filter(v=>v.system?.kind==='webBattleStart').length,1);
 }finally{await games.stop();}
});
test('player exploration projection explains entry state and hides unknown building bindings',()=>{
 const {s,m}=mapFixture({auto:false});m.cells['2,0'].buildingMapId='hidden-building';let view=P.playerView(s,'1',{fields:['maps']}).maps[0];assert.deepEqual(view.neighbors,['1,0']);assert.equal(view.canExit,false);assert.deepEqual(view.cells['2,0'],{id:'2,0',hidden:true});assert.match(view.autoStatus,/没有遭遇/);
 m.participants['1'].cell='2,0';m.revealed['2,0']=true;view=P.playerView(s,'1',{fields:['maps']}).maps[0];assert.match(view.autoStatus,/手动开战/);assert.equal(view.cells['2,0'].room.autoStart,false);assert.equal(view.cells['2,0'].buildingMapId,'hidden-building');
 const playerTask=P.playerView(s,'1',{fields:['dashboard']}).dashboard.tasks.find(t=>t.system.kind==='webEncounterWait'),gmTask=P.playerView(s,'GM',{fields:['dashboard'],gm:true}).dashboard.tasks.find(t=>t.system.kind==='webEncounterWait');assert.equal(playerTask.system.cell,'2,0');assert.equal(gmTask.system.mapId,m.id);
 m.status='paused';assert.match(P.playerView(s,'1',{fields:['maps']}).maps[0].autoStatus,/暂停/);
});
