'use strict';
const C=require('./constants'),M=require('./model'),B=require('./combat'),U=require('./ui'),H=require('./health'),Boss=require('./boss'),R=require('./rescue');
const ok=C.requireThat,base=(a,...args)=>['gmstory',a,...args].join(':');
function createStory({snapshot,tx,store,client,needGM,textChannel,features}) {
  function home(s,b) {
    const j=b.judgment;return U.payload('GM救援与裁决 · '+b.name,'状态 '+b.status+'\n'+R.players(s,b).map(a=>a.name+' · '+H.text(s.players[a.userId])).join('\n')+'\n暂停期间可以加入支援；救援结果保存后由GM明确恢复战斗。',[
      U.row(U.button(base('reinforce',b.id),'加入玩家 / 友方NPC',undefined,b.status!=='paused'||!!b.pending),U.button(base('eventnew',b.id),'编写救援事件',U.D.ButtonStyle.Primary,j?.status!=='pending'||!!b.pending),U.button(base('deathreason',b.id,j?.id||'_',j?.version||0),'全队死亡裁决',U.D.ButtonStyle.Danger,j?.status!=='pending'||!!b.pending)),
      U.row(U.button('gmcontrol:'+b.id+':resume','恢复战斗',U.D.ButtonStyle.Success,b.status!=='paused'),U.button(base('home',b.id),'刷新'),...(j?[U.button(base('review','rescue',b.id),'通知核对 / 补发')]:[]))]);
  }
  function reinforcement(s,b,page=0) {
    const list=Object.values(s.npcTemplates).filter(t=>t.published).slice(page*20,page*20+20);return U.payload('加入援军 · '+b.name,'剩余参战名额 '+(20-b.actors.length)+'；不会移动旧角色或重置旧AP。',[
      U.row(new U.D.UserSelectMenuBuilder().setCustomId('rpg:'+base('addplayer',b.id)).setPlaceholder('选择有效玩家作为援军').setMinValues(1).setMaxValues(1)),
      ...(list.length?[U.row(U.select(base('addnpc',b.id),'选择友方NPC模板',list.map(t=>({label:t.name,value:t.id}))))]:[]),
      U.row(U.button(base('reinforce',b.id,Math.max(0,page-1)),'上一页NPC',undefined,!page),U.button(base('reinforce',b.id,page+1),'下一页NPC',undefined,list.length<20),U.button(base('home',b.id),'返回'))]);
  }
  function owned(s,id,uid) {const f=s.forms[id];ok(f?.kind==='rescueEvent'&&f.owner===uid&&!f.done&&f.expiresAt>Date.now(),'救援草稿已失效。');return f;}
  function eventView(s,f,preview=false) {
    const b=s.battles[f.battleId],list=R.players(s,b),text=f.rp||'请填写GM救援叙述。';
    if(preview)return U.payload('救援结果预览',text+'\n'+f.results.map(r=>r.name+' · 正常HP '+r.before.hp+'→'+r.after.hp+' · 倒地HP '+r.before.reserveHP+'→'+r.after.reserveHP+(r.revived?' · 起身':'')).join('\n'),[U.row(U.button(base('eventcommit',f.id,f.version),'确认救援',U.D.ButtonStyle.Success),U.button(base('eventback',f.id,f.version),'返回修改'))]);
    return U.payload('GM救援事件草稿',text+'\n每人治疗 '+f.amount+'\n已选 '+f.refs.length+'人',[
      U.row(U.select(base('eventtargets',f.id,f.version),'选择本次受益玩家',list.map(a=>({label:a.name,value:a.id,default:f.refs.includes(a.id)})),1,list.length)),U.row(U.button(base('eventedit',f.id,f.version),'叙述与治疗量'),U.button(base('eventpreview',f.id,f.version),'预览结果',U.D.ButtonStyle.Success),U.button(base('home',b.id),'返回裁决'))]);
  }
  function bossCard(s,m,ref) {const r=m.cells[ref].room,q=r.bossRequest;return U.payload('GM确认BOSS遭遇 · '+r.snapshot.name,'地图 '+m.name+' · 格子 '+ref+'\n状态 '+q.status+'\n整组敌人 '+r.npcs.reduce((n,e)=>n+e.quantity,0)+'名 · 本批剩余 '+r.remainingNpcs.reduce((n,e)=>n+e.quantity,0)+'名\n'+Object.keys(m.participants).map(uid=>s.players[uid]?.name||'角色变化').join('、'),[
    U.row(U.button(base('bossconfirm',m.id,ref,q.id,q.version),'确认本批开战',U.D.ButtonStyle.Success,q.status!=='pending'),U.button(base('bosspending',m.id,ref),'暂缓 / 刷新'),U.button(base('review','boss',m.id,ref),'通知核对 / 补发'))]);}
  async function notice(guild,ref) {
    const [kind,id,cell]=ref.split('/'),get=s=>kind==='boss'?s.explorations[id]?.cells[cell]?.room?.bossRequest:s.battles[id]?.judgment;
    let s=snapshot(guild),q=get(s);if(!q)return;if(['sending','uncertain'].includes(q.notification.status))return;
    const ch=await textChannel(guild,s.config.rpChannelId);await require('./rp').verifyChannel(await client.guilds.fetch(guild),ch,s);
    const view=()=>kind==='boss'?bossCard(s,s.explorations[id],cell):home(s,s.battles[id]);
    if(q.notification.messageId){const msg=await ch.messages.fetch(q.notification.messageId);ok(msg.author?.id===client.user.id,'GM通知归属不符，停止修改。');await msg.edit(view());return;}
    if(q.status!=='pending')return;const noticeId=q.id,attempt=q.notification.attempt||0,sendKey=noticeId+':'+attempt;
    const authorized=await store.transact(guild,'gm-notice-intent:'+sendKey,client.user.id,st=>{const live=get(st);if(live?.id!==noticeId||live.status!=='pending'||live.version!==q.version)return false;live.notification.status='sending';return true;},'GM隐藏通知意图',{delivery:false});
    if(!authorized)return;s=snapshot(guild);
    try {const message=await ch.send({...view(),content:s.config.gmRoleIds.map(id=>'<@&'+id+'>').join(' '),allowedMentions:{parse:[],roles:s.config.gmRoleIds},nonce:noticeId+String(attempt),enforceNonce:true});
      await store.transact(guild,'gm-notice-sent:'+sendKey,client.user.id,st=>{const live=get(st);if(live?.id===noticeId)live.notification={status:'sent',messageId:message.id,channelId:ch.id,attempt};},'GM隐藏通知送达',{delivery:false});
    }catch(e){await store.transact(guild,'gm-notice-uncertain:'+sendKey,client.user.id,st=>{const live=get(st);if(live?.id===noticeId)live.notification.status='uncertain';},'GM隐藏通知待核对',{delivery:false}).catch(()=>{});throw e;}
  }
  async function openModal(i,s) {
    if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:gmstory:'))return false;const [action,id,x,y]=i.customId.split(':').slice(2);if(!['eventedit','deathreason','singledeath','reserve'].includes(action))return false;needGM(s,i.member);
    let fields,title,custom;
    if(action==='eventedit'){const f=owned(s,id,i.user.id);ok(f.version===Number(x),'草稿已变化。');fields=[{key:'rp',label:'公开救援叙述（最多1000字）',value:f.rp,paragraph:true,maxLength:1000},{key:'amount',label:'每名目标治疗量，先补倒地血',value:f.amount}];title='GM救援事件';custom=base('eventeditsubmit',id,x);}
    else if(action==='reserve'){const b=s.battles[id],a=B.actorById(b,x);ok(b.status==='paused'&&!b.pending&&H.downed(B.actorCharacter(s,a)),'暂停并选择倒地角色。');fields=[{key:'hp',label:'倒地HP；0会进入明确死亡确认',value:B.actorCharacter(s,a).life.reserveHP}];title='调整倒地血';custom=base('reservesubmit',id,x);}
    else {const b=s.battles[id];ok(b?.status==='paused'&&!b.pending,'先暂停并完成受击结算。');if(action==='deathreason')R.pending(s,b,x,y);fields=[{key:'reason',label:'判死理由（将保存审计）',paragraph:true,maxLength:1000}];title='明确判死理由';custom=base(action==='singledeath'?'singlepreview':'deathpreview',id,x,y);}
    await i.showModal(U.modal(custom,title,fields));return true;
  }
  async function component(i,member) {
    const [action,id,x,y,z,v]=i.customId.split(':').slice(2),s=snapshot(i.guildId),uid=i.user.id;needGM(s,member);
    if(action==='home')return home(s,s.battles[id]);if(action==='reinforce')return reinforcement(s,s.battles[id],Number(x)||0);
    if(action==='bosspending')return bossCard(s,s.explorations[id],x);
    if(action==='review'){const q=id==='boss'?s.explorations[x]?.cells[y]?.room?.bossRequest:s.battles[x]?.judgment;ok(q,'通知不存在。');return U.payload('GM通知核对',q.notification.status+'\n核对隐藏频道是否已有该通知；确认没有后才允许重发。',[U.row(U.button(base('retry',id,x,y||'_',q.id,q.version),'已核对没有消息，允许补发',U.D.ButtonStyle.Danger))]);}
    if(action==='retry'){await tx(i,st=>{needGM(st,member);const q=id==='boss'?st.explorations[x].cells[y].room.bossRequest:st.battles[x].judgment;ok(q.id===z&&q.version===Number(v),'通知已变化，请重新核对。');ok(!q.notification.messageId,'已登记送达，不能重复发送。');q.notification.attempt=(q.notification.attempt||0)+1;q.notification.status='pending';require('./outbox').put(st,'gmNotice',[id,x,...(id==='boss'?[y]:[])].join('/'),{priority:1});},'GM核对后重发隐藏通知');return U.payload('已安排补发','后台会重新核对频道权限。');}
    if(action==='bossconfirm'){const ch=await textChannel(i.guildId,s.config.rpChannelId);await require('./rp').verifyChannel(i.guild,ch,s);const b=await store.transact(i.guildId,'boss-confirm:'+y,uid,st=>{needGM(st,member);ok(st.config.rpChannelId===ch.id,'隐藏频道配置已变化。');return Boss.confirm(st,id,x,y,z);},'GM确认BOSS遭遇');return U.battleView(snapshot(i.guildId),snapshot(i.guildId).battles[b.id]);}
    if(['addplayer','addnpc'].includes(action)){await tx(i,st=>{needGM(st,member);const b=st.battles[id];if(action==='addplayer')R.addPlayer(st,b,i.values[0]);else {ok(b.status==='paused'&&!b.pending,'先暂停并结算受击。');const a=B.addNPC(st,b,i.values[0],'ally');R.place(b,a);require('./ammunition').primeNPC(a.character);a.initialAmmoLoaded=true;if(b.judgment){b.judgment.version++;b.judgment.status='supported';}}},'加入救援援军');return home(snapshot(i.guildId),snapshot(i.guildId).battles[id]);}
    if(action==='eventnew'){const f=await tx(i,st=>{needGM(st,member);const b=st.battles[id],j=b.judgment;R.pending(st,b,j?.id,j?.version);const f={id:C.id('f'),kind:'rescueEvent',owner:uid,battleId:id,judgmentId:j.id,judgmentVersion:j.version,refs:[],amount:1,rp:'',version:0,expiresAt:Date.now()+3600000};st.forms[f.id]=f;return f;},'创建救援事件草稿');return eventView(snapshot(i.guildId),f);}
    if(action.startsWith('event')) {
      const f=await store.transact(i.guildId,action==='eventcommit'?'rescue-event:'+id:i.id,uid,st=>{needGM(st,member);const f=owned(st,id,uid);ok(f.version===Number(x),'草稿已变化。');const b=st.battles[f.battleId];R.pending(st,b,f.judgmentId,f.judgmentVersion);
        if(action==='eventtargets')f.refs=[...i.values];else if(action==='eventeditsubmit'){f.rp=C.text(i.fields.getTextInputValue('rp'),'救援RP',1000);f.amount=C.number(i.fields.getTextInputValue('amount'),'治疗量',1,100000000);}
        else if(action==='eventpreview'){ok(f.refs.length&&f.rp,'请选择角色并填写叙述。');f.results=f.refs.map(ref=>{const a=R.players(st,b).find(a=>a.id===ref);ok(a,'救援目标已变化。');const p=C.clone(st.players[a.userId]);return {name:p.name,...H.heal(p,f.amount)};});f.signature=R.rosterSignature(st,b);f.expiresAt=Date.now()+300000;f.preview=true;}
        else if(action==='eventback')f.preview=false;
        else if(action==='eventcommit'){ok(f.preview&&f.signature===R.rosterSignature(st,b),'生命状态已变化，请重新预览。');f.results=R.event(st,b,f.judgmentId,f.judgmentVersion,f.refs,f.amount,f.rp);f.done=true;}
        else ok(false,'救援入口已失效。');f.version++;return f;
      },'GM救援事件与结果');return f.done?home(snapshot(i.guildId),snapshot(i.guildId).battles[f.battleId]):eventView(snapshot(i.guildId),f,f.preview);
    }
    if(action==='deathpreview'){const f=await tx(i,st=>{needGM(st,member);return R.deathPreview(st,st.battles[id],uid,x,y,i.fields.getTextInputValue('reason'));},'预览全队死亡裁决');return U.payload('确认全队死亡并清空角色资产',f.reason+'\n'+R.players(s,s.battles[id]).map(a=>a.name).join('、'),[U.row(U.button(base('deathcommit',f.id),'确认全部死亡',U.D.ButtonStyle.Danger),U.button(base('home',id),'取消'))]);}
    if(action==='deathcommit'){const result=await store.transact(i.guildId,'party-death:'+id,uid,st=>{needGM(st,member);return R.kill(st,uid,id);},'GM明确全队死亡裁决');return U.payload('死亡裁决已保存',result.names.join('、')+'\n'+result.reason);}
    if(action==='singlepreview'||action==='reservesubmit') {
      if(action==='reservesubmit'&&Number(i.fields.getTextInputValue('hp'))>0){await tx(i,st=>{const b=st.battles[id];ok(b.status==='paused'&&!b.pending,'先暂停并完成受击。');H.set(B.actorCharacter(st,B.actorById(b,x)),i.fields.getTextInputValue('hp'),'reserve');},'调整倒地HP');return home(snapshot(i.guildId),snapshot(i.guildId).battles[id]);}
      const f=await tx(i,st=>{needGM(st,member);const b=st.battles[id],a=B.actorById(b,x),p=B.actorCharacter(st,a);ok(b.status==='paused'&&!b.pending&&!a.deathId,'角色或战斗已变化。');const f={id:C.id('f'),kind:'actorDeath',owner:uid,battleId:id,actorId:x,characterId:p.id,life:JSON.stringify(H.snapshot(p)),lifeVersion:p.life?.version,reason:action==='singlepreview'?C.text(i.fields.getTextInputValue('reason'),'判死理由',1000):'GM将倒地HP设为0',expiresAt:Date.now()+300000,status:'ready'};st.forms[f.id]=f;return f;},'预览单人判死');return U.payload('明确判死确认',B.actorById(s.battles[id],x).name+' · 将清空该玩家角色与资产\n'+f.reason,[U.row(U.button(base('singlecommit',f.id),'确认死亡',U.D.ButtonStyle.Danger),U.button(base('home',id),'取消'))]);
    }
    if(action==='singlecommit'){await store.transact(i.guildId,'actor-death:'+id,uid,st=>{needGM(st,member);const f=st.forms[id];ok(f?.owner===uid&&f.kind==='actorDeath'&&f.expiresAt>Date.now(),'判死确认已失效。');if(f.status==='done')return;const b=st.battles[f.battleId],a=B.actorById(b,f.actorId),p=B.actorCharacter(st,a);ok(b.status==='paused'&&!b.pending&&!a.deathId&&p.id===f.characterId&&f.life===JSON.stringify(H.snapshot(p))&&f.lifeVersion===p.life?.version,'状态变化，请重新预览。');H.forceDeath(p);require('./mortality').settle(st,b,a,{userId:uid});B.record(b,'GM明确判死：'+f.reason,{actorId:a.id,eventType:'death'});f.status='done';},'GM单人明确判死');return U.payload('死亡已保存','历史审计保留。');}
    if(action==='bossassign') {const pools=Object.values(s.bossPools||{}),page=Number(x)||0,part=pools.slice(page*20,page*20+20),m=s.explorations[id],old=Object.entries(m.cells).find(([,c])=>c.room?.boss);return U.payload('选择BOSS池',part.map(p=>p.name).join('\n')||'先在地图配置中新建BOSS池。',[...(part.length?[U.row(U.select(base('bosspool',id),'选择BOSS池',part.map(p=>({label:p.name,value:p.id}))))]:[]),U.row(U.button(base('bossassign',id,Math.max(0,page-1)),'上一页',undefined,!page),U.button(base('bossassign',id,page+1),'下一页',undefined,(page+1)*20>=pools.length),...(old?[U.button(base('bossclear',id,old[0]),'移除尚未进入BOSS房')]:[]))]);}
    if(action==='bosspool'){const poolId=i.values?.[0]||x,m=s.explorations[id],page=Number(y)||0,pool=s.bossPools[poolId];ok(pool,'池已经失效。');const cells=Object.entries(m.cells).filter(([ref,c])=>(c.type==='room'||c.hasContents)&&!c.touched&&!Object.values(m.participants).some(p=>p.cell===ref)),part=cells.slice(page*20,page*20+20);return U.payload('选择BOSS房位置',m.name+' · '+pool.name,[...(part.length?[U.row(U.select(base('bosscell',id,poolId,pool.version),'选择尚未进入的内容格',part.map(([ref,c])=>({label:ref+' · '+(c.room?.snapshot.name||'房间'),value:ref}))))]:[]),U.row(U.button(base('bosspool',id,poolId,Math.max(0,page-1)),'上一页',undefined,!page),U.button(base('bosspool',id,poolId,page+1),'下一页',undefined,(page+1)*20>=cells.length))]);}
    if(action==='bosscell'){const ch=await textChannel(i.guildId,s.config.rpChannelId);await require('./rp').verifyChannel(i.guild,ch,s);await tx(i,st=>{needGM(st,member);ok(st.bossPools[x]?.version===Number(y),'BOSS池已更新，请重新选择。');Boss.assign(st,st.explorations[id],i.values[0],x);},'GM手动分配BOSS房');return U.payload('BOSS房已分配','整组怪物已冻结；全队进入后会通知GM确认。');}
    if(action==='bossclear'){await tx(i,st=>Boss.clear(st,st.explorations[id],x),'移除未进入BOSS房');return U.payload('已移除BOSS配置','恢复原房间内容。');}
    ok(false,'GM剧情入口已经失效。');
  }
  return {home,reinforcement,eventView,bossCard,notice,openModal,component};
}
module.exports={createStory};
