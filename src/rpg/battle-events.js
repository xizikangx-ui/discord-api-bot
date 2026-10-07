'use strict';
const C=require('./constants'),U=require('./ui');
function capture(b,entry){if(!b.id)return;const text=entry.message,type=/死亡/.test(text)?'death':/移动至/.test(text)?'move':/等待防守/.test(text)?'attack':/伤害，剩余|成功闪避/.test(text)?'result':/开始吟唱|确认吟唱/.test(text)?'casting':/弹药操作/.test(text)?'reload':/切换武器/.test(text)?'switch':/使用.+恢复|使用.+修复/.test(text)?'item':null;if(!type)return;
 b.publicEvents||=[];let e=type==='move'&&b.publicEvents.find(e=>e.type==='move'&&e.turnId===b.current?.id&&e.actorId===entry.details?.actorId);
 if(e){e.message=text;e.details=C.clone(entry.details);e.at=entry.at;e.version++;e.publication.status='pending';return;}
 const details=C.clone(entry.details||{}),actor=b.actors.find(a=>a.id===(details.actorId||details.attackerId)),targetIds=details.targetIds||[];
 const portrait=details.portrait||(actor&&(actor.finalCharacter||actor.character)?.portraits?.avatar);
 e={id:entry.id||C.id('e'),type,turnId:b.current?.id||details.turnId||null,actorId:actor?.id||null,actorName:actor?.name||null,portrait:portrait||null,message:text,details,at:entry.at,version:1,publication:{status:'pending'},targetNames:targetIds.map(id=>b.actors.find(a=>a.id===id)?.name||'已离场')};b.publicEvents.push(e);
}
function lines(e){const d=e.details,out=[];
 if(d.area)out.push('中心 ('+d.area.center.x+', '+d.area.center.y+')米 · 半径 '+d.area.radius+'米');
 if(e.targetNames?.length)out.push('目标：'+e.targetNames.join('、'));
 if(d.ammoRemaining!=null)out.push('剩余载弹：'+d.ammoRemaining+'发'+(d.ammoEmpty?' · ⚠️ 无弹药':''));
 if(d.choice)out.push('防守：'+({defend:'纯防御',dodge:'闪避',both:'同时防守',none:'放弃'}[d.choice])+(d.dodge?' · 闪避骰 '+d.dodge.rolls?.map(r=>r.dice.join('/')).join('、')+'＋修正 = '+d.dodge.total+(d.dodge.success?' 成功':' 失败'):''));
 if(d.breakdown)out.push('实际伤害：'+Object.entries(d.breakdown).map(([k,v])=>C.DAMAGE_TYPES[k]+' '+v).join(' · '));
 if(d.hp!=null)out.push('HP：'+(d.hpBefore??'?')+' → '+d.hp+' / '+d.maxHP+' '+U.bar(d.hp,d.maxHP));
 if(d.saves?.length)out.push('异常豁免：'+d.saves.map(s=>s.name+' '+s.save.total+'/'+s.save.difficulty+(s.save.success?' 成功':' 失败')).join(' · '));
 if(d.remaining!=null)out.push('剩余移动：'+d.remaining+'米');return out;
}
function settle(b,hit){const e=b.publicEvents?.find(e=>e.type==='attack'&&e.details.groupId===hit.groupId);if(!e?.details.children)return;const child=e.details.children.find(h=>h.id===hit.id);if(child){child.result=C.clone(hit.result);e.version++;e.publication.status='pending';}}
function view(b,e,page=0){const children=e.details.children||[],sections=children.length?children.flatMap(h=>Array.from({length:Math.max(1,Math.ceil((h.shots||[]).length/4))},(_,n)=>({child:h,shotPage:n}))):[{shotPage:0}];const ordinaryPages=Math.max(1,Math.ceil((e.details.shots||[]).length/4)),pages=children.length?sections.length:ordinaryPages;page=Math.max(0,Math.min(Number(page)||0,pages-1));const section=children.length?sections[page]:{shotPage:page},shots=section.child?.shots||e.details.shots||[],shotPage=section.shotPage;const labels={attack:'攻击成立',result:'防守与伤害结果',move:'战术移动',death:'死亡结算',casting:'技能吟唱',reload:'弹药操作',switch:'切换武器',item:'使用道具'};
 const rolls=shots.slice(shotPage*4,shotPage*4+4).map((shot,n)=>'第'+(shotPage*4+n+1)+'发/击 · '+Object.entries(shot.rolls||{}).map(([type,r])=>C.DAMAGE_TYPES[type]+'：'+(r.expression||'0')+' ['+(r.rolls||[]).map(x=>x.chosen).join(',')+']'+(r.ammunition?' ＋弹药 '+r.ammunition.total:'')+' = '+(shot.damage?.[type]??r.total)).join('；'));
 const components=[U.row(U.button('battle:'+b.id,'查看战场'),U.button('event:'+b.id+':'+e.id+':'+page,'查看操作记录'))];
 if(e.type==='attack'&&b.pending)components[0].components.push(U.button('defense:'+b.id+':'+b.pending.id,'打开防守面板',U.D.ButtonStyle.Danger));
 if(pages>1)components.push(U.row(U.button('event:'+b.id+':'+e.id+':'+(page-1),'上一页逐发结果',undefined,!page),U.button('event:'+b.id+':'+e.id+':'+(page+1),'下一页逐发结果',undefined,page===pages-1)));
 const target=section.child?'\n\n**范围目标：'+section.child.name+'** · '+(section.child.result?'已结算，伤害 '+section.child.result.total+'，剩余HP '+section.child.result.hp:'等待独立防守'):'';
 const v=U.payload(labels[e.type],e.message+'\n'+lines(e).join('\n')+target+(rolls.length?'\n\n'+rolls.join('\n'):''),components,e.type==='death'?0xcc4455:e.type==='result'?0xdf8b45:0x37b8c3);
 v.embeds[0].setFooter({text:e.id+' · '+(page+1)+'/'+pages+' · 已保存结果，不重新掷骰'});v.allowedMentions={parse:[]};v.rpgMap={kind:'event',event:e,b};return v;
}
function createEvents({snapshot,store,client,textChannel,render,logFailure}){
 async function publish(guild,ref,force=false){let b=snapshot(guild).battles[ref];const channel=await textChannel(guild,b.channelId);
  for(const initial of b.publicEvents||[]){let e=snapshot(guild).battles[ref].publicEvents.find(e=>e.id===initial.id);if(e.publication.status==='sent'&&e.publication.version===e.version)continue;if(!force&&['sending','uncertain'].includes(e.publication.status))continue;
   const version=e.version;await store.transact(guild,'event-intent:'+C.id('n'),client.user.id,st=>{st.battles[ref].publicEvents.find(x=>x.id===e.id).publication.status='sending';},'公开战斗事件发送意图');
   try{b=snapshot(guild).battles[ref];e=b.publicEvents.find(x=>x.id===e.id);const card=await render(guild,view(b,e));let message=e.publication.messageId&&await channel.messages.fetch(e.publication.messageId).catch(err=>{if(err.code===10008)return null;throw err;});message=message?await message.edit(card):await channel.send({...card,nonce:e.id,enforceNonce:true});await store.transact(guild,'event-sent:'+C.id('n'),client.user.id,st=>{const live=st.battles[ref].publicEvents.find(x=>x.id===e.id);live.publication={status:live.version===version?'sent':'pending',messageId:message.id,version};},'公开战斗事件已送达');}
   catch(err){if(!store.frozen(guild))await store.transact(guild,'event-failed:'+C.id('n'),client.user.id,st=>{st.battles[ref].publicEvents.find(x=>x.id===e.id).publication.status=typeof err.code==='number'?'failed':'uncertain';},'公开事件等待补发');logFailure('公开战斗操作卡发送失败，GM可核对后补发。',err);}
  }
 }
 async function component(i,member){const [,,ref,id,page]=i.customId.split(':'),s=snapshot(i.guildId),b=s.battles[ref];C.requireThat(b,'战斗已不存在。');if(id==='retry'){C.requireThat(U.gm(s,member),'补发需要GM。');await publish(i.guildId,ref,true);return U.payload('已补发已有事件','沿用存档中的骰点与结果。');}const e=b.publicEvents?.find(x=>x.id===id);C.requireThat(e,'事件不存在。');return view(b,e,page);}
 return {publish,component};
}
module.exports={capture,view,lines,settle,createEvents};
