'use strict';
const {createHash}=require('node:crypto');
const C=require('./constants'),M=require('./model'),U=require('./ui');
const {requireThat:ok}=C;
const LIMIT=4*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function format(bytes) {
  ok(bytes.length>12&&bytes.length<=LIMIT,'图片必须为PNG、JPEG或WebP，且每张不超过4 MiB。');
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw new Error('图片实际格式不支持，请上传PNG、JPEG或WebP。');
}
async function readBounded(response,limit) {
  ok(response.ok,'图片下载失败，请重试。');
  ok(Number(response.headers?.get('content-length')||0)<=limit,'图片超过大小限制。');
  if(response.body?.[Symbol.asyncIterator]) {
    const chunks=[];let length=0;
    try {for await(const chunk of response.body){length+=chunk.length;ok(length<=limit,'图片超过大小限制。');chunks.push(Buffer.from(chunk));}}
    catch(e){await response.body.cancel?.().catch(()=>{});throw e;}
    return Buffer.concat(chunks);
  }
  const bytes=Buffer.from(await response.arrayBuffer());ok(bytes.length<=limit,'图片超过大小限制。');return bytes;
}
function createPortraits({client,channel,encrypt,decrypt,fetcher=fetch,snapshot,tx,needGM,pickView,logFailure,cacheBytes=64*1024*1024}) {
  const cache=new Map();
  const expiry=setInterval(()=>{for(const [key,entry]of cache)if(entry.expires<=Date.now())cache.delete(key);},60000);expiry.unref();
  async function upload(guild,uid,attachment) {
    ok(attachment.size<=LIMIT,'每张图片最多4 MiB。');
    const bytes=attachment.bytes||await readBounded(await fetcher(attachment.url,{signal:AbortSignal.timeout(20000)}),LIMIT),ext=format(bytes),id=attachment.id||C.id('image');
    const ch=channel();ok(ch?.send&&ch.guild,'私密图片存储频道未连接。');
    const file=Buffer.from(encrypt({kind:'rpg-portrait',guildId:guild,id,owner:uid,ext,hash:hash(bytes),body:bytes.toString('base64')}));
    ok(file.length<(ch.guild.maximumFileSize||10*1024*1024),'加密图片超过存储频道附件限制。');
    const message=await ch.send({content:'discord-api-bot-rpg-image:'+guild+':'+id,allowedMentions:{parse:[]},...(attachment.id?{nonce:id,enforceNonce:true}:{}),files:[{attachment:file,name:id+'.json.enc'}]});
    return {id,messageId:message.id,ext,hash:hash(bytes),size:bytes.length};
  }
  async function load(guild,ref) {
    const key=guild+':'+ref.id;const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.bytes;
    const message=await channel().messages.fetch({message:ref.messageId,force:true});
    ok(message.author.id===client.user.id&&message.content==='discord-api-bot-rpg-image:'+guild+':'+ref.id,'图片存档归属不符。');
    const file=[...message.attachments.values()].find(a=>a.name===ref.id+'.json.enc');ok(file,'图片附件缺失。');
    const encrypted=await readBounded(await fetcher(file.url,{signal:AbortSignal.timeout(20000)}),8*1024*1024);
    const result=decrypt(JSON.parse(encrypted.toString('utf8'))),value=result.value;
    ok(result.encrypted&&value.kind==='rpg-portrait'&&value.guildId===guild&&value.id===ref.id,'图片存档验证失败。');
    const bytes=Buffer.from(value.body,'base64');ok(hash(bytes)===ref.hash&&value.hash===ref.hash&&format(bytes)===ref.ext,'图片内容验证失败。');
    if(cacheBytes>0){cache.set(key,{bytes,expires:Date.now()+60000});let used=[...cache.values()].reduce((n,e)=>n+e.bytes.length,0);while(cache.size&&(cache.size>16||used>cacheBytes)){const first=cache.keys().next().value;used-=cache.get(first).bytes.length;cache.delete(first);}}return bytes;
  }
  async function decorate(guild,result) {
    const out={...result};const refs=out.rpgPortraits;delete out.rpgPortraits;
    // Explicit replacement prevents a previous private step's attachments leaking.
    if(!refs)return out;
    out.files=[];out.attachments=[];
    for(const [slot,ref] of Object.entries(refs)) {
      if(!['avatar','illustration'].includes(slot)||!ref)continue;
      try {const bytes=await load(guild,ref),name=ref.id+'.'+ref.ext;
        if(!out.files.some(f=>f.name===name))out.files.push({attachment:bytes,name});
        out.embeds[0][slot==='avatar'?'setThumbnail':'setImage']('attachment://'+name);
      }catch(e){logFailure?.('角色图片读取失败。',e);out.content=(out.content||'')+'\n⚠️ 图片暂时无法读取，文字角色卡仍可使用。';}
    }
    return out;
  }
  function target(state,f) {
    if(f.targetType==='player'){const p=M.player(state,f.owner);ok(p.id===f.targetId,'角色已经变化。');return p;}
    const npc=state.npcTemplates[f.targetId];ok(npc?.published&&npc.version===f.targetVersion,'NPC模板版本已经变化，请重新选择。');return npc;
  }
  function preview(s,f) {
    const t=target(s,f),refs={...(t.portraits||{}),...f.uploads};
    for(const slot of f.clear==='both'?['avatar','illustration']:[f.clear])if(slot)delete refs[slot];
    const out=U.payload('图片设置预览 · '+t.name,'右上头像：'+(refs.avatar?'已设置':'无')+'\n底部立绘：'+(refs.illustration?'已设置':'无')+'\n确认后保存。',[
      U.row(U.button('portrait:confirm:'+f.id,'确认保存图片',U.D.ButtonStyle.Success),U.button('portrait:cancel:'+f.id,'取消'))]);
    out.rpgPortraits=refs;out.rpgImageRequested=true;return out;
  }
  function list(s,f,page=0) {
    const options=Object.values(s.npcTemplates).filter(t=>t.published).map(t=>({value:t.id,label:t.name,description:'版本 '+t.version}));
    return pickView('选择要更新图片的NPC',options,'portrait:pick:'+f.id,page);
  }
  async function slash(i,member) {
    const s=snapshot(i.guildId),npc=i.commandName==='npc图片';
    if(npc)needGM(s,member);else M.player(s,i.user.id);
    const clear=i.options.getString('清除'),files=[['avatar',i.options.getAttachment('头像')],['illustration',i.options.getAttachment('立绘')]].filter(([,a])=>a);
    ok(!clear||!files.length,'清除与上传请分开操作。');ok(clear||files.length,'请上传头像、立绘，或选择清除位置。');
    const uploads={};for(const [slot,a]of files)uploads[slot]=await upload(i.guildId,i.user.id,a);
    const f=await tx(i,st=>{if(npc)needGM(st,member);const p=npc?null:M.player(st,i.user.id);
      ok(!p||p.id===s.players[i.user.id].id,'角色已经变化，请重新上传。');
      const f={id:C.id('f'),kind:'portrait',owner:i.user.id,targetType:npc?'npc':'player',targetId:p?.id,uploads,clear,expiresAt:C.confirmationDeadline(14*60000)};st.forms[f.id]=f;return f;},'准备角色图片');
    return npc?list(snapshot(i.guildId),f):preview(snapshot(i.guildId),f);
  }
  async function component(i,member) {
    const [, ,action,...args]=i.customId.split(':'),s=snapshot(i.guildId),f=s.forms[args[0]];
    ok(f?.kind==='portrait'&&f.owner===i.user.id&&!f.done&&f.expiresAt>Date.now(),'图片步骤已失效，请重新上传。');
    if(f.targetType==='npc')needGM(s,member);
    if(action==='pick'&&args[1]!=='select')return list(s,f,Number(args[1]));
    const result=await tx(i,st=>{const f=st.forms[args[0]];ok(f&&!f.done&&f.owner===i.user.id&&f.expiresAt>Date.now(),'图片操作已结束。');
      if(f.targetType==='npc')needGM(st,member);
      if(action==='pick'){const t=st.npcTemplates[i.values[0]];ok(t?.published,'NPC模板已失效。');f.targetId=t.id;f.targetVersion=t.version;return null;}
      if(action==='cancel'){f.done=true;return null;}
      ok(action==='confirm','图片操作无效。');const t=target(st,f);t.portraits={...(t.portraits||{}),...C.clone(f.uploads)};
      for(const slot of f.clear==='both'?['avatar','illustration']:[f.clear])if(slot)delete t.portraits[slot];
      if(f.targetType==='npc')t.version++;f.done=true;return {name:t.name};
    },'保存角色图片');
    if(action==='pick')return preview(snapshot(i.guildId),snapshot(i.guildId).forms[f.id]);
    return U.payload(action==='cancel'?'已取消':'图片已保存',result?result.name+'，重新打开角色卡即可查看。':'原图片保持不变。');
  }
  return {slash,component,decorate,upload,load,close(){clearInterval(expiry);cache.clear();}};
}
module.exports={LIMIT,format,readBounded,createPortraits};
