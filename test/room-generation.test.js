'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/rpg/constants'),F=require('../src/rpg/forms'),X=require('../src/rpg/exploration'),Layout=require('../src/rpg/random-layout'),Policy=require('../src/rpg/room-generation'),K=require('../src/rpg/containers'),P=require('../src/web/game-service');
const min=a=>a;
function fixture(){
 const s=require('./helpers/rpg-harness').state();s.platform='web';
 const category=F.create(s,'GM','mapcategory');Object.assign(category.data,{name:'医疗楼',mapTypes:['indoor','region']});const cat=F.publish(s,category);
 const actor=F.create(s,'GM','npc');Object.assign(actor.data,{name:'巡逻守卫',hpMax:20});const npc=F.publish(s,actor);
 const form=F.create(s,'GM','room');Object.assign(form.data,{name:'医疗值班室',categoryIds:[cat.id],randomNpcs:[{ref:npc.id,probabilities:[65,25,8,2,0,0,0,0,0,0,0]}],randomContainers:[{ref:'药品柜',probabilities:[100,0,0,0,0,0,0]},{ref:'医疗包',probabilities:[100,0,0,0,0,0,0]}]});const room=F.publish(s,form);
 return{s,cat,npc,room};
}
function occupiedFixture(){
 const f=fixture();delete f.s.roomTemplates[f.room.id];
 const form=F.create(f.s,'GM','room');Object.assign(form.data,{name:'驻守医疗室',categoryIds:[f.cat.id],npcIds:[f.npc.id],npcQuantities:{[f.npc.id]:1},randomNpcs:[{ref:f.npc.id,probabilities:[0,100,0,0,0,0,0,0,0,0,0]}],variants:[{id:'occupied',name:'驻守医疗室',description:'医疗室由守卫驻守。',weight:1,enabled:true,overrides:{}}]});
 f.room=F.publish(f.s,form);return f;
}
function map(f,n=10,percent=30){const m=X.create(f.s,'GM','public','配额地图',1,n+1,'random',f.cat.id);m.cells={'0,0':{type:'entrance',categoryId:f.cat.id}};for(let i=1;i<=n;i++)m.cells[i+',0']={type:'room',categoryId:f.cat.id};m.generation={combatPercent:percent};m.maxRank=3;return m;}
function counts(m){const rooms=Object.values(m.cells).filter(c=>c.room).map(c=>c.room);return{safe:rooms.filter(r=>r.encounter==='resolved').length,battle:rooms.filter(r=>r.encounter==='pending').length};}
test('new layout options default to a 30% quota, validate 0—100, round room counts and leave safety unless 100 is explicit',()=>{
 assert.equal(Layout.options().combatPercent,30);assert.throws(()=>Layout.options({combatPercent:-1}),/战斗比例/);assert.throws(()=>Layout.options({combatPercent:101}),/战斗比例/);
 for(const n of [1,2,3,5,10,19])for(const rate of [0,1,30,50,99,100]){const f=fixture(),m=map(f,n,rate);X.generate(f.s,m,min);assert.equal(counts(m).battle,Policy.count(n,rate),n+'/'+rate);assert.equal(counts(m).safe,n-Policy.count(n,rate));if(rate<100)assert.ok(counts(m).safe>=1);}
});

test('the basic random-map creation entry enforces the default quota even when every room template always contains enemies',()=>{
 const f=occupiedFixture(),m=X.create(f.s,'GM','public','基础创建入口',1,20,'random',f.cat.id);
 assert.equal(m.generation.combatPercent,30);X.generate(f.s,m,min);
 assert.deepEqual(counts(m),{safe:6,battle:3});
 assert.ok(Object.values(m.cells).filter(c=>c.room).every(c=>c.room.generation&&c.room.generation.combatPercent===30));
});

