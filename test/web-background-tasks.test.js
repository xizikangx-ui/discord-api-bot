"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundTasks}=require('../src/web/background-tasks');
test('shutdown drains delayed notifications before closing storage and rejects later work',async()=>{
  let release,finished=false,drained=false,late=false;
  const delay=new Promise(resolve=>{release=resolve;}),tasks=createBackgroundTasks();
  tasks.run(async()=>{await delay;finished=true;});
  tasks.seal();tasks.run(()=>{late=true;});
  const shutdown=tasks.drain().then(()=>{drained=true;assert.equal(finished,true);});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
  release();await shutdown;assert.equal(late,false);
});
test('failed broadcasts are contained while shutdown still drains successful work',async()=>{
  let errors=0,finished=false;const tasks=createBackgroundTasks(()=>{errors++;});
  tasks.run(()=>{throw Error('isolated notification failure');});
  tasks.run(()=>{finished=true;});tasks.seal();await tasks.drain();
  assert.equal(errors,1);assert.equal(finished,true);await tasks.drain();
});
test('game shutdown drains the active publication pump despite repeated ticks and timer wakeups',{timeout:5000},async t=>{
  const C=require('../src/rpg/constants'),repo=require('./helpers/web-demo.cjs').memoryRepository(),group='shutdown-pump-test',saved=new Map([[group,C.newState(group)]]);
  let writes=0,sends=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),database={assertLease(){},load:async id=>C.clone(saved.get(id)||null),save:async(id,before,next)=>{writes++;saved.set(id,C.clone(next));}};
  await repo.put('group',{id:group,name:'停机隔离验证',autoSync:false});await repo.put('room',{id:'shutdown-gm-room',groupId:group,kind:'gm',name:'GM隐藏',sequence:0},{scope:group});
  const games=require('../src/web/games').createGames({database,repo,accounts:{},library:{published:async()=>[]},chat:{send:async()=>{entered();await gate;sends++;return{id:'shutdown-message'};},upsertSystem:async()=>{throw Error('unexpected public card');}}});
  t.after(async()=>{release();await games.stop();});
  await games.ensure(group);await games.store.transact(group,'queue-shutdown-notice','system:web',s=>{s.deliveryJobs||={};s.deliveryJobs['shutdown-notice']={key:'shutdown-notice',kind:'webNotice',text:'受控通知',status:'pending',priority:0,desiredRevision:s.revision+1};return{queued:true};},'停机测试通知',{delivery:false});
  games.start();await started;
  let ticksFinished=false,stopped=false;
  const ticks=Promise.all([games.tick(),games.tick(),games.tick()]).then(()=>{ticksFinished=true;});
  // A commit wakes the zero-delay timer while chat.send is still blocked.
  // This exercises the timer path that used to replace the real pump promise.
  await games.store.transact(group,'wake-blocked-shutdown-pump','system:web',()=>({wake:true}),'唤醒受阻通知循环',{delivery:false});
  await new Promise(resolve=>setTimeout(resolve,20));
  const writesAtGate=writes,shutdown=games.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,false,'stop must wait for the in-flight notification');assert.equal(ticksFinished,false,'extra ticks must still await the active pump');assert.equal(sends,0);assert.equal(writes,writesAtGate);
  release();await shutdown;await ticks;
  assert.equal(sends,1);assert.equal(games.store.select(group,s=>s.deliveryJobs['shutdown-notice'].status),'done');assert.equal(writes,writesAtGate+1,'the in-flight delivery receipt is saved before stop returns');
  const finalWrites=writes,finalRevision=games.store.select(group,s=>s.revision);await Promise.all([games.tick(),games.tick()]);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(writes,finalWrites,'stopped pumps cannot issue later transactions');assert.equal(games.store.select(group,s=>s.revision),finalRevision);assert.equal(sends,1);
});
