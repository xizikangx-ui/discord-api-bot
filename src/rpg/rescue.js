'use strict';
const C=require('./constants'),H=require('./health');
const ok=C.requireThat;
function players(s,b) { return b.actors.filter(a=>a.userId&&!a.deathId&&!a.retreated&&s.players[a.userId]?.id===a.characterId); }
function check(s,b) {
  if(b.status!=='active')return false;
  if(b.judgment?.status==='supported'&&b.actors.some(a=>!a.userId&&a.team==='ally'&&!a.retreated&&!a.deathId&&H.canAct(a.character)))return false;
  const roster=players(s,b);if(!roster.length||!roster.every(a=>H.downed(s.players[a.userId])))return false;
  if(b.pending) { b.stopForRescue=true;return true; }
  b.status='paused';b.pauseReason='全体在场玩家倒地，等待GM安排救援或裁决。';
  if(!b.judgment || b.judgment.status!=='pending')b.judgment={id:C.id('j'),version:1,status:'pending',characters:roster.map(a=>({actorId:a.id,userId:a.userId,characterId:a.characterId})),notification:{status:'pending'},createdAt:Date.now()};
  delete b.stopForRescue;return true;
}
function pending(s,b,id,version) { const j=b.judgment;ok(b.status==='paused'&&!b.pending&&j?.status==='pending'&&j.id===id&&j.version===Number(version),'裁决状态已变化或仍有待结算攻击。');return j; }
function rosterSignature(s,b) { return JSON.stringify(players(s,b).map(a=>({id:a.id,character:a.characterId,life:H.snapshot(s.players[a.userId]),version:s.players[a.userId].life?.version}))); }
function event(s,b,id,version,refs,amount,rp) {
  const j=pending(s,b,id,version);rp=C.text(rp,'救援事件RP',1000);amount=C.number(amount,'每人治疗量',1,100000000);
  ok(refs.length&&new Set(refs).size===refs.length,'请选择获救角色。');const B=require('./combat'),results=[];
  for(const ref of refs){const a=players(s,b).find(a=>a.id===ref);ok(a,'救援角色已经变化。');const p=s.players[a.userId];results.push({actorId:ref,name:p.name,...H.heal(p,amount)});}
  B.record(b,'GM救援事件：'+rp,{eventType:'rescue',gmRP:rp,rescueId:j.id,results,children:results.map(r=>({id:C.id('h'),targetId:r.actorId,name:r.name,shots:[],result:{healthBefore:r.before,healthAfter:r.after,hpBefore:r.before.hp,hp:r.after.hp,maxHP:r.after.maxHP,healed:r.healed,reserveHealed:r.reserveHealed,revived:r.revived}}))});j.version++;j.events||=[];j.events.push({rp,results,at:Date.now()});
  if(players(s,b).some(a=>H.canAct(s.players[a.userId])))j.status='rescued';return results;
}
function addPlayer(s,b,uid) {
  const M=require('./model'),B=require('./combat');ok(b.status==='paused'&&!b.pending&&b.actors.length<20,'暂停并完成受击后才能加入援军，最多20名参战者。');const p=M.player(s,uid);H.requireAction(p);ok(!M.battleFor(s,uid),'援军已参加另一场战斗。');
  for(const m of Object.values(s.explorations||{}))ok(m.id===b.exploration?.mapId||!m.participants[uid],'援军已参加另一张探索地图。');
  ok(!b.actors.some(a=>a.userId===uid&&a.characterId===p.id),'已经是参战角色。');
  const a={id:C.id('a'),userId:uid,characterId:p.id,name:p.name,team:'ally',retreated:false};p.ap=0;b.actors.push(a);place(b,a);
  if(b.exploration){const m=s.explorations[b.exploration.mapId];ok(m&&m.status!=='ended','原探索地图已失效。');m.participants[uid]={characterId:p.id,cell:b.exploration.cell};m.version++;}
  if(b.judgment){b.judgment.version++;b.judgment.status='supported';}B.record(b,p.name+'作为援军加入。',{actorId:a.id,eventType:'support'});return a;
}
function place(b,a) {
  const occupied=new Set(b.actors.filter(x=>x!==a&&!x.retreated).map(x=>x.x+','+x.y)),cells=[];
  for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)if(b.terrain[x+','+y]!=='blocked')for(const dx of [10,25,40])for(const dy of [10,25,40])if(!occupied.has((x*50+dx)+','+(y*50+dy)))cells.push({x:x*50+dx,y:y*50+dy});
  ok(cells.length,'没有可用的援军位置。');Object.assign(a,cells[require('node:crypto').randomInt(cells.length)]);
}
function deathPreview(s,b,owner,id,version,reason) {
  pending(s,b,id,version);reason=C.text(reason,'裁决理由',1000);ok(players(s,b).every(a=>H.downed(s.players[a.userId])),'已经有人起身，不能使用旧全队死亡裁决。');
  const f={id:C.id('f'),kind:'partyDeath',owner,battleId:b.id,judgmentId:id,version:Number(version),reason,signature:rosterSignature(s,b),expiresAt:C.confirmationDeadline(300000),status:'ready'};s.forms[f.id]=f;return f;
}
function kill(s,owner,id) {
  const f=s.forms[id];ok(f?.kind==='partyDeath'&&f.owner===owner,'裁决确认不属于你。');if(f.status==='done')return C.clone(f.result);ok(f.status==='ready'&&f.expiresAt>Date.now(),'确认已过期。');const b=s.battles[f.battleId],j=pending(s,b,f.judgmentId,f.version);ok(f.signature===rosterSignature(s,b),'生命或队伍已变化，请重新预览。');
  const refs=players(s,b);for(const a of refs){H.forceDeath(s.players[a.userId]);require('./mortality').settle(s,b,a,{userId:owner});}j.status='death';j.version++;f.status='done';f.result={names:refs.map(a=>a.name),reason:f.reason};b.outcome='defeat';require('./combat').record(b,'GM判定全队死亡：'+f.reason,{judgmentId:j.id});require('./combat').endBattle(s,b);return C.clone(f.result);
}
module.exports={players,check,pending,event,addPlayer,place,deathPreview,kill,rosterSignature};
