'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), F = require('./forms'), U = require('./ui');
const { createCharacterPanel } = require('./character-panel');
const { createPortraits } = require('./portraits');
const { createBulkIssue } = require('./bulk-issue');
const { createEquipment } = require('./equipment');
const { createCheckSkills } = require('./check-skills');
const AI=require('./npc-auto'), Team=require('./team-movement');
const {createNpcPanel}=require('./npc-panel'),{createAmmunitionPanel}=require('./ammunition-panel');
const { createStore } = require('./store');
const { commands } = require('./commands');
const { chapters } = require('./rules');
const { createHandlers } = require('./handlers');
const A = require('./activities');
const { createActivities } = require('./activities-ui');
const { createBattleGM } = require('./battle-gm');
const { createNavigation } = require('./navigation');
const { createBuyback, availability } = require('./buyback');
const { createFactions } = require('./factions');
const Text=require('./texts');
const { createSelections } = require('./selections');
const { createExploration } = require('./exploration-ui');
const { requireThat: ok, number: num } = C;
const { D, E, row, button, select, payload, modal } = U;
const commandNames = new Set(commands().map(c => c.name));
const dangerous = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageThreads', 'ManageMessages',
  'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageWebhooks', 'MentionEveryone', 'ManageEvents', 'ManageGuildExpressions'];
