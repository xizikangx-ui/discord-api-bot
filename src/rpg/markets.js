'use strict';
const C=require('./constants'),M=require('./model'),H=require('./health'),G=require('./gm-service');
const TYPES={weapon:{name:'武器市场',kinds:['武器','弹药','弹夹','配件']},armor:{name:'防具市场',kinds:['防具','饰品']}};
const ok=C.requireThat;
function initialize(s){if(s.platform!=='web'||s.webMarketVersion===1)return null;s.markets||={};s.marketTrades||={};for(const [id,t]of Object.entries(TYPES))s.markets[id]||={id,name:t.name,open:false,version:1,listings:{}};s.webMarketVersion=1;return {marketsInitialized:true};}
function market(s,id){ok(Object.hasOwn(TYPES,id)&&s.markets?.[id],'市场不存在。');return s.markets[id];}
function identity(e){return {id:e.id,template:e.template,price:e.price,enabled:e.enabled,version:e.version};}
function listingHash(e){return G.fingerprint(e&&identity(e));}
function manage(s,command,p){
 const m=market(s,p.marketId);
 if(command==='market.toggle'){ok(Number(p.baseVersion)===m.version,'市场开关已变化，请刷新。');ok(typeof p.open==='boolean','开关无效。');m.open=p.open;m.version++;return {marketId:m.id,open:m.open};}
 const rows=p.rows||[p];ok(Array.isArray(rows)&&rows.length&&rows.length<=100,'每批1—100种货品。');
 const staged=C.clone(m),seen=new Set();
 for(const row of rows){ok(row&&typeof row==='object'&&!Array.isArray(row),'货品行格式无效。');const id=row.id||C.id('ml');ok(typeof id==='string'&&id.length<=100&&!['__proto__','constructor','prototype'].includes(id),'货品编号无效。');ok(!seen.has(id),'同批不能重复编辑货品。');seen.add(id);const old=staged.listings[id];
   ok((old?.version||0)===Number(row.baseVersion||0),'货品已修改，请刷新后保存。');
   if(command==='market.restock'){ok(old,'货品不存在。');old.remaining=C.number(old.remaining+C.number(row.quantity,'补货数量',1,10000),'库存',0,10000);old.version++;continue;}
   if(command==='market.remove'){ok(old,'货品不存在。');old.enabled=false;old.version++;continue;}
   ok(command==='market.save','市场操作无效。');const template=row.templateId?s.catalog[row.templateId]:old?.template;
   ok(template?.published&&TYPES[m.id].kinds.includes(template.kind),'请选择已发布的本市场实物，不能上架杂物。');
   if(old&&row.quantity!==undefined)ok(row.stockVersion===old.stockVersion,'库存已变化，请重新读取库存后调整。');
   staged.listings[id]={id,template:C.clone(template),price:C.number(row.price??old?.price??template.value,'单价',0,C.MAX_MONEY),remaining:C.number(row.quantity??old?.remaining??1,'库存',0,10000),stockVersion:old?.stockVersion||0,enabled:row.enabled!==false,version:(old?.version||0)+1};
 }Object.assign(m,staged);return {marketId:m.id,updated:rows.length};
}
function purchase(s,uid,p){const buyer=M.player(s,uid);H.requireAction(buyer);ok(!M.battleFor(s,uid),'参加未结束战斗时不能购买。');
 const m=market(s,p.marketId),e=m.listings[p.listingId];ok(m.open,'市场已休市。');ok(e?.enabled,'货品已下架。');
 ok(listingHash(e)===p.listingVersion,'价格或货品已变化，请查看最新货架。');
 ok(s.catalog[e.template.id]?.published,'源模板已停用，暂不能购买。');
 const quantity=C.number(p.quantity,'购买数量',1,100),total=e.price*quantity;ok(Number.isSafeInteger(total)&&total<=C.MAX_MONEY,'交易总价超限。');
 ok(e.remaining>=quantity,'库存不足，请调整购买数量。');ok(buyer.balance-M.reserved(s,uid).coins>=total,'可用余额不足或已被交易预留。');
 const staged=C.clone(buyer),stateful=['武器','防具','饰品','配件','弹夹'].includes(e.template.kind);
 for(let n=0;n<(stateful?quantity:1);n++)M.receive(staged,M.makeItem(e.template,stateful?1:quantity));
 staged.balance-=total;Object.assign(buyer,staged);e.remaining-=quantity;e.stockVersion=(e.stockVersion||0)+1;
 const result={id:C.id('mt'),marketId:m.id,owner:uid,characterId:buyer.id,name:e.template.name,quantity,unitPrice:e.price,total,remaining:e.remaining,at:Date.now()};
 s.marketTrades||={};s.marketTrades[result.id]=C.clone(result);return result;
}
function view(s,id,{page=0,q='',kind='',size=12,gm=false}={}){const m=market(s,id);page=C.number(page,'页',0,100000);size=C.number(size,'每页数量',1,100);q=String(q).normalize('NFKC').toLowerCase();
 const list=Object.values(m.listings).filter(e=>(gm||e.enabled)&&(!kind||e.template.kind===kind)&&e.template.name.normalize('NFKC').toLowerCase().includes(q));
 return {id:m.id,name:m.name,open:m.open,version:m.version,total:list.length,page,kinds:TYPES[id].kinds,items:list.slice(page*size,(page+1)*size).map(e=>({id:e.id,name:e.template.name,kind:e.template.kind,rarity:e.template.rarity,description:e.template.description,templateId:e.template.id,weight:e.template.weight,price:e.price,remaining:e.remaining,enabled:e.enabled,version:e.version,stockVersion:e.stockVersion||0,listingVersion:listingHash(e),available:!!s.catalog[e.template.id]?.published}))};
}
module.exports={TYPES,initialize,market,identity,listingHash,manage,purchase,view};
