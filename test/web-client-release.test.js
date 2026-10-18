'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),R=require('../src/web/client-release');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
function data(){const prefix='https://github.com/xizikangx-ui/discord-api-bot/releases/download/client-v1.1.0/';return{schema:1,version:'1.1.0',versionCode:2,publishedAt:'2026-10-18T00:00:00Z',notes:'客户端更新',artifacts:{'windows-x64':{url:prefix+'YichangBook-Setup-1.1.0-x64.exe',size:100,sha256:'a'.repeat(64),sha512:Buffer.alloc(64,2).toString('base64')},android:{url:prefix+'YichangBook-Android-1.1.0.apk',size:100,sha256:'b'.repeat(64),packageName:'app.yichang.book',certificateSha256:'c'.repeat(64)}}};}
function sign(d){const raw=Buffer.from(JSON.stringify(d));return{payload:raw.toString('base64'),signature:crypto.sign('sha256',raw,privateKey).toString('base64')};}
test('signed release verification pins version, platform, package and GitHub repository without disclosing signing material',()=>{const d=data();assert.deepEqual(R.verify(sign(d),publicKey),d);const e=sign(d);e.payload=Buffer.from(JSON.stringify({...d,version:'9.0.0'})).toString('base64');assert.throws(()=>R.verify(e,publicKey),/签名/);for(const url of ['http://github.com/xizikangx-ui/discord-api-bot/releases/download/client-v1.1.0/file.exe','https://github.com/attacker/repo/releases/download/client-v1.1.0/file.exe','https://evil.example/file.exe']){const bad=data();bad.artifacts['windows-x64'].url=url;assert.throws(()=>R.verify(sign(bad),publicKey),/文件信息/);}const bad=data();bad.artifacts.android.packageName='evil.package';assert.throws(()=>R.verify(sign(bad),publicKey),/Android/);});
test('twenty simultaneous update checks share one verified manifest and derive exact updater metadata',async()=>{let requests=0,clock=10000;const d=data(),e=sign(d),r=R.createClientRelease({publicKey,now:()=>clock,fetcher:async()=>{requests++;return new Response(JSON.stringify(e));}});const results=await Promise.all(Array.from({length:20},()=>r.get('windows-x64')));assert.equal(requests,1);assert.ok(results.every(x=>x.data.version==='1.1.0'));assert.deepEqual((await r.windowsFeed()).files,[{url:d.artifacts['windows-x64'].url,size:100,sha512:d.artifacts['windows-x64'].sha512}]);clock+=14*60000;await r.get('android');assert.equal(requests,1);clock+=2*60000;await r.get('android');assert.equal(requests,2);await assert.rejects(r.get('linux'),/平台/);});
test('no release, failed downloads and invalid manifests never produce an executable update',async()=>{let calls=0,clock=0;const r=R.createClientRelease({publicKey,now:()=>clock,fetcher:async()=>{calls++;return new Response('',{status:404});}});assert.equal(await r.get('android'),null);assert.equal(await r.windowsFeed(),null);assert.equal(calls,1);clock=61000;await r.get('android');assert.equal(calls,2);const corrupt=R.createClientRelease({publicKey,fetcher:async()=>new Response(JSON.stringify({payload:'aaaa',signature:'bad'}))});await assert.rejects(corrupt.get('android'),/签名/);const huge=R.createClientRelease({publicKey,fetcher:async()=>new Response('x'.repeat(150000))});await assert.rejects(huge.get('android'),/过大/);});

test('anonymous client endpoints expose only a signed envelope and verified generic feed',async()=>{
 const envelope=sign(data());let calls=0;
 const service=R.createClientRelease({publicKey,fetcher:async()=>{calls++;return new Response(JSON.stringify(envelope));}});
 const h=await require('./helpers/chat-website.cjs').launch({clientRelease:service});
 try{
  const responses=await Promise.all(Array.from({length:20},()=>fetch(h.origin+'/api/web/v1/client-release?platform=windows-x64')));
  assert.ok(responses.every(r=>r.status===200));assert.equal(calls,1);
  assert.deepEqual(await responses[0].json(),envelope);
  const feed=await fetch(h.origin+'/api/web/v1/client-release/windows-x64/latest.yml');
  assert.match(feed.headers.get('content-type'),/application\/yaml/);
  assert.deepEqual((await feed.json()).files,[{url:data().artifacts['windows-x64'].url,size:100,sha512:data().artifacts['windows-x64'].sha512}]);
  assert.equal((await fetch(h.origin+'/api/web/v1/client-release?platform=linux')).status,422);
  assert.equal((await fetch(h.origin+'/api/web/v1/me')).status,401);
 }finally{await h.app.stop();}
 const empty=await require('./helpers/chat-website.cjs').launch({clientRelease:R.createClientRelease({publicKey,fetcher:async()=>new Response('',{status:404})})});
 try{const response=await fetch(empty.origin+'/api/web/v1/client-release?platform=android');assert.equal(response.status,204);assert.equal(await response.text(),'');}finally{await empty.app.stop();}
});
