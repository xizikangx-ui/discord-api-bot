'use strict';
const C=require('./constants'),G=require('./gm-service'),M=require('./model'),B=require('./combat'),H=require('./health');
// Preview validators never execute random gameplay or create a death/reward record.
function preview(s,user,command,p){
  if(command==='character.delete'){const c=M.player(s,p.uid);C.requireThat(c.id===p.characterId,'角色已变化。');C.text(p.reason,'销卡理由',1000);return {name:c.name,characterId:c.id,inventoryCount:Object.keys(c.inventory).length,balance:c.balance,reason:p.reason,warning:'确认后清空角色、资产和兑换券。'};}
  if(command==='battle.death'||command==='battle.partyDeath'){const b=s.battles[p.battleId];G.editable(b);C.text(p.reason,'判死理由',1000);const list=command==='battle.death'?[B.actorById(b,p.actorId)]:require('./rescue').players(s,b);if(command==='battle.partyDeath')require('./rescue').pending(s,b,p.judgmentId,p.judgmentVersion);return {reason:p.reason,affected:list.map(a=>({name:a.name,actorId:a.id,health:H.snapshot(B.actorCharacter(s,a))})),warning:'确认后执行一次死亡清理并保存审计。'};}
  if(command==='map.cleanup'){const list=require('./map-cleanup').preview(s).filter(e=>(p.ids||[]).includes(e.id));C.requireThat(list.length&&(p.ids||[]).length===list.length,'请选择已结束地图。');return list;}
  const safe=new Set(['character.luck','character.key','character.skillRemove','character.checkXP','buyback','text.save','container.set','container.rates','config.save','map.pause','map.resume','map.end','map.rpEnabled','map.auto','map.link','map.transfer','map.playerPosition','map.playerRemove','map.resolve','battle.position','battle.terrain','battle.hp','battle.clearCondition','battle.ai','battle.equip','battle.skill','session.edit','session.close','session.cancel','session.delivered','check.end','check.create','session.create','npc.portrait']);
  if(safe.has(command))return {validated:true,result:G.apply(C.clone(s),user,command,p)};
  if(command.startsWith('battle.')){const b=s.battles[p.battleId];C.requireThat(b&&b.status!=='ended','战斗不存在或已结束。');if(command==='battle.npc')G.editable(b);if(command==='battle.action'){const a=B.actorById(b,p.actorId);C.requireThat(!a.userId||a.userId===user,'玩家由本人操作。');C.requireThat(p.action==='defend'||b.status==='active'&&b.current?.actorId===a.id,'当前不是该NPC的行动机会。');}return {battle:b.name,status:b.status,actor:p.actorId?B.actorById(b,p.actorId).name:undefined,params:p,random:'实际执行时生成一次，保存后不会重新随机。'};}
  if(command.startsWith('map.'))return {map:s.explorations[p.mapId]?.name,params:p,random:'实际执行时生成一次并保存。'};
  return {command,params:p};
}
module.exports={preview};
