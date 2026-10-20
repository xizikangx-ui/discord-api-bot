'use strict';
const C=require('../rpg/constants'),G=require('../rpg/gm-service'),S=require('./security');
const allowed=new Set([...Object.values(G.KINDS),'players','explorations','battles','offers','checks','sessions','deaths','corpses','forms','events','deliveryJobs','lootPublications','containerDefinitions','couponRedemptions','merchantTrades','markets','marketTrades']);
async function collection(store,group,uid,source,query){
 S.ok(allowed.has(source),'查询类型无效。');
 const id=query.get('id'),page=C.number(query.get('page')||0,'页',0,100000),size=C.number(query.get('size')||25,'每页',1,100),q=(query.get('q')||'').normalize('NFKC').toLowerCase(),category=query.get('category'),rarity=query.get('rarity');
 if(source==='events'&&store.database?.auditPage){const data=await store.database.auditPage(group,{id,page,size,q});if(id)S.ok(data.item,'对象不存在。');return {...data,revision:store.select(group,s=>s.revision)};}
 return store.select(group,s=>{
  let all=Object.values(s[source]||{});if(source==='forms')all=all.filter(f=>f.owner===uid);
  if(id){const item=all.find(x=>[x.id,x.userId,x.key].includes(id));S.ok(item,'对象不存在。');return {revision:s.revision,item:source==='players'?{...item,stats:require('../rpg/model').stats(C.clone(item))}:item};}
  all=all.filter(t=>(t.name||t.title||t.label||t.id||t.key||'').normalize('NFKC').toLowerCase().includes(q));
  if(source==='catalog'&&category)all=all.filter(t=>require('../rpg/item-categories').matches(t,category,true));
  if(rarity)all=all.filter(t=>t.rarity===rarity);
  if(query.get('published')==='1')all=all.filter(t=>t.published&&t.enabled!==false);
  if(source==='events')all.reverse();
  return {revision:s.revision,total:all.length,page,items:all.slice(page*size,(page+1)*size).map(t=>source==='players'?{id:t.id,userId:t.userId,name:t.name,hp:t.hp,life:t.life,balance:t.balance,points:t.points,stats:require('../rpg/model').stats(C.clone(t))}:t)};
 });
}
function battle(s,id){const b=s.battles[id];return {config:s.config,battles:b?{[id]:b}:{},players:Object.fromEntries((b?.actors||[]).filter(a=>a.userId&&s.players[a.userId]).map(a=>[a.userId,s.players[a.userId]])),skillTemplates:s.skillTemplates,conditionTemplates:s.conditionTemplates};}
module.exports={collection,battle};
