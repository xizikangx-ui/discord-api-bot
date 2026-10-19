'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('../src/web/security');
const {createSubscriptions}=require('../src/web/subscriptions');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const access=new Set(['a','b']),rooms={ra:{id:'ra',groupId:'a'},rb:{id:'rb',groupId:'b'},secret:{id:'secret',groupId:'a',hidden:true}},sent=[],closed=[];
  let valid=true,paused;
  const accounts={session:async()=>{S.ok(valid,'请登录。','UNAUTHORIZED');return {user:{id:'u'}};},member:async group=>{if(paused)await paused;S.ok(access.has(group),'此团不可用。','FORBIDDEN');return {group:{id:group},user:{id:'u'},role:'player'};}};
  const chat={access:async(uid,id,r,a)=>{const room=rooms[id];S.ok(room,'群聊不存在。','NOT_FOUND');await accounts.member(room.groupId);S.ok(!room.hidden,'无权读取。','FORBIDDEN');return {room,a};}};
  const ws={userId:'u',credential:'test',readyState:1,bufferedAmount:0,send:data=>sent.push(JSON.parse(data)),close:(code,reason)=>{closed.push({code,reason});ws.readyState=3;}};
  const sub=createSubscriptions({accounts,chat});
  return {accounts,chat,ws,sub,sent,closed,access,setValid:v=>valid=v,pause:p=>paused=p};
}
test('serial subscriptions ignore a stale authorization result after a rapid group switch',async()=>{
  const f=fixture();let release;f.pause(new Promise(r=>release=r));
  const old=f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:1,groupId:'a',roomId:'ra',watchGroups:['a','b']}));await tick();
  const next=f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:2,groupId:'b',roomId:'rb',watchGroups:['a','b']}));release();await Promise.all([old,next]);
  assert.equal(f.ws.groupId,'b');assert.equal(f.ws.roomId,'rb');assert.deepEqual(f.sent.map(x=>x.data.requestId),[2]);assert.equal(f.closed.length,0);
});
test('a mixed group and old room only invalidates that subscription, keeping the account alive',async()=>{
  const f=fixture();await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:1,groupId:'a',roomId:'ra'}));
  await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:2,groupId:'b',roomId:'ra'}));
  assert.equal(f.sent.at(-1).type,'subscription-error');assert.equal(f.sent.at(-1).data.code,'FORBIDDEN');assert.equal(f.closed.length,0);
  await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:3,groupId:'b',roomId:'rb'}));assert.equal(f.ws.groupId,'b');
});
test('revoking a background group removes only its watch; revoking the active group drops its room',async()=>{
  const f=fixture();await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',groupId:'a',roomId:'ra',watchGroups:['a','b']}));
  f.access.delete('b');await f.sub.check(f.ws);assert.deepEqual([...f.ws.watchGroups],['a']);assert.equal(f.ws.groupId,'a');assert.equal(f.closed.length,0);
  f.access.delete('a');await f.sub.check(f.ws);assert.equal(f.ws.groupId,undefined);assert.equal(f.ws.roomId,undefined);assert.equal(f.closed.length,0);
});
test('a truly expired account session closes the connection and a hidden room never subscribes',async()=>{
  const f=fixture();await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',groupId:'a',roomId:'secret'}));assert.equal(f.ws.roomId,undefined);assert.equal(f.closed.length,0);
  f.setValid(false);await f.sub.check(f.ws);assert.equal(f.closed.at(-1).code,4001);
});
test('transient database failure keeps the accepted group while an oversized watch list is rejected',async()=>{
  const f=fixture();await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',groupId:'a',roomId:'ra'}));
  f.accounts.member=async()=>{throw Object.assign(Error('database'),{code:'08006'});};await f.sub.check(f.ws);
  assert.equal(f.ws.groupId,'a');assert.equal(f.closed.length,0);assert.equal(f.sent.at(-1).data.code,'08006');
  await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',watchGroups:Array(101).fill('a')}));assert.equal(f.ws.groupId,'a');assert.equal(f.closed.length,0);
});
test('slow socket uses bounded output and asks to resync',async()=>{
  const f=fixture();f.ws.bufferedAmount=262145;await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',groupId:'a',roomId:'ra'}));assert.equal(f.closed.at(-1).code,1013);
});
test('switching suspends the previous body feed before authorization and failure never restores it',async()=>{
 const f=fixture();await f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',groupId:'a',roomId:'ra',watchGroups:['a','b']}));
 let release;f.pause(new Promise(r=>release=r));f.access.delete('b');const pending=f.sub.enqueue(f.ws,JSON.stringify({type:'subscribe',requestId:2,groupId:'b',roomId:'rb'}));
 assert.equal(f.ws.groupId,undefined);assert.equal(f.ws.roomId,undefined);assert.equal(f.ws.watchGroups.has('a'),true);release();await pending;assert.equal(f.ws.groupId,undefined);assert.equal(f.closed.length,0);
});
