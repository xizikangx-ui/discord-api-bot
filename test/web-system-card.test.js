'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('system card publishes and updates structured actions once; ordinary messages cannot forge them',async()=>{
 const h=await require('./helpers/chat-website.cjs').launch();
 try{
  const payload={text:'遭遇开始，请打开战斗面板。',system:{battleId:'b-persisted',kind:'battle',ended:false}};
  const first=await h.app.chat.upsertSystem(h.room.id,'battle-open',1,payload);
  assert.equal(first.system.battleId,'b-persisted');
  assert.equal((await h.app.chat.upsertSystem(h.room.id,'battle-open',1,payload)).id,first.id);
  const updated=await h.app.chat.upsertSystem(h.room.id,'battle-open',2,{text:'战斗结束，查看奖励。',system:{...payload.system,ended:true}});
  assert.equal(updated.id,first.id);assert.equal(updated.system.ended,true);
  const normal=await h.app.chat.send(h.player.user.id,h.room.id,{clientId:require('node:crypto').randomUUID(),text:'玩家消息',system:{ended:true}});
  assert.equal(normal.system,undefined);
 }finally{await h.app.stop();}
});
