'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),S=require('./security');
const SOURCE='https://github.com/xizikangx-ui/discord-api-bot/releases/latest/download/client-release.json';
function verify(envelope,publicKey){
 S.ok(envelope&&typeof envelope.payload==='string'&&typeof envelope.signature==='string','更新清单格式无效。','UNAVAILABLE');
 const raw=Buffer.from(envelope.payload,'base64');S.ok(raw.length>0&&raw.length<=65536,'更新清单过大。','UNAVAILABLE');
 S.ok(crypto.verify('sha256',raw,publicKey,Buffer.from(envelope.signature,'base64')),'更新清单签名无效。','UNAVAILABLE');
 let data;try{data=JSON.parse(raw);}catch{S.fail('更新清单无法读取。','UNAVAILABLE');}
 S.ok(data.schema===1&&/^\d+\.\d+\.\d+$/.test(data.version)&&Number.isSafeInteger(data.versionCode)&&data.versionCode>0&&Number.isFinite(Date.parse(data.publishedAt))&&typeof data.notes==='string'&&data.notes.length<=8000,'更新版本信息无效。','UNAVAILABLE');
 for(const platform of ['windows-x64','android']){const a=data.artifacts?.[platform];let u;try{u=new URL(a?.url);}catch{S.fail('更新下载地址无效。','UNAVAILABLE');}
 S.ok(u.protocol==='https:'&&u.hostname==='github.com'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname.startsWith('/xizikangx-ui/discord-api-bot/releases/download/client-v'+data.version+'/')&&!u.pathname.includes('..')&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=350*1024*1024&&/^[a-f0-9]{64}$/.test(a.sha256),'更新文件信息无效。','UNAVAILABLE');
 if(platform==='windows-x64')S.ok(u.pathname.endsWith('.exe')&&Buffer.from(a.sha512||'','base64').length===64,'Windows更新校验信息无效。','UNAVAILABLE');
 else S.ok(u.pathname.endsWith('.apk')&&a.packageName==='app.yichang.book'&&/^[a-f0-9]{64}$/.test(a.certificateSha256),'Android更新校验信息无效。','UNAVAILABLE');
 }
 return data;
}
function createClientRelease({fetcher=fetch,publicKey=fs.readFileSync(path.resolve(__dirname,'../../clients/update-public-key.pem'),'utf8'),now=Date.now}={}){
 let cached,inflight,retryAt=0;
 async function load(){if(cached&&cached.expires>now())return cached;if(inflight)return inflight;if(now()<retryAt)return null;
 inflight=(async()=>{const response=await fetcher(SOURCE,{signal:AbortSignal.timeout(12000),headers:{'user-agent':'YichangBook-Release-Check','accept':'application/json'}});if(response.status===404){retryAt=now()+60000;return null;}S.ok(response.ok,'暂时无法检查客户端更新。','UNAVAILABLE');const chunks=[];let n=0;for await(const part of response.body){n+=part.length;S.ok(n<=131072,'更新清单过大。','UNAVAILABLE');chunks.push(Buffer.from(part));}const envelope=JSON.parse(Buffer.concat(chunks).toString()),data=verify(envelope,publicKey);cached={envelope,data,expires:now()+15*60000};return cached;})();
 try{return await inflight;}catch(e){retryAt=now()+60000;if(cached)return cached;throw e;}finally{inflight=null;}}
 async function get(platform){S.ok(['windows-x64','android'].includes(platform),'客户端平台无效。');return load();}
 async function windowsFeed(){const release=await get('windows-x64');if(!release)return null;const d=release.data,a=d.artifacts['windows-x64'];return{version:d.version,files:[{url:a.url,size:a.size,sha512:a.sha512}],path:a.url,sha512:a.sha512,releaseDate:d.publishedAt};}
 return{get,windowsFeed};
}
module.exports={createClientRelease,verify,SOURCE};
