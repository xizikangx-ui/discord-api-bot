'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants');
const { shuffled } = require('./random-layout');
// Stable seed IDs keep room edits and translated names from changing the preset.
const POOLS = [
  ['货架', '收银台'], ['药品柜', '储存架'], ['检查床', '医疗柜'], ['实验台', '通风柜'],
  ['服务器机柜', '控制柜'], ['值班桌', '监控台'], ['装备柜', '值班台'], ['办公桌', '文件柜'],
  ['会议桌', '投影台'], ['文件架', '索引柜'], ['工作台', '工具柜'], ['维修台', '机器残骸'],
  ['废弃车辆', '检修设备'], ['床铺', '储物柜'], ['料理台', '餐具架'], ['灶台', '冷藏设备'],
  ['帐篷', '补给箱'], ['观察台', '岩石'], ['路障', '检查设备'], ['储存架', '通风设备']
];
function defaults(room = {}) {
  const match = /^room_seed_(\d+)$/.exec(room.id || '');
  return { names: (match && POOLS[Number(match[1])] || ['通用家具']).join('、'), min: 1, max: 3, terrain: 'blocked' };
}
function validate(raw, room = {}) {
  const value = { ...defaults(room), ...(raw || {}) };
  const names = (Array.isArray(value.names) ? value.names : String(value.names).split(/[、，,\n]/)).map(n => C.text(n.trim(), '障碍名称', 20)).filter(Boolean);
  C.requireThat(names.length >= 1 && names.length <= 10, '障碍名称须为1—10种，用顿号分隔。');
  const min = C.number(value.min, '最少障碍数量', 0, 3), max = C.number(value.max, '最多障碍数量', min, 3);
  C.requireThat(['blocked', 'difficult'].includes(value.terrain), '障碍地形须为阻挡或困难。');
  return { names: [...new Set(names)].join('、'), min, max, terrain: value.terrain };
}
function connected(width, height, terrain) {
  const cells = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (terrain[x + ',' + y] !== 'blocked') cells.push(x + ',' + y);
  if (!cells.length) return false;
  const seen = new Set([cells[0]]), queue = [cells[0]];
  for (let n = 0; n < queue.length; n++) {
    const [x, y] = queue[n].split(',').map(Number);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      const ref = nx + ',' + ny;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && terrain[ref] !== 'blocked' && !seen.has(ref)) { seen.add(ref); queue.push(ref); }
    }
  }
  return seen.size === cells.length;
}
function generate(room, rng = randomInt) {
  const config = validate(room.obstacles, room), width = rng(2, 4), height = rng(2, 5), limit = Math.min(3, Math.floor(width * height / 4));
  const min = Math.min(config.min, limit), max = Math.min(config.max, limit), requested = rng(min, max + 1), terrain = {}, obstacles = [];
  const refs = Array.from({ length: width * height }, (_, n) => n % width + ',' + Math.floor(n / width));
  const names = config.names.split('、');
  for (const ref of shuffled(refs, rng)) {
    if (obstacles.length === requested) break;
    terrain[ref] = config.terrain;
    if (!connected(width, height, terrain)) { delete terrain[ref]; continue; }
    obstacles.push({ cell: ref, name: names[rng(0, names.length)], terrain: config.terrain });
  }
  return { version: 1, width, height, terrain, obstacles, requested, actual: obstacles.length };
}
function validateLayout(layout) {
  C.requireThat(layout?.version === 1, '房间战场布局版本无效。');
  const width = C.number(layout.width, '战场列数', layout.legacy ? 1 : 2, layout.legacy ? 20 : 3);
  const height = C.number(layout.height, '战场行数', layout.legacy ? 1 : 2, layout.legacy ? 20 : 4);
  for (const [ref, type] of Object.entries(layout.terrain || {})) {
    const [x, y] = ref.split(',').map(Number);
    C.requireThat(/^\d+,\d+$/.test(ref) && x < width && y < height && ['normal', 'blocked', 'difficult'].includes(type), '房间战场地形无效。');
  }
  C.requireThat(layout.legacy || connected(width, height, layout.terrain || {}), '房间战场没有连通的可通行区域。');
  return layout;
}
function place(battle, rng = randomInt, legacy = false) {
  const cells = [];
  for (let y = 0; y < battle.height; y++) for (let x = 0; x < battle.width; x++) if (battle.terrain[x + ',' + y] !== 'blocked') cells.push({ x, y });
  const offsets = legacy && cells.length * 9 < battle.actors.length ? [5, 15, 25, 35, 45] : [10, 25, 40];
  C.requireThat(cells.length * offsets.length ** 2 >= battle.actors.length, '战场可用出生位置不足。');
  const available = shuffled(cells, rng).map(cell => shuffled(offsets.flatMap(x => offsets.map(y => ({ x: cell.x * 50 + x, y: cell.y * 50 + y }))), rng));
  const actors = shuffled(battle.actors, rng), spawns = [];
  actors.forEach((actor, n) => {
    const point = available[n % available.length].pop();
    actor.x = point.x; actor.y = point.y;
    spawns.push({ actorId: actor.id, ...point });
  });
  battle.encounterSpawns = spawns;
  return spawns;
}
function describe(layout) {
  return (layout.obstacles || []).map(o => o.name + '（' + (o.terrain === 'difficult' ? '困难' : '阻挡') + '，' + o.cell.split(',').map(n => Number(n) + 1).join('/') + '）').join('、') || '无障碍';
}
module.exports = { defaults, validate, connected, generate, validateLayout, place, describe };
