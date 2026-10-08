'use strict';
const C=require('./constants'),M=require('./model');
function validate(raw={}){const v={mode:raw.mode||'single',radius:C.number(raw.radius||0,'AOE半径',0,500000,false),allowAlly:!!raw.allowAlly,allowSelf:!!raw.allowSelf};C.requireThat(['single','selective','all'].includes(v.mode),'范围模式无效。');if(v.mode!=='single')C.requireThat(v.radius>0,'AOE半径必须大于0。');return v;}
function preview(state,b,actor,ability,center,chosen){
  const B=require('./combat'),cfg=validate(ability.aoe);C.requireThat(cfg.mode!=='single','这项攻击是单体。');
  center={x:C.round2(C.number(center?.x,'中心横向米数',0,b.width*50-.01,false)),y:C.round2(C.number(center?.y,'中心纵向米数',0,b.height*50-.01,false))};
  const p=B.actorCharacter(state,actor),range=Math.max(0,M.modify(M.stats(p).effects,'range',ability.rangeMeters??(ability.range||0)*50));
  C.requireThat(ability.melee?Math.floor(actor.x/50)===Math.floor(center.x/50)&&Math.floor(actor.y/50)===Math.floor(center.y/50):Math.hypot(actor.x-center.x,actor.y-center.y)<=range+.000001,'AOE中心超出有效射程。');
  const inCircle=B.liveActors(state,b).filter(a=>Math.hypot(a.x-center.x,a.y-center.y)<=cfg.radius+.000001);
  const eligible=inCircle.filter(a=>cfg.mode==='all'||(a.id===actor.id?cfg.allowSelf:a.team===actor.team?cfg.allowAlly:true));
  if(chosen)C.requireThat(chosen.length&&new Set(chosen).size===chosen.length&&chosen.every(ref=>eligible.some(a=>a.id===ref)),'AOE名单已变化或包含不可选目标，请重新预览。');
  const targets=cfg.mode==='all'?eligible:chosen?eligible.filter(a=>chosen.includes(a.id)):eligible;
  return {center,radius:cfg.radius,mode:cfg.mode,targets:targets.map(a=>a.id),eligible:eligible.map(a=>a.id),friendly:targets.filter(a=>a.team===actor.team).map(a=>a.id)};
}
function hits(b){if(!b.pending)return [];return b.pending.kind==='aoe'?b.pending.hits.filter(h=>!h.result):[b.pending];}
function hit(b,id){return hits(b).find(h=>h.id===id);}
function fingerprint(state,b){const B=require('./combat');return JSON.stringify({status:b.status,current:b.current,pending:b.pending,actors:b.actors.map(a=>({id:a.id,character:B.actorCharacter(state,a),x:a.x,y:a.y,team:a.team,retreated:a.retreated,casting:a.casting}))});}
function createAoePanel({snapshot,tx,publishBattle,canActor,actionPanel}){
 const U=require('./ui'),B=require('./combat');
 function owned(s,ref,uid,member){const f=s.forms[ref];C.requireThat(f?.kind==='aoe'&&f.owner===uid&&!f.done&&f.expiresAt>Date.now(),'AOE步骤失效，请重新选择攻击。');const b=s.battles[f.battleId],a=canActor(s,b,f.actorId,member,uid);C.requireThat(B.current(s,b,f.turnId).actor.id===a.id&&!b.pending,'行动状态已变化。');const ability=B.abilities(B.actorCharacter(s,a)).find(e=>e.key===f.abilityKey);C.requireThat(ability,'技能或武器已不可用。');return {f,b,a,t:ability.attack};}
 async function open(i,s,b,a,key,action,mode='semi'){const f=await tx(i,st=>{const live=st.battles[b.id];C.requireThat(live.current?.actorId===a.id&&!live.pending,'行动已变化。');const f={id:C.id('f'),kind:'aoe',owner:i.user.id,battleId:b.id,actorId:a.id,turnId:b.current.id,abilityKey:key,action,mode,count:mode==='auto'?3:1,targets:[],version:0,expiresAt:C.confirmationDeadline(600000)};st.forms[f.id]=f;return f;},'准备范围攻击');return view(snapshot(i.guildId),f.id,i.user.id,i.member);}
 function view(s,ref,uid,member,stage='center'){const {f,b,a,t}=owned(s,ref,uid,member),cfg=validate(t.aoe),base='aoe:'+ref+':',v=f.version;
   const components=[],actors=B.liveActors(s,b);
   if(stage==='center')components.push(U.row(U.select(base+'center:'+v,'选择范围中心目标',actors.map(e=>({label:e.name,value:e.id})))));
   let body='**'+t.name+'** · '+(cfg.mode==='all'?'无差别AOE · 包含自身及友军':'选择性AOE')+' · 半径 **'+cfg.radius+'米**\n';
   if(f.center){const previewData=preview(s,b,a,t,f.center);body+='中心 ('+f.center.x+', '+f.center.y+')米\n';
     if(cfg.mode==='selective'&&previewData.eligible.length&&stage!=='confirm')components.push(U.row(U.select(base+'targets:'+v,'多选范围内目标',previewData.eligible.map(id=>({label:B.actorById(b,id).name,value:id,default:f.targets.includes(id)})),1,previewData.eligible.length)));
     const targets=cfg.mode==='all'?previewData.targets:f.targets;body+='波及名单：'+(targets.map(id=>B.actorById(b,id).name).join('、')||'尚未选取')+'\n'+(targets.some(id=>B.actorById(b,id).team===a.team)?'⚠️ 本次会波及友军或施放者。\n':'');
     if(stage==='confirm')components.push(U.row(U.button(base+'commit:'+v,'确认释放',U.D.ButtonStyle.Danger),U.button(base+'back:'+v,'返回修改')));
     else components.push(U.row(U.button(base+'preview:'+v,'预览并核对',U.D.ButtonStyle.Primary),U.button(base+'coordinates:'+v,'输入中心坐标')));
   }else components.push(U.row(U.button(base+'coordinates:'+v,'输入中心坐标')));
   if(f.mode==='auto'){body+='全自动 '+f.count+' 发（一次扣行动）\n';if(stage!=='confirm')components.push(U.row(U.button(base+'count:'+v,'修改连射发数')));}
   components.push(U.row(U.button('view:'+b.id+':'+a.id+':'+uid+':'+f.turnId+':overview','取消选择')));
   const out=U.payload(stage==='confirm'?'范围攻击最终确认':'范围攻击 · '+stage,body,components,0xe78a40);
   out.rpgMap={kind:'battle',state:s,b,overlay:f.center?{...preview(s,b,a,t,f.center),targets:cfg.mode==='all'?preview(s,b,a,t,f.center).targets:f.targets}:null,zoom:true};return out;
 }
 async function openModal(i,s){if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:aoe:'))return false;const [,,ref,action,version]=i.customId.split(':');if(!['coordinates','count'].includes(action))return false;const {f}=owned(s,ref,i.user.id,i.member);C.requireThat(f.version===Number(version),'步骤已更新。');await i.showModal(U.modal('aoe:'+ref+':'+action+'submit:'+version,action==='count'?'连射发数':'AOE中心（米）',action==='count'?[{key:'count',label:'连射发数',value:f.count}]:[{key:'x',label:'横向米数',value:f.center?.x||0},{key:'y',label:'纵向米数',value:f.center?.y||0}]));return true;}
 async function component(i,member){const [,,ref,action,version]=i.customId.split(':'),s=snapshot(i.guildId),uid=i.user.id;const {f,b}=owned(s,ref,uid,member);C.requireThat(f.version===Number(version),'面板步骤已更新，请重新打开。');
   if(action==='commit'){const area=preview(s,b,B.actorById(b,f.actorId),B.abilities(B.actorCharacter(s,B.actorById(b,f.actorId))).find(t=>t.key===f.abilityKey).attack,f.center,validate(B.abilities(B.actorCharacter(s,B.actorById(b,f.actorId))).find(t=>t.key===f.abilityKey).attack.aoe).mode==='selective'?f.targets:undefined);return actionPanel.prepare(i,{battleId:b.id,actorId:f.actorId,turnId:f.turnId,action:'attack',sourceFormId:f.id,params:{abilityKey:f.abilityKey,targetId:area.targets[0],action:f.action,firing:{mode:f.mode,count:f.count,aoe:area}}});}
   await tx(i,st=>{const {f,b,a,t}=owned(st,ref,uid,member);C.requireThat(f.version===Number(version),'旧步骤不能重复执行。');
     if(action==='center'){const target=B.actorById(b,i.values[0]);f.center={x:target.x,y:target.y};f.targets=[];preview(st,b,a,t,f.center);}
     else if(action==='coordinatessubmit'){f.center={x:Number(i.fields.getTextInputValue('x')),y:Number(i.fields.getTextInputValue('y'))};preview(st,b,a,t,f.center);f.targets=[];}
     else if(action==='countsubmit')f.count=C.number(i.fields.getTextInputValue('count'),'连射发数',1,10000);
     else if(action==='targets'){preview(st,b,a,t,f.center,i.values);f.targets=[...i.values];}
     else if(action==='preview'){const p=preview(st,b,a,t,f.center,validate(t.aoe).mode==='selective'?f.targets:undefined);C.requireThat(p.targets.length,'请选择目标。');f.fingerprint=fingerprint(st,b);}
     else C.requireThat(action==='back','范围操作已失效。');f.version++;
   },'范围攻击选择');return view(snapshot(i.guildId),ref,uid,member,action==='preview'?'confirm':'center');
 }
 return {open,component,openModal,view};
}
module.exports={validate,preview,hits,hit,fingerprint,createAoePanel};
