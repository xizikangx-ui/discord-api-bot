'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('music resume preserves the position; only explicit restart requests zero',async()=>{
  const {trackPlaybackAction}=await import('../web/src/music-state.js');
  for(const status of ['paused','playing'])assert.deepEqual(trackPlaybackAction({trackId:'a',status},'a'),{action:'resume',trackId:'a'});
  assert.deepEqual(trackPlaybackAction({trackId:'a',status:'paused'},'b'),{action:'play',trackId:'b'});
  assert.deepEqual(trackPlaybackAction({trackId:'a',status:'paused'},'a',true),{action:'play',trackId:'a',position:0});
});
test('music timeline uses the saved pause, server offset, and loop without restarting on metadata changes',async()=>{
  const {playbackPosition,playbackSignature,musicTime}=await import('../web/src/music-state.js');
  const library={serverTime:105000,receivedAt:200000,playback:{trackId:'a',status:'playing',startedAt:100000,position:12,loop:false,version:3}};
  assert.equal(playbackPosition(library,202000),19);
  const renamed={...library,playback:{...library.playback,version:4}};
  assert.equal(playbackSignature(renamed.playback),playbackSignature(library.playback));
  assert.equal(playbackPosition({...library,playback:{...library.playback,status:'paused',startedAt:null}},999999),12);
  assert.equal(playbackPosition(library,202000,15),15);
  assert.equal(playbackPosition({...library,playback:{...library.playback,loop:true}},202000,15),4);
  assert.equal(musicTime(125.6),'2:05');
});
test('a delayed music response cannot undo a newer pause or track selection',async()=>{
  const {mergeMusicSnapshot}=await import('../web/src/music-state.js'),latest={playback:{trackId:'b',status:'paused',version:8,position:35},serverTime:200000,receivedAt:300000,tracks:[]};
  const old={playback:{trackId:'a',status:'playing',version:7,position:0},serverTime:199999,receivedAt:300010,tracks:[{id:'a'}]};
  assert.deepEqual(mergeMusicSnapshot(latest,old),{...old,playback:latest.playback,serverTime:latest.serverTime,receivedAt:latest.receivedAt});
  assert.equal(mergeMusicSnapshot(latest,{...old,playback:{...old.playback,version:9}}).playback.trackId,'a');
});
test('catalog versions protect a same-version retirement projection from delayed playback and old lists',async()=>{
  const {mergeMusicSnapshot}=await import('../web/src/music-state.js'),current={playback:{trackId:null,status:'stopped',version:8,libraryVersion:5},tracks:[{id:'a',retired:true}],library:{version:5},serverTime:200000,receivedAt:300000},old={playback:{trackId:'a',status:'playing',version:8,libraryVersion:4},tracks:[{id:'a',retired:false}],library:{version:4},serverTime:199999,receivedAt:300010};
  assert.deepEqual(mergeMusicSnapshot(current,old),current);
  const fresh={...current,library:{version:6},tracks:[{id:'a',retired:false}],playback:{...current.playback,libraryVersion:6}};
  assert.deepEqual(mergeMusicSnapshot(current,fresh),fresh);
});
test('chat-first console starts collapsed, migrates only the selected page and remembers explicit choices',async()=>{
  const {consoleKey,readConsole,saveConsole}=await import('../web/src/console-state.js'),data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,v)=>data.set(key,v)},key=consoleKey('u','g',false);
  assert.equal(readConsole(storage,key,false).open,false);
  data.set(key.replace('v2:','v1:'),JSON.stringify({open:true,pane:'skills'}));
  assert.deepEqual(readConsole(storage,key,false),{open:false,pane:'skills'});
  saveConsole(storage,key,{open:true,pane:'bag'});
  assert.deepEqual(readConsole(storage,key,false),{open:true,pane:'bag'});
  assert.equal(readConsole(storage,consoleKey('u','other',false),false).open,false);
  assert.equal(readConsole(storage,consoleKey('u','g',true),true).open,false);
});
test('red task badges correspond to current actionable objects and disappear when tasks clear',async()=>{
  const {taskCounts,contextPosition}=await import('../web/src/chat-shell.js');
  assert.deepEqual(taskCounts([{system:{battleId:'b',kind:'webDefense',hitId:'h'}},{system:{mapId:'m'}},{tab:'bag'}]),{battle:1,explore:1,bag:1});
  assert.deepEqual(taskCounts([]),{});
  assert.deepEqual(taskCounts([{system:{battleId:'b',kind:'webNotice'}}],true),{gm:1});
  assert.deepEqual(taskCounts([{system:{mapId:'m',kind:'webEncounterWait',cell:'1,0'}}],true),{gm:1});
  assert.deepEqual(taskCounts([{system:{mapId:'m',kind:'webEncounterWait',cell:'1,0'}}]),{explore:1});
  assert.deepEqual(contextPosition(999,999,390,844),{left:152,top:374});
  assert.deepEqual(contextPosition(-1,-1,1280,720),{left:8,top:8});
});
