'use strict';
const { randomInt, randomBytes } = require('node:crypto');

const DEFAULT_GUILD_ID = '1549280540505411635';
const ATTRIBUTES = { strength: '力量', constitution: '体质', mind: '心智', appearance: '外貌',
  intelligence: '智力', agility: '敏捷', knowledge: '学识' };
const DAMAGE_TYPES = { physical: '物理', magical: '魔法', mental: '精神' };
const RARITIES = [
  { id: 'red', name: '红', weight: 5, min: 30000, max: 300000, color: 0xed4245 },
  { id: 'gold', name: '金', weight: 10, min: 1500, max: 6000, color: 0xf1c40f },
  { id: 'purple', name: '紫', weight: 85, min: 500, max: 1500, color: 0x9b59b6 },
  { id: 'blue', name: '蓝', weight: 200, min: 100, max: 500, color: 0x3498db },
  { id: 'green', name: '绿', weight: 250, min: 20, max: 100, color: 0x2ecc71 },
  { id: 'white', name: '白', weight: 450, min: 1, max: 20, color: 0xecf0f1 },
];
const BOXES = ['大衣', '外套', '书柜', '武器箱', '医疗包', '旅行包', '饭盒', '高级旅行包',
  '小型保险', '保险箱', '军需保险箱', '武库保险箱'];
const QUALITIES = ['粗劣', '一般', '标准', '良好', '优秀', '精锐', '史诗', '传奇', '神话', '永恒'];
const WEAPON_TYPES = ['弓', '弩', '刀', '枪', '剑', '戟', '斧', '匕首', '手枪', '步枪', '狙击枪',
  '霰弹枪', '榴弹枪', '机枪', '反器械枪', '法杖', '其他'];
const FIREARMS = WEAPON_TYPES.slice(8, 15);
const ORIGINS = ['未知', '文明产物', '自然造物', '神战遗留', '名匠工造', '黎明重工', '天启公司', '地方产品'];
const CONSUMABLES = ['消耗品', '食物', '药品'];
const ITEM_KINDS = ['杂物', '武器', '防具', '饰品', '卡牌', '弹药', '弹夹', '配件', '技能', '特殊物品', '钥匙', '修复道具', ...CONSUMABLES];
const ARMOR_COVERAGE = { '头盔': ['head'], '胸甲': ['chest'], '臂甲': ['arms'], '内甲': ['inner'],
  '腿甲': ['legs'], '靴甲': ['feet'], '上身甲': ['head', 'chest', 'arms'],
  '下身甲': ['legs', 'feet'], '全甲': ['head', 'chest', 'arms', 'legs', 'feet'] };
const ACCESSORY_LIMITS = { head: [1, 4], body: [3, 10], ring: [1, 10] };
const ACCESSORY_NAMES = { head: '头部', body: '身体', ring: '戒指' };
const SEVERITIES = ['一般', '严重', '致命'];
const MAX_MONEY = 1000000000000;
const OFFER_TTL = 5 * 60 * 1000;
const id = (prefix = '') => prefix + randomBytes(6).toString('hex');
const clone = value => structuredClone(value);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function number(value, label, min = 0, max = 1000000, integer = true) {
  const n = Number(value);
  requireThat(value !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isSafeInteger(n)),
    label + '须为' + min + '至' + max + (integer ? '的整数。' : '的数值。'));
  return n;
}
function text(value, label, max = 2000, optional = false) {
  const s = String(value ?? '').trim();
  requireThat((optional || s.length) && s.length <= max, label + '须为' + (optional ? '0' : '1') + '至' + max + '字。');
  return s;
}
function dice(expression = '1d100', mode = 'normal', rng = randomInt) {
  const input = String(expression).replace(/\s/g, '').toLowerCase();
  requireThat(input.length <= 50, '骰式过长。');
  if (/^[+-]?\d+$/.test(input)) return { expression: input, rolls: [], modifier: 0,
    total: number(input, '固定数值', -1000000, 1000000) };
  const match = input.match(/^r?(\d*)d(\d+)([+-]\d+)?$/);
  requireThat(match, '骰式请使用 r2d20、1d6+3 或固定数值。');
  const count = number(match[1] || 1, '骰子数量', 1, 100);
  const faces = number(match[2], '骰子面数', 2, 1000);
  const modifier = number(match[3] || 0, '骰点修正', -1000000, 1000000);
  requireThat(['normal', 'advantage', 'disadvantage'].includes(mode), '掷骰模式无效。');
  const rolls = Array.from({ length: count }, () => {
    const a = rng(1, faces + 1);
    if (mode === 'normal') return { dice: [a], chosen: a };
    const b = rng(1, faces + 1);
    return { dice: [a, b], chosen: mode === 'advantage' ? Math.max(a, b) : Math.min(a, b) };
  });
  return { expression: count + 'd' + faces + (modifier ? (modifier > 0 ? '+' : '') + modifier : ''),
    rolls, modifier, total: rolls.reduce((sum, r) => sum + r.chosen, modifier) };
}
function rarity(rng = randomInt) {
  let ticket = rng(0, 1000);
  for (const r of RARITIES) { if (ticket < r.weight) return r; ticket -= r.weight; }
  throw new Error('稀有度权重无效。');
}
function title(level) {
  if (level === 1) return '凡人';
  if (level <= 10) return '入门';
  const titles = ['初级', '中级', '高级', '特级', '危险级', '扭曲级', '异常级', '天使级'];
  if (level <= 90) return titles[Math.floor((level - 11) / 10)];
  return level < 100 ? '半神' : '神';
}
function targetLabel(target) {
  if (target.startsWith('attr:')) return target === 'attr:luck' ? '时运' : ATTRIBUTES[target.slice(5)];
  const labels = { hp: '生命值', hpMax: '生命上限', ap: '当前动作点', apGain: '动作点增长',
    range: '攻击距离（米）', move: '移动米数', hit: '命中', dodge: '闪避修正', 'resist:physical': '物理异常抗性', 'resist:magical': '魔法异常抗性',
    'resist:mental': '精神异常抗性' };
  return labels[target] || (target.startsWith('attack:') ? '伤害：' : '防御：') + (DAMAGE_TYPES[target.split(':')[1]] || target);
}
const EFFECT_TARGETS = [...Object.keys(ATTRIBUTES).map(k => 'attr:' + k), 'attr:luck', 'range', 'hpMax', 'move', 'hit', 'dodge', 'apGain',
  ...Object.keys(DAMAGE_TYPES).flatMap(k => ['attack:' + k, 'defense:' + k, 'resist:' + k])];
