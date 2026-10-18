'use strict';
const C=require('./constants'),M=require('./model'),X=require('./exploration'),B=require('./combat');
const {requireThat:ok,clone}=C;
function automatic(m,r){return !!r&&!r.boss&&!r.merchant&&!!(r.autoStart??m.autoEncounters??r.snapshot.autoStart);}
function roster(m){return JSON.stringify(Object.entries(m.participants).sort(([a],[b])=>a.localeCompare(b)));}
function layout(m){return JSON.stringify(Object.entries(m.cells).map(([ref,c])=>[ref,c.type,c.passable,c.room?.id,c.buildingMapId]));}
function valid(state,m,r,now=Date.now()){
  if(r.status!=='pending')return false;
  if(r.expiresAt<=now||m.status!=='active'||r.roster!==roster(m)||r.layout!==layout(m))return false;
  if(r.kind&&r.kind!=='move'){const target=state.explorations[r.destination];if(!target||target.status!=='active'||target.version!==r.destinationVersion)return false;}
  return r.members.every(uid=>state.players[uid]?.id===r.characters[uid]&&state.players[uid].hp>0&&!M.battleFor(state,uid));
}
function expire(state,m,now=Date.now()) {const r=m.moves?.[m.moveRequestId];if(r?.status==='pending'&&!valid(state,m,r,now)){r.status=r.expiresAt<=now?'expired':'cancelled';r.reason=r.status==='expired'?'四分钟内未全员确认':'地图、队伍或角色状态已经变化';m.version++;m.lastEvent='全队移动已取消：'+r.reason;return r;}return null;}
function checks(state,m,r){require('./rp').check(m);ok(valid(state,m,r),'移动申请已过期或队伍状态变化，请重新发起。');
  for(const uid of r.members){const {p,part}=X.participant(state,m,uid);require('./conditions').requireAction(p,'move');ok(part.cell===r.from,'全队必须在同一格。');ok(!M.stats(p).overloaded,p.name+'超重，无法移动。');}
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
  const r={id:C.id('v'),owner:uid,from:part.cell,to,keyId:keyId||null,members,characters:Object.fromEntries(members.map(id=>[id,m.participants[id].characterId])),roster:roster(m),layout:layout(m),yes:[uid],status:'pending',createdAt:now,expiresAt:C.confirmationDeadline(180000,now),publication:{status:'pending'}};
  checks(state,m,r);m.moves||={};m.moves[r.id]=r;m.moveRequestId=r.id;m.version++;m.lastEvent='全队移动待确认：'+r.from+' → '+r.to;
  if(members.length===1)complete(state,m,r);return clone(r);
}
function vote(state,m,ref,uid,yes,now=Date.now()){
  const r=m.moves?.[ref];ok(r,'移动申请不存在。');expire(state,m,now);ok(valid(state,m,r,now),'移动申请已经结束，请重新打开探索。');ok(r.members.includes(uid)&&state.players[uid]?.id===r.characters[uid],'只有该申请中的有效角色可以确认。');
  if(!yes){r.status='rejected';r.reason='有队员拒绝移动';r.rejectedBy=uid;m.version++;m.lastEvent='全队移动已取消：有队员拒绝';return clone(r);}
  if(!r.yes.includes(uid)){r.yes.push(uid);m.version++;}if(r.members.every(id=>r.yes.includes(id)))complete(state,m,r);return clone(r);
}
function readyUsers(state,m,cell,battleId=null){
 const users=Object.keys(m.participants);
 return users.length&&users.every(uid=>{const p=m.participants[uid],b=M.battleFor(state,uid);return p.cell===cell&&state.players[uid]?.id===p.characterId&&state.players[uid].hp>0&&(!b||b.id===battleId);})?users:[];
}
function pendingAuto(state,m){
 if(m.status!=='active'||require('./rp').waiting(m))return false;
 return Object.entries(m.cells).some(([cell,c])=>{
  const r=c.room;if(!automatic(m,r))return false;
  if(r.encounter==='pending')return !!readyUsers(state,m,cell).length;
  const b=r.encounter==='battle'&&state.battles[r.battleId];
  return b?.status==='recruiting'&&!!readyUsers(state,m,cell,b.id).length;
 });
}
function checkpoint(state){return Object.fromEntries(['battles','players','offers','deaths','corpses','forms','characterDrafts','explorations'].map(k=>[k,clone(state[k])]));}
function failedStart(state,saved,mapId,error){
 const m=state.explorations[mapId];Object.assign(state,saved);const restored=state.explorations[mapId];for(const k of Object.keys(m))if(!Object.hasOwn(restored,k))delete m[k];Object.assign(m,restored);state.explorations[mapId]=m;m.status='paused';m.lastEvent='自动遭遇暂停：'+error.message;m.version++;
}
function autoEncounters(state){const changed={maps:[],battles:[]};
  for(const m of Object.values(state.explorations).filter(m=>m.status==='active'))for(const [cell,c] of Object.entries(m.cells)){
    const r=c.room;if(require('./rp').waiting(m)||!r||!r.boss&&!automatic(m,r))continue;
    if(r.encounter==='battle'){
      const b=state.battles[r.battleId];if(!b)continue;
      if(b.status==='recruiting'&&!r.boss){
        const users=readyUsers(state,m,cell,b.id);
        if(!users.length||!users.every(uid=>b.actors.some(a=>a.userId===uid&&a.characterId===state.players[uid].id)))continue;
        const saved=checkpoint(state);
        try{B.start(state,b);m.lastEvent='遭遇开始：'+r.snapshot.name;m.version++;changed.battles.push(b.id);changed.maps.push(m.id);}
        catch(e){failedStart(state,saved,m.id,e);changed.maps.push(m.id);return changed;}
        continue;
      }
      const live=B.liveActors(state,b),enemies=live.filter(a=>a.team==='enemy'),allies=live.filter(a=>a.team==='ally');
      if(b.status==='active'&&!b.pending&&!enemies.length){B.endBattle(state,b);b.outcome=allies.length?'victory':'defeat';changed.battles.push(b.id);}
      else if(b.status==='active'&&!b.pending&&!allies.length){B.endBattle(state,b);b.outcome='defeat';changed.battles.push(b.id);}
      if(b.status!=='ended'||b.outcome!=='victory')continue;
      X.resolve(state,m,cell);changed.maps.push(m.id);
    }
    if(r.encounter!=='pending'||r.boss)continue;
    const users=readyUsers(state,m,cell);if(!users.length)continue;
    if(users.length>=20){m.status='paused';m.lastEvent='自动遭遇暂停：每场20人上限，需给NPC预留位置。';changed.maps.push(m.id);continue;}
    const saved=checkpoint(state);
    try {
      const b=X.encounter(state,m,cell,users);
      B.start(state,b);changed.battles.push(b.id);changed.maps.push(m.id);m.lastEvent='遭遇开始：'+r.snapshot.name;
    }catch(e){failedStart(state,saved,m.id,e);changed.maps.push(m.id);return changed;}
  }
  return changed;
}
module.exports={roster,layout,valid,expire,checks,propose,vote,autoEncounters,complete,pendingAuto,automatic};