test('paused GM cell edits cannot turn all safe rooms into battles by replacing them with corridors and rooms',()=>{
 const f=occupiedFixture(),m=X.create(f.s,'GM','public','暂停编辑入口',1,20,'random',f.cat.id),G=require('../src/rpg/gm-service');X.generate(f.s,m,min);m.status='paused';
 const before=counts(m),templates=C.clone(f.s.roomTemplates),battleCells=Object.fromEntries(Object.entries(m.cells).filter(([,c])=>c.room?.encounter==='pending').map(([ref,c])=>[ref,C.clone(c)]));
 const safeRefs=Object.entries(m.cells).filter(([,c])=>c.room?.encounter==='resolved').map(([ref])=>ref);assert.ok(safeRefs.length>1);
 for(const ref of safeRefs){const [x,y]=ref.split(',').map(Number),params={mapId:m.id,x,y,categoryId:f.cat.id,passable:true,hasContents:false};
  G.apply(f.s,'GM','map.cell',{...params,type:'corridor'});G.apply(f.s,'GM','map.cell',{...params,type:'room'});
  assert.equal(m.cells[ref].room.encounter,'resolved',ref);assert.deepEqual(m.cells[ref].room.npcs,[]);assert.equal(m.cells[ref].room.generation.role,'safe');
 }
 assert.deepEqual(counts(m),before);for(const [ref,c]of Object.entries(battleCells))assert.deepEqual(m.cells[ref],c);assert.deepEqual(f.s.roomTemplates,templates);
});

test('blocked paused-room additions stay unrolled until reopened and cannot reserve extra combat slots',()=>{
 const f=occupiedFixture(),m=X.create(f.s,'GM','public','阻挡编辑顺序',1,2,'random',f.cat.id),G=require('../src/rpg/gm-service');
 m.cells={'0,0':{type:'entrance',categoryId:f.cat.id},'1,0':{type:'room',categoryId:f.cat.id}};X.generate(f.s,m,min);m.status='paused';const original=C.clone(m.cells['1,0'].room);
 const edit=(x,passable)=>G.apply(f.s,'GM','map.cell',{mapId:m.id,x,y:0,type:'room',categoryId:f.cat.id,passable,hasContents:false});
 edit(2,false);assert.equal(m.cells['2,0'].passable,false);assert.equal(m.cells['2,0'].room,undefined);
 edit(3,true);assert.equal(m.cells['3,0'].room.encounter,'pending');const otherBattle=C.clone(m.cells['3,0'].room);
 edit(2,true);assert.equal(m.cells['2,0'].room.encounter,'resolved');assert.equal(m.cells['2,0'].room.generation.role,'safe');assert.deepEqual(counts(m),{safe:2,battle:1});assert.deepEqual(m.cells['1,0'].room,original);assert.deepEqual(m.cells['3,0'].room,otherBattle);
});

test('blocked content cells do not require room generation or prevent publication and reopen through the shared quota',()=>{
 for(const region of [false,true]){
  const f=occupiedFixture(),m=X.create(f.s,'GM','public','阻挡内容发布',region?2:1,3,'random',f.cat.id,region?'region':'indoor'),G=require('../src/rpg/gm-service'),type=region?'forest':'room';
  m.cells={'0,0':{type:'entrance',categoryId:f.cat.id},'1,0':{type:region?'wild':'room',hasContents:region,categoryId:f.cat.id},'2,0':{type,hasContents:region,passable:false,categoryId:f.cat.id}};
  if(region)for(let x=0;x<3;x++)m.cells[x+',1']={type:'road',categoryId:f.cat.id};
  X.generate(f.s,m,min);assert.equal(m.cells['2,0'].room,undefined);assert.deepEqual(counts(m),{safe:1,battle:0});assert.doesNotThrow(()=>X.publish(f.s,m));const original=C.clone(m.cells['1,0'].room);m.status='paused';
  G.apply(f.s,'GM','map.cell',{mapId:m.id,x:2,y:0,type,categoryId:f.cat.id,passable:true,hasContents:region});assert.equal(m.cells['2,0'].room.encounter,'pending');assert.equal(m.cells['2,0'].room.generation.role,'battle');assert.deepEqual(counts(m),{safe:1,battle:1});assert.deepEqual(m.cells['1,0'].room,original);
 }
});

