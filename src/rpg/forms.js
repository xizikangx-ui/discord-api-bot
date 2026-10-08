'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), U = require('./ui');
const R = require('./room-settings');
const Categories = require('./item-categories');
const { requireThat: ok } = C;
const get = (data, path) => path.split('.').reduce((v, k) => v?.[k], data);
function set(data, path, value) {
  const parts = path.split('.'); let object = data;
  for (const part of parts.slice(0, -1)) object = object[part] ||= {};
  object[parts.at(-1)] = value;
}
const field = (key, label, type = 'text', values, max) => ({ key, label, type, values, max });
const enumField = (key, label, values) => field(key, label, 'choice', values);
const refField = (key, label, source, limit = 10, predicate) => ({ key, label, type: 'refs', source, limit, predicate });
function defaults(kind, itemKind = '杂物') {
  if (kind === 'checkskill') return { name: '', level: 1 };
  if (kind === 'skill') return {...defaults('item','技能'),requiresWeapon:false,melee:false,weaponType:'',aoe:{mode:'single',radius:0,allowAlly:false,allowSelf:false}};
  if (kind === 'item') return { kind: itemKind, name: '', description: '', rarity: 'white', weightKg: 0, value: 0,
    durabilityMax:100, armorWeakening:{type:'physical',amount:0}, weakeningResistance:{physical:0,magical:0,mental:0},repairKinds:['武器','防具'],repairAmount:10,repairMaxLoss:0, quality: '标准', origin: '未知', title: '', appearance: '', supernatural: false, traitIds: ['neutral'], effects: [], boxes: [],
    weaponType: '剑', handedness: 'auto', otherType: '', melee: true, ammoType: '', magazineType: '', capacity: 1, current: 0,
    ammoIds: [], magazineIds: [], fireModes: ['semi'], hit: 10, rangeMeters: 50, primary: 'physical', damage: { physical: itemKind==='弹药'?'0':'1d6', magical: '', mental: '' }, conditions: [],
    armorType: '胸甲', defenses: { physical: 0, magical: 0, mental: 0 }, accessoryType: 'body',
    uniqueText: '', skillIds: [], preinstalled: [], compatible: [], attachmentSlot: '瞄具',
    special: 'heart', keyCharges: 1, heal: '0', clearConditions: [], duration: { kind: 'actions', count: 3 }, action: 'formal', casting: 0 };
  if (kind === 'trait') return { name: '', description: '', effects: [] };
  if (kind === 'condition') return { name: '', description: '', type: 'physical', effectType: 'numeric',
    levels: Object.fromEntries(C.SEVERITIES.map(s => [s, { enabled: s === '一般', difficulty: 10,
      duration: { kind: 'actions', count: 3 }, worsenAfter: 0, description: '', effects: [] }])) };
  if (kind === 'mapcategory') return { name: '', description: '' };
  if (kind === 'room') return { name: '', description: '', categoryIds: [], boxes: [], containerCounts: {}, supplyIds: [], supplyQuantities: {}, npcIds: [], npcQuantities: {}, keyIds: [], autoStart: true, spawn: {playerX:25,playerY:25,npcX:475,npcY:475}, obstacles: require('./encounter-layout').defaults(), randomContainers: [], randomSupplies: [], randomNpcs: [] };
  if (kind === 'npc') return { humanoid: false, baseXP: 0, name: '', description: '', attributes: Object.fromEntries(Object.keys(C.ATTRIBUTES).map(k => [k, 3])),
    hpMax: 9, itemIds: [], quantities: {}, equipmentPreset: [], ai: require('./npc-auto').config() };
  return { title: '领取玩家身份组', description: '选择身份组后领取。', roleIds: [], exclusive: false, allowCancel: true, labels: {} };
}
function fields(form) {
  const kind = form.kind, d = form.data;
  const common = [field('name', '名称'), field('description', '描述', 'long'),field('enabled','允许生成 / 发放','bool')];
  if (kind === 'checkskill') return [field('name', '技能名称'), field('level', '初始等级', 'number')];
  const aoeFields=[enumField('aoe.mode','目标模式',[{value:'single',label:'单体'},{value:'selective',label:'选择性圆形AOE'},{value:'all',label:'无差别圆形AOE'}]),field('aoe.radius','AOE半径（米）','number'),field('aoe.allowAlly','选择性AOE允许友军','bool'),field('aoe.allowSelf','选择性AOE允许自身','bool')];
  if(kind==='skill')return [...common,field('hit','固定命中','number'),field('damage.physical','物理伤害骰式'),field('damage.magical','魔法伤害骰式'),field('damage.mental','精神伤害骰式'),field('rangeMeters','攻击距离（米）','number'),enumField('primary','主伤害类型',Object.entries(C.DAMAGE_TYPES).map(([value,label])=>({value,label}))),enumField('action','行动类型',[{value:'formal',label:'正式'},{value:'quick',label:'快速'}]),field('casting','吟唱次数（0瞬发）','number'),field('requiresWeapon','是否要求可用武器','bool'),field('conditions','附带异常','conditions'),...aoeFields];
  if (kind === 'trait') return [...common, field('effects', '结构化数值效果', 'effects')];
  if (kind === 'condition') {
    const list = [...common, enumField('type', '异常类型', Object.entries(C.DAMAGE_TYPES).map(([value, label]) => ({ value, label }))),
      enumField('effectType', '数值或文本', [{ value: 'numeric', label: '数值扣除' }, { value: 'text', label: '仅文本记录' }])];
    for (const s of C.SEVERITIES) {
      const prefix = 'levels.' + s + '.';
      list.push(field(prefix + 'enabled', s + '级是否启用', 'bool'), field(prefix + 'difficulty', s + '级豁免难度', 'number'),
        enumField(prefix + 'duration.kind', s + '级持续类型', [{ value: 'actions', label: '自身行动机会' }, { value: 'battle', label: '一场战斗' }, { value: 'until', label: '直到解除' }]),
        field(prefix + 'duration.count', s + '级持续行动次数', 'number'), field(prefix + 'worsenAfter', s + '级恶化次数（0关闭）', 'number'),
        field(prefix + 'description', s + '级效果描述', 'long'), field(prefix + 'effects', s + '级扣除效果', 'conditionEffects'));
    }
    return list;
  }
  if (kind === 'mapcategory') return [...common,{...enumField('mapTypes','适用地图类型',[{value:'indoor',label:'建筑内部'},{value:'region',label:'区域地图'}]),type:'multi',limit:2}];
  if (kind === 'room') return [...common, refField('categoryIds', '兼容地图大类（可多选）', 'mapCategories', 25),field('autoStart','全队进入后自动开战','bool'),field('obstacles.names','障碍名称池（顿号分隔）','long'),field('obstacles.min','最少障碍数（0—3）','number'),field('obstacles.max','最多障碍数（0—3，按面积限制）','number'),enumField('obstacles.terrain','障碍地形',[{value:'blocked',label:'阻挡（不能通过）'},{value:'difficult',label:'困难（双倍移动消耗）'}]),
    {...enumField('boxes', '固定容器类型', C.BOXES), type: 'multi', limit: 52}, {key:'containerCounts',label:'固定容器数量（下拉选择）',type:'fixedRoom',source:'boxes',refs:'boxes',max:10},
    refField('supplyIds', '固定物资', 'catalog', 25, t => t.kind !== '技能'), {key:'supplyQuantities',label:'固定物资数量（下拉选择）',type:'fixedRoom',source:'catalog',refs:'supplyIds',max:100},
    refField('npcIds', '固定NPC', 'npcTemplates', 19), {key:'npcQuantities',label:'固定NPC数量（下拉选择）',type:'fixedRoom',source:'npcTemplates',refs:'npcIds',max:19},
    refField('keyIds', '入门钥匙（留空免费）', 'catalog', 1, t => t.kind === '钥匙'),
    {key:'randomContainers',label:'随机容器 · 0—6个概率',type:'randomRoom',source:'boxes',max:6,limit:52},
    {key:'randomSupplies',label:'随机散落物资 · 0—6件概率',type:'randomRoom',source:'catalog',max:6,limit:25,predicate:t=>t.kind!=='技能'},
    {key:'randomNpcs',label:'随机NPC · 0—10个概率',type:'randomRoom',source:'npcTemplates',max:10,limit:25},...(form.variantParent?[]:[field('variants','十种环境变种','variants')])];
  if (kind === 'npc') return [...common, field('humanoid', '人形NPC（死亡掉落实物）', 'bool'), field('baseXP', '基础击杀经验（默认0）', 'number'),enumField('anomalyRank','异常等级',require('./npc-strength').LEVELS),field('randomStrength','随机等级强度','bool'),field('levelMin','生成最低等级','number'),field('levelMax','生成最高等级','number'), ...Object.entries(C.ATTRIBUTES).map(([k, n]) => field('attributes.' + k, n, 'number')),
    field('hpMax', '生命上限', 'number'), refField('itemIds', '随身实物（装备另设槽位）', 'catalog', 25,t=>!['技能','杂物'].includes(t.kind)),refField('skillIds','NPC战斗技能','skillTemplates',25),
    {key:'quantities',label:'初始物品数量（下拉选择）',type:'fixedRoom',source:'catalog',refs:'itemIds',max:100}];
  if (kind === 'rolepanel') return [field('title', '面板标题'), field('description', '面板说明', 'long'),
    field('roleIds', '领取身份组', 'roles'), field('exclusive', '互斥单选', 'bool'), field('allowCancel', '允许取消领取', 'bool'),
    field('labels', '自定义领取标签（选择身份组）', 'roleLabels')];
  const list = [...common, enumField('rarity', '六色稀有度', C.RARITIES.map(r => ({ value: r.id, label: r.name }))),
    field('weightKg', '重量kg（两位小数）', 'number'), field('value', '参考价值', 'number'),
    { ...enumField('boxes', '可从哪些箱型抽出', C.BOXES), type: 'multi', limit: 52 }];
  if (['武器', '技能'].includes(d.kind)) list.push(field('rangeMeters', '射程 / 攻击距离（米）', 'number'));
  if(d.kind==='武器')list.push(...aoeFields);
  if (d.kind === '武器') list.push(enumField('handedness', '单手 / 双手（可手动调整）', [
    { value: 'auto', label: '按武器类型自动分类' }, { value: 'one', label: '单手武器' }, { value: 'two', label: '双手武器' }]));
  if(['武器','防具'].includes(d.kind))list.push(field('durabilityMax','最大耐久','number'));
  if(d.kind==='修复道具')list.push({...enumField('repairKinds','可修复类型',['武器','防具']),type:'multi',limit:2},field('repairAmount','每次修复耐久点数','number'),field('repairMaxLoss','每次修复削减耐久上限（0不削减）','number'));
  if (d.kind === '钥匙') list.push(field('keyCharges', '初始钥匙次数', 'number'));
  if (['武器', '防具', '饰品', '卡牌'].includes(d.kind)) list.push(refField('traitIds', '词条（1至10）', 'traits'));
  list.push(field('effects', C.CONSUMABLES.includes(d.kind) ? '使用后的持续增减益' : '额外结构化数值效果', 'effects'));
  if (['武器', '防具', '饰品'].includes(d.kind)) list.push(enumField('quality', '装备品质', C.QUALITIES),
    field('title', '可选称号'), field('supernatural', '超凡装备', 'bool'), field('appearance', '外貌', 'long'), enumField('origin', '产地', C.ORIGINS),
    refField('preinstalled', '初装配件', 'catalog', 10, t => t.kind === '配件'));
  if (d.kind === '武器') list.push(enumField('weaponType', '武器类型', C.WEAPON_TYPES), field('otherType', '其他类型说明'),
    refField('ammoIds', '选择兼容弹药（可多选）', 'catalog', 25, t=>t.kind==='弹药'), refField('magazineIds', '选择兼容弹夹／箭匣（可多选）', 'catalog', 25, t=>t.kind==='弹夹'), {...enumField('fireModes','射击模式',['semi','auto'].map(value=>({value,label:value==='semi'?'半自动（单发）':'全自动（连射）'}))),type:'multi',limit:2}, field('capacity', '载弹上限', 'number'), field('current', '初始载弹', 'number'));
  if(d.kind==='武器')list.push(enumField('armorWeakening.type','护甲削弱类型',Object.entries(C.DAMAGE_TYPES).map(([value,label])=>({value,label}))),field('armorWeakening.amount','护甲削弱点数（每发／击，0关闭）','number'));
  if(d.kind==='防具')list.push(...Object.entries(C.DAMAGE_TYPES).map(([k,n])=>field('weakeningResistance.'+k,n+'抗削弱点数','number')));
  if (d.kind === '武器' && d.weaponType === '其他') list.push(field('melee', '其他类型是否近战（否则远程）', 'bool'));
  if (d.kind === '武器' || d.kind === '技能') {
    list.push(field('hit', '固定命中', 'number'),
      field('damage.physical', '物理伤害骰式（留空无）'), field('damage.magical', '魔法伤害骰式（留空无）'),
      field('damage.mental', '精神伤害骰式（留空无）'),
      enumField('primary', '主伤害分量', Object.entries(C.DAMAGE_TYPES).map(([value, label]) => ({ value, label }))),
      field('conditions', '附带异常及等级', 'conditions'));
  }
  if (d.kind === '技能') list.push(enumField('action', '使用行动类型', [{ value: 'quick', label: '快速' }, { value: 'formal', label: '正式' }]), field('casting', '吟唱次数（0瞬发）', 'number'));
  if (d.kind === '防具') list.push(enumField('armorType', '覆盖部位', Object.keys(C.ARMOR_COVERAGE)),
    ...Object.entries(C.DAMAGE_TYPES).map(([k, n]) => field('defenses.' + k, n + '防御', 'number')));
  if (d.kind === '饰品') list.push(enumField('accessoryType', '饰品位置', Object.entries(C.ACCESSORY_NAMES).map(([value, label]) => ({ value, label }))));
  if (d.kind === '卡牌') list.push(field('uniqueText', '独特效果说明', 'long'), refField('skillIds', '关联战斗技能', 'skillTemplates', 10));
  if(d.kind==='弹药')list.push(field('damage.physical','物理附加伤害（固定值或骰式）'),field('damage.magical','魔法附加伤害（留空无）'),field('damage.mental','精神附加伤害（留空无）'),field('conditions','赋予异常及等级','conditions'));
  if(d.kind==='弹夹')list.push(refField('ammoIds','选择兼容弹药（可多选）','catalog',25,t=>t.kind==='弹药'));
  if (d.kind === '弹夹') list.push(field('capacity', '装弹量', 'number'));
  if (d.kind === '配件') list.push(field('attachmentSlot', '装配位置名称'),
    { ...enumField('compatible', '兼容类型', [...C.WEAPON_TYPES, ...Object.keys(C.ARMOR_COVERAGE)]), type: 'multi', limit: 25 });
  if (d.kind === '特殊物品') list.push(enumField('special', '世界树物品', [{ value: 'heart', label: '世界树之心' }, { value: 'tear', label: '世界树之泪' }]));
  if (C.CONSUMABLES.includes(d.kind)) list.push(field('heal', '恢复生命固定值或骰式'), refField('clearConditions', '可解除异常', 'conditionTemplates', 10),
    enumField('duration.kind', '持续效果时间单位', [{ value: 'actions', label: '自身行动次数' }, { value: 'minutes', label: '实际分钟' }]),
    field('duration.count', '持续时长（正整数）', 'number'));
  return list;
}
function create(state, owner, kind, itemKind, existingId) {
  const source = { skill: 'skillTemplates', item: 'catalog', trait: 'traits', condition: 'conditionTemplates', npc: 'npcTemplates', mapcategory: 'mapCategories', room: 'roomTemplates', rolepanel: 'rolePanels', checkskill: 'checkSkillTemplates' }[kind];
  if (kind === 'checkskill') state.checkSkillTemplates ||= {};
  const old = existingId ? state[source][existingId] : null;
  if (existingId) ok(old, '模板不存在。');
  const data = old ? C.clone(old) : defaults(kind, itemKind);data.enabled=old?old.published!==false:true;
  if(kind==='room'){if(old)data.variants||=require('./room-variants').defaults(data);data.obstacles||=require('./encounter-layout').defaults(data);}
  if(kind==='npc'){data.anomalyRank||='I';data.randomStrength??=false;}
  if(kind==='mapcategory')data.mapTypes||=['indoor','region'];
  if (kind === 'item' && old) {
    if(['武器','弹夹'].includes(old.kind)){data.ammoIds=old.ammoIds || (old.initialAmmo?.id ? [old.initialAmmo.id] : Object.values(state.catalog).filter(t=>t.kind==='弹药'&&t.ammoType===old.ammoType).slice(0,1).map(t=>t.id));data.magazineIds=old.magazineIds || (old.initialMagazine?.id?[old.initialMagazine.id]:[]);}
    data.rangeMeters ??= (old.range ?? 1)*50;
    data.handedness ||= 'auto';
    data.durabilityMax ??=100;data.armorWeakening||={type:'physical',amount:0};data.weakeningResistance||={physical:0,magical:0,mental:0};
    data.fireModes ||= ['semi'];
    data.duration ||= { kind: 'actions', count: 3 };
    data.weightKg = old.weight / 100; data.effects = C.clone(old.ownEffects ||
      old.effects.slice((old.traitIds || []).flatMap(ref => state.traits[ref]?.effects || []).length));
  }
  if(kind==='npc'&&old&&!data.quantities)data.quantities=C.clone(old.itemQuantities||{});
  if (kind === 'condition' && old) for (const s of C.SEVERITIES) data.levels[s] = { ...defaults(kind).levels[s], ...(old.levels[s] || {}), enabled: !!old.levels[s] };
  const form = { id: C.id('f'), owner, kind, existingId: existingId || null, data, page: 0, field: 0, choicePage: 0,
    effectOp: 'add', createdAt: Date.now() };
  state.forms[form.id] = form; return form;
}
function owned(state, formId, owner) { const f = state.forms[formId]; ok(f && f.owner === owner, '草稿不存在或不属于你。'); return f; }
function display(value, field, state, limit = 120) {
  if(field.type==='roleLabels')return typeof value==='object'?Object.entries(value||{}).map(([id,label])=>'<@&'+id+'>：'+label).join('、')||'默认身份组名称':String(value||'默认身份组名称');
  if (field.type === 'randomRoom') return ((value || []).map(e => (field.source==='boxes' ? e.ref : state[field.source][e.ref]?.name || e.ref)+': '+R.summary([e])).join('\n') || '未配置').slice(0,limit);
  if (field.type === 'fixedRoom' && value && typeof value==='object') return Object.entries(value).map(([ref,n])=>(field.source==='boxes' ? ref : state[field.source][ref]?.name || ref)+' ×'+n).join('、') || '默认1';
  if(field.type==='variants')return (value||[]).length+'种变种，下拉编辑';
  if (field.type === 'bool') return value ? '开启' : '关闭';
  if (['effects', 'conditionEffects'].includes(field.type)) return (value || []).map(e => C.targetLabel(e.target) + ' ' +
    (e.amount ?? ((e.op === 'percent' ? '%' : '+') + e.value))).join('；') || '无';
  if (field.type === 'refs') return (value || []).map(ref => state[field.source][ref]?.name || ref).join('、') || '无';
  if (field.type === 'conditions') return (value || []).map(ref => (state.conditionTemplates[ref.id]?.name || ref.id) + '·' + ref.severity).join('、') || '无';
  if (field.type === 'roles') return (value || []).map(id => '<@&' + id + '>').join('、') || '无';
  if (Array.isArray(value)) return value.join('、') || '无';
  const option = field.values?.find(v => v.value === value);
  return String(option?.label ?? value ?? '未填写').slice(0, limit) || '未填写';
}
function view(state, form, preview = false) {
  const defs = fields(form), pages = Math.ceil(defs.length / 20), page = Math.max(0, Math.min(form.page, pages - 1));
  const selected = defs[form.field] || defs[0];
  const body = '草稿 ' + form.id + ' · ' + form.kind + (form.data.kind ? '／' + form.data.kind : '') +
    (form.data.kind === '武器' ? '\n持握分类：' + require('./weapons').label(form.data) + '（可在第一页下拉手动调整）' : '') +
    '\n退出后用 /gm 草稿 继续。' + (form.existingId ? '\n修改模板 ' + form.existingId + '，已发放实例保持原版本。' : '') +
    '\n\n' + defs.slice(page * 20, page * 20 + 20).map((d, n) => (page * 20 + n === form.field ? '▶ ' : '') +
      '**' + d.label + '**：' + display(get(form.data, d.key), d, state).slice(0, 120)).join('\n') +
    (preview ? '\n\n请逐页核对后发布。' : '');
  const result = U.payload(preview ? '发布预览' : 'GM分步录入 · 第' + (page + 1) + '/' + pages + '页', body, [
    U.row(U.select('formfield:' + form.id, '选择要填写的字段', defs.slice(page * 20, page * 20 + 20).map((d, n) =>
      ({ label: d.label, value: String(page * 20 + n), default: page * 20 + n === form.field })))),
    U.row(U.button('formpage:' + form.id + ':' + (page - 1), '上一页', undefined, page === 0),
      U.button('formpage:' + form.id + ':' + (page + 1), '下一页', undefined, page === pages - 1),
      U.button('formedit:' + form.id, '编辑：' + selected.label, U.D.ButtonStyle.Primary),
      U.button('formpreview:' + form.id, '预览'), U.button('formdetail:' + form.id, '查看当前字段全文')),
    U.row(U.button('formpublish:' + form.id, form.kind === 'rolepanel' ? '发布领取面板' : '发布模板', U.D.ButtonStyle.Success),
      U.button('formexit:' + form.id, '保存并退出'), U.button('formdelete:' + form.id, '删除草稿', U.D.ButtonStyle.Danger))
  ]);
  if(form.kind==='npc')result.components.push(U.row(U.button('npcui:f:'+form.id+':_:home','NPC自动操作 / 装备槽位',U.D.ButtonStyle.Primary)));
  if(form.kind==='npc')result.rpgPortraits=form.data.portraits || {};
  return form.kind==='item'?require('./loot-icons').decorate(result,{templateId:form.existingId,snapshot:form.data}):result;
}
function options(state, def, category) {
  if (def.type === 'conditions') return Object.values(state.conditionTemplates).filter(t => t.published).flatMap(t =>
    C.SEVERITIES.filter(s => t.levels[s]).map(s => ({ label: t.name + '·' + s, value: t.id + '|' + s })));
  if (def.type === 'refs') return Object.values(state[def.source]).filter(t => t.published && (!def.predicate || def.predicate(t)) && (!category || def.source !== 'catalog' || Categories.matches(t, category, def.key !== 'itemIds'))).map(t => ({ label: t.name, value: t.id }));
  return (def.values || []).map(v => typeof v === 'string' ? { label: v, value: v } : v);
}
function choiceView(state, form) {
  const def = fields(form)[form.field], categorized = def.type === 'refs' && def.source === 'catalog' && ['itemIds','supplyIds'].includes(def.key), category = form.itemCategories?.[def.key] || (def.key === 'itemIds' ? 'all' : undefined), values = options(state, def, category);
  const page = Math.max(0, Math.min(form.choicePage, Math.ceil(values.length / 25) - 1));
  const part = values.slice(page * 25, page * 25 + 25);
  const selected = get(form.data, def.key);
  const selectedValues = def.type === 'conditions' ? (selected || []).map(x => x.id + '|' + x.severity) :
    Array.isArray(selected) ? selected : [selected];
  const multi = ['multi', 'refs', 'conditions'].includes(def.type);
  return U.payload(def.label, '选择后立即保存到草稿。多页多选保留其他页的选择。\n当前：' + display(selected, def, state), [
    ...(categorized ? [Categories.row('formcategory:' + form.id, category, def.key !== 'itemIds')] : []),
    ...(part.length ? [U.row(U.select('formchoice:' + form.id + ':' + page, def.label, part.map(o => ({ ...o, default: selectedValues.includes(o.value) })),
      multi ? 0 : 1, multi ? Math.min(part.length, def.limit || 10) : 1))] : []),
    U.row(U.button('formchoicepage:' + form.id + ':' + (page - 1), '上一页', undefined, page <= 0),
      U.button('formchoicepage:' + form.id + ':' + (page + 1), '下一页', undefined, (page + 1) * 25 >= values.length),
      U.button('formclear:' + form.id, '清空选择', undefined, !multi), U.button('formback:' + form.id, '返回草稿'))
  ]);
}
function setChoice(state, form, page, selected) {
  const def = fields(form)[form.field], all = options(state, def, form.itemCategories?.[def.key] || (def.key === 'itemIds' ? 'all' : undefined)), currentPage = all.slice(page * 25, page * 25 + 25).map(o => o.value);
  ok(selected.every(x => currentPage.includes(x)), '选择已失效。');
  if (['multi', 'refs', 'conditions'].includes(def.type)) {
    let values = get(form.data, def.key) || [];
    if (def.type === 'conditions') values = values.map(x => x.id + '|' + x.severity);
    values = [...values.filter(x => !currentPage.includes(x)), ...selected];
    ok(values.length <= (def.limit || 10), '最多选择' + (def.limit || 10) + '项。');
    set(form.data, def.key, def.type === 'conditions' ? values.map(x => { const [id, severity] = x.split('|'); return { id, severity }; }) : values);
  } else set(form.data, def.key, selected[0]);
  if(def.key==='anomalyRank'){const rank=require('./npc-strength').LEVELS.indexOf(selected[0]);form.data.levelMin=rank*10+1;form.data.levelMax=(rank+1)*10;}
  if(def.key==='magazineIds'&&selected.length){const mag=state.catalog[selected[0]];form.data.capacity=mag.capacity;form.data.current=Math.min(form.data.current||0,mag.capacity);if(!form.data.ammoIds?.length)form.data.ammoIds=Object.values(state.catalog).filter(t=>t.kind==='弹药'&&t.ammoType===mag.ammoType).slice(0,1).map(t=>t.id);}
}
function effectsView(state, form) {
  const def = fields(form)[form.field], effects = get(form.data, def.key) || [], conditional = def.type === 'conditionEffects';
  const page=Math.max(0,Math.min(form.effectPage||0,Math.max(0,Math.ceil(effects.length/25)-1)));
  const targets = conditional ? C.CONDITION_TARGETS : C.EFFECT_TARGETS;
  const targetPage = Math.max(0, Math.min(form.targetPage || 0, Math.ceil(targets.length / 25) - 1));
  return U.payload(def.label, display(effects, def, state) + '\n\n' + (conditional ? '填写固定值或骰式，系统按扣除处理。' :
    '运算：' + (form.effectOp === 'percent' ? '百分比修正' : '固定加减') + '。负数表示减益。'), [
    U.row(U.select('formtarget:' + form.id, '新增效果：选择目标', targets.slice(targetPage*25,targetPage*25+25).map(value => ({ value, label: C.targetLabel(value) })))),
    ...(targets.length > 25 ? [U.row(U.button('formtargetpage:'+form.id+':'+(targetPage-1),'上一页目标',undefined,!targetPage),U.button('formtargetpage:'+form.id+':'+(targetPage+1),'下一页目标',undefined,(targetPage+1)*25>=targets.length))] : []),
    ...(effects.length ? [U.row(U.select('formremoveeffect:' + form.id, '删除某项效果', effects.slice(page*25,page*25+25).map((e, n) =>
      ({ label: C.targetLabel(e.target) + ' ' + (e.amount ?? e.value), value: String(page*25+n) }))))] : []),

    U.row(...(!conditional ? [U.button('formop:' + form.id, '切换固定／百分比')] : []), U.button('formclear:' + form.id, '清空效果'), U.button('formback:' + form.id, '返回草稿'), ...(effects.length>25 ? [U.button('formeffectpage:'+form.id+':'+(page-1),'上一页效果',undefined,!page),U.button('formeffectpage:'+form.id+':'+(page+1),'下一页效果',undefined,(page+1)*25>=effects.length)] : []))
  ]);
}
function publish(state, form) {
  const data = C.clone(form.data);
  let result;
  if(form.variantParent){const V=require('./room-variants'),parent=owned(state,form.variantParent.formId,form.owner);ok((parent.variantVersion||0)===form.variantParent.version,'主房间变种已修改，请重新编辑。');const v=parent.data.variants.find(v=>v.id===form.variantParent.id);ok(v,'变种已不存在。');const checked=require('./exploration').validateRoom(state,data,true);v.overrides=Object.fromEntries(V.KEYS.filter(k=>JSON.stringify(checked[k])!==JSON.stringify(parent.data[k])).map(k=>[k,C.clone(checked[k])]));parent.variantVersion=(parent.variantVersion||0)+1;form.done=true;return {id:v.id,name:v.name};}
  if (form.kind === 'skill') result = require('./skills').publish(state,data,form.existingId);
  else if (form.kind === 'item') result = M.publishTemplate(state, data, form.existingId);
  else {
    const source = { skill: 'skillTemplates', trait: 'traits', condition: 'conditionTemplates', npc: 'npcTemplates', mapcategory: 'mapCategories', room: 'roomTemplates', rolepanel: 'rolePanels', checkskill: 'checkSkillTemplates' }[form.kind];
    if (form.kind === 'checkskill') {
      state.checkSkillTemplates ||= {};
      result = { name: C.text(data.name, '技能名称', 80), level: C.number(data.level, '初始等级', 0, 1000000) };
    }
    if (form.kind === 'trait') result = { name: C.text(data.name, '词条名称', 80), description: C.text(data.description, '说明', 2000, true), effects: M.normalizeEffects(data.effects) };
    if (form.kind === 'condition') {
      for (const severity of C.SEVERITIES) {
        if (!data.levels[severity].enabled) delete data.levels[severity]; else delete data.levels[severity].enabled;
      }
      result = B.validateCondition(data);
    }
    if (form.kind === 'npc') {
      if (form.existingId) data.portraits = C.clone(state.npcTemplates[form.existingId]?.portraits || {});
      result = B.validateNPC(state, data);
    }
    if(form.kind==='mapcategory')ok((data.mapTypes||['indoor','region']).length>0&&(data.mapTypes||[]).every(t=>['indoor','region'].includes(t)),'至少选择一个合法地图类型。');
    if (form.kind === 'mapcategory') result = { name: C.text(data.name, '大类名称', 80), description: C.text(data.description || '', '描述', 2000, true),mapTypes:data.mapTypes||['indoor','region'] };
    if (form.kind === 'room') result = require('./exploration').validateRoom(state, data);
    if (form.kind === 'rolepanel') {
      ok(data.roleIds.length && data.roleIds.length <= 20, '领取面板需要1至20个身份组。');
      const previous = state.rolePanels[form.existingId];
      result = { ...data, title: C.text(data.title, '标题', 100), description: C.text(data.description, '说明', 2000, true),
        channelId: previous?.channelId || null, messageId: previous?.messageId || null };
      const labels = {};
      const pairs=typeof data.labels==='object'?Object.entries(data.labels||{}):String(data.labels||'').split('\n').filter(Boolean).map(line=>{const [id,...parts]=line.split('=');return [id.trim(),parts.join('=')];});
      for (const [roleId, textValue] of pairs) {
        if(!data.roleIds.includes(roleId))continue;
        labels[roleId]=C.text(textValue,'按钮标签',80);
      }
      result.labels = labels;
    }
    result.id = form.existingId || C.id('t'); result.version = (state[source][result.id]?.version || 0) + 1; result.published = true;
    state[source][result.id] = result;
  }
  result.published=data.enabled!==false;
  form.publishedId = result.id; form.existingId = result.id;
  return result;
}
module.exports = { get, set, defaults, fields, create, owned, display, view, options, choiceView, setChoice, effectsView, publish };
