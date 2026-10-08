'use strict';
const fs=require('node:fs'),path=require('node:path');
const directory=path.join(__dirname,'../../assets/loot'),manifest={};
const gold=['watch','medal','book','telescope','instrument','camera','tea','watch','coins','painting','archive','archive'];
const red=['gem','cufflinks','archive','instrument','sample','gem','tea','necklace','coins','jewelry','medal','archive'];
gold.forEach((name,n)=>manifest['seed_'+n+'_gold']=name);red.forEach((name,n)=>manifest['seed_'+n+'_red']=name);
manifest.special_heart='heart';manifest.special_tear='tear';
['module','lens','laser','satellite','module','archive','blueprint','rubbing','medal','chain','gem','enamel','painting','clock','book','sculpture','crucible','compass','module','earrings'].forEach((name,n)=>manifest['modern_gold_'+String(n+1).padStart(3,'0')]=name);
['goldbar','diamond','painting','datacore','archive','diamond','blueprint-v2','bracelet','archive','coins'].forEach((name,n)=>manifest['modern_red_'+String(n+1).padStart(3,'0')]=name);
for(const [id,key] of Object.entries(manifest))if(!fs.existsSync(path.join(directory,key+'.png')))delete manifest[id];
function resolve(item){const t=item.snapshot||item;if(!['gold','red'].includes(t.rarity))return null;const id=item.templateId||t.id,key=manifest[id];if(key)return fs.existsSync(path.join(directory,key+'.png'))?key:(t.rarity==='red'?'jewelry':null);
 const name=t.name||'';for(const [pattern,icon] of [[/腕表|怀表|手表/,'watch'],[/金币|古币/,'coins'],[/金条|黄金储/,'goldbar'],[/书|全集/,'book'],[/资料|档案|手稿|记录/,'archive'],[/首饰|珠宝|戒|宝石/,'jewelry'],[/相机/,'camera'],[/画|艺术/,'painting'],[/仪|模块|核心|校准/,'datacore']])if(pattern.test(name))return icon;return t.rarity==='red'?'jewelry':null;}
const uris=new Map();function uri(item){const key=resolve(item);if(!key)return null;if(!uris.has(key)){const file=path.join(directory,key+'.png');if(!fs.existsSync(file))return null;uris.set(key,'data:image/png;base64,'+fs.readFileSync(file).toString('base64'));}return uris.get(key);}
function decorate(v,item,embedIndex=0){const key=resolve(item);if(!key)return v;const file=path.join(directory,key+'.png');if(!fs.existsSync(file))return v;const name='loot-'+key+'.png';v.files||=[];if(!v.files.some(f=>f.name===name))v.files.push({attachment:file,name});v.embeds[embedIndex].setThumbnail('attachment://'+name);return v;}
function grid(v,title,items){if(items.some(item=>resolve(item)))v.rpgMap={kind:'items',title,items:items.map(item=>({name:(item.snapshot||item).name,rarity:(item.snapshot||item).rarity,quantity:item.quantity||1,templateId:item.templateId||(item.snapshot||item).id,snapshot:item.snapshot||item}))};return v;}
module.exports={manifest,resolve,uri,decorate,grid,directory};
