'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),Module=require('node:module');
const state=import('../web/src/exploration-state.js');
function map(extra={}){return{id:'m',name:'旧书馆',mapType:'indoor',status:'active',rows:2,width:3,entrance:'0,0',canMove:true,neighbors:['1,0','0,1'],participants:{me:{cell:'0,0',name:'执灯人'}},cells:{'0,0':{type:'entrance'},'1,0':{hidden:true},'2,0':{type:'wall'},'0,1':{type:'stairs'},'1,1':{type:'room',room:{name:'藏书室',description:'银灯照亮书页。',encounter:'resolved',unlocked:true,containers:[],supplies:[]}},'2,1':{type:'corridor'}},...extra};}
test('hidden tiles cannot leak room content, terrain, parties or furniture through the view helper',async()=>{
 const {tileView,cellName}=await state,c={hidden:true};Object.defineProperty(c,'room',{get(){throw Error('hidden content must not be read');}});Object.defineProperty(c,'type',{get(){throw Error('hidden terrain must not be read');}});const m=map({cells:{'0,0':c},participants:{me:{cell:'0,0',name:'secret party'}}}),tile=tileView(m,'0,0','me');assert.deepEqual(tile,{ref:'0,0',hidden:true,name:'未探索区域',type:'fog',party:[],connections:[]});assert.equal(cellName(c),'未探索区域');
});
test('movement uses current server eligibility and authoritative neighbors rather than a new path solver',async()=>{
 const {movementReason}=await state,m=map();assert.equal(movementReason(m,'me','1,0'),'');assert.match(movementReason(m,'me','2,0'),/相邻/);assert.match(movementReason(m,'me','0,0'),/已经/);assert.match(movementReason(m,'other','1,0'),/加入/);assert.match(movementReason({...m,rpWaiting:true},'me','1,0'),/环境/);assert.match(movementReason({...m,canMove:false,moveBlockedReason:'先完成战斗'},'me','1,0'),/先完成战斗/);
 const stale={x:{status:'pending',valid:false,expiresAt:Date.now()+100000}};assert.equal(movementReason({...m,moves:stale},'me','1,0'),'');assert.equal(movementReason({...m,canMove:undefined,moves:{x:{status:'pending',expiresAt:Date.now()-1}}},'me','1,0'),'');assert.match(movementReason({...m,canMove:undefined,moves:{x:{status:'pending',expiresAt:Date.now()+100000}}},'me','1,0'),/确认/);
 assert.match(movementReason({...m,status:'paused'},'me','1,0'),/已暂停/);assert.match(movementReason({...m,status:'draft'},'me','1,0'),/尚未发布/);assert.match(movementReason({...m,status:'ended'},'me','1,0'),/已经结束/);
});
test('indoor floor navigation and regional compass preserve the existing row semantics',async()=>{
 const {floorOf,floorChoices,boardCells,directionLabel,directionArrow}=await state,m=map();assert.equal(floorOf('2,1'),1);assert.deepEqual(floorChoices(m,'me').map(f=>f.label),['第1层','第2层']);assert.deepEqual(boardCells(m,1).map(c=>c.ref),['0,1','1,1','2,1']);assert.equal(directionLabel(m,'0,0','0,1'),'上层');assert.equal(directionLabel(m,'0,1','0,0'),'下层');assert.equal(directionLabel(m,'0,0','1,0'),'向右');const region={...m,mapType:'region'};assert.equal(boardCells(region).length,6);assert.equal(directionLabel(region,'0,0','1,0'),'向东');assert.equal(directionLabel(region,'0,0','0,1'),'向南');assert.equal(directionArrow(region,'1,0','0,0'),'←');
 assert.ok(floorChoices(m,'me')[0].current);assert.ok(floorChoices(m,'visitor').every(f=>!f.current));
});
test('irregular holes remain in place, current teammates are named, and absent cells are not playable',async()=>{
 const {boardCells,tileView}=await state,m=map();delete m.cells['1,1'];m.participants.friend={cell:'0,0',name:'观星者'};assert.equal(boardCells(m,1)[1].cell,null);assert.equal(boardCells(m,1)[2].ref,'2,1');assert.deepEqual(tileView(m,'0,0','me').party.map(p=>p.name),['执灯人','观星者']);assert.equal(tileView(m,'1,1','me').empty,true);
});
test('form drafts stay scoped to a group and map, and room item pagination preserves every item',async()=>{
 const {mapDraft,pageItems}=await state,drafts={'g:m':{cell:'1,0',key:'key',choice:{quantity:3,itemId:'i'}}};assert.equal(mapDraft(drafts,'g','m').key,'key');assert.equal(mapDraft(drafts,'other','m').cell,'');assert.equal(mapDraft(drafts,'g','other').choice.quantity,1);const items=Array.from({length:19},(_,id)=>({id})),seen=[0,1,2].flatMap(page=>pageItems(items,page).items);assert.deepEqual(seen,items);assert.equal(pageItems(items,99).index,2);assert.equal(pageItems([],99).pages,1);
});
test('only a completed building transfer follows its destination while the same view is still active',async()=>{
 const {followResultMap}=await state,context={submittedScope:'g:source',currentScope:'g:source',active:true,navigationUnchanged:true},response={status:'committed',result:{status:'completed',resultMapId:'inside'}};
 assert.equal(followResultMap('map.link',response,context),'inside');assert.equal(followResultMap('map.vote',response,context),'inside');assert.equal(followResultMap('map.move',response,context),null);assert.equal(followResultMap('map.link',{...response,result:{...response.result,status:'pending'}},context),null);
 for(const override of [{active:false},{navigationUnchanged:false},{currentScope:'other:source'},{currentScope:'g:another-map'}])assert.equal(followResultMap('map.link',response,{...context,...override}),null);
});
test('merchant controls are unavailable while paused, unjoined, waiting for RP, downed or fighting',async()=>{
 const {merchantReason}=await state,m=map(),p={hp:10};assert.equal(merchantReason(m,'me',p),'');assert.match(merchantReason({...m,status:'paused'},'me',p),/暂停/);assert.match(merchantReason(m,'visitor',p),/加入/);assert.match(merchantReason({...m,rpWaiting:true},'me',p),/环境/);assert.match(merchantReason(m,'me',{hp:0,health:{downed:true}}),/倒地/);assert.match(merchantReason(m,'me',p,true),/战斗/);
});
const webRoot=path.join(__dirname,'../web'),webRequire=Module.createRequire(path.join(webRoot,'package.json'));
function component(entry,name){const esbuild=webRequire('esbuild'),built=esbuild.buildSync({entryPoints:[path.join(webRoot,'src',entry)],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},external:['react','react-dom','react-dom/*'],logLevel:'silent'}),mod=new Module(path.join(webRoot,'__exploration_test__.cjs'),module);mod.filename=path.join(webRoot,'__exploration_test__.cjs');mod.paths=Module._nodeModulePaths(webRoot);mod.require=webRequire;mod._compile(built.outputFiles[0].text,mod.filename);return mod.exports[name];}
const React=webRequire('react'),{renderToStaticMarkup}=webRequire('react-dom/server');
test('SSR board keeps map selection separate from current position and does not emit hidden details',()=>{
 const Board=component('exploration-map.jsx','ExplorationBoard'),m=map();m.cells['1,0']={hidden:true,name:'secret building',type:'building',room:{name:'secret boss',description:'private lore'},buildingMapId:'secret map'};let calls=0;const html=renderToStaticMarkup(React.createElement(Board,{map:m,userId:'me',floor:0,selected:'1,0',onSelect:()=>calls++}));assert.match(html,/data-current="true"/);assert.match(html,/data-hidden="true"/);assert.match(html,/aria-pressed="true"/);assert.match(html,/未探索区域/);assert.doesNotMatch(html,/secret|private lore/);assert.equal(calls,0);
});
test('SSR exploration opens the joined map and current floor, shows resources, and never executes a command on render',()=>{
 const Panel=component('exploration-panel.jsx','ExplorationPanel'),m=map({participants:{me:{cell:'1,1',name:'执灯人'}},neighbors:['0,1','2,1']}),game={revision:1,player:{userId:'me',inventory:{}},maps:[map({id:'other',name:'无关地图',participants:{}}),m],roster:[]};m.cells['1,1'].room.supplies=[{id:'medicine',quantity:2,snapshot:{name:'绷带',kind:'药品',rarity:'white'}}];let calls=0;const html=renderToStaticMarkup(React.createElement(Panel,{game,groupId:'g',userId:'me',prepare:()=>calls++}));assert.match(html,/<h3>旧书馆<\/h3>/);assert.match(html,/data-map-cell="1,1"/);assert.doesNotMatch(html,/data-map-cell="0,0"/);assert.match(html,/散落物资/);assert.match(html,/绷带/);assert.match(html,/拾取/);assert.match(html,/定位队伍/);assert.match(html,/室内楼层/);assert.equal(calls,0);
});
test('map artwork contains no runtime network calls or continuous animation',()=>{
 const css=fs.readFileSync(path.join(webRoot,'src/exploration.css'),'utf8'),art=fs.readFileSync(path.join(webRoot,'src/exploration-map.jsx'),'utf8');assert.doesNotMatch(css,/@keyframes|animation\s*:/);assert.doesNotMatch(art,/fetch\(|api\(|Worker\(|setInterval\(/);assert.match(css,/@media\(max-width:760px\)/);
});
