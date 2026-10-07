'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('discord.js');
const {harness,state}=require('./helpers/rpg-harness'),C=require('../src/rpg/constants');
const {createRpg}=require('../src/rpg'),{createNavigation}=require('../src/rpg/navigation');
const {createMetrics}=require('../src/rpg/metrics');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const deadline=performance.now()+5000;while(!fn()){assert.ok(performance.now()<deadline,'timed out');await pause(10);}}
function runtime(){
 const h=harness(),s=state();s.config.gmRoleIds=['gm'];s.config.playerRoleIds=['player'];
 require('../src/rpg/content-pack').install(s);require('../src/rpg/skills').migrate(s);require('../src/rpg/ammunition').migrate(s);
 let saved=C.clone(s);h.deps.database={assertLease(){},load:async()=>C.clone(saved),save:async(_,before,next)=>{assert.equal(saved.revision,before.revision);saved=C.clone(next);}};
 h.errors=[];h.deps.logFailure=(label,error)=>h.errors.push({label,error});
 const P=D.PermissionFlagsBits;for(const [id,name]of [[h.guild.id,'所有人'],['gm','GM'],['player','玩家'],['extra','备用GM']])h.guild.roles.cache.set(id,{id,name,permissions:new D.PermissionsBitField()});
 let extra=false,visible=false;h.hidden={id:'hidden',guildId:h.guild.id,type:D.ChannelType.GuildText,permissionOverwrites:{cache:new Map()},permissionsFor:obj=>new D.PermissionsBitField(['BOT','gm'].includes(obj.id)?[P.ViewChannel,P.SendMessages,P.EmbedLinks]:obj.id==='extra'&&visible?[P.ViewChannel,...(extra?[P.SendMessages]:[])]:0n)};
 h.guild.channels={fetch:async()=>h.hidden};h.showExtra=()=>{visible=true;};h.allowExtra=()=>{visible=true;extra=true;};return h;
}
async function openChannel(h,rpg){const opened=h.interaction('GM',null,{},'rpg:rp:config');await rpg.handle(opened);return opened.result.components.flatMap(row=>row.toJSON().components).find(c=>c.type===8).custom_id;}
function selectChannel(h,id){const i=h.interaction('GM',null,{},id,['hidden']);i.message={flags:{has:()=>true}};return i;}

test('a repeated click acknowledges the in-flight operation without invalidating it or executing twice',async()=>{
 const h=runtime(),rpg=createRpg(h.deps);await rpg.start();let release,entered=false;
 const gate=new Promise(resolve=>{release=resolve;});
 try{
  const id=await openChannel(h,rpg),fetchRoles=h.guild.roles.fetch;h.guild.roles.fetch=async()=>{entered=true;await gate;return fetchRoles();};
  const first=selectChannel(h,id),work=rpg.handle(first);await until(()=>entered);
  const duplicate=selectChannel(h,id);await rpg.handle(duplicate);assert.equal(duplicate.updatedSource,true);assert.equal(duplicate.result,undefined);assert.equal(h.errors.length,0);
  release();await work;assert.match(first.result.embeds[0].data.title,/已保存/);
  const s=rpg.store.snapshot(C.DEFAULT_GUILD_ID);assert.equal(s.config.rpChannelId,'hidden');assert.ok(s.receipts[first.id]);assert.equal(s.receipts[duplicate.id],undefined);
 }finally{release?.();rpg.stop();await rpg.drain();}
});

