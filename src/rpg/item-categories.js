'use strict';
const U = require('./ui');
const groups = [
  ['all', '全部实用物品', null], ['weapon', '武器', ['武器']], ['armor', '防具', ['防具']],
  ['accessory', '饰品', ['饰品']], ['card', '卡牌', ['卡牌']], ['ammo', '弹药 / 弹夹', ['弹药', '弹夹']],
  ['consumable', '食物 / 药品 / 道具', ['食物', '药品', '消耗品', '修复道具']],
  ['attachment', '配件', ['配件']], ['key', '钥匙', ['钥匙']], ['special', '特殊物品', ['特殊物品']],
  ['junk', '杂物', ['杂物']]
];
function valid(category, junk = false) { return groups.some(([id]) => id === category && (junk || id !== 'junk')); }
function matches(t, category = 'all', junk = false) {
  const group = groups.find(([id]) => id === category);
  if (!group || (!junk && t.kind === '杂物')) return false;
  return group[2] ? group[2].includes(t.kind) : t.kind !== '杂物';
}
function row(route, category = 'all', junk = false) {
  return U.row(U.select(route, '按物品分类筛选', groups.filter(([id]) => junk || id !== 'junk')
    .map(([value, label]) => ({value, label, default:value === category}))));
}
module.exports = {groups, valid, matches, row};
