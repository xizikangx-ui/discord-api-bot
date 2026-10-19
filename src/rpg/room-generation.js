'use strict';
// The quota is attached only to newly built random layouts. Existing room
// instances are immutable here: editing or reading a map never rerolls them.
const C=require('./constants'),K=require('./containers'),Strength=require('./npc-strength');
const GRADES=['white','green','blue','purple','gold','red'];
function ordinary(m,c){return m.mode==='random'&&!['entrance','stairs','corridor','road','wall'].includes(c.type)&&c.passable!==false&&!c.templateId&&!c.variantId&&!c.room?.boss&&!c.room?.merchant;}
function count(total,percent){const n=Math.round(total*percent/100);return percent<100?Math.min(n,Math.max(0,total-1)):n;}
function legalNpcs(state,t,maxRank){
 const entries=[...(t.npcs||[]).filter(e=>e.quantity>0),...(t.randomNpcs||[]).filter(e=>e.probabilities?.slice(1).some(p=>p>0))],seen=new Set();
 return entries.filter(e=>e.template?.published!==false&&state.npcTemplates[e.template?.id]?.published&&Strength.allowed(e.template,maxRank)&&!seen.has(e.template.id)&&seen.add(e.template.id)).map(e=>C.clone(e.template));
}
function candidates(state,categoryId){
 const X=require('./exploration'),V=require('./room-variants'),groups=[];
 for(const t of Object.values(state.roomTemplates||{}).filter(t=>t.published&&!t.manualOnly&&t.categoryIds?.includes(categoryId))){
  const variants=t.variants?.length?t.variants.filter(v=>v.enabled!==false&&v.weight>0):[null],entries=[];
  for(const v of variants){
   const raw=v?V.merge(t,v):C.clone(t);
   raw.categoryIds=(raw.categoryIds||[]).filter(id=>state.mapCategories[id]?.published);
   raw.supplyIds=(raw.supplyIds||[]).filter(id=>state.catalog[id]?.published);
   raw.npcIds=(raw.npcIds||[]).filter(id=>state.npcTemplates[id]?.published);
   raw.randomSupplies=(raw.randomSupplies||[]).filter(e=>state.catalog[e.ref]?.published);
   raw.randomNpcs=(raw.randomNpcs||[]).filter(e=>state.npcTemplates[e.ref]?.published);
   entries.push({template:X.validateRoom(state,raw,true),weight:v?.weight||1});
  }
  if(entries.length)groups.push(entries);
 }
 return groups;
}
function containerFallback(state,groups){
 const configured=[...new Set(groups.flat().flatMap(({template:t})=>[...(t.boxes||[]),...(t.randomContainers||[]).map(e=>e.ref)]))];
 const pool=(configured.length?configured:['纸箱']).filter(name=>K.ALL.includes(name)&&K.get(state,name)?.enabled!==false);
 C.requireThat(pool.length,configured.length?'该主题的容器候选已全部停用，请先启用至少一种容器。':'通用白色容器“纸箱”已停用，请先启用或配置主题容器。');
 return pool.sort((a,b)=>GRADES.indexOf(K.get(state,a).grade)-GRADES.indexOf(K.get(state,b).grade)||a.localeCompare(b,'zh-CN'))[0];
}
function fallbackFor(state,template){
 const groups=[[{template}]],categories=new Set(template.categoryIds||[]),V=require('./room-variants');
 for(const t of Object.values(state.roomTemplates||{}))if(t.published&&!t.manualOnly&&t.id!==template.id&&t.categoryIds?.some(id=>categories.has(id))){
  const variants=t.variants?.length?t.variants.filter(v=>v.enabled!==false&&v.weight>0):[null];
  groups.push(variants.map(v=>({template:v?V.merge(t,v):t})));
 }
 return containerFallback(state,groups);
}
function pick(groups,rng){
 const entries=groups[rng(0,groups.length)],total=entries.reduce((n,e)=>n+e.weight,0);let ticket=rng(0,total);
 for(const e of entries){ticket-=e.weight;if(ticket<0)return e.template;}
 throw Error('房间变种权重无效。');
}
function plan(state,m){
 const percent=m.generation?.combatPercent;
 if(m.mode!=='random'||percent===undefined)return null;
 C.number(percent,'普通内容房战斗比例',0,100);
 const cells=Object.entries(m.cells).filter(([,c])=>(c.type==='room'||c.hasContents)&&ordinary(m,c)),missing=cells.filter(([,c])=>!c.room),cache=new Map(),maxRank=m.maxRank??10;
 for(const [,c] of missing)if(!cache.has(c.categoryId)){
  const groups=candidates(state,c.categoryId);C.requireThat(groups.length,'主题“'+(state.mapCategories[c.categoryId]?.name||'未指定')+'”没有可生成的已发布房间。');
  const combat=groups.map(entries=>entries.filter(e=>legalNpcs(state,e.template,maxRank).length)).filter(entries=>entries.length);
  cache.set(c.categoryId,{groups,combat});
 }
 const target=count(cells.length,percent),existing=cells.filter(([,c])=>c.room&&(c.room.generation?.role==='battle'||(c.room.npcs||[]).some(e=>e.quantity>0))).length,needed=Math.max(0,Math.min(missing.length,target-existing));
 const eligible=missing.filter(([,c])=>cache.get(c.categoryId).combat.length);
 C.requireThat(eligible.length>=needed,'普通战斗房需要 '+needed+' 个可用地点，但当前主题在怪物等级上限内没有足够的已发布NPC候选；请调整主题、NPC或战斗比例。');
 // Check all eligible themes before any rooms or random results are created.
 if(m.generation?.containerPolicyVersion===2)for(const entry of cache.values())entry.fallback=containerFallback(state,entry.groups);
 else if(needed)for(const [,c]of eligible){const entry=cache.get(c.categoryId);entry.fallback??=containerFallback(state,entry.groups);}
 return {percent,target,needed,missing,eligible,cache,maxRank};
}
function generate(state,m,rng){
 const p=plan(state,m);if(!p)return null;
 const shuffled=require('./random-layout').shuffled,battles=new Set(shuffled(p.eligible.map(([ref])=>ref),rng).slice(0,p.needed)),result={};
 for(const [ref,c]of p.missing){const theme=p.cache.get(c.categoryId),role=battles.has(ref)?'battle':'safe',template=pick(role==='battle'?theme.combat:theme.groups,rng);
  const room=require('./exploration').instantiate(state,template,rng,p.maxRank,null,{role,npcs:legalNpcs(state,template,p.maxRank),fallback:theme.fallback,containerPolicyVersion:m.generation?.containerPolicyVersion});
  room.generation={policy:1,role,combatPercent:p.percent,...(m.generation?.containerPolicyVersion===2?{containerPolicyVersion:2}:{})};result[ref]=room;
 }
 return result;
}
module.exports={ordinary,count,legalNpcs,candidates,containerFallback,fallbackFor,plan,generate};
