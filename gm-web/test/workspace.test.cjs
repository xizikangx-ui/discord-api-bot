const test=require('node:test'),assert=require('node:assert/strict');
test('map workflow, empty coordinates and obsolete responses stay scoped',async()=>{
 const {mapStage,gridCells,mapCommandAllowed,requestGate}=await import('../src/ui-state.js');
 const m={status:'draft',mode:'fixed',cells:{'0,0':{type:'entrance'},'2,0':{type:'room'}}};
 assert.equal(mapStage(m),'待布置');assert.equal(mapCommandAllowed('map.publish',m,''),false);
 m.cells['2,0'].templateId='room';assert.equal(mapStage(m),'待生成');m.cells['2,0'].room={};m.generated=true;assert.equal(mapStage(m),'可发布');
 assert.deepEqual(gridCells(3,1,m.cells).map(c=>c.ref),['0,0','1,0','2,0']);assert.equal(gridCells(3,1,m.cells)[1].cell,undefined);
 assert.equal(mapCommandAllowed('map.cell',m,'1,0'),true);m.status='active';assert.equal(mapCommandAllowed('map.cell',m,'1,0'),false);assert.equal(mapCommandAllowed('map.pause',m,''),true);
 const gate=requestGate(),old=gate.next(),fresh=gate.next();assert.equal(gate.valid(old),false);assert.equal(gate.valid(fresh),true);gate.invalidate();assert.equal(gate.valid(fresh),false);
});
test('real shared map component renders an explicit creation entry without raw JSON',async t=>{
 const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),root=path.resolve(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'map-component-'));
 t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const esbuild=require(path.join(root,'node_modules/esbuild'));
 await esbuild.build({stdin:{contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{World}from'./src/main';export const render=p=>renderToStaticMarkup(React.createElement(World,p));`,resolveDir:root,loader:'jsx'},bundle:true,platform:'node',format:'cjs',outfile:path.join(out,'component.cjs'),loader:{'.css':'empty'},alias:{react:path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')}});
 global.window={gmSession:{guildId:'test'},gmDirectory:{channels:[]},gmSchema:{commands:[]}};
 const html=require(path.join(out,'component.cjs')).render({kind:'maps',schema:{commands:[]},run:async fn=>fn(),error:()=>{},prepare:()=>{},revision:1});
 assert.match(html,/新建地图/);assert.match(html,/填写名称和主题/);assert.doesNotMatch(html,/readout|undefined|TypeError/);
 delete global.window;
});

test('channel display/read cursors reject previous room; late history preserves deletion and newer cards',async()=>{
 const {roomMessages,mergeMessages}=await import('../../web/src/chat-state.js');
 const old=[{id:'a',roomId:'old',sequence:99},{id:'b',roomId:'new',sequence:2}];assert.deepEqual(roomMessages(old,'new').map(m=>m.sequence),[2]);assert.equal(roomMessages(old,'empty').length,0);
 const latest={id:'card',roomId:'new',sequence:8,text:'new'},stale={...latest,sequence:3,text:'stale'};assert.equal(mergeMessages([latest],[stale])[0].text,'new');
 const deleted={...latest,deleted:true};assert.equal(mergeMessages([deleted],[latest])[0].deleted,true);
});
