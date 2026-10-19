'use strict';
const S=require('./security'),PG=require('../rpg/postgres'),{gunzipSync}=require('node:zlib'),{RESET_ID}=require('./group-chat');
const collections=['players','characterDrafts','battles','explorations','offers','deaths','corpses','worldSettings','worldCities','worldRoutes','worldLocations','worldJourneys','worldSites','markets','marketTrades','couponRedemptions'];
const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k,x])=>!(typeof x==='string'&&/(?:channelId|ChannelId|roomId)$/.test(k))).map(([k,x])=>[k,clean(x)])):v;
function protectedArchive(archive,decrypt){
 const result={};
 for(const row of archive.namespaces.game.objects){if(!collections.includes(row.collection))continue;
  const decoded=decrypt(JSON.parse(Buffer.from(row.payload.base64,'base64').toString('utf8'))),raw=decoded.value;
  S.ok(decoded.encrypted&&raw.kind==='rpg-record-v1'&&raw.guildId===row.guild_id&&raw.scope===row.collection&&raw.id===row.object_id,'迁移备份对象归属不符。');
  ((result[row.guild_id]||={})[row.collection]||={})[row.object_id]=JSON.parse(gunzipSync(Buffer.from(raw.body,'base64'),{maxOutputLength:128*1024*1024}));
 }
 return result;
}
function createMigrationBackup({repo,backups,storage,crypt,decrypt,readArchive=require('./backup-cli').readArchive,log=console.log}){
 let archive;
 async function prepare(enabled){
  if(!enabled)return null;
  const prior=await repo.get('chatMigrationBackup',RESET_ID),job=await repo.get('chatReset',RESET_ID);
  if(prior?.status==='verified'&&job?.status==='completed')return null;
  let record=job&&prior?.backupId?await repo.get('backup',prior.backupId):null;
  if(!record)record=await backups.run(true);
  S.ok(record?.backupId,'群聊迁移前加密备份未完成。','UNAVAILABLE');
  archive=await readArchive(storage,crypt,record);
  S.ok(archive?.namespaces?.platform?.messages&&archive?.namespaces?.game?.objects,'群聊迁移备份读回不完整。','UNAVAILABLE');
  const marker={id:RESET_ID,status:'ready',backupId:record.backupId,verifiedReadAt:Date.now(),images:archive.images?.length||0};
  await repo.put('chatMigrationBackup',marker);log(JSON.stringify({metric:'web.chatMigration.backup',backupId:marker.backupId,images:marker.images,readBack:true}));return marker;
 }
 async function verify(games,groups){
  if(!archive)return null;
  const before=protectedArchive(archive,decrypt),hashes={};
  for(const g of groups.filter(g=>!g.deleting))hashes[g.id]=games.store.select(g.id,state=>Object.fromEntries(collections.map(col=>{
   const expected=PG.digest(clean(before[g.id]?.[col]||{})),actual=PG.digest(clean(state[col]||{}));
   S.ok(expected===actual,'群聊迁移资产核对失败：'+g.id+':'+col,'CONFLICT');return[col,actual];
  })));
  const reset=await repo.get('chatReset',RESET_ID);S.ok(reset?.status==='completed'&&reset.groups.every(g=>reset.results[g.groupId]?.status==='completed'),'群聊迁移尚未完成。','UNAVAILABLE');
  let oldMessages=0;for(const g of reset.groups)for(const c of g.cutoffs)oldMessages+=(await repo.history(c.roomId,{after:0,before:c.sequence+1,limit:1})).length;
  const pending=(await repo.list('mediaCleanup')).filter(m=>m.chatResetId===RESET_ID).length;
  S.ok(!oldMessages&&!pending,'群聊历史或附件仍待清理。','UNAVAILABLE');
  const marker=await repo.get('chatMigrationBackup',RESET_ID),result={...marker,status:'verified',protectedAssetsMatch:true,protectedHashes:hashes,checkedAt:Date.now(),groups:reset.groups.length,messagesCleared:Object.values(reset.results).reduce((n,r)=>n+(r.messages||0),0),remainingOldMessages:oldMessages,attachmentTasks:pending};
  await repo.put('chatMigrationBackup',result);
  log(JSON.stringify({metric:'web.chatMigration.complete',backupId:result.backupId,groups:result.groups,messagesCleared:result.messagesCleared,remainingOldMessages:0,attachmentTasks:0,protectedAssetsMatch:true}));archive=null;return result;
 }
 return{prepare,verify};
}
module.exports={collections,clean,protectedArchive,createMigrationBackup};
