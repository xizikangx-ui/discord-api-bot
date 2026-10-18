'use strict';
const crypto=require('node:crypto'),fs=require('node:fs');
const HOME='https://yichang.up.railway.app',FEED=HOME+'/api/web/v1/client-release/windows-x64/',ENDPOINT=HOME+'/api/web/v1/client-release?platform=windows-x64';
const REPO='/xizikangx-ui/discord-api-bot/releases/download/';
function requireThat(ok,message){if(!ok)throw Error(message);}
function compareVersion(a,b){const parts=v=>{requireThat(typeof v==='string'&&/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v),'客户端版本格式无效。');return v.split('.').map(Number);},aa=parts(a),bb=parts(b);for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;return 0;}
function artifactUrl(value,version,platform){try{const u=new URL(value),prefix=REPO+'client-v'+version+'/';return u.protocol==='https:'&&u.hostname==='github.com'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname.startsWith(prefix)&&/^[A-Za-z0-9][A-Za-z0-9._-]{1,150}$/.test(u.pathname.slice(prefix.length))&&u.pathname.endsWith(platform==='android'?'.apk':'.exe');}catch{return false;}}
function downloadUrl(value,release){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return false;if(u.origin===HOME)return u.href.startsWith(FEED)&&['latest.yml'].includes(u.pathname.slice(new URL(FEED).pathname.length));if(u.hostname==='github.com')return !!release&&u.href===release.artifacts['windows-x64'].url;return !!release&&['release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(u.hostname);}catch{return false;}}
function verifyEnvelope(envelope,publicPem,platform='windows-x64'){
 requireThat(envelope&&typeof envelope.payload==='string'&&typeof envelope.signature==='string'&&envelope.payload.length<=256*1024&&envelope.signature.length<1024,'更新清单格式无效。');
 const raw=Buffer.from(envelope.payload,'base64'),signature=Buffer.from(envelope.signature,'base64'),key=publicPem?.type==='public'?publicPem:crypto.createPublicKey(publicPem);
 requireThat(raw.length>0&&raw.toString('base64')===envelope.payload&&signature.toString('base64')===envelope.signature,'更新清单编码无效。');
 requireThat(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength>=3072,'更新公钥不符合要求。');
 requireThat(crypto.verify('sha256',raw,{key,padding:crypto.constants.RSA_PKCS1_PADDING},signature),'更新清单签名校验失败，保留当前版本。');
 let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw Error('更新清单无法读取。');}
 requireThat(value.schema===1&&Number.isSafeInteger(value.versionCode)&&value.versionCode>0&&value.versionCode<=2147483647,'更新清单版本无效。');
 compareVersion(value.version,value.version);
 requireThat(Number.isFinite(Date.parse(value.publishedAt))&&typeof value.notes==='string'&&value.notes.length<=8000,'更新说明无效。');
 for(const p of ['windows-x64','android']){const a=value.artifacts?.[p];requireThat(a&&artifactUrl(a.url,value.version,p)&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=(p==='android'?128:512)*1024*1024&&/^[a-f0-9]{64}$/.test(a.sha256),'更新文件信息无效。');if(p==='windows-x64')requireThat(typeof a.sha512==='string'&&Buffer.from(a.sha512,'base64').length===64&&Buffer.from(a.sha512,'base64').toString('base64')===a.sha512,'Windows 更新校验信息无效。');else requireThat(a.packageName==='app.yichang.book'&&/^[a-f0-9]{64}$/.test(a.certificateSha256),'安卓更新签名信息无效。');}
 requireThat(['windows-x64','android'].includes(platform),'客户端平台无效。');return value;
}
function verifyUpdateInfo(info,manifest){const a=manifest.artifacts['windows-x64'];requireThat(info?.version===manifest.version&&info.files?.length===1,'更新文件与签名版本不一致，请稍后再试。');const f=info.files[0];requireThat(f.url===a.url&&f.size===a.size&&f.sha512===a.sha512,'更新文件与签名清单不一致。');return true;}
async function verifyFile(file,artifact){const stat=await fs.promises.stat(file);requireThat(stat.isFile()&&stat.size===artifact.size,'更新文件不完整，未进行安装。');const sha256=crypto.createHash('sha256'),sha512=crypto.createHash('sha512');for await(const chunk of fs.createReadStream(file)){sha256.update(chunk);sha512.update(chunk);}requireThat(sha256.digest('hex')===artifact.sha256&&(!artifact.sha512||sha512.digest('base64')===artifact.sha512),'更新文件校验失败，未进行安装。');return true;}
module.exports={HOME,FEED,ENDPOINT,compareVersion,artifactUrl,downloadUrl,verifyEnvelope,verifyUpdateInfo,verifyFile};