test('RP permission refusal names the missing GM permission and preserves the selector for a safe retry',async()=>{
 const h=runtime(),rpg=createRpg(h.deps);await rpg.start();
 try{
  await rpg.store.transact(h.guild.id,'extra-role','GM',s=>s.config.gmRoleIds.push('extra'));
  h.showExtra();
  const id=await openChannel(h,rpg),denied=selectChannel(h,id);await rpg.handle(denied);
  assert.match(denied.result.content,/<@&extra>：缺少发送消息/);assert.match(denied.result.content,/<#hidden>/);
  assert.equal(denied.result.components,undefined,'partial edit must preserve the existing selector');assert.equal(h.errors.length,0);assert.equal(rpg.store.select(h.guild.id,s=>s.config.rpChannelId),null);
  h.allowExtra();const retry=selectChannel(h,id);await rpg.handle(retry);assert.match(retry.result.embeds[0].data.title,/已保存/);assert.equal(rpg.store.select(h.guild.id,s=>s.config.rpChannelId),'hidden');
 }finally{rpg.stop();await rpg.drain();}
});

test('a new interaction suppresses an old image even before the new text is ready',()=>{
 const h=harness(),s=state(),nav=createNavigation(()=>s),opened=h.interaction('1'),wrapped=nav.wrap(opened,{components:[new D.ActionRowBuilder().addComponents(new D.ButtonBuilder().setCustomId('rpg:test').setLabel('test').setStyle(D.ButtonStyle.Primary))]}),ticket=nav.ticket(opened);
 assert.equal(nav.current(opened,ticket),true);const next=h.interaction('1',null,{},wrapped.components[0].toJSON().components[0].custom_id),release=nav.resolve(next);
 assert.equal(nav.current(opened,ticket),false);release();assert.equal(nav.current(opened,ticket),true);
});

test('REST metrics distinguish endpoint limits without credentials and small-sample P95 includes the slow result',()=>{
 const lines=[],metrics=createMetrics({enabled:true,emit:line=>lines.push(line)});
 try{
  metrics.observe('interaction.result',10);metrics.observe('interaction.result',900);
  metrics.rateLimited({route:'/guilds/123456789012345678/roles/member-counts',timeToReset:60000,global:false});
  metrics.rateLimited({route:'/webhooks/123456789012345678/secret-token/messages/@original',retryAfter:2000,sublimitTimeout:2000});
  metrics.restResponse({method:'PATCH',route:'/webhooks/123456789012345678/secret-token/messages/@original'},{status:429});metrics.report();
  assert.equal(lines.length,1);const report=JSON.parse(lines[0]);assert.equal(report.stages['interaction.result'].p95,900);
  assert.equal(report.stages['discord.rateLimitWait.guild.roleCounts.resource'].p95,60000);assert.equal(report.stages['discord.rateLimitWait.interaction.reply.sublimit'].p95,2000);assert.equal(report.counters['discord.rest.PATCH.interaction.reply'],1);
  assert.doesNotMatch(lines[0],/secret-token|123456789012345678/);
 }finally{metrics.close();}
});

test('periodic application refresh skips unchanged message reads and edits but publishes changed counts',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
 let count=4,reads=0,fetches=0,edits=0;
 const config={id:'panel',name:'panel',description:'description',enabled:true,roleIds:['award'],prerequisiteRoleIds:['pre'],votesRequired:2,messages:[{channelId:'channel',messageId:'message'}]},settings={middleApplicationPanels:{panel:config}};
 const message={edit:async()=>{edits++;}},channel={messages:{fetch:async()=>{fetches++;return message;}}};
 const guild={id:'guild',roles:{fetchMemberCounts:async()=>{reads++;return new D.Collection([['award',count]]);}},channels:{fetch:async()=>channel}};
 const ctl=require('../src/middle-applications').createMiddleApplications({client:{guilds:{cache:new D.Collection([['guild',guild]])}},settingsFor:()=>settings,save:async()=>{},managerRoleId:()=>null,logFailure:(label,error)=>{throw error;}});
 ctl.start();await until(()=>edits===1);await pause(20);t.mock.timers.tick(60000);await until(()=>reads===2);await pause(20);
 assert.equal(fetches,1);assert.equal(edits,1);count=5;t.mock.timers.tick(60000);await until(()=>edits===2);assert.equal(reads,3);assert.equal(fetches,2);
});
