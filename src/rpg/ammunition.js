'use strict';
const C=require('./constants');const {requireThat:ok,clone}=C;
function usesMagazine(t){return t.kind==='武器'&&(C.FIREARMS.includes(t.weaponType)||t.weaponType==='弩');}
function ammoCompatible(t,a){return t.ammoIds?.length?t.ammoIds.includes(a.id):t.ammoType===a.ammoType;}
function magazineCompatible(w,m){return w.magazineIds?.length?w.magazineIds.includes(m.id):w.magazineType===m.magazineType;}
function empty(t){return {current:0,capacity:t.capacity||1,weight:0,rounds:[]};}
function normalize(p){
  // Move legacy weapon rounds to its existing magazine exactly once; never create extra rounds.
  for(const w of Object.values(p.inventory).filter(i=>usesMagazine(i.snapshot))) {
    if(w.snapshot.weaponType==='弩'&&!w.magazineStorage&&!p.inventory[w.magazineId]){
      const t={id:'legacy_bolt_'+w.templateId,version:1,published:true,kind:'弹夹',name:'旧弩兼容箭匣',capacity:1,weight:0,value:0,rarity:'white',ammoIds:clone(w.snapshot.ammoIds||[]),ammoType:w.snapshot.ammoType,magazineType:'legacy_bolt_'+w.templateId,effects:[],description:'旧弩迁移使用的单发箭匣。'};
      const m={id:C.id('i'),templateId:t.id,version:1,snapshot:t,quantity:1,attachments:[],loaded:empty(t)};p.inventory[m.id]=m;w.magazineId=m.id;w.snapshot.magazineIds=[t.id];w.snapshot.magazineType=t.magazineType;
    }
    const m=p.inventory[w.magazineId];
    if(m?.snapshot.kind==='弹夹') {
      if(!m.loaded){m.loaded=w.magazineStorage?empty(m.snapshot):clone(w.loaded||empty(m.snapshot));m.loaded.capacity=m.snapshot.capacity;}
      m.loaded.rounds ||= Array.from({length:m.loaded.current||0},()=>round(w.snapshot.initialAmmo||{weight:m.loaded.weight||0,ammoType:w.snapshot.ammoType}));
      w.loaded=m.loaded;
    }else {delete w.magazineId;w.loaded=empty(w.snapshot);}
    w.magazineStorage=true;
  }
  for(const m of Object.values(p.inventory).filter(i=>i.snapshot.kind==='弹夹')){m.loaded ||= empty(m.snapshot);m.loaded.rounds||=[];m.loaded.current=m.loaded.rounds.length;}
  return p;
}
function migrate(state){if(state.ammunitionVersion===1)return false;
  for(const p of Object.values(state.players))normalize(p);
  for(const b of Object.values(state.battles).filter(b=>b.status!=='ended'))for(const a of b.actors.filter(a=>!a.userId&&!a.deathId))normalize(a.character);
  state.ammunitionVersion=1;return true;
}
function round(t){return {weight:t.weight||0,effects:clone(t.effects||[]),damage:clone(t.damage||{}),conditions:clone(t.conditions||[]),template:clone(t)};}
function attached(p,id){return Object.values(p.inventory).some(i=>i.magazineId===id);}
function fill(p,magazineId,ammoId,quantity){normalize(p);const m=p.inventory[magazineId],a=p.inventory[ammoId];
  ok(m?.snapshot.kind==='弹夹'&&a?.snapshot.kind==='弹药','请选择弹夹和弹药。');ok(!attached(p,magazineId),'先抽出弹夹，再填弹。');
  ok(ammoCompatible(m.snapshot,a.snapshot),'弹药与弹夹不兼容。');
  const free=m.loaded.capacity-m.loaded.current,n=quantity==null?Math.min(free,a.quantity):C.number(quantity,'填弹数量',1,10000);
  ok(n>0&&n<=free&&n<=a.quantity,'弹夹已满或弹药不足。');m.loaded.rounds.push(...Array.from({length:n},()=>round(a.snapshot)));m.loaded.current=m.loaded.rounds.length;
  a.quantity-=n;if(!a.quantity)delete p.inventory[ammoId];p.ammoVersion=(p.ammoVersion||0)+1;return n;
}
function swap(p,weaponId,magazineId){normalize(p);const w=p.inventory[weaponId],m=p.inventory[magazineId];ok(w&&usesMagazine(w.snapshot),'该武器不支持弹夹／箭匣。');
  const old=w.magazineId||null;
  if(magazineId){ok(m?.snapshot.kind==='弹夹'&&!attached(p,magazineId),'弹夹不存在或已装入武器。');ok(magazineCompatible(w.snapshot,m.snapshot),'弹夹与武器不兼容。');
    ok(m.loaded.rounds.every(r=>ammoCompatible(w.snapshot,r.template||{id:w.snapshot.initialAmmo?.id,ammoType:w.snapshot.ammoType})),'弹夹中的弹药不兼容此武器。');
    w.magazineId=magazineId;w.loaded=m.loaded;
  }else {ok(old,'武器没有可抽出的弹夹。');delete w.magazineId;w.loaded=empty(w.snapshot);}
  w.magazineStorage=true;p.ammoVersion=(p.ammoVersion||0)+1;return old;
}
function validateBattleOperation(state,b,turnId,op,context){const B=require('./combat'),M=require('./model'),W=require('./weapons');const {actor,p,turn}=context||B.readonlyCurrent(state,b,turnId);if(!context)normalize(p);
 ok(!b.pending&&turn.quick>0,'需要自己的快速行动且没有待响应攻击。');if(actor.userId)for(const ref of [op.weapon,op.magazine,op.ammo].filter(Boolean))ok(M.available(state,actor.userId,ref)>0,'物品已被交易预留。');
 if(op.type==='fill'){const m=p.inventory[op.magazine],a=p.inventory[op.ammo];ok(m?.snapshot.kind==='弹夹'&&a?.snapshot.kind==='弹药','请选择弹夹和弹药。');ok(!attached(p,op.magazine),'先抽出弹夹，再填弹。');ok(ammoCompatible(m.snapshot,a.snapshot),'弹药与弹夹不兼容。');const free=m.loaded.capacity-m.loaded.current,available=actor.userId?M.available(state,actor.userId,op.ammo):a.quantity,n=op.quantity??Math.min(free,available||0);C.number(n,'填弹数量',1,10000);ok(n>0&&n<=free&&n<=a.quantity,'弹夹已满或弹药不足。');}
 else{ok(['extract','swap'].includes(op.type),'弹药操作无效。');ok(W.equipped(p).includes(op.weapon),'只能操作已装备的武器。');const w=p.inventory[op.weapon],m=p.inventory[op.magazine];ok(w&&usesMagazine(w.snapshot),'该武器不支持弹夹／箭匣。');if(op.type==='extract')ok(w.magazineId,'武器没有可抽出的弹夹。');else{ok(m?.snapshot.kind==='弹夹'&&!attached(p,op.magazine),'弹夹不存在或已装入武器。');ok(magazineCompatible(w.snapshot,m.snapshot),'弹夹与武器不兼容。');ok(m.loaded.rounds.every(r=>ammoCompatible(w.snapshot,r.template||{id:w.snapshot.initialAmmo?.id,ammoType:w.snapshot.ammoType})),'弹夹中的弹药不兼容此武器。');}}
 return true;
}
function battleOperation(state,b,turnId,op){const B=require('./combat'),M=require('./model'),W=require('./weapons');const {actor,p,turn}=B.current(state,b,turnId);
  ok(!b.pending&&turn.quick>0,'需要自己的快速行动且没有待响应攻击。');normalize(p);
  const refs=[op.weapon,op.magazine,op.ammo].filter(Boolean);if(actor.userId)for(const ref of refs)ok(M.available(state,actor.userId,ref)>0,'物品已被交易预留。');
  validateBattleOperation(state,b,turnId,op,{actor,p,turn});
  let value;
  if(op.type==='fill'){const m=p.inventory[op.magazine];ok(m?.snapshot.kind==='弹夹','弹夹已变化。');const available=actor.userId?M.available(state,actor.userId,op.ammo):p.inventory[op.ammo]?.quantity;const count=op.quantity??Math.min(m.loaded.capacity-m.loaded.current,available||0);value=fill(p,op.magazine,op.ammo,count);}
  else {ok(W.equipped(p).includes(op.weapon),'只能操作已装备的武器。');value=swap(p,op.weapon,op.type==='extract'?null:op.magazine);}
  turn.quick--;M.syncHP(p);B.record(b,actor.name+'进行弹药操作：'+({fill:'向弹夹填弹',extract:'抽出弹夹',swap:'更换弹夹'}[op.type])+(op.type==='fill'?' '+value+'发':''),{actorId:actor.id,portrait:p.portraits?.avatar,weapon:op.weapon&&p.inventory[op.weapon]?.snapshot.name,magazine:op.magazine&&p.inventory[op.magazine]?.snapshot.name});return value;
}
function primeNPC(p){normalize(p);const W=require('./weapons'),results=[];
  for(const ref of W.equipped(p)){const w=p.inventory[ref];if(!usesMagazine(w.snapshot))continue;
    let mag=p.inventory[w.magazineId];if(!mag){mag=Object.values(p.inventory).find(m=>m.snapshot.kind==='弹夹'&&!attached(p,m.id)&&magazineCompatible(w.snapshot,m.snapshot)&&m.loaded.rounds.every(r=>ammoCompatible(w.snapshot,r.template||{})));if(mag)swap(p,w.id,mag.id);}
    if(!mag){results.push({name:w.snapshot.name,current:0,capacity:w.snapshot.capacity});continue;}
    if(mag.loaded.current<mag.loaded.capacity){swap(p,w.id,null);for(const a of [...Object.values(p.inventory)]){if(mag.loaded.current>=mag.loaded.capacity)break;if(a.snapshot.kind==='弹药'&&ammoCompatible(w.snapshot,a.snapshot)&&ammoCompatible(mag.snapshot,a.snapshot))fill(p,mag.id,a.id);}swap(p,w.id,mag.id);}
    results.push({name:w.snapshot.name,current:w.loaded.current,capacity:w.loaded.capacity});
  }return results;
}
module.exports={usesMagazine,ammoCompatible,magazineCompatible,normalize,empty,round,attached,fill,swap,validateBattleOperation,battleOperation,migrate,primeNPC};