const CONDITION_TARGETS = [...EFFECT_TARGETS, 'hp', 'ap'];
function kg(value) { return (value / 100).toFixed(2) + 'kg'; }
function round2(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

// Values are fictional scenario props. Combat equipment is authored by GMs.
function seedCatalog() {
  const props = [
    ['纸巾', '羊毛围巾', '户外定位仪', '精密怀表', '限量腕表', '收藏级宝石胸针'],
    ['旧手套', '保温手套', '运动相机', '专业镜头', '典藏徽章', '稀世收藏袖扣'],
    ['旧杂志', '精装图册', '珍藏版书籍', '签名手稿', '限量版藏书', '孤本史料手稿'],
    ['清洁布', '保养工具套装', '测距仪', '高精度光学仪', '限量观测仪', '收藏级历史仪器'],
    ['纱布', '急救耗材套装', '医用监测仪', '便携检测设备', '专业检测仪', '珍贵研究样本盒'],
    ['水杯', '便携滤水器', '卫星导航器', '专业相机', '限量收藏相机', '宝石旅行纪念品'],
    ['方便食品', '精装茶叶', '稀有茶叶礼盒', '收藏茶饼', '典藏茶饼', '稀世收藏茶饼'],
    ['洗漱包', '真皮钱包', '户外通信器', '高端镜头', '限量腕表', '收藏级宝石项链'],
    ['纪念币', '银制纪念章', '稀有纪念币', '签名收藏币', '金币套装', '稀世古币'],
    ['文具', '银制摆件', '工艺摆件', '限量版画', '艺术家原作', '收藏级珠宝'],
    ['徽章', '纪念勋章', '军用观测镜', '收藏纪念章', '历史资料原件', '稀世历史纪念品'],
    ['工具刷', '维护工具箱', '精密检测仪', '专用测量仪', '历史技术手稿', '稀世技术档案'],
  ];
  const catalog = {};
  const descriptions = [
    ['便携纸巾，适合擦拭污渍与清洁小物件。', '柔软厚实的羊毛围巾，边缘织有细密纹样。', '具备地图显示与位置记录功能的户外定位仪。', '装在金属表壳中的机械怀表，齿轮运行精细。', '带有独立编号的限量腕表，表盘与机芯保存完好。', '镶嵌罕见宝石的收藏胸针，工艺与出处具有收藏价值。'],
    ['有磨损痕迹的旧手套，仍可遮挡轻微风寒。', '内衬保温材料的手套，适合低温环境使用。', '小型运动相机，可记录旅行和户外活动。', '供专业摄影使用的镜头，镜片镀膜完整。', '经过精细制作的典藏徽章，附有收藏说明。', '以珍贵材料制成的收藏袖扣，雕刻细致。'],
    ['一本翻阅过的旧杂志，收录当时的新闻与图文。', '采用硬壳装订的图册，图片清晰且附有说明。', '保存完好的珍藏版书籍，具有研究与收藏价值。', '作者签名的原始手稿，保留修订痕迹。', '限量印制的藏书，装帧考究并附发行编号。', '保存着独特历史资料的孤本手稿，内容难以替代。'],
    ['用于擦拭工具表面的清洁布，易于折叠携带。', '用于日常清理与维护的保养工具套装。', '能够测量目标距离的便携测距仪。', '结构精密的高精度光学仪，适合观测与测量。', '限量生产的观测仪，镜组与外壳保存完好。', '具有明确历史来源的收藏仪器，兼具研究价值。'],
    ['独立包装的医用纱布，可作为包扎耗材。', '包含基础包扎材料的急救耗材套装。', '可显示基础生命体征的医用监测仪。', '装在便携箱中的检测设备，适合现场检查。', '专业检测仪器，附带完整探头和操作说明。', '密封保存的珍贵研究样本盒，标签记录着来源。'],
    ['耐用的随身水杯，杯盖密封可靠。', '便携滤水器，配有可更换的过滤组件。', '支持卫星定位的导航器，适合野外路线规划。', '具备手动控制功能的专业相机。', '编号限量的收藏相机，镜头与机身配套完整。', '以宝石制作的旅行纪念品，包装注明产地。'],
    ['密封包装的方便食品，便于携带和快速准备。', '装在精致盒中的茶叶，香气清晰且包装完整。', '少见品种的茶叶礼盒，附产地与采摘说明。', '适宜收藏的茶饼，包装记载生产年份。', '保存条件良好的典藏茶饼，具有明确收藏来源。', '稀少批次的收藏茶饼，附完整流转与保存记录。'],
    ['分隔收纳的洗漱包，可整理旅途清洁用品。', '缝线整齐的真皮钱包，具有多个收纳夹层。', '面向户外活动的通信器，配有充电与连接附件。', '高端摄影镜头，适合精细成像需求。', '附收藏编号的限量腕表，机芯经妥善维护。', '镶有珍贵宝石的收藏项链，附来源证明。'],
    ['为纪念某项活动铸造的纪念币。', '银制纪念章，正面浮雕保存清晰。', '发行数量较少的纪念币，具有收藏价值。', '带有签名及纪念说明的收藏币。', '成套保存的纪念金币，装在专用保护盒中。', '来源可考的稀世古币，铭文与铸造细节清楚。'],
    ['常用文具组合，可用于书写和简单记录。', '小巧的银制摆件，表面有细致纹饰。', '具有装饰用途的工艺摆件，制作完整。', '附版次编号的限量版画，纸张保存平整。', '艺术家亲自创作的原作，保留签名与创作信息。', '采用珍贵材质制作的收藏珠宝，配有专用盒。'],
    ['标示组织或活动的普通徽章。', '记录特定功绩或事件的纪念勋章。', '便携观测镜，外壳坚固且镜片清洁。', '保存完好的收藏纪念章，附发行资料。', '记录历史事件的资料原件，含原始批注。', '具有重要历史出处的稀世纪念品，附考证资料。'],
    ['清理工具缝隙与表面灰尘的小型工具刷。', '包含常用维护工具的收纳箱。', '适合精细检查的检测仪，附配套探头。', '用于特定测量任务的专用仪器。', '记录历史技术方案的手稿，保留计算与图示。', '保存独特技术资料的稀世档案，内容完整。'],
  ];
  BOXES.forEach((box, b) => {
    [...RARITIES].reverse().forEach((r, n) => {
      const key = 'seed_' + b + '_' + r.id;
      catalog[key] = { id: key, version: 1, published: true, kind: '杂物',
        name: props[b][n], rarity: r.id, weight: [20, 50, 100, 150, 100, 50][n],
        value: require('./upgrade').seedPrice(key), boxes: [box], effects: [], traitIds: [], description: descriptions[b][n] };
    });
  });
  for (const [special, name] of [['heart', '世界树之心'], ['tear', '世界树之泪']]) {
    catalog['special_' + special] = { id: 'special_' + special, version: 1, published: true,
      kind: '特殊物品', name, special, rarity: 'red', weight: 0, value: 0, effects: [], boxes: [],
      description: '仅由GM发放，使用时扩展一个角色槽位。' };
  }
  return catalog;
}
function newState(guildId) {
  return { kind: 'tabletop-rpg', schema: 1, upgrade: 5, guildId, revision: 0,
    config: { gmRoleIds: [], playerRoleIds: [], announcementChannelId: null },
    players: {}, characterDrafts: {}, forms: {}, catalog: seedCatalog(), skillTemplates: {}, checkSkillTemplates: {}, checks: {}, sessions: {}, lootPublications: {},
    traits: { neutral: { id: 'neutral', version: 1, published: true, name: '无附加效果', description: '只展示，不修改数值。', effects: [] } }, conditionTemplates: {},
    mapCategories: {}, roomTemplates: {}, explorations: {}, deaths: {}, corpses: {}, npcTemplates: {}, battles: {}, offers: {}, rolePanels: {}, receipts: {}, events: [] };
}
module.exports = { DEFAULT_GUILD_ID, ATTRIBUTES, DAMAGE_TYPES, RARITIES, BOXES, QUALITIES, WEAPON_TYPES,
  FIREARMS, ORIGINS, ITEM_KINDS, CONSUMABLES, ARMOR_COVERAGE, ACCESSORY_LIMITS, ACCESSORY_NAMES, SEVERITIES,
  MAX_MONEY, OFFER_TTL, EFFECT_TARGETS, CONDITION_TARGETS, id, clone, requireThat, number, text,
  dice, rarity, title, targetLabel, kg, round2, seedCatalog, newState };
