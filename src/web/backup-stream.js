'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
async function* base64(source){let rest=Buffer.alloc(0);for await(const chunk of source){const b=Buffer.concat([rest,Buffer.from(chunk)]),n=b.length-b.length%3;if(n)yield b.subarray(0,n).toString('base64');rest=Buffer.from(b.subarray(n));}if(rest.length)yield rest.toString('base64');}
async function* archive(pool,{names={},definitions,crypt,images}){
 const r=await pool.connect(),sources={},media=[];let committed=false,released=false;
 try{
  await r.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for(const [k,d]of Object.entries(definitions)){const s=names[k]||d.schema;if(!/^(web_platform|web_content|rpg_web|web_test_[a-z0-9_]+|rpg_test_[a-z0-9_]+)$/.test(s))throw Error('备份命名空间无效。');sources[k]=s;}
  yield JSON.stringify({format:'wasteland-web-backup-v1',at:Date.now(),sourceSchemas:sources}).slice(0,-1)+',"namespaces":{';let firstGroup=true;
  for(const [k,d]of Object.entries(definitions)){
   yield (firstGroup?'':',')+JSON.stringify(k)+':{';firstGroup=false;let firstTable=true;
   for(const table of d.tables){
    yield (firstTable?'':',')+JSON.stringify(table)+':[';firstTable=false;let first=true;
    await r.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT * FROM "${sources[k]}".${table}`);
    try{for(;;){const rows=(await r.query('FETCH FORWARD 100 FROM backup_rows')).rows;if(!rows.length)break;for(const row of rows){if(k==='platform'&&table==='records'&&row.kind==='media'){const m=crypt.open('media',row.id,row.payload);if(m.status==='ready')media.push({id:m.id,key:m.key});}const data=Object.fromEntries(Object.entries(row).map(([key,v])=>[key,Buffer.isBuffer(v)?{base64:v.toString('base64')}:v]));yield (first?'':',')+JSON.stringify(data);first=false;}}}finally{await r.query('CLOSE backup_rows');}
    yield ']';
   }yield '}';
  }
  await r.query('COMMIT');committed=true;r.release();released=true;
  yield '},"images":'+JSON.stringify(await images(media))+'}';
 }finally{if(!committed)await r.query('ROLLBACK').catch(()=>{});if(!released)r.release();}
}
async function writeBackup({pool,names,definitions,crypt,storage,id,key}){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'yichang-backup-')),file=path.join(dir,'manifest.enc');let imageCount=0;
 const images=async refs=>{const saved=[];for(const ref of refs){const object=await storage.client.send(new storage.commands.GetObjectCommand({Bucket:storage.bucket,Key:ref.key})),local=path.join(dir,'media.enc'),hash=crypto.createHash('sha256');const input=object.Body[Symbol.asyncIterator]?object.Body:Readable.from([Buffer.from(await object.Body.transformToByteArray())]);async function* hashed(){for await(const chunk of input){hash.update(chunk);yield chunk;}}try{await pipeline(Readable.from(hashed()),fs.createWriteStream(local));const dest='backups/'+id+'/'+ref.key;await storage.client.send(new storage.commands.PutObjectCommand({Bucket:storage.bucket,Key:dest,Body:fs.createReadStream(local),ContentLength:(await fsp.stat(local)).size}));saved.push({id:ref.id,key:dest,original:ref.key,digest:hash.digest('hex')});}finally{await fsp.rm(local,{force:true});}}imageCount=saved.length;return saved;};
 async function* payload(){yield '{"gzip":"';const input=Readable.from(archive(pool,{names,definitions,crypt,images})),gz=zlib.createGzip(),job=pipeline(input,gz);job.catch(()=>{});try{yield* base64(gz);await job;yield '"}';}finally{input.destroy();gz.destroy();await job.catch(()=>{});}}
 try{
  await pipeline(Readable.from(crypt.sealStream('backup',id,payload())),fs.createWriteStream(file));
  await storage.client.send(new storage.commands.PutObjectCommand({Bucket:storage.bucket,Key:key,Body:fs.createReadStream(file),ContentLength:(await fsp.stat(file)).size}));
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return {images:imageCount,digest:hash.digest('hex'),bytes:(await fsp.stat(file)).size};
 }finally{await fsp.rm(file,{force:true});await fsp.rmdir(dir);}
}
module.exports={base64,archive,writeBackup};
