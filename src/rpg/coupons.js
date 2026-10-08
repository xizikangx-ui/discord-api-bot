'use strict';
const C=require('./constants'),M=require('./model'),H=require('./health');
const ok=C.requireThat;
function pool(s,id) { const p=s.couponPools?.[id]; ok(p?.published,'兑换池未发布或不存在。'); return p; }
function validate(s,raw) {
  const p={name:C.text(raw.name,'兑换券名称',80),description:C.text(raw.description||'','说明',1000,true),mode:raw.mode,enabled:raw.enabled!==false,entries:C.clone(raw.entries||[])};
  ok(['bundle','choice'].includes(p.mode),'请选择整套或单一领取。'); ok(p.entries.length>0,'请至少选择一种物品。');
  ok(new Set(p.entries.map(e=>e.ref)).size===p.entries.length,'池内物品不能重复。');
  for (const e of p.entries) { const t=s.catalog[e.ref]; ok(t?.published&&t.kind!=='技能','请选择已发布的实物模板。'); e.quantity=C.number(e.quantity,'数量',1,100); }
  if(p.mode==='bundle')ok(p.entries.reduce((n,e)=>n+e.quantity,0)<=100,'整套一次最多100件。');
  return p;
}
function publish(s,raw,id,baseVersion=0) { s.couponPools||={}; const old=id&&s.couponPools[id];ok((old?.version||0)===baseVersion,'兑换池已更新，请重新打开编辑。');const p={...validate(s,raw),id:id||C.id('v'),version:baseVersion+1,published:true};s.couponPools[p.id]=p;return p; }
function grant(s,id,targets) {
  const p=pool(s,id);ok(p.enabled,'该池已停止发券。');ok(targets.length>0&&targets.length<=25,'一次请选择1—25名玩家。');ok(new Set(targets.map(t=>t.uid)).size===targets.length,'玩家不能重复。');
  for(const t of targets) { const c=M.player(s,t.uid);ok(c.id===t.characterId,'目标角色已变化。');const q=C.number(t.quantity,'发券数',1,100000);ok((c.couponBalances?.[id]||0)+q<=1000000,'兑换券余额不能超过1000000。'); }
  for(const t of targets) { const c=M.player(s,t.uid);c.couponBalances||={};c.couponBalances[id]=(c.couponBalances[id]||0)+Number(t.quantity); } return C.clone(targets);
}
function preview(s,uid,id,selected,now=Date.now()) {
  const p=M.player(s,uid),v=pool(s,id);H.requireAction(p);ok(!M.battleFor(s,uid),'战斗结束后才能兑换，包括暂停和招募中的战斗。');ok((p.couponBalances?.[id]||0)>0,'没有该兑换券。');
  const entries=v.mode==='bundle'?v.entries:v.entries.filter(e=>e.ref===selected);ok(entries.length,'请选择池内一种物品。');
  const f={id:C.id('f'),kind:'couponRedeem',owner:uid,characterId:p.id,poolId:id,poolVersion:v.version,entries:entries.map(e=>{const t=s.catalog[e.ref];ok(t?.published&&t.kind!=='技能','池内模板已失效，请联系GM。');return {...e,version:t.version};}),status:'ready',expiresAt:C.confirmationDeadline(300000,now)};s.forms[f.id]=f;return f;
}
function redeem(s,uid,id,now=Date.now()) {
  const f=s.forms[id];ok(f?.kind==='couponRedeem'&&f.owner===uid,'兑换确认不属于你。');if(f.status==='done')return C.clone(s.couponRedemptions[id]);
  ok(f.status==='ready'&&f.expiresAt>now,'确认已过期，请重新选择。');const p=M.player(s,uid),v=pool(s,f.poolId);ok(p.id===f.characterId,'角色已经变化。');H.requireAction(p);ok(!M.battleFor(s,uid),'战斗结束后才能兑换。');ok(v.version===f.poolVersion,'兑换池已更新，请重新预览确认。');ok((p.couponBalances?.[v.id]||0)>0,'兑换券不足。');
  for(const e of f.entries)ok(s.catalog[e.ref]?.published&&s.catalog[e.ref].version===e.version,'物品模板已更新，请重新预览确认。');
  // Stage the entire reward, including preinstalled magazine/attachment weight.
  const shadow={...s,players:{...s.players,[uid]:C.clone(p)}},items=[];
  for(const e of f.entries)items.push(...M.issue(shadow,uid,e.ref,e.quantity));
  const next=shadow.players[uid];next.couponBalances[v.id]--;s.players[uid]=next;
  const result={id,owner:uid,characterId:p.id,poolId:v.id,poolVersion:v.version,name:v.name,at:now,items:C.clone(items),remaining:next.couponBalances[v.id]};
  s.couponRedemptions||={};s.couponRedemptions[id]=result;f.status='done';return C.clone(result);
}
function remove(s,id) { pool(s,id);ok(!Object.values(s.players).some(p=>(p.couponBalances?.[id]||0)>0),'仍有未兑换余额，不能删除该池。');delete s.couponPools[id]; }
module.exports={pool,validate,publish,grant,preview,redeem,remove};
