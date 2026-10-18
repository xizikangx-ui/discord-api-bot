'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const S=require('../src/web/security'),Music=require('../src/web/music');
const op=()=>crypto.randomUUID(),audio=()=>Buffer.concat([Buffer.from('ID3'),Buffer.alloc(128)]);
async function cases(t,h){
 const first=h.group.id,second=(await h.app.accounts.createGroup(h.user,{name:'共享音乐另一团'},op())).id;
 await h.app.games.ensure(second);
 // A second GM can select shared music, but cannot rename/retire another GM's upload.
 await h.repo.put('member',{id:second+':'+h.player.user.id,userId:h.player.user.id,groupId:second,role:'gm',active:true,version:1},{scope:second});
 const path=g=>'/groups/'+g+'/music',read=async(g=first,who=h.admin)=>(await h.request(who,path(g))).data;
 const command=async(g,action,extra={},who=h.admin)=>{const state=await read(g,who);return h.request(who,path(g)+'/control',{operationId:op(),action,baseVersion:state.playback.version,...extra});};
 let track,secondTrack,secondPlay;
 await t.test('all groups discover the same private library, with separate playback and owner-only management',async()=>{
  const p={operationId:op(),name:'共享战斗主题',category:'battle',loop:true,data:audio().toString('base64')};
  const r=await h.request(h.admin,path(first)+'/upload',p);assert.equal(r.status,200);track=r.data;
  const other=await read(second,h.player),shared=other.tracks.find(f=>f.id===track.id);
  assert.ok(shared);assert.equal(shared.canManage,false);assert.equal(shared.ownerId,h.user.id);assert.equal(other.library.maxBytes,300*1024*1024);assert.equal(other.library.maxTrackBytes,12*1024*1024);
  const played=await command(second,'play',{trackId:track.id},h.player);assert.equal(played.status,200);secondPlay=played.data.playback;
  assert.equal((await read(first)).playback.status,'stopped');assert.equal((await read(second)).playback.trackId,track.id);
  const denied=await command(second,'retire',{trackId:track.id,trackVersion:track.version},h.player);assert.equal(denied.status,403);
  secondTrack=(await h.request(h.player,path(second)+'/upload',{...p,operationId:op(),name:'另一位GM上传的主题'})).data;
  assert.equal((await read(first)).tracks.find(f=>f.id===secondTrack.id).canManage,true);
 });
 await t.test('pause saves elapsed position; continue and same-track play never restart without an explicit zero',async()=>{
  assert.equal((await command(first,'play',{trackId:track.id,position:7})).status,200);
  let state=await h.repo.get('musicState',first);state.startedAt=Date.now()-42000;await h.repo.put('musicState',state,{scope:first});
  const paused=await command(first,'pause');assert.equal(paused.status,200);assert.equal(paused.data.playback.status,'paused');assert.equal(paused.data.playback.startedAt,null);assert.ok(paused.data.playback.position>=49&&paused.data.playback.position<51);
  const resumed=await command(first,'resume');assert.equal(resumed.status,200);assert.equal(resumed.data.playback.position,paused.data.playback.position);assert.equal(resumed.data.playback.trackId,track.id);
  const same=await command(first,'play',{trackId:track.id});assert.ok(same.data.playback.position>=paused.data.playback.position);
  const restart=await command(first,'play',{trackId:track.id,position:0});assert.equal(restart.data.playback.position,0);
  const seek=await command(first,'seek',{position:120});assert.equal(seek.data.playback.position,120);
  const pauseAgain=await command(first,'pause'),seekPaused=await command(first,'seek',{position:33});assert.equal(seekPaused.data.playback.status,'paused');assert.equal(seekPaused.data.playback.position,33);assert.equal(seekPaused.data.playback.startedAt,null);assert.ok(pauseAgain.data.playback.position>=120);
 });
 await t.test('metadata edits keep the playback clock; stale track edits and changed retry payloads are rejected',async()=>{
  await command(first,'resume');const before=(await read(first)).playback;
  const current=(await read(first)).tracks.find(f=>f.id===track.id),edited=await command(first,'edit',{trackId:track.id,trackVersion:current.version,name:'夜航主题',category:'event',loop:false});
  assert.equal(edited.status,200);assert.equal(edited.data.playback.startedAt,before.startedAt);assert.equal(edited.data.playback.position,before.position);
  const stale=await command(second,'edit',{trackId:track.id,trackVersion:current.version,name:'旧页面覆盖',category:'other'});assert.equal(stale.status,409);
  const now=await read(first),payload={operationId:op(),action:'pause',baseVersion:now.playback.version};
  const one=await h.request(h.admin,path(first)+'/control',payload),two=await h.request(h.admin,path(first)+'/control',payload);assert.deepEqual(two.data,one.data);
  assert.equal((await h.request(h.admin,path(first)+'/control',{...payload,action:'stop'})).status,409);
  assert.equal((await h.request(h.admin,path(first)+'/control',{...payload,operationId:op(),action:'resume'})).status,409);
 });
 await t.test('retirement is reversible, retains bytes, and restoration never resumes another group unexpectedly',async()=>{
  await command(first,'resume');const key=(await h.repo.get('media',track.id)).key,original=h.storage.objects.get(key),current=(await read(first)).tracks.find(f=>f.id===track.id);
  const retired=await command(first,'retire',{trackId:track.id,trackVersion:current.version});assert.equal(retired.status,200);assert.equal(h.storage.objects.get(key),original);
  const stopped=(await read(second,h.player)).playback;assert.equal(stopped.status,'stopped');assert.equal(stopped.version,secondPlay.version);assert.ok(stopped.libraryVersion>secondPlay.libraryVersion);
  const all=await read(first);assert.ok(all.tracks.find(f=>f.id===track.id).retired);
  assert.equal((await command(second,'play',{trackId:track.id},h.player)).status,422);
  const restored=await command(first,'restore',{trackId:track.id,trackVersion:retired.data.track.version});assert.equal(restored.status,200);assert.equal(restored.data.track.retired,false);assert.equal((await h.repo.get('media',track.id)).key,key);
  assert.equal((await read(second,h.player)).playback.status,'stopped');
  const play=await command(second,'play',{trackId:track.id},h.player);assert.equal(play.status,200);assert.equal(play.data.playback.position,0);
 });
 await t.test('shared quota serializes reservations across different groups and includes disabled music',async()=>{
  const existing=(await read(first)).library.bytes,fake={id:op(),kind:'music',shared:true,bytes:Music.LIBRARY_MAX_BYTES-existing-audio().length,status:'ready',retired:true,owner:h.user.id,version:1};
  await h.repo.put('media',fake,{scope:Music.MUSIC_SCOPE});
  try{
   const p={name:'容量边界',category:'other',data:audio().toString('base64')},results=await Promise.all([h.request(h.admin,path(first)+'/upload',{...p,operationId:op()}),h.request(h.player,path(second)+'/upload',{...p,operationId:op()})]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,422]);assert.equal((await read(first)).library.bytes,Music.LIBRARY_MAX_BYTES);
   assert.match(results.find(r=>r.status===422).error.message,/300 MiB/);
  }finally{await h.repo.remove('media',fake.id);}
 });
 await t.test('private audio supports authenticated ranges and shared reads while removal revokes access',async()=>{
  const url=h.origin+'/api/web/v1'+path(second)+'/files/'+track.id,headers={Cookie:'web_session='+h.player.secret},full=await fetch(url,{headers});assert.equal(full.status,200);assert.equal(full.headers.get('accept-ranges'),'bytes');const b=Buffer.from(await full.arrayBuffer());
  const part=await fetch(url,{headers:{...headers,Range:'bytes=2-9'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-9/'+b.length);assert.deepEqual(Buffer.from(await part.arrayBuffer()),b.subarray(2,10));
  const suffix=await fetch(url,{headers:{...headers,Range:'bytes=-4'}});assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),b.subarray(-4));
  assert.equal((await fetch(url,{headers:{...headers,Range:'bytes=999999-'}})).status,416);
  assert.equal((await fetch(url)).status,401);
  const member=await h.repo.get('member',second+':'+h.player.user.id);member.active=false;await h.repo.put('member',member,{scope:second});assert.equal((await fetch(url,{headers})).status,403);member.active=true;await h.repo.put('member',member,{scope:second});
 });
 await t.test('legacy group audio moves once without changing its object; deleting its source preserves shared audio',async()=>{
  const old={...await h.repo.get('media',secondTrack.id),version:3,retired:true},oldId=old.id;
  // Simulate the old metadata layout around a real encrypted upload. Its audio
  // keeps its original id/AAD, so the final cross-group read verifies recovery.
  delete old.shared;delete old.sourceGroupId;await h.repo.put('media',old,{scope:second});
  const service=Music.createMusic({repo:h.repo,accounts:h.app.accounts,crypt:null,storage:h.storage});const count=h.storage.objects.size;
  assert.equal((await service.migrateLegacy()).migrated,1);assert.equal((await service.migrateLegacy()).migrated,0);assert.equal(h.storage.objects.size,count);
  const saved=await h.repo.get('media',oldId);assert.equal(saved.key,old.key);assert.equal(saved.version,3);assert.equal(saved.retired,true);assert.equal(saved.playbackEpoch,1);assert.equal((await h.repo.list('media',second)).filter(f=>f.kind==='music').length,0);
  await h.repo.put('mediaCleanup',{id:oldId,key:old.key,groupId:second});await h.app.deletion.resume();assert.equal(await h.repo.get('mediaCleanup',oldId),null);assert.ok(h.storage.objects.has(old.key));
  const source=await h.repo.get('group',second);await h.app.deletion.start(h.user,second,{operationId:op(),baseVersion:source.version});await h.app.deletion.drain();assert.equal((await h.repo.get('groupDeletion',second)).status,'deleted');assert.ok(await h.repo.get('media',oldId));assert.ok(await h.repo.get('media',secondTrack.id));assert.ok(h.storage.objects.has(old.key));assert.ok((await read(first)).tracks.some(f=>f.id===oldId&&f.retired));
  assert.equal((await command(first,'restore',{trackId:oldId,trackVersion:3})).status,200);const response=await fetch(h.origin+'/api/web/v1'+path(first)+'/files/'+oldId,{headers:{Cookie:'web_session='+h.admin.secret}});assert.equal(response.status,200);assert.equal(S.hash(Buffer.from(await response.arrayBuffer())),old.hash);
 });
 await t.test('a catalog update during GET cannot label stale rows with the new library version',async()=>{
  const snapshot=await read(first),chosen=snapshot.tracks.find(f=>f.id===track.id),list=h.repo.list;let intercepted=false;
  h.repo.list=async function(kind,scope,r){
   const rows=await list.call(this,kind,scope,r);
   if(kind==='media'&&scope===Music.MUSIC_SCOPE&&!r&&!intercepted){
    intercepted=true;
    const changed=await h.request(h.admin,path(first)+'/control',{operationId:op(),action:'edit',baseVersion:snapshot.playback.version,trackId:track.id,trackVersion:chosen.version,name:'并发曲库更新',category:chosen.category,loop:chosen.loop});assert.equal(changed.status,200);
   }
   return rows;
  };
  try{const fresh=await read(first);assert.ok(intercepted);assert.equal(fresh.tracks.find(f=>f.id===track.id).name,'并发曲库更新');assert.ok(fresh.library.version>snapshot.library.version);assert.equal(fresh.playback.libraryVersion,fresh.library.version);}
  finally{h.repo.list=list;}
 });
}
test('shared music controls: position, permissions, restore, quota, ranges and source-group cleanup',async t=>{const h=await require('./helpers/chat-website.cjs').launch();try{await cases(t,h);}finally{await h.app.stop();}});
test('music position and byte ranges reject invalid offsets and preserve paused positions',()=>{
 assert.equal(Music.playbackPosition({status:'playing',position:3,startedAt:1000},5500),7.5);assert.equal(Music.playbackPosition({status:'paused',position:3,startedAt:1000},5500),3);
 const b=Buffer.alloc(20);for(const range of ['bytes=-0','bytes=5-2','bytes=20-','bytes=0-2,4-6','items=0-2','bytes=-','bytes=1.2-3'])assert.equal(Music.audioRange(b,range).status,416,range);
 assert.deepEqual(Music.audioRange(b,'bytes=4-99'),{status:206,start:4,end:19});
});
module.exports={cases};
