'use strict';
const crypto=require('node:crypto'),S=require('./security');
async function verifyReleaseBackup({id,repo,backups,storage,database,log=console.log}){
 if(!id)return;
 S.ok(/^[a-zA-Z0-9_-]{1,100}$/.test(id),'发布备份门禁编号无效。');
 database.assertLease();let marker=await repo.get('releaseBackupGate',id);
 if(marker?.status==='verified')return marker;
 S.ok(storage.streaming&&storage.bucket,'发布前流式备份尚未配置。','UNAVAILABLE');
 let record=marker?.backupId&&await repo.get('backup',marker.backupId);
 if(!record?.digest){record=await backups.run(true);S.ok(record?.digest,'发布前备份未完成。','UNAVAILABLE');marker={id,status:'saved',backupId:record.backupId,at:Date.now()};await repo.put('releaseBackupGate',marker);}
 const object=await storage.client.send(new storage.commands.GetObjectCommand({Bucket:storage.bucket,Key:record.manifest})),hash=crypto.createHash('sha256');let bytes=0;
 if(object.Body[Symbol.asyncIterator])for await(const chunk of object.Body){hash.update(chunk);bytes+=chunk.length;}else{const chunk=Buffer.from(await object.Body.transformToByteArray());hash.update(chunk);bytes=chunk.length;}
 S.ok(hash.digest('hex')===record.digest&&bytes===record.bytes,'发布备份读回摘要或大小不一致，停止启动。','UNAVAILABLE');database.assertLease();
 marker={...marker,status:'verified',verifiedAt:Date.now(),bytes,images:record.images};await repo.put('releaseBackupGate',marker);
 log(JSON.stringify({type:'web.releaseBackup.verified',gate:id,backupId:record.backupId,bytes,images:record.images,readBack:true}));return marker;
}
module.exports={verifyReleaseBackup};