const dangerBits = dangerous.filter(k => D.PermissionFlagsBits[k]).reduce((s, k) => s | D.PermissionFlagsBits[k], 0n);
function createRpg(deps) {
  const { client, guildIds, logFailure } = deps;
  const metrics=deps.metrics||require('./metrics').createMetrics({enabled:process.env.RPG_PERFORMANCE_METRICS==='1'});
  const store = createStore({...deps,metrics});
  const ready = new Set(), publishing = new Map(), roleLocks = new Set(), ticking = new Set();
  let timer,backupTimer;const mediaJobs=new Set(),interactions=new Set(),tickJobs=new Set();
  const enabled = guild => guildIds().includes(guild);
  function snapshot(guild) { ok(ready.has(guild), '跑团存档正在读取或读取失败，暂未启用。'); return store.snapshot(guild); }
  const navigation = createNavigation(snapshot,store.select);
  const needGM = (s, member) => ok(U.gm(s, member), '需要本服务器配置的GM身份组。');
  const needConfig = member => ok(member.permissions.has(D.PermissionFlagsBits.ManageGuild), '配置面板需要“管理服务器”权限。');
  const owner = (i, uid) => ok(uid === i.user.id, '该个人操作面板不属于你，请重新打开自己的面板。');
  const tx = (i, fn, label) => store.transact(i.guildId, i.id, i.user.id, fn, label || i.commandName || i.customId.split(':')[1]);
  const battle = (s, battleId) => { const b = s.battles[battleId]; ok(b, '战斗不存在。'); return b; };
  function channelBattle(s, channelId) {
    const b = Object.values(s.battles).find(b => b.channelId === channelId && b.status !== 'ended');
    ok(b, '当前频道没有有效战斗，请GM /战斗 招募。'); return b;
  }
  function canActor(s, b, actorId, member, userId) {
    const a = B.actorById(b, actorId);
    ok(a.userId === userId || U.gm(s, member), '只能操作自己的角色，NPC由GM操作。');
    return a;
  }
  async function textChannel(guild, id) {
    const ch = await client.channels.fetch(id);
    ok(ch?.guildId === guild && ch.isTextBased() && ch.send, '请选择本服务器可发送消息的文字频道或子区。');
    return ch;
  }
  async function publishBattle(guild,battleId){if(store.backgroundPublications)return store.enqueue(guild,'battle',battleId,{priority:store.select(guild,s=>s.battles[battleId]?.pending)?0:5});return publishBattleNow(guild,battleId);}
  async function publishDefenseNow(guild, battleId) {
    const s=snapshot(guild),b=battle(s,battleId),ch=await textChannel(guild,b.channelId);
    for(const hit of require('./aoe').hits(b).filter(h=>!h.notified&&(!store.backgroundPublications||B.actorById(b,h.targetId).userId||AI.config(B.actorById(b,h.targetId).ai).mode!=='auto'))){
      const target=B.actorById(b,hit.targetId),roles=target.userId?[]:s.config.gmRoleIds;
      const claimed=await store.transact(guild,'auto-defense:'+hit.id,client.user.id,st=>{const live=require('./aoe').hit(st.battles[b.id],hit.id);if(!live)return false;live.notified=true;st.battles[b.id].defenseNotifications||={};st.battles[b.id].defenseNotifications[hit.id]={status:'sending',targetId:hit.targetId,groupId:hit.groupId};return true;},'防守通知发送意图',{delivery:false});
      if(!claimed)continue;
      try{const message=await ch.send({content:(target.userId?'<@'+target.userId+'>':roles.map(r=>'<@&'+r+'>').join(' '))+' **'+target.name+'** 受到攻击，请选择防守。',components:[row(button('defense:'+b.id+':'+hit.id,'打开防守面板',D.ButtonStyle.Danger))],allowedMentions:{parse:[],users:target.userId?[target.userId]:[],roles},nonce:hit.id,enforceNonce:true});
        await store.transact(guild,'auto-prompt:'+message.id,client.user.id,st=>{const battle=st.battles[b.id];battle.auxiliaryMessages||=[];battle.auxiliaryMessages.push(message.id);battle.defenseNotifications[hit.id].status='sent';battle.defenseNotifications[hit.id].messageId=message.id;},'记录防守通知送达',{delivery:false});
      }catch(e){if(!store.frozen(guild))await store.transact(guild,'defense-error:'+hit.id,client.user.id,st=>{st.battles[b.id].defenseNotifications[hit.id].status='uncertain';},'防守通知发送待核对',{delivery:false});throw e;}
    }
  }
  async function publishBattleNow(guild, battleId) {
    const key = guild + ':' + battleId;
    const job = (publishing.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      let s = snapshot(guild), b = battle(s, battleId);
      const ch = await textChannel(guild, b.channelId);
      if(!store.backgroundPublications)await publishDefenseNow(guild,battleId);
      if(b.status==='paused'&&b.pauseReason&&b.notifiedPause!==b.pauseReason){
        const reason=b.pauseReason,roles=s.config.gmRoleIds;
        await store.transact(guild,'pause:'+C.id('t'),client.user.id,st=>{st.battles[b.id].notifiedPause=reason;},'自动操作暂停通知意图');
        await ch.send({content:roles.map(r=>'<@&'+r+'>').join(' ')+' **战斗已暂停**：'+reason,allowedMentions:{parse:[],roles}});
      }
      // Persist notification intent first. Ambiguous send never repeats a ping.
      if (b.current && b.status === 'active' && b.notifiedTurn !== b.current.id) {
        const turnId = b.current.id, a = B.actorById(b, b.current.actorId);
        if(a.userId||AI.config(a.ai).mode!=='auto')await store.transact(guild, 'notice:' + turnId, client.user.id, st => { st.battles[b.id].notifiedTurn = turnId; }, '行动通知');
        const roles = a.userId || AI.config(a.ai).mode==='auto' ? [] : s.config.gmRoleIds;
        const content = (a.userId ? '<@' + a.userId + '>' : roles.map(r => '<@&' + r + '>').join(' ')) +
          ' 轮到 **' + a.name + '** 行动，请打开战场上的个人操作面板。';
        if(a.userId||AI.config(a.ai).mode!=='auto')await ch.send({ content, allowedMentions: { parse: [], users: a.userId ? [a.userId] : [], roles },nonce:turnId,enforceNonce:true });
      }
      await battleEvents.publish(guild,b.id);
      s=snapshot(guild);b=battle(s,battleId);
      if (b.messageId) {
        const message = await ch.messages.fetch(b.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (message) { const version=require('./outbox').fingerprint(b),rendered=await renderer.decorate(guild,U.battleView(s,b));
          if(version===store.select(guild,st=>require('./outbox').fingerprint(st.battles[b.id])))await message.edit(rendered); }
        else await store.transact(guild, 'missing-board:' + b.messageId, client.user.id, st => { st.battles[b.id].messageId = null; }, '战场消息失效');
      }
      s = snapshot(guild); b = battle(s, battleId);
      if (b.status === 'ended') {
        await navigation.clearBattle(guild, battleId);
        for (const id of b.auxiliaryMessages || []) {
          try { const message = await ch.messages.fetch(id); await message.edit({ components: [] }); }
          catch (e) { if (e.code !== 10008) logFailure('战斗防守按钮清理失败。', e); }
        }
      }
      if (!b.messageId) {
        ok(!['sending','uncertain'].includes(b.boardPublication?.status),'战场发送结果待核对，请GM恢复公示。');
        await store.transact(guild,'board-intent:'+C.id('j'),client.user.id,st=>{st.battles[b.id].boardPublication={status:'sending'};},'战场发送意图',{delivery:false});
        try{const message = await ch.send({...await renderer.decorate(guild,U.battleView(s,b)),nonce:b.id,enforceNonce:true});
          await store.transact(guild, 'board:' + message.id, client.user.id, st => { st.battles[b.id].messageId = message.id;st.battles[b.id].boardPublication={status:'sent'}; }, '发布战场',{delivery:false});
        }catch(e){if(!store.frozen(guild))await store.transact(guild,'board-error:'+C.id('j'),client.user.id,st=>{st.battles[b.id].boardPublication={status:typeof e.code==='number'&&e.code>=10000?'failed':'uncertain'};},'战场公示待核对',{delivery:false});throw e;}
      }
      s = snapshot(guild); b = battle(s, battleId);
      if(b.messageId&&b.recruitAnnouncement?.status==='pending'){
        const notice=b.recruitAnnouncement,announcement=await textChannel(guild,notice.channelId);
        await store.transact(guild,'recruit-intent:'+b.id,client.user.id,st=>{st.battles[b.id].recruitAnnouncement.status='sending';},'招募通知意图',{delivery:false});
        try{const message=await announcement.send({content:'战斗招募：'+b.name+'\nhttps://discord.com/channels/'+guild+'/'+b.channelId+'/'+b.messageId,allowedMentions:{parse:[]},nonce:'r'+b.id,enforceNonce:true});
          await store.transact(guild,'recruit-sent:'+b.id,client.user.id,st=>{st.battles[b.id].recruitAnnouncement={...notice,status:'sent',messageId:message.id};},'招募通知送达',{delivery:false});
        }catch(e){await store.transact(guild,'recruit-error:'+C.id('j'),client.user.id,st=>{st.battles[b.id].recruitAnnouncement.status='uncertain';},'招募通知待核对',{delivery:false});throw e;}
      }
      if(!store.backgroundPublications)await exploration.publishCorpsesNow(guild, battleId).catch(e => logFailure('NPC掉落公示失败。', e));
      for (const a of b.actors.filter(a => a.userId && a.deathId)) await navigation.clearUser(guild, a.userId, a.finalCharacter.id);


    });
    publishing.set(key, job);
    try { await job; } finally { if (publishing.get(key) === job) publishing.delete(key); }
  }
  async function tickGuild(guild) {
    if (!ready.has(guild) || store.frozen(guild) || ticking.has(guild)) return;
    ticking.add(guild);
    try {
    const s = snapshot(guild), now = Date.now();
    const expiring = Object.values(s.offers).some(o => ['editing', 'ready'].includes(o.status) && o.expiresAt <= now);
    const due=Object.values(s.battles).filter(b=>require('./aoe').hits(b).some(h=>h.expiresAt<=now));
    const effectsDue = Object.values(s.players).concat(Object.values(s.battles).filter(b => b.status !== 'ended')
      .flatMap(b => b.actors.filter(a => !a.userId && !a.deathId).map(a => B.actorCharacter(s, a))))
      .some(p => p.temporaryEffects?.some(e => e.duration.kind === 'minutes' && e.expiresAt <= now));
    if (expiring || due.length || effectsDue) {
      const expiredCharacters = await store.transact(guild, 'timer:' + C.id('t'), client.user.id, st => {
        M.expireOffers(st, now);
        const expired = A.expireAll(st, now);
        for(const b of Object.values(st.battles))for(const hit of [...require('./aoe').hits(b)])if(hit.expiresAt<=now&&require('./aoe').hit(b,hit.id))B.defend(st,b,hit.id,'defend');
        for (const b of Object.values(st.battles)) if (b.status === 'active') B.nextOpportunity(st, b);
        return expired;
      }, '到期交易及默认防御');
      const changed = Object.values(snapshot(guild).battles).filter(b => b.status !== 'ended' &&
        (due.some(x => x.id === b.id) || b.actors.some(a => expiredCharacters.includes(B.actorCharacter(s, a).id))));
      for (const b of changed) await publishBattle(guild, b.id);
    }
    const before=snapshot(guild);
    const autoDue=Object.values(before.battles).some(b=>AI.due(before,b) || (b.status==='active'&&b.actors.some(a=>AI.config(a.ai).mode==='auto')&&b.actors.some(a=>a.team==='enemy')&&(!B.liveActors(before,b).some(a=>a.team==='enemy')||!B.liveActors(before,b).some(a=>a.team==='ally'))));
    const mapDue=Object.values(before.explorations).some(m=>!require('./rp').waiting(m)&&((m.moves?.[m.moveRequestId]?.status==='pending'&&!Team.valid(before,m,m.moves[m.moveRequestId],now)) || (m.status==='active'&&Object.entries(m.cells).some(([cell,c])=>{const r=c.room;return r&&(r.autoStart??r.snapshot.autoStart)&&((r.encounter==='pending'&&Object.values(m.participants).length&&Object.entries(m.participants).every(([uid,p])=>p.cell===cell&&before.players[uid]?.id===p.characterId&&before.players[uid].hp>0&&!M.battleFor(before,uid)))||(r.encounter==='battle'&&before.battles[r.battleId]?.status==='ended'&&before.battles[r.battleId]?.outcome==='victory'));}))));
    if(autoDue||mapDue){
      const changed=await store.transact(guild,'auto:'+C.id('t'),client.user.id,st=>{
        const ids=new Set(),maps=new Set(),moves=[];
        for(const m of Object.values(st.explorations)){const r=Team.expire(st,m,now);if(r)moves.push({mapId:m.id,id:r.id});}
        for(const ref of Object.keys(st.battles)){
          let b=st.battles[ref];if(b.status!=='active')continue;
          const rollback=C.clone(st);
          try {if(AI.due(st,b)){AI.step(st,b);ids.add(ref);for(let n=0;n<20&&b.pending&&AI.due(st,b);n++)AI.step(st,b);}
            if(!b.pending&&b.actors.some(a=>AI.config(a.ai).mode==='auto')&&b.actors.some(a=>a.team==='enemy')){const live=B.liveActors(st,b);if(!live.some(a=>a.team==='enemy')||!live.some(a=>a.team==='ally')){b.outcome=live.some(a=>a.team==='ally')?'victory':'defeat';B.endBattle(st,b);ids.add(ref);}}
          }catch(e){Object.assign(st,rollback);b=st.battles[ref];b.status='paused';b.pauseReason='NPC自动操作暂停：'+e.message;B.record(b,b.pauseReason);ids.add(ref);}
        }
        const encounters=Team.autoEncounters(st);for(const ref of encounters.battles)ids.add(ref);for(const ref of encounters.maps)maps.add(ref);
        return {battles:[...ids],maps:[...maps],moves};
      },'NPC自动操作及全队探索');
      for(const ref of changed.battles)await publishBattle(guild,ref);
      for(const ref of changed.maps){await exploration.publish(guild,ref);const m=snapshot(guild).explorations[ref];
        if(m.status==='paused'&&m.lastEvent?.startsWith('自动遭遇暂停')&&m.notifiedPause!==m.lastEvent){const reason=m.lastEvent,roles=snapshot(guild).config.gmRoleIds;
          await store.transact(guild,'map-pause:'+C.id('t'),client.user.id,st=>{st.explorations[ref].notifiedPause=reason;},'自动遭遇暂停通知意图');
          const ch=await textChannel(guild,m.channelId);await ch.send({content:roles.map(r=>'<@&'+r+'>').join(' ')+' '+reason,allowedMentions:{parse:[],roles}});}}

      for(const r of changed.moves)await exploration.publishMove(guild,r.mapId,r.id);
    }
    await rpPanel.tick(guild);
    await activities.tick(guild, now);
    } finally { ticking.delete(guild); }
  }
  async function start() {
    for (const guild of guildIds()) {
      try {
        await store.load(guild); ready.add(guild);
        if(snapshot(guild).ammunitionVersion!==1)await store.transact(guild,'ammunition-migration-v1',client.user.id,st=>require('./ammunition').migrate(st),'弹夹独立弹药存储迁移');
        if(snapshot(guild).tacticalVersion!==1)await store.transact(guild,'tactical-migration-v1',client.user.id,st=>require('./skills').migrate(st),'独立战斗技能与双地图迁移');
        if(snapshot(guild).contentPackVersion!==1)await store.transact(guild,'content-pack-v1',client.user.id,st=>require('./content-pack').install(st),'六色容器与随机探索预置库');
        console.log('跑团加密存档读取正常：' + guild);
        await activities.recover(guild).catch(e => logFailure('跑团活动恢复失败。', e));
        await exploration.recover(guild);
        await mapExtra.recover(guild);await rpPanel.tick(guild);
        await tickGuild(guild);
        for (const b of Object.values(snapshot(guild).battles).filter(b => b.status !== 'ended' || b.endedAt >= Date.now() - 86400000)) {
          if(!require('./outbox').needsRecovery(store,guild,'battle',b.id))continue;
          await publishBattle(guild, b.id).catch(e => logFailure('跑团战场恢复失败。', e));
        }
      } catch (e) { logFailure('跑团初始化失败：' + guild, e); }
    }
    timer = setInterval(() => { for (const guild of ready) {const job=tickGuild(guild).catch(e => logFailure('跑团定时处理失败。', e));tickJobs.add(job);job.finally(()=>tickJobs.delete(job));} }, 2000);
    timer.unref();
    if(store.backgroundPublications){outbox.start();backupTimer=setInterval(()=>{for(const guild of ready)store.backup(guild).catch(e=>logFailure('跑团数据库Discord备份失败，数据库存档仍为权威。',e));},300000);backupTimer.unref();}
  }
  function configView(s) {
    const roles = ids => ids.map(r => '<@&' + r + '>').join('、') || '未配置';
    return payload('跑团配置面板', 'GM：' + roles(s.config.gmRoleIds) + '\n玩家：' + roles(s.config.playerRoleIds) +
      '\n公告频道：' + (s.config.announcementChannelId ? '<#' + s.config.announcementChannelId + '>' : '未配置') +
      '\n\nGM负责发放、录入和战斗。玩家身份组＋确认角色卡才能参与战斗。领取面板不能包含GM或危险权限角色。', [
      row(new D.RoleSelectMenuBuilder().setCustomId('rpg:config:gm').setPlaceholder('选择GM身份组').setMinValues(0).setMaxValues(10)),
      row(new D.RoleSelectMenuBuilder().setCustomId('rpg:config:player').setPlaceholder('选择玩家身份组').setMinValues(0).setMaxValues(10)),
      row(new D.ChannelSelectMenuBuilder().setCustomId('rpg:config:channel').setPlaceholder('公告频道').setChannelTypes(D.ChannelType.GuildText, D.ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1)),
      row(button('newroles', '创建领取身份组面板', D.ButtonStyle.Primary), button('rolelist:0', '已有领取面板'), button('configview', '刷新配置'), button('map:config', '地图 / 掉落配置'))
    ]);
  }
  async function safeRoles(guild, ids, s) {
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe();
    ok(bot.permissions.has(D.PermissionFlagsBits.ManageRoles), 'Bot缺少管理身份组权限。');
    const protectedIds = new Set([...s.config.gmRoleIds, ...(deps.protectedRoles?.(guild.id) || [])]);
    for (const id of ids) {
      const role = guild.roles.cache.get(id);
      ok(role && id !== guild.id && !role.managed && role.position < bot.roles.highest.position &&
        !(role.permissions.bitfield & dangerBits) && !protectedIds.has(id),
      '身份组不可领取：不存在、托管、管理操作角色、危险权限或层级不低于Bot。');
    }
  }
  function rolePanelView(s, panel, guild) {
    const parts = panel.roleIds.map(id => button('claim:' + panel.id + ':' + id,
      panel.labels[id] || guild.roles.cache.get(id)?.name || id, D.ButtonStyle.Primary));
    const rows = [];
    rows.push(row(select('claimmulti:' + panel.id, panel.exclusive ? '选择一个身份组' : '选择要领取的身份组',
      panel.roleIds.map(id => ({ value: id, label: panel.labels[id] || guild.roles.cache.get(id)?.name || id })), 1, panel.exclusive ? 1 : panel.roleIds.length)));
    for (let n = 0; n < parts.length; n += 5) rows.push(row(...parts.slice(n, n + 5)));
    return payload(panel.title, panel.description + '\n' + (panel.exclusive ? '互斥：仅切换此面板内的身份组。' : '可领取多个身份组。') +
      (panel.allowCancel ? '再次点击已持有身份组可取消。' : '此面板不允许取消。'), rows);
  }
  async function publishRoles(i, panelId) {
    const s = snapshot(i.guildId), panel = s.rolePanels[panelId];
    ok(panel?.published, '领取面板不存在。');
    await safeRoles(i.guild, panel.roleIds, s);
    const ch = await textChannel(i.guildId, s.config.announcementChannelId || i.channelId);
    let message;
    if (panel.channelId && panel.messageId) {
      const oldCh = await textChannel(i.guildId, panel.channelId);
      message = await oldCh.messages.fetch(panel.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
      if (message) await message.edit(rolePanelView(s, panel, i.guild));
    }
    if (!message) message = await ch.send(rolePanelView(s, panel, i.guild));
    await store.transact(i.guildId, 'roleboard:' + message.id + ':' + panel.version, i.user.id, st => {
      st.rolePanels[panelId].channelId = message.channelId; st.rolePanels[panelId].messageId = message.id;
    }, '发布领取身份组面板');
  }
  async function claim(i, panelId, requested, toggle) {
    const key = i.guildId + ':' + i.user.id;
    ok(!roleLocks.has(key), '身份组领取正在处理，请稍后刷新。');
    roleLocks.add(key);
    try {
      const s = snapshot(i.guildId), panel = s.rolePanels[panelId]; ok(panel?.published, '面板已停用。');
      ok(requested.length && requested.every(id => panel.roleIds.includes(id)) && (!panel.exclusive || requested.length === 1), '选择无效。');
      await safeRoles(i.guild, panel.roleIds, s);
      const member = await i.guild.members.fetch({ user: i.user.id, force: true });
      const held = panel.roleIds.filter(id => member.roles.cache.has(id));
      let desired = panel.exclusive ? requested : [...new Set([...held, ...requested])];
      if (toggle && held.includes(requested[0])) {
        ok(panel.allowCancel, '该面板不允许取消身份组。'); desired = held.filter(id => id !== requested[0]);
      }
      const add = desired.filter(id => !held.includes(id)), remove = held.filter(id => !desired.includes(id));
      await tx(i, st => {
        st.roleClaims ||= {};
        st.roleClaims[i.id] = { userId: i.user.id, panelId, add, remove, status: 'pending', at: Date.now() };
        return { add, remove };
      }, '身份组领取请求');
      if (remove.length) await member.roles.remove(remove, '跑团领取面板互斥切换');
      if (add.length) await member.roles.add(add, '跑团领取面板');
      await store.transact(i.guildId, 'claimed:' + i.id, i.user.id, st => { st.roleClaims[i.id].status = 'completed'; }, '身份组领取完成');
      return '身份组已更新。';
    } finally { roleLocks.delete(key); }
  }
  function formView(s, formId, uid) {
    const f = F.owned(s, formId, uid);
    return f.kind === 'session' ? activities.sessionDraft(f) : f.kind==='mapbuild'?mapExtra.form(s,f):F.view(s, f);
  }
  function offerAccess(s, offerId, member, uid) {
    const o = s.offers[offerId]; ok(o, '交易不存在。');
    ok([o.creatorId, o.targetId].includes(uid) || U.gm(s, member), '只能查看本人参与的交易。'); return o;
  }
  async function announceOffer(i, offer) {
    if(store.backgroundPublications){await store.transact(i.guildId,'offer-channel:'+offer.id+':'+i.id,i.user.id,st=>{st.offers[offer.id].channelId=i.channelId;},'安排交易通知');return store.enqueue(i.guildId,'offer',offer.id,{priority:2});}
    await i.channel.send({ content: '<@' + offer.targetId + '> 有一份待确认的' + ({ trade: '交易', transfer: '转账', buyback: 'GM收购报价' }[offer.type]) +
      '，5分钟内点击查看。', components: [row(button('offer:' + offer.id, '查看并操作交易', D.ButtonStyle.Primary))],
      allowedMentions: { parse: [], users: [offer.targetId] } });
  }
  function pickView(title, options, base, page = 0) {
    const pages = Math.max(1, Math.ceil(options.length / 25)); page = Math.max(0, Math.min(page, pages - 1));
    const result = payload(title, '第' + (page + 1) + '/' + pages + '页' + (options.length ? '' : '\n暂无可用选项。'), [
      ...(options.length ? [row(select(base + ':select', title, options.slice(page * 25, page * 25 + 25)))] : []),
      row(button(base + ':' + (page - 1), '上一页', undefined, page === 0), button(base + ':' + (page + 1), '下一页', undefined, page === pages - 1))
    ]);
    const match = base.match(/^[^:]+:(b[0-9a-f]{12}):(a[0-9a-f]{12}):([^:]+):([^:]+)/);
    if (match) result.components.push(row(button('view:' + match.slice(1).join(':') + ':overview', '返回个人概览'),
      button('view:' + match.slice(1).join(':') + ':quick', '取消选择')));
    return result;
  }
  async function use(i, ref, target, selectionId) {
    const result = await tx(i, st => {
      if(selectionId){const f=F.owned(st,selectionId,i.user.id);ok(!f.done&&f.expiresAt>Date.now()&&f.characterId===M.player(st,i.user.id).id,'使用操作已完成或角色已变化。');f.done=true;}
      const p = M.player(st, i.user.id), b = M.battleFor(st, i.user.id);
      ok(M.available(st, i.user.id, ref) > 0, '物品不存在或已被交易预留。');
      ok(b?.status !== 'paused', '战斗暂停时不能消耗快速行动，请GM恢复战斗后使用。');
      if (b?.status === 'active') {
        const a = b.actors.find(a => a.userId === i.user.id);
        ok(b.current?.actorId === a?.id, '只能在自己的当前行动使用物品。');
        const result = B.useItem(st, b, b.current.id, ref,undefined,target); B.nextOpportunity(st, b); return result;
      }
      if(p.inventory[ref]?.snapshot.kind==='修复道具'){ok(M.available(st,i.user.id,target)>0,'目标装备已预留或不存在。');return require('./durability').repair(p,ref,target);}
      return M.consume(p, ref);
    }, '使用食物药品');
    const b = M.battleFor(snapshot(i.guildId), i.user.id); if (b) await publishBattle(i.guildId, b.id);
    return result;
  }
  async function autocomplete(i) {
    if (!enabled(i.guildId) || !ready.has(i.guildId)) { await i.respond([]); return; }
    const s = snapshot(i.guildId), q = i.options.getFocused().toLowerCase(), sub = i.options.getSubcommand(false);
    if(i.commandName==='开箱'||i.commandName==='gm'&&sub==='次数'){if(i.commandName==='gm'&&!U.gm(s,i.member))return i.respond([]);return i.respond([...(i.commandName==='gm'?['抽卡']:[]),...C.BOXES.filter(b=>require('./containers').get(s,b)?.enabled!==false)].filter(name=>name.includes(q)).slice(0,25).map(name=>({name,value:name})));}
    if(i.commandName==='规则'){await i.respond(Object.keys(require('./rules').chapters).filter(name=>name.toLowerCase().includes(q)).slice(0,25).map(name=>({name,value:name})));return;}
    if(i.commandName==='鉴定'&&sub==='发布'){
      if(!U.gm(s,i.member)){await i.respond([]);return;}
      await i.respond(Object.values(s.checkSkillTemplates||{}).filter(t=>t.published&&t.name.toLowerCase().includes(q)).slice(0,25).map(t=>({name:t.name+' · 初始等级 '+t.level,value:t.id})));return;
    }
    const fromCatalog = i.commandName === 'gm' && ['发放', '批量发放', '修改模板'].includes(sub);
    if (fromCatalog && !U.gm(s, i.member)) { await i.respond([]); return; }
    let entries = fromCatalog ? Object.values(s.catalog).filter(t => t.published && (sub === '修改模板' || t.kind !== '杂物')) : Object.values(s.players[i.user.id]?.inventory || {});
    if (i.commandName === 'gm' && sub === '收购') {
      if (!U.gm(s, i.member)) { await i.respond([]); return; }
      const target = i.options.get('成员')?.value;
      entries = Object.values(s.players[target]?.inventory || {}).filter(t => !availability(s, target, t).reason);
    }
    if(i.commandName==='使用')entries=entries.filter(t=>[...C.CONSUMABLES,'修复道具'].includes(t.snapshot.kind));
    await i.respond(entries.filter(t => ((t.snapshot?.name || t.name) + t.id).toLowerCase().includes(q)).slice(0, 25)
      .map(t => ({ name: ((t.snapshot?.name || t.name).slice(0, 60) + ' · ' + t.id +
        (i.commandName === 'gm' && sub === '收购' ? ' · 可售 ' + availability(s, i.options.get('成员').value, t).quantity : '')).slice(0, 100), value: t.id })));
  }
  async function slash(i, member) {
    const s = snapshot(i.guildId), uid = i.user.id, name = i.commandName;
    const o = i.options, target = () => o.getUser('成员')?.id || uid;
    if (name === '地图配置') { needGM(s, member); return exploration.config(s); }
    if (name === '地图') return exploration.home(s, member);
    if(name==='角色设置')return characterPanel.home(M.player(s,uid));
    if(name==='技能')return combatSkills.slash(i,member);
    if(['角色图片','npc图片'].includes(name))return portraits.slash(i,member);
    if (name === '势力') return factions.home(s, uid);
    if (name === '开团' || name === '鉴定') return activities.slash(i, member);
    if (name === '跑团配置面板') { needConfig(member); return configView(s); }
    if(name==='规则')return Text.read(s,'rule/'+(o.getString('章节')||'总览'));
    if (name === 'rd') {
      const result = await tx(i, () => C.dice(o.getString('骰式') || '1d100', o.getString('模式') || 'normal'), '公开掷骰');
      return payload('掷骰 · ' + result.expression, '<@' + uid + '> → **' + result.total + '**\n' +
        result.rolls.map(r => r.dice.join('/') + (r.dice.length > 1 ? '→' + r.chosen : '')).join('、') + '\n修正 ' + result.modifier);
    }
    if (name === '建卡') {
      const d = await tx(i, st => M.rollCharacter(st, uid, o.getString('名字') || i.member.displayName || i.user.username));
      return U.draftView(d);
    }
    if (name === '角色卡') return U.characterView(M.player(s, target()));
    if (name === '分配属性点') {
      await tx(i, st => { M.allocate(st, uid, o.getString('属性'), o.getInteger('点数') || 1); return { attribute: o.getString('属性'), points: o.getInteger('点数') || 1 }; });
      return U.characterView(M.player(snapshot(i.guildId), uid));
    }
    if (name === '抽卡' || name === '开箱') {
      const record = await tx(i, st => {
        const result = M.openLoot(st, uid, name === '抽卡' ? 'card' : o.getString('箱型'));
        const previous = Object.values(st.lootPublications).find(r => r.userId === uid &&
          (r.result.batchId === result.batchId || r.result.item.id === result.item.id) && r.channelId === i.channelId);
        const r = previous || { id: C.id('l'), userId: uid, channelId: i.channelId, at: Date.now(), publication: { status: 'pending' } };
        if (previous?.messageId && !previous.publicationParts) previous.publicationParts = [{ id: C.id('n'), status: 'sent',
          messageId: previous.messageId, pending: previous.result.pending }];
        r.result = C.clone(result); st.lootPublications[r.id] = r; return r;
      }, '抽取并保存公示');
      try { await activities.publish(i.guildId, 'loot', record.id); }
      catch (e) {
        logFailure('抽取公示未完成。', e);
        return payload('结果已保存 · 公示待补发', record.result.items.length + '件物品 · 批次 ' + record.result.batchId + '\n' + e.message, [
          row(button('activity:loot:repost:' + record.id, '核对后补发已存结果'), button('activity:loot:menu:0', '查看抽取记录'))]);
      }
      const saved = snapshot(i.guildId).lootPublications[record.id];
      return payload(saved.messageId?'抽取结果已公示':'抽取结果已保存 · 公示处理中', record.result.items.length + '件物品 · 批次 ' + record.result.batchId + (record.result.pending ? ' · 整批待领取，未扣次数' : ' · 已入包') +
        (saved.messageId?'\nhttps://discord.com/channels/' + i.guildId + '/' + saved.channelId + '/' + saved.messageId:'\n公示将在后台发送，原抽取结果已保存。'),
        [row(button('activity:loot:menu:0', '查看公示记录'), button('bag:' + uid + ':' + uid + ':0', '查看个人背包'))]);
    }
    if (name === '使用') {
      if(!o.getString('物品'))return selections.list(s,uid,'使用');
      if(M.player(s,uid).inventory[o.getString('物品')]?.snapshot.kind==='修复道具')return selections.repairStart(i,o.getString('物品'));
      const result = await use(i, o.getString('物品'));
      return payload('已使用 · ' + result.name, '恢复 ' + result.healed + ' HP · 当前 ' + result.hp +
        '\n解除异常：' + (result.cleared.join('、') || '无') + '\n持续效果：' + U.effectsText(result.effects),
        [row(button('bag:' + uid + ':' + uid + ':0', '返回背包'))], 0x2ecc71);
    }
    if (name === '背包') {
      if (target() !== uid) needGM(s, member);
      return U.inventoryView(s, target(), uid);
    }
    if (name === '丢弃') {
      if(!o.getString('物品'))return selections.list(s,uid,'丢弃');
      const item = M.transferable(s, uid, o.getString('物品'), o.getInteger('数量') || 1);
      const token = await tx(i, st => {
        const f = { id: C.id('x'), owner: uid, kind: 'drop', itemId: item.id, quantity: o.getInteger('数量') || 1, expiresAt: Date.now() + 60000 };
        st.forms[f.id] = f; return f.id;
      });
      return payload('确认丢弃', item.snapshot.name + ' ×' + (o.getInteger('数量') || 1) + '\n不可恢复，请确认。', [row(button('dropconfirm:' + token, '确认丢弃', D.ButtonStyle.Danger))]);
    }
    if(name==='弹药管理')return ammoPanel.home(s,i,member,'p',i.user.id,'_');
    if (name === '装备') {
      const operation = o.getString('操作'), ref = o.getString('物品');
      if(!operation)return selections.home();
      if(!ref || (['装配','拆下'].includes(operation)&&!o.getString('配件')))return selections.list(s,uid,operation);
      if (operation === '使用道具') {
        if(M.player(s,uid).inventory[ref]?.snapshot.kind==='修复道具')return selections.repairStart(i,ref);
        const result = await use(i, ref);
        return payload('已使用 · ' + result.name, '恢复 ' + result.healed + ' HP，当前HP ' + result.hp +
          '\n持续效果：' + U.effectsText(result.effects), [row(button('bag:' + uid + ':' + uid + ':0', '返回背包'))]);
      }
      const result = await tx(i, st => {
        if (['装配', '拆下'].includes(operation)) { M.attach(st, uid, ref, o.getString('配件'), operation === '拆下'); return '配件已调整。'; }
        if (operation.startsWith('使用')) {
          const slot = { '使用世界树之心-头部': 'head', '使用世界树之心-身体': 'body', '使用世界树之心-戒指': 'ring' }[operation];
          M.useSpecial(st, uid, ref, slot); return '槽位已扩展。';
        }
        const b = M.battleFor(st, uid);
        if (b?.status === 'active') {
          const a = b.actors.find(a => a.userId === uid);
          ok(b.current?.actorId === a.id && operation === '装备', '战斗中请在自己的当前行动面板切换武器。');
          B.switchWeapon(st, b, b.current.id, ref);
          B.nextOpportunity(st, b);
        } else M.equip(st, uid, ref, operation === '卸下');
        return '装备已调整。';
      });
      const b = M.battleFor(snapshot(i.guildId), uid); if (b) await publishBattle(i.guildId, b.id);
      return payload('装备', result);
    }
    if (name === '交易' || name === '转账') {
      const offer = await tx(i, st => M.createOffer(st, uid, target(), name === '交易' ? 'trade' : 'transfer', null, 1, o.getInteger('金额') || 0));
      await announceOffer(i, offer);
      return U.offerView(snapshot(i.guildId), offer, uid);
    }
    if (name === '鉴定技能') return checkSkills.slash(i, member);
    if (['录入物品', '录入词条', '录入异常','录入鉴定技能','录入技能'].includes(name)) {
      needGM(s, member);
      const kind = { '录入物品': 'item', '录入词条': 'trait', '录入异常': 'condition', '录入鉴定技能':'checkskill','录入技能':'skill' }[name];
      const f = await tx(i, st => { needGM(st, member); return F.create(st, uid, kind, o.getString('类型') || '杂物'); });
      return F.view(snapshot(i.guildId), f);
    }
    if (name === 'gm') return gmSlash(i, member);
    if (name === '战斗') return battleSlash(i, member);
    throw new Error('跑团指令未识别。');
  }
  async function gmSlash(i, member) {
    const s = snapshot(i.guildId); needGM(s, member);
    const o = i.options, sub = o.getSubcommand(), uid = i.user.id, target = o.getUser('成员')?.id;
    if (sub === '批量发放' || (sub === '发放' && !target)) return bulkIssue.start(i, member);
    if(sub==='技能')return combatSkills.manage(s);
    if (sub === '鉴定技能') return checkSkills.slash(i, member);
    if (sub === '恢复存档') {
      await store.recover(i.guildId);if(snapshot(i.guildId).tacticalVersion!==1)await store.transact(i.guildId,'tactical-migration-v1',client.user.id,st=>require('./skills').migrate(st),'独立战斗技能与双地图迁移'); if(snapshot(i.guildId).contentPackVersion!==1)await store.transact(i.guildId,'content-pack-v1',client.user.id,st=>require('./content-pack').install(st),'六色容器与随机探索预置库'); ready.add(i.guildId);
      return payload('加密存档已重新读取', '当前版本 ' + snapshot(i.guildId).revision + '。请核对背包、交易及战斗记录后继续。');
    }
    if(sub==='文本编辑')return texts.home(s);
    if (sub === '模板库') return catalogView(s, o.getString('类型') || '物品', 0);
    if (sub === '抽取公示') return activities.slash(i, member);
    if (sub === '草稿') {
      const ref = o.getString('编号'), forms = Object.values(s.forms).filter(f => f.owner === uid && !f.done && !['drop', 'delete', 'buyback','selection','fire','aoe','battleAction','allocation','portrait','bulkissue','skillaward'].includes(f.kind));
      if (ref) return formView(s, ref, uid);
      return pickView('选择持久草稿', forms.map(f => ({ value: f.id, label: f.data?.name || f.data?.title || f.kind, description: f.id })), 'drafts', 0);
    }
    if (sub === 'npc' || sub === '修改模板') {
      const ref = o.getString('物品');
      if(sub==='修改模板'&&!ref)return catalogView(s,'物品',0);
      const f = await tx(i, st => { needGM(st, member); return F.create(st, uid, sub === 'npc' ? 'npc' : 'item', null, ref); });
      return F.view(snapshot(i.guildId), f);
    }
    if (sub === '销卡') {
      M.player(s, target);
      const f = await tx(i, st => {
        const form = { id: C.id('x'), owner: uid, kind: 'delete', target, characterId: M.player(st, target).id, expiresAt: Date.now() + 60000 };
        st.forms[form.id] = form; return form;
      });
      return payload('确认GM销卡', '将清空 <@' + target + '> 的角色、财产、次数和槽位扩展，取消交易并移出暂停的战斗。审计保留。', [
        row(button('deleteconfirm:' + f.id, '确认销卡', D.ButtonStyle.Danger))]);
    }
    if (sub === '收购') {
      if (!o.getString('物品')) return buyback.list(s, target);
      ok(o.getInteger('价格') !== null, '快捷收购需要填写价格；不指定物品可打开收购面板。');
      const offer = await tx(i, st => { needGM(st, member); return M.createOffer(st, uid, target, 'buyback', o.getString('物品'), o.getInteger('数量') || 1, o.getInteger('价格')); });
      await announceOffer(i, offer); return U.offerView(snapshot(i.guildId), offer, uid);
    }
    if(sub==='发放'&&!o.getString('物品')){M.player(s,target);return selections.list(s,uid,'发放',0,target);}
    const result = await tx(i, st => {
      needGM(st, member);
      const p = M.player(st, target), amount = o.getInteger('数量') || 1;
      if(sub==='时运'){p.luck=num(o.getInteger('数值'),'基础时运',-9,11);return {luck:p.luck};}
      if (sub === '经验') return M.grantXP(st, target, amount);
      if (sub === '属性点') { p.points = num(p.points + amount, '累计自由点', 0, 1000000); return { points: p.points }; }
      if (sub === '发放') return M.issue(st, target, o.getString('物品'), amount).map(item => ({ id: item.id, name: item.snapshot.name }));
      if (sub === '次数') {
        const type = o.getString('类型');ok(type==='抽卡'||C.BOXES.includes(type),'次数类型无效。');
        if (type === '抽卡') p.tickets.card = num(p.tickets.card + amount, '抽卡次数', 0, 1000000);
        else p.tickets.boxes[type] = num((p.tickets.boxes[type] || 0) + amount, '开箱次数', 0, 1000000);
        return { type, amount };
      }
      throw new Error('GM操作未识别。');
    });
    return payload('GM' + sub + '已保存', '目标 <@' + target + '>\n' + (sub === '经验' ? '实得经验 ' + result.credited + '，等级 ' + result.before + '→' + result.level + '，获得自由点 ' + result.points :
      sub === '时运' ? '基础时运 '+result.luck : sub === '发放' ? result.map(item => item.name + ' · ' + item.id).join('\n') : sub === '次数' ? result.type + ' +' + result.amount : '自由点余额 ' + result.points));
  }
  function catalogView(s, type, page, category = 'all') {
    const source = { '物品': 'catalog', '词条': 'traits', '异常': 'conditionTemplates', 'NPC': 'npcTemplates', '鉴定技能':'checkSkillTemplates','战斗技能':'skillTemplates' }[type] || 'catalog';
    const entries = Object.values(s[source]||{}).filter(t=>source!=='catalog'||require('./item-categories').matches(t,category,true)), total = Math.max(1, Math.ceil(entries.length / 12));
    page = Math.max(0, Math.min(page, total - 1));
    const result = payload('GM模板库 · ' + type, entries.slice(page * 12, page * 12 + 12).map(t => '**' + t.name + '** · ' + (t.kind || type) +
      '\n' + t.id + ' · v' + t.version).join('\n') + '\n\n' + (page + 1) + '/' + total, [
      ...(source==='catalog'?[require('./item-categories').row('catalogcategory',category,true)]:[]),
      row(button('catalog:' + type + ':' + (page - 1)+':'+category, '上一页', undefined, page === 0), button('catalog:' + type + ':' + (page + 1)+':'+category, '下一页', undefined, page >= total - 1)),
      ...(entries.length ? [row(select('templateedit:' + source, '选择模板修改或查看', entries.slice(page * 12, page * 12 + 12).map(t => ({ label: t.name, value: t.id }))))] : []),
    ].filter(r => r.components.length));
    return source==='catalog'?require('./loot-icons').grid(result,'GM目录 · '+category,entries.slice(page*12,page*12+12)):result;
  }
  async function battleSlash(i, member) {
    const s = snapshot(i.guildId), o = i.options, sub = o.getSubcommand();
    if (sub === '面板') {
      const b = channelBattle(s, i.channelId);
      if (U.gm(s, member) && !o.getString('角色')) return gmUI.view(s, b);
      const a = o.getString('角色') ? canActor(s, b, o.getString('角色'), member, i.user.id) :
        b.actors.find(a => a.userId === i.user.id && !a.deathId) || (U.gm(s, member) ? b.actors.find(a => a.id === b.current?.actorId) : null);
      return a ? U.personalView(s, b, a, i.user.id) : U.battleView(s, b);
    }
    needGM(s, member);
    if(['添加npc','位置','生命','异常','解除异常','移出'].includes(sub)&&!(sub==='添加npc'?o.getString('模板'):o.getString('角色')))return gmUI.entry(s,channelBattle(s,i.channelId), {'添加npc':'npc','位置':'actors','生命':'actors','异常':'conditions','解除异常':'conditions','移出':'remove'}[sub]);
    if (sub === '生命' && o.getInteger('数值') === 0) {
      const b = channelBattle(s, i.channelId), a = B.actorById(b, o.getString('角色')), p = B.actorCharacter(s, a);
      if (a.userId) return payload('确认玩家死亡并销卡', a.name + '的HP将归零，清空角色和全部资产。', [
        row(button('gmui:' + b.id + ':deathconfirm:' + a.id + ':' + p.id, '确认死亡并销卡', D.ButtonStyle.Danger), button('gmui:' + b.id + ':view', '取消'))]);
    }
    const ref = await tx(i, st => {
      needGM(st, member);
      if (sub === '招募') {
        const b = B.createBattle(st, i.channelId, i.user.id, o.getString('名称'), o.getInteger('列数') || 10, o.getInteger('行数') || 10);
        if(store.backgroundPublications&&st.config.announcementChannelId&&st.config.announcementChannelId!==i.channelId)b.recruitAnnouncement={channelId:st.config.announcementChannelId,status:'pending'};
        b.environment = C.text(o.getString('场景') || '', '场景', 400, true); return b.id;
      }
      const b = channelBattle(st, i.channelId);
      if (sub === '开战') B.start(st, b, o.getString('偷袭'));
      else if (sub === '暂停') B.pause(b);
      else if (sub === '恢复') { B.pause(b, true); B.nextOpportunity(st, b); }
      else if (sub === '代结束') {
        ok(b.current, '没有当前行动。');
        ok(!b.pending, '请先完成防守响应。');
        if (b.status === 'paused') b.status = 'active';
        B.finish(st, b, b.current.id);
      } else if (sub === '结束') B.endBattle(st, b);
      else if (sub === '添加npc') B.addNPC(st, b, o.getString('模板'), o.getString('阵营'));
      else if (sub === '位置') B.position(b, o.getString('角色'), o.getNumber('横坐标'), o.getNumber('纵坐标'), o.getString('阵营'));
      else if (sub === '地形') B.setTerrain(b, o.getInteger('列'), o.getInteger('行'), o.getString('类型'));
      else {
        const a = B.actorById(b, o.getString('角色')), p = B.actorCharacter(st, a);
        ok(['recruiting', 'paused'].includes(b.status) && !b.pending, '调整生命、异常或阵容前请暂停，并完成待响应攻击。');
        ok(!a.deathId, '角色已死亡，不能操作原角色。');
        if (sub === '生命') {
          const before = p.hp;
          p.hp = num(o.getInteger('数值'), '生命', 0, M.stats(p).maxHP);
          B.record(b, 'GM调整' + a.name + '生命 ' + before + '→' + p.hp + '。', { userId: i.user.id });
        }
        if (sub === '异常') B.record(b, a.name + '的异常施加完成。', B.applyCondition(st, p, { id: o.getString('模板'), severity: o.getString('等级') }));
        if (sub === '解除异常') {
          ok(p.conditions.some(c => c.id === o.getString('编号')), '异常编号不存在。');
          B.record(b, 'GM解除' + a.name + '的异常。', { userId: i.user.id, conditionId: o.getString('编号') });
          p.conditions = p.conditions.filter(c => c.id !== o.getString('编号')); M.syncHP(p);
        }
        if (sub === '移出') {
          b.actors = b.actors.filter(x => x.id !== a.id); b.queue = b.queue.filter(x => x.actorId !== a.id);
          if (b.current?.actorId === a.id) b.current = null; p.ap = 0; delete a.casting;
        }
      }
      return b.id;
    });
    await publishBattle(i.guildId, ref);
    if (!store.backgroundPublications && sub === '招募' && s.config.announcementChannelId && s.config.announcementChannelId !== i.channelId) {
      const b = battle(snapshot(i.guildId), ref), ch = await textChannel(i.guildId, s.config.announcementChannelId);
      await ch.send({ content: '战斗招募：' + b.name + '\nhttps://discord.com/channels/' + i.guildId + '/' + b.channelId + '/' + b.messageId,
        allowedMentions: { parse: [] } });
    }
    return gmUI.view(snapshot(i.guildId), battle(snapshot(i.guildId), ref));
  }
  const characterPanel=createCharacterPanel({snapshot,tx});
  const bulkIssue=createBulkIssue({snapshot,tx,needGM});
  const portraits=createPortraits({...deps,snapshot,tx,needGM,pickView});
  const renderer=deps.renderer||require('./map-image').createRenderer({portraits,logFailure,metrics});
  const battleEvents=require('./battle-events').createEvents({snapshot,store,client,textChannel,render:renderer.decorate,logFailure});
  const actionPanel=require('./action-drafts').createPanel({snapshot,tx,store,canActor,publishBattle});
  const aoePanel=require('./aoe').createAoePanel({snapshot,tx,publishBattle,canActor,actionPanel});
  const combatSkills=require('./skills').createSkills({snapshot,tx,needGM,pickView});
  const activities = createActivities({ snapshot, tx, store, textChannel, client, needGM, logFailure });
  const npcPanel=createNpcPanel({snapshot,tx,needGM,publishBattle});
  const ammoPanel=createAmmunitionPanel({snapshot,tx,needGM,publishBattle,actionPanel});
  const gmUI = createBattleGM({ snapshot, tx, needGM, battle, publishBattle, pickView });
  const boardRecovery=require('./board-recovery').createBoardRecovery({snapshot,store,tx,needGM,textChannel,busy:(g,r)=>publishing.has(g+':'+r)});
  const buyback = createBuyback({ snapshot, tx, needGM, announceOffer });
  const factions = createFactions({ snapshot, tx });
  const exploration = createExploration({ snapshot, tx, store, textChannel, client, needGM, activities, publishBattle, gmUI, logFailure,render:renderer.decorate });
  const variantPanel=require('./room-variants').controller({snapshot,tx,needGM});
  const mapExtra=require('./exploration-extra').controller({snapshot,tx,store,client,textChannel,needGM,manage:exploration.manage,publishMap:exploration.publish,logFailure});
  const rpPanel=require('./rp').controller({snapshot,tx,store,client,textChannel,needGM,publishMap:exploration.publish,logFailure});
  const texts=Text.createTexts({snapshot,tx,needGM,pickView});
  const selections=createSelections({snapshot,tx,needGM,pickView,use,publishBattle,offerAccess,owner});
  const equipment=createEquipment({snapshot,selections});
  const checkSkills=createCheckSkills({snapshot,tx,needGM,pickView});
  async function publishOffer(guild,ref){const o=store.select(guild,s=>s.offers[ref]);if(!o||o.status!=='ready'||o.expiresAt<=Date.now())return;if(['sent','sending','uncertain'].includes(o.notification?.status))return;
    await store.transact(guild,'offer-intent:'+C.id('j'),client.user.id,st=>{st.offers[ref].notification={status:'sending'};},'交易通知意图',{delivery:false});
    try{const ch=await textChannel(guild,o.channelId),msg=await ch.send({content:'<@'+o.targetId+'> 有一份待确认的'+({trade:'交易',transfer:'转账',buyback:'GM收购报价'}[o.type])+'，5分钟内点击查看。',components:[row(button('offer:'+ref,'查看并操作交易',D.ButtonStyle.Primary))],allowedMentions:{parse:[],users:[o.targetId]},nonce:ref,enforceNonce:true});await store.transact(guild,'offer-sent:'+C.id('j'),client.user.id,st=>{st.offers[ref].notification={status:'sent',messageId:msg.id};},'交易通知送达',{delivery:false});}
    catch(e){if(!store.frozen(guild))await store.transact(guild,'offer-failed:'+C.id('j'),client.user.id,st=>{st.offers[ref].notification={status:typeof e.code==='number'&&e.code>=10000?'failed':'uncertain'};},'交易通知待核对',{delivery:false});throw e;}}
  const outbox=require('./outbox').createOutbox({store,client,logFailure,metrics,handlers:{eventImage:battleEvents.publishImage,defense:publishDefenseNow,battle:publishBattleNow,map:async(g,r,f)=>{if(!store.select(g,s=>s.explorations[r]))return;await exploration.publishNow(g,r,f);},move:(g,r,f)=>exploration.publishMoveNow(g,...r.split('/'),f),corpses:(g,r,f)=>exploration.publishCorpsesNow(g,r,f),loot:(g,r,f)=>activities.publishNow(g,'loot',r,f),check:(g,r,f)=>activities.publishNow(g,'check',r,f),attempt:(g,r,f)=>activities.publishNow(g,'attempt',r,f),session:(g,r,f)=>activities.publishNow(g,'session',r,f),offer:publishOffer,rp:(g,r)=>rpPanel.publishQueued(g,...r.split('/')),rpDraft:(g,r,f)=>rpPanel.draft(g,r,f),reminder:(g,r)=>activities.remind(g,r)}});
  store.onCommit(()=>outbox.wake());
  const { openModal, component } = createHandlers({ snapshot, tx, needGM, needConfig, owner, battle, canActor,
    configView, safeRoles, publishRoles, claim, formView, offerAccess, catalogView, pickView, publishBattle, store, textChannel, use, gmUI,selections,aoePanel,actionPanel });
  async function handle(i) {
    const receivedAt=performance.now();
    const ours = (i.isChatInputCommand?.() || i.isAutocomplete?.()) ? commandNames.has(i.commandName) : i.customId?.startsWith('rpg:');
    if (!ours) return false;
    if(Number.isFinite(i.createdTimestamp))metrics.observe('interaction.gatewayAge',Math.max(0,Date.now()-i.createdTimestamp));
    if (i.isAutocomplete?.()) { await autocomplete(i).catch(() => i.respond([]).catch(() => {})); return true; }
    let release, originalShowModal;
    const privateSource = !!i.message?.flags?.has(E);
    try {
      ok(i.guildId && enabled(i.guildId), '跑团功能仅在指定跑团服务器启用。');
      if (!ready.has(i.guildId) && i.isChatInputCommand?.() && i.commandName === 'gm' && i.options.getSubcommand() === '恢复存档') {
        needConfig(i.member);
        await i.deferReply({ flags: E }); await store.recover(i.guildId);ready.add(i.guildId);if(snapshot(i.guildId).tacticalVersion!==1)await store.transact(i.guildId,'tactical-migration-v1',client.user.id,st=>require('./skills').migrate(st),'独立战斗技能与双地图迁移'); if(snapshot(i.guildId).contentPackVersion!==1)await store.transact(i.guildId,'content-pack-v1',client.user.id,st=>require('./content-pack').install(st),'六色容器与随机探索预置库'); ready.add(i.guildId);
        await i.editReply(payload('跑团存档已恢复', '请 /跑团配置面板 核对GM、玩家和公告配置。')); return true;
      }
      const s = snapshot(i.guildId);
      activities.remember(i.guild);
      release = navigation.resolve(i);
      originalShowModal = i.showModal;
      i.showModal = value => originalShowModal.call(i, navigation.modal(i, value));
      // Modal opening itself is the initial response. Mutation is deferred on submit.
      if (i.customId && (await actionPanel.openModal(i,s) || await boardRecovery.openModal(i,s) || await variantPanel.openModal(i,s) || await mapExtra.openModal(i,s) || await rpPanel.openModal(i,s) || await aoePanel.openModal(i,s) || await npcPanel.openModal(i,s) || await checkSkills.openModal(i,s) || await bulkIssue.openModal(i,s) || await characterPanel.openModal(i,s) || await exploration.openModal(i, s) || await activities.openModal(i, s) || await gmUI.openModal(i, s) || await buyback.openModal(i, s) || await selections.openModal(i,s) || await texts.openModal(i,s) || await openModal(i, s))) return true;
      const publicResult = i.isChatInputCommand?.() && ['rd', '角色卡'].includes(i.commandName);
      if (privateSource && i.deferUpdate) await i.deferUpdate();
      else await i.deferReply(publicResult ? {} : { flags: E });
      metrics.observe('interaction.ack',performance.now()-receivedAt);
      const workDone=metrics.start('interaction.work');
      // discord.js patches this GuildMember from the current Discord interaction
      // payload. Its roles are fresh; a second REST lookup can queue behind limits.
      const member = i.member?.id===i.user.id&&i.member?.guild?.id===i.guildId&&i.member?.roles?.cache&&i.member?.permissions?.has
        ? i.member : await i.guild.members.fetch({ user: i.user.id, force: true });
      const result = i.isChatInputCommand?.() ? await slash(i, member) :
        i.customId.startsWith('rpg:act:') ? await actionPanel.component(i,member) :
        i.customId.startsWith('rpg:variant:') ? await variantPanel.component(i,member) :
        i.customId.startsWith('rpg:mapx:') ? await mapExtra.component(i,member) :
        i.customId.startsWith('rpg:rp:') ? await rpPanel.component(i,member) :
        i.customId.startsWith('rpg:aoe:') ? await aoePanel.component(i,member) :
        i.customId.startsWith('rpg:skill:') ? await combatSkills.component(i,member) :
        i.customId.startsWith('rpg:event:') ? await battleEvents.component(i,member) :
        i.customId.startsWith('rpg:boardrepair:') ? await boardRecovery.component(i,member) :
        i.customId.startsWith('rpg:npcui:') ? await npcPanel.component(i,member) :
        i.customId.startsWith('rpg:ammo:') ? await ammoPanel.component(i,member) :
        i.customId.startsWith('rpg:checkskill:') ? await checkSkills.component(i,member) :
        i.customId.startsWith('rpg:gear:') ? await equipment.component(i,member) :
        i.customId.startsWith('rpg:bulkgive:') ? await bulkIssue.component(i,member) :
        i.customId.startsWith('rpg:profile:') ? await characterPanel.component(i,member) :
        i.customId.startsWith('rpg:portrait:') ? await portraits.component(i,member) :
        i.customId.startsWith('rpg:map:') ? await exploration.component(i, member) :
        i.customId.startsWith('rpg:activity:') ? await activities.component(i, member) :
        i.customId.startsWith('rpg:buyback:') ? await buyback.component(i, member) :
        i.customId.startsWith('rpg:text:') ? await texts.component(i,member) :
        i.customId.startsWith('rpg:faction:') ? await factions.component(i, member) :
        i.customId.startsWith('rpg:gmui:') ? await gmUI.component(i, member) :
        /^rpg:(choose|quote(?:items|coins|save|finish)?)(:|category:|hand:|amount:|submit:|part:|repair:|do:)/.test(i.customId) ? await selections.component(i,member) : await component(i, member);
      workDone();
      const raw=result||payload('已完成','操作已保存。');
      const delayed=store.backgroundPublications&&(raw.rpgMap||raw.rpgPortraits);
      const response=delayed?{...raw,embeds:(raw.embeds||[]).map(e=>D.EmbedBuilder.from(e).setImage(null).setThumbnail(null)),files:[],attachments:[]}:await renderer.decorate(i.guildId,await portraits.decorate(i.guildId,raw));
      delete response.rpgMap;delete response.rpgPortraits;
      if(!publicResult){response.attachments ||= [];response.files ||= [];}
      const wrapped=publicResult?response:navigation.wrap(i,response),replyDone=metrics.start('interaction.reply');await i.editReply(wrapped);replyDone();
      metrics.observe('interaction.result',performance.now()-receivedAt);
      if(Number.isFinite(i.createdTimestamp))metrics.observe('interaction.endToEnd',Math.max(0,Date.now()-i.createdTimestamp));
      if(delayed){const ticket=navigation.ticket(i),job=(async()=>{
        // Rapid navigation can make an image obsolete before downloading/rendering.
        await new Promise(resolve=>setTimeout(resolve,200));
        if(!publicResult&&!navigation.current(i,ticket))return;
        const decorated=await renderer.decorate(i.guildId,await portraits.decorate(i.guildId,raw));
        if(publicResult||navigation.current(i,ticket)){const done=metrics.start('interaction.imageReply');await i.editReply({...decorated,components:wrapped.components});done();}
      })().catch(e=>logFailure('跑团图片后台补充失败，文字和按钮仍可使用。',e));mediaJobs.add(job);job.finally(()=>mediaJobs.delete(job));}
    } catch (error) {
      if(error.code==='RPG_PANEL_BUSY'){
        metrics.observe('interaction.busy',performance.now()-receivedAt);
        // The first request owns the operation and will update this same panel.
        // A repeated click only acknowledges receipt; it must not execute again.
        await i.deferUpdate().catch(e=>logFailure('跑团重复点击确认失败，原操作仍会继续。',e));return true;
      }
      if(error.recoverable&&privateSource&&i.deferred){
        metrics.observe('interaction.validation',performance.now()-receivedAt);
        await i.editReply({content:error.message,allowedMentions:{parse:[]}}).catch(()=>{});
        return true;
      }
      navigation.invalidate(i);
      logFailure('跑团操作失败。', error);
      const content = error.message || '操作失败，请刷新面板。';
      if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
      else await i.reply({ content, flags: E, allowedMentions: { parse: [] } }).catch(() => {});
    } finally {
      release?.(); if (originalShowModal) i.showModal = originalShowModal;
    }
    return true;
  }
  function stop(){clearInterval(timer);clearInterval(backupTimer);outbox.stop();renderer.close();metrics.close();}
  async function drain(){await Promise.allSettled([...interactions,...tickJobs]);await outbox.drain();await Promise.allSettled([...mediaJobs]);await store.drain();}
  async function trackedHandle(i){const job=handle(i);interactions.add(job);try{return await job;}finally{interactions.delete(job);}}
  return { start, handle:trackedHandle, stop, drain, store, activities, exploration, tickGuild, portraits, outbox,metrics };
}
module.exports = { createRpg, commands, dangerBits };
