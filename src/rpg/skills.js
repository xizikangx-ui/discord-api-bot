'use strict';
const C=require('./constants'),M=require('./model'),U=require('./ui');
const {requireThat:ok,clone}=C;
function publish(state,raw,existingId){
  const t=M.validateTemplate({...state,catalog:{...state.catalog,...state.skillTemplates}}, {...raw,kind:'技能',melee:false,weaponType:'',rarity:'white',weightKg:0,value:0,boxes:[],traitIds:[],effects:[]});
  t.id=existingId||C.id('s');t.version=(state.skillTemplates?.[t.id]?.version||0)+1;t.published=true;t.requiresWeapon=!!raw.requiresWeapon;
  state.skillTemplates||={};state.skillTemplates[t.id]=t;return t;
}
function grant(p,t,key){ok(t?.published&&t.kind==='技能','技能未发布。');p.learnedSkills||={};
  const old=Object.values(p.learnedSkills).find(x=>x.templateId===t.id);if(old)return old;
  const entry={id:key||C.id('s'),templateId:t.id,version:t.version,snapshot:clone(t)};p.learnedSkills[entry.id]=entry;return entry;
}
function migrate(state){if(state.tacticalVersion===1)return null;
  state.skillTemplates||={};let templates=0,learned=0,cancelled=0;
  for(const [ref,t]of Object.entries(state.catalog))if(t.kind==='技能'){const skill={...clone(t),requiresWeapon:t.requiresWeapon??true,weight:0,value:0,boxes:[]};state.skillTemplates[ref]=skill;delete state.catalog[ref];templates++;}
  const convert=p=>{if(!p)return;p.learnedSkills||={};for(const [ref,item]of Object.entries(p.inventory||{}))if(item.snapshot.kind==='技能'){const skill={...clone(item.snapshot),requiresWeapon:item.snapshot.requiresWeapon??true};const entry=grant(p,skill,ref);p.skillAliases||={};p.skillAliases[ref]=entry.id;delete p.inventory[ref];learned++;}
    for(const item of Object.values(p.inventory||{}))for(const skill of item.snapshot.skills||[])skill.requiresWeapon??=true;};
  const oldItemIds=new Set(Object.values(state.players).flatMap(p=>Object.entries(p.inventory||{}).filter(([,i])=>i.snapshot.kind==='技能').map(([id])=>id)));
  const containsSkill=o=>{const walk=x=>!!x&&typeof x==='object'&&(x.snapshot?.kind==='技能'||x.kind==='技能'||Object.entries(x).some(([k,v])=>['templateId','itemId','id'].includes(k)&&typeof v==='string'&&(state.skillTemplates[v]||oldItemIds.has(v))||typeof v==='object'&&walk(v)));return walk(o);};
  for(const o of Object.values(state.offers))if(['editing','ready'].includes(o.status)&&containsSkill(o)){o.status='cancelled';o.reason='战斗技能转为独立能力';cancelled++;}
  for(const p of Object.values(state.players))convert(p);
  for(const t of Object.values(state.npcTemplates)){t.skillSnapshots||=[];for(const e of t.loadout||[])if(e.template.kind==='技能'&&!t.skillSnapshots.some(s=>s.id===e.template.id))t.skillSnapshots.push({...clone(e.template),requiresWeapon:e.template.requiresWeapon??true});
    for(const ref of t.itemIds||[])if(state.skillTemplates[ref]&&!t.skillSnapshots.some(s=>s.id===ref))t.skillSnapshots.push(clone(state.skillTemplates[ref]));
    t.itemIds=(t.itemIds||[]).filter(ref=>!state.skillTemplates[ref]);if(t.loadout)t.loadout=t.loadout.filter(e=>e.template.kind!=='技能');t.skillIds=(t.skillSnapshots||[]).map(s=>s.id);}
  for(const b of Object.values(state.battles)){for(const a of b.actors){convert(a.character);convert(a.finalCharacter);const p=a.finalCharacter||(a.userId?state.players[a.userId]:a.character);if(a.casting&&p?.skillAliases?.[a.casting.key])a.casting.key=p.skillAliases[a.casting.key];}if(b.pending?.kind==='aoe')continue;}
  for(const m of Object.values(state.explorations))m.mapType||='indoor';
  for(const f of Object.values(state.forms))if(f.kind==='item'&&f.data.kind==='技能'){f.kind='skill';f.data.requiresWeapon??=true;}
  state.tacticalVersion=1;return {templates,learned,cancelled};
}
function createSkills({snapshot,tx,needGM,pickView}){
  function view(s,p,uid,page=0){const entries=Object.values(p.learnedSkills||{});page=Math.max(0,Math.min(Number(page)||0,Math.max(0,Math.ceil(entries.length/10)-1)));
    return U.payload('战斗技能 · '+p.name,entries.slice(page*10,page*10+10).map(e=>'**'+e.snapshot.name+'** · v'+e.version+'\n'+e.snapshot.description.slice(0,160)+'\n命中 '+e.snapshot.hit+' · 射程 '+e.snapshot.rangeMeters+'米 · '+(e.snapshot.action==='quick'?'快速':'正式')+' · '+(e.snapshot.requiresWeapon?'要求可用武器':'无需武器')).join('\n\n')||'尚未学习战斗技能。',[U.row(U.button('skill:mine:'+uid+':'+(page-1),'上一页',undefined,!page),U.button('skill:mine:'+uid+':'+(page+1),'下一页',undefined,(page+1)*10>=entries.length))]);}
  function manage(s){return U.payload('GM独立战斗技能','技能不放进背包，不计重量，不参与交易或掉落。',[U.row(U.button('skill:new','录入技能',U.D.ButtonStyle.Primary),U.button('catalog:战斗技能:0','技能库'),U.button('skill:chooseuser','授予 / 移除技能'))]);}
  function userPick(){return U.payload('选择技能目标','请选择有效角色。',[U.row(new U.D.UserSelectMenuBuilder().setCustomId('rpg:skill:user').setPlaceholder('目标玩家').setMinValues(1).setMaxValues(1)),U.row(U.button('skill:home','返回技能管理'))]);}
  function choice(s,uid,action,page=0){const p=M.player(s,uid),entries=action==='grant'?Object.values(s.skillTemplates||{}).filter(t=>t.published):Object.values(p.learnedSkills||{}).map(e=>({...e.snapshot,id:e.id}));
    const v=pickView((action==='grant'?'授予':'移除')+'战斗技能 · '+p.name,entries.map(e=>({label:e.name,value:e.id})),'skill:pick:'+uid+':'+p.id+':'+action,page);v.components.push(U.row(U.button('skill:target:'+uid,'返回目标')));return v;}
  async function slash(i,member){const s=snapshot(i.guildId);if(i.commandName==='技能')return view(s,M.player(s,i.user.id),i.user.id);needGM(s,member);return manage(s);}
  async function component(i,member){const [,,action,...args]=i.customId.split(':'),s=snapshot(i.guildId),uid=i.user.id;
    if(action==='mine'){ok(args[0]===uid,'只能打开自己的技能。');return view(s,M.player(s,uid),uid,args[1]);}needGM(s,member);
    if(action==='home')return manage(s);if(action==='chooseuser')return userPick();
    if(action==='new'){const f=await tx(i,st=>{needGM(st,member);return require('./forms').create(st,uid,'skill');},'录入战斗技能');return require('./forms').view(snapshot(i.guildId),f);}
    if(action==='user'||action==='target'){const target=action==='user'?i.values[0]:args[0],p=M.player(s,target);return U.payload('技能操作 · '+p.name,'每个技能只授予一次，移除不影响鉴定技能。',[U.row(U.button('skill:list:'+target+':grant:0','授予技能'),U.button('skill:list:'+target+':remove:0','移除技能'),U.button('skill:chooseuser','返回成员'))]);}
    if(action==='list')return choice(s,args[0],args[1],Number(args[2]));
    if(action==='pick'&&args[3]!=='select')return choice(s,args[0],args[2],Number(args[3]));
    if(action==='pick'){await tx(i,st=>{needGM(st,member);const p=M.player(st,args[0]);ok(p.id===args[1],'角色已变化。');ok(M.battleFor(st,args[0])?.status!=='active','战斗中请先暂停。');if(args[2]==='grant')return grant(p,st.skillTemplates[i.values[0]]);ok(p.learnedSkills?.[i.values[0]],'该技能已经移除。');delete p.learnedSkills[i.values[0]];return true;},'GM调整战斗技能');return choice(snapshot(i.guildId),args[0],args[2]);}
    throw Error('技能操作已失效。');
  }
  return {slash,component,manage,view};
}
module.exports={publish,grant,migrate,createSkills};
