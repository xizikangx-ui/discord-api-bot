'use strict';
const crypto=require('node:crypto'),C=require('./constants'),M=require('./model'),H=require('./health'),X=require('./exploration'),Categories=require('./item-categories');
const ok=C.requireThat, rngDefault=crypto.randomInt;
function validate(s,raw){
 const t={name:C.text(raw.name,'行商名称',80),description:C.text(raw.description||'','行商说明',1000,true),sellMode:raw.sellMode||'random',buyMode:raw.buyMode||'category',sellCategories:C.clone(raw.sellCategories||['all']),buyCategories:C.clone(raw.buyCategories||['all']),sellCount:C.number(raw.sellCount??6,'随机货品种数',1,20),sellQuantity:C.number(raw.sellQuantity??1,'每种库存',1,100),buyCount:C.number(raw.buyCount??6,'随机收购种数',1,20),buyQuota:C.number(raw.buyQuota??10,'收购总件数额度',0,10000),entries:C.clone(raw.entries||[]),enabled:raw.enabled!==false};
 ok(['random','fixed'].includes(t.sellMode)&&['random','category'].includes(t.buyMode),'货单模式无效。');
 for(const cats of [t.sellCategories,t.buyCategories])ok(cats.length>0&&cats.length<=11&&new Set(cats).size===cats.length&&cats.every(c=>Categories.valid(c,true)),'请指定有效的物品分类。');
 for(const e of t.entries){ok(s.catalog[e.ref]?.published&&s.catalog[e.ref].kind!=='技能','货品必须是已发布实物。');e.quantity=C.number(e.quantity,'库存',1,100);}
 ok(t.entries.length<=20&&new Set(t.entries.map(e=>e.ref)).size===t.entries.length,'固定货单最多20种、不重复。');if(t.sellMode==='fixed')ok(t.entries.length,'固定货单不能为空。');return t;
}
function publish(s,raw,id,version=0){s.merchantTemplates||={};ok((s.merchantTemplates[id]?.version||0)===version,'行商模板已被修改。');const t={...validate(s,raw),id:id||C.id('v'),version:version+1,published:true};s.merchantTemplates[t.id]=t;return t;}
function matches(t,cats){return t.kind!=='技能'&&cats.some(c=>Categories.matches(t,c,true));}
function sample(list,count,rng){const a=[...list];for(let n=a.length-1;n>0;n--){const j=rng(0,n+1);[a[n],a[j]]=[a[j],a[n]];}return a.slice(0,count);}
function generate(s,t,rng=rngDefault){t=validate(s,t);const available=Object.values(s.catalog).filter(t=>t.published&&t.kind!=='技能');
 const sells=t.sellMode==='random'?sample(available.filter(x=>matches(x,t.sellCategories)),t.sellCount,rng).map(x=>({ref:x.id,quantity:t.sellQuantity})):t.entries;
 ok(sells.length,'所选出售分类没有可用模板。');const wanted=t.buyMode==='random'?sample(available.filter(x=>matches(x,t.buyCategories)),t.buyCount,rng).map(x=>x.id):[];
 ok(!t.buyQuota||t.buyMode!=='random'||wanted.length,'所选收购分类没有可用模板。');
 return {id:C.id('h'),version:1,name:t.name,description:t.description,stock:sells.map(e=>({id:C.id('k'),template:C.clone(s.catalog[e.ref]),remaining:e.quantity})),buyMode:t.buyMode,buyCategories:t.buyCategories,wanted,wantedTemplates:Object.fromEntries(wanted.map(id=>[id,C.clone(s.catalog[id])])),buyRemaining:t.buyQuota,generatedAt:Date.now()};
}
function assign(s,m,ref,id,rng=rngDefault,frozen){ok(m&&['draft','paused'].includes(m.status),'先暂停地图或在草稿中分配。');const c=m.cells[ref],t=s.merchantTemplates?.[id];ok(t?.published&&t.enabled!==false,'行商模板已停用或失效。');ok(c&&(c.type==='room'||c.hasContents)&&X.passable(c)&&!c.room?.boss,'请选择非BOSS的可通行内容格。');ok(!X.touched(m,ref),'已进入的格子不能更换。');X.validateMap(m);
 const node=frozen?C.clone(frozen):generate(s,t,rng);node.templateId=t.id;node.templateVersion=t.version;if(!Object.hasOwn(c,'merchantOriginal'))c.merchantOriginal=C.clone(c.room||null);
 c.room={id:C.id('r'),templateId:null,snapshot:{name:t.name,description:t.description,keyIds:[],autoStart:false},unlocked:true,encounter:'resolved',containers:[],supplies:[],npcs:[],remainingNpcs:[],battleId:null,merchant:node};m.version++;return node;}
