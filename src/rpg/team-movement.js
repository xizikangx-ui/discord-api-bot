'use strict';
const C=require('./constants'),M=require('./model'),X=require('./exploration'),B=require('./combat');
const {requireThat:ok,clone}=C;
function roster(m){return JSON.stringify(Object.entries(m.participants).sort(([a],[b])=>a.localeCompare(b)));}
function layout(m){return JSON.stringify(Object.entries(m.cells).map(([ref,c])=>[ref,c.type,c.passable,c.room?.id,c.buildingMapId]));}
function valid(state,m,r,now=Date.now()){
  if(r.status!=='pending')return false;
  if(r.expiresAt<=now||m.status!=='active'||r.roster!==roster(m)||r.layout!==layout(m))return false;
  if(r.kind&&r.kind!=='move'){const target=state.explorations[r.destination];if(!target||target.status!=='active'||target.version!==r.destinationVersion)return false;}
  return r.members.every(uid=>state.players[uid]?.id===r.characters[uid]&&state.players[uid].hp>0&&!M.battleFor(state,uid));
}
function expire(state,m,now=Date.now()) {const r=m.moves?.[m.moveRequestId];if(r?.status==='pending'&&!valid(state,m,r,now)){r.status=r.expiresAt<=now?'expired':'cancelled';r.reason=r.status==='expired'?'三分钟内未全员确认':'地图、队伍或角色状态已经变化';return r;}return null;}
function checks(state,m,r){require('./rp').check(m);ok(valid(state,m,r),'移动申请已过期或队伍状态变化，请重新发起。');
  for(const uid of r.members){const {p,part}=X.participant(state,m,uid);ok(part.cell===r.from,'全队必须在同一格。');ok(!M.stats(p).overloaded,p.name+'超重，无法移动。');}
  if(r.kind&&r.kind!=='move'){require('./map-links').check(state,m,r);return;}
  ok(X.neighbors(m,r.from).includes(r.to),'只能移动到相邻可通行格。');
  const origin=m.cells[r.from]?.room;ok(!origin||origin.encounter==='resolved','先完成当前房间遭遇。');
  const room=m.cells[r.to]?.room;if(room&&!room.unlocked){const p=state.players[r.owner],item=p.inventory[r.keyId];ok(item?.snapshot.kind==='钥匙'&&item.templateId===room.snapshot.keyIds[0]&&item.keyCharges>0&&M.available(state,r.owner,r.keyId)>0,'发起者的匹配钥匙已失效或被预留。');}
}
function complete(state,m,r){checks(state,m,r);if(r.kind&&r.kind!=='move'){require('./map-links').complete(state,m,r);return r;}X.move(state,m,r.owner,r.to,r.keyId);
  for(const uid of r.members)m.participants[uid].cell=r.to;
  r.status='completed';r.completedAt=Date.now();m.lastEvent='全队移动至 '+r.to;return r;
}
function propose(state,m,uid,to,keyId,now=Date.now()){
  expire(state,m,now);ok(!m.moves?.[m.moveRequestId]||m.moves[m.moveRequestId].status!=='pending','已有全队移动申请，请先确认或取消。');
  const {part}=X.participant(state,m,uid),members=Object.keys(m.participants);
  const r={id:C.id('v'),owner:uid,from:part.cell,to,keyId:keyId||null,members,characters:Object.fromEntries(members.map(id=>[id,m.participants[id].characterId])),roster:roster(m),layout:layout(m),yes:[uid],status:'pending',createdAt:now,expiresAt:now+180000,publication:{status:'pending'}};
  checks(state,m,r);m.moves||={};m.moves[r.id]=r;m.moveRequestId=r.id;
  if(members.length===1)complete(state,m,r);return clone(r);
}
function vote(state,m,ref,uid,yes,now=Date.now()){
  const r=m.moves?.[ref];ok(r,'移动申请不存在。');expire(state,m,now);ok(valid(state,m,r,now),'移动申请已经结束，请重新打开探索。');ok(r.members.includes(uid)&&state.players[uid]?.id===r.characters[uid],'只有该申请中的有效角色可以确认。');
  if(!yes){r.status='rejected';r.reason='有队员拒绝移动';r.rejectedBy=uid;return clone(r);}
  if(!r.yes.includes(uid))r.yes.push(uid);if(r.members.every(id=>r.yes.includes(id)))complete(state,m,r);return clone(r);
}
function autoEncounters(state){const changed={maps:[],battles:[]};
  for(const m of Object.values(state.explorations).filter(m=>m.status==='active'))for(const [cell,c] of Object.entries(m.cells)){
    const r=c.room;if(require('./rp').waiting(m)||!r||!(r.autoStart??r.snapshot.autoStart))continue;
    if(r.encounter==='battle'){
      const b=state.battles[r.battleId];if(!b)continue;
      const live=B.liveActors(state,b),enemies=live.filter(a=>a.team==='enemy'),allies=live.filter(a=>a.team==='ally');
      if(b.status==='active'&&!b.pending&&!enemies.length){B.endBattle(state,b);b.outcome=allies.length?'victory':'defeat';changed.battles.push(b.id);}
      else if(b.status==='active'&&!b.pending&&!allies.length){B.endBattle(state,b);b.outcome='defeat';changed.battles.push(b.id);}
      if(b.status!=='ended'||b.outcome!=='victory')continue;
      X.resolve(state,m,cell);changed.maps.push(m.id);
    }
    if(r.encounter!=='pending')continue;
    const users=Object.keys(m.participants);if(!users.length||!users.every(uid=>m.participants[uid].cell===cell&&state.players[uid]?.id===m.participants[uid].characterId&&state.players[uid].hp>0&&!M.battleFor(state,uid)))continue;
    if(users.length>=20){m.status='paused';m.lastEvent='自动遭遇暂停：每场20人上限，需给NPC预留位置。';changed.maps.push(m.id);continue;}
    const oldBattles=clone(state.battles),oldRoom=clone(r),oldVersion=m.version,oldPlayers=clone(state.players),oldOffers=clone(state.offers),oldDeaths=clone(state.deaths),oldCorpses=clone(state.corpses);
    try {
      const b=X.encounter(state,m,cell,users),spawn=r.snapshot.spawn||{};
      for(const a of b.actors)B.position(b,a.id,a.team==='ally'?(spawn.playerX??25):(spawn.npcX??b.width*50-25),a.team==='ally'?(spawn.playerY??25):(spawn.npcY??b.height*50-25));
      B.start(state,b);changed.battles.push(b.id);changed.maps.push(m.id);m.lastEvent='遭遇开始：'+r.snapshot.name;
    }catch(e){state.battles=oldBattles;state.players=oldPlayers;state.offers=oldOffers;state.deaths=oldDeaths;state.corpses=oldCorpses;c.room=oldRoom;m.version=oldVersion;m.status='paused';m.lastEvent='自动遭遇暂停：'+e.message;changed.maps.push(m.id);}
  }
  return changed;
}
module.exports={roster,layout,valid,expire,checks,propose,vote,autoEncounters,complete};
