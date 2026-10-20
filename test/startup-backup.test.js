'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyReleaseBackup}=require('../src/web/startup-backup');
function fixture(){
 const records=new Map(),bytes=Buffer.from('isolated encrypted archive'),logs=[];let writes=0,reads=0,lease=true;
 const record={id:'fixture',backupId:'fixture',manifest:'backups/fixture/manifest.enc',digest:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,images:2};
 class GetObjectCommand{constructor(input){this.input=input;}}
 const args={id:'release-test',repo:{async get(kind,id){return structuredClone(records.get(kind+':'+id));},async put(kind,value){records.set(kind+':'+value.id,structuredClone(value));}},backups:{async run(force){assert.equal(force,true);writes++;await args.repo.put('backup',record);return record;}},storage:{streaming:true,bucket:'isolated',commands:{GetObjectCommand},client:{async send(cmd){assert.equal(cmd.input.Key,record.manifest);reads++;return{Body:(async function*(){yield bytes.subarray(0,7);yield bytes.subarray(7);})()};}}},database:{assertLease(){assert.ok(lease,'lease lost');}},log:s=>logs.push(JSON.parse(s))};
 return {args,records,record,bytes,logs,get writes(){return writes;},get reads(){return reads;},loseLease(){lease=false;}};
}
test('release gate backs up and reads back before marking verified; restart does not repeat',async()=>{
 const f=fixture(),saved=await verifyReleaseBackup(f.args);assert.equal(saved.status,'verified');assert.equal(f.writes,1);assert.equal(f.reads,1);assert.equal(f.logs[0].readBack,true);assert.equal(f.logs[0].bytes,f.bytes.length);
 await verifyReleaseBackup(f.args);assert.equal(f.writes,1);assert.equal(f.reads,1);
});
test('incomplete readback resumes the same saved archive and never marks corrupted data verified',async()=>{
 const f=fixture(),send=f.args.storage.client.send;f.args.storage.client.send=async()=>({Body:(async function*(){yield Buffer.from('corrupt');})()});
 await assert.rejects(verifyReleaseBackup(f.args),/摘要或大小不一致/);assert.equal((await f.args.repo.get('releaseBackupGate',f.args.id)).status,'saved');assert.equal(f.writes,1);
 f.args.storage.client.send=send;await verifyReleaseBackup(f.args);assert.equal(f.writes,1);assert.equal(f.reads,1);
});
test('readback failure or lost writer lease keeps startup closed',async()=>{
 const f=fixture();f.args.storage.client.send=async()=>{throw Error('object read unavailable');};await assert.rejects(verifyReleaseBackup(f.args),/unavailable/);assert.equal(f.logs.length,0);
 f.loseLease();await assert.rejects(verifyReleaseBackup(f.args),/lease lost/);assert.equal((await f.args.repo.get('releaseBackupGate',f.args.id)).status,'saved');
 const g=fixture();g.args.storage.streaming=false;await assert.rejects(verifyReleaseBackup(g.args),/尚未配置/);assert.equal(g.writes,0);
});
test('release gate is optional outside explicit releases and rejects invalid gate identifiers',async()=>{
 await verifyReleaseBackup({});const f=fixture();f.args.id='../invalid';await assert.rejects(verifyReleaseBackup(f.args),/编号无效/);assert.equal(f.writes,0);
});
