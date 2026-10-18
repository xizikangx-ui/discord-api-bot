'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');
const Book=require('../src/rpg/player-rules'),Texts=require('../src/rpg/texts'),P=require('../src/web/game-service');
const state=()=>require('./helpers/rpg-harness').state();
test('player edition has ordered categories, unique stable chapters and current player rules',()=>{
 const rows=Book.view(state()),ids=rows.map(r=>r.key);assert.equal(new Set(ids).size,ids.length);assert.equal(new Set(rows.map(r=>r.category)).size,6);assert.ok(rows.length>=30);assert.ok(rows.every(r=>r.text&&r.label&&r.categoryTitle&&r.value===undefined));
 assert.match(rows.find(r=>r.key==='playerRule/ap').text,/100 AP.*200.*400/s);assert.match(rows.find(r=>r.key==='playerRule/life').text,/先倒地/);assert.match(rows.find(r=>r.key==='playerRule/defense').text,/120秒/);assert.match(rows.find(r=>r.key==='playerRule/maps').text,/4分钟/);
});
test('player API excludes GM chapters, legacy mixed rule text, raw defaults and operational procedures',()=>{
 const s=state();s.config.textOverrides={'rule/地图':{text:'GM_SECRET_MAP_CONFIGURATION'},'rule/GM救援裁决':{text:'GM_SECRET_JUDGEMENT'}};const rows=P.playerView(s,'1',{fields:['texts']}).texts,encoded=JSON.stringify(rows);
 assert.doesNotMatch(encoded,/GM_SECRET|rule\/GM救援裁决|\/录入|\/gm |永久删除团|textDrafts|npc-ai-v1/);assert.ok(!rows.some(r=>r.key==='rule/地图'));assert.ok(rows.every(r=>!Object.hasOwn(r,'value')));
});
test('GM can edit the separate player edition and public lore without overwriting the GM manual',()=>{
 const s=state();s.config.textOverrides={'playerRule/ap':{text:'本团公开的行动说明',version:2},'rule/世界背景':{text:'本团公开世界背景',version:3},'rule/战斗':{text:'GM操作手册',version:5}};
 assert.ok(Texts.definitions().some(r=>r.key==='playerRule/ap'));assert.equal(Texts.get(s,'rule/战斗'),'GM操作手册');const rows=Book.view(s);assert.equal(rows.find(r=>r.key==='playerRule/ap').text,'本团公开的行动说明');assert.equal(rows.find(r=>r.key==='rule/世界背景').text,'本团公开世界背景');
});
const webRoot=path.join(__dirname,'../web'),req=Module.createRequire(path.join(webRoot,'package.json'));
function component(){const build=req('esbuild').buildSync({entryPoints:[path.join(webRoot,'src/rulebook.jsx')],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},external:['react','react-dom','react-dom/*'],logLevel:'silent'}),m=new Module(path.join(webRoot,'__book_test__.cjs'),module);m.filename=path.join(webRoot,'__book_test__.cjs');m.paths=Module._nodeModulePaths(webRoot);m.require=req;m._compile(build.outputFiles[0].text,m.filename);return m.exports.PlayerRulebook;}
test('rulebook renders a real contents and reading page with navigation, not a flat GM dump',()=>{
 const React=req('react'),{renderToStaticMarkup}=req('react-dom/server'),html=renderToStaticMarkup(React.createElement(component(),{texts:[...Book.view(state()),{key:'rule/GM救援裁决',label:'内部管理员章节',text:'PRIVATE_ADMIN_TEXT'}]}));
 assert.match(html,/规则书目录/);assert.match(html,/规则正文：冒险从这里开始/);assert.match(html,/卷一 · 初入此世/);assert.match(html,/卷六 · 世界档案/);assert.match(html,/下一章/);assert.match(html,/type="search"/);assert.doesNotMatch(html,/PRIVATE_ADMIN_TEXT|内部管理员章节|<pre|<textarea/);
});
