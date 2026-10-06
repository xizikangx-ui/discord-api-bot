'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants'), M = require('./model'), B = require('./combat'), W = require('./weapons'), AM=require('./ammunition');
const { requireThat: ok, clone } = C;
const DEFAULTS = { quick: { reload: 35, extract: 15, fill: 15, heal: 20, switch: 5, cast: 10 }, formal: { 'attack:*': 100 }, defense: { defend: 100, dodge: 0, both: 0, none: 0 } };
function config(raw = {}) { return { mode: raw.mode === 'auto' ? 'auto' : 'manual', target: ['random','nearest','lowest'].includes(raw.target) ? raw.target : 'nearest', weights: clone(raw.weights || DEFAULTS) }; }
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
function legal(state,b,op) {try {const s={...state,players:clone(state.players),battles:{[b.id]:clone(b)},deaths:clone(state.deaths),corpses:clone(state.corpses),explorations:clone(state.explorations),offers:clone(state.offers)};execute(s,s.battles[b.id],op,(min)=>min);return true;}catch{return false;} }
function options(state,b,a) {
  const p=B.actorCharacter(state,a), enemies=B.liveActors(state,b).filter(t=>t.team!==a.team), result=[];
  for(const group of ['quick','formal']) {
    if(!b.current[group])continue;
    for(const ability of B.abilities(p)) for(const enemy of enemies) {
      const op={type:'attack',key:'attack:'+(p.inventory[ability.key]?.templateId || ability.attack.id || ability.key),group,ability:ability.key,target:enemy.id,firing:C.FIREARMS.includes(ability.attack.weaponType)&&!(ability.attack.fireModes||['semi']).includes('semi')?{mode:'auto',count:Math.max(1,Math.min(3,p.inventory[ability.key]?.loaded?.current||0,require('./durability').current(p.inventory[ability.key])))}:{mode:'semi'}};
      if(legal(state,b,op))result.push(op);
    }
    result.push({type:'pass',key:'pass',group},{type:'finish',key:'finish',group});
  }
  if(b.current.quick) {
    AM.normalize(p);
    for(const weapon of W.equipped(p).filter(id=>AM.usesMagazine(p.inventory[id].snapshot))) {
      const w=p.inventory[weapon];
      if(w.magazineId&&w.loaded.current===0){const op={type:'extract',key:'extract',group:'quick',weapon};if(legal(state,b,op))result.push(op);}
      for(const m of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹夹'&&i.loaded.current>0)){
        const op={type:'reload',key:'reload',group:'quick',weapon,magazine:m.id};if(legal(state,b,op))result.push(op);
      }
      for(const m of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹夹'&&!AM.attached(p,i.id)&&AM.magazineCompatible(w.snapshot,i.snapshot)&&i.loaded.current<i.loaded.capacity))for(const ammo of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹药')){
        const op={type:'fill',key:'fill',group:'quick',weapon,magazine:m.id,ammo:ammo.id};if(AM.ammoCompatible(w.snapshot,ammo.snapshot)&&legal(state,b,op))result.push(op);
      }
    }
    for(const item of Object.values(p.inventory)) {
      if(C.CONSUMABLES.includes(item.snapshot.kind) && p.hp<M.stats(p).maxHP){const op={type:'heal',key:'heal',group:'quick',item:item.id};if(legal(state,b,op))result.push(op);}
      if(item.snapshot.kind==='武器'&&!W.equipped(p).includes(item.id)){const op={type:'switch',key:'switch',group:'quick',item:item.id};if(legal(state,b,op))result.push(op);}
    }
    const cast={type:'cast',key:'cast',group:'quick'};if(legal(state,b,cast))result.push(cast);
  }
  const nearest=enemies.sort((x,y)=>Math.hypot(a.x-x.x,a.y-x.y)-Math.hypot(a.x-y.x,a.y-y.y))[0];
  const to=!M.stats(p).overloaded && approach(b,a,nearest,b.current.move);
  if(to)for(const group of ['quick','formal'])if(b.current[group])result.push({type:'move',key:'move',group,...to});
  return result;
}
function due(state,b) {
  if(b.status!=='active')return false;
  const a=b.pending?B.actorById(b,b.pending.targetId):b.current&&B.actorById(b,b.current.actorId);
  return !!(a&&!a.userId&&!a.deathId&&config(a.ai).mode==='auto');
}
function step(state,b,rng=randomInt) {
  if(!due(state,b))return false;
  if(b.pending) {
    const a=B.actorById(b,b.pending.targetId), entries=Object.entries(config(a.ai).weights.defense).map(([key,weight])=>({key,weight}));
    B.defend(state,b,b.pending.id,draw(entries,rng)?.key || 'defend',rng); return true;
  }
  const a=B.actorById(b,b.current.actorId), token=b.current.id;
  if(a.aiTurn!==token){a.aiTurn=token;a.aiSteps=0;}
  if(++a.aiSteps>64){b.status='paused';b.pauseReason='NPC自动操作超过64步，请GM检查配置。';B.record(b,b.pauseReason);return true;}
  const candidates=options(state,b,a), cfg=config(a.ai), group=b.current.quick?'quick':b.current.formal?'formal':null;
  let entries=candidates.filter(e=>e.group===group);
  // One probability per ability, regardless of the number of eligible targets.
  const grouped=new Map();for(const op of entries){const key=op.key;const list=grouped.get(key)||[];list.push(op);grouped.set(key,list);}
  const choices=[...grouped].map(([key,list])=>({key,list,weight:weight(a,group,{key})}));
  let selected=draw(choices.filter(e=>e.weight>0),rng), op;
  const needsAmmo=JSON.stringify(cfg.weights)===JSON.stringify(DEFAULTS)&&group==='quick'&&W.equipped(B.actorCharacter(state,a)).some(id=>AM.usesMagazine(B.actorCharacter(state,a).inventory[id].snapshot)&&!B.actorCharacter(state,a).inventory[id].loaded.current);
  if(needsAmmo){const required=entries.find(e=>e.type==='reload')||entries.find(e=>e.type==='extract')||entries.find(e=>e.type==='fill')||entries.find(e=>e.type==='switch'&&require('./durability').current(B.actorCharacter(state,a).inventory[e.item])>0&&(!AM.usesMagazine(B.actorCharacter(state,a).inventory[e.item].snapshot)||B.actorCharacter(state,a).inventory[e.item].loaded?.current>0));if(required)selected={key:required.key,list:[required]};}
  if(selected){
    const list=selected.list;
    if(selected.key.startsWith('attack:')){const t=target(state,b,a,list.map(o=>B.actorById(b,o.target)),rng);op=list.find(o=>o.target===t.id);}
    else op=list[rng(0,list.length)];
  } else if(JSON.stringify(cfg.weights)===JSON.stringify(DEFAULTS)) {
    op=entries.find(e=>e.type==='reload') || entries.find(e=>e.type==='extract') || entries.find(e=>e.type==='fill') || (candidates.some(e=>e.type==='attack')?null:candidates.find(e=>e.type==='move'));
  }
  if(!op && group)op={type:'pass',group,key:'pass'};
  if(!op)op={type:'finish',key:'finish'};
  execute(state,b,op,rng);if(b.pending)b.pending.automatic=true; b.aiSequence=(b.aiSequence||0)+1;
  B.record(b,'NPC自动操作：'+a.name+' · '+op.key,{sequence:b.aiSequence,turnId:token,operation:clone(op)});
  return true;
}
module.exports={DEFAULTS,config,validate,draw,approach,options,due,step};
