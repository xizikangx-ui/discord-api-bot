'use strict';
const C=require('./constants'),M=require('./model'),H=require('./health');
const ok=C.requireThat;
function validate(s,raw) {
  const p={name:C.text(raw.name,'BOSS池名称',80),description:C.text(raw.description||'','房间描述',1000,true),entries:C.clone(raw.entries||[])};
  ok(p.entries.length&&new Set(p.entries.map(e=>e.ref)).size===p.entries.length,'请选择不重复的怪物模板。');
  for(const e of p.entries){ok(s.npcTemplates[e.ref]?.published,'请选择已发布NPC模板。');e.quantity=C.number(e.quantity,'怪物数量',1,19);}
  ok(p.entries.reduce((n,e)=>n+e.quantity,0)<=19,'整组最多19名敌人。');return p;
}
function publish(s,raw,id,baseVersion=0) {s.bossPools||={};ok((s.bossPools[id]?.version||0)===baseVersion,'BOSS池已更新。');const p={...validate(s,raw),id:id||C.id('v'),version:baseVersion+1,published:true};s.bossPools[p.id]=p;return p;}
function assign(s,m,ref,poolId,rng=require('node:crypto').randomInt) {
  ok(['draft','paused'].includes(m.status),'请在草稿或暂停地图时分配。');ok(s.config.rpChannelId,'请先配置GM隐藏操作频道。');const c=m.cells[ref],p=s.bossPools[poolId];ok(p?.published,'BOSS池不存在。');validate(s,p);
  ok(c&&(c.type==='room'||c.hasContents)&&c.passable!==false,'请选择可通行的内容格。');ok(!c.room?.merchant,'行商节点不能直接替换为BOSS房。');ok(!c.touched&&!Object.values(m.participants).some(x=>x.cell===ref),'已经进入的房间不能更换。');ok(!Object.entries(m.cells).some(([r,x])=>r!==ref&&x.room?.boss),'每张地图最多一间BOSS房。');require('./exploration').validateMap(m);
  const X=require('./exploration');if(!c.room)c.room=X.instantiate(s,X.selectRoom(s,m,c,rng),rng,m.maxRank??10,c.variantId);
  c.bossOriginal ||= C.clone(c.room);
  const entries=p.entries.flatMap(e=>Array.from({length:e.quantity},()=>({template:s.npcTemplates[e.ref].randomStrength?require('./npc-strength').freeze(s.npcTemplates[e.ref],rng):C.clone(s.npcTemplates[e.ref]),quantity:1})));
  const r=c.room;r.boss={poolId,version:p.version};r.snapshot.name=p.name;r.snapshot.description=p.description||r.snapshot.description;r.snapshot.autoStart=false;r.autoStart=false;r.npcs=entries;r.snapshot.npcs=C.clone(entries);r.remainingNpcs=C.clone(entries);r.encounter='pending';r.battleId=null;delete r.bossRequest;m.version++;return r;
}
function clear(s,m,ref) {const c=m.cells[ref];ok(['draft','paused'].includes(m.status)&&c?.room?.boss&&!c.touched&&!Object.values(m.participants).some(x=>x.cell===ref),'只能移除尚未进入的BOSS房。');c.room=c.bossOriginal;delete c.bossOriginal;m.version++;}
function signature(s,m,ref) {const r=m.cells[ref]?.room;return JSON.stringify({room:r?.id,npcs:r?.remainingNpcs,roster:Object.entries(m.participants).sort(([a],[b])=>a.localeCompare(b)).map(([uid,p])=>[uid,p.characterId,p.cell])});}
function eligible(s,m,ref) {return m.status==='active'&&!require('./rp').waiting(m)&&m.revealed[ref]&&m.cells[ref]?.room?.encounter==='pending'&&Object.keys(m.participants).length>0&&Object.entries(m.participants).every(([uid,p])=>p.cell===ref&&s.players[uid]?.id===p.characterId&&H.canAct(s.players[uid])&&!M.battleFor(s,uid));}
function needsScan(s) {return Object.values(s.explorations||{}).some(m=>Object.entries(m.cells).some(([ref,c])=>c.room?.boss&&eligible(s,m,ref)&&(!c.room.bossRequest||c.room.bossRequest.status!=='pending'||c.room.bossRequest.signature!==signature(s,m,ref))));}
function reconcile(s) {
  for(const m of Object.values(s.explorations||{}))for(const [ref,c] of Object.entries(m.cells))if(c.room?.boss){const r=c.room,q=r.bossRequest;
    if(eligible(s,m,ref)){const sig=signature(s,m,ref);if(!q||q.status!=='pending'||q.signature!==sig){r.bossRequest={id:C.id('j'),version:1,status:'pending',signature:sig,notification:{status:'pending'}};m.version++;}}
    else if(q?.status==='pending'){q.status='cancelled';q.version++;}
  }
}
function confirm(s,mapId,ref,id,version,rng=require('node:crypto').randomInt) {
  const m=s.explorations[mapId],r=m?.cells[ref]?.room,q=r?.bossRequest;ok(q&&q.id===id,'遭遇确认已变化。');if(q.status==='started')return s.battles[q.battleId];
  ok(q.status==='pending'&&q.version===Number(version)&&eligible(s,m,ref)&&q.signature===signature(s,m,ref),'队伍或房间已变化，请重新确认。');
  q.status='approved';const b=require('./exploration').encounter(s,m,ref,Object.keys(m.participants),rng,id);require('./combat').start(s,b,null,rng);q.status='started';q.battleId=b.id;q.version++;return b;
}
function authorized(s,m,ref,id) {const q=m.cells[ref].room.bossRequest;ok(q?.status==='approved'&&q.id===id&&q.signature===signature(s,m,ref),'BOSS遭遇须由GM隐藏面板确认。');}
module.exports={validate,publish,assign,clear,signature,eligible,needsScan,reconcile,confirm,authorized};
