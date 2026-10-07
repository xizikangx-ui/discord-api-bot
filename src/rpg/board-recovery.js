'use strict';
const C=require('./constants'),U=require('./ui');
function createBoardRecovery({snapshot,store,tx,needGM,textChannel,busy}){
 function view(b){return U.payload('战场公示核对', '当前状态：'+(b.boardPublication?.status|| (b.messageId?'sent':'pending'))+'\n'+(b.messageId?'已登记消息 '+b.messageId:'没有登记消息。')+'\n发送结果不明确时先检查战斗频道；已有消息可登记绑定，确认不存在后才补发。',[
  U.row(U.button('boardrepair:'+b.id+':bind','登记已存在的战场消息'),U.button('boardrepair:'+b.id+':absent','确认不存在并补发',U.D.ButtonStyle.Danger)),U.row(U.button('gmui:'+b.id+':view','返回GM面板'))]);}
 async function openModal(i,s){if(i.isModalSubmit?.()||!/^rpg:boardrepair:[^:]+:bind$/.test(i.customId||''))return false;needGM(s,i.member);const ref=i.customId.split(':')[2];C.requireThat(s.battles[ref],'战斗不存在。');await i.showModal(U.modal('boardrepair:'+ref+':bindsubmit','登记战场消息',[{key:'message',label:'战斗频道中已有的Bot战场消息ID'}]));return true;}
 async function component(i,member){const [,,ref,action]=i.customId.split(':'),s=snapshot(i.guildId),b=s.battles[ref];needGM(s,member);C.requireThat(b&&b.status!=='ended','只恢复尚未结束的战斗公示。');
  if(action==='view')return view(b);C.requireThat(!busy(i.guildId,ref),'战场任务仍在发送，请稍后核对。');
  if(action==='absent')return U.payload('确认频道中没有战场消息','请检查频道中由Bot发送的战场卡；确认不存在后，沿用已有战斗状态补发，不重新结算。',[U.row(U.button('boardrepair:'+ref+':retry','我已核对，确认补发',U.D.ButtonStyle.Danger),U.button('boardrepair:'+ref+':view','返回'))]);
  if(action==='bindsubmit'){
   const id=i.fields.getTextInputValue('message').trim();C.requireThat(/^\d{17,20}$/.test(id),'请输入Discord消息ID。');const ch=await textChannel(i.guildId,b.channelId),message=await ch.messages.fetch(id);
   C.requireThat(message.author.id===store.clientId&&message.channelId===b.channelId&&message.embeds?.some(e=>e.footer?.text?.startsWith('战斗 '+ref+' ·')),'消息不是本场战斗的Bot战场卡。');
   await tx(i,st=>{needGM(st,member);C.requireThat(st.battles[ref].status!=='ended'&&!busy(i.guildId,ref),'战斗状态已变化。');st.battles[ref].messageId=id;st.battles[ref].boardPublication={status:'sent'};require('./outbox').put(st,'battle',ref,{priority:1});},'GM核对并登记战场消息');return view(snapshot(i.guildId).battles[ref]);
  }
  C.requireThat(action==='retry','恢复步骤失效。');await tx(i,st=>{needGM(st,member);const live=st.battles[ref];C.requireThat(live.status!=='ended'&&!live.messageId&&!busy(i.guildId,ref),'战场已恢复或状态变化，请刷新。');live.boardPublication={status:'pending'};require('./outbox').put(st,'battle',ref,{priority:1});},'GM核对战场未发送并允许补发');return U.payload('补发任务已保存','继续使用原战斗、骰点和资产。');
 }
 return {view,openModal,component};
}
module.exports={createBoardRecovery};
