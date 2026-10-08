'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants'), M = require('./model'), B = require('./combat'), L = require('./loot');
const R = require('./room-settings');
const { requireThat: ok, number: num, clone, id } = C;
const TYPES = { room: '房间', corridor: '走廊', stairs: '楼梯', wall: '墙', entrance: '入口' };
const REGIONAL={road:'道路',wild:'野地',forest:'森林',ruins:'废墟',water:'水域',mountain:'山地',landmark:'地标',building:'建筑入口',entrance:'起点'};
const passable=c=>!!c&&c.type!=='wall'&&c.passable!==false;
const cellTypes=m=>m.mapType==='region'?REGIONAL:TYPES;
const key = (x, y) => x + ',' + y;
const xy = ref => ref.split(',').map(Number);
function quantities(text, refs, max = 100) {
  return R.quantities(text,refs,max);
}
function validateRoom(state, raw, skipVariants=false) {
  const r = clone(raw);
  r.autoStart=!!r.autoStart;r.spawn=Object.fromEntries(Object.entries({playerX:25,playerY:25,npcX:475,npcY:475}).map(([key,value])=>[key,num(r.spawn?.[key]??value,'出生位置',0,499.99,false)]));
  r.obstacles = require('./encounter-layout').validate(r.obstacles, r);
  r.name = C.text(r.name, '房间名称', 80); r.description = C.text(r.description || '', '房间描述', 2000, true);
  ok(r.categoryIds?.length && r.categoryIds.length<=25 && r.categoryIds.every(id=>state.mapCategories[id]?.published), '先选择已发布的兼容地图大类。');
  r.boxes ||= []; ok(r.boxes.every(b => C.BOXES.includes(b)), '容器类型无效。');
  r.boxCounts = quantities(r.containerCounts, r.boxes, 10);
  r.supplyIds ||= []; r.npcIds ||= []; r.keyIds ||= [];
  ok(r.keyIds.length <= 1 && r.keyIds.every(i => state.catalog[i]?.published && state.catalog[i].kind === '钥匙'), '请选择一把已发布钥匙。');
  ok(r.supplyIds.every(i => state.catalog[i]?.published && state.catalog[i].kind !== '技能'), '物资只能选择已发布实物。');
  ok(r.npcIds.every(i => state.npcTemplates[i]?.published), 'NPC模板不存在。');
  r.supplyCounts = quantities(r.supplyQuantities, r.supplyIds);
  r.npcCounts = quantities(r.npcQuantities, r.npcIds, 19);
  ok(Object.values(r.npcCounts).reduce((a, b) => a + b, 0) <= 19, '每房间NPC最多19名。');
  r.supplies = r.supplyIds.map(ref => ({ template: clone(state.catalog[ref]), quantity: r.supplyCounts[ref] }));
  r.npcs = r.npcIds.map(ref => ({ template: clone(state.npcTemplates[ref]), quantity: r.npcCounts[ref] }));
  r.randomContainers = R.validateEntries(state,r.randomContainers,'container');
  r.randomSupplies = R.validateEntries(state,r.randomSupplies,'supply');
  r.randomNpcs = R.validateEntries(state,r.randomNpcs,'npc');
  r.containerCounts=clone(r.boxCounts);r.supplyQuantities=clone(r.supplyCounts);r.npcQuantities=clone(r.npcCounts);
  if(!skipVariants){const V=require('./room-variants');r.variants=V.validate(raw.variants,r);for(const v of r.variants)validateRoom(state,V.merge(r,v),true);}
  return r;
}
function create(state, owner, channelId, name, floors, width, mode, categoryId,mapType='indoor') {
  ok(['indoor','region'].includes(mapType),'地图类型无效。');
  ok(['random', 'fixed'].includes(mode), '地图模式无效。');
  ok(state.mapCategories[categoryId]?.published, '先录入地图大类。');
  const m = { mapType,id: id('m'), owner, channelId, name: C.text(name, '地图名称', 80),
    floors: num(floors, '楼层', 1, 20), width: num(width, '每层格数', 1, 20), mode, categoryId,
    cells: {}, revealed: {}, participants: {}, status: 'draft', version: 1, createdAt: Date.now(), messageId: null };
  for (let y = 0; y < m.floors; y++) for (let x = 0; x < m.width; x++)
    m.cells[key(x, y)] = { type:mapType==='region'?(x===0&&y===0?'entrance':x===0||y===0?'road':'wild'):x === 0 ? (y === 0 ? 'entrance' : 'stairs') : x % 2 ? 'corridor' : 'room', categoryId };
  state.explorations[m.id] = m; return m;
}
function editable(m) { ok(['draft', 'paused'].includes(m.status), '修改布局前请暂停地图。'); }
function touched(m, ref) {
  const c = m.cells[ref];
  return !!(c?.touched || Object.values(m.participants).some(p => p.cell === ref));
}
function editCell(state, m, x, y, type, categoryId, templateId, variantId = null) {
  editable(m); x = num(x, '列', 1, 20) - 1; y = num(y, '楼层', 1, 20) - 1;
  ok(cellTypes(m)[type] || type === 'empty', '格子类型无效。'); const ref = key(x, y), old = m.cells[ref];
  ok(!old?.room?.boss,'请先通过BOSS配置移除尚未进入的BOSS房。');
  if(touched(m,ref)){ok(old.type===type&&old.categoryId===(categoryId||m.categoryId)&&(old.templateId||null)===(templateId||null),'该格有人或已有交互记录，不能替换或删除。');m.version++;return ref;}
  if (type === 'empty') delete m.cells[ref];
  else {
    const c = { type, categoryId: categoryId || m.categoryId, templateId: templateId || null, variantId:variantId||null };
    if (type === 'room') {
      ok(state.mapCategories[c.categoryId]?.published, '房间大类不存在。');
      if (c.templateId) ok(state.roomTemplates[c.templateId]?.categoryIds.includes(c.categoryId), '房间模板与大类不匹配。');
    }
    m.cells[ref] = c;
    if (m.status !== 'draft' && type === 'room') c.room = instantiate(state, selectRoom(state, m, c), randomInt,m.maxRank??10,c.variantId);
  }
  m.width = Math.max(m.width, x + 1); m.floors = Math.max(m.floors, y + 1); m.version++;
  if (old && m.status === 'draft') delete m.revealed[ref];
  return ref;
}
function neighbors(m, ref) {
  const [x, y] = xy(ref), c = m.cells[ref];
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].map(p => key(...p)).filter(to => {
    const next = m.cells[to]; if (!passable(next)) return false;
    if(m.mapType==='region')return true;
    const [, ny] = xy(to);
    return ny === y || (['stairs', 'entrance'].includes(c?.type) && ['stairs', 'entrance'].includes(next.type));
  });
}
function validateMap(m) {
  const entries = Object.entries(m.cells), starts = entries.filter(([, c]) => c.type === 'entrance');
  ok(starts.length === 1, '地图必须恰好有一个入口。');
  const seen = new Set([starts[0][0]]), queue = [...seen];
  for (const ref of queue) for (const n of neighbors(m, ref)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const unreachable = entries.filter(([ref, c]) => passable(c) && !seen.has(ref));
  ok(!unreachable.length, '存在不可达格子，请连接走廊或相邻楼层的楼梯：' + unreachable.slice(0, 12).map(([r]) => r).join('、'));
  return starts[0][0];
}
function selectRoom(state, m, c, rng = randomInt) {
  if (c.templateId) { const t = state.roomTemplates[c.templateId]; ok(t?.published, '房间模板不存在。'); return t; }
  ok(m.mode === 'random', '固定地图每个房间格都需要选择模板。');
  const pool = Object.values(state.roomTemplates).filter(r => r.published && !r.manualOnly && r.categoryIds.includes(c.categoryId));
  ok(pool.length, '该大类尚未录入房间。'); return pool[rng(0, pool.length)];
}
function instantiate(state, template, rng=randomInt, maxRank=10, fixedVariant=null) {
  if(template.variants?.length){const V=require('./room-variants'),variant=V.choose(template,rng,fixedVariant);const raw=V.merge(template,variant);raw.categoryIds=raw.categoryIds.filter(id=>state.mapCategories[id]?.published);raw.supplyIds=raw.supplyIds.filter(id=>state.catalog[id]?.published);raw.npcIds=raw.npcIds.filter(id=>state.npcTemplates[id]?.published);raw.randomSupplies=(raw.randomSupplies||[]).filter(e=>state.catalog[e.ref]?.published);raw.randomNpcs=(raw.randomNpcs||[]).filter(e=>state.npcTemplates[e.ref]?.published);template=validateRoom(state,raw,true);}
  const r = { id: id('r'), templateId: template.id, snapshot: clone(template), unlocked: !template.keyIds.length,
    encounter: 'resolved', containers: [], supplies: [], battleId: null, randomResults: [], npcs: clone(template.npcs) };
  const random = (list,kind) => (list || []).map(e=>{const quantity=R.draw(e.probabilities,rng);r.randomResults.push({kind,ref:e.ref,quantity,probabilities:clone(e.probabilities)});return {...e,quantity};});
  const containers = [...template.boxes.map(box=>({ref:box,quantity:template.boxCounts[box]})),...random(template.randomContainers,'container')];
  for (const entry of containers.filter(e=>require('./containers').get(state,e.ref)?.enabled!==false)) for (let n = 0; n < entry.quantity; n++)
    r.containers.push({ id: id('c'), box:entry.ref, status: 'unopened', batch: null, owner: null });
  for (const entry of [...template.supplies,...random(template.randomSupplies,'supply')].filter(e=>e.quantity>0)) {
    const stateful = ['武器', '防具', '饰品', '卡牌', '配件', '弹夹', '技能', '钥匙'].includes(entry.template.kind);
    for (let n = 0; n < (stateful ? entry.quantity : 1); n++) r.supplies.push(M.makeItem(entry.template, stateful ? 1 : entry.quantity));
  }
  r.npcs=r.npcs.filter(e=>require('./npc-strength').allowed(e.template,maxRank));
  r.npcs.push(...random((template.randomNpcs||[]).filter(e=>require('./npc-strength').allowed(e.template,maxRank)),'npc').filter(e=>e.quantity>0).map(e=>({template:clone(e.template),quantity:e.quantity})));
  r.npcs=r.npcs.flatMap(e=>e.template.randomStrength?Array.from({length:e.quantity},()=>({template:require('./npc-strength').freeze(e.template,rng),quantity:1})): [e]);
  r.remainingNpcs=clone(r.npcs);r.encounter=r.npcs.length ? 'pending' : 'resolved';
  return r;
}
function generate(state, m, rng = randomInt) {
  ok(m.status === 'draft', '已发布地图不能重新随机生成。'); validateMap(m);
  for (const c of Object.values(m.cells)) if ((c.type === 'room'||c.hasContents) && !c.room?.boss) c.room = instantiate(state, selectRoom(state, m, c, rng), rng,m.maxRank??10,c.variantId);
  m.generated = true; m.version++; return m;
}
function publish(state, m) {
  ok(m.status === 'draft', '地图已经发布。');
  ok(!Object.values(state.explorations).some(x => x.id !== m.id && x.channelId === m.channelId && !['draft', 'ended'].includes(x.status)), '当前频道已有探索地图。');
  const entrance = validateMap(m); ok(m.generated && Object.values(m.cells).filter(c => c.type === 'room'||c.hasContents).every(c => c.room), '先生成并预览全部房间。');
  m.entrance = entrance; m.revealed[entrance] = true; m.status = 'active'; m.version++;
}
function join(state, m, uid) {
  ok(m.status === 'active', '地图尚未开放或已暂停。'); const p = M.player(state, uid); ok(p.hp > 0, '死亡角色不能参加探索。');
  ok(!Object.values(state.explorations).some(x => x.id !== m.id && x.status !== 'ended' && x.participants[uid]), '已参加另一张探索地图。');
  ok(!M.battleFor(state, uid), '参战期间不能参加探索。');
  ok(!m.excursion&&(!m.parentContext||m.participants[uid]),'队伍正在建筑内部，暂时不能追加报名。');
  if (m.participants[uid]) { ok(m.participants[uid].characterId === p.id, '角色已经变化，请GM移除原报名。'); return; }
  m.participants[uid] = { characterId: p.id, cell: m.entrance }; m.version++;
}
function participant(state, m, uid) {
  const p = M.player(state, uid), part = m.participants[uid];
  ok(part && part.characterId === p.id && p.hp > 0, '先用当前角色参加地图。');
  ok(m.status === 'active', '地图已暂停或结束。'); ok(!M.battleFor(state, uid), '参战期间不能移动或领取探索物资。');
  return { p, part };
}
function move(state, m, uid, to, keyId) {
  const { p, part } = participant(state, m, uid); ok(!M.stats(p).overloaded, '超重无法移动。');
  require('./rp').check(m);
  const origin = m.cells[part.cell]; ok(!origin?.room || origin.room.encounter === 'resolved', '请先由GM处理当前房间遭遇。');
  ok(neighbors(m, part.cell).includes(to), '只能走向相邻格，上下楼需连接楼梯。');
  const c = m.cells[to];
  if (c.room && !c.room.unlocked) {
    const required = c.room.snapshot.keyIds[0], item = p.inventory[keyId];
    ok(item?.snapshot.kind === '钥匙' && item.templateId === required && item.keyCharges > 0 && M.available(state, uid, keyId) > 0, '需要匹配且未被交易预留的钥匙。');
    item.keyCharges--; c.room.unlocked = true;
  }
  part.cell = to; require('./rp').enter(state,m,to); c.touched = true; m.revealed[to] = true; m.version++;
  return c.room?.encounter === 'pending';
}
function currentRoom(state, m, uid) {
  require('./rp').check(m);
  const { p, part } = participant(state, m, uid), c = m.cells[part.cell];
  ok(c?.room && c.room.unlocked && c.room.encounter === 'resolved', '房间尚未解锁或遭遇尚未解除。');
  c.touched = true; return { p, r: c.room, cell: part.cell };
}
function open(state, m, uid, ref, rng = randomInt) {
  const { p, r, cell } = currentRoom(state, m, uid), c = r.containers.find(c => c.id === ref);
  ok(c && c.status !== 'claimed', '容器已经领取。');
  if (!c.batch) { c.batch = L.generate(state, c.box, rng, M.stats(p).luck,true); c.owner = { userId: uid, characterId: p.id }; c.status = 'pending'; }
  ok(c.owner.userId === uid && c.owner.characterId === p.id, '原批次已绑定开启者，需GM转交。');
  const result = { batchId: c.batch.id, box: c.box, luck: c.batch.luck ?? null, rates: clone(c.batch.rates ?? null), items: clone(c.batch.items), item: clone(c.batch.items[0]), pending: true, free: true };
  if (M.weight(p) + c.batch.items.reduce((n, i) => n + M.itemWeight(i), 0) <= M.stats(p).limit) {
    for (const item of c.batch.items) M.receive(p, clone(item)); c.status = 'claimed'; result.pending = false;
  }
  let publication = Object.values(state.lootPublications).find(x => x.result?.batchId === c.batch.id);
  if (!publication) publication = { id: id('l'), userId: uid, channelId: m.channelId, at: Date.now(), publication: { status: 'pending' } };
  publication.userId = uid; publication.result = result; state.lootPublications[publication.id] = publication;
  m.version++; return { publicationId: publication.id, result, cell };
}
function take(state, m, uid, ref) {
  const { p, r } = currentRoom(state, m, uid), item = r.supplies.find(i => i.id === ref);
  ok(item, '该物资已被领取。'); M.receive(p, clone(item)); r.supplies = r.supplies.filter(i => i.id !== ref); m.version++; return clone(item);
}
function transfer(state, m, cell, containerId, uid) {
  editable(m); const p = M.player(state, uid), c = m.cells[cell]?.room?.containers.find(x => x.id === containerId);
  ok(c?.status === 'pending' && m.participants[uid]?.characterId === p.id, '选择待领取容器及本地图有效玩家。');
  c.owner = { userId: uid, characterId: p.id }; m.version++;
}
function encounter(state, m, ref, users, rng = randomInt, approval = null) {
  require('./rp').check(m);
  ok(m.status === 'active', '恢复地图后才能开始遭遇。'); const c = m.cells[ref];
  ok(c?.room?.encounter === 'pending' && m.revealed[ref], '房间没有待处理遭遇。');
  ok(users.length && users.every(uid => m.participants[uid]?.cell === ref && state.players[uid]?.id === m.participants[uid].characterId), '请选择在该房间且有有效角色的玩家。');
  if(c.room.boss)require('./boss').authorized(state,m,ref,approval);
  const remaining=c.room.remainingNpcs || clone(c.room.snapshot.npcs), slots=20-users.length;
  ok(slots>0,'每场最多20名参战者，请为NPC预留位置。');
  const Layout = require('./encounter-layout'), layout = Layout.validateLayout(c.room.tacticalLayout || Layout.generate(c.room.snapshot, rng));
  const b = B.createBattle(state, m.channelId, m.owner, m.name + ' · ' + c.room.snapshot.name, layout.width, layout.height);
  b.terrain = clone(layout.terrain); b.roomObstacles = clone(layout.obstacles); b.environment = c.room.snapshot.description;
  for (const uid of users) B.join(state, b, uid);
  let capacity=slots;
  for (const entry of remaining) {const count=Math.min(capacity,entry.quantity);for(let n=0;n<count;n++)B.addNPC(state,b,entry.template.id,'enemy',entry.template);entry.quantity-=count;capacity-=count;}
  Layout.place(b, rng, !!layout.legacy); c.room.tacticalLayout = clone(layout);
  c.room.remainingNpcs=remaining.filter(e=>e.quantity>0);
  b.exploration = { mapId: m.id, cell: ref }; c.room.battleId = b.id; c.room.encounter = 'battle'; c.touched = true; m.version++;
  return b;
}
function resolve(state, m, ref) {
  const r = m.cells[ref]?.room; ok(r && r.encounter !== 'resolved', '遭遇已经解除。');
  ok(!r.battleId || state.battles[r.battleId]?.status === 'ended', '先结束关联战斗。');
  if(r.boss)ok(r.battleId&&state.battles[r.battleId]?.outcome==='victory','BOSS房须实际获胜后才能解除遭遇。');
  if(r.battleId && r.remainingNpcs?.length) {r.encounter='pending';r.battleId=null;} else r.encounter = 'resolved';
  m.cells[ref].touched = true; m.version++;
}
module.exports = { TYPES, REGIONAL,passable,cellTypes,key, xy, quantities, validateRoom, create, editCell, neighbors, validateMap,selectRoom,instantiate,generate, publish,
  join, participant, move, currentRoom, open, take, transfer, encounter, resolve, touched };
