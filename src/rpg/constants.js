'use strict';
const { randomInt, randomBytes } = require('node:crypto');

const DEFAULT_GUILD_ID = '1549280540505411635';
const ATTRIBUTES = { strength: '力量', constitution: '体质', mind: '心智', appearance: '外貌',
  intelligence: '智力', agility: '敏捷', knowledge: '学识' };
const DAMAGE_TYPES = { physical: '物理', magical: '魔法', mental: '精神' };
const RARITIES = [
  { id: 'red', name: '红', weight: 5, min: 1500000, max: 23000000, color: 0xed4245 },
  { id: 'gold', name: '金', weight: 10, min: 30000, max: 100000, color: 0xf1c40f },
  { id: 'purple', name: '紫', weight: 85, min: 5000, max: 15000, color: 0x9b59b6 },
  { id: 'blue', name: '蓝', weight: 200, min: 1000, max: 5000, color: 0x3498db },
  { id: 'green', name: '绿', weight: 250, min: 400, max: 1000, color: 0x2ecc71 },
  { id: 'white', name: '白', weight: 450, min: 1, max: 200, color: 0xecf0f1 },
];
const BOXES = ['大衣', '外套', '书柜', '武器箱', '医疗包', '旅行包', '饭盒', '高级旅行包',
  '小型保险', '保险箱', '军需保险箱', '武库保险箱'];
const QUALITIES = ['粗劣', '一般', '标准', '良好', '优秀', '精锐', '史诗', '传奇', '神话', '永恒'];
const WEAPON_TYPES = ['弓', '弩', '刀', '枪', '剑', '戟', '斧', '匕首', '手枪', '步枪', '狙击枪',
  '霰弹枪', '榴弹枪', '机枪', '反器械枪', '法杖', '其他'];
const FIREARMS = WEAPON_TYPES.slice(8, 15);
const ORIGINS = ['未知', '文明产物', '自然造物', '神战遗留', '名匠工造', '黎明重工', '天启公司', '地方产品'];
const ITEM_KINDS = ['杂物', '武器', '防具', '饰品', '卡牌', '弹药', '弹夹', '配件', '技能', '特殊物品', '消耗品'];
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
  if (target.startsWith('attr:')) return ATTRIBUTES[target.slice(5)];
  const labels = { hp: '生命值', hpMax: '生命上限', ap: '当前动作点', apGain: '动作点增长',
    move: '移动米数', hit: '命中', dodge: '闪避修正', 'resist:physical': '物理异常抗性', 'resist:magical': '魔法异常抗性',
    'resist:mental': '精神异常抗性' };
  return labels[target] || (target.startsWith('attack:') ? '伤害：' : '防御：') + (DAMAGE_TYPES[target.split(':')[1]] || target);
}
const EFFECT_TARGETS = [...Object.keys(ATTRIBUTES).map(k => 'attr:' + k), 'hpMax', 'move', 'hit', 'dodge', 'apGain',
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
  BOXES.forEach((box, b) => {
    [...RARITIES].reverse().forEach((r, n) => {
      const key = 'seed_' + b + '_' + r.id;
      catalog[key] = { id: key, version: 1, published: true, kind: '杂物',
        name: props[b][n], rarity: r.id, weight: [20, 50, 100, 150, 100, 50][n],
        value: r.min, boxes: [box], effects: [], traitIds: [], description: '现代场景中的' + props[b][n] + '，价值为游戏内估值。' };
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
  return { kind: 'tabletop-rpg', schema: 1, guildId, revision: 0,
    config: { gmRoleIds: [], playerRoleIds: [], announcementChannelId: null },
    players: {}, characterDrafts: {}, forms: {}, catalog: seedCatalog(),
    traits: { neutral: { id: 'neutral', version: 1, published: true, name: '无附加效果', description: '只展示，不修改数值。', effects: [] } }, conditionTemplates: {},
    npcTemplates: {}, battles: {}, offers: {}, rolePanels: {}, receipts: {}, events: [] };
}
module.exports = { DEFAULT_GUILD_ID, ATTRIBUTES, DAMAGE_TYPES, RARITIES, BOXES, QUALITIES, WEAPON_TYPES,
  FIREARMS, ORIGINS, ITEM_KINDS, ARMOR_COVERAGE, ACCESSORY_LIMITS, ACCESSORY_NAMES, SEVERITIES,
  MAX_MONEY, OFFER_TTL, EFFECT_TARGETS, CONDITION_TARGETS, id, clone, requireThat, number, text,
  dice, rarity, title, targetLabel, kg, round2, seedCatalog, newState };
