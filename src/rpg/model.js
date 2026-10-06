'use strict';
const C = require('./constants');
const Dur=require('./durability');
const W=require('./weapons');
const { randomInt } = require('node:crypto');
const { requireThat: ok, number: num, clone, id } = C;

function player(state, userId) {
  const p = state.players[userId];
  ok(p, '该成员尚未确认角色卡，请先 /建卡。');
  return p;
}
function newCharacter(name, attributes, adaptation = 1) {
  return { id: id('c'), name, attributes, adaptation, luck: 1, gender: null, age: null, ageVersion: 0, profile: {}, portraits: {}, allocationVersion: 0, profileVersion: 0, level: 1, xpCenti: 0, points: 2,
    hp: attributes.constitution * 3, balance: 0, inventory: {}, conditions: [], temporaryEffects: [], ap: 0,
    equipped: { weapon: null, offhand: null, armor: [], accessories: [], cards: [] },
    slots: { head: 1, body: 3, ring: 1, card: 5 }, tickets: { card: 0, boxes: {} }, pendingLoot: {}, checkSkills: {},
    faction: null, createdAt: Date.now() };
}
function rollCharacter(state, userId, name, reroll = false, rng = randomInt) {
  ok(!state.players[userId], '已有角色卡，重建需要GM销卡。');
  let draft = state.characterDrafts[userId];
  if (reroll) ok(draft && draft.rerolls < 3, '没有待确认角色，或已用完三次重掷。');
  else if (draft) return draft;
  const attributes = Object.fromEntries(Object.keys(C.ATTRIBUTES).map(k => [k, rng(1, 7)]));
  draft = { id: id('d'), userId, name: C.text(name || '未命名角色', '角色名', 50), attributes,
    gender: draft?.gender || null, age: draft?.age ?? null, profile: clone(draft?.profile || {}), adaptation: rng(1, 11), rerolls: reroll ? draft.rerolls + 1 : 0, at: Date.now() };
  state.characterDrafts[userId] = draft;
  return draft;
}
function confirmCharacter(state, userId) {
  ok(!state.players[userId] && state.characterDrafts[userId], '角色已确认，或没有待确认角色。');
  const d = state.characterDrafts[userId];
  ok(['male','female'].includes(d.gender), '请先下拉选择男性或女性。');
  const p = newCharacter(d.name, clone(d.attributes), d.adaptation);
  p.gender = d.gender; p.age = d.age ?? null; p.profile = clone(d.profile || {});
  p.userId = userId; p.initialRolls = clone(d);
  state.players[userId] = p;
  delete state.characterDrafts[userId];
  return p;
}
function equippedIds(p) {
  return [...W.equipped(p), ...p.equipped.armor, ...p.equipped.accessories, ...p.equipped.cards].filter(Boolean);
}
function isAttached(p, itemId) {
  return Object.values(p.inventory).some(i => (i.attachments || []).includes(itemId) || i.magazineId === itemId);
}
function sourceEffects(p) {
  const result = [];
  for (const itemId of equippedIds(p)) {
    const item = p.inventory[itemId];
    if (!item || !Dur.usable(item)) continue;
    result.push(...(item.snapshot.effects || []));
    for (const attachmentId of item.attachments || []) result.push(...(p.inventory[attachmentId]?.snapshot.effects || []));
    if (item.magazineId) result.push(...(p.inventory[item.magazineId]?.snapshot.effects || []));
  }
  for (const condition of p.conditions) result.push(...(condition.modifiers || []));
  for (const effect of p.temporaryEffects || []) {
    if (effect.duration.kind !== 'minutes' || effect.expiresAt > Date.now()) result.push(...effect.modifiers);
  }
  return result;
}
function modify(effects, target, base) {
  const selected = effects.filter(e => e.target === target);
  const flat = selected.filter(e => e.op !== 'percent').reduce((s, e) => s + e.value, 0);
  const percent = selected.filter(e => e.op === 'percent').reduce((s, e) => s + e.value, 0);
  return Math.max(0, (base + flat) * Math.max(0, 1 + percent / 100));
}
function signedModifier(effects, target, base = 0) {
  const selected = effects.filter(e => e.target === target);
  return (base + selected.filter(e => e.op !== 'percent').reduce((s, e) => s + e.value, 0)) *
    Math.max(0, 1 + selected.filter(e => e.op === 'percent').reduce((s, e) => s + e.value, 0) / 100);
}
function weight(p) {
  require('./ammunition').normalize(p);
  return Object.values(p.inventory).reduce((sum, item) => {
    const loaded = item.magazineStorage ? {} : (item.loaded || {});
    return sum + item.snapshot.weight * item.quantity + (loaded.rounds ? loaded.rounds.reduce((s, r) => s + r.weight, 0) :
      (loaded.weight || 0) * (loaded.current || 0));
  }, 0);
}
function stats(p, extraEffects = []) {
  const effects = [...sourceEffects(p), ...extraEffects];
  const attributes = Object.fromEntries(Object.entries(p.attributes)
    .map(([k, v]) => [k, Math.floor(modify(effects, 'attr:' + k, v))]));
  const defenses = Object.fromEntries(Object.keys(C.DAMAGE_TYPES).map(k => [k, 0]));
  for (const armorId of p.equipped.armor) {
    const item=p.inventory[armorId],armor = item&&Dur.usable(item)?item.snapshot:null;
    if (armor) for (const k of Object.keys(defenses)) defenses[k] += armor.defenses[k] || 0;
  }
  for (const k of Object.keys(defenses)) defenses[k] = modify(effects, 'defense:' + k, defenses[k]);
  const maxHP = Math.floor(modify(effects, 'hpMax', p.hpMaxOverride ?? attributes.constitution * 3));
  const carried = weight(p);
  const limit = (attributes.strength + attributes.constitution) * 500;
  const burdened = carried > limit / 2;
  const overloaded = carried > limit;
  const move = overloaded ? 0 : C.round2(modify(effects, 'move', Math.max(0, attributes.agility - (burdened ? 2 : 0)) * 3));
  const luck = Math.max(-9, Math.min(11, Math.floor(signedModifier(effects, 'attr:luck', p.luck ?? 1))));
  return { luck, attributes, defenses, maxHP, carried, limit, burdened, overloaded, move, effects,
    apGain: modify(effects, 'apGain', attributes.agility * 5),
    hit: modify(effects, 'hit', 0),
    resist: Object.fromEntries(Object.keys(C.DAMAGE_TYPES).map(k => [k, signedModifier(effects, 'resist:' + k)])) };
}
function syncHP(p) { p.hp = Math.max(0, Math.min(p.hp, stats(p).maxHP)); }
function expireEffects(p, now = Date.now()) {
  const expired = (p.temporaryEffects || []).filter(e => e.duration.kind === 'minutes' && e.expiresAt <= now);
  if (expired.length) { p.temporaryEffects = p.temporaryEffects.filter(e => !expired.includes(e)); syncHP(p); }
  return expired;
}
function finishEffects(p, turnId) {
  const expired = [];
  for (const e of p.temporaryEffects || []) if (e.duration.kind === 'actions') {
    if (e.skipTurnId && e.skipTurnId === turnId) { delete e.skipTurnId; continue; }
    if (--e.remaining <= 0) expired.push(e);
  }
  p.temporaryEffects = (p.temporaryEffects || []).filter(e => !expired.includes(e)); syncHP(p);
  return expired;
}
function allocate(state, userId, attribute, amount) {
  const p = player(state, userId);
  ok(battleFor(state, userId)?.status !== 'active', '加点前请GM暂停战斗。');
  ok(C.ATTRIBUTES[attribute], '属性无效。');
  amount = num(amount, '属性点', 1, 1000000);
  ok(p.points >= amount, '自由属性点不足。');
  const full = p.hp === stats(p).maxHP;
  p.points -= amount; p.attributes[attribute] += amount; p.allocationVersion = (p.allocationVersion || 0) + 1;
  if (full) p.hp = stats(p).maxHP;
  return p;
}
function grantXP(state, userId, amount) {
  const p = player(state, userId);
  amount = num(amount, '经验', 1, 1000000000);
  const credited = amount * (100 + 5 * (p.adaptation - 1));
  ok(Number.isSafeInteger(p.xpCenti + credited), '经验数值过大。');
  const before = p.level;
  p.xpCenti += credited;
  while (p.level < 100 && p.xpCenti >= p.level * 100000) {
    p.xpCenti -= p.level * 100000; p.level++;
  }
  const points = (Math.floor((p.level - 1) / 3) - Math.floor((before - 1) / 3)) * 2;
  p.points += points;
  return { credited: credited / 100, before, level: p.level, points };
}
function normalizeEffects(values = []) {
  ok(Array.isArray(values) && values.length <= 30, '效果最多30项。');
  return values.map(e => {
    ok(C.EFFECT_TARGETS.includes(e.target), '效果目标无效。');
    ok(['add', 'percent'].includes(e.op || 'add'), '效果运算无效。');
    return { target: e.target, op: e.op || 'add', value: num(e.value, '效果数值', -1000000, 1000000, false) };
  });
}
function validateTemplate(state, raw) {
  const t = clone(raw);
  ok(C.ITEM_KINDS.includes(t.kind), '物品种类无效。');
  t.name = C.text(t.name, '名称', 80);
  t.description = C.text(t.description || '', '描述', 2000, true);
  const r = C.RARITIES.find(r => r.id === t.rarity);
  ok(r, '请选择六色稀有度。');
  const kg = num(t.weightKg ?? (t.weight || 0) / 100, '重量kg', 0, 100000, false);
  ok(Math.abs(kg * 100 - Math.round(kg * 100)) < 0.000001, '重量最多两位小数。');
  t.weight = Math.round(kg * 100);
  delete t.weightKg;
  if(['武器','防具'].includes(t.kind))t.durabilityMax=num(t.durabilityMax??100,'最大耐久',1,1000000);
  if(t.kind==='武器'){t.armorWeakening||={type:'physical',amount:0};ok(C.DAMAGE_TYPES[t.armorWeakening.type],'请选择护甲削弱类型。');t.armorWeakening.amount=num(t.armorWeakening.amount??0,'护甲削弱',0,1000000);}
  if(t.kind==='防具')t.weakeningResistance=Object.fromEntries(Object.keys(C.DAMAGE_TYPES).map(k=>[k,num(t.weakeningResistance?.[k]||0,'抗削弱',0,1000000)]));
  if(t.kind==='修复道具'){t.repairKinds=[...new Set(t.repairKinds||[])];ok(t.repairKinds.length&&t.repairKinds.every(k=>['武器','防具'].includes(k)),'请选择可修复武器、防具或两者。');t.repairAmount=num(t.repairAmount,'修复点数',1,1000000);t.repairMaxLoss=num(t.repairMaxLoss??0,'削减耐久上限',0,1000000);}
  if (t.kind === '钥匙') t.keyCharges = num(t.keyCharges ?? 1, '钥匙次数', 0, 100000);
  t.value = num(t.value || 0, '参考价值', 0, C.MAX_MONEY);
  t.boxes = [...new Set(t.boxes || [])];
  ok(t.boxes.every(b => C.BOXES.includes(b)), '箱型无效。');
  t.traitIds = [...new Set(t.traitIds || [])];
  if (['武器', '防具', '饰品', '卡牌'].includes(t.kind)) ok(t.traitIds.length >= 1 && t.traitIds.length <= 10, '装备和卡牌须选择1至10个词条，可以选择“无附加效果”。');
  ok(t.traitIds.length <= 10, '最多10个词条。');
  for (const ref of t.traitIds) ok(state.traits[ref]?.published, '词条不存在或尚未发布：' + ref);
  t.ownEffects = normalizeEffects(t.effects || []);
  t.effects = [...t.traitIds.flatMap(ref => clone(state.traits[ref].effects || [])), ...t.ownEffects];
  if (['武器', '防具', '饰品'].includes(t.kind)) {
    ok(C.QUALITIES.includes(t.quality), '请选择十档品质。');
    ok(C.ORIGINS.includes(t.origin), '产地无效。');
    t.appearance = C.text(t.appearance || '', '外貌描述', 1000, true);
    t.title = C.text(t.title || '', '称号', 100, true);
    t.supernatural = Boolean(t.supernatural);
  }
  if(['武器','弹夹'].includes(t.kind)&&t.ammoIds?.length){ok(t.ammoIds.length<=25,'最多25种弹药。');for(const ref of t.ammoIds)ok(state.catalog[ref]?.published&&state.catalog[ref].kind==='弹药','弹药尚未发布。');t.ammoType=state.catalog[t.ammoIds[0]].ammoType;}
  if(t.kind==='武器'&&t.magazineIds?.length){ok(t.magazineIds.length<=25,'最多25种弹夹。');for(const ref of t.magazineIds){const mag=state.catalog[ref];ok(mag?.published&&mag.kind==='弹夹','弹夹尚未发布。');ok((t.ammoIds?.length?t.ammoIds.map(id=>state.catalog[id]):Object.values(state.catalog).filter(a=>a.kind==='弹药'&&a.ammoType===t.ammoType)).some(a=>require('./ammunition').ammoCompatible(mag,a)),'弹夹与所选弹药不兼容，没有交集。');}t.magazineType=state.catalog[t.magazineIds[0]].magazineType;}
  if (t.kind === '武器' || t.kind === '技能') {
    if (t.kind === '武器') {
      ok(C.WEAPON_TYPES.includes(t.weaponType), '武器类型无效。');
      t.handedness ||= 'auto';
      ok(['auto', 'one', 'two'].includes(t.handedness), '请选择自动分类、单手或双手武器。');
      if (t.weaponType === '其他') t.otherType = C.text(t.otherType, '其他类型', 80);
      t.melee = ![...C.FIREARMS, '弓', '弩', '法杖'].includes(t.weaponType) && t.melee !== false;
      if ([...C.FIREARMS, '弓', '弩'].includes(t.weaponType)) t.ammoType = C.text(t.ammoType, '弹药类型', 80);
      if ([...C.FIREARMS,'弩'].includes(t.weaponType)) {
        t.magazineType = C.text(t.magazineType, '弹夹类型', 80);
        t.capacity = num(t.capacity, '载弹上限', 1, 10000);
        t.current = num(t.current ?? t.capacity, '当前载弹', 0, t.capacity);
        t.fireModes=[...new Set(t.fireModes||['semi'])];ok(t.fireModes.length&&t.fireModes.every(m=>['semi','auto'].includes(m)),'请选择半自动或全自动模式。');
        const firstMagazine=t.magazineIds?.length?state.catalog[t.magazineIds[0]]:null;
        const ammo = t.ammoIds?.length ? t.ammoIds.map(ref=>state.catalog[ref]).find(a=>!firstMagazine||require('./ammunition').ammoCompatible(firstMagazine,a)) : Object.values(state.catalog).find(a => a.published && a.kind === '弹药' && a.ammoType === t.ammoType);
        ok(ammo, '请先录入对应弹药，用于载弹重量和装填。');
        t.ammoWeight = ammo.weight;
        t.initialAmmo = clone(ammo);
      }
    } else {
      ok(['quick', 'formal'].includes(t.action || 'formal'), '技能行动类型无效。');
      t.action ||= 'formal'; t.casting = num(t.casting || 0, '吟唱行动次数', 0, 100);
      if (t.casting > 0) t.action = 'formal';
    }
    t.hit = num(t.hit, '固定命中', 0, 1000000);
    t.rangeMeters = num(t.rangeMeters ?? (t.range ?? 1) * 50, '攻击距离（米）', 0, 500000, false);
    t.range = t.rangeMeters / 50;
    t.damage ||= {};
    const types = Object.keys(t.damage).filter(k => t.damage[k] !== '');
    ok(types.length && types.every(k => C.DAMAGE_TYPES[k]), '至少填写一种伤害。');
    for (const type of types) C.dice(t.damage[type], 'normal', (min) => min);
    t.primary = t.primary || types[0];
    ok(types.includes(t.primary), '主伤害必须是已填写的伤害类型。');
    t.conditions ||= [];
    for (const ref of t.conditions) ok(state.conditionTemplates[ref.id]?.published && state.conditionTemplates[ref.id]?.levels?.[ref.severity], '附带异常或等级未发布。');
    t.conditions = t.conditions.map(ref => ({ id: ref.id, severity: ref.severity, template: clone(state.conditionTemplates[ref.id]) }));
  }
  if (t.kind === '防具') {
    ok(C.ARMOR_COVERAGE[t.armorType], '防具类型无效。');
    t.defenses = Object.fromEntries(Object.keys(C.DAMAGE_TYPES).map(k => [k, num(t.defenses?.[k] || 0, '防御', 0, 1000000, false)]));
  }
  if (t.kind === '饰品') ok(C.ACCESSORY_LIMITS[t.accessoryType], '饰品类型无效。');
  if (t.kind === '卡牌') t.uniqueText = C.text(t.uniqueText || '', '独特效果', 2000, true);
  if (t.kind === '弹药' || t.kind === '弹夹') {
    t.ammoType = C.text(t.ammoType || t.name, '弹药类型', 80);
    if (t.kind === '弹夹') {
      t.magazineType = C.text(t.magazineType || t.name, '弹夹类型', 80);
      t.capacity = num(t.capacity, '容量', 1, 10000);
    }
  }
  if(t.kind==='弹药'){t.damage ||= {};for(const [type,expr] of Object.entries(t.damage)){ok(C.DAMAGE_TYPES[type],'附加伤害类型无效。');if(expr)ok(C.dice(expr,'normal',min=>min).total>=0,'弹药附加伤害不能为负数。');}t.conditions=(t.conditions||[]).map(ref=>{const condition=state.conditionTemplates[ref.id];ok(condition?.published&&condition.levels[ref.severity],'弹药附带异常或等级未发布。');return {id:ref.id,severity:ref.severity,template:clone(condition)};});}
  if (t.kind === '配件') {
    t.attachmentSlot = C.text(t.attachmentSlot, '配件位置', 50);
    t.compatible = [...new Set(t.compatible || [])];
    ok(t.compatible.length, '请填写兼容的武器或防具类型。');
  }
  if (t.kind === '特殊物品') {
    ok(['heart', 'tear'].includes(t.special), '特殊物品选择世界树之心或世界树之泪。');
    ok(!t.boxes.length, '世界树物品只能由GM发放，不能加入开箱掉落池。');
  }
  if (C.CONSUMABLES.includes(t.kind)) {
    t.heal = C.text(t.heal || '0', '恢复生命骰式', 50);
    ok(C.dice(t.heal, 'normal', min => min).total >= 0, '恢复生命不能为负数。');
    t.clearConditions ||= [];
    ok(t.clearConditions.length <= 10 && t.clearConditions.every(ref => state.conditionTemplates[ref]?.published), '解除异常需选择已发布模板，最多10项。');
    if (t.effects.length) {
      ok(['actions', 'minutes'].includes(t.duration?.kind), '持续效果需选择行动次数或实际分钟。');
      t.duration.count = num(t.duration.count, '持续时长', 1, 10000);
    }
  }
  t.preinstalled ||= [];
  for (const ref of t.preinstalled) ok(state.catalog[ref]?.kind === '配件' && state.catalog[ref].published, '初装配件未发布。');
  t.initialParts = t.preinstalled.map(ref => clone(state.catalog[ref]));
  const attachmentPositions = new Set();
  for (const part of t.initialParts) {
    ok(['武器', '防具'].includes(t.kind) && part.compatible.includes(t.weaponType || t.armorType), '初装配件不兼容此装备类型。');
    ok(!attachmentPositions.has(part.attachmentSlot), '初装配件位置重复。');
    attachmentPositions.add(part.attachmentSlot);
  }
  if (t.kind === '武器' && [...C.FIREARMS,'弩'].includes(t.weaponType)) {
    const magazine = t.magazineIds?.length ? state.catalog[t.magazineIds[0]] : Object.values(state.catalog).find(a => a.published && a.kind === '弹夹' &&
      a.magazineType === t.magazineType && a.ammoType === t.ammoType && a.capacity >= t.capacity);
    ok(magazine && require('./ammunition').ammoCompatible(magazine,t.initialAmmo), '请先发布兼容弹夹／箭匣。');ok(t.current<=magazine.capacity,'初始载弹不能超过初装弹夹容量。');
    t.initialMagazine = clone(magazine);
  }
  t.skillIds ||= [];
  for (const ref of t.skillIds) ok(state.catalog[ref]?.kind === '技能' && state.catalog[ref].published, '关联技能未发布。');
  t.skills = t.skillIds.map(ref => clone(state.catalog[ref]));
  return t;
}
function publishTemplate(state, raw, existingId) {
  const t = validateTemplate(state, raw);
  const previous = existingId ? state.catalog[existingId] : null;
  if (existingId) ok(previous, '待修改的模板不存在。');
  t.id = existingId || id('t'); t.version = (previous?.version || 0) + 1; t.published = true;
  state.catalog[t.id] = t;
  return t;
}
function makeItem(template, quantity = 1) {
  const item = { id: id('i'), templateId: template.id, version: template.version, snapshot: clone(template), quantity,
    attachments: [], ...(['武器','防具'].includes(template.kind)?{durability:template.durabilityMax??100}:{}), ...(require('./ammunition').usesMagazine(template)
      ? { loaded: { current: template.current, capacity: template.capacity, weight: template.ammoWeight, ammoType: template.ammoType,
        rounds: Array.from({ length: template.current || 0 }, () => require('./ammunition').round(template.initialAmmo || {weight:template.ammoWeight||0,ammoType:template.ammoType})) } } : {}) };
  if(template.kind==='弹夹')item.loaded=require('./ammunition').empty(template);
  if (template.kind === '钥匙') item.keyCharges = template.keyCharges;
  const parts = (template.initialParts || []).map(t => makeItem(t));
  item.attachments = parts.map(p => p.id);
  if (template.initialMagazine) {
    const magazine = makeItem(template.initialMagazine);
    item.magazineId = magazine.id;magazine.loaded=clone(item.loaded || require('./ammunition').empty(magazine.snapshot));magazine.loaded.capacity=magazine.snapshot.capacity;item.loaded=magazine.loaded;item.magazineStorage=true;parts.push(magazine);
  }
  if (parts.length) item.bundle = parts;
  return item;
}
function bundleItems(item) { return [item, ...(item.bundle || []).flatMap(bundleItems)]; }
function itemWeight(item) { return bundleItems(item).reduce((s, i) => s + i.snapshot.weight * i.quantity +
  (i.magazineStorage ? 0 : i.loaded?.rounds ? i.loaded.rounds.reduce((n, r) => n + r.weight, 0) : (i.loaded?.current || 0) * (i.loaded?.weight || 0)), 0); }
