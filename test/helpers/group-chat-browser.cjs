'use strict';
// Disposable loopback QA: no production database, credentials or network calls.
const crypto=require('node:crypto'),C=require('../../src/rpg/constants'),M=require('../../src/rpg/model');
(async()=>{
 const h=await require('./chat-website.cjs').launch({port:47853}),{app,repo}=h,second=await app.accounts.createGroup(h.user,{name:'月光远征队'},crypto.randomUUID());await app.games.ensure(second.id);
 for(const [group,name]of [[h.group,'林鸦'],[second,'夜航者']]){
  await app.games.store.transact(group.id,'browser-qa-seed-'+group.id,h.user.id,s=>{
   const p=M.newCharacter(name,{strength:6,agility:6,constitution:5,mind:5,intelligence:5,appearance:5,knowledge:5});p.userId=h.user.id;p.balance=6000;p.tickets.card=5;s.players[p.userId]=p;
   require('../../src/rpg/content-pack').install(s);s.config.safeRates={...s.config.safeRates,card:[0,0,0,0,100,0]};
   const F=require('../../src/rpg/forms'),X=require('../../src/rpg/exploration'),cf=F.create(s,h.user.id,'mapcategory');Object.assign(cf.data,{name:'安宁旧宅',mapTypes:['indoor']});const cat=F.publish(s,cf),rf=F.create(s,h.user.id,'room');Object.assign(rf.data,{name:'旧宅起居室',categoryIds:[cat.id],description:'窗边的光落在旧木桌上，一只收纳箱安静地放在墙角。',randomContainers:[{ref:'抽屉',probabilities:[100,0,0,0,0,0,0]}]});F.publish(s,rf);
   const map=X.create(s,h.user.id,group.chatRoomId,'安全房保底展示',1,4,'random',cat.id);map.generation.combatPercent=0;X.generate(s,map,lo=>lo);X.publish(s,map);X.join(s,map,h.user.id);
   return {seeded:true};
  });
 }
 await app.chat.send(h.user.id,second.chatRoomId,{clientId:crypto.randomUUID(),text:'这里是另一团独立的远征群聊。角色、物品和填写内容相互隔离。'});
 await app.chat.send('system:web',h.group.chatRoomId,{clientId:crypto.randomUUID(),text:'探索 · 安宁旧宅\n全队已抵达起居室。安全房也有容器，可以从聊天旁打开探索面板。',system:{mapId:app.games.store.select(h.group.id,s=>Object.keys(s.explorations)[0])}},{system:true});
 await app.chat.send('system:web',h.group.gmRoomId,{clientId:crypto.randomUUID(),text:'环境描述等待GM处理。',system:{kind:'webNotice'}},{system:true});
 app.server.prependListener('request',req=>{req.headers.cookie='web_session='+h.admin.secret;});app.server.prependListener('upgrade',req=>{req.headers.cookie='web_session='+h.admin.secret;});
 const report={requests:[],connections:0};app.server.on('request',req=>{if(req.url.startsWith('/api/'))report.requests.push({method:req.method,url:req.url,at:Date.now()});});app.server.on('upgrade',()=>report.connections++);
 app.server.prependListener('request',(req,res)=>{if(req.url==='/__qa-metrics'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(report));}});
 console.log('Disposable group-chat browser fixture ready: http://127.0.0.1:47853');
 process.on('SIGINT',()=>void app.stop());process.on('SIGTERM',()=>void app.stop());
})().catch(e=>{console.error(e);process.exitCode=1;});
