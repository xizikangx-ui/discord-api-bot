'use strict';
const C=require('./constants'),M=require('./model'),X=require('./exploration');const {requireThat:ok,clone}=C;
function destination(state,m,kind,from){if(kind==='enter'){ok(m.mapType==='region'&&m.cells[from]?.type==='building','在区域地图建筑入口才能进入。');return state.explorations[m.cells[from].buildingMapId];}ok(kind==='exit'&&m.parentContext&&from===m.entrance,'在内部入口才能离开建筑。');return state.explorations[m.parentContext.mapId];}
function bind(state,m,ref,buildingId){ok(['draft','paused'].includes(m.status)&&!m.excursion,'绑定前请暂停地图，并让队伍离开建筑。');ok(m.mapType==='region'&&m.cells[ref]?.type==='building','请选择建筑入口格。');const child=state.explorations[buildingId];ok(child&&child.id!==m.id&&(child.mapType||'indoor')==='indoor'&&child.status!=='ended','选择现有内部地图。');m.cells[ref].buildingMapId=buildingId;m.version++;}
function check(state,m,r){const dest=destination(state,m,r.kind,r.from);ok(dest&&dest.id===r.destination&&dest.status==='active','目标地图不可用或已暂停。');
 const room=m.cells[r.from]?.room;ok(!room||room.encounter==='resolved','先结束当前遭遇。');
 if(r.kind==='enter'){ok(!dest.parentContext&&!dest.excursion&&!Object.keys(dest.participants).length,'建筑正被其他队伍使用。');ok(!m.excursion,'已在进入建筑途中。');}
 else ok(dest.excursion?.childId===m.id&&m.parentContext.returnCell===r.to,'建筑往返记录不匹配。');
 for(const uid of r.members){const {p,part}=X.participant(state,m,uid);ok(part.cell===r.from&&!M.stats(p).overloaded,'队伍需集合且不能超重。');ok(!Object.values(state.explorations).some(other=>other.id!==m.id&&other.participants?.[uid]),'参与者在其他地图，不能切换。');}
}
function propose(state,m,uid,kind,now=Date.now()){const Team=require('./team-movement');Team.expire(state,m,now);ok(m.moves?.[m.moveRequestId]?.status!=='pending','已有全队移动或切换申请。');const {part}=X.participant(state,m,uid),dest=destination(state,m,kind,part.cell);ok(dest,'未绑定内部地图。');const members=Object.keys(m.participants);
 const r={id:C.id('v'),kind,owner:uid,from:part.cell,to:kind==='enter'?dest.entrance:m.parentContext.returnCell,destination:dest.id,destinationName:dest.name,destinationVersion:dest.version,members,characters:Object.fromEntries(members.map(id=>[id,m.participants[id].characterId])),roster:Team.roster(m),layout:Team.layout(m),yes:[uid],status:'pending',createdAt:now,expiresAt:now+180000,publication:{status:'pending'}};
 Team.checks(state,m,r);m.moves||={};m.moves[r.id]=r;m.moveRequestId=r.id;if(members.length===1)Team.complete(state,m,r);return clone(r);
}
function complete(state,m,r){check(state,m,r);const target=state.explorations[r.destination];
 if(r.kind==='enter'){m.excursion={childId:target.id,returnCell:r.from,characters:clone(r.characters)};target.parentContext={mapId:m.id,returnCell:r.from,characters:clone(r.characters)};}
 else{delete target.excursion;delete m.parentContext;}
 for(const uid of r.members){target.participants[uid]={...m.participants[uid],cell:r.to};delete m.participants[uid];}
 target.revealed[r.to]=true;target.cells[r.to].touched=true;target.version++;m.version++;r.status='completed';r.completedAt=Date.now();r.resultMapId=target.id;
 m.lastEvent='全队'+(r.kind==='enter'?'进入':'返回')+' '+target.name;target.lastEvent='全队从 '+m.name+' '+(r.kind==='enter'?'进入建筑':'返回区域');
}
function releaseEmpty(state,m){if(!m.parentContext||Object.keys(m.participants).length)return;const parent=state.explorations[m.parentContext.mapId];if(parent?.excursion?.childId===m.id){delete parent.excursion;parent.version++;}delete m.parentContext;m.version++;}
module.exports={bind,check,propose,complete,destination,releaseEmpty};
