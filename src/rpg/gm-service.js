'use strict';
const C=require('./constants'),M=require('./model'),B=require('./combat'),F=require('./forms'),H=require('./health');
const {createHash}=require('node:crypto'),ok=C.requireThat;
const KINDS={item:'catalog',skill:'skillTemplates',checkskill:'checkSkillTemplates',trait:'traits',condition:'conditionTemplates',npc:'npcTemplates',mapcategory:'mapCategories',room:'roomTemplates',rolepanel:'rolePanels',coupon:'couponPools',boss:'bossPools',merchant:'merchantTemplates',glossary:'glossaryTerms'};
function error(message,code='VALIDATION'){const e=Error(message);e.code=code;throw e;}
function version(actual,expected){if(Number(actual||0)!==Number(expected))error('内容已被修改，请查看差异并重新确认。','CONFLICT');}
const volatile=new Set(['messageId','auxiliaryMessages','boardPublication','notifiedTurn','notifiedPause','publicEvents','npcCards','history','recent','events','notification','publication','defenseNotifications','webPublication']);
function fingerprint(value){return createHash('sha256').update(JSON.stringify(value, (k,v)=>volatile.has(k)?undefined:v)??'null').digest('hex');}
function publishBatch(s,rows,owner){
  ok(Array.isArray(rows)&&rows.length>0&&rows.length<=100,'每批录入1—100条。');
  const ids=new Set(),results=[];
  for(const row of rows){const source=KINDS[row.kind];ok(source,'模板类型无效。');
    if(row.id){ok(!ids.has(source+':'+row.id),'同一批不能重复修改同一模板。');ids.add(source+':'+row.id);ok(s[source]?.[row.id],'模板不存在。');version(s[source][row.id].version,row.baseVersion);}
    else ok(!row.baseVersion,'新模板基线应为0。');
    const d=C.clone(row.data);ok(d&&typeof d==='object'&&!Array.isArray(d),'模板数据无效。');let t;
    if(['coupon','boss','merchant','glossary'].includes(row.kind))t=require('./'+({coupon:'coupons',boss:'boss',merchant:'merchant',glossary:'glossary'}[row.kind])).publish(s,d,row.id,row.baseVersion||0);
    else {const f=F.create(s,owner,row.kind,d.kind,row.id);f.data={...f.data,...d};t=F.publish(s,f);delete s.forms[f.id];}
    if(d.enabled===false)t.published=false;
    results.push({kind:row.kind,id:t.id,name:t.name||t.title,version:t.version,published:t.published});
  }
  return results;
}
function grantOne(s,uid,type,ref,quantity){
  const p=M.player(s,uid),n=C.number(quantity,'数量',1,type==='xp'?1000000000:type==='points'||type==='tickets'||type==='coupon'?100000:100);
  if(type==='item'){ok(s.catalog[ref]?.kind!=='杂物','常规发放不包含杂物。');return M.issue(s,uid,ref,n).map(i=>({id:i.id,name:i.snapshot.name,quantity:i.quantity}));}
  if(type==='xp')return M.grantXP(s,uid,n);
  if(type==='points'){p.points=C.number(p.points+n,'自由点余额',0,1000000);return {points:p.points};}
  if(type==='tickets'){ok(ref==='抽卡'||C.BOXES.includes(ref),'次数类型无效。');if(ref==='抽卡')p.tickets.card=C.number(p.tickets.card+n,'抽卡次数',0,1000000);else p.tickets.boxes[ref]=C.number((p.tickets.boxes[ref]||0)+n,'开箱次数',0,1000000);return {ref,quantity:n,type:ref,amount:n};}
  if(type==='coupon'){return require('./coupons').grant(s,ref,[{uid,characterId:p.id,quantity:n}]);}
  if(type==='skill'){ok(M.battleFor(s,uid)?.status!=='active','战斗中请先暂停。');ok(n===1,'技能授予数量为1。');return require('./skills').grant(p,s.skillTemplates[ref]);}
  if(type==='checkskill'){ok(n===1,'鉴定技能授予数量为1。');const t=s.checkSkillTemplates[ref];ok(t?.published,'技能不存在。');p.checkSkills||={};ok(!p.checkSkills[ref],'已拥有该鉴定技能。');return p.checkSkills[ref]={templateId:ref,name:t.name,level:t.level,xp:0,version:1,templateVersion:t.version};}
  error('发放类型无效。');
}
function grantBatch(s,rows){
  ok(Array.isArray(rows)&&rows.length&&rows.length<=625,'发放清单无效。');const grouped=new Map();
  for(const row of rows){const list=grouped.get(row.uid)||[];list.push(row);grouped.set(row.uid,list);}
  ok(grouped.size<=25,'一次最多25名角色。');const results=[];
  for(const [uid,list]of grouped){try{const p=M.player(s,uid);ok(list.every(r=>r.characterId===p.id),'目标角色已变化。');const items=list.filter(r=>r.type==='item');ok(new Set(items.map(r=>r.ref)).size<=25&&items.reduce((n,r)=>n+Number(r.quantity),0)<=100,'每角色最多25种、总计100件物品。');
    const totals=new Map();for(const r of list){const key=r.type+':'+(r.ref||'');totals.set(key,(totals.get(key)||0)+Number(r.quantity));const cap=r.type==='xp'?1000000000:['points','tickets','coupon'].includes(r.type)?100000:r.type==='item'?100:1;ok(totals.get(key)<=cap,'同一项目累计数量超过单次发放上限。');}
    const staged={...s,players:{...s.players,[uid]:C.clone(p)}};const entries=list.map(r=>({type:r.type,ref:r.ref,result:grantOne(staged,uid,r.type,r.ref,r.quantity)}));s.players[uid]=staged.players[uid];results.push({uid,name:p.name,success:true,entries});
  }catch(e){results.push({uid,success:false,reason:e.message});}}
  return results;
}
function editable(b){ok(b&&['recruiting','paused'].includes(b.status)&&!b.pending,'请先暂停并完成待防守结算。');}
function apply(s,user,command,p){
  if(command==='templates.publish')return publishBatch(s,p.rows,user);
  if(command==='grant')return grantBatch(s,p.rows);
  if(command==='character.key'){const i=M.player(s,p.uid).inventory[p.itemId];ok(i?.snapshot.kind==='钥匙'&&M.available(s,p.uid,p.itemId)>0,'钥匙不存在或被预留。');i.keyCharges=C.number(p.quantity,'次数',0,100000);return {name:i.snapshot.name,keyCharges:i.keyCharges};}
  if(command==='death.reward'){const d=s.deaths[p.id];ok(d,'死亡记录不存在。');return require('./mortality').reward(s,s.battles[d.battleId],d,p.uid);}
  if(command==='npc.portrait'){const t=s.npcTemplates[p.id];ok(t,'NPC模板不存在。');version(t.version,p.baseVersion);ok(['avatar','illustration'].includes(p.slot),'图片位置无效。');t.portraits||={};if(p.clear)delete t.portraits[p.slot];else {const f=s.forms[p.uploadId];ok(f?.kind==='gmWebPortrait'&&f.owner===user&&f.status==='done'&&f.npcId===t.id&&f.slot===p.slot,'请选择本人已完成的图片上传。');t.portraits[p.slot]=C.clone(f.ref);}t.version++;return {id:t.id,name:t.name,version:t.version,slot:p.slot};}
  if(command==='map.cleanup'){const Clean=require('./map-cleanup'),entries=Clean.preview(s).filter(e=>p.ids.includes(e.id));ok(entries.length===p.ids.length,'清理对象已变化。');const r=Clean.remove(s,entries);s.mapCleanupMessages||={};for(const e of r.messages)s.mapCleanupMessages[e.channelId+':'+e.messageId]={...e,done:false};require('./outbox').put(s,'mapCleanup','all',{priority:10});return r;}
  if(command==='character.luck'){const a=M.player(s,p.uid);a.luck=C.number(p.value,'基础时运',-9,11);return {luck:a.luck};}
  if(command==='character.delete'){ok(C.text(p.reason,'销卡理由',1000),'请填写理由。');ok(M.player(s,p.uid).id===p.characterId,'角色已变化。');M.deleteCharacter(s,p.uid);return {deleted:p.uid,reason:p.reason};}
  if(command==='character.skillRemove'){ok(M.battleFor(s,p.uid)?.status!=='active','战斗中请先暂停。');const a=M.player(s,p.uid);ok(a.learnedSkills?.[p.ref],'技能不存在。');delete a.learnedSkills[p.ref];return {removed:p.ref};}
  if(command==='character.checkXP'){const a=M.player(s,p.uid),skill=a.checkSkills?.[p.ref];ok(skill,'尚未学习鉴定技能。');const n=C.number(p.quantity,'技能经验',1,1000000000);skill.xp=(skill.xp||0)+n;skill.level+=Math.floor(skill.xp/100);skill.xp%=100;skill.version=(skill.version||1)+1;return skill;}
  if(command==='buyback'){return M.createOffer(s,user,p.uid,'buyback',p.itemId,C.number(p.quantity,'数量',1,100000),C.number(p.price,'总价',0,C.MAX_MONEY));}
  if(command==='text.save'){require('./texts').get(s,p.key);s.config.textOverrides||={};version(s.config.textOverrides[p.key]?.version,p.baseVersion);return s.config.textOverrides[p.key]={text:C.text(p.text,'正文',4000),version:Number(p.baseVersion)+1,at:Date.now(),editor:user};}
  if(command==='container.set'){const K=require('./containers');if(p.grade)K.setGrade(s,p.name,p.grade);if(p.enabled!==undefined){s.containerDefinitions||=K.definitions();const d=s.containerDefinitions[p.name];ok(d,'容器不存在。');d.enabled=!!p.enabled;d.version++;}return require('./containers').get(s,p.name);}
  if(command==='container.rates'){require('./loot').setGradeRates(s,p.grade,p.rates);return {grade:p.grade,rates:p.rates};}
  if(command==='config.save'){s.config={...s.config,...p.data};return {saved:Object.keys(p.data)};}
  if(command==='map.quickCreate'){
    require('./gm-context-data').validateQuick(s,p);
    // Stage the complete map so callers also cannot retain a partial map on failure.
    const staged={...s,explorations:{...s.explorations}},layout=require('./random-layout');
    if(p.mode==='full')staged.mapCategories=Object.fromEntries(Object.entries(s.mapCategories).filter(([id])=>require('./gm-context-data').mapOptions(s).categories.some(c=>c.id===id&&c.usable)));
    const m=layout.create(staged,user,p.channelId,p.name,p.mapType,p.mode,p.categoryId,p.rows,p.width,p);
    if(p.mode!=='fixed')require('./exploration').generate(staged,m);
    s.explorations[m.id]=m;return {id:m.id,name:m.name,status:m.status,version:m.version,generated:!!m.generated,createdMap:true};
  }
  if(command==='map.create')return require('./random-layout').create(s,user,p.channelId,p.name,p.mapType,p.mode,p.categoryId,p.rows,p.width,p);
  if(command.startsWith('map.')){const X=require('./exploration'),m=s.explorations[p.mapId];ok(m&&m.status!=='ended','地图不存在或已结束。');
    switch(command){case'map.generate':X.generate(s,m);break;case'map.layout':require('./random-layout').build(m,m.generation||{});X.generate(s,m);break;case'map.link':require('./map-links').bind(s,m,p.cell,p.buildingMapId);break;case'map.transfer':return X.transfer(s,m,p.cell,p.containerId,p.uid);case'map.auto':{ok(['draft','paused'].includes(m.status),'先暂停地图。');const r=m.cells[p.cell]?.room;ok(r,'房间不存在。');r.autoStart=!!p.enabled;m.version++;break;}case'map.playerPosition':case'map.playerRemove':{ok(m.status==='paused'&&m.participants[p.uid]&&!M.battleFor(s,p.uid),'先暂停地图并结束目标战斗。');if(command==='map.playerRemove'){delete m.participants[p.uid];require('./map-links').releaseEmpty(s,m);}else {const c=m.cells[p.cell];ok(c&&X.passable(c)&&(!c.room||c.room.unlocked),'目标格不可用或房门未解锁。');m.participants[p.uid].cell=p.cell;m.revealed[p.cell]=true;c.touched=true;}m.version++;break;}case'map.publish':X.publish(s,m);break;
      case'map.cell':{const key=Number(p.x)+','+Number(p.y),old=m.cells[key],same=old&&old.type===p.type&&old.categoryId===(p.categoryId||m.categoryId)&&(old.templateId||null)===(p.templateId||null)&&(old.variantId||null)===(p.variantId||null);let ref;if(same){ok(['draft','paused'].includes(m.status),'修改布局前请暂停地图。');ref=key;m.version++;}else{ref=X.editCell(s,m,Number(p.x)+1,Number(p.y)+1,p.type,p.categoryId,p.templateId,p.variantId);if(m.status==='draft')m.generated=false;}if(p.type!=='empty'){const c=m.cells[ref];Object.assign(c,{name:C.text(p.name||'','地点名称',80,true),description:C.text(p.description||'','地点说明',2000,true),passable:p.passable!==false,hasContents:!!p.hasContents});if(m.status==='paused'&&!c.room&&(c.type==='room'||c.hasContents))c.room=X.instantiate(s,X.selectRoom(s,m,c),require('node:crypto').randomInt,m.maxRank??10,c.variantId);if(p.buildingMapId)require('./map-links').bind(s,m,ref,p.buildingMapId);}break;}
      case'map.pause':ok(m.status==='active','地图尚未启动。');m.status='paused';m.version++;break;
      case'map.resume':ok(m.status==='paused','地图未暂停。');m.entrance=X.validateMap(m);m.revealed[m.entrance]=true;m.status='active';m.version++;break;
      case'map.end':ok(!m.excursion&&!m.parentContext,'请先让队伍返回区域地图。');ok(!Object.values(s.battles).some(b=>b.exploration?.mapId===m.id&&b.status!=='ended'),'先结束关联战斗。');m.status='ended';m.endedAt=Date.now();m.version++;break;
      case'map.encounter':return X.encounter(s,m,p.cell,p.users);
      case'map.resolve':return X.resolve(s,m,p.cell);
      case'map.boss':return require('./boss').assign(s,m,p.cell,p.poolId);
      case'map.bossClear':return require('./boss').clear(s,m,p.cell);
      case'map.bossConfirm':return require('./boss').confirm(s,m.id,p.cell,p.requestId,p.requestVersion);
      case'map.merchant':return require('./merchant').assign(s,m,p.cell,p.templateId);
      case'map.merchantClear':return require('./merchant').clear(s,m,p.cell);
      case'map.restock':return require('./merchant').restock(s,m.id,p.cell,p.templateId,p.quantity,p.buyQuota);
      case'map.rp':{const r=m.rps?.[p.rpId];ok(r&&r.version===p.rpVersion&&r.status==='pending','RP已变化或正在发布。');r.description=C.text(p.description,'环境RP',4000);r.version++;if(p.skip)require('./rp').release(m,r,'skipped');else {r.status='publishing';r.publication.status='pending';require('./outbox').put(s,'rp',m.id+'/'+r.id,{priority:1});}break;}
      case'map.rpEnabled':ok(['draft','paused'].includes(m.status),'先暂停地图。');m.rpEnabled=!!p.enabled;m.version++;break;
      default:error('地图操作无效。');
    }return {id:m.id,name:m.name,status:m.status,version:m.version};
  }
  if(command==='battle.create')return B.createBattle(s,p.channelId,user,p.name,p.width,p.height);
  if(command.startsWith('battle.')){const b=s.battles[p.battleId];ok(b&&b.status!=='ended','战斗不存在或已结束。');
    switch(command){case'battle.start':B.start(s,b,p.surprise||null);break;case'battle.pause':B.pause(b);break;case'battle.resume':B.pause(b,true);B.nextOpportunity(s,b);break;case'battle.finish':ok(!b.pending&&b.current,'没有可结束的行动。');if(b.status==='paused')b.status='active';B.finish(s,b,b.current.id);break;case'battle.end':B.endBattle(s,b);break;
      case'battle.npc':{editable(b);const a=B.addNPC(s,b,p.templateId,p.team);if(b.judgment){require('./rescue').place(b,a);require('./ammunition').primeNPC(a.character);a.initialAmmoLoaded=true;b.judgment.version++;b.judgment.status='supported';}return a;}
      case'battle.reinforce':return require('./rescue').addPlayer(s,b,p.uid);
      case'battle.position':editable(b);B.position(b,p.actorId,p.x,p.y,p.team);break;
      case'battle.terrain':editable(b);B.setTerrain(b,p.x,p.y,p.type);break;
      case'battle.hp':{editable(b);const a=B.actorById(b,p.actorId);ok(!a.deathId,'角色已死亡。');const actor=B.actorCharacter(s,a);ok(p.bar!=='reserve'||Number(p.value)>0,'归零请使用明确判死。');H.set(actor,p.value,p.bar,b.actionRound?.number);B.record(b,'GM调整生命',{userId:user,actorId:a.id,eventType:'gmHP',healthAfter:H.snapshot(actor)});break;}
      case'battle.condition':{editable(b);const actor=B.actorCharacter(s,B.actorById(b,p.actorId));return B.applyCondition(s,actor,{id:p.templateId,severity:p.severity});}
      case'battle.clearCondition':{editable(b);const actor=B.actorCharacter(s,B.actorById(b,p.actorId));ok(actor.conditions.some(c=>c.id===p.conditionId),'异常不存在。');actor.conditions=actor.conditions.filter(c=>c.id!==p.conditionId);M.syncHP(actor);break;}
      case'battle.remove':{editable(b);const a=B.actorById(b,p.actorId),actor=B.actorCharacter(s,a);b.actors=b.actors.filter(a=>a.id!==p.actorId);b.queue=b.queue.filter(a=>a.actorId!==p.actorId);if(b.current?.actorId===p.actorId)b.current=null;actor.ap=0;delete a.casting;break;}
      case'battle.skill':{editable(b);const a=B.actorById(b,p.actorId);ok(!a.userId&&!a.deathId,'请选择有效NPC。');if(p.remove){ok(a.character.learnedSkills?.[p.ref],'技能不存在。');delete a.character.learnedSkills[p.ref];}else require('./skills').grant(a.character,s.skillTemplates[p.ref]);a.npcVersion=(a.npcVersion||0)+1;break;}case'battle.ai':{const a=B.actorById(b,p.actorId);ok(!a.userId,'只能配置NPC。');a.ai=require('./npc-auto').validate(p.ai);a.npcVersion=(a.npcVersion||0)+1;break;}
      case'battle.equip':{editable(b);const a=B.actorById(b,p.actorId);ok(!a.userId,'这里只管理NPC装备。');M.equipCharacter(a.character,p.itemId,!!p.remove,p.hand||'auto');ok(!M.stats(a.character).overloaded,'NPC超重。');a.npcVersion=(a.npcVersion||0)+1;break;}
      case'battle.action':{const a=B.actorById(b,p.actorId);ok(!a.userId||a.userId===user,'玩家操作由本人执行。');const D=require('./action-drafts');const f=D.create(s,user,{battleId:b.id,actorId:a.id,turnId:b.current?.id,action:p.action,params:p.params});return D.execute(s,f.id,user,p.rp||'');}
      case'battle.rescue':return require('./rescue').event(s,b,p.judgmentId,p.judgmentVersion,p.refs,p.amount,p.rp);
      case'battle.partyDeath':{const R=require('./rescue'),f=R.deathPreview(s,b,user,p.judgmentId,p.judgmentVersion,p.reason);return R.kill(s,user,f.id);}
      case'battle.death':{editable(b);ok(C.text(p.reason,'判死理由',1000),'请填写理由。');const a=B.actorById(b,p.actorId);ok(!a.deathId,'已死亡。');H.forceDeath(B.actorCharacter(s,a));require('./mortality').settle(s,b,a,{userId:user,reason:p.reason});return {name:a.name,deathId:a.deathId,reason:p.reason};}
      default:error('战斗操作无效。');
    }return {id:b.id,name:b.name,status:b.status,current:b.current};
  }
  const A=require('./activities');
  if(command==='check.create')return A.createCheck(s,user,p.channelId,p.data);
  if(command==='session.create')return A.createSession(s,user,p.channelId,p.data);
  if(command==='session.edit')return A.editSession(s,p.id,p.data,p.baseVersion);
  if(command==='session.retry'){const x=s.sessions[p.id];ok(x&&['overdue','failed','uncertain'].includes(x.reminder.status)&&p.absent,'请核对提醒未送达后确认。');x.manualReminder={id:C.id('j'),authorized:true};require('./outbox').put(s,'manualReminder',x.id+'/'+x.manualReminder.id,{priority:1});return {id:x.id,status:'queued'};}
  if(command==='session.close'){const x=s.sessions[p.id];ok(x&&['open','closed','overdue'].includes(x.status)&&x.reminder.status!=='preparing','开团状态已变化。');x.status='closed';x.version++;return {id:x.id,status:x.status};}
  if(command==='session.delivered'){const x=s.sessions[p.id];ok(x&&['uncertain','failed'].includes(x.reminder.status),'提醒状态已变化。');for(const b of x.reminder.batches)if(['sending','uncertain'].includes(b.status))b.status='sent';if(x.reminder.batches.every(b=>b.status==='sent')){x.reminder.status='sent';x.status='notified';}x.version++;return {id:x.id,status:x.status};}
  if(command==='session.cancel'){const x=s.sessions[p.id];ok(x,'开团不存在。');ok(x.reminder.status==='pending','提醒已经发送或待核对。');x.status='cancelled';x.reminder.status='cancelled';x.version++;return {id:x.id,status:x.status};}
  if(command==='check.end'){const x=s.checks[p.id];ok(x,'鉴定不存在。');x.status='ended';x.version++;return {id:x.id,status:x.status};}
  error('操作入口无效。');
}
function rowsFor(command,p){
  ok(p&&typeof p==='object'&&!Array.isArray(p),'操作参数格式无效。');
  if(command!=='grant'&&command!=='templates.publish')return [];
  ok(Array.isArray(p.rows)&&p.rows.every(r=>r&&typeof r==='object'&&!Array.isArray(r)),'批量清单须为有效的列表。');
  return p.rows;
}
function guards(s,command,p){const rows=rowsFor(command,p),refs=[];const add=(source,id)=>{ok(s[source]?.[id],'引用已删除，请重新选择。');refs.push({source,id,hash:fingerprint(s[source][id])});};
  if(p.mapId)add('explorations',p.mapId);if(p.battleId){add('battles',p.battleId);for(const a of s.battles[p.battleId].actors)if(a.userId&&s.players[a.userId])add('players',a.userId);}
  if(p.uid)add('players',p.uid);for(const r of rows){if(r.uid)add('players',r.uid);if(r.ref){const src={item:'catalog',skill:'skillTemplates',checkskill:'checkSkillTemplates',coupon:'couponPools'}[r.type];if(src)add(src,r.ref);}if(r.id&&KINDS[r.kind])add(KINDS[r.kind],r.id);}
  if(p.templateId){const src=command.includes('merchant')?'merchantTemplates':command.startsWith('map.cell')?'roomTemplates':command==='map.restock'?'catalog':command==='battle.condition'?'conditionTemplates':'npcTemplates';add(src,p.templateId);}
  if(command==='map.cleanup')for(const id of p.ids||[])add('explorations',id);if(command==='npc.portrait')add('npcTemplates',p.id);if(command==='death.reward')add('deaths',p.id);if(p.buildingMapId)add('explorations',p.buildingMapId);
  if(p.poolId)add('bossPools',p.poolId);if(p.id&&command.startsWith('session.'))add('sessions',p.id);if(p.id&&command.startsWith('check.'))add('checks',p.id);
  const scan=v=>{if(typeof v==='string'){for(const source of Object.values(KINDS)){if(s[source]?.[v])add(source,v);}}else if(Array.isArray(v)){v.forEach(scan);}else if(v&&typeof v==='object'){Object.values(v).forEach(scan);}};scan(p);refs.push({source:'config',hash:fingerprint(s.config)});return [...new Map(refs.map(r=>[r.source+':'+r.id,r])).values()];
}
function verifyGuards(s,list){const conflicts=list.filter(r=>fingerprint(r.id?s[r.source]?.[r.id]:s[r.source])!==r.hash);if(conflicts.length){const e=Error('相关角色、资源或内容已经变化，请核对差异并重新预览。');e.code='CONFLICT';e.details=conflicts.map(r=>({source:r.source,id:r.id,current:r.id?s[r.source]?.[r.id]:s[r.source]}));throw e;}}
function validateBatch(s,rows,owner){ok(Array.isArray(rows)&&rows.length&&rows.length<=100,'每批录入1—100条。');const seen=new Set();return rows.map((r,n)=>{try{if(r.id){const key=r.kind+':'+r.id;ok(!seen.has(key),'本组重复修改同一模板。');seen.add(key);}const source=KINDS[r.kind];ok(source,'模板类型无效。');const copy={...s,forms:{},[source]:{...s[source]}};return {row:n+1,success:true,...publishBatch(copy,[r],owner)[0]};}catch(e){return {row:n+1,name:r.data?.name,success:false,reason:e.message};}});}
module.exports={KINDS,error,version,fingerprint,publishBatch,validateBatch,grantOne,grantBatch,apply,rowsFor,guards,verifyGuards,editable};
