'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants'), M = require('./model'), B = require('./combat'), W = require('./weapons'), AM=require('./ammunition');
const { requireThat: ok, clone } = C;
const DEFAULTS = { quick: { reload: 35, extract: 15, fill: 15, heal: 20, switch: 5, cast: 10 }, formal: { 'attack:*': 100 }, defense: { defend: 100, dodge: 0, both: 0, none: 0 } };
function config(raw = {}) { return { strategy:raw.strategy==='probability'?'probability':'smart', mode: raw.mode === 'auto' ? 'auto' : 'manual', target: ['random','nearest','lowest'].includes(raw.target) ? raw.target : 'nearest', weights: clone(raw.weights || DEFAULTS) }; }
function validate(raw) {
  const v = config(raw);
  for (const group of ['quick','formal','defense']) {
    const entries = Object.entries(v.weights[group] || {});
    ok(entries.length && entries.length <= 100, '每组须配置1—100种操作。');
    let total = 0;
    for (const [key, value] of entries) { ok(/^(attack:.+|reload|extract|fill|heal|switch|cast|move|pass|finish|defend|dodge|both|none)$/.test(key), '操作类型无效。');
      if (group === 'defense') ok(['defend','dodge','both','none'].includes(key), '防守操作无效。');
      else ok(!['defend','dodge','both','none'].includes(key), '行动操作无效。');
      total += C.number(value, '概率', 0, 100, false); }
    ok(Math.abs(total - 100) < 0.00001, group + '组概率总和必须为100%。');
  }
  return v;
}
function weight(a, group, op) {
  const w = config(a.ai).weights[group] || {};
  return Number(w[op.key] ?? (op.key.startsWith('attack:') ? w['attack:*'] : 0) ?? 0);
}
function draw(entries, rng = randomInt) {
  const sum = entries.reduce((s,e) => s + e.weight, 0); if (sum <= 0) return null;
  let n = rng(0, 1000000) / 1000000 * sum;
  for (const e of entries) { n -= e.weight; if (n < 0) return e; } return entries.at(-1);
}
function target(state, b, a, candidates, rng) {
  if (!candidates.length) return null; const strategy = config(a.ai).target;
  if (strategy === 'random') return candidates[rng(0,candidates.length)];
  const metric = t => strategy === 'lowest' ? B.actorCharacter(state,t).hp : Math.hypot(a.x-t.x,a.y-t.y);
  const min = Math.min(...candidates.map(metric)), ties = candidates.filter(t => Math.abs(metric(t)-min)<0.000001);
  return ties[rng(0,ties.length)];
}
// Find a safe first segment along a grid route; partial movement preserves the budget.
function approach(b, a, enemy, budget) {
  if (!enemy || budget <= .01) return null;
  const start = Math.floor(a.x/50)+','+Math.floor(a.y/50), end = Math.floor(enemy.x/50)+','+Math.floor(enemy.y/50);
  const dist = { [start]: 0 }, previous = {}, open = [start];
  while (open.length) {
    open.sort((x,y)=>dist[x]-dist[y]); const ref=open.shift(); if(ref===end)break;
    const [x,y]=ref.split(',').map(Number);
    for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
      const key=nx+','+ny, terrain=b.terrain[key]; if(nx<0||ny<0||nx>=b.width||ny>=b.height||terrain==='blocked')continue;
      const n=dist[ref]+(terrain==='difficult'?100:50); if(n<(dist[key]??Infinity)){dist[key]=n;previous[key]=ref;if(!open.includes(key))open.push(key);}
    }
  }
  if(start!==end && !previous[end])return null;
  let next=end; while(previous[next] && previous[next]!==start)next=previous[next];
  const [x,y]=next.split(',').map(Number), destination=start===end?enemy:{x:x*50+25,y:y*50+25};
  const dx=destination.x-a.x,dy=destination.y-a.y,len=Math.hypot(dx,dy);if(len<.01)return null;
  let fraction=1;
  for(let n=0;n<25;n++) {const to={x:C.round2(a.x+dx*fraction),y:C.round2(a.y+dy*fraction)};
    try {if(B.movementCost(b,a,to)<=budget && Math.hypot(to.x-a.x,to.y-a.y)>.01)return to;}catch{}
    fraction*=.75; }
  return null;
}
function execute(state,b,op,rng=randomInt) {
  const turn=b.current.id;
  if(op.type==='attack') return B.attack(state,b,turn,op.ability,op.target,op.group,rng,op.firing || {});
  if(['reload','extract','fill'].includes(op.type))return AM.battleOperation(state,b,turn,{...op,type:op.type==='reload'?'swap':op.type});
  if(op.type==='heal') return B.useItem(state,b,turn,op.item,rng);
  if(op.type==='switch') return B.switchWeapon(state,b,turn,op.item);
  if(op.type==='cast') return B.confirmCasting(state,b,turn);
  if(op.type==='move') return B.move(state,b,turn,op.x,op.y);
  if(op.type==='pass') {b.current[op.group]=0;return;}
  if(op.type==='finish') return B.finish(state,b,turn,rng);
  throw new Error('自动操作类型无效。');
}
function legal(state,b,op){try{B.validateOperation(state,b,op);return true;}catch{return false;}}
function options(state,b,a) {
  const p=B.actorCharacter(state,a), enemies=B.liveActors(state,b).filter(t=>t.team!==a.team), result=[];
  for(const group of ['quick','formal']) {
    if(!b.current[group])continue;
    for(const ability of B.abilities(p)) for(const enemy of enemies) {
      const op={type:'attack',key:'attack:'+(p.inventory[ability.key]?.templateId || ability.attack.id || ability.key),group,ability:ability.key,target:enemy.id,firing:C.FIREARMS.includes(ability.attack.weaponType)&&!(ability.attack.fireModes||['semi']).includes('semi')?{mode:'auto',count:Math.max(1,Math.min(3,p.inventory[ability.key]?.loaded?.current||0,require('./durability').current(p.inventory[ability.key])))}:{mode:'semi'}};
      if(require('./aoe').validate(ability.attack.aoe).mode!=='single'){try{const area=require('./aoe').preview(state,b,a,ability.attack,{x:enemy.x,y:enemy.y});if(area.mode==='selective')area.targets=area.targets.filter(id=>B.actorById(b,id).team!==a.team);op.firing.aoe=area;}catch{continue;}}
      if(legal(state,b,op))result.push(op);
    }
    result.push({type:'pass',key:'pass',group},{type:'finish',key:'finish',group});
  }
  if(b.current.quick) {
    AM.normalize(p);
    for(const weapon of W.equipped(p).filter(id=>AM.usesMagazine(p.inventory[id].snapshot))) {
      const w=p.inventory[weapon];
      if(w.magazineId&&w.loaded.current===0){const op={type:'extract',key:'extract',group:'quick',weapon};if(legal(state,b,op))result.push(op);}
      for(const m of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹夹'&&i.loaded.current>0&&w.loaded.current===0)){
        const op={type:'reload',key:'reload',group:'quick',weapon,magazine:m.id};if(legal(state,b,op))result.push(op);
      }
      for(const m of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹夹'&&!AM.attached(p,i.id)&&w.loaded.current===0&&AM.magazineCompatible(w.snapshot,i.snapshot)&&i.loaded.current<i.loaded.capacity))for(const ammo of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹药')){
        const op={type:'fill',key:'fill',group:'quick',weapon,magazine:m.id,ammo:ammo.id};if(AM.ammoCompatible(w.snapshot,ammo.snapshot)&&legal(state,b,op))result.push(op);
      }
    }
    for(const item of Object.values(p.inventory)) {
      if(C.CONSUMABLES.includes(item.snapshot.kind) && p.hp<M.stats(p).maxHP && mean(item.snapshot.heal)>0){const op={type:'heal',key:'heal',group:'quick',item:item.id};if(legal(state,b,op))result.push(op);}
      if(item.snapshot.kind==='武器'&&!W.equipped(p).includes(item.id)){const op={type:'switch',key:'switch',group:'quick',item:item.id};if(legal(state,b,op))result.push(op);}
    }
    const cast={type:'cast',key:'cast',group:'quick'};if(legal(state,b,cast))result.push(cast);
  }
  const nearest=enemies.sort((x,y)=>Math.hypot(a.x-x.x,a.y-x.y)-Math.hypot(a.x-y.x,a.y-y.y))[0];
  const to=!M.stats(p).overloaded && approach(b,a,nearest,b.current.move);
  if(to)for(const group of ['quick','formal'])if(b.current[group])result.push({type:'move',key:'move',group,...to});
  return result;
}
function mean(expr){if(!expr)return 0;const s=String(expr).replace(/\s/g,'').toLowerCase(),m=s.match(/^r?(\d*)d(\d+)([+-]\d+)?$/);return m?Number(m[1]||1)*(Number(m[2])+1)/2+Number(m[3]||0):Number(s)||0;}
function expected(state,b,a,op){const p=B.actorCharacter(state,a),ability=B.abilities(p).find(e=>e.key===op.ability)?.attack;if(!ability)return -1;
  if(ability.casting&&!a.casting?.confirmed)return -1;
  if(op.firing?.aoe){return op.firing.aoe.targets.reduce((sum,ref)=>sum+(B.actorById(b,ref).team===a.team?-1:1)*expected(state,b,a,{...op,target:ref,firing:{...op.firing,aoe:null}}),0);}
  const target=B.actorById(b,op.target),defense=M.stats(B.actorCharacter(state,target)).defenses;
  const count=op.firing?.mode==='auto'?op.firing.count:1,w=p.inventory[op.ability];let total=0;
  for(let n=0;n<count;n++){const ammo=w?.loaded?.rounds?.[n]||{},stats=M.stats(p,ammo.effects||[]);for(const type of Object.keys(C.DAMAGE_TYPES)){let damage=Math.max(0,mean(ability.damage[type])+mean(ammo.damage?.[type]));if(ability.melee&&type===ability.primary)damage+=stats.attributes.strength;damage=M.modify(stats.effects,'attack:'+type,damage);if(type!=='physical')damage*=1+stats.attributes.intelligence*.1;total+=Math.max(0,damage-defense[type]);}}
  return total;
}
function smart(state,b,a,candidates,rng){const p=B.actorCharacter(state,a),attacks=candidates.filter(o=>o.type==='attack'&&expected(state,b,a,o)>=0);
 if(attacks.length){const best=Math.max(...attacks.map(o=>expected(state,b,a,o))),ties=attacks.filter(o=>Math.abs(expected(state,b,a,o)-best)<.000001),chosen=draw(ties.map(op=>({op,weight:weight(a,op.group,op)})).filter(e=>e.weight>0),rng);let op=chosen?.op||ties[rng(0,ties.length)];const same=ties.filter(e=>e.ability===op.ability&&e.group===op.group),preferred=target(state,b,a,same.map(e=>B.actorById(b,e.target)),rng);op=same.find(e=>e.target===preferred.id)||op;return {...op,reason:'合法即时攻击中预期伤害最高：'+C.round2(best)+'（不掷真实骰子）'};}
 const casting=candidates.find(o=>o.type==='cast');if(casting)return {...casting,reason:'吟唱已完成，先确认释放'};
 const ammo=candidates.find(o=>o.type==='reload')||candidates.find(o=>o.type==='extract')||candidates.find(o=>o.type==='fill');if(ammo)return {...ammo,reason:'已装备武器缺弹，执行必要换弹链'};
 const enemies=B.liveActors(state,b).filter(t=>t.team!==a.team),nearest=target(state,b,a,enemies,rng),used=a.aiSwitched||[];
 const change=candidates.find(o=>{if(o.type!=='switch'||used.includes(o.item))return false;const w=p.inventory[o.item];return require('./durability').usable(w)&&(!AM.usesMagazine(w.snapshot)||w.loaded?.current>0)&&nearest&&(w.snapshot.melee?Math.floor(a.x/50)===Math.floor(nearest.x/50)&&Math.floor(a.y/50)===Math.floor(nearest.y/50):Math.hypot(a.x-nearest.x,a.y-nearest.y)<=M.modify(M.stats(p).effects,'range',w.snapshot.rangeMeters??w.snapshot.range*50));});
 if(change)return {...change,reason:'当前无法攻击，切换为可用且射程合适的武器'};
 const chant=candidates.find(o=>o.type==='attack'&&B.abilities(p).find(e=>e.key===o.ability)?.attack.casting&&!a.casting);if(chant)return {...chant,reason:'无瞬发攻击，开始配置的技能吟唱'};
 const heal=candidates.find(o=>o.type==='heal');if(heal)return {...heal,reason:'无合法攻击且生命不足，使用有恢复效果的道具'};
 const move=candidates.find(o=>o.type==='move');if(move)return {...move,reason:'没有射程内攻击，沿可通行路径接近敌人'};
 return {type:'finish',key:'finish',reason:'没有有效攻击、装填、移动或吟唱，结束机会'};
}
function due(state,b) {
  if(b.status!=='active')return false;
  const a=b.pending?require('./aoe').hits(b).map(h=>B.actorById(b,h.targetId)).find(a=>!a.userId&&!a.deathId&&config(a.ai).mode==='auto'):b.current&&B.actorById(b,b.current.actorId);
  return !!(a&&!a.userId&&!a.deathId&&config(a.ai).mode==='auto');
}
function step(state,b,rng=randomInt) {
  if(!due(state,b))return false;
  if(b.pending) {
    const hit=require('./aoe').hits(b).find(h=>{const a=B.actorById(b,h.targetId);return !a.userId&&!a.deathId&&config(a.ai).mode==='auto';}),a=B.actorById(b,hit.targetId), entries=Object.entries(config(a.ai).weights.defense).map(([key,weight])=>({key,weight}));
    B.defend(state,b,hit.id,draw(entries,rng)?.key || 'defend',rng); return true;
  }
  const a=B.actorById(b,b.current.actorId), token=b.current.id;
  if(a.aiTurn!==token){a.aiTurn=token;a.aiSteps=0;a.aiSwitched=[];}
  if(++a.aiSteps>64){b.status='paused';b.pauseReason='NPC自动操作超过64步，请GM检查配置。';B.record(b,b.pauseReason);return true;}
  const candidates=options(state,b,a), cfg=config(a.ai), group=b.current.quick?'quick':b.current.formal?'formal':null;
  let op;
  if(cfg.strategy==='probability'){
  let entries=candidates.filter(e=>e.group===group);
  // One probability per ability, regardless of the number of eligible targets.
  const grouped=new Map();for(const op of entries){const key=op.key;const list=grouped.get(key)||[];list.push(op);grouped.set(key,list);}
  const choices=[...grouped].map(([key,list])=>({key,list,weight:weight(a,group,{key})}));
  let selected=draw(choices.filter(e=>e.weight>0),rng);
  const needsAmmo=JSON.stringify(cfg.weights)===JSON.stringify(DEFAULTS)&&group==='quick'&&W.equipped(B.actorCharacter(state,a)).some(id=>AM.usesMagazine(B.actorCharacter(state,a).inventory[id].snapshot)&&!B.actorCharacter(state,a).inventory[id].loaded.current);
  if(needsAmmo){const required=entries.find(e=>e.type==='reload')||entries.find(e=>e.type==='extract')||entries.find(e=>e.type==='fill')||entries.find(e=>e.type==='switch'&&require('./durability').current(B.actorCharacter(state,a).inventory[e.item])>0&&(!AM.usesMagazine(B.actorCharacter(state,a).inventory[e.item].snapshot)||B.actorCharacter(state,a).inventory[e.item].loaded?.current>0));if(required)selected={key:required.key,list:[required]};}
  if(selected){
    const list=selected.list;
    if(selected.key.startsWith('attack:')){const t=target(state,b,a,list.map(o=>B.actorById(b,o.target)),rng);op=list.find(o=>o.target===t.id);}
    else op=list[rng(0,list.length)];
  } else if(JSON.stringify(cfg.weights)===JSON.stringify(DEFAULTS)) {
    op=entries.find(e=>e.type==='reload') || entries.find(e=>e.type==='extract') || entries.find(e=>e.type==='fill') || (candidates.some(e=>e.type==='attack')?null:candidates.find(e=>e.type==='move'));
  }
  }else op=smart(state,b,a,candidates,rng);
  if(!op && group)op={type:'pass',group,key:'pass'};
  if(!op)op={type:'finish',key:'finish'};
  a.aiDecision={at:Date.now(),turnId:token,operation:clone(op),reason:op.reason||'按GM概率抽取合法操作'};if(op.type==='switch')a.aiSwitched.push(op.item);
  execute(state,b,op,rng);if(b.pending)b.pending.automatic=true; b.aiSequence=(b.aiSequence||0)+1;
  B.record(b,'NPC自动操作：'+a.name+' · '+op.key,{sequence:b.aiSequence,turnId:token,operation:clone(op)});
  return true;
}
module.exports={DEFAULTS,config,validate,draw,approach,options,due,step,mean,expected,smart};
