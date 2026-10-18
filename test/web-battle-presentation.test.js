'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');
const state=()=>import('../web/src/battle-presentation-state.js');
const hit=(overrides={})=>({total:8,target:'旧城守卫',healthBefore:{hp:12,maxHP:12},healthAfter:{hp:4,maxHP:12},perShot:[{total:8,maxRoll:true,reduced:{physical:2}}],...overrides});
const attack=(version=1,details={})=>({id:'e-a',type:'attack',actorId:'p',actorName:'远行者',at:1100,version,details:{groupId:'h-a',targetIds:['enemy'],ability:'星火弹',presentation:{kind:'skill',damageTypes:['physical','magical','mental']},...details},targetNames:['旧城守卫']});
test('live launch, settlement and real death have separate phases and HTTP/WS duplicates cannot replay',async()=>{
 const {createBattleFeedbackTracker}=await state();let now=1000;const t=createBattleFeedbackTracker({clock:()=>now});t.connect('g:me');t.baseline([]);now=1200;
 const launch={battleId:'b',event:attack(),committedAt:1100};let cues=t.ingest([launch],{source:'http'});assert.equal(cues.length,1);assert.equal(cues[0].phase,'launch');assert.equal(cues[0].damage,undefined);assert.equal(t.ingest([launch]).length,0);
 const result={id:'e-r',type:'result',actorName:'旧城守卫',at:1150,version:1,details:{hitId:'h-a',attackerId:'p',...hit()}};
 cues=t.ingest([{battleId:'b',event:result,committedAt:1150}]);assert.equal(cues[0].phase,'settle');assert.equal(cues[0].damage,8);assert.equal(cues[0].full,true);assert.equal(cues[0].killed,false);
 assert.equal(t.ingest([{battleId:'b',event:attack(2,{results:[{id:'h-a',...hit()}]}),committedAt:1180}]).length,0);
 const death={id:'e-d',type:'death',actorName:'旧城守卫',at:1190,version:1,details:{deathId:'d1',killed:true,sourceName:'远行者'}};
 cues=t.ingest([{battleId:'b',event:death,committedAt:1190}]);assert.equal(cues[0].killed,true);assert.deepEqual(cues[0].deathIds,['d1']);assert.equal(t.ingest([{battleId:'b',event:{...death,id:'e-other'},committedAt:1191}]).length,0);
});
test('partially resolved AOE seeds existing results and animates only newly settled targets',async()=>{
 const {createBattleFeedbackTracker}=await state();let now=1000;const t=createBattleFeedbackTracker({clock:()=>now});t.connect('g:me');t.baseline([{battleId:'b',eventId:'e-a',version:2,launchHitIds:['h1','h2'],settledHitIds:['h1']}]);now=1300;
 const event=attack(3,{area:{radius:10},children:[{id:'h1',name:'守卫一',result:hit()},{id:'h2',name:'守卫二',result:hit({total:3})}]});
 const cues=t.ingest([{battleId:'b',event,committedAt:1250}]);assert.equal(cues.length,1);assert.equal(cues[0].phase,'settle');assert.deepEqual(cues[0].targets,['守卫二']);assert.equal(cues[0].damage,3);
});
test('history and reconnect catch-up never replay; pending attacks can settle live after reconnect',async()=>{
 const {createBattleFeedbackTracker}=await state();let now=1000;const t=createBattleFeedbackTracker({clock:()=>now});t.connect('g:me');t.baseline([]);now=1200;
 assert.equal(t.ingest([{battleId:'b',event:attack(),committedAt:1100}],{source:'history'}).length,0);now=5000;t.connect('g:me');t.baseline([{battleId:'b',eventId:'e-a',version:1,launchHitIds:['h-a']}]);
 assert.equal(t.ingest([{battleId:'b',event:attack(),committedAt:1100}],{source:'http'}).length,0);now=5200;
 const cues=t.ingest([{battleId:'b',event:attack(2,{results:[{id:'h-a',...hit()}]}),committedAt:5100}]);assert.equal(cues.length,1);assert.equal(cues[0].phase,'settle');
 t.connect('other:me');t.baseline([]);now=5400;assert.equal(t.ingest([{battleId:'other-b',event:attack(),committedAt:5300}]).length,1);
});
test('downing, healing, fixed damage, dodge and player death do not create false kill/max prompts',async()=>{
 const {cuesForEvent,resultRows,createBattleFeedbackTracker}=await state();const result={id:'e',type:'result',actorName:'玩家',details:{hitId:'h',...hit({healthAfter:{hp:0,maxHP:12,reserveHP:12,downed:true}})}};
 assert.equal(cuesForEvent(result,'b')[0].downed,true);assert.equal(cuesForEvent(result,'b')[0].killed,false);
 assert.equal(resultRows({...result,details:{...result.details,dodge:{success:true}}})[0].full,false);
 assert.equal(resultRows({...result,details:{...result.details,perShot:[{total:8,maxRoll:false}]}})[0].full,false);
 assert.equal(cuesForEvent({id:'heal',type:'item',details:{healed:2,reserveHealed:6,healthBefore:{hp:0,maxHP:12,reserveHP:6,downed:true},healthAfter:{hp:2,maxHP:12,reserveHP:12,downed:false}}},'b')[0].revived,true);
 const t=createBattleFeedbackTracker({clock:()=>2000});t.connect('g');t.baseline([]);const death=t.ingest([{battleId:'b',committedAt:2000,event:{id:'death',type:'death',version:1,details:{deathId:'player-death',killed:false}}}]);assert.equal(death[0].killed,false);assert.equal(death[0].title,'死亡结算');
});
test('burst queue and dedupe memory are bounded while merged AOE preserves target results',async()=>{
 const {createBattleFeedbackTracker,mergeBattleCues}=await state();const t=createBattleFeedbackTracker({maxSeen:32,clock:()=>2000});t.connect('g');t.baseline([]);const entries=Array.from({length:50},(_,i)=>({battleId:'b',committedAt:2000,event:{...attack(),id:'event-'+i,details:{...attack().details,groupId:'hit-'+i}}}));const cues=t.ingest(entries);assert.ok(cues.length<=8);assert.ok(t.size()<=32);
 const rows=[hit(),hit({total:3})],merged=mergeBattleCues(rows.map((row,i)=>({battleId:'b',groupId:'same',phase:'settle',hits:[{id:'h'+i}],targets:['目标'+i],rows:[{...row,damage:row.total}],deathIds:[],id:String(i)})));assert.equal(merged.length,1);assert.equal(merged[0].rows.length,2);assert.equal(merged[0].damage,11);
});
test('battle status and deadline keep defense and current turn visible without extending expiry',async()=>{
 const {battleStatus,defenseRemaining,actionStyle}=await state();const b={status:'active',current:{actorId:'self'},actors:[{id:'self',userId:'me',name:'旅者'}],pending:[],pendingCount:0};assert.equal(battleStatus(b,'me').state,'turn');assert.equal(battleStatus({...b,pendingCount:2},'me').state,'waiting');assert.equal(battleStatus({...b,pending:[{id:'h',expiresAt:121000}]},'me').state,'defense');assert.equal(defenseRemaining(121000,1000),120);assert.equal(defenseRemaining(121000,122000),0);assert.deepEqual(actionStyle({damageTypes:['physical','magical','mental']}).types,['physical','magical','mental']);assert.equal(actionStyle({weaponType:'枪'}).projectile,false);assert.equal(actionStyle({weaponType:'突击步枪'}).projectile,true);
});
test('a battle removed from active results keeps its committed settlement and kill status',async()=>{const {battleStatus}=await state();assert.equal(battleStatus(null,'me',{phase:'settle',actor:'远行者',killed:true}).title,'击杀确认 · 结算已保存');assert.equal(battleStatus(null,'me',{phase:'settle',actor:'远行者'}).title,'结算完成');assert.equal(battleStatus(null,'me',{phase:'launch',actor:'远行者'}).title,'攻击已保存 · 等待防守');});
const webRoot=path.join(__dirname,'../web'),req=Module.createRequire(path.join(webRoot,'package.json'));
function component(name){const build=req('esbuild').buildSync({entryPoints:[path.join(webRoot,'src/battle-presentation.jsx')],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},external:['react','react-dom','react-dom/*'],logLevel:'silent'}),m=new Module(path.join(webRoot,'__battle_test__.cjs'),module);m.filename=path.join(webRoot,'__battle_test__.cjs');m.paths=Module._nodeModulePaths(webRoot);m.require=req;m._compile(build.outputFiles[0].text,m.filename);return m.exports[name];}
test('battle cards show readable saved dice, armor and both health bars; artwork carries mixed effects',async()=>{
 const React=req('react'),render=req('react-dom/server').renderToStaticMarkup,{cuesForEvent}=await state(),e={id:'r',type:'result',actorName:'旅者',details:{...hit({healthBefore:{hp:4,maxHP:12,reserveHP:12,downed:false},healthAfter:{hp:0,maxHP:12,reserveHP:12,downed:true}}),presentation:{damageTypes:['physical','magical','mental']},shots:[{rolls:{physical:{expression:'1d8',rolls:[{chosen:8}],total:8}},damage:{physical:8}}]}};
 const html=render(React.createElement(component('BattleEventDetails'),{event:e}));assert.match(html,/倒地 · 尚未死亡/);assert.match(html,/正常 HP/);assert.match(html,/倒地 HP/);assert.match(html,/护甲减免/);assert.match(html,/1d8/);assert.doesNotMatch(html,/击杀确认/);
 const cue=cuesForEvent(attack(),'b')[0],art=render(React.createElement(component('CombatArtwork'),{cue}));assert.match(art,/spell-sigil/);assert.match(art,/mental-waves/);assert.match(art,/slash-arcs/);assert.doesNotMatch(art,/damage-float/);
});
