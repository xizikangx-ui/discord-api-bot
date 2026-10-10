'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('discord.js');
const {deadlineTimer,archiveReminders,discordCacheOptions,renewLongTimeouts}=require('../src/economy');
const {createScheduledPunishments,scheduledPunishmentCommands}=require('../src/scheduled-punishments');
const settle=async()=>{for(let n=0;n<30;n++)await new Promise(setImmediate);};
test('empty deadline queues have no polling; changes replace the timer',()=>{
 let calls=0,cb;const pending=new Map();let seq=0,now=100;
 const timer=deadlineTimer(()=>calls++,{now:()=>now,set:(f,ms)=>{cb=f;pending.set(++seq,ms);return seq;},clear:id=>pending.delete(id)});
 timer.at(Infinity);assert.equal(pending.size,0);timer.at(200);assert.equal([...pending.values()][0],100);
 timer.at(150);assert.equal(pending.size,1);assert.equal([...pending.values()][0],50);pending.clear();cb();assert.equal(calls,1);timer.stop();timer.at(300);assert.equal(pending.size,0);
});
test('reminder archive is idempotent and catches reminders restored from older backups',()=>{
 const s={reminders:[{id:'old',nextAt:1,content:'private'}],warningFollowups:[{id:'warning'}]};
 assert.equal(archiveReminders(s,100),true);assert.deepEqual(s.reminders,[]);assert.equal(s.disabledReminderArchive.length,1);
 assert.equal(archiveReminders(s,200),false);s.reminders=[{id:'old'},{id:'restored'}];archiveReminders(s,300);
 assert.equal(s.disabledReminderArchive.length,2);assert.equal(s.disabledReminderArchive[0].disabledAt,100);assert.equal(s.warningFollowups.length,1);
});
test('bounded Discord caches retain the bot and evict other members without changing role caches',()=>{
 const options=discordCacheOptions(D.Options,()=> 'BOT');
 const members=options.makeCache({name:'GuildMemberManager'},null,{name:'GuildMemberManager'}),users=options.makeCache({name:'UserManager'},null,{name:'UserManager'}),messages=options.makeCache({name:'MessageManager'},null,{name:'MessageManager'});
 members.set('BOT',{id:'BOT'});users.set('BOT',{id:'BOT'});
 for(let n=0;n<1200;n++){members.set(String(n),{id:String(n)});users.set(String(n),{id:String(n)});messages.set(String(n),{id:String(n)});}
 assert.ok(members.has('BOT'));assert.ok(users.has('BOT'));assert.ok(members.size<=201);assert.ok(users.size<=1001);assert.equal(messages.size,20);assert.equal(options.sweepers.messages.lifetime,600);
});
test('long timeout maintenance does no reads or writes when nothing is due; revocation wins an in-flight read',async()=>{
 let jobs=[{endAt:Date.now()+1e8,nextRefreshAt:Date.now()+1e6}],reads=0,saves=0,renewals=0;
 const deps={jobs:()=>jobs,remove:j=>jobs=jobs.filter(x=>x!==j),fetchMember:async()=>{reads++;return {};},renew:async()=>{renewals++;},save:async()=>{saves++;},onError:e=>{throw e;},refreshWindow:1e7,day:86400000};
 await renewLongTimeouts(deps);assert.equal(reads+saves+renewals,0);
 jobs[0].nextRefreshAt=0;deps.fetchMember=async()=>{reads++;jobs=[];return {};};await renewLongTimeouts(deps);assert.equal(renewals,0);assert.equal(saves,0);
 jobs=[{endAt:Date.now()+1e8,nextRefreshAt:0}];deps.fetchMember=async()=>({});await renewLongTimeouts(deps);assert.equal(renewals,1);assert.equal(saves,1);
});
function appointments(t,{executeError=false}={}) {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1800000000000});
 const setting={},saved=[],errors=[];let executed=0,allowed=true,busy=false;
 const message={id:'notice',channelId:'channel',edit:async()=>{}},channel={send:async()=>message,messages:{fetch:async()=>message},isThread:()=>false};
 const member={user:{id:'GM'}},guild={id:'guild',members:{fetch:async()=>member},channels:{fetch:async()=>channel}};
 const deps={client:{guilds:{fetch:async()=>guild},channels:{fetch:async()=>channel}},settingsFor:()=>setting,guildIds:()=>['guild'],scopeFor:()=>['guild'],
 authorized:()=>allowed,validate:async()=>{},execute:async()=>{executed++;if(executeError)throw Error('timeout after send');return 'done';},save:async()=>saved.push(structuredClone(setting)),hasCase:()=>false,targetBusy:()=>busy,logFailure:(...args)=>errors.push(args)};
 let seq=0;const i=(commandName,opts={},customId)=>({id:String(++seq),guildId:'guild',guild,user:{id:'GM'},channelId:'channel',channel,
  isChatInputCommand:()=>!!commandName,isButton:()=>!!customId,commandName,customId,
  options:{getUser:k=>k==='成员'?{id:'target'}:null,getString:k=>opts[k]??null,getInteger:k=>opts[k]??null},deferReply:async()=>{},editReply:async function(v){this.result=v;}});
 const ctl=createScheduledPunishments(deps);t.after(()=>ctl.stop());
 const book=async minutes=>{const preview=i('预约处罚',{'方式':'timeout','原因':'test','等待分钟':minutes,'禁言分钟':10});await ctl.handle(preview);const id=preview.result.components[0].toJSON().components[0].custom_id;const confirm=i(null,{},id);await ctl.handle(confirm);return setting.scheduledPunishments.at(-1);};
 return {ctl,book,setting,i,deps,get executed(){return executed;},set allowed(v){allowed=v;},set busy(v){busy=v;}};
}
for(const minutes of [20,40,60])test(`appointment waits ${minutes} minutes, persists the deadline and executes only once`,async t=>{
 const h=appointments(t);await h.ctl.start();const job=await h.book(minutes);assert.equal(job.dueAt-job.createdAt,minutes*60000);
 t.mock.timers.tick(minutes*60000-1);await settle();assert.equal(h.executed,0);t.mock.timers.tick(1);await settle();assert.equal(h.executed,1);assert.equal(job.status,'completed');
 t.mock.timers.tick(3600000);await settle();assert.equal(h.executed,1);
});
test('old appointment dueAt survives restart; ambiguous execution is never retried',async t=>{
 const h=appointments(t,{executeError:true});h.setting.scheduledPunishments=[{id:'legacy',caseId:'case',guildId:'guild',scopeGuildIds:['guild'],userId:'target',moderatorId:'GM',sourceChannelId:'channel',mode:'timeout',reason:'legacy',dueAt:Date.now()+86400000,status:'pending'}];
 await h.ctl.start();assert.equal(h.setting.scheduledPunishments[0].dueAt,Date.now()+86400000);t.mock.timers.tick(86400000);await settle();assert.equal(h.executed,1);assert.equal(h.setting.scheduledPunishments[0].status,'uncertain');
 h.ctl.stop();const restarted=createScheduledPunishments(h.deps);t.after(()=>restarted.stop());await restarted.start();t.mock.timers.tick(86400000);await settle();assert.equal(h.executed,1);
});
test('appointment cancellation and current permission loss prevent execution',async t=>{
 const h=appointments(t);await h.ctl.start();const first=await h.book(20);await h.ctl.handle(h.i('解除预约处罚',{'编号':first.id}));assert.equal(first.status,'cancelled');
 const second=await h.book(20);h.allowed=false;t.mock.timers.tick(20*60000);await settle();assert.equal(h.executed,0);assert.equal(second.status,'failed');
});
test('busy target retries at most once per minute and does not spin',async t=>{
 const h=appointments(t);await h.ctl.start();await h.book(20);h.busy=true;t.mock.timers.tick(20*60000);await settle();assert.equal(h.executed,0);h.busy=false;t.mock.timers.tick(60000);await settle();assert.equal(h.executed,1);
});
test('appointment command requires an explicit allowed waiting duration',()=>{
 const json=scheduledPunishmentCommands[0].toJSON(),o=json.options.find(o=>o.name==='等待分钟');assert.equal(o.required,true);assert.deepEqual(o.choices.map(c=>c.value),[20,40,60]);
});
test('text maps mask unexplored rooms and clear attachments while retaining image access',()=>{
 const {textView}=require('../src/rpg/discord-display'),{board}=require('../src/rpg/exploration-ui');
 const m={id:'m',name:'map',status:'active',width:2,floors:1,cells:{'0,0':{type:'entrance'},'1,0':{type:'room',name:'SECRET'}},revealed:{'0,0':true},participants:{}};
 const v=textView(board(m));assert.equal(v.embeds[0].data.image,undefined);assert.deepEqual(v.attachments,[]);assert.ok(JSON.stringify(v).includes('??'));assert.ok(!JSON.stringify(v).includes('SECRET'));assert.ok(v.components.some(r=>r.toJSON().components.some(c=>c.label==='查看图片')));
});
test('one render worker is lazy, deduplicates identical requests and releases native state after idle',async()=>{
 const {createRenderer}=require('../src/rpg/map-image');const renderer=createRenderer({workerCount:1,idleMs:40,cacheBytes:100000,cacheTtl:60});
 try{assert.equal(renderer.stats().workers,0);const svg='<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
 const [a,b]=await Promise.all([renderer.queue(svg),renderer.queue(svg)]);assert.deepEqual(a,b);assert.equal(renderer.stats().workers,1);assert.equal(renderer.stats().cacheEntries,1);
 await new Promise(r=>setTimeout(r,160));assert.equal(renderer.stats().workers,0);assert.equal(renderer.stats().cacheEntries,0);
 const defaults=createRenderer({});try{assert.equal(defaults.workers.length,2);}finally{defaults.close();}
 }finally{renderer.close();}
});
test('uncached nickname updates coalesce for 30 seconds and fetch current membership before restoring',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1800000000000});
 let reads=0,restores=0;const settings={nicknamePolicy:{enabled:true,locks:{target:{violationRoleId:'bad'}},operatorRoleIds:[]}};
 const guild={id:'guild',members:{cache:new D.Collection(),fetchMe:async()=>({permissions:new D.PermissionsBitField(D.PermissionFlagsBits.ManageNicknames)}),fetch:async()=>{reads++;return member;}}};
 const member={id:'target',user:{bot:false},guild,manageable:true,nickname:'changed',roles:{cache:new D.Collection([['bad',{}]])},setNickname:async()=>{restores++;}};
 const ctl=require('../src/nickname-panel').createNicknamePanel({client:{guilds:{cache:new D.Collection([['guild',guild]])}},settingsFor:()=>settings,save:async()=>{},logFailure:(_,e)=>{throw e;}});
 for(let n=0;n<20;n++)ctl.onRaw({t:'GUILD_MEMBER_UPDATE',d:{guild_id:'guild',user:{id:'target'},roles:['bad']}});
 t.mock.timers.tick(29999);await settle();assert.equal(reads,0);t.mock.timers.tick(1);await settle();assert.equal(reads,1);assert.equal(restores,1);
 member.roles.cache.clear();ctl.onRaw({t:'GUILD_MEMBER_UPDATE',d:{guild_id:'guild',user:{id:'target'},roles:[]}});t.mock.timers.tick(30000);await settle();assert.equal(restores,1);assert.equal(settings.nicknamePolicy.locks.target,undefined);
});
test('hourly warning batches never remove roles or send followups early and do not save empty scans',async()=>{
 const {processWarnings}=require('../src/economy');let reads=0,removed=0,sent=0,saves=0;
 const s={warningExpirations:[{id:'case',guildId:'guild',userId:'user',roleId:'warning',expiresAt:1800000}],warningFollowups:[{id:'dm',dueAt:86400000,userId:'user'}]};
 const guild={members:{fetch:async options=>{reads++;assert.equal(options.force,true);return {roles:{cache:new Map([['warning',{}]]),remove:async()=>{removed++;}}};}},roles:{fetch:async()=>({id:'warning'})}};
 const deps={state:()=>s,fetchUser:async()=>({send:async()=>{sent++;}}),fetchGuild:async()=>guild,save:async()=>{saves++;},onError:(_,e)=>{throw e;}};
 await processWarnings({...deps,now:0});assert.equal(reads+removed+sent+saves,0);
 await processWarnings({...deps,now:3600000});assert.equal(removed,1);assert.equal(sent,0);assert.equal(saves,1);
 await processWarnings({...deps,now:86399999});assert.equal(sent,0);assert.equal(saves,1);
 await processWarnings({...deps,now:86400000});assert.equal(sent,1);assert.equal(saves,2);await processWarnings({...deps,now:90000000});assert.equal(saves,2);
});
test('member event storms reduce automatic role-count queries by over 90% without unchanged message edits or saves',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1800000000000});let reads=0,edits=0,saves=0;
 const config={id:'panel',name:'panel',description:'description',enabled:true,roleIds:['award'],prerequisiteRoleIds:[],votesRequired:2,messages:[{channelId:'channel',messageId:'message'}]},settings={middleApplicationPanels:{panel:config}};
 const guild={id:'guild',members:{cache:new D.Collection()},roles:{fetchMemberCounts:async()=>{reads++;return new D.Collection([['award',4]]);}},channels:{fetch:async()=>({messages:{fetch:async()=>({edit:async()=>{edits++;}})}})}};
 const ctl=require('../src/middle-applications').createMiddleApplications({client:{guilds:{cache:new D.Collection([['guild',guild]])}},settingsFor:()=>settings,save:async()=>{saves++;},managerRoleId:()=>null,logFailure:(_,e)=>{throw e;}});
 ctl.start();await settle();assert.equal(reads,1);
 for(let minute=0;minute<60;minute++){for(let n=0;n<20;n++)ctl.onRaw({t:'GUILD_MEMBER_UPDATE',d:{guild_id:'guild',user:{id:String(n)},roles:['award']}});t.mock.timers.tick(60000);await settle();}
 assert.ok(reads<=5);assert.ok(1-reads/61>=.9);assert.equal(edits,1);assert.equal(saves,0);
 console.log(JSON.stringify({type:'role-count-isolation',minutes:60,memberEvents:1200,queries:reads,minuteBaseline:61,reduction:1-reads/61}));
});
test('votes persist immediately while public totals coalesce; saved cutoff does not move',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1800000000000});let edits=0,writes=0;
 let data={kind:'anonymous-poll',id:'poll',guildId:'guild',channelId:'public',messageId:'message',creatorId:'voter',type:'ordinary',status:'open',title:'test',options:['yes','no'],maxChoices:1,votes:{},events:[],createdAt:Date.now(),endsAt:Date.now()+120000};
 const end=data.endsAt,meta={id:'poll',guildId:'guild',channelId:'public',messageId:'message',archiveMessageId:'archive-message',status:'open',endsAt:end},settings={pollIndexes:[meta]};
 const archiveMessage={author:{id:'BOT'},attachments:new D.Collection([['file',{name:'poll-poll.json.enc',url:'https://example.invalid/encrypted'}]]),edit:async p=>{writes++;data=JSON.parse(Buffer.from(p.files[0].attachment).toString()).v;}};
 const archive={guildId:'archive-guild',type:D.ChannelType.GuildText,guild:{roles:{everyone:{id:'everyone'}}},permissionsFor:who=>new D.PermissionsBitField(who.id==='everyone'?0n:D.PermissionFlagsBits.Administrator),messages:{fetch:async()=>archiveMessage}};
 const client={user:{id:'BOT'},channels:{fetch:async id=>id==='archive'?archive:{messages:{fetch:async()=>({edit:async()=>{edits++;}})}}}};
 t.mock.method(global,'fetch',async()=>({ok:true,json:async()=>({v:data})}));
 const ctl=require('../src/polls').createPolls({client,settingsFor:()=>settings,guildIds:()=>['guild'],save:async()=>{},encrypt:v=>JSON.stringify({v}),decrypt:e=>({encrypted:true,value:e.v}),archiveChannelId:'archive',archiveGuildId:'archive-guild',manager:()=>false,logFailure:(_,e)=>{throw e;}});
 await ctl.start();assert.equal(edits,1);
 const vote=value=>({guildId:'guild',guild:{members:{fetch:async()=>({user:{bot:false}})}},user:{id:'voter',bot:false},channelId:'public',message:{id:'message',author:{id:'BOT'}},customId:'poll-vote:poll',values:[String(value)],isChatInputCommand:()=>false,isButton:()=>false,isStringSelectMenu:()=>true,isModalSubmit:()=>false,deferReply:async()=>{},editReply:async()=>{}});
 await ctl.handle(vote(0));await ctl.handle(vote(1));assert.equal(writes,2);assert.deepEqual(data.votes.voter.choices,[1]);assert.equal(edits,1);assert.equal(data.endsAt,end);
 t.mock.timers.tick(59999);await settle();assert.equal(edits,1);t.mock.timers.tick(1);await settle();assert.equal(edits,2);
 t.mock.timers.tick(60000);await settle();assert.equal(data.status,'closed');assert.equal(data.endsAt,end);assert.equal(data.events.filter(e=>e.action==='deadline').length,1);
});
test('idle RPG scans never copy the archive; 20/50 text requests do not invoke blocked rendering',async()=>{
 const {harness,state,fight}=require('./helpers/rpg-harness'),{createRpg}=require('../src/rpg'),C=require('../src/rpg/constants');
 const h=harness(),s=state();s.config.gmRoleIds=['gm'];s.config.playerRoleIds=['player'];
 require('../src/rpg/content-pack').install(s);require('../src/rpg/skills').migrate(s);require('../src/rpg/ammunition').migrate(s);
 const {b}=fight(s);let saved=structuredClone(s),renders=0;
 h.deps.database={assertLease(){},load:async()=>structuredClone(saved),save:async(_,before,next)=>{assert.equal(saved.revision,before.revision);saved=structuredClone(next);}};
 h.deps.renderer={decorate:async()=>{renders++;throw Error('blocked render');},close(){}};
 const rpg=createRpg(h.deps);try{
  await rpg.start();await settle();await rpg.outbox.drain();rpg.outbox.stop();const snapshot=rpg.store.snapshot;let copies=0;rpg.store.snapshot=(...args)=>{copies++;return snapshot(...args);};
  const before=JSON.stringify(saved);for(let n=0;n<60;n++)await rpg.tickGuild(C.DEFAULT_GUILD_ID);assert.equal(copies,0);assert.equal(JSON.stringify(saved),before);
  for(const count of [20,50]){const durations=await Promise.all(Array.from({length:count},async()=>{const i=h.interaction('1',null,{},'rpg:personal:'+b.id),start=performance.now();await rpg.handle(i);assert.equal(i.result.files.length,0);assert.ok(i.result.embeds[0].data.description.includes('动作点'));return performance.now()-start;}));durations.sort((a,b)=>a-b);const p95=durations[Math.ceil(count*.95)-1];assert.ok(p95<3000);console.log(JSON.stringify({type:'isolated-text-load',requests:count,resultP95ms:Math.round(p95),environment:process.platform+' local fake transport'}));}
  assert.equal(renders,0);assert.ok(rpg.store.select(C.DEFAULT_GUILD_ID,s=>s.battles[b.id].current));
 }finally{rpg.stop();await rpg.drain();}
});