test('repairing redundant stairs applies the quota to new ordinary rooms and preserves every existing room snapshot',()=>{
 const f=occupiedFixture(),m=X.create(f.s,'GM','public','楼梯修复入口',2,4,'random',f.cat.id);
 m.cells=Object.fromEntries([['0,0','entrance'],['1,0','stairs'],['2,0','room'],['3,0','corridor'],['0,1','stairs'],['1,1','stairs'],['2,1','room'],['3,1','corridor']].map(([ref,type])=>[ref,{type,categoryId:f.cat.id}]));
 X.generate(f.s,m,min);assert.deepEqual(counts(m),{safe:1,battle:1});m.status='paused';
 const original=Object.fromEntries(Object.entries(m.cells).filter(([,c])=>c.room).map(([ref,c])=>[ref,C.clone(c)])),r=Layout.repairStairs(f.s,m,min);
 assert.equal(r.count,2);assert.deepEqual(counts(m),{safe:3,battle:1});
 for(const ref of r.changed){assert.equal(m.cells[ref].room.encounter,'resolved');assert.equal(m.cells[ref].room.generation.role,'safe');assert.deepEqual(m.cells[ref].room.remainingNpcs,[]);}
 for(const [ref,c]of Object.entries(original))assert.deepEqual(m.cells[ref],c);assert.doesNotThrow(()=>X.validateMap(m));
});

test('a zero-quantity frozen NPC entry cannot create an empty encounter or qualify as a combat candidate',()=>{
 const f=occupiedFixture(),template=X.validateRoom(f.s,f.room);template.variants=[];template.npcs=[{template:C.clone(f.npc),quantity:0}];template.randomNpcs=[];
 const r=X.instantiate(f.s,template,min,3);assert.equal(r.encounter,'resolved');assert.deepEqual(r.npcs,[]);assert.deepEqual(r.remainingNpcs,[]);assert.deepEqual(Policy.legalNpcs(f.s,template,3),[]);assert.equal(r.randomResults.some(e=>e.kind==='containerGuarantee'),false);
});

