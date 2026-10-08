'use strict';
const C=require('./constants'),M=require('./model'),B=require('./combat'),H=require('./health'),U=require('./ui');
const ok=C.requireThat;
function outside(s,uid,targetUid) {
  const p=M.player(s,uid),target=M.player(s,targetUid);H.requireAction(p);ok(H.alive(target),'目标已经死亡。');ok(!M.battleFor(s,uid)&&!M.battleFor(s,targetUid),'不得跨战斗治疗。');
  const locate=who=>Object.values(s.explorations||{}).find(m=>m.status!=='ended'&&m.participants[who]);const a=locate(uid),b=locate(targetUid);
  ok(!a||a.participants[uid].characterId===p.id,'施治者探索角色已变化。');ok(!b||b.participants[targetUid].characterId===target.id,'治疗目标探索角色已变化。');
  ok(!a&&!b||a&&b&&a.id===b.id&&a.participants[uid].cell===b.participants[targetUid].cell,'探索期间只能治疗同地图同格的同伴。');return target;
}
function battle(s,b,actor,targetId) {
  const a=B.actorById(b,targetId),p=B.actorCharacter(s,a);ok(!a.deathId&&!a.retreated&&H.alive(p)&&(!a.userId||p.id===a.characterId),'治疗目标已失效。');
  ok(a.team===actor.team&&Math.floor(a.x/50)===Math.floor(actor.x/50)&&Math.floor(a.y/50)===Math.floor(actor.y/50),'只能治疗同格同伴。');return {a,p};
}
function createTreatment({snapshot,tx,use,actionPanel,canActor,bulkUse}) {
  function targets(s,b,a,itemId) {B.current(s,b,b.current?.id);const list=b.actors.filter(t=>{try{battle(s,b,a,t.id);return true;}catch{return false;}});return U.payload('选择治疗目标','同格同伴；消耗本人道具及一次快速行动。',[U.row(U.select(['treat','target',b.id,a.id,b.current.id,itemId].join(':'),'选择自己或同伴',list.map(t=>({label:t.name,value:t.id})))),...(a.userId?[U.row(U.button('bagbulk:'+a.userId+':'+itemId,'批量使用（先设置数量）'))]:[])]);}
  async function list(i,targetUid,page=0) {
    const f=await tx(i,s=>{const p=M.player(s,i.user.id),target=M.player(s,targetUid);H.requireAction(p);const f={id:C.id('f'),kind:'healSelect',owner:i.user.id,characterId:p.id,targetUid,targetCharacterId:target.id,expiresAt:C.confirmationDeadline(300000)};s.forms[f.id]=f;return f;},'准备同伴治疗');return view(snapshot(i.guildId),f,page);
  }
  function view(s,f,page=0){const p=M.player(s,f.owner),items=Object.values(p.inventory).filter(i=>C.CONSUMABLES.includes(i.snapshot.kind)&&M.available(s,f.owner,i.id)>0).slice(page*20,page*20+20);return U.payload('使用道具治疗同伴',s.players[f.targetUid]?.name||'目标角色已变化',[
    ...(items.length?[U.row(U.select('treat:outside:'+f.id,'选择本人治疗道具',items.map(i=>({label:i.snapshot.name,value:i.id}))))]:[]),U.row(U.button('treat:page:'+f.id+':'+(page+1),'下一页',undefined,items.length<20))]);}
  async function component(i,member) {
    const [action,id,actorId,turnId,itemId,recipientId]=i.customId.split(':').slice(2),s=snapshot(i.guildId);
    if(action==='batch'){const b=s.battles[id],a=canActor(s,b,actorId,member,i.user.id);ok(a.userId===i.user.id&&B.current(s,b,turnId).actor.id===a.id,'批量入口已变化。');battle(s,b,a,recipientId);return bulkUse.prepare(i,itemId,1,i.user.id,recipientId);}
    if(action==='target'){const b=s.battles[id],a=canActor(s,b,actorId,member,i.user.id);ok(B.current(s,b,turnId).actor.id===a.id,'行动机会变化。');const t=battle(s,b,a,i.values[0]);const v=await actionPanel.prepare(i,{battleId:b.id,actorId:a.id,turnId,action:'item',params:{itemId,recipientId:t.a.id,recipientCharacterId:t.p.id}});if(a.userId===i.user.id)v.components.push(U.row(U.button(['treat','batch',b.id,a.id,turnId,itemId,t.a.id].join(':'),'设置批量数量')));return v;}
    const f=s.forms[id];ok(f?.kind==='healSelect'&&f.owner===i.user.id&&!f.done&&f.expiresAt>Date.now(),'治疗选择已失效。');
    if(action==='page')return view(s,f,Number(actorId)||0);
    const b=M.battleFor(s,i.user.id);if(b){const a=b.actors.find(a=>a.userId===i.user.id),t=b.actors.find(a=>a.userId===f.targetUid);ok(t&&t.characterId===f.targetCharacterId,'治疗目标已变化。');return actionPanel.prepare(i,{battleId:b.id,actorId:a.id,turnId:b.current?.id,action:'item',params:{itemId:i.values[0],recipientId:t.id,recipientCharacterId:t.characterId}});}
    const r=await use(i,i.values[0],undefined,id,f.targetUid);return U.payload('治疗已保存',f.targetUid+' · 正常HP恢复 '+r.healed+' · 倒地HP恢复 '+r.reserveHealed+(r.revived?' · 已起身':''));
  }
  return {targets,list,component};
}
module.exports={outside,battle,createTreatment};
