'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/rpg/constants'),P=require('../src/web/game-service'),T=require('../src/rpg/team-movement');
function fixture(){
 const s=require('./helpers/rpg-harness').state();
 const m={id:'visible-map',channelId:'public',name:'巡游地图',mapType:'region',status:'active',width:3,floors:2,version:2,entrance:'0,0',participants:{'1':{characterId:s.players['1'].id,cell:'0,0'},'2':{characterId:s.players['2'].id,cell:'0,0'}},revealed:{'0,0':true,'1,0':true,'0,1':true},cells:{
  '0,0':{type:'entrance',description:'入口的碎石路。'},
  '1,0':{type:'building',name:'旧疗养院',buildingMapId:'inside',room:{id:'visible-room',snapshot:{name:'已知房间',description:'可见房间说明',npcIds:['secret-foe'],secret:'GM私注'},publicDescription:'GM已公开的环境说明',encounter:'resolved',containers:[{id:'sealed-box',box:'医疗包',status:'unopened',batch:{secret:'hidden-drop'}}],supplies:[]}},
  '0,1':{type:'forest'},
  '2,0':{type:'ruins',name:'隐藏格名称',buildingMapId:'secret-child',room:{id:'secret-room',snapshot:{name:'秘密怪房',description:'隐藏说明',npcs:[{name:'隐藏敌人'}]},remainingNpcs:[{quantity:19}],supplies:[{name:'秘密战利品'}]}},
 },moves:{},rps:{}};
 s.explorations[m.id]=m;
 for(const [id,channelId,name]of [['inside','public','公开内部地图'],['secret-child','secret','隐藏内部地图']])s.explorations[id]={id,channelId,name,mapType:'indoor',status:'active',width:1,floors:1,version:1,entrance:'0,0',participants:{},revealed:{'0,0':true},cells:{'0,0':{type:'entrance'}},moves:{},rps:{}};
 return {s,m};
}
function view(s){return P.playerView(s,'1',{fields:['maps'],roomIds:new Set(['public'])}).maps.find(m=>m.id==='visible-map');}
test('map projection supplies visible names, public environment, teammates and coordinates without mutating state',()=>{
 const {s,m}=fixture(),before=C.clone(s),v=view(s),cell=v.cells['1,0'];
 assert.equal(cell.name,'旧疗养院');assert.equal(cell.displayName,'旧疗养院');assert.equal(cell.typeName,'建筑入口');assert.equal(cell.floor,1);assert.equal(cell.column,2);assert.equal(cell.buildingName,'公开内部地图');assert.equal(cell.room.description,'GM已公开的环境说明');assert.equal(cell.room.snapshot,undefined);assert.equal(cell.room.remainingNpcs,undefined);assert.equal(cell.room.containers[0].batch,undefined);
 assert.equal(v.participants['2'].name,s.players['2'].name);assert.equal(v.participants['2'].validCharacter,true);assert.equal(v.canMove,true);assert.equal(v.moveBlockedReason,'');assert.deepEqual(v.neighbors,['1,0','0,1']);assert.deepEqual(s,before);
 delete m.cells['1,0'].room.publicDescription;assert.equal(view(s).cells['1,0'].room.description,'可见房间说明');
});
test('hidden cells and move drafts cannot leak unrevealed terrain, templates, enemy counts or loot',()=>{
 const {s,m}=fixture();m.moves.pending={id:'pending',owner:'1',from:'0,0',to:'1,0',members:['1','2'],yes:['1'],status:'pending',expiresAt:Date.now()+240000,roster:T.roster(m),layout:T.layout(m),characters:{'1':s.players['1'].id},destination:'secret-child',destinationName:'隐藏内部地图',destinationVersion:1,keyId:'private-key',publication:{status:'sending',privateToken:'secret-publication'}};
 const v=view(s),serialized=JSON.stringify(v);assert.deepEqual(v.cells['2,0'],{id:'2,0',hidden:true});
 for(const hidden of ['隐藏格名称','秘密怪房','隐藏说明','隐藏敌人','秘密战利品','secret-room','secret-child','隐藏内部地图','secret-foe','GM私注','hidden-drop','private-key','secret-publication'])assert.ok(!serialized.includes(hidden),hidden);
 assert.equal(v.moves.pending.layout,undefined);assert.equal(v.moves.pending.roster,undefined);assert.equal(v.moves.pending.characters,undefined);assert.equal(v.moves.pending.destination,undefined);assert.deepEqual(v.moves.pending.members,['1','2']);assert.equal(v.moves.pending.expiresAt,m.moves.pending.expiresAt);
});
test('RP waiting hides room environment and snapshot-derived labels, and hidden map bindings stay private',()=>{
 const {s,m}=fixture();delete m.cells['1,0'].name;m.rpPendingId='rp';m.rps.rp={status:'pending'};
 const v=view(s);assert.equal(v.rpWaiting,true);assert.equal(v.cells['1,0'].room,undefined);assert.equal(v.cells['1,0'].displayName,'建筑入口');assert.match(v.moveBlockedReason,/环境描述/);assert.equal(v.canMove,false);
 assert.ok(!JSON.stringify(v).includes('可见房间说明'));assert.ok(!JSON.stringify(v).includes('GM已公开的环境说明'));
 m.cells['1,0'].buildingMapId='secret-child';assert.equal(view(s).cells['1,0'].buildingName,undefined);
});
test('map movement availability explains current rule constraints and never changes saved confirmations',()=>{
 const scenarios=[
  ['未加入',({m})=>delete m.participants['1'],/先加入/],
  ['角色变更',({m})=>m.participants['1'].characterId='old',/角色已变化/],
  ['暂停',({m})=>m.status='paused',/已暂停/],
  ['参战',({s})=>s.battles.b={id:'b',status:'active',actors:[{userId:'1',characterId:s.players['1'].id}]},/正在参战/],
  ['倒地',({s})=>{s.players['1'].hp=0;s.players['1'].life={state:'downed',reserveHP:10};},/倒地/],
  ['超重',({s})=>s.players['1'].inventory.heavy={quantity:1,snapshot:{weight:999999}},/超重/],
  ['移动异常',({s})=>s.players['1'].conditions=[{severity:'致命',template:{name:'肢体破坏',levels:{'致命':{restrictions:['move']}}}}],/异常限制/],
  ['队伍未集合',({m})=>m.participants['2'].cell='0,1',/同一格/],
  ['队友换卡',({m})=>m.participants['2'].characterId='old',/有队员的角色已变化/],
  ['队友倒地',({s})=>{s.players['2'].hp=0;s.players['2'].life={state:'downed',reserveHP:10};},/有队员已倒地/],
  ['当前遭遇',({m})=>m.cells['0,0'].room={id:'origin',snapshot:{name:'遭遇'},encounter:'pending',containers:[],supplies:[]},/完成当前格的遭遇/],
  ['确认待办',({s,m})=>{const r={id:'move',status:'pending',members:['1','2'],characters:{'1':s.players['1'].id,'2':s.players['2'].id},expiresAt:Date.now()+240000,roster:T.roster(m),layout:T.layout(m),yes:['1'],from:'0,0',to:'1,0'};m.moves[r.id]=r;m.moveRequestId=r.id;},/移动申请/],
 ];
 for(const [label,change,pattern]of scenarios){const f=fixture();change(f);const before=C.clone(f.s),v=view(f.s);assert.equal(v.canMove,false,label);assert.match(v.moveBlockedReason,pattern,label);assert.deepEqual(f.s,before,label);}
 const f=fixture();f.m.participants.missing={cell:'0,0'};assert.equal(view(f.s).participants.missing.validCharacter,false);assert.equal(view(f.s).participants.missing.name,'角色已变化');
});
test('expired confirmations do not keep legal map movement disabled or revive their timer',()=>{
 const {s,m}=fixture(),r={id:'old',status:'pending',members:['1','2'],characters:{'1':s.players['1'].id,'2':s.players['2'].id},expiresAt:Date.now()-1,roster:T.roster(m),layout:T.layout(m),yes:['1'],from:'0,0',to:'1,0'};m.moves[r.id]=r;m.moveRequestId=r.id;
 const v=view(s);assert.equal(v.canMove,true);assert.equal(v.moveBlockedReason,'');assert.equal(r.status,'pending');assert.equal(v.moves.old.expiresAt,r.expiresAt);
 assert.equal(v.moves.old.valid,false);
});
test('building capability projections distinguish public entrances and private unavailable destinations',()=>{
 const {s,m}=fixture();m.participants['1'].cell='1,0';m.participants['2'].cell='1,0';
 let v=view(s);assert.equal(v.canEnterBuilding,true);assert.equal(v.enterBuildingBlockedReason,'');
 m.cells['1,0'].buildingMapId='secret-child';v=view(s);assert.equal(v.canEnterBuilding,false);assert.match(v.enterBuildingBlockedReason,/不可访问/);assert.ok(!JSON.stringify(v).includes('隐藏内部地图'));
});