test('safe room snapshots contain no fixed or random enemy configuration while published source templates remain intact',()=>{
 const f=occupiedFixture(),source=C.clone(f.room),m=map(f);X.generate(f.s,m,min);const safe=Object.values(m.cells).filter(c=>c.room?.generation.role==='safe');assert.equal(safe.length,7);
 for(const {room:r}of safe){for(const field of ['npcIds','npcs','randomNpcs'])assert.deepEqual(r.snapshot[field],[],field);for(const field of ['npcCounts','npcQuantities'])assert.deepEqual(r.snapshot[field],{},field);assert.deepEqual(r.npcs,[]);assert.deepEqual(r.remainingNpcs,[]);assert.equal(r.encounter,'resolved');assert.equal(r.snapshot.name,'驻守医疗室');assert.equal(r.snapshot.description,'医疗室由守卫驻守。');}
 assert.deepEqual(f.room,source);assert.deepEqual(f.s.roomTemplates[f.room.id],source);
});
test('stairs, corridors, roads and entrances never enter the ordinary-room quota, even if a GM enables contents',()=>{
 const f=fixture(),m=map(f,10,30);for(const type of ['stairs','corridor','road','entrance','wall'])assert.equal(Policy.ordinary(m,{type,hasContents:true}),false);
 assert.equal(Policy.ordinary(m,{type:'forest',hasContents:true}),true);assert.equal(Policy.ordinary(m,{type:'room',passable:false}),false);
 m.cells['0,0'].hasContents=true;const p=Policy.plan(f.s,m);assert.equal(p.missing.length,10);assert.equal(p.target,3);
});
test('new peaceful variants explicitly suppress inherited enemies, while legacy or GM overrides and published snapshots are preserved',()=>{
 const f=fixture();Object.assign(f.room,{npcIds:[f.npc.id],npcQuantities:{[f.npc.id]:2}});const before=C.clone(f.room),peace=X.instantiate(f.s,f.room,min,3,'v0'),occupied=X.instantiate(f.s,f.room,min,3,'v1');
 assert.deepEqual(peace.npcs,[]);assert.equal(peace.encounter,'resolved');assert.equal(peace.randomResults.some(e=>e.kind==='npc'),false);assert.equal(occupied.npcs[0].quantity,2);assert.deepEqual(f.room,before);
 const legacy=C.clone(f.room);legacy.variants[0].overrides={};const custom=X.instantiate(f.s,legacy,min,3,'v0');assert.equal(custom.npcs[0].quantity,2);
});
test('a quota battle saves at least one legal NPC and its lowest enabled thematic container even when every quantity draw was zero',()=>{
 const f=fixture(),m=map(f);X.generate(f.s,m,min);assert.deepEqual(counts(m),{safe:7,battle:3});
 for(const c of Object.values(m.cells)){const r=c.room;if(!r)continue;if(r.generation.role==='safe'){assert.deepEqual(r.npcs,[]);assert.deepEqual(r.remainingNpcs,[]);assert.equal(r.randomResults.some(e=>e.kind==='npc'),false);}else{assert.equal(r.npcs.length,1);assert.equal(r.npcs[0].template.id,f.npc.id);assert.equal(r.npcs[0].quantity,1);assert.equal(r.containers.length,1);assert.equal(r.containers[0].box,'医疗包');assert.equal(r.containers[0].batch,null);assert.ok(r.randomResults.some(e=>e.kind==='npcGuarantee'));assert.ok(r.randomResults.some(e=>e.kind==='containerGuarantee'));}}
});
test('fixed GM room choices, fixed variants, BOSS and merchant nodes are excluded and never overwritten',()=>{
 const f=fixture(),m=map(f,7,0);m.cells['1,0'].templateId=f.room.id;m.cells['2,0'].templateId=f.room.id;m.cells['2,0'].variantId=f.room.variants[1].id;
 m.cells['3,0'].room={id:'boss',boss:{poolId:'boss'},encounter:'pending',npcs:[{quantity:5}]};m.cells['4,0'].room={id:'merchant',merchant:{name:'行商'},encounter:'resolved'};const frozen=C.clone(m.cells);
 X.generate(f.s,m,(lo,hi)=>hi-1);assert.equal(m.cells['1,0'].room.npcs.length,1);assert.equal(m.cells['1,0'].room.generation,undefined);assert.equal(m.cells['2,0'].room.snapshot.variantId,f.room.variants[1].id);assert.deepEqual(m.cells['3,0'],frozen['3,0']);assert.deepEqual(m.cells['4,0'],frozen['4,0']);assert.equal(m.cells['5,0'].room.encounter,'resolved');
 assert.ok(m.cells['1,0'].room.containers.length);assert.ok(m.cells['2,0'].room.containers.length);
 const fixed=map(f,2,100);fixed.mode='fixed';for(const c of Object.values(fixed.cells).filter(c=>c.type==='room'))c.templateId=f.room.id;X.generate(f.s,fixed,(lo,hi)=>hi-1);assert.ok(Object.values(fixed.cells).filter(c=>c.room).every(c=>!c.room.generation&&c.room.containers.length));
});
test('new GM-specified, standalone and paused-edit combat rooms get a container without changing enemy counts; saved rooms and BOSS remain frozen',()=>{
 const f=fixture();Object.assign(f.room,{npcIds:[f.npc.id],npcQuantities:{[f.npc.id]:2},randomNpcs:[],randomContainers:[]});const validated=X.validateRoom(f.s,f.room),r=X.instantiate(f.s,validated,min,3,'v1');assert.equal(r.npcs.reduce((n,e)=>n+e.quantity,0),2);assert.equal(r.containers[0].box,'纸箱');
 const m=map(f,2,0);m.mode='fixed';for(const c of Object.values(m.cells).filter(c=>c.type==='room')){c.templateId=f.room.id;c.variantId='v1';}X.generate(f.s,m,min);assert.ok(Object.values(m.cells).filter(c=>c.room).every(c=>c.room.npcs.reduce((n,e)=>n+e.quantity,0)===2&&c.room.containers.length===1));
 const saved=m.cells['1,0'].room;saved.containers=[];X.generate(f.s,m,()=>{throw Error('saved empty room cannot be supplemented');});assert.deepEqual(saved.containers,[]);
 m.status='paused';X.editCell(f.s,m,4,1,'room',f.cat.id,f.room.id,'v1');assert.equal(m.cells['3,0'].room.containers[0].box,'纸箱');
 const without=X.instantiate(f.s,validated,min,3,'v1',{skipContainer:true});assert.deepEqual(without.containers,[]);
});
test('missing published or in-rank NPC candidates fail before drawing or changing any map field',()=>{
 for(const disable of [f=>f.npc.published=false,f=>f.npc.anomalyRank='IV']){const f=fixture(),m=map(f),beforePlayers=C.clone(f.s.players);disable(f);const before=C.clone(m);let draws=0;assert.throws(()=>X.generate(f.s,m,(lo)=>{draws++;return lo;}),/NPC候选/);assert.equal(draws,0);assert.deepEqual(m,before);assert.deepEqual(f.s.players,beforePlayers);}
 const f=fixture(),m=map(f);f.room.published=false;assert.throws(()=>X.generate(f.s,m,min),/没有可生成/);assert.equal(Object.values(m.cells).some(c=>c.room),false);
});
test('container fallback respects disabled thematic choices, uses generic white only without candidates and never bypasses a full shutdown',()=>{
 const f=fixture();f.s.containerDefinitions=K.definitions();f.s.containerDefinitions['医疗包'].enabled=false;const m=map(f);X.generate(f.s,m,min);assert.ok(Object.values(m.cells).filter(c=>c.room?.encounter==='pending').every(c=>c.room.containers[0].box==='药品柜'));
 const all=fixture();all.s.containerDefinitions=K.definitions();for(const b of ['医疗包','药品柜'])all.s.containerDefinitions[b].enabled=false;const blocked=map(all),before=C.clone(blocked);assert.throws(()=>X.generate(all.s,blocked,min),/候选已全部停用/);assert.deepEqual(blocked,before);
 const plain=fixture();plain.room.randomContainers=[];const generic=map(plain);X.generate(plain.s,generic,min);assert.ok(Object.values(generic.cells).filter(c=>c.room?.encounter==='pending').every(c=>c.room.containers[0].box==='纸箱'));assert.equal(K.get(plain.s,'纸箱').grade,'white');
 plain.s.containerDefinitions=K.definitions();plain.s.containerDefinitions['纸箱'].enabled=false;assert.throws(()=>X.generate(plain.s,map(plain),min),/纸箱.*停用/);
});
test('refresh, regeneration, restore and additional rooms preserve frozen IDs, NPC levels, container intents and random results',()=>{
 const f=fixture(),m=map(f);f.npc.randomStrength=true;f.npc.levelMin=1;f.npc.levelMax=10;X.generate(f.s,m,min);const before=C.clone(m),players=C.clone(f.s.players);X.generate(f.s,m,()=>{throw Error('must not reroll');});assert.deepEqual(m,before);
 const restored=C.clone(m);X.generate(f.s,restored,()=>{throw Error('restore must not reroll');});assert.deepEqual(restored,before);
 m.cells['11,0']={type:'room',categoryId:f.cat.id};m.width++;m.generated=false;X.generate(f.s,m,min);for(const [ref,c]of Object.entries(before.cells))assert.deepEqual(m.cells[ref],c);assert.deepEqual(f.s.players,players);
});
test('a late random-source failure does not retain partially built quota rooms or fallback results',()=>{
 const f=fixture(),m=map(f),before=C.clone(m);let draws=0;assert.throws(()=>X.generate(f.s,m,(lo)=>{if(++draws===20)throw Error('injected render-independent random failure');return lo;}),/injected/);assert.deepEqual(m,before);
});
test('multi-batch encounters keep one saved room container and frozen remaining enemies until every batch is resolved',()=>{
 const f=fixture(),m=map(f,2,100),B=require('../src/rpg/combat');Object.assign(f.room,{npcIds:[f.npc.id],npcQuantities:{[f.npc.id]:19},randomNpcs:[]});X.generate(f.s,m,min);X.publish(f.s,m);X.join(f.s,m,'1');X.join(f.s,m,'2');const ref='1,0',r=m.cells[ref].room;m.revealed[ref]=true;for(const p of Object.values(m.participants))p.cell=ref;const containers=C.clone(r.containers),random=C.clone(r.randomResults);
 const first=X.encounter(f.s,m,ref,['1','2'],min);assert.equal(first.actors.length,20);assert.equal(r.remainingNpcs.reduce((n,e)=>n+e.quantity,0),1);assert.throws(()=>X.open(f.s,m,'1',r.containers[0].id,min),/参战期间|遭遇尚未解除/);B.endBattle(f.s,first,'测试结束第一批');X.resolve(f.s,m,ref);assert.equal(r.encounter,'pending');assert.deepEqual(r.containers,containers);
 const second=X.encounter(f.s,m,ref,['1','2'],min);assert.equal(second.actors.length,3);assert.equal(r.remainingNpcs.length,0);B.endBattle(f.s,second,'测试结束第二批');X.resolve(f.s,m,ref);assert.equal(r.encounter,'resolved');assert.deepEqual(r.containers,containers);assert.deepEqual(r.randomResults,random);
});
test('revealed battle containers expose names and locked flags only; fog, RP and channel fences still hide them, and opening remains forbidden',()=>{
 const f=fixture(),m=map(f,3,100);X.generate(f.s,m,min);X.publish(f.s,m);X.join(f.s,m,'1');const cell=Object.entries(m.cells).find(([,c])=>c.room)[0],r=m.cells[cell].room;m.revealed[cell]=true;m.participants['1'].cell=cell;r.containers[0].batch={items:[{snapshot:{name:'秘密奖励'}}]};r.containers[0].owner={userId:'secret-owner'};
 const view=(roomIds=new Set(['public']))=>P.playerView(f.s,'1',{fields:['maps'],roomIds}).maps;
 const projected=view()[0].cells[cell].room;assert.equal(projected.containers[0].box,'医疗包');assert.equal(projected.containers[0].locked,true);assert.equal(projected.containers[0].quantity,1);assert.equal(projected.containers[0].batch,undefined);assert.equal(projected.containers[0].owner,undefined);assert.deepEqual(projected.supplies,[]);assert.ok(!JSON.stringify(view()).includes('秘密奖励'));assert.throws(()=>X.open(f.s,m,'1',r.containers[0].id,min),/遭遇尚未解除/);
 delete m.revealed[cell];assert.deepEqual(view()[0].cells[cell],{id:cell,hidden:true});assert.deepEqual(view(new Set()),[]);m.revealed[cell]=true;m.rps={pending:{status:'pending'}};m.rpPendingId='pending';assert.equal(view()[0].cells[cell].room,undefined);delete m.rpPendingId;r.encounter='resolved';assert.equal(view()[0].cells[cell].room.containers[0].locked,false);
});
test('ordinary legacy generated maps are not retrofitted, and NPC random-entry defaults distinguish random from fixed quantity',()=>{
 const f=fixture(),m=map(f);delete m.generation.combatPercent;X.generate(f.s,m,min);assert.equal(counts(m).battle,0);assert.ok(Object.values(m.cells).filter(c=>c.room).every(c=>!c.room.generation));const before=C.clone(m);X.generate(f.s,m,()=>{throw Error('legacy reroll');});assert.deepEqual(m,before);
 const R=require('../src/rpg/room-settings');assert.deepEqual(R.defaultProbabilities(10),[65,25,8,2,0,0,0,0,0,0,0]);assert.deepEqual(R.defaultProbabilities(6),[0,100,0,0,0,0,0]);assert.equal(R.quantities({},['npc'],19).npc,1);
});
test('only newly created random maps guarantee containers in both ordinary safe and battle rooms',()=>{
 const f=fixture(),m=map(f,10,30);m.generation.containerPolicyVersion=2;X.generate(f.s,m,min);assert.deepEqual(counts(m),{safe:7,battle:3});
 for(const {room:r}of Object.values(m.cells).filter(c=>c.room)){assert.equal(r.containers.length,1);assert.equal(r.containers[0].box,'医疗包');assert.equal(r.generation.containerPolicyVersion,2);assert.equal(r.randomResults.filter(e=>e.kind==='containerGuarantee').length,1);}
 const saved=C.clone(m);X.generate(f.s,m,()=>{throw Error('cannot redraw policy containers');});assert.deepEqual(m,saved);
 const fresh=X.create(f.s,'GM','another','新随机图',1,4,'random',f.cat.id);assert.equal(fresh.generation.containerPolicyVersion,2);
 const fixed=X.create(f.s,'GM','fixed','GM固定图',1,4,'fixed',f.cat.id);assert.equal(fixed.generation,undefined);
});
test('safe-room guarantee selects legal thematic containers, rejects a full thematic shutdown before RNG and preserves old drafts',()=>{
 const f=fixture();f.s.containerDefinitions=K.definitions();f.s.containerDefinitions['医疗包'].enabled=false;const m=map(f,3,0);m.generation.containerPolicyVersion=2;X.generate(f.s,m,min);assert.ok(Object.values(m.cells).filter(c=>c.room).every(c=>c.room.containers[0].box==='药品柜'));
 const blocked=map(f,3,0);blocked.generation.containerPolicyVersion=2;f.s.containerDefinitions['药品柜'].enabled=false;const before=C.clone(blocked);let rolls=0;assert.throws(()=>X.generate(f.s,blocked,lo=>{rolls++;return lo;}),/候选已全部停用/);assert.equal(rolls,0);assert.deepEqual(blocked,before);
 const plain=fixture();plain.room.randomContainers=[];const fallback=map(plain,3,0);fallback.generation.containerPolicyVersion=2;X.generate(plain.s,fallback,min);assert.ok(Object.values(fallback.cells).filter(c=>c.room).every(c=>c.room.containers[0].box==='纸箱'));
 const legacy=map(plain,3,0);X.generate(plain.s,legacy,min);assert.ok(Object.values(legacy.cells).filter(c=>c.room).every(c=>c.room.containers.length===0));
 const old=Layout.create(plain.s,'GM','old','旧草稿重排','indoor','manual',plain.cat.id,4,3,{},min);delete old.generation.containerPolicyVersion;Layout.build(old,{},min);assert.equal(old.generation.containerPolicyVersion,undefined);X.generate(plain.s,old,min);assert.ok(Object.values(old.cells).filter(c=>c.room?.generation.role==='safe').every(c=>!c.room.containers.length));
});
test('explicit GM safe rooms and special nodes keep their saved zero-container configuration under the new policy',()=>{
 const f=fixture(),m=map(f,5,0);m.generation.containerPolicyVersion=2;m.cells['1,0'].templateId=f.room.id;m.cells['1,0'].variantId='v0';m.cells['2,0'].room={id:'boss',boss:{},containers:[],npcs:[]};m.cells['3,0'].room={id:'merchant',merchant:{},containers:[],npcs:[]};const specials=C.clone([m.cells['2,0'],m.cells['3,0']]);X.generate(f.s,m,min);assert.equal(m.cells['1,0'].room.containers.length,0);assert.deepEqual([m.cells['2,0'],m.cells['3,0']],specials);assert.equal(m.cells['4,0'].room.containers.length,1);
});