function activeOffer(offer, now = Date.now()) { return ['editing', 'ready'].includes(offer.status) && offer.expiresAt > now; }
function reserved(state, userId, excludedOffer) {
  const items = {}; let coins = 0;
  for (const offer of Object.values(state.offers)) {
    if (offer.id === excludedOffer || !activeOffer(offer)) continue;
    const side = offer.sides[userId];
    if (!side) continue;
    coins += side.coins;
    for (const selected of side.items) items[selected.id] = (items[selected.id] || 0) + selected.quantity;
  }
  return { items, coins };
}
function available(state, userId, itemId, excludedOffer) {
  const p = player(state, userId);
  return (p.inventory[itemId]?.quantity || 0) - (reserved(state, userId, excludedOffer).items[itemId] || 0);
}
function transferable(state, userId, itemId, quantity, excludedOffer) {
  const p = player(state, userId);
  const item = p.inventory[itemId];
  ok(item && !equippedIds(p).includes(itemId) && !isAttached(p, itemId), '物品不存在或正在装备／装配，请先卸下。');
  ok(!(item.attachments || []).length && !item.magazineId, '请先拆下配件和弹夹再转移。');
  ok(available(state, userId, itemId, excludedOffer) >= quantity, '物品数量不足或已被其他交易预留。');
  return item;
}
function receive(p, item) {
  const before = weight(p);
  const bundle = bundleItems(item);
  for (const part of bundle) { p.inventory[part.id] = part; delete part.bundle; }
  if (weight(p) > stats(p).limit && weight(p) > before) {
    for (const part of bundle) delete p.inventory[part.id];
    throw new Error('接收后会超重，请先 /丢弃 或转出物品。');
  }
}
function issue(state, userId, templateId, quantity = 1) {
  const p = player(state, userId); const template = state.catalog[templateId];
  ok(template?.published, '物品模板不存在或未发布。');
  quantity = num(quantity, '发放数量', 1, 100);
  const items = [];
  const stateful = ['武器', '防具', '饰品', '卡牌', '配件', '弹夹', '技能', '钥匙'].includes(template.kind);
  for (let n = 0; n < (stateful ? quantity : 1); n++) {
    const item = makeItem(template, stateful ? 1 : quantity);
    receive(p, item); items.push(item);
  }
  return items;
}
function openLoot(state, userId, box = 'card', rng = randomInt) {
  const p = player(state, userId);
  ok(box === 'card' || C.BOXES.includes(box), '箱型无效。');
  const count = box === 'card' ? p.tickets.card : (p.tickets.boxes[box] || 0);
  ok(count > 0, '没有对应次数，请找GM发放。');
  let batch = p.pendingLoot[box];
  if (batch && !batch.items) batch = { id: batch.id, items: [batch] };
  if (!batch) batch = require('./loot').generate(state, box, rng, stats(p).luck);
  p.pendingLoot[box] = batch;
  const result = { batchId: batch.id, box, luck: batch.luck ?? null, rates: clone(batch.rates ?? null), items: clone(batch.items), item: clone(batch.items[0]), pending: true };
  if (weight(p) + batch.items.reduce((sum, item) => sum + itemWeight(item), 0) > stats(p).limit) {
    return result;
  }
  for (const item of batch.items) receive(p, item);
  delete p.pendingLoot[box];
  if (box === 'card') p.tickets.card--; else p.tickets.boxes[box]--;
  result.pending = false; return result;
}
function drop(state, userId, itemId, quantity) {
  const p = player(state, userId);
  quantity = num(quantity, '丢弃数量', 1, 100000);
  const item = transferable(state, userId, itemId, quantity);
  item.quantity -= quantity;
  if (!item.quantity) delete p.inventory[itemId];
  return item.snapshot.name;
}
function battleFor(state, userId) {
  return Object.values(state.battles).find(b => b.status !== 'ended' && b.actors.some(a => a.userId === userId && !a.deathId && (!a.characterId || a.characterId === state.players[userId]?.id)));
}
function equip(state, userId, itemId, remove = false, hand = 'auto') {
  const p = player(state, userId); const item = p.inventory[itemId];
  ok(item && available(state, userId, itemId) >= 1 && !isAttached(p, itemId), '物品不存在、已预留或作为配件装配。');
  const t = item.snapshot;
  const battle = battleFor(state, userId);
  if (battle?.status === 'active') ok(t.kind === '武器', '防具、饰品、配件和卡牌调整需要GM暂停战斗。');
  return equipCharacter(p, itemId, remove, hand);
}
function equipCharacter(p, itemId, remove = false, hand = 'auto') {
  const item = p.inventory[itemId];
  ok(item && !isAttached(p, itemId), '物品不存在或正在装配。');
  const t = item.snapshot;
  if (t.kind === '武器') W.set(p, itemId, hand, remove);
  else {
    const slot = { '防具': 'armor', '饰品': 'accessories', '卡牌': 'cards' }[t.kind];
    ok(slot, '该物品不能装备，请使用相应操作。');
    const list = p.equipped[slot];
    if (remove) p.equipped[slot] = list.filter(x => x !== itemId);
    else if (!list.includes(itemId)) {
      if (slot === 'armor') {
        const occupied = list.flatMap(ref => C.ARMOR_COVERAGE[p.inventory[ref].snapshot.armorType]);
        ok(!C.ARMOR_COVERAGE[t.armorType].some(k => occupied.includes(k)), '防具槽位冲突，请先卸下冲突装备。');
      } else if (slot === 'cards') ok(list.length < p.slots.card, '生效卡牌槽位已满。');
      else ok(list.filter(ref => p.inventory[ref].snapshot.accessoryType === t.accessoryType).length < p.slots[t.accessoryType], '该饰品槽位已满。');
      list.push(itemId);
    }
  }
  syncHP(p);
  return t.name;
}
function attach(state, userId, equipmentId, attachmentId, remove = false) {
  const p = player(state, userId);
  ok(battleFor(state, userId)?.status !== 'active', '请先让GM暂停战斗，再调整配件。');
  if (!remove) ok(available(state, userId, attachmentId) >= 1 && available(state, userId, equipmentId) >= 1, '物品已被交易预留。');
  return attachCharacter(p, equipmentId, attachmentId, remove);
}
function attachCharacter(p, equipmentId, attachmentId, remove = false) {
  const equipment = p.inventory[equipmentId]; const attachment = p.inventory[attachmentId];
  ok(equipment && ['武器', '防具'].includes(equipment.snapshot.kind) && attachment?.snapshot.kind === '配件', '请选择武器／防具及配件。');
  if (remove) equipment.attachments = equipment.attachments.filter(x => x !== attachmentId);
  else {
    ok(!isAttached(p, attachmentId), '物品已装配。');
    ok(attachment.snapshot.compatible.includes(equipment.snapshot.weaponType || equipment.snapshot.armorType), '配件与装备类型不兼容。');
    ok(!equipment.attachments.some(ref => p.inventory[ref].snapshot.attachmentSlot === attachment.snapshot.attachmentSlot), '该配件位置已占用，请先拆下。');
    equipment.attachments.push(attachmentId);
  }
  syncHP(p);
}
function useSpecial(state, userId, itemId, slot) {
  const p = player(state, userId); const item = p.inventory[itemId];
  ok(battleFor(state, userId)?.status !== 'active', '调整槽位前请GM暂停战斗。');
  ok(item?.snapshot.kind === '特殊物品' && available(state, userId, itemId) > 0, '特殊物品不可用。');
  if (item.snapshot.special === 'tear') {
    ok(p.slots.card < 20, '卡牌槽位已达到20。'); p.slots.card++;
  } else {
    ok(C.ACCESSORY_LIMITS[slot], '请选择头部、身体或戒指。');
    ok(p.slots[slot] < C.ACCESSORY_LIMITS[slot][1], '该槽位已达到上限。'); p.slots[slot]++;
  }
  item.quantity--; if (!item.quantity) delete p.inventory[itemId];
  return p.slots;
}
function consume(p, itemId, rng = randomInt, turnId = null, now = Date.now()) {
  const item = p.inventory[itemId];
  ok(C.CONSUMABLES.includes(item?.snapshot.kind) && item.quantity > 0, '请选择食物、药品或消耗品。');
  expireEffects(p, now);
  const roll = C.dice(item.snapshot.heal || '0', 'normal', rng), before = p.hp;
  const cleared = p.conditions.filter(c => (item.snapshot.clearConditions || []).includes(c.templateId)).map(c => c.template.name);
  p.conditions = p.conditions.filter(c => !(item.snapshot.clearConditions || []).includes(c.templateId));
  const t = item.snapshot;
  if (t.effects?.length && t.duration) {
    ok(['actions', 'minutes'].includes(t.duration.kind), '持续时间无效。');
    const next = { id: id('v'), templateId: item.templateId, version: item.version, name: t.name,
      modifiers: clone(t.effects), duration: clone(t.duration), appliedAt: now,
      ...(t.duration.kind === 'minutes' ? { expiresAt: now + t.duration.count * 60000 } :
        { remaining: t.duration.count, ...(turnId ? { skipTurnId: turnId } : {}) }) };
    p.temporaryEffects = [...(p.temporaryEffects || []).filter(e => e.templateId !== item.templateId), next];
  }
  p.hp = Math.min(stats(p).maxHP, p.hp + Math.max(0, roll.total));
  item.quantity--; if (!item.quantity) delete p.inventory[itemId];
  syncHP(p);
  return { name: t.name, roll, healed: Math.max(0, p.hp - before), hpChange: p.hp - before, hp: p.hp, cleared,
    effects: clone(t.duration ? t.effects || [] : []), duration: clone(t.duration || null) };
}
function createOffer(state, creatorId, targetId, type = 'trade', itemId, quantity = 1, price = 0) {
  player(state, targetId);
  if (type === 'trade' || type === 'transfer') {
    player(state, creatorId); ok(creatorId !== targetId, '不能向自己交易或转账。');
  }
  const offer = { id: id('o'), creatorId, targetId, type, revision: 1, status: 'editing',
    expiresAt: Date.now() + C.OFFER_TTL, sides: {}, confirmations: {}, createdAt: Date.now() };
  if (type === 'buyback') {
    quantity = num(quantity, '数量', 1, 100000);
    transferable(state, targetId, itemId, quantity);
    offer.sides[targetId] = { items: [{ id: itemId, quantity }], coins: 0, supplied: true };
    offer.price = num(price, '收购总价', 0, C.MAX_MONEY); offer.status = 'ready';
  } else {
    offer.sides[creatorId] = { items: [], coins: 0, supplied: false };
    offer.sides[targetId] = { items: [], coins: 0, supplied: type === 'transfer' };
    if (type === 'transfer') {
      price = num(price, '转账金额', 1, C.MAX_MONEY);
      ok(player(state, creatorId).balance - reserved(state, creatorId).coins >= price, '可用余额不足。');
      offer.sides[creatorId] = { items: [], coins: price, supplied: true }; offer.status = 'ready';
    }
  }
  state.offers[offer.id] = offer;
  return offer;
}
function updateOffer(state, offerId, userId, items, coins) {
  const offer = state.offers[offerId];
  ok(offer?.type === 'trade' && activeOffer(offer) && offer.sides[userId], '交易已过期或你不是交易方。');
  coins = num(coins, '游戏币', 0, C.MAX_MONEY);
  ok(Array.isArray(items) && items.length <= 10, '每方最多10种物品。');
  ok(new Set(items.map(x => x.id)).size === items.length, '物品请合并数量后填写一次。');
  for (const selected of items) {
    selected.quantity = num(selected.quantity, '数量', 1, 100000);
    transferable(state, userId, selected.id, selected.quantity, offerId);
  }
  ok(player(state, userId).balance - reserved(state, userId, offerId).coins >= coins, '可用余额不足。');
  offer.sides[userId] = { items, coins, supplied: true }; offer.confirmations = {}; offer.revision++;
  offer.status = Object.values(offer.sides).every(s => s.supplied) ? 'ready' : 'editing';
  return offer;
}
function confirmOffer(state, offerId, userId, revision) {
  const offer = state.offers[offerId];
  ok(offer && activeOffer(offer) && offer.status === 'ready', '交易未完成报价或已结束。');
  ok(offer.revision === revision, '报价已变化，请重新查看后确认。');
  const participants = offer.type === 'buyback' ? [offer.targetId] : offer.type === 'transfer' ? [offer.creatorId] : [offer.creatorId, offer.targetId];
  ok(participants.includes(userId), '你不能确认该交易。');
  offer.confirmations[userId] = revision;
  if (!participants.every(uid => offer.confirmations[uid] === revision)) return { completed: false, offer };
  for (const [uid, side] of Object.entries(offer.sides)) {
    for (const entry of side.items) transferable(state, uid, entry.id, entry.quantity, offerId);
    ok(player(state, uid).balance - reserved(state, uid, offerId).coins >= side.coins, '交易方余额不足。');
  }
  if (offer.type === 'buyback') {
    const p = player(state, offer.targetId);
    ok(p.balance + offer.price <= C.MAX_MONEY, '余额达到上限。');
    for (const selected of offer.sides[offer.targetId].items) {
      const i = p.inventory[selected.id]; i.quantity -= selected.quantity; if (!i.quantity) delete p.inventory[selected.id];
    }
    p.balance += offer.price;
  } else {
    const a = player(state, offer.creatorId), b = player(state, offer.targetId);
    const beforeA = weight(a), beforeB = weight(b);
    const take = (p, side) => side.items.map(entry => {
      const source = p.inventory[entry.id];
      const part = clone(source); part.id = id('i'); part.quantity = entry.quantity;
      source.quantity -= entry.quantity; if (!source.quantity) delete p.inventory[entry.id];
      return part;
    });
    const toB = take(a, offer.sides[offer.creatorId]); const toA = take(b, offer.sides[offer.targetId]);
    for (const i of toA) a.inventory[i.id] = i;
    for (const i of toB) b.inventory[i.id] = i;
    ok(!toA.length || weight(a) <= stats(a).limit || weight(a) <= beforeA, '接收方超重，交易未执行。');
    ok(!toB.length || weight(b) <= stats(b).limit || weight(b) <= beforeB, '接收方超重，交易未执行。');
    const delta = offer.sides[offer.targetId].coins - offer.sides[offer.creatorId].coins;
    ok(a.balance + delta >= 0 && a.balance + delta <= C.MAX_MONEY && b.balance - delta >= 0 && b.balance - delta <= C.MAX_MONEY, '交易余额超过范围。');
    a.balance += delta; b.balance -= delta;
  }
  offer.status = 'completed'; offer.completedAt = Date.now();
  return { completed: true, offer };
}
function cancelOffer(state, offerId, userId, gm = false) {
  const offer = state.offers[offerId];
  ok(offer && ['editing', 'ready'].includes(offer.status), '交易已结束。');
  ok(gm || [offer.creatorId, offer.targetId].includes(userId), '你不能取消该交易。');
  offer.status = 'cancelled';
}
function expireOffers(state, now = Date.now()) {
  let changed = false;
  for (const offer of Object.values(state.offers)) if (['editing', 'ready'].includes(offer.status) && offer.expiresAt <= now) {
    offer.status = 'expired'; changed = true;
  }
  return changed;
}
function deleteCharacter(state, userId) {
  const battle = battleFor(state, userId);
  ok(!battle || ['recruiting', 'paused'].includes(battle.status), '请先暂停战斗，再销卡。');
  if (battle) {
    const actor = battle.actors.find(a => a.userId === userId);
    ok(!battle.pending?.attackerId && !battle.pending?.targetId, '请先完成待响应攻击。');
    battle.actors = battle.actors.filter(a => a !== actor);
    battle.queue = (battle.queue || []).filter(ref => ref.actorId !== actor.id);
    if (battle.current?.actorId === actor.id) battle.current = null;
  }
  for (const offer of Object.values(state.offers)) if (activeOffer(offer) && [offer.creatorId, offer.targetId].includes(userId)) offer.status = 'cancelled';
  delete state.players[userId]; delete state.characterDrafts[userId];
}

module.exports = { player, newCharacter, rollCharacter, confirmCharacter, equippedIds, isAttached, sourceEffects,
  modify, signedModifier, weight, stats, syncHP, allocate, grantXP, normalizeEffects, validateTemplate, publishTemplate, makeItem,
  activeOffer, reserved, available, transferable, receive, issue, openLoot, drop, battleFor, equip, attach, useSpecial,
  createOffer, updateOffer, confirmOffer, cancelOffer, expireOffers, deleteCharacter, bundleItems, itemWeight, equipCharacter, attachCharacter, consume, expireEffects, finishEffects };
