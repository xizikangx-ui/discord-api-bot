'use strict';
const C=require('./constants');
const RESTRICTIONS={formal:'禁止正式行动',active:'禁止主动行动',spell:'禁止魔法及精神技能',weapon:'禁止武器操作',move:'禁止移动',flee:'禁止撤退'};
function stages(p){return(p.conditions||[]).map(c=>({name:c.template?.name||'异常',...c.template?.levels?.[c.severity]}));}
function movement(p){return Math.min(1,...stages(p).map(s=>s.restrictions?.includes('move')?0:s.movementMultiplier??1));}
function spell(t){return t?.kind==='技能'&&(['magical','mental'].includes(t.primary)||['magical','mental'].some(k=>t.damage?.[k]&&t.damage[k]!=='0'));}
function reason(p,action,t,group){
 if(['finish','pass','defend','view'].includes(action))return '';
 for(const s of stages(p)){const r=s.restrictions||[];
  if(r.includes('active')||r.includes('formal')&&(group==='formal'||action==='flee')||r.includes('spell')&&spell(t)||r.includes('weapon')&&(['reload','ammo','extract','fill','swap','switch'].includes(action)||['attack','cast'].includes(action)&&(t?.kind!=='技能'||t.requiresWeapon))||r.includes('move')&&action==='move'||r.includes('flee')&&action==='flee')return s.name+'：'+(r.includes('active')?'当前不能主动行动。':'该操作受到异常限制。');
 }return '';
}
function requireAction(p,action,t,group){C.requireThat(!reason(p,action,t,group),reason(p,action,t,group));}
function interrupt(s,p){if(!s)return;const B=require('./combat');for(const b of Object.values(s.battles||{}))for(const a of b.actors){if(!a.casting||a.deathId)continue;let character;try{character=B.actorCharacter(s,a);}catch{continue;}if(character.id!==p.id)continue;const t=B.abilities(p,true).find(e=>e.key===a.casting.key)?.attack||{kind:'技能',primary:a.casting.presentation?.primary};if(reason(p,'cast',t,'quick')){B.record(b,a.name+'的吟唱被异常打断。',{actorId:a.id,eventType:'condition',ability:a.casting.name});delete a.casting;}}}
function templates(){const out=[];const level=(severity,extra={},count=3)=>({difficulty:{'一般':10,'严重':14,'致命':18}[severity],duration:count?{kind:'actions',count}:{kind:'until'},worsenAfter:0,description:'',effects:[],restrictions:[],...extra});
 const add=(key,name,type,levels)=>out.push({id:'core_condition_'+key,name,type,effectType:'numeric',description:'基础异常，可由GM修改。',version:1,published:true,levels,seedPackage:'conditions-v1'});
 for(const [key,name]of [['bleeding','流血'],['poison','中毒'],['burning','燃烧'],['disease','疫病']])add(key,name,'physical',Object.fromEntries(C.SEVERITIES.map((severity,n)=>[severity,level(severity,{effects:[{target:'hp',amount:['1d4','1d6','1d10'][n]}],description:'每次自身行动机会开始损失'+['1d4','1d6','1d10'][n]+' HP。'})])));
 add('stun','眩晕','mental',{'一般':level('一般',{restrictions:['formal'],description:'禁止正式行动。'},1),'严重':level('严重',{restrictions:['active'],description:'禁止主动行动，仍可结束机会及免费防守。'},1)});
 add('silence','沉默','magical',{'严重':level('严重',{restrictions:['spell'],description:'禁止魔法、精神及混合技能。'})});
 add('slow','迟滞','physical',{'一般':level('一般',{movementMultiplier:.5,description:'移动预算减半。'}),'严重':level('严重',{restrictions:['move'],movementMultiplier:0,description:'移动预算归零。'})});
 add('arms','肢体破坏·上肢','physical',{'致命':level('致命',{restrictions:['weapon'],description:'禁止武器攻击、需武器技能、装填和切换。'},0)});
 add('legs','肢体破坏·下肢','physical',{'致命':level('致命',{restrictions:['move','flee'],movementMultiplier:0,description:'禁止移动和撤退。'},0)});return out;
}
function install(s){if(s.conditionPackVersion===1)return null;s.conditionTemplates||={};let added=0;for(const t of templates())if(!s.conditionTemplates[t.id]){s.conditionTemplates[t.id]=t;added++;}s.conditionPackVersion=1;return{conditionsAdded:added};}
module.exports={RESTRICTIONS,stages,movement,spell,reason,requireAction,interrupt,templates,install};
