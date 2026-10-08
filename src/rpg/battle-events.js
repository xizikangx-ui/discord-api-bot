'use strict';
const C=require('./constants'),U=require('./ui');
const {createHash}=require('node:crypto');
function migrateNpcCards(b){
 if(b.npcCardMigrationVersion===1)return;
 b.npcCards||={};b.npcCardCleanup||=[];
 for(const a of b.actors.filter(a=>!a.userId)){
  const events=(b.publicEvents||[]).filter(e=>e.actorId===a.id),latest=events.at(-1);if(!latest)continue;
  const published=events.filter(e=>e.publication?.messageId),keep=published.at(-1);
  b.npcCards[a.id]={actorId:a.id,eventId:latest.id,version:1,publication:{status:keep?'pending':events.some(e=>['sending','uncertain'].includes(e.publication?.status))?'uncertain':'pending',messageId:keep?.publication.messageId}};
  if(b.status!=='ended')for(const e of published)if(e.publication.messageId!==keep?.publication.messageId)b.npcCardCleanup.push({actorId:a.id,messageId:e.publication.messageId,eventId:e.id,status:'pending'});
 }
 b.npcCardMigrationVersion=1;
}
function updateNpc(b,e){const a=b.actors.find(a=>a.id===e.actorId);if(!a||a.userId)return;migrateNpcCards(b);const old=b.npcCards[a.id]||{actorId:a.id,version:0,publication:{status:'pending'}};old.eventId=e.id;old.version++;if(!['sending','uncertain'].includes(old.publication.status))old.publication.status='pending';b.npcCards[a.id]=old;}
function capture(b,entry){if(!b.id)return;const text=entry.message,type=entry.details?.eventType||(/死亡/.test(text)?'death':/移动至/.test(text)?'move':/等待防守/.test(text)?'attack':/伤害，剩余|成功闪避/.test(text)?'result':/开始吟唱|确认吟唱/.test(text)?'casting':/弹药操作/.test(text)?'reload':/切换武器/.test(text)?'switch':/使用.+恢复|使用.+修复/.test(text)?'item':null);if(!type)return;
 const ctx=b.operationContext;entry.details||={};if(b.current&&entry.details.actorId===b.current.actorId){entry.details.turnId||=b.current.id;entry.details.opportunity={roundNumber:b.current.roundNumber,apCost:b.current.apCost,free:!!b.current.free,quick:b.current.quick,formal:b.current.formal,move:b.current.move};}if(ctx&&entry.details.actorId===ctx.actorId){entry.details.operationId=ctx.id;if(ctx.rp&&!ctx.rpAttached&&({attack:['attack','casting'],defend:['result'],cast:['casting'],ammo:['reload'],switch:['switch']}[ctx.action]||[ctx.action]).includes(type)){entry.details.rp={operationId:ctx.id,text:ctx.rp,at:entry.at};ctx.rpAttached=true;}}
 b.publicEvents||=[];let e=type==='move'&&b.publicEvents.find(e=>e.type==='move'&&e.turnId===b.current?.id&&e.actorId===entry.details?.actorId);
 if(e){e.message=text;e.details=C.clone(entry.details);e.at=entry.at;e.version++;e.publication.status='pending';if(entry.details.rp){e.rpEntries||=[];if(!e.rpEntries.some(r=>r.operationId===entry.details.rp.operationId))e.rpEntries.push(C.clone(entry.details.rp));}updateNpc(b,e);return;}
 const details=C.clone(entry.details||{}),actor=b.actors.find(a=>a.id===(details.actorId||details.attackerId)),targetIds=details.targetIds||[];
 const portrait=details.portrait||(actor&&(actor.finalCharacter||actor.character)?.portraits?.avatar);
 e={id:entry.id||C.id('e'),type,turnId:b.current?.id||details.turnId||null,actorId:actor?.id||null,actorName:actor?.name||null,portrait:portrait||null,message:text,details,at:entry.at,version:1,rpEntries:details.rp?[C.clone(details.rp)]:[],publication:{status:'pending'},targetNames:targetIds.map(id=>b.actors.find(a=>a.id===id)?.name||'已离场')};b.publicEvents.push(e);updateNpc(b,e);
}
function lines(e){const d=e.details,out=[];
 if(d.area)out.push('中心 ('+d.area.center.x+', '+d.area.center.y+')米 · 半径 '+d.area.radius+'米');
 if(e.targetNames?.length)out.push('目标：'+e.targetNames.join('、'));
 if(d.ammoRemaining!=null)out.push('剩余载弹：'+d.ammoRemaining+'发'+(d.ammoEmpty?' · ⚠️ 无弹药':''));
 if(d.choice)out.push('防守：'+({defend:'纯防御',dodge:'闪避',both:'同时防守',none:'放弃'}[d.choice])+(d.dodge?' · 闪避骰 '+d.dodge.rolls?.map(r=>r.dice.join('/')).join('、')+'＋修正 = '+d.dodge.total+(d.dodge.success?' 成功':' 失败'):''));
 if(d.breakdown)out.push('实际伤害：'+Object.entries(d.breakdown).map(([k,v])=>C.DAMAGE_TYPES[k]+' '+v).join(' · '));
 if(d.hp!=null)out.push('HP：'+(d.hpBefore??'?')+' → '+d.hp+' / '+d.maxHP+' '+U.bar(d.hp,d.maxHP));
 if(d.healthAfter?.reserveHP!=null)out.push('倒地HP：'+(d.healthBefore?.reserveHP??'?')+' → '+d.healthAfter.reserveHP+' / '+d.healthAfter.maxHP+(d.healthAfter.downed?' · 倒地':' · 待用'));
 if(d.saves?.length)out.push('异常豁免：'+d.saves.map(s=>s.name+' '+s.save.total+'/'+s.save.difficulty+(s.save.success?' 成功':' 失败')).join(' · '));
 if(d.results?.length&&!d.children)for(const r of d.results)out.push(r.after?'救援：'+r.name+' · 正常HP '+r.after.hp+' · 倒地HP '+r.after.reserveHP:'结算：'+r.target+' · 伤害 '+r.total+' · 正常HP '+r.hp+(r.healthAfter?.reserveHP!=null?' · 倒地HP '+r.healthAfter.reserveHP:''));
 if(d.reward)out.push('已确认奖励：实得经验 '+(d.reward.credited??d.reward.xp??0));if(d.opportunity)out.push('行动第'+d.opportunity.roundNumber+'轮 · 本机会'+(d.opportunity.free?'免费':'已扣 '+(d.opportunity.apCost??100)+' AP'));
 if(d.remaining!=null)out.push('剩余移动：'+d.remaining+'米');return out;
}
function settle(b,hit){const e=b.publicEvents?.find(e=>e.type==='attack'&&e.details.groupId===hit.groupId);if(!e)return;const child=e.details.children?.find(h=>h.id===hit.id);if(child)child.result=C.clone(hit.result);e.details.results||=[];const saved=e.details.results.find(r=>r.id===hit.id);if(saved)Object.assign(saved,C.clone(hit.result));else e.details.results.push({id:hit.id,targetId:hit.targetId,...C.clone(hit.result)});e.version++;e.publication.status='pending';const card=b.npcCards?.[e.actorId];if(card?.eventId===e.id){card.version++;if(!['sending','uncertain'].includes(card.publication.status))card.publication.status='pending';}}
const DText=(value,max)=>U.D.escapeMarkdown(String(value).slice(0,max));
function view(b,e,page=0){const children=e.details.children||[],sections=children.length?children.flatMap(h=>Array.from({length:Math.max(1,Math.ceil((h.shots||[]).length/4))},(_,n)=>({child:h,shotPage:n}))):[{shotPage:0}];const ordinaryPages=Math.max(1,Math.ceil((e.details.shots||[]).length/4)),pages=children.length?sections.length:ordinaryPages;page=Math.max(0,Math.min(Number(page)||0,pages-1));const section=children.length?sections[page]:{shotPage:page},shots=section.child?.shots||e.details.shots||[],shotPage=section.shotPage;const labels={attack:'攻击成立',result:'防守与伤害结果',move:'战术移动',death:'死亡结算',pass:'放弃行动',finish:'结束行动机会',flee:'撤退',casting:'技能吟唱',reload:'弹药操作',switch:'切换武器',item:'使用道具',rescue:'GM救援事件',condition:'异常伤害',support:'援军抵达'};
 const rolls=shots.slice(shotPage*4,shotPage*4+4).map((shot,n)=>'第'+(shotPage*4+n+1)+'发/击 · '+Object.entries(shot.rolls||{}).map(([type,r])=>C.DAMAGE_TYPES[type]+'：'+(r.expression||'0')+' ['+(r.rolls||[]).map(x=>x.chosen).join(',')+']'+(r.ammunition?' ＋弹药 '+r.ammunition.total:'')+' = '+(shot.damage?.[type]??r.total)).join('；'));
 const components=[U.row(U.button('battle:'+b.id,'查看战场'),U.button('event:'+b.id+':'+e.id+':'+page,'查看操作记录'))];
 if(e.type==='attack'&&b.pending&&e.details.groupId===b.pending.id)components[0].components.push(U.button('defense:'+b.id+':'+b.pending.id,'打开防守面板',U.D.ButtonStyle.Danger));
 components.push(U.row(U.button('event:'+b.id+':'+e.id+':'+page+':wide','横版大图'),...(e.rpEntries?.length?[U.button('event:'+b.id+':'+e.id+':0:rp','完整RP')]:[])));
 if(pages>1)components.push(U.row(U.button('event:'+b.id+':'+e.id+':'+(page-1),'上一页逐发结果',undefined,!page),U.button('event:'+b.id+':'+e.id+':'+(page+1),'下一页逐发结果',undefined,page===pages-1)));
 const result=section.child?.result;const target=section.child?'\n\n**'+(e.type==='rescue'?'获救角色':'范围目标')+'：'+section.child.name+'** · '+(result?.healed!=null?'正常HP恢复 '+result.healed+'、倒地HP恢复 '+result.reserveHealed+'\n正常HP '+result.healthBefore.hp+'→'+result.healthAfter.hp+' · 倒地HP '+result.healthBefore.reserveHP+'→'+result.healthAfter.reserveHP+(result.revived?' · 已起身':''):result?'已结算，伤害 '+result.total+'，剩余HP '+result.hp:'等待独立防守'):'';
 const feedback=require('./combat-presentation').feedback(e,section),rp=e.rpEntries?.length?'\n\n**角色RP**\n'+DText(e.rpEntries.map(r=>r.text).join('\n'),280):'';const special=(feedback.killed?'💥 **击杀敌人**\n':'')+(feedback.full?'🌟 **满伤害 · 伤害骰全满**\n':'');
 const v=U.payload(labels[e.type],special+require('./combat-presentation').message(e,feedback)+rp+'\n'+lines(e).join('\n')+target+(rolls.length?'\n\n'+rolls.join('\n'):''),components,e.type==='death'?0xcc4455:e.type==='result'?0xdf8b45:0x37b8c3);
 v.embeds[0].setFooter({text:e.id+' · '+(page+1)+'/'+pages+' · 已保存结果，不重新掷骰'});v.allowedMentions={parse:[]};v.rpgMap={kind:'event',event:e,b,page,section,layout:'portrait'};return v;
}
function createEvents({snapshot,store,client,textChannel,render,logFailure}){
 const locks=new Map();
 async function ordered(guild,ref,fn){const key=guild+':'+ref,old=locks.get(key)||Promise.resolve(),next=old.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
 function publish(guild,ref,force=false){return ordered(guild,ref,()=>publishUnlocked(guild,ref,force));}
 async function cleanup(guild,ref,channel){
  for(const item of snapshot(guild).battles[ref].npcCardCleanup||[]){if(item.status!=='pending')continue;
   const b=snapshot(guild).battles[ref],a=b.actors.find(a=>a.id===item.actorId),e=b.publicEvents?.find(e=>e.id===item.eventId);
   if(b.status==='ended')return;
   if(!a||a.userId||e?.actorId!==a.id||e.publication?.messageId!==item.messageId||b.npcCards[a.id]?.publication.messageId===item.messageId)continue;
   try{const message=await channel.messages.fetch(item.messageId).catch(err=>{if(err.code===10008)return null;throw err;});
    const current=snapshot(guild).battles[ref];if(current.status==='ended'||current.npcCards[a.id]?.publication.messageId===item.messageId)return;
    if(message){C.requireThat(message.author.id===client.user.id&&message.channelId===channel.id,'旧NPC操作卡归属不能确认。');await message.delete();}
    await store.transact(guild,'npc-clean:'+item.messageId,client.user.id,st=>{const entry=st.battles[ref].npcCardCleanup.find(x=>x.messageId===item.messageId);if(entry)entry.status='deleted';},'清理活动战斗重复NPC操作卡',{delivery:false});
   }catch(err){logFailure('重复NPC操作卡未能清理，保留历史及玩家消息。',err);}
  }
 }
 async function publishUnlocked(guild,ref,force=false){let b=snapshot(guild).battles[ref];if(!b)return;
  const legacyEnded=b.status==='ended'&&b.npcCardMigrationVersion!==1;
  if(!legacyEnded&&b.npcCardMigrationVersion!==1){await store.transact(guild,'npc-cards-v1:'+ref,client.user.id,st=>migrateNpcCards(st.battles[ref]),'NPC操作卡迁移',{delivery:false});b=snapshot(guild).battles[ref];}
  const channel=await textChannel(guild,b.channelId);
  const tasks=(b.publicEvents||[]).filter(e=>legacyEnded||(!b.npcCards?.[e.actorId]&&!b.actors.some(a=>a.id===e.actorId&&!a.userId))).map(e=>({id:e.id,npc:false}));
  if(!legacyEnded)tasks.push(...Object.keys(b.npcCards||{}).map(id=>({id,npc:true})));
  for(const task of tasks){b=snapshot(guild).battles[ref];const current=task.npc?b.npcCards[task.id]:b.publicEvents.find(e=>e.id===task.id),e=task.npc?b.publicEvents.find(e=>e.id===current.eventId):current;if(!e)continue;
   const publication=current.publication,version=current.version;if(publication.status==='sent'&&publication.version===version)continue;if(!force&&['sending','uncertain'].includes(publication.status))continue;
   const live=st=>task.npc?st.battles[ref].npcCards[task.id]:st.battles[ref].publicEvents.find(e=>e.id===task.id);
   await store.transact(guild,'event-intent:'+C.id('n'),client.user.id,st=>{live(st).publication.status='sending';},'公开战斗事件发送意图',{delivery:false});
   try{const raw=view(b,e),card={...raw,embeds:raw.embeds.map(e=>U.D.EmbedBuilder.from(e).setImage(null)),files:[],attachments:[]};delete card.rpgMap;if(task.npc)card.embeds[0].setTitle('NPC · '+e.actorName+' · 最新操作');
    if(store.select(guild,st=>live(st)?.version)!==version){await store.transact(guild,'event-stale:'+C.id('n'),client.user.id,st=>{live(st).publication.status='pending';},'跳过旧版操作卡图片',{delivery:false});continue;}
    let message=publication.messageId&&await channel.messages.fetch(publication.messageId).catch(err=>{if(err.code===10008)return null;throw err;});
    const nonce=task.npc?createHash('sha256').update(ref+':'+task.id).digest('hex').slice(0,24):e.id;
    message=message?await message.edit(card):await channel.send({...card,nonce,enforceNonce:true});
    await store.transact(guild,'event-sent:'+C.id('n'),client.user.id,st=>{const target=live(st);target.publication={status:target.version===version?'sent':'pending',messageId:message.id,version};target.imagePublication={status:'pending',eventId:e.id,version,messageId:message.id};if(store.backgroundPublications)require('./outbox').put(st,'eventImage',ref+'/'+(task.npc?'npc/':'player/')+task.id,{priority:20});},'公开战斗事件已送达',{delivery:false});
   }catch(err){if(!store.frozen(guild))await store.transact(guild,'event-failed:'+C.id('n'),client.user.id,st=>{live(st).publication.status=typeof err.code==='number'&&err.code>=10000?'failed':'uncertain';},'公开事件等待补发',{delivery:false});logFailure('公开战斗操作卡发送失败，GM可核对后补发。',err);}
  }
  await cleanup(guild,ref,channel);
 }
 async function publishImage(guild,jobRef){const [ref,kind,id]=jobRef.split('/'),s=snapshot(guild),b=s.battles[ref];if(!b)return;const npc=kind==='npc',slot=npc?b.npcCards?.[id]:b.publicEvents?.find(e=>e.id===id),image=slot?.imagePublication;if(!image||image.status==='sent'||slot.publication?.status!=='sent')return;
  const e=b.publicEvents.find(e=>e.id===image.eventId);if(!e)return;const version=slot.version,messageId=image.messageId,eventId=e.id;
  const live=st=>npc?st.battles[ref]?.npcCards?.[id]:st.battles[ref]?.publicEvents?.find(e=>e.id===id);
  const raw=view(b,e);raw.rpgMap.backgroundImage=true;const card=await render(guild,raw);if(npc)card.embeds[0].setTitle('NPC · '+e.actorName+' · 最新操作');
  return ordered(guild,ref,async()=>{const same=()=>store.select(guild,st=>{const v=live(st);return v?.version===version&&v.publication?.messageId===messageId&&(!npc||v.eventId===eventId)&&v.publication.status==='sent';});if(!same())return;
  const channel=await textChannel(guild,b.channelId),message=await channel.messages.fetch(messageId).catch(error=>{if(error.code===10008)return null;throw error;});if(!message||!same())return;
  await message.edit(card);await store.transact(guild,'event-image:'+C.id('j'),client.user.id,st=>{const v=live(st);if(v?.version===version&&v.imagePublication?.messageId===messageId)v.imagePublication.status='sent';},'操作卡图片送达',{delivery:false});
  });
 }
 async function component(i,member){const [,,ref,id,page,mode]=i.customId.split(':'),s=snapshot(i.guildId),b=s.battles[ref];C.requireThat(b,'战斗已不存在。');if(id==='retry'){C.requireThat(U.gm(s,member),'补发需要GM。');await publish(i.guildId,ref,true);return U.payload('已补发已有事件','沿用存档中的骰点与结果。');}const e=b.publicEvents?.find(x=>x.id===id);C.requireThat(e,'事件不存在。');if(mode==='rp'){const text=(e.rpEntries||[]).map((r,n)=>(n+1)+'. '+U.D.escapeMarkdown(r.text)).join('\n\n'),pages=Math.max(1,Math.ceil(text.length/1600)),n=Math.max(0,Math.min(Number(page)||0,pages-1));return U.payload('完整角色RP · '+(e.actorName||'角色'),text.slice(n*1600,(n+1)*1600)||'没有附带RP。',[U.row(U.button('event:'+ref+':'+id+':'+(n-1)+':rp','上一页',undefined,!n),U.button('event:'+ref+':'+id+':'+(n+1)+':rp','下一页',undefined,n===pages-1),U.button('event:'+ref+':'+id+':0','返回结果'))]);}const v=view(b,e,page);if(mode==='wide')v.rpgMap.layout='wide';return v;
 }
 return {publish,publishImage,component};
}
module.exports={capture,view,lines,settle,createEvents,migrateNpcCards,updateNpc};
