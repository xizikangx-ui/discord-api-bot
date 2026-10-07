'use strict';
const C = require('./constants'), M = require('./model'), X = require('./exploration'), F = require('./forms'), U = require('./ui');
const L = require('./loot'), DTH = require('./mortality');
const Team=require('./team-movement');
const { requireThat: ok, clone } = C;
const { row, button, select, payload, modal, D } = U;
const place=(m,ref)=>m.mapType==='region'?('第'+(X.xy(ref)[1]+1)+'行 · 第'+(X.xy(ref)[0]+1)+'列'):location(ref);
const location = ref => { const [x,y] = X.xy(ref); return (y+1) + 'F · 第' + (x+1) + '格'; };
const labels = { draft: '草稿', active: '探索中', paused: '已暂停', ended: '已结束' };
function grid(m, full = false) {
  const icons = { room: '□', corridor: '·', stairs: '↕', entrance: '入', wall: '■' };
  const lines = [];
  for (let y = m.floors - 1; y >= 0; y--) {
    let line = String(y + 1).padStart(2, '0') + 'F ';
    for (let x = 0; x < m.width; x++) {
      const ref = X.key(x, y), c = m.cells[ref];
      line += !full && !m.revealed[ref] ? '？' : !c ? ' ' : Object.values(m.participants).some(p => p.cell === ref) ? '人' : icons[c.type];
    }
    lines.push(line);
  }
  return '```\n' + lines.join('\n') + '\n```\n入 入口 · 走廊 □ 房间 ↕ 楼梯 ■ 墙 ？迷雾';
}
function board(m) {
  const v = payload('探索地图 · ' + m.name, '**' + labels[m.status] + '** · ' + Object.keys(m.participants).length + '人参与\n' + '🟦 队伍　🟩 房间　🟪 楼梯　⬛ 墙　深色：迷雾', [
    row(button('map:join:' + m.id, '参与探索', D.ButtonStyle.Success, m.status !== 'active'),
      button('map:personal:' + m.id, '探索操作', D.ButtonStyle.Primary), button('map:manage:' + m.id, 'GM管理'))
  ], 0x2e8b57);
  const visible=Object.keys(m.revealed).length,total=Object.values(m.cells).filter(c=>c.type!=='wall').length;
  if(require('./rp').waiting(m))v.embeds[0].addFields(U.field('RP环境','等待GM公开环境描述，房间操作暂时锁定。'));
  if(m.excursion)v.embeds[0].addFields(U.field('建筑内队伍','队伍已经进入内部地图；退出建筑后会返回原位置。'));
  v.embeds[0].addFields(U.field('🧭 探索进度',U.bar(visible,total)+' '+visible+'/'+total,true),U.field('👥 队伍',Object.keys(m.participants).slice(0,15).map(uid=>'<@'+uid+'>').join(' ')||'等待报名',true),U.field('📍 最近事件',m.lastEvent||'全员确认后一起移动，迷雾由全队共享。'));
  v.embeds[0].setFooter({ text: m.id + ' · 全队共享迷雾 · 只有进入过的格子公开' }); return require('./map-image').prepare(v,{kind:'exploration',m});
}
function moveCard(m,r,page=0){const status={pending:'等待全员确认',completed:'全队已移动',rejected:'队员拒绝，已取消',expired:'确认超时',cancelled:'状态变化，已取消'};
  const waiting=r.members.filter(uid=>!r.yes.includes(uid));page=Math.max(0,Math.min(Number(page)||0,Math.max(0,Math.ceil(waiting.length/20)-1)));
  const v=payload((r.kind==='enter'?'全队进入建筑':r.kind==='exit'?'全队离开建筑':'全队移动确认')+' · '+m.name,'**'+status[r.status]+'**\n'+place(m,r.from)+' → '+(r.destinationName?r.destinationName+' · ':'')+(r.kind==='enter'?location(r.to):place(m,r.to))+'\n'+U.bar(r.yes.length,r.members.length)+' **'+r.yes.length+'/'+r.members.length+'** 人同意\n'+
    (r.status==='pending'?'截止 <t:'+Math.floor(r.expiresAt/1000)+':R>\n尚未确认：'+(waiting.slice(page*20,page*20+20).map(uid=>'<@'+uid+'>').join(' ')||'无'):r.reason||'全队位置已保存。'),[
    ...(r.status==='pending'?[row(button('map:movevote:'+m.id+':'+r.id+':yes','同意移动',D.ButtonStyle.Success),button('map:movevote:'+m.id+':'+r.id+':no','拒绝移动',D.ButtonStyle.Danger),button('map:movecancel:'+m.id+':'+r.id,'发起者 / GM取消'))]:[]),
    row(button('map:moveinfo:'+m.id+':'+r.id+':'+(page-1),'上一页名单',undefined,!page),button('map:moveinfo:'+m.id+':'+r.id+':'+(page+1),'下一页名单',undefined,(page+1)*20>=waiting.length),button('map:personal:'+(r.resultMapId||m.id),'返回探索操作'))
  ],r.status==='pending'?0xf1c40f:r.status==='completed'?0x2ecc71:0x95a5a6);
  v.embeds[0].setFooter({text:r.id+' · 拒绝或三分钟超时不移动 · 不公开未探索房间内容'});return v;
}
function corpseView(state, corpse, page = 0) {
  const items = corpse.items.filter(i => !corpse.claims[i.id]);
  page = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(items.length / 15) - 1)));
  const part = items.slice(page * 15, page * 15 + 15), b = state.battles[corpse.battleId];
  return payload('人形NPC掉落 · ' + corpse.name, (b.status === 'ended' ? '战斗已结束，存活参战角色可领取。' : '战斗结束后开放领取。') +
    '\n剩余' + items.length + '项\n\n' + part.map(i => '**' + i.snapshot.name + '** ×' + i.quantity + ' · ' + C.kg(M.itemWeight(i)) +
      '\n' + i.snapshot.description.slice(0, 100) + '\n' + i.id).join('\n'), [
    ...(part.length ? [row(select('map:corpseclaim:' + corpse.id, '选择一件领取（超重时保留）', part.map(i => ({ label: i.snapshot.name, value: i.id }))))] : []),
    row(button('map:corpse:' + corpse.id + ':' + (page - 1), '上一页', undefined, !page),
      button('map:corpse:' + corpse.id + ':' + (page + 1), '下一页', undefined, (page + 1) * 15 >= items.length), button('map:corpse:' + corpse.id + ':' + page, '刷新'))
  ], 0xe67e22);
}
function createExploration({ snapshot, store, tx: transact, textChannel, client, needGM, activities, publishBattle, gmUI, logFailure,render=async(g,v)=>v }) {
  const jobs = new Map();
  const tx = (i, fn, label) => transact(i, st => { if (i.rpgMapGM) needGM(st, i.rpgMapMember || i.member); return fn(st); }, label);
  function map(s, ref) { const m = s.explorations[ref]; ok(m, s.mapTombstones?.[ref]?'地图已清理。':'地图不存在。'); return m; }
  function picker(title, entries, base, page = 0, extras = []) {
    page = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(entries.length / 20) - 1)));
    return payload(title, '共' + entries.length + '项 · 第' + (page + 1) + '页', [
      ...(entries.length ? [row(select('map:' + base + ':pick', '选择一项', entries.slice(page * 20, page * 20 + 20)))] : []),
      row(button('map:' + base + ':' + (page - 1), '上一页', undefined, !page),
        button('map:' + base + ':' + (page + 1), '下一页', undefined, (page + 1) * 20 >= entries.length), ...extras)
    ]);
  }
  const back = () => button('map:config', '返回地图配置');
  function config(s) {
    return payload('GM地图与掉落配置', '先录入地图大类，再录入房间。房间可含固定内容与随机容器、散落物资、NPC。\n随机数量分别按0—6、0—6、0—10的独立概率配置，使用下拉选择。\n保险箱概率与钥匙次数可独立调整。', [
      row(button('map:newcategory', '录入大类', D.ButtonStyle.Primary), button('map:newroom', '录入房间', D.ButtonStyle.Primary), button('map:library:category:0', '已有大类'), button('map:library:room:0', '已有房间')),
      row(button('mapx:boxes:0', '容器分档 / 六色概率'), button('map:keys', '玩家钥匙次数'), button('map:deaths:0', '指定击杀经验'), button('map:home', '地图列表')),
      row(button('map:corpselist:0', 'NPC掉落公示 / 补发'),button('rp:config','RP隐藏操作频道'),button('mapx:cleanuppreview','清理旧地图'))
    ]);
  }
  function home(s, member) {
    const gm = U.gm(s, member), entries = Object.values(s.explorations).filter(m => gm || ['active', 'paused'].includes(m.status));
    return picker('探索地图', entries.map(m => ({ label: m.name + ' · ' + labels[m.status], value: m.id })), 'list', 0,
      gm ? [button('mapx:start', '创建地图', D.ButtonStyle.Primary),button('mapx:cleanuppreview','清理已结束地图'), back()] : []);
  }
  function manage(s, m) {
    const v=payload('GM地图 · ' + m.name, labels[m.status]+' · 难度上限 '+require('./npc-strength').LEVELS[(m.maxRank??3)-1]+' · RP '+(m.rpEnabled?'开启':'关闭') + '\n完整布局仅GM可见 · 蓝色为队伍 · 青色房间 · 紫色楼梯\n已探索' + Object.keys(m.revealed).length + '格 · 房间内容请在格子详情核对。', [
      row(button('map:celltype:' + m.id, '添加 / 修改 / 删除格子', D.ButtonStyle.Primary, !['draft', 'paused'].includes(m.status)),
        button('map:generate:' + m.id + ':' + m.version, '生成 / 重新抽取', undefined, m.status !== 'draft'),
        button('map:publish:' + m.id + ':' + m.version, '确认发布', D.ButtonStyle.Success, m.status !== 'draft' || !m.generated)),
      row(button('map:toggle:' + m.id + ':' + m.version, m.status === 'paused' ? '恢复探索' : '暂停探索', undefined, !['active', 'paused'].includes(m.status)),
        button('map:gmroom:' + m.id + ':0', '房间 / 遭遇 / 待领取'), button('map:players:' + m.id + ':0', '队员 / 位置'),
        button('map:endpreview:' + m.id, '结束探索', D.ButtonStyle.Danger, m.status === 'ended')),
      row(button('rp:toggle:'+m.id,m.rpEnabled?'关闭RP':'开启RP'),button('rp:home:'+m.id+':'+(m.rpPendingId||'_'),'环境草稿 / 等待',undefined,!m.rpPendingId),button('mapx:layout:'+m.id+':'+m.version,'重新随机布局',undefined,m.status!=='draft'||m.mode==='fixed')),
      ...(m.moveRequestId?[row(button('map:moveinfo:'+m.id+':'+m.moveRequestId+':0','当前移动申请'),button('map:moverepost:'+m.id+':'+m.moveRequestId,'核对后补发移动确认'))]:[]),
      row(button('map:manage:' + m.id, '刷新'), button('map:repost:' + m.id, '核对后补发地图', undefined, m.status === 'draft'), button('map:home', '返回地图列表'), button('map:celldraft:' + m.id, '继续格子草稿', undefined, !Object.keys(m.cellDrafts || {}).length))
    ]);
    return require('./map-image').prepare(v,{kind:'exploration',m,full:true});
  }
  function personal(s, m, uid, tab='move', page=0) {
    const part=m.participants[uid],p=s.players[uid];ok(part&&p?.id===part.characterId,'先参加探索。');
    if(require('./rp').waiting(m))return payload('等待GM描述 · '+m.name,'队伍已进入新房间，GM正在准备环境描述。移动、遭遇和物资领取暂时锁定。',[row(button('map:personal:'+m.id,'刷新探索'))]);
    const c=m.cells[part.cell],r=c?.room,stats=M.stats(p),tabs={move:'全队移动',room:'房间交互',team:'探索队伍',map:'地图楼层'};
    ok(tabs[tab],'探索分页无效。');const components=[row(select('map:personaltab:'+m.id,'探索操作分页',Object.entries(tabs).map(([value,label])=>({value,label,default:tab===value}))))];
    let body='**'+m.name+'** · '+labels[m.status]+'\n📍 '+place(m,part.cell)+'\n'+(r?'**'+r.snapshot.name+'**\n'+(r.publicDescription||r.snapshot.description).slice(0,1800):(c?.description||X.cellTypes(m)[c?.type]))+'\n'+
      (r?'遭遇 '+({pending:(r.autoStart??r.snapshot.autoStart)?'等待自动开战':'等待GM确认',battle:'战斗中',resolved:'可探索物资'}[r.encounter])+'\n':'')+'负重 '+C.kg(stats.carried)+' / '+C.kg(stats.limit)+' '+U.bar(stats.carried,stats.limit);
    if(tab==='move'){
      const directions=X.neighbors(m,part.cell).map(to=>{const [x,y]=X.xy(to),[ox,oy]=X.xy(part.cell);return button('map:move:'+m.id+':'+to,x<ox?'← 向左':x>ox?'向右 →':y>oy?(m.mapType==='region'?'↓ 向下':'↑ 上楼'):(m.mapType==='region'?'↑ 向上':'↓ 下楼'),D.ButtonStyle.Primary,m.status!=='active'||!!M.battleFor(s,uid));});
      if(directions.length)components.push(row(...directions));body+='\n全队必须在同一格，全部同意后才移动。';
      if(c?.type==='building'&&c.buildingMapId)components.push(row(button('map:portal:'+m.id+':enter','全队进入建筑',D.ButtonStyle.Success)));
      if(m.parentContext&&part.cell===m.entrance)components.push(row(button('map:portal:'+m.id+':exit','全队离开建筑',D.ButtonStyle.Success)));
      const request=m.moves?.[m.moveRequestId];if(request)components.push(row(button('map:moveinfo:'+m.id+':'+request.id+':0','当前 / 最近移动申请')));
    }
    if(tab==='room'){components.push(row(button('map:containers:'+m.id+':0','房间容器（免费）',D.ButtonStyle.Primary,!r||r.encounter!=='resolved'||!r.containers.some(c=>c.status!=='claimed')),button('map:supplies:'+m.id+':0','散落物资',undefined,!r||r.encounter!=='resolved'||!r.supplies.length)));
      body+='\n容器剩余 '+(r?.containers.filter(c=>c.status!=='claimed').length||0)+' · 物资剩余 '+(r?.supplies.length||0);}
    if(tab==='team'){const members=Object.entries(m.participants);page=Math.max(0,Math.min(Number(page)||0,Math.max(0,Math.ceil(members.length/15)-1)));body+='\n\n'+members.slice(page*15,page*15+15).map(([id,p])=>'<@'+id+'> · '+place(m,p.cell)).join('\n');components.push(row(button('map:personalpage:'+m.id+':team:'+(page-1),'上一页',undefined,!page),button('map:personalpage:'+m.id+':team:'+(page+1),'下一页',undefined,(page+1)*15>=members.length)));}
    if(tab==='map'&&m.mapType!=='region'){page=Math.max(0,Math.min(Number.isFinite(Number(page))?Number(page):X.xy(part.cell)[1],m.floors-1));components.push(row(select('map:floor:'+m.id,'选择楼层',Array.from({length:m.floors},(_,n)=>({value:String(n),label:(n+1)+'F',default:page===n})))));}
    components.push(row(button('map:personalpage:'+m.id+':'+tab+':'+page,'刷新当前页'),button('map:leave:'+m.id,'退出探索')));
    const v=payload('探索操作 · '+p.name,body,components,0x1abc9c);v.embeds[0].setFooter({text:m.id+' · 私有操作面板 · 资产不会写入公共地图'});
    return tab==='map'?require('./map-image').prepare(v,{kind:'exploration',m,floor:page}):v;
  }
  async function publish(guild, ref, force = false) {
    const key = guild + ':' + ref; if (jobs.has(key)) return jobs.get(key);
    const job = (async () => {
      let m = map(snapshot(guild), ref); const ch = await textChannel(guild, m.channelId);
      if (m.messageId) {
        const old = await ch.messages.fetch(m.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (old) { await old.edit(await render(guild,board(m))); return; }
        ok(force, '地图公示已删除，GM核对后补发。');
      }
      ok(force || !['sending', 'uncertain'].includes(m.publication?.status), '地图发送结果待核对，请GM检查后补发。');
      await store.transact(guild, 'map-send:' + C.id('n'), client.user.id, st => { st.explorations[ref].publication = { status: 'sending' }; }, '保存地图公示意图');
      try {
        m = map(snapshot(guild), ref); const message = await ch.send({ ...await render(guild,board(m)), nonce: ref, enforceNonce: true });
        await store.transact(guild, 'map-sent:' + message.id, client.user.id, st => {
          st.explorations[ref].messageId = message.id; st.explorations[ref].publication = { status: 'sent' };
        }, '地图公示送达');
      } catch (e) {
        if (!store.frozen(guild)) await store.transact(guild, 'map-failed:' + C.id('n'), client.user.id, st => {
          st.explorations[ref].publication = { status: typeof e.code === 'number' ? 'failed' : 'uncertain' };
        }, '地图公示待核对'); throw e;
      }
    })(); jobs.set(key, job); try { await job; } finally { jobs.delete(key); }
  }
  async function publishMove(guild,ref,requestId,force=false){const key='move:'+guild+':'+ref+':'+requestId;
    const job=(jobs.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      let m=map(snapshot(guild),ref),r=m.moves?.[requestId];ok(r,'移动申请不存在。');const ch=await textChannel(guild,m.channelId);
      let missingFirst=false;
      if(r.messageId){const old=await ch.messages.fetch(r.messageId).catch(e=>{if(e.code===10008)return null;throw e;});if(old){await old.edit({...moveCard(m,r),content:'',allowedMentions:{parse:[]}});
        if(r.status!=='pending'||(Object.keys(r.publication.batches||{}).length>=Math.ceil(r.members.length/60)&&Object.values(r.publication.batches||{}).every(b=>b.status==='sent')))return;
      }else {ok(force,'确认消息已删除，请GM核对后补发。');missingFirst=true;}}
      ok(force||!['sending','uncertain'].includes(r.publication.status),'移动确认发送结果待核对，请GM补发。');
      const batches=[];for(let n=0;n<r.members.length;n+=60)batches.push(r.members.slice(n,n+60));
      for(let n=0;n<batches.length;n++){
        const current=map(snapshot(guild),ref).moves[requestId];if(current.publication.batches?.[n]?.status==='sent'&&!(missingFirst&&!n))continue;
        ok(force||!['sending','uncertain'].includes(current.publication.batches?.[n]?.status),'该批提及结果不明确，请GM核对后补发。');
        await store.transact(guild,'move-intent:'+C.id('n'),client.user.id,st=>{const live=st.explorations[ref].moves[requestId];live.publication.status='sending';live.publication.batches||={};live.publication.batches[n]={status:'sending'};},'全队移动通知意图');
        try{m=map(snapshot(guild),ref);r=m.moves[requestId];const sent=await ch.send({...(!n?moveCard(m,r):{}),content:batches[n].map(uid=>'<@'+uid+'>').join(' ')+(n?' 请确认全队移动。':''),allowedMentions:{parse:[],users:batches[n]},nonce:r.id+'_'+n,enforceNonce:true});
          await store.transact(guild,'move-sent:'+sent.id,client.user.id,st=>{const live=st.explorations[ref].moves[requestId];live.publication.batches[n]={status:'sent',messageId:sent.id};if(!n)live.messageId=sent.id;live.publication.status='sent';},'全队移动通知送达');
        }catch(e){if(!store.frozen(guild))await store.transact(guild,'move-failed:'+C.id('n'),client.user.id,st=>{const live=st.explorations[ref].moves[requestId];live.publication.status=typeof e.code==='number'?'failed':'uncertain';live.publication.batches[n]={status:live.publication.status};},'全队移动通知待核对');throw e;}
      }
    });jobs.set(key,job);try{await job;}finally{if(jobs.get(key)===job)jobs.delete(key);}
  }
  async function publishCorpsesInner(guild, battleId, force = false) {
    const s = snapshot(guild), b = s.battles[battleId];
    for (const c of Object.values(s.corpses).filter(c => c.battleId === battleId)) {
      const ch = await textChannel(guild, b.channelId);
      const remaining = c.items.filter(i => !c.claims[i.id]);
      const card = payload('NPC掉落 · ' + c.name, '可拾取' + remaining.length + '项实物。战斗结束后开放领取；探索遭遇须GM解除。\n\n' +
        remaining.slice(0,15).map(i => '**' + i.snapshot.name + '** ×' + i.quantity + ' · ' + C.kg(M.itemWeight(i)) + '\n' + i.snapshot.description.slice(0,60)).join('\n') + (remaining.length > 15 ? '\n更多物品通过下方面板分页查看。' : ''),
        [row(button('map:corpse:' + c.id + ':0', '查看共享掉落', D.ButtonStyle.Primary))], 0xe67e22);
      if (c.messageId) { const message = await ch.messages.fetch(c.messageId).catch(e => { if (e.code === 10008) return null; throw e; });
        if (message) { await message.edit(card); continue; } ok(force, '尸体公示已删除，请GM核对后补发。'); }
      ok(force || !['sending', 'uncertain'].includes(c.publication.status), '尸体公示结果待核对，请GM核对后补发。');
      await store.transact(guild, 'corpse-send:' + C.id('n'), client.user.id, st => { st.corpses[c.id].publication.status = 'sending'; }, '尸体公示意图');
      try { const message = await ch.send({ ...card, nonce: c.id, enforceNonce: true });
        await store.transact(guild, 'corpse-sent:' + message.id, client.user.id, st => { st.corpses[c.id].messageId = message.id; st.corpses[c.id].publication.status = 'sent'; }, '尸体公示送达');
      } catch (e) { if (!store.frozen(guild)) await store.transact(guild, 'corpse-failed:' + C.id('n'), client.user.id, st => {
        st.corpses[c.id].publication.status = typeof e.code === 'number' ? 'failed' : 'uncertain';
      }, '尸体公示待核对'); throw e; }
    }
  }
  async function publishCorpses(guild, battleId, force = false) {
    const key = 'corpses:' + guild + ':' + battleId;
    const job = (jobs.get(key) || Promise.resolve()).catch(() => {}).then(() => publishCorpsesInner(guild, battleId, force));
    jobs.set(key, job); try { await job; } finally { if (jobs.get(key) === job) jobs.delete(key); }
  }
  async function openModal(i, s) {
    if (i.isModalSubmit?.() || !i.customId?.startsWith('rpg:map:')) return false;
    const [, action, ref, arg,extra] = i.customId.split(':').slice(1);
    if (!['createnamed', 'coord', 'rateedit', 'keyedit', 'teleport','celldescription'].includes(action)) return false;
    needGM(s, i.member);
    let fields;
    if (action === 'createnamed') fields = [{ key: 'name', label: '地图名称' }, { key: 'floors', label:extra==='region'?'区域行数1—20':'楼层1—20', value: '3' }, { key: 'width', label:extra==='region'?'区域列数1—20':'每层格数1—20', value: '9' }];
    if (action === 'coord' || action === 'teleport') fields = [{ key: 'x', label: '列1—20' }, { key: 'y', label:map(s,ref).mapType==='region'?'区域行1—20':'楼层1—20' }];
    if (action === 'rateedit') fields = [{ key: 'values', label: '白 绿 蓝 紫 金 红（空格分隔，合计100）', value: L.rates(s, ref).join(' ') }];
    if (action === 'keyedit') { const item = M.player(s, ref).inventory[arg]; ok(item?.snapshot.kind === '钥匙', '钥匙已不存在。'); fields = [{ key: 'charges', label: '剩余次数（设置绝对值，0—100000）', value: item.keyCharges }]; }
    if(action==='celldescription'){const d=map(s,ref).cellDrafts?.[i.user.id];ok(d,'格子草稿已失效。');fields=[{key:'name',label:'地点名称（留空用模板名称）',value:d.name,required:false},{key:'description',label:'地点说明',value:d.description,long:true,required:false}];}
    await i.showModal(modal('map:' + action + 'submit:' + ref + (arg ? ':' + arg : '')+(extra?':'+extra:''), 'GM配置', fields)); return true;
  }
  async function component(i, member) {
    const [, action, ref, arg, extra] = i.customId.split(':').slice(1), s = snapshot(i.guildId), uid = i.user.id;
    const gm = U.gm(s, member);
    if(['movevote','moveinfo','movecancel','moverepost'].includes(action)){
      const m=map(s,ref),r=m.moves?.[arg];ok(r,'移动申请不存在。');
      if(action==='moveinfo')return moveCard(m,r,Number(extra));
      if(action==='moverepost'){needGM(s,member);await publishMove(i.guildId,ref,arg,true);return moveCard(map(snapshot(i.guildId),ref),map(snapshot(i.guildId),ref).moves[arg]);}
      if(action==='movevote')ok(U.playerRole(s,member),'需要玩家身份组。');else ok(gm||r.owner===uid,'仅发起者或GM可以取消。');
      let missingMember=false,freshMembers=[];
      if(action==='movevote'&&extra==='yes'&&r.members.every(id=>id===uid||r.yes.includes(id))){
        for(let n=0;n<r.members.length;n+=10){const members=await Promise.all(r.members.slice(n,n+10).map(user=>i.guild.members.fetch({user,force:true}).catch(e=>{if(e.code===10007)return null;throw e;})));freshMembers.push(...members);if(members.some(member=>!member||!U.playerRole(s,member)))missingMember=true;}
      }
      await tx(i,st=>{const live=map(st,ref);if(action==='movevote')ok(U.playerRole(st,member),'需要玩家身份组。');missingMember ||=freshMembers.some(m=>!m||!U.playerRole(st,m));if(action==='movecancel'||missingMember){const r=live.moves[arg];ok(r.status==='pending','申请已经结束。');r.status='cancelled';r.reason=missingMember?'队员已退服或不再拥有玩家身份组':'发起者或GM取消';}else Team.vote(st,live,arg,uid,extra==='yes');},'全队移动确认');
      await publishMove(i.guildId,ref,arg);await publish(i.guildId,ref);const dest=map(snapshot(i.guildId),ref).moves[arg].resultMapId;if(dest)await publish(i.guildId,dest);return moveCard(map(snapshot(i.guildId),ref),map(snapshot(i.guildId),ref).moves[arg]);
    }
    if(action==='portal'){ok(U.playerRole(s,member),'需要玩家身份组。');const r=await tx(i,st=>{ok(U.playerRole(st,member),'需要玩家身份组。');return require('./map-links').propose(st,map(st,ref),uid,arg);},'全队建筑切换申请');await publishMove(i.guildId,ref,r.id);await publish(i.guildId,ref);if(r.resultMapId)await publish(i.guildId,r.resultMapId);return moveCard(map(snapshot(i.guildId),ref),map(snapshot(i.guildId),ref).moves[r.id]);}
    if(['personaltab','personalpage','floor'].includes(action)){ok(U.playerRole(s,member),'需要玩家身份组。');return personal(s,map(s,ref),uid,action==='personaltab'?i.values[0]:action==='floor'?'map':arg,action==='floor'?Number(i.values[0]):Number(extra));}
    if (action === 'home') return home(s, member);
    if (action === 'list') return ref === 'pick' ? (gm ? manage(s, map(s, i.values[0])) : board(map(s, i.values[0]))) :
      picker('探索地图', Object.values(s.explorations).filter(m => gm || ['active', 'paused'].includes(m.status)).map(m => ({ label: m.name + ' · ' + labels[m.status], value: m.id })), 'list', ref);
    if (action === 'corpse') { const c = s.corpses[ref]; ok(c, '掉落记录不存在。'); return corpseView(s, c, arg); }
    if (action === 'corpseclaim') {
      ok(U.playerRole(s, member), '需要玩家身份组。'); const c = s.corpses[ref];
      await tx(i, st => { ok(U.playerRole(st, member), '需要玩家身份组。'); return DTH.claim(st, ref, uid, i.values[0]); }, '领取NPC掉落'); await publishCorpses(i.guildId, c.battleId);
      return corpseView(snapshot(i.guildId), snapshot(i.guildId).corpses[ref]);
    }
    if (['join', 'personal', 'move', 'unlock', 'open', 'containers', 'take', 'supplies', 'mapview', 'leave'].includes(action)) {
      const m = map(s, ref); ok(U.playerRole(s, member), '需要玩家身份组。');
      if (action === 'containers' || (action === 'open' && arg !== 'pick')) return picker('房间容器', X.currentRoom(s, m, uid).r.containers.filter(c => c.status !== 'claimed').map(c => ({ label: c.box + ' · ' + c.status, value: c.id })), 'open:' + ref, arg, [button('map:personal:' + ref, '返回房间')]);
      if (action === 'personal') return personal(s, m, uid);
      if (action === 'mapview') return { ...board(m), components: [row(button('map:personal:' + m.id, '返回探索操作'))] };
      if (action === 'supplies') return picker('固定物资', X.currentRoom(s,m,uid).r.supplies.map(x => ({ label: x.snapshot.name + ' · ' + C.kg(M.itemWeight(x)), value: x.id })) || [], 'take:' + ref, arg, [button('map:personal:' + ref, '返回房间')]);
      if (action === 'take' && arg !== 'pick') return picker('固定物资', X.currentRoom(s, m, uid).r.supplies.map(x => ({ label: x.snapshot.name, value: x.id })), 'take:' + ref, arg);
      if (action === 'move' && m.cells[arg]?.room && !m.cells[arg].room.unlocked) {
        const { p } = X.participant(s, m, uid), required = m.cells[arg].room.snapshot.keyIds[0];
        const keys = Object.values(p.inventory).filter(x => x.templateId === required && x.keyCharges > 0 && M.available(s, uid, x.id) > 0);
        return payload('房门上锁', '首次开门消耗匹配钥匙一次，此后全队永久解锁。', [
          ...(keys.length ? [row(select('map:unlock:' + ref + ':' + arg, '选择钥匙', keys.slice(0, 25).map(k => ({ label: k.snapshot.name + ' · 剩余' + k.keyCharges, value: k.id }))))] : []),
          row(button('map:personal:' + ref, keys.length ? '取消开门' : '缺少可用钥匙，返回'))
        ]);
      }
      const result = await tx(i, st => {
        const live = map(st, ref); ok(U.playerRole(st, member), '需要玩家身份组。');
        if (action === 'join') X.join(st, live, uid);
        if (action === 'leave') { ok(!M.battleFor(st, uid), '战斗期间请GM移出。'); delete live.participants[uid];require('./map-links').releaseEmpty(st,live); live.version++; }
        if (action === 'move' || action === 'unlock') return { moveRequest: Team.propose(st,live,uid,arg,i.values?.[0]).id };
        if (action === 'open') return X.open(st, live, uid, i.values[0]);
        if (action === 'take') {
          const item = X.take(st, live, uid, i.values[0]), record = { id: C.id('l'), userId: uid, channelId: live.channelId, at: Date.now(),
            result: { box: '房间物资', batchId: item.id, items: [clone(item)], item: clone(item), pending: false, free: true }, publication: {status:'pending'} };
          st.lootPublications[record.id] = record; return { publicationId: record.id };
        }
      }, '地图玩家操作');
      await publish(i.guildId, ref);
      if(result?.moveRequest){await publishMove(i.guildId,ref,result.moveRequest);return moveCard(map(snapshot(i.guildId),ref),map(snapshot(i.guildId),ref).moves[result.moveRequest]);}
      if (result?.publicationId) await activities.publish(i.guildId, 'loot', result.publicationId, false).catch(e => logFailure('地图容器公示失败，GM可从抽取公示补发。', e));
      if (result?.item) await i.channel.send(payload('探索物资已领取', '<@' + uid + '> 获得 **' + result.item.snapshot.name + '** ×' + result.item.quantity + '\n' + result.item.snapshot.description));
      if (result?.encountered && !require('./rp').waiting(map(snapshot(i.guildId),ref))) {
        const room = map(snapshot(i.guildId), ref).cells[result.cell].room;
        await i.channel.send({ ...payload('房间遭遇 · ' + room.snapshot.name, '玩家进入了怪物房，请GM确认阵容后开战。', [row(button('map:room:' + ref + ':' + result.cell, 'GM处理遭遇'))]),
          content: s.config.gmRoleIds.map(r => '<@&' + r + '>').join(' '), allowedMentions: { parse: [], roles: s.config.gmRoleIds } });
      }
      return action === 'leave' ? home(snapshot(i.guildId), member) : personal(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid);
    }
    needGM(s, member); i.rpgMapGM = true; i.rpgMapMember = member;
    if (action === 'config') return config(s);
    if (action === 'newcategory' || action === 'newroom') {
      const f = await tx(i, st => F.create(st, uid, action === 'newcategory' ? 'mapcategory' : 'room'), '创建地图模板草稿'); return F.view(snapshot(i.guildId), f);
    }
    if (action === 'library') {
      const source = ref === 'category' ? 'mapCategories' : 'roomTemplates';
      if (arg === 'pick') { const f = await tx(i, st => F.create(st, uid, ref === 'category' ? 'mapcategory' : 'room', null, i.values[0]), '修改地图模板'); return F.view(snapshot(i.guildId), f); }
      return picker('已有' + (ref === 'category' ? '大类' : '房间'), Object.values(s[source]).map(t => ({ label: t.name, value: t.id })), 'library:' + ref, arg, [back()]);
    }
    if(action==='rates'&&s.contentPackVersion===1)return payload('概率已统一到六色容器','请使用新入口调整同档位所有容器。',[row(button('mapx:grades','六色概率'),button('mapx:boxes:0','容器分档'))]);
    if (action === 'rates') return payload('保险箱爆率', '每件独立抽取；已生成结果不受修改影响。', [
      row(select('map:ratepick', '选择保险箱', Object.keys(L.DEFAULT_SAFE_RATES).map(b => ({ label: b, value: b })))), row(back())
    ]);
    if (action === 'ratepick' || action === 'rateview') { const box = action === 'ratepick' ? i.values[0] : ref; return payload(box + ' · 概率',
      '白／绿／蓝／紫／金／红：\n' + L.rates(s, box).join('% ／ ') + '%', [row(button('map:rateedit:' + box, '修改概率'), button('map:ratereset:' + box, '恢复默认'), button('map:rates', '返回'))]); }
    if (action === 'rateeditsubmit' || action === 'ratereset') {
      ok(s.contentPackVersion!==1,'旧独立保险箱配置已迁移，请使用六色概率面板。');
      await tx(i, st => L.setRates(st, ref, action === 'ratereset' ? L.DEFAULT_SAFE_RATES[ref] : i.fields.getTextInputValue('values').trim().split(/\s+/).map(Number)), '修改保险箱爆率'); return config(snapshot(i.guildId));
    }
    if (action === 'keys') return payload('GM钥匙次数', '选择持有钥匙的玩家。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:keyuser').setPlaceholder('选择玩家')), row(back())]);
    if (action === 'keyuser' || action === 'keylist') { const target = action === 'keyuser' ? i.values[0] : ref; return picker('玩家钥匙', Object.values(M.player(s, target).inventory).filter(k => k.snapshot.kind === '钥匙').map(k => ({ label: k.snapshot.name + ' · 剩余' + k.keyCharges, value: k.id })), 'keychoose:' + target, arg, [back()]); }
    if (action === 'keychoose') { if (arg === 'pick') return payload('钥匙次数', '编号 ' + i.values[0], [row(button('map:keyedit:' + ref + ':' + i.values[0], '设置剩余次数'), button('map:keylist:' + ref + ':0', '返回'))]); return picker('玩家钥匙', Object.values(M.player(s, ref).inventory).filter(k => k.snapshot.kind === '钥匙').map(k => ({ label: k.snapshot.name, value: k.id })), 'keychoose:' + ref, arg); }
    if (action === 'keyeditsubmit') { await tx(i, st => { const item = M.player(st, ref).inventory[arg]; ok(item?.snapshot.kind === '钥匙' && M.available(st, ref, arg) > 0, '钥匙不存在或被预留。'); item.keyCharges = C.number(i.fields.getTextInputValue('charges'), '次数', 0, 100000); }, 'GM调整钥匙次数'); return config(snapshot(i.guildId)); }
    if(action==='createtype')return payload('创建探索地图 · 类型','建筑内部按楼层和走廊排列；区域地图按上下左右相邻格探索。',[row(select('map:mapkind','地图类型',[{value:'indoor',label:'建筑内部 · 多层平面图'},{value:'region',label:'区域大地图 · 道路与地标'}])),row(back())]);
    if(action==='mapkind'||action==='category'){const type=action==='mapkind'?i.values[0]:ref;
      if(action==='category'&&arg==='pick')return payload('选择生成方式','随机从指定大类抽房间，固定逐格指定内容。',[row(select('map:createmode:'+i.values[0]+':'+type,'地图方式',[{label:'随机',value:'random'},{label:'固定',value:'fixed'}])),row(back())]);
      return picker('选择地图大类',Object.values(s.mapCategories).filter(t=>t.published&&(t.mapTypes||['indoor','region']).includes(type)).map(t=>({label:t.name,value:t.id})),'category:'+type,action==='mapkind'?0:arg,[back()]);}
    if (action === 'createcategory') {
      if (ref === 'pick') return payload('选择生成方式', '随机从大类房间抽选；固定逐格指定。', [row(select('map:createmode:' + i.values[0], '地图方式', [{ label: '随机', value: 'random' }, { label: '固定', value: 'fixed' }])), row(button('map:home', '取消'))]);
      return picker('选择地图大类', Object.values(s.mapCategories).map(t => ({ label: t.name, value: t.id })), 'createcategory', ref, [back()]);
    }
    if (action === 'createmode') return payload('创建地图', '模式 ' + i.values[0] + '，填写大小后进入可编辑预览。', [row(button('map:createnamed:' + ref + ':' + i.values[0]+':'+(arg==='region'?'region':'indoor'), '填写名称与大小'), button('map:home', '取消'))]);
    if (action === 'createnamedsubmit') { const m = await tx(i, st => X.create(st, uid, i.channelId, i.fields.getTextInputValue('name'), i.fields.getTextInputValue('floors'), i.fields.getTextInputValue('width'), arg, ref,extra==='region'?'region':'indoor'), '创建地图草稿'); return manage(snapshot(i.guildId), m); }
    if (action === 'deaths') {
      if (ref === 'pick') return payload('指定击杀经验', '选择获得经验的有效玩家角色。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:rewarduser:' + i.values[0])), row(back())]);
      return picker('未结算击杀经验', Object.values(s.deaths).filter(d => d.kind === 'npc' && d.team === 'enemy' && !d.rewarded).map(d => ({ label: d.name + ' · 基础经验' + d.baseXP, value: d.id })), 'deaths', ref, [back()]);
    }
    if (action === 'rewarduser') return payload('确认击杀归属', '<@' + i.values[0] + '> 将获得该NPC经验，仅能结算一次。', [row(button('map:reward:' + ref + ':' + i.values[0], '确认发放', D.ButtonStyle.Success), back())]);
    if (action === 'reward') { const death = s.deaths[ref]; ok(death, '死亡记录不存在。'); await tx(i, st => DTH.reward(st, st.battles[death.battleId], st.deaths[ref], arg), 'GM指定击杀经验'); return config(snapshot(i.guildId)); }
    if (action === 'corpselist') {
      if (ref === 'pick') return payload('NPC掉落公示', '核对频道后可补发已有掉落卡，不重新生成物品。', [row(button('map:corpserepost:' + i.values[0], '核对后补发'), button('map:corpse:' + i.values[0] + ':0', '查看掉落'), back())]);
      return picker('NPC掉落记录', Object.values(s.corpses).map(c => ({ label: c.name + ' · ' + c.publication.status, value: c.id })), 'corpselist', ref, [back()]);
    }
    if (action === 'corpserepost') { ok(s.corpses[ref], '掉落不存在。'); await publishCorpses(i.guildId, s.corpses[ref].battleId, true); return config(snapshot(i.guildId)); }
    const m = map(s, ref);
    if(action==='cellvariant'){const d=m.cellDrafts?.[uid],t=s.roomTemplates[d?.templateId];ok(t,'先指定房间。');if(arg==='pick'){await tx(i,st=>{const d=map(st,ref).cellDrafts[uid],t=st.roomTemplates[d.templateId];ok(i.values[0]==='auto'||t.variants.some(v=>v.id===i.values[0]&&v.enabled!==false),'变种已失效。');d.variantId=i.values[0]==='auto'?null:i.values[0];},'选择固定或随机变种');return cellDraft(snapshot(i.guildId),map(snapshot(i.guildId),ref),uid);}return picker('选择房间变种',[{label:'按变种权重随机',value:'auto'},...t.variants.filter(v=>v.enabled!==false).map(v=>({label:v.name,value:v.id}))],'cellvariant:'+ref,arg,[button('map:celldraft:'+ref,'返回格子')]);}
    if (action === 'manage') return manage(s, m);
    if (action === 'celltype') return payload('编辑格子 · 选择类型', '已有交互的格子不能替换。', [row(select('map:typepick:' + ref, '格子类型', [...Object.entries(X.cellTypes(m)).map(([value, label]) => ({ value, label })), { label: '删除格子', value: 'empty' }])), row(button('map:manage:' + ref, '返回'))]);
    if (action === 'typepick') return payload('编辑格子 · 填写位置', X.cellTypes(m)[i.values[0]] || '删除格子', [row(button('map:coord:' + ref + ':' + i.values[0], '填写列与楼层'), button('map:manage:' + ref, '取消'))]);
    if (action === 'coordsubmit') {
      await tx(i, st => { const live = map(st, ref); ok(['draft', 'paused'].includes(live.status), '请暂停地图。');
        live.cellDrafts ||= {}; live.cellDrafts[uid] = { x: C.number(i.fields.getTextInputValue('x'), '列', 1, 20), y: C.number(i.fields.getTextInputValue('y'), '楼层', 1, 20), type: arg,passable:!['water','mountain','wall'].includes(arg), categoryId: live.categoryId, templateId: null, version: live.version };
        const d=live.cellDrafts[uid],old=live.cells[(d.x-1)+','+(d.y-1)];if(old?.type===d.type)Object.assign(d,C.clone(old),{version:live.version});
      }, '保存格子编辑草稿'); return cellDraft(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid);
    }
    if (action === 'celldraft') return cellDraft(s, m, uid);
    if (action === 'cellcategory' || action === 'cellroom') {
      const d = m.cellDrafts?.[uid]; ok(d, '重新填写格子坐标。');
      if (arg === 'pick') { await tx(i, st => { const d = map(st, ref).cellDrafts[uid];
        if (action === 'cellcategory') { d.categoryId = i.values[0]; d.templateId = null;d.variantId=null; } else {d.templateId = i.values[0];d.variantId=null;}
      }, '编辑格子选择'); return cellDraft(snapshot(i.guildId), map(snapshot(i.guildId), ref), uid); }
      const entries = Object.values(action === 'cellcategory' ? s.mapCategories : s.roomTemplates).filter(t => action === 'cellcategory' || t.categoryIds.includes(d.categoryId));
      return picker('选择' + (action === 'cellcategory' ? '大类' : '固定房间'), entries.map(t => ({ label: t.name, value: t.id })), action + ':' + ref, arg, [button('map:celldraft:' + ref, '返回编辑')]);
    }
    if(action==='celldescriptionsubmit'){await tx(i,st=>{const d=map(st,ref).cellDrafts?.[uid];ok(d,'草稿已失效。');d.name=C.text(i.fields.getTextInputValue('name'),'地点名称',80,true);d.description=C.text(i.fields.getTextInputValue('description'),'地点描述',2000,true);},'编辑地点描述');return cellDraft(snapshot(i.guildId),map(snapshot(i.guildId),ref),uid);}
    if(action==='cellpass'||action==='cellcontent'){await tx(i,st=>{const d=map(st,ref).cellDrafts?.[uid];ok(d,'草稿失效。');if(action==='cellpass')d.passable=d.passable===false;else d.hasContents=!d.hasContents;},'编辑地点设置');return cellDraft(snapshot(i.guildId),map(snapshot(i.guildId),ref),uid);}
    if(action==='cellbind'){const d=m.cellDrafts?.[uid];ok(d?.type==='building','选择建筑入口格。');if(arg==='pick'){await tx(i,st=>{const d=map(st,ref).cellDrafts[uid],target=st.explorations[i.values[0]];ok(target&&(target.mapType||'indoor')==='indoor'&&target.id!==ref,'地图类型已变化。');d.buildingMapId=target.id;},'绑定内部地图草稿');return cellDraft(snapshot(i.guildId),map(snapshot(i.guildId),ref),uid);}return picker('选择建筑内部地图',Object.values(s.explorations).filter(x=>(x.mapType||'indoor')==='indoor'&&x.status!=='ended').map(x=>({label:x.name,value:x.id})),'cellbind:'+ref,arg,[button('map:celldraft:'+ref,'返回格子草稿')]);}
    if (action === 'cellapply') { await tx(i, st => { const live = map(st, ref), d = live.cellDrafts?.[uid]; ok(d && d.version === live.version, '地图已有变更，请重新编辑格子。'); const cell=X.editCell(st,live,d.x,d.y,d.type,d.categoryId,d.templateId,d.variantId);if(d.type!=='empty'){Object.assign(live.cells[cell],{name:d.name||'',description:d.description||'',passable:d.passable!==false,hasContents:!!d.hasContents,buildingMapId:d.buildingMapId||null});if(d.hasContents&&live.status!=='draft'&&!live.cells[cell].room){const temp={...live,mode:live.mode};live.cells[cell].room=X.instantiate(st,X.selectRoom(st,temp,live.cells[cell]),require('node:crypto').randomInt,live.maxRank??10,d.variantId);}} live.generated = live.status === 'draft' ? false : live.generated; delete live.cellDrafts[uid]; }, '保存地图格子'); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'cellcancel') { await tx(i, st => { delete map(st, ref).cellDrafts?.[uid]; }, '取消格子编辑'); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'endpreview') return payload('确认结束探索', '保留地图和掉落记录，关闭玩家操作。', [row(button('map:end:' + ref + ':' + m.version, '确认结束', D.ButtonStyle.Danger), button('map:manage:' + ref, '取消'))]);
    if (['generate', 'publish', 'toggle', 'end'].includes(action)) {
      await tx(i, st => { const live = map(st, ref); ok(live.version === Number(arg), '地图已变化，请刷新。');
        if (action === 'generate') X.generate(st, live);
        if (action === 'publish') X.publish(st, live);
        if (action === 'toggle') { ok(['active', 'paused'].includes(live.status), '地图状态已变化。'); if (live.status === 'paused') { live.entrance = X.validateMap(live); live.revealed[live.entrance] = true; } live.status = live.status === 'paused' ? 'active' : 'paused'; live.version++; }
        if (action === 'end') {ok(!live.excursion&&!live.parentContext,'请先让队伍返回区域地图再结束探索。');ok(!Object.values(st.battles).some(b => b.exploration?.mapId === ref && b.status !== 'ended'), '先结束关联战斗。'); live.status = 'ended'; live.version++; }
      }, 'GM地图管理'); const next = map(snapshot(i.guildId), ref); if (next.status !== 'draft') await publish(i.guildId, ref); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref));
    }
    if (action === 'repost') { await publish(i.guildId, ref, true); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    if (action === 'gmroom') { if (arg === 'pick') return roomGM(s, m, i.values[0]);
      return picker('房间详情', Object.entries(m.cells).filter(([, c]) => c.room).map(([cell, c]) => ({ label: location(cell) + ' · ' + c.room.snapshot.name, value: cell })), 'gmroom:' + ref, arg, [button('map:manage:' + ref, '返回')]); }
    if (action === 'room') return roomGM(s, m, arg);
    if(action==='roomauto'){await tx(i,st=>{const live=map(st,ref),r=live.cells[arg]?.room;ok(r,'房间不存在。');ok(['draft','paused'].includes(live.status),'先暂停地图再切换遭遇方式。');r.autoStart=!(r.autoStart??r.snapshot.autoStart);live.version++;},'切换自动遭遇');return roomGM(snapshot(i.guildId),map(snapshot(i.guildId),ref),arg);}
    if (action === 'roster') {
      const r = m.cells[arg]?.room; ok(r?.encounter === 'pending', '遭遇已变化。');
      const players = Object.entries(m.participants).filter(([, p]) => p.cell === arg).map(([uid]) => ({ label: s.players[uid]?.name || uid, value: uid }));
      return payload('确认遭遇阵容', '选择同房间玩家，随后生成战斗招募；通过战斗GM面板正式开战。', [
        ...(players.length ? [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:encounter:' + ref + ':' + arg)
          .setPlaceholder('选择当前房间的参战玩家').setMinValues(1).setMaxValues(Math.min(19, players.length)))] : []), row(button('map:room:' + ref + ':' + arg, '返回房间'))
      ]);
    }
    if (action === 'encounter') { const b = await tx(i, st => X.encounter(st, map(st, ref), arg, i.values), 'GM确认房间战斗'); await publish(i.guildId, ref); await publishBattle(i.guildId, b.id); return gmUI.view(snapshot(i.guildId), snapshot(i.guildId).battles[b.id]); }
    if (action === 'resolve') { await tx(i, st => X.resolve(st, map(st, ref), arg), 'GM解除房间遭遇'); await publish(i.guildId, ref); return roomGM(snapshot(i.guildId), map(snapshot(i.guildId), ref), arg); }
    if (action === 'transferpick') { return picker('待领取容器', m.cells[arg]?.room?.containers.filter(c => c.status === 'pending').map(c => ({ label: c.box + ' · ' + c.batch.id, value: c.id })) || [], 'transferchoose:' + ref + ':' + arg, extra, [button('map:room:' + ref + ':' + arg, '返回房间')]); }
    if (action === 'transferchoose') {
      if (extra !== 'pick') return picker('待领取容器', m.cells[arg]?.room?.containers.filter(c => c.status === 'pending').map(c => ({ label: c.box, value: c.id })) || [], 'transferchoose:' + ref + ':' + arg, extra);
      return payload('转交原批次', '地图暂停时才能转交，接收者必须参加本地图。', [row(new D.UserSelectMenuBuilder().setCustomId('rpg:map:transfer:' + ref + ':' + arg + ':' + i.values[0])), row(button('map:room:' + ref + ':' + arg, '取消'))]);
    }
    if (action === 'transfer') { await tx(i, st => X.transfer(st, map(st, ref), arg, extra, i.values[0]), '转交原容器批次'); return roomGM(snapshot(i.guildId), map(snapshot(i.guildId), ref), arg); }
    if (action === 'players') {
      if (arg === 'pick') return payload('GM玩家调整', '<@' + i.values[0] + '>', [row(button('map:teleport:' + ref + ':' + i.values[0], '调整位置'), button('map:remove:' + ref + ':' + i.values[0], '移出探索'), button('map:manage:' + ref, '返回'))]);
      return picker('探索队员', Object.entries(m.participants).map(([uid, p]) => ({ label: (s.players[uid]?.name || uid) + ' · ' + place(m,p.cell), value: uid })), 'players:' + ref, arg, [button('map:manage:' + ref, '返回')]);
    }
    if (action === 'teleportsubmit' || action === 'remove') { await tx(i, st => { const live = map(st, ref); ok(live.status === 'paused', '先暂停地图。'); ok(live.participants[arg] && !M.battleFor(st, arg), '玩家不存在或仍在战斗。');
      if (action === 'remove') {delete live.participants[arg];require('./map-links').releaseEmpty(st,live);}
      else { const to = X.key(C.number(i.fields.getTextInputValue('x'), '列', 1, 20) - 1, C.number(i.fields.getTextInputValue('y'), '楼层', 1, 20) - 1), c = live.cells[to]; ok(c && c.type !== 'wall' && (!c.room || c.room.unlocked), '目标格不存在、是墙或房门未解锁。'); live.participants[arg].cell = to; live.revealed[to] = true; c.touched = true; }
      live.version++;
    }, 'GM调整探索队员'); await publish(i.guildId, ref); return manage(snapshot(i.guildId), map(snapshot(i.guildId), ref)); }
    throw new Error('地图操作已失效，请重新打开。');
  }
  function cellDraft(s, m, uid) {
    const d = m.cellDrafts?.[uid]; ok(d, '没有格子编辑草稿。');
    return payload('格子编辑预览', '第' + d.y + (m.mapType==='region'?'行':'层')+'，第' + d.x + '列 · ' + (X.cellTypes(m)[d.type] || '删除') + '\n大类：' + s.mapCategories[d.categoryId]?.name +
      '\n房间：' + (s.roomTemplates[d.templateId]?.name || '随机抽取（固定模式必须选择）')+'\n变种：'+(s.roomTemplates[d.templateId]?.variants?.find(v=>v.id===d.variantId)?.name||'按权重随机'), [
      ...(d.type === 'room'||d.hasContents ? [row(button('map:cellcategory:' + m.id + ':0', '选择大类'), button('map:cellroom:' + m.id + ':0', '指定房间'),button('map:cellvariant:'+m.id+':0','房间变种',undefined,!d.templateId))] : []),
      ...(d.type!=='empty'?[row(button('map:celldescription:'+m.id,'地点名称 / 描述'),button('map:cellpass:'+m.id,d.passable===false?'不可通行（切换）':'可通行（切换）'),button('map:cellcontent:'+m.id,d.hasContents?'地点内容：已启用':'启用地点内容'),...(d.type==='building'?[button('map:cellbind:'+m.id+':0','选择内部地图')]:[]))]:[]),
      row(button('map:cellapply:' + m.id, '确认保存', D.ButtonStyle.Success), button('map:cellcancel:' + m.id, '取消'), button('map:manage:' + m.id, '返回地图'))
    ]);
  }
  function roomGM(s, m, cell) {
    const r = m.cells[cell]?.room; ok(r, '房间不存在，请先生成。');
    return payload('GM房间 · ' + r.snapshot.name, '位置 ' + location(cell) + ' · 遭遇 ' + r.encounter + '\n' + r.snapshot.description +
      '\n\n本房间已生成NPC：' + ((r.npcs || r.snapshot.npcs).map(n => n.template.name + (n.template.spawnStrength?' · '+n.template.anomalyRank+'级 / Lv.'+n.template.spawnStrength.level:'')+' ×' + n.quantity).join('、') || '无') +
      (r.remainingNpcs?.length && r.battleId ? '\n待后续战斗NPC：'+r.remainingNpcs.map(n=>n.template.name+' ×'+n.quantity).join('、')+'（每场含玩家最多20名，结束本轮后继续）' : '') +
      '\n钥匙：' + (r.snapshot.keyIds.map(k => s.catalog[k]?.name || k).join('、') || '无需钥匙') +
      '\n容器：' + r.containers.map(c => c.box + ' · ' + c.status).join('、') + '\n物资：' + r.supplies.map(i => i.snapshot.name + ' ×' + i.quantity).join('、') +
      '\n随机生成记录：'+((r.randomResults || []).map(e=>(e.kind==='container' ? e.ref : [...(r.snapshot.randomSupplies || []),...(r.snapshot.randomNpcs || [])].find(t=>t.ref===e.ref)?.template?.name || e.ref)+' ×'+e.quantity).join('、') || '旧实例或未配置'), [
      row(button('map:roster:' + m.id + ':' + cell, '确认玩家 / 开战', D.ButtonStyle.Primary, r.encounter !== 'pending'),
        button('map:resolve:' + m.id + ':' + cell, r.remainingNpcs?.length && r.battleId ? '结束本轮 / 继续遭遇' : 'GM解除遭遇', undefined, r.encounter === 'resolved'), button('map:transferpick:' + m.id + ':' + cell + ':0', '转交待领取容器')),
      row(button('map:roomauto:'+m.id+':'+cell,(r.autoStart??r.snapshot.autoStart)?'自动开战：开启（切换）':'自动开战：关闭（切换）'),button('map:manage:' + m.id, '返回地图'))
    ]);
  }
  async function recover(guild) {
    for (const m of Object.values(snapshot(guild).explorations).filter(m => !['draft', 'ended'].includes(m.status))){await publish(guild, m.id).catch(e => logFailure('探索地图恢复失败。', e));
      const r=m.moves?.[m.moveRequestId];if(r)await publishMove(guild,m.id,r.id).catch(e=>logFailure('全队移动确认恢复失败，请GM核对发送记录。',e));}
  }
  return { config, home, manage, personal, component, openModal, publish, publishMove, publishCorpses, recover };
}
module.exports = { grid, board, moveCard, corpseView, createExploration };
