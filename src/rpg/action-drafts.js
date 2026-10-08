'use strict';
const C=require('./constants'),B=require('./combat'),U=require('./ui');
const labels={attack:'攻击／释放技能',move:'移动',reload:'装填',ammo:'弹夹操作',switch:'切换武器',item:'使用道具',cast:'确认吟唱',pass:'放弃行动',finish:'结束行动机会',flee:'撤退',defend:'防守反应'};
function owned(s,id,uid){const f=s.forms[id];C.requireThat(f?.kind==='battleAction'&&f.owner===uid,'行动草稿不属于你或已经不存在。');return f;}
function create(s,uid,{battleId,actorId,turnId,action,params={},back,sourceFormId,expiresAt=Infinity}){
 const b=s.battles[battleId];C.requireThat(b,'战斗已不存在。');const a=B.actorById(b,actorId),p=B.actorCharacter(s,a);C.requireThat(labels[action]&&!a.deathId&&!a.retreated&&require('./health').canAct(p),'行动或角色已失效。');
 const source=sourceFormId&&s.forms[sourceFormId];if(source?.kind==='bulkUse')C.requireThat(!source.done&&source.status==='ready'&&source.expiresAt>Date.now()&&source.quantity===params.quantity,'批量草稿已变化。');
 const hit=action==='defend'&&require('./aoe').hit(b,params.hitId);if(action==='defend')C.requireThat(hit&&hit.targetId===a.id&&hit.expiresAt>Date.now(),'防守已经结算或到期。');else C.requireThat(b.current?.id===turnId&&b.current.actorId===a.id&&b.status==='active','行动机会已经变化。');
 if(sourceFormId){const old=Object.values(s.forms).find(f=>f.kind==='battleAction'&&f.owner===uid&&f.sourceFormId===sourceFormId&&f.sourceVersion===(source?.version??null)&&f.status==='ready'&&f.expiresAt>Date.now());if(old)return old;}
 const f={id:C.id('f'),kind:'battleAction',owner:uid,battleId,actorId,characterId:p.id,turnId,action,params:C.clone(params),back,sourceFormId,sourceVersion:source?.version??null,createdAt:Date.now(),expiresAt:Math.min(C.confirmationDeadline(300000),hit?.expiresAt||Infinity,expiresAt),status:'ready'};s.forms[f.id]=f;return f;
}
function execute(s,id,uid,rp='',rng){const f=owned(s,id,uid);if(f.status==='done')return C.clone(f.result);
 C.requireThat(f.status==='ready'&&f.expiresAt>Date.now(),'行动草稿已取消或过期；防守填写RP不会延长截止时间。');rp=C.text(rp,'RP',1000,true);
 const b=s.battles[f.battleId];C.requireThat(b,'战斗已不存在，RP没有发布。');const a=B.actorById(b,f.actorId),p=B.actorCharacter(s,a),x=f.params;
 C.requireThat(p.id===f.characterId&&!a.deathId&&!a.retreated&&require('./health').canAct(p),'角色已经变化，请重新选择行动。');
 if(f.action==='defend'){const hit=require('./aoe').hit(b,x.hitId);C.requireThat(hit&&hit.targetId===a.id&&hit.expiresAt>Date.now(),'防守已结算或超时，RP没有发布。');}
 else C.requireThat(B.current(s,b,f.turnId).actor.id===a.id,'当前行动者已变化。');
 if(f.sourceFormId){const source=s.forms[f.sourceFormId];C.requireThat(source&&!source.done&&source.expiresAt>Date.now()&&(source.kind!=='bulkUse'||source.version===f.sourceVersion&&source.quantity===x.quantity),'攻击步骤已经失效。');if(source.kind==='aoe')C.requireThat(source.fingerprint===require('./aoe').fingerprint(s,b),'战场已变化，请返回重新预览范围。');}
 const context={id:'action:'+f.id,actorId:a.id,turnId:f.turnId,action:f.action,rp,roundNumber:b.current?.roundNumber,apCost:b.current?.apCost,free:b.current?.free};b.operationContext=context;let result;
 try{switch(f.action){
  case 'attack':result=B.attack(s,b,f.turnId,x.abilityKey,x.targetId,x.action, rng,x.firing||{});break;
  case 'move':if(x.movementFingerprint)C.requireThat(x.movementFingerprint===require('./movement-panel').fingerprint(s,b,a),'移动状态已变化，请重新预览。');if(x.targetPosition){const t=B.actorById(b,x.targetId);C.requireThat(!t.deathId&&!t.retreated&&B.actorCharacter(s,t).id===x.targetCharacterId&&t.x===x.targetPosition.x&&t.y===x.targetPosition.y,'敌人位置或角色已变化，请重新预览。');}B.move(s,b,f.turnId,x.x,x.y);break;
  case 'reload':B.reload(s,b,f.turnId,x.ammoId,x.magazineId,x.weaponId);break;
  case 'ammo':C.requireThat((p.ammoVersion||0)===x.ammoVersion,'弹药已经变化，请重新选择。');result=require('./ammunition').battleOperation(s,b,f.turnId,x.operation);break;
  case 'switch':B.switchWeapon(s,b,f.turnId,x.weaponId,x.hand);break;
  case 'item':if(x.recipientId)C.requireThat(B.actorCharacter(s,B.actorById(b,x.recipientId)).id===x.recipientCharacterId,'治疗目标角色已变化。');result=B.useItem(s,b,f.turnId,x.itemId,rng,x.targetId,x.recipientId,x.quantity||1);break;
  case 'cast':B.confirmCasting(s,b,f.turnId);break;
  case 'pass':B.pass(s,b,f.turnId,x.type,rng);break;
  case 'finish':B.finish(s,b,f.turnId,rng);break;
  case 'flee':B.flee(s,b,f.turnId,rng);break;
  case 'defend':result=B.defend(s,b,x.hitId,x.choice,rng);break;
 }
 if(f.action!=='attack'&&f.action!=='defend')B.nextOpportunity(s,b,rng);
 }finally{delete b.operationContext;}
 if(f.sourceFormId)s.forms[f.sourceFormId].done=true;f.status='done';f.done=true;f.completedAt=Date.now();f.result={battleId:b.id,actorId:a.id,action:f.action,result:C.clone(result??null)};return C.clone(f.result);
}
function view(s,id,uid){const f=owned(s,id,uid),b=s.battles[f.battleId],a=B.actorById(b,f.actorId),x=f.params;
 const summary=f.action==='attack'?(B.abilities(B.actorCharacter(s,a)).find(t=>t.key===x.abilityKey)?.attack.name||'攻击')+' → '+(x.firing?.aoe?'范围名单 '+x.firing.aoe.targets.map(id=>B.actorById(b,id).name).join('、'):B.actorById(b,x.targetId).name)+(x.firing?.mode==='auto'?' · '+x.firing.count+'发':''):f.action==='move'?(x.note||'移动至 '+require('./movement-panel').cellName(Math.floor(x.x/50),Math.floor(x.y/50)))+' · 距离 '+(x.distance??C.round2(Math.hypot(x.x-a.x,x.y-a.y)))+'米 · 消耗 '+B.movementCost(b,a,x)+'米 · 剩余 '+C.round2((b.current?.move||0)-B.movementCost(b,a,x))+'米':f.action==='defend'?({defend:'纯防御',dodge:'闪避',both:'同时防守',none:'放弃防守'}[x.choice]):f.action==='item'?(B.actorCharacter(s,a).inventory[x.itemId]?.snapshot.name||'道具')+' ×'+(x.quantity||1)+'（消耗 '+(x.quantity||1)+' 次快速行动） → '+(x.recipientId?B.actorById(b,x.recipientId).name:a.name):labels[f.action];
 const turn=b.current?.actorId===a.id?b.current:null;
 const v=U.payload('确认行动 · '+a.name,'**'+summary+'**\n'+(f.action==='defend'?'免费防守反应 · 不延长原防守时限':turn?'本行动机会'+(turn.free?'免费': '已扣 '+(turn.apCost??100)+' AP')+'；提交才消耗本次操作预算。':'行动机会已变化')+'\n\n可直接执行，或填写RP后执行。RP随公开操作卡发布，不影响判定。\n截止 <t:'+Math.floor(f.expiresAt/1000)+':R>',[U.row(U.button('act:do:'+id,'直接执行',U.D.ButtonStyle.Success,f.status!=='ready'),U.button('act:rp:'+id,'RP 并行动',U.D.ButtonStyle.Primary,f.status!=='ready'),U.button('act:cancel:'+id,'返回修改'))],0xb69568);
 v.rpgPanel={kind:'battle',battleId:b.id,actorId:a.id,tab:f.action==='move'?'move':'overview'};if(f.action==='move')v.rpgMap={kind:'battle',state:s,b,movement:{actorId:a.id,cells:[],selected:x}};return v;
}
function createPanel({snapshot,tx,store,canActor,publishBattle}){
 async function prepare(i,data){const f=await tx(i,s=>{const b=s.battles[data.battleId];canActor(s,b,data.actorId,i.member,i.user.id);return create(s,i.user.id,data);},'准备战斗行动');return view(snapshot(i.guildId),f.id,i.user.id);}
 async function openModal(i,s){if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:act:rp:'))return false;const id=i.customId.split(':')[3],f=owned(s,id,i.user.id);C.requireThat(f.status==='ready'&&f.expiresAt>Date.now(),'行动草稿已失效。');await i.showModal(U.modal('act:submit:'+id,'RP 并行动 · 随公开操作卡发布',[{key:'rp',label:'角色叙述（选填，不影响结果）',long:true,max:1000,required:false}]));return true;}
 async function component(i,member){const [,,action,id]=i.customId.split(':'),f=owned(snapshot(i.guildId),id,i.user.id);
  if(action==='cancel'){await tx(i,s=>{const live=owned(s,id,i.user.id);if(live.status==='ready')live.status='cancelled';},'取消行动草稿');const s=snapshot(i.guildId),b=s.battles[f.battleId],a=B.actorById(b,f.actorId);return U.personalView(s,b,a,i.user.id);}
  C.requireThat(['do','submit'].includes(action),'行动入口已失效。');
  i.rpgOperation='action:'+id;const result=await store.transact(i.guildId,i.rpgOperation,i.user.id,s=>{const f=owned(s,id,i.user.id);canActor(s,s.battles[f.battleId],f.actorId,member,i.user.id);return execute(s,id,i.user.id,action==='submit'?i.fields.getTextInputValue('rp'):'');},'战斗行动与RP');if(!store.backgroundPublications)await publishBattle(i.guildId,result.battleId);
  const s=snapshot(i.guildId),b=s.battles[result.battleId],a=B.actorById(b,result.actorId),v=U.personalView(s,b,a,i.user.id);v.content='✅ '+(result.action==='attack'?(result.result?.casting?'已开始吟唱。':'攻击已成立，结果已保存，等待防守。'):result.action==='defend'?'防守已结算 · 实际伤害 '+result.result.total+' · HP '+result.result.hp:labels[result.action]+'已保存。');return v;
 }
 return {prepare,openModal,component};
}
module.exports={create,execute,owned,view,createPanel,labels};
