'use strict';
const C=require('./constants'),U=require('./ui'),M=require('./model'),B=require('./combat');
function createRecovery({snapshot,store,canActor,features,exploration}){
 function home(){return U.payload('继续操作','请选择入口重新读取最新状态。',[U.row(U.button('reopen:battle','重新打开个人面板'),U.button('reopen:bag','背包'),U.button('reopen:map','地图'))]);}
 function view(i,member,kind){const s=snapshot(i.guildId);if(kind==='bag')return U.inventoryView(s,i.user.id,i.user.id);if(kind==='map'){const m=s.explorations[i.rpgRecovery?.mapId];return m?.participants[i.user.id]?.characterId===s.players[i.user.id]?.id?exploration.personal(s,m,i.user.id,i.rpgRecovery?.tab||'room'):exploration.home(s,member);}
  if(kind==='form'){const f=s.forms[i.rpgRecovery.formId];if(f?.owner===i.user.id&&['item','npc','trait','condition','room','mapcategory'].includes(f.kind)&&U.gm(s,member))return require('./forms').view(s,f);}
  if(kind==='offer'){const o=s.offers[i.rpgRecovery.offerId];if(o&&(o.sides?.[i.user.id]||U.gm(s,member)))return U.offerView(s,o,i.user.id);}
  if(kind==='兑换券')return features.redeemHome(s,i.user.id);if(kind==='收藏柜')return features.showcase(s,i.user.id,i.user.id);if(kind==='名词解释')return features.glossary(s);
  const context=i.rpgRecovery;let b=s.battles[context?.battleId];if(!b){b=M.battleFor(s,i.user.id);}
  if(b){let a=b.actors.find(a=>a.id===context?.actorId);if(!a||a.userId!==i.user.id&&!U.gm(s,member))a=b.actors.find(a=>a.userId===i.user.id);if(a){canActor(s,b,a.id,member,i.user.id);return U.personalView(s,b,a,i.user.id,context?.tab||'overview');}}
  return home();
 }
 function context(i){if(i.rpgRecovery)return;const source=i.message;if(source?.author?.id!==store.clientId)return;const text=source.embeds?.[0]?.footer?.text||source.embeds?.[0]?.data?.footer?.text||'';if(/^入口 bag /.test(text)){i.rpgRecovery={kind:'bag'};return;}const map=/^(m[\da-f]{12}) · 私有/.exec(text);if(map){i.rpgRecovery={kind:'map',mapId:map[1]};return;}const m=/^面板 (b[\da-f]{12}) (a[\da-f]{12}) (\S+) (\w+)$/.exec(text);if(!m)return;const s=snapshot(i.guildId),b=s.battles[m[1]],a=b?.actors.find(a=>a.id===m[2]);if(a?.userId===i.user.id&&B.actorCharacter(s,a)?.id===m[3])i.rpgRecovery={kind:'battle',battleId:b.id,actorId:a.id,tab:m[4]};}
 async function recover(i,error){context(i);let v;try{v=view(i,i.member,i.rpgRecovery?.kind);}catch{v=home();}
  const saved=store.select(i.guildId,s=>s.receipts[i.id]||s.receipts[i.rpgOperation]);const r=saved?.result,summary=r?.name?r.name+' ×'+(r.quantity||1)+(r.total!=null?' · '+r.total+'币':''):r?.action?(require('./action-drafts').labels[r.action]||r.action):'';v.content=(saved?'✅ 操作已保存，回复未完成。'+(summary?' '+summary:''):'⚠️ '+(error.message||'操作未完成'))+'\n已读取最新面板；没有自动重试原操作。';
  if(store.frozen(i.guildId)){v=home();v.content='存档写入结果待核对，修改仍暂停。GM请使用 /gm 恢复存档。';}
  return v;
 }
 function component(i,member){return view(i,member,i.customId.split(':')[2]);}
 return {recover,component,home};
}
module.exports={createRecovery};
