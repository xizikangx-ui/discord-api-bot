"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),S=require("../src/web/security");
async function fixture(){
  const repo=require("./helpers/web-demo.cjs").memoryRepository(),accounts=require("../src/web/accounts").createAccounts(repo),objects=new Map(),events=[];
  for(const id of ["gm","player","visitor"])await repo.put("user",{id,name:id,displayName:id,version:1},{lookup:S.hash(id)});
  for(const id of ["first","second","foreign"])await repo.put("group",{id,name:id,version:1});
  for(const [g,ids]of [["first",["gm","player"]],["second",["gm","player"]],["foreign",["visitor"]]])for(const id of ids)await repo.put("member",{id:g+":"+id,userId:id,groupId:g,role:id==="gm"?"gm":"player",active:true,version:1},{scope:g});
  const chat=require("../src/web/chat").createChat(repo,accounts,{broadcast:(room,event)=>events.push({room,event})});
  for(const id of ["open","hidden"])await repo.put("room",{id,groupId:"first",kind:id==="hidden"?"gm":"chat",sequence:0,version:1},{scope:"first"});
  class PutObjectCommand{constructor(p){this.p=p;}}class GetObjectCommand{constructor(p){this.p=p;}}class DeleteObjectCommand{constructor(p){this.p=p;}}
  const storage={bucket:"isolated-test",commands:{PutObjectCommand,GetObjectCommand,DeleteObjectCommand},client:{async send(c){if(c instanceof PutObjectCommand){objects.set(c.p.Key,c.p.Body);return{};}if(c instanceof DeleteObjectCommand){objects.delete(c.p.Key);return{};}const b=objects.get(c.p.Key);assert.ok(b,"image remains in private storage");return{Body:{transformToByteArray:async()=>b}};}}};
  const media=require("../src/web/media").createMedia(repo,S.codec(crypto.randomBytes(32).toString("base64")),{...storage,accounts,chat});
  const data=(await require("sharp")({create:{width:16,height:16,channels:4,background:{r:31,g:97,b:171,alpha:1}}}).png().toBuffer()).toString("base64");
  const actor=async(id="gm",group="first")=>accounts.member(group,id);
  async function upload(id="gm",group="first",suffix=crypto.randomUUID()){const a=await actor(id,group),image=await media.uploadAvatar(a,{uploadId:suffix,data});return{a,image};}
  return{repo,accounts,chat,events,storage,media,data,actor,upload};
}
test("account avatars: GM without a character uploads, encrypted bytes stay private and old references stop being public",async()=>{
 const h=await fixture(),{a,image}=await h.upload();
 const saved=await h.accounts.setAvatar(a,{mediaId:image.id,operationId:"avatar_publish_one",baseVersion:0});
 assert.equal(saved.user.avatarVersion,1);assert.equal(saved.avatar.webMediaId,image.id);
 assert.equal((await h.repo.list("media","first")).length,0);assert.equal((await h.repo.list("media","gm")).length,1);
 const bytes=await h.media.read("player",image.id,"first");assert.equal((await require("sharp")(bytes).metadata()).format,"webp");
 assert.equal((await h.accounts.setAvatar(a,{mediaId:image.id,operationId:"avatar_publish_one",baseVersion:0})).user.avatarVersion,1);
 await assert.rejects(h.accounts.setAvatar(a,{mediaId:image.id,operationId:"avatar_publish_stale",baseVersion:0}),/头像已在其他页面修改/);
 const clear=await h.accounts.setAvatar(await h.actor(),{clear:true,operationId:"avatar_clear_one",baseVersion:1});assert.equal(clear.avatar,null);assert.equal(clear.user.avatarVersion,2);
 await assert.rejects(h.media.read("player",image.id,"first"),e=>e.code==="FORBIDDEN");
 assert.ok((await h.media.read("gm",image.id)).length);
});
test("account avatars are shared only across current common groups and survive deletion of an unrelated source group",async()=>{
 const h=await fixture(),{a,image}=await h.upload();await h.accounts.setAvatar(a,{mediaId:image.id,operationId:"avatar_publish_cross"});
 assert.ok((await h.media.read("player",image.id,"second")).length);
 await assert.rejects(h.media.read("visitor",image.id,"foreign"),e=>e.code==="FORBIDDEN");
 await assert.rejects(h.media.read("visitor",image.id,"second"),e=>e.code==="FORBIDDEN");
 await h.repo.purgeGroup("first",["open","hidden"]);await h.repo.put("groupDeletion",{id:"first",status:"deleted"});
 assert.ok((await h.media.read("player",image.id,"second")).length);
 const m=await h.repo.get("member","second:player");m.active=false;await h.repo.put("member",m,{scope:"second"});
 await assert.rejects(h.media.read("player",image.id,"second"),e=>e.code==="FORBIDDEN");
 assert.ok((await h.media.read("gm",image.id)).length);
});
test("avatar publishing never accepts another owner, room attachment or an ordinary portrait upload",async()=>{
 const h=await fixture(),{image}=await h.upload("player");
 await assert.rejects(h.accounts.setAvatar(await h.actor(),{mediaId:image.id,operationId:"avatar_steal_image"}),e=>e.code==="FORBIDDEN");
 const image2=await h.media.upload(await h.actor(),{uploadId:"ordinary_portrait_image",data:h.data});
 await assert.rejects(h.accounts.setAvatar(await h.actor(),{mediaId:image2.id,operationId:"avatar_reuse_portrait"}),e=>e.code==="FORBIDDEN");
 await assert.rejects(h.media.uploadAvatar(await h.actor(),{uploadId:"ordinary_portrait_image",data:h.data}),e=>e.code==="CONFLICT");
});
test("chat avatars resolve current profiles without rewriting history: ordinary account first, RP character first",async()=>{
 const h=await fixture();let profile={avatar:{webMediaId:"account-one"},characterAvatar:{webMediaId:"character-one"}};
 h.chat.setCharacterReader(async()=>({name:"角色"}));h.chat.setProfileReader(async()=>({player:profile}));
 const ordinary=await h.chat.send("player","open",{clientId:"avatar_text_message",text:"普通聊天"});assert.equal(ordinary.avatar.webMediaId,"account-one");
 const rp=await h.chat.send("player","open",{clientId:"avatar_role_message",text:"角色叙述",kind:"rp"});assert.equal(rp.avatar.webMediaId,"character-one");
 assert.equal((await h.repo.findMessage(ordinary.id)).avatar,undefined);
 profile={avatar:{webMediaId:"account-new"},characterAvatar:null};
 const history=await h.chat.history("gm","open",{after:0,before:Number.MAX_SAFE_INTEGER});assert.deepEqual(history.map(m=>m.avatar.webMediaId),["account-new","account-new"]);
 profile={avatar:null,characterAvatar:{webMediaId:"character-new"}};
 assert.deepEqual((await h.chat.history("gm","open",{after:0,before:Number.MAX_SAFE_INTEGER})).map(m=>m.avatar.webMediaId),["character-new","character-new"]);
 await assert.rejects(h.chat.history("player","hidden",{after:0,before:Number.MAX_SAFE_INTEGER}),e=>e.code==="FORBIDDEN");
});
