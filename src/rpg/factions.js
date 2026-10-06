'use strict';
const C = require('./constants'), M = require('./model'), U = require('./ui');
const WORLD = '这个世界曾拥有发展到现代的文明。直到纪元2055年，一场被称为“原点”的IX级超现实重塑异常席卷全球，现实的稳定性从此不再理所当然。\n\n灾难后，约三分之二的区域沦为现实不稳定区：熟悉的街道可能通向不存在的城市，建筑内部的空间与外部尺度不再一致，时间、天气乃至物质性质都可能偏离常识。幸存者依靠仍能维持秩序的聚居地、交通线与补给网络生存，同时不得不进入危险区域寻找资源。\n\n原点也让超凡力量进入现实，并催生了“异常生物”。其中一些缺乏组织与纪律，仅凭本能破坏；另一些能够控制区域、扭曲局部现实，被称为“超现实扭曲者”。它们按照威胁划分为I至X级。评级用于描述危险程度，并不意味着相同等级的异常拥有相同能力。';
const FACTIONS = {
  explorer: { name: '自由探险家', color: 0x3498db, description: '自由探险家不隶属于统一组织。他们可能是受雇调查的独行者、护送补给的佣兵，或寻找失落遗迹与灾前知识的探索队。\n\n自由意味着能够自行选择路线、雇主与伙伴，也意味着没有稳定的组织保障。对于他们而言，可靠的地图、可信的同伴与及时撤退的判断，往往比名声更能决定能否活着回来。' },
  apocalypse: { name: '天启重工', color: 0xe74c3c, description: '天启重工是目前维持世界秩序的超级巨物。其工业体系、行政网络与资源调配能力连接着主要稳定区，也使大量聚居地依赖其提供的安全、医疗与供应。\n\n对一些幸存者而言，它是文明延续的支柱；对另一些人而言，它也是无法绕开的庞大权力体系。' },
  scavenger: { name: '拾荒者联盟', color: 0xf1c40f, description: '拾荒者联盟在原点灾难后的废墟与异常区域中发展起来，由拾荒队、回收商、向导和中间人共同构成。成员经常深入现实不稳定区，寻找仍能使用的设备、稀有材料以及具有交易价值的异常遗物。\n\n联盟目前掌握着最好的黑商渠道。公开市场难以收购、辨认或流通的物品，往往能在其网络中找到买家。危险路线情报、估价经验与熟悉的中间人，是联盟成员赖以生存的资产；不过，渠道畅通并不代表交易没有风险。' }
};
const DEPARTMENTS = {
  war: { name: '战争部', responsibility: '武力', description: '武装防卫、运输护航、危险区域作战及异常威胁处置。' },
  death: { name: '死亡部', responsibility: '内政', description: '聚居地行政、人口与档案管理、秩序维护及灾后事务协调。' },
  plague: { name: '瘟疫部', responsibility: '卫生', description: '医疗救治、防疫隔离、异常污染调查与公共卫生。' },
  famine: { name: '饥荒部', responsibility: '经济', description: '生产、粮食、能源、物流、贸易及资源分配。' }
};
const departmentText = s => Object.entries(DEPARTMENTS).map(([key,d]) => '**' + d.name + '｜' + d.responsibility + '**：' + (s?require('./texts').get(s,'department/'+key):d.description)).join('\n');
function label(value) {
  const f = FACTIONS[value?.id];
  return f ? f.name + (value.id === 'apocalypse' && DEPARTMENTS[value.department] ? ' · ' + DEPARTMENTS[value.department].name : '') : '未选择';
}
function choose(state, userId, characterId, faction, department) {
  const p = M.player(state, userId);
  C.requireThat(p.id === characterId, '角色卡已变化，请重新 /势力。');
  C.requireThat(FACTIONS[faction] && (faction !== 'apocalypse' || DEPARTMENTS[department]), '势力或部门无效。');
  p.faction = { id: faction, department: faction === 'apocalypse' ? department : null, changedAt: Date.now() };
  return { characterId: p.id, faction: C.clone(p.faction) };
}
function createFactions({ snapshot, tx }) {
  const { row, button, select, payload, D } = U;
  const back = () => row(button('faction:home', '返回势力面板'));
  function home(state, uid) {
    const p = state.players[uid];
    return payload('势力归属', '当前归属：**' + label(p?.faction) + '**\n势力用于角色背景，不增加数值、资产或能力。\n' +
      (p ? '可随时修改，确认后写入角色卡。' : '确认角色卡后可以选择归属；现在可以阅读背景。'), [
      row(select('faction:read', '阅读势力介绍', Object.entries(FACTIONS).map(([value, f]) => ({ label: f.name, value })))),
      row(button('faction:world', '世界背景'), button('faction:select', '选择 / 修改势力', D.ButtonStyle.Primary, !p))
    ]);
  }
  function preview(s,p, id, department = 'none') {
    const f = FACTIONS[id]; C.requireThat(f, '势力无效。');
    if (id === 'apocalypse') C.requireThat(DEPARTMENTS[department], '请选择天启重工部门。');
    return payload('确认势力归属', p.name + '\n当前：' + label(p.faction) + '\n选择：**' + label({ id, department }) + '**\n\n' +
      require('./texts').get(s,'faction/'+id).slice(0,1500) + (id === 'apocalypse' ? '\n\n' + require('./texts').get(s,'department/'+department).slice(0,1500) : ''), [
      row(button('faction:confirm:' + p.id + ':' + id + ':' + department, '确认归属', D.ButtonStyle.Success),
        button('faction:select', '返回选择'), button('faction:home', '取消'))
    ], f.color);
  }
  async function component(i) {
    const [, action, ref, id, department] = i.customId.split(':').slice(1), s = snapshot(i.guildId), uid = i.user.id;
    if (action === 'home') return home(s, uid);
    if (action === 'world') return payload('世界背景 · 原点之后', require('./texts').get(s,'rule/世界背景'), [back()], 0x8e44ad);
    if(action==='lorepage'){const Text=require('./texts'),key=ref;const text=key==='apocalypse'?Text.get(s,'faction/'+key)+'\n\n'+departmentText(s):Text.get(s,'faction/'+key),pages=Math.ceil(text.length/3500),page=Math.max(0,Math.min(Number(id)||0,pages-1));return payload(FACTIONS[key].name,text.slice(page*3500,(page+1)*3500),[row(button('faction:lorepage:'+key+':'+(page-1),'上一页',undefined,!page),button('faction:lorepage:'+key+':'+(page+1),'下一页',undefined,page>=pages-1)),back()],FACTIONS[key].color);}
    if (action === 'read') {
      const f = FACTIONS[i.values[0]]; C.requireThat(f, '势力无效。');
      const text=require('./texts').get(s,'faction/'+i.values[0])+(i.values[0]==='apocalypse'?'\n\n'+departmentText(s):'');return payload(f.name,text.slice(0,3500),[row(button('faction:lorepage:'+i.values[0]+':0','上一页',undefined,true),button('faction:lorepage:'+i.values[0]+':1','下一页',undefined,text.length<=3500)),back()],f.color);
    }
    const p = M.player(s, uid);
    if (action === 'select') return payload('选择势力', '当前：' + label(p.faction), [
      row(select('faction:pick', '选择角色所属势力', Object.entries(FACTIONS).map(([value, f]) => ({ label: f.name, value })))), back()
    ]);
    if (action === 'pick') {
      const id = i.values[0]; C.requireThat(FACTIONS[id], '势力无效。');
      if (id !== 'apocalypse') return preview(s,p, id);
      return payload('天启重工 · 选择部门', Object.entries(DEPARTMENTS).map(([key,d])=>'**'+d.name+'｜'+d.responsibility+'**：'+require('./texts').get(s,'department/'+key).slice(0,650)).join('\n'), [
        row(select('faction:department', '选择一个部门', Object.entries(DEPARTMENTS).map(([value, d]) =>
          ({ label: d.name + '｜' + d.responsibility, value })))), row(button('faction:select', '返回势力选择'), button('faction:home', '取消'))
      ], FACTIONS.apocalypse.color);
    }
    if (action === 'department') return preview(s,p, 'apocalypse', i.values[0]);
    C.requireThat(action === 'confirm', '势力操作无效。');
    await tx(i, st => choose(st, uid, ref, id, department), '修改角色势力归属');
    return home(snapshot(i.guildId), uid);
  }
  return { home, component };
}
module.exports = { WORLD, FACTIONS, DEPARTMENTS, departmentText, label, choose, createFactions };