function clear(s,m,ref){ok(m&&['draft','paused'].includes(m.status)&&m.cells[ref]?.room?.merchant&&!X.touched(m,ref),'只能移除未进入的行商节点。');m.cells[ref].room=m.cells[ref].merchantOriginal;delete m.cells[ref].merchantOriginal;m.generated=false;m.version++;}
function access(s,uid,mapId,ref){const m=s.explorations[mapId];ok(m,'地图已失效。');const {p,part}=X.participant(s,m,uid);H.requireAction(p);ok(!require('./rp').waiting(m),'请等待GM环境描述完成。');ok(part.cell===ref&&m.revealed[ref],'必须身处该行商节点。');const n=m.cells[ref]?.room?.merchant;ok(n,'行商节点已失效。');return {p,m,n};}
function buyable(n,item){return item.snapshot.value>=0&&matches(item.snapshot,n.buyCategories)&&(n.buyMode!=='random'||n.wanted.includes(item.templateId));}
const itemFingerprint=item=>crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
const price=(value,buy=false)=>{C.requireThat(Number.isSafeInteger(value)&&value>=0&&value<=C.MAX_MONEY,'物品标价无效。');return buy?Math.floor(value*110/100):value;};
function quote(s,uid,mapId,ref,mode,itemId,quantity=1){const {p,n}=access(s,uid,mapId,ref);quantity=C.number(quantity,'交易数量',1,100);ok(['purchase','sell'].includes(mode),'交易方向无效。');let unitPrice,fingerprint;
 if(mode==='purchase'){const e=n.stock.find(e=>e.id===itemId);ok(e&&e.remaining>=quantity,'库存不足，请刷新货单。');unitPrice=price(e.template.value);}
 else {const item=M.transferable(s,uid,itemId,quantity);ok(buyable(n,item)&&n.buyRemaining>=quantity,'行商不收购此物品或额度不足。');unitPrice=price(item.snapshot.value,true);fingerprint=itemFingerprint(item);}
 const total=unitPrice*quantity;ok(Number.isSafeInteger(total)&&total<=C.MAX_MONEY,'交易总价超限。');
 const f={id:C.id('f'),kind:'merchantTrade',owner:uid,characterId:p.id,mapId,cell:ref,nodeId:n.id,nodeVersion:n.version,mode,itemId,quantity,unitPrice,total,itemFingerprint:fingerprint,version:0,status:'ready',expiresAt:C.confirmationDeadline(300000)};s.forms[f.id]=f;return f;
}
function execute(s,uid,id){const f=s.forms[id];ok(f?.kind==='merchantTrade'&&f.owner===uid,'行商确认不属于你。');if(f.status==='done')return C.clone(f.result);ok(f.status==='ready'&&f.expiresAt>Date.now(),'交易确认已过期。');
 const {p,m,n}=access(s,uid,f.mapId,f.cell);ok(p.id===f.characterId&&n.id===f.nodeId&&n.version===f.nodeVersion,'角色或货单已变化，请刷新重新确认。');const staged=C.clone(p);let name;
 if(f.mode==='purchase'){const e=n.stock.find(e=>e.id===f.itemId);ok(e&&e.remaining>=f.quantity&&price(e.template.value)===f.unitPrice,'库存或价格已变化。');ok(p.balance-M.reserved(s,uid).coins>=f.total,'余额不足或游戏币已被交易预留。');const stateful=['武器','防具','饰品','卡牌','配件','弹夹','钥匙'].includes(e.template.kind);for(let i=0;i<(stateful?f.quantity:1);i++)M.receive(staged,M.makeItem(e.template,stateful?1:f.quantity));staged.balance-=f.total;name=e.template.name;Object.assign(p,staged);e.remaining-=f.quantity;}
 else {const item=M.transferable(s,uid,f.itemId,f.quantity);ok(itemFingerprint(item)===f.itemFingerprint&&buyable(n,item)&&n.buyRemaining>=f.quantity&&price(item.snapshot.value,true)===f.unitPrice,'物品、收购需求或额度已变化。');ok(p.balance+f.total<=C.MAX_MONEY,'余额将超出上限。');name=item.snapshot.name;staged.inventory[f.itemId].quantity-=f.quantity;if(!staged.inventory[f.itemId].quantity)delete staged.inventory[f.itemId];staged.balance+=f.total;Object.assign(p,staged);n.buyRemaining-=f.quantity;p.showcase=(p.showcase||[]).filter(id=>p.inventory[id]);}
 n.tradeVersion=(n.tradeVersion||0)+1;m.version++;const result={id:'merchant:'+f.id,owner:uid,characterId:p.id,mapId:m.id,nodeId:n.id,mode:f.mode,name,quantity:f.quantity,unitPrice:f.unitPrice,total:f.total,createdAt:Date.now()};s.merchantTrades||={};s.merchantTrades[result.id]=result;f.status='done';f.done=true;f.result=C.clone(result);return result;
}
function restock(s,mapId,ref,templateId,quantity,buyQuota){const m=s.explorations[mapId],n=m?.cells[ref]?.room?.merchant;ok(m&&['draft','active','paused'].includes(m.status)&&n,'节点已结束或不存在。');quantity=C.number(quantity,'补货数量',0,100);buyQuota=C.number(buyQuota,'追加收购总额度',0,10000);ok(quantity||buyQuota,'请指定补货或追加额度。');if(quantity){const t=s.catalog[templateId];ok(t?.published&&t.kind!=='技能','请选择已发布实物。');const e=n.stock.find(e=>e.template.id===templateId&&e.template.version===t.version);if(e){ok(e.remaining+quantity<=10000,'单种库存超限。');e.remaining+=quantity;}else{ok(n.stock.length<100,'节点货品最多100种。');n.stock.push({id:C.id('k'),template:C.clone(t),remaining:quantity});}}
 ok(n.buyRemaining+buyQuota<=10000,'收购额度超限。');n.buyRemaining+=buyQuota;n.version++;m.version++;return n;
}
module.exports={validate,publish,matches,sample,generate,assign,clear,access,buyable,price,quote,execute,restock,itemFingerprint};
