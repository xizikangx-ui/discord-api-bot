'use strict';
const D = require('discord.js');
const C = require('./constants');
const M = require('./model');
const B = require('./combat');
const W = require('./weapons');
const E = D.MessageFlags.Ephemeral;
const row = (...components) => new D.ActionRowBuilder().addComponents(...components.filter(Boolean));
const button = (customId, label, style = D.ButtonStyle.Secondary, disabled = false) =>
  new D.ButtonBuilder().setCustomId('rpg:' + customId).setLabel(label.slice(0, 80)).setStyle(style).setDisabled(disabled);
const select = (customId, placeholder, options, min = 1, max = 1) => new D.StringSelectMenuBuilder()
  .setCustomId('rpg:' + customId).setPlaceholder(placeholder.slice(0, 150)).setMinValues(min).setMaxValues(max)
  .addOptions(options.map(o => ({ label: String(o.label).slice(0, 100), value: String(o.value),
    ...(o.description ? { description: String(o.description).slice(0, 100) } : {}), ...(o.default ? { default: true } : {}) })));
const icon = title => /战场|战斗|行动|防守/.test(title) ? '⚔️' : /背包|物品|装备|抽取/.test(title) ? '🎒' :
  /角色/.test(title) ? '🪪' : /鉴定|掷骰/.test(title) ? '🎲' : /开团/.test(title) ? '📅' :
  /交易|资产|报价/.test(title) ? '🤝' : /草稿|录入|预览|模板/.test(title) ? '📝' : /已保存|完成|成功|已发布/.test(title) ? '✅' : '📋';
const embed = (title, description, color = 0x5865f2) => new D.EmbedBuilder().setTitle((icon(title) + ' ' + title).slice(0, 256))
  .setDescription((description || '暂无记录。').slice(0, 4096)).setColor(color).setFooter({ text: '夕 · 跑团系统' });
const payload = (title, body, components = [], color) => ({ embeds: [embed(title, body, color)], components, allowedMentions: { parse: [] } });
const field = (name, value, inline = false) => ({ name: String(name).slice(0, 256), value: String(value ?? '—').slice(0, 1024) || '—', inline });
function bar(current, maximum) {
  const full = maximum > 0 ? Math.max(0, Math.min(10, Math.floor(current / maximum * 10))) : 0;
  return '▰'.repeat(full) + '▱'.repeat(10 - full);
}
function effectsText(effects) {
  return effects?.length ? effects.map(e => C.targetLabel(e.target) + ' ' + (e.value >= 0 ? '+' : '') + e.value +
    (e.op === 'percent' ? '%' : '')).join('、') : '无';
}
function temporaryText(p, page = 0) {
  return (p.temporaryEffects || []).filter(e => e.duration.kind !== 'minutes' || e.expiresAt > Date.now()).slice(page * 3, page * 3 + 3)
    .map(e => '**' + e.name + '** · ' + (e.duration.kind === 'minutes' ? '<t:' + Math.floor(e.expiresAt / 1000) + ':R>到期' : '剩余' + e.remaining + '次自身行动') +
      '\n' + effectsText(e.modifiers).slice(0, 280)).join('\n\n') || '无持续增减益';
}
function modal(id, title, fields) {
  return new D.ModalBuilder().setCustomId('rpg:' + id).setTitle(title.slice(0, 45)).addComponents(...fields.map(f => row(
    new D.TextInputBuilder().setCustomId(f.key).setLabel(f.label.slice(0, 45))
      .setStyle(f.long ? D.TextInputStyle.Paragraph : D.TextInputStyle.Short)
      .setRequired(f.required !== false).setMaxLength(f.max || 2000)
      .setValue(String(f.value ?? '').slice(0, f.max || 2000)))));
}
const memberRoles = member => member.roles?.cache ? [...member.roles.cache.keys()] : member.roles || [];
function gm(state, member) { return state.config.gmRoleIds.some(r => memberRoles(member).includes(r)); }
function playerRole(state, member) { return state.config.playerRoleIds.some(r => memberRoles(member).includes(r)); }
function characterView(p, privateView = false, page = 0) {
  const s = M.stats(p), faction = require('./factions'), color = faction.FACTIONS[p.faction?.id]?.color || 0x3498db;
  const v = payload('角色卡 · ' + p.name, '**Lv.' + p.level + ' · ' + C.title(p.level) + '**\n' + faction.label(p.faction) +
    '\n性别：' + ({male:'男性',female:'女性'}[p.gender]||'未设置') + ' · 年龄：'+(p.age == null ? '未设置' : p.age+'岁')+' · 时运 **'+(p.luck??1)+' → '+s.luck+'**' + '\n\n**HP ' + p.hp + '/' + s.maxHP + '**\n' + bar(p.hp, s.maxHP) + '\n**经验 ' + (p.xpCenti / 100).toFixed(2) +
    (p.level === 100 ? ' · 满级' : '/' + p.level * 1000) + '**\n' + bar(p.xpCenti / 100, p.level * 1000), [], color);
  const attr = Object.entries(C.ATTRIBUTES).map(([k, label]) => label + ' **' + p.attributes[k] + '**' + (s.attributes[k] !== p.attributes[k] ? ' → **' + s.attributes[k] + '**' : ''));
  v.embeds[0].addFields(field('身体属性', attr.filter((_, n) => [0,1,3,5].includes(n)).join('\n'), true),
    field('心智属性', attr.filter((_, n) => [2,4,6].includes(n)).join('\n') + '\n适应性 **' + p.adaptation + '** · 自由点 **' + p.points + '**', true),
    field('三类防御', Object.entries(s.defenses).map(([k,n]) => C.DAMAGE_TYPES[k] + ' **' + n + '**').join(' / ')),
    field('行动与负重', '移动 **' + s.move + '米** · 举起 ' + s.attributes.strength * 10 + 'kg\n' +
      C.kg(s.carried) + ' / ' + C.kg(s.limit) + (s.overloaded ? ' · ⛔ 无法移动' : s.burdened ? ' · ⚠️ 减速' : ' · ✅ 正常')),
    field('异常 · 第' + (page + 1) + '页', p.conditions.slice(page * 8, page * 8 + 8).map(c => c.template.name.slice(0,80) + ' · ' + c.severity).join('\n') || '无'),
    field('持续效果 · 第' + (page + 1) + '页', temporaryText(p, page)));
  if (privateView) v.embeds[0].addFields(field('私人资产', '余额 **' + p.balance + '** · 抽卡次数 **' + p.tickets.card + '**\n' +
    Object.entries(p.tickets.boxes).map(([k,n]) => k + ' ' + n).join(' / ') || '暂无'));
  const profilePages = [['background','个人背景'],['appearance','个人外貌描述'],['belief','个人信念']].flatMap(([key,label])=>p.profile?.[key] ? Array.from({length:Math.ceil(p.profile[key].length/1000)},(_,n)=>({label,text:p.profile[key].slice(n*1000,(n+1)*1000)})) : []);
  if(page>0&&profilePages[page-1])v.embeds[0].addFields(field(profilePages[page-1].label,profilePages[page-1].text));
  const pages = Math.max(1+profilePages.length, Math.ceil(p.conditions.length / 8), Math.ceil((p.temporaryEffects || []).length / 3));
  if (p.userId && !privateView && pages > 1) v.components = [row(button('cardpage:' + p.userId + ':' + p.id + ':' + Math.max(0,page-1), '上一页 / 状态', undefined, page <= 0),
    button('cardpage:' + p.userId + ':' + p.id + ':' + Math.min(pages-1,page+1), '下一页 / 个人描述', undefined, page >= pages-1))];
  if(p.userId)v.components.push(row(button('profile:home:'+p.userId+':'+p.id,'角色设置 / 分配自由点')));
  v.rpgPortraits = p.portraits || {};
  v.embeds[0].setFooter({ text: '角色 ' + p.id + ' · '+(page+1)+'/'+pages+' · ' + (privateView ? '本人及GM可见' : '公开属性') }); return v;
}
function draftView(d) {
  return payload('确认角色 · 整套重掷剩余' + (3 - d.rerolls), d.name + '\n' +
    Object.entries(C.ATTRIBUTES).map(([k, n]) => n + ' ' + d.attributes[k]).join('　') +
    '\n性别：'+({male:'男性',female:'女性'}[d.gender]||'请下拉选择')+' · 年龄：'+(d.age == null ? '未设置' : d.age+'岁')+'\n适应性 ' + d.adaptation + '\n确认后获得2点自由属性点，属性掷骰锁定。', [
      row(select('profile:draftgender:'+d.userId+':'+d.id,'选择男性或女性',require('./character-panel').genders.map(g=>({...g,default:d.gender===g.value})))),
      row(button('profile:draftbio:'+d.userId+':'+d.id,'填写背景 / 外貌 / 信念'),button('profile:draftage:'+d.userId+':'+d.id,'填写年龄')),
      row(button('char:confirm:' + d.id, '确认角色', D.ButtonStyle.Success,!d.gender), button('char:reroll:' + d.id, '整套重掷', D.ButtonStyle.Secondary, d.rerolls >= 3)),
    ]);
}
function inventoryView(state, userId, viewerId, page = 0) {
  const p = M.player(state, userId), entries = Object.values(p.inventory);
  const count = Math.max(1, Math.ceil(entries.length / 12)); page = Math.max(0, Math.min(page, count - 1));
  const reserve = M.reserved(state, userId);
  const s = M.stats(p), pageItems = entries.slice(page * 12, page * 12 + 12);
  const body = '**' + p.name + '** · ' + entries.length + '种物品\n\n' + pageItems.map(i =>
    '**' + i.snapshot.name + '** ×' + i.quantity + ' · ' + i.snapshot.kind + ' · ' + C.kg(i.snapshot.weight) +
    '\n编号 ' + i.id + ' · 参考价值 ' + i.snapshot.value + (reserve.items[i.id] ? ' · 预留' + reserve.items[i.id] : '') +
    (M.equippedIds(p).includes(i.id) ? ' · 已装备' : M.isAttached(p, i.id) ? ' · 已装配' : '') +
    (i.snapshot.kind === '钥匙' ? ' · 钥匙剩余' + i.keyCharges : '') +
    (i.loaded ? ' · 载弹' + i.loaded.current + '/' + i.loaded.capacity : '')).join('\n') +
    '\n\n可用余额 ' + (p.balance - reserve.coins) + '　' + (page + 1) + '/' + count + '页';
  const result = payload('背包 · 仅本人和GM可见', body, [
    ...(pageItems.length ? [row(select('bagitem:' + userId + ':' + viewerId + ':' + page, '选择物品查看描述与使用效果',
      pageItems.map(i => ({ label: i.snapshot.name + ' ×' + i.quantity, value: i.id }))))] : []), row(
    button('bag:' + userId + ':' + viewerId + ':' + (page - 1), '上一页', undefined, page === 0),
    button('bag:' + userId + ':' + viewerId + ':' + (page + 1), '下一页', undefined, page === count - 1),
    button('bag:' + userId + ':' + viewerId + ':' + page, '刷新'))], 0x1abc9c);
  result.embeds[0].addFields(field('负重', C.kg(s.carried) + ' / ' + C.kg(s.limit) + (s.overloaded ? ' · 超重' : s.burdened ? ' · 减速' : ''), true),
    field('可用游戏币', p.balance - reserve.coins, true), field('抽取次数', '卡牌 ' + p.tickets.card + '\n' +
      (Object.entries(p.tickets.boxes).map(([k, v]) => k + ' ' + v).join('／') || '暂无箱子次数'), true));
  return result;
}
function itemView(state, userId, viewerId, ref, page = 0) {
  const p = M.player(state, userId), item = p.inventory[ref]; C.requireThat(item, '物品已不存在。');
  const t = item.snapshot, r = C.RARITIES.find(r => r.id === t.rarity) || C.RARITIES.at(-1);
  const sections = [t.kind === '钥匙' ? '剩余开门次数：' + item.keyCharges : '', t.description || '暂无描述', effectsText(t.effects),
    t.uniqueText || '', t.appearance || ''].filter(Boolean);
  if (['武器','技能'].includes(t.kind)) sections.push('固定命中 ' + t.hit + ' · 攻击距离 ' + (t.rangeMeters??t.range*50) + '米 · 有效 '+C.round2(M.modify(M.stats(p).effects,'range',t.rangeMeters??t.range*50))+'米'+(t.melee?'（近战同格）':'')+'\n伤害：' +
    Object.entries(t.damage || {}).filter(([, v]) => v).map(([k, v]) => C.DAMAGE_TYPES[k] + ' ' + v).join('／') +
    '\n' + (t.kind === '武器' ? '类型 ' + t.weaponType + (t.melee ? ' · 近战' : ' · 远程') : '行动 ' + t.action + ' · 吟唱 ' + t.casting) +
    (item.loaded ? '\n载弹 ' + item.loaded.current + '/' + item.loaded.capacity : ''));
  if(['武器','防具'].includes(t.kind)){const Dur=require('./durability');sections.push('耐久 '+Dur.current(item)+'/'+Dur.maximum(item)+(Dur.usable(item)?'':' · 已损坏'));}
  if(t.kind==='武器'&&t.armorWeakening?.amount)sections.push('护甲削弱 '+C.DAMAGE_TYPES[t.armorWeakening.type]+' '+t.armorWeakening.amount+'点／发或击');
  if(t.kind==='防具')sections.push('抗削弱 '+Object.entries(t.weakeningResistance||{}).map(([k,v])=>C.DAMAGE_TYPES[k]+' '+v).join('／'));
  if(t.kind==='修复道具')sections.push('修复 '+t.repairKinds.join('／')+' · 每件恢复 '+t.repairAmount+' 点耐久'+(t.repairMaxLoss?' · 每次削减上限 '+t.repairMaxLoss+' 点':' · 不削减耐久上限'));
  if(t.kind==='弹夹')sections.push('装弹量 '+t.capacity+' 发 · 兼容弹药 '+t.ammoType);
  if(t.kind==='弹药')sections.push('附加伤害：'+(Object.entries(t.damage||{}).filter(([,v])=>v).map(([k,v])=>C.DAMAGE_TYPES[k]+' '+v).join('／')||'无')+'\n附带异常：'+((t.conditions||[]).map(c=>c.template?.name+'·'+c.severity).join('、')||'无'));
  if(t.kind==='武器'&&item.loaded)sections.push('射击模式：'+(t.fireModes||['semi']).map(v=>v==='auto'?'全自动':'半自动').join('／')+(item.loaded.current===0?'\n⚠️ 弹夹已空：无弹药，请装填。':''));
  if (t.kind === '防具') sections.push('覆盖 ' + t.armorType + '\n' + Object.entries(t.defenses || {}).map(([k, v]) => C.DAMAGE_TYPES[k] + '防御 ' + v).join('／'));
  if (t.quality || t.origin || t.title) sections.push('品质 ' + (t.quality || '—') + ' · 产地 ' + (t.origin || '—') + '\n称号 ' + (t.title || '无'));
  if (item.attachments?.length) sections.push('配件：\n' + item.attachments.map(id => p.inventory[id]?.snapshot.name || id).join('\n'));
  const pages = sections.flatMap(s => Array.from({ length: Math.max(1, Math.ceil(s.length / 1800)) }, (_, n) => s.slice(n * 1800, (n + 1) * 1800)));
  page = Math.max(0, Math.min(page, pages.length - 1));
  const result = payload('物品 · ' + t.name, pages[page], [
    row(button('itempage:' + userId + ':' + viewerId + ':' + ref + ':' + (page - 1), '上一页', undefined, page === 0),
      button('itempage:' + userId + ':' + viewerId + ':' + ref + ':' + (page + 1), '下一页', undefined, page === pages.length - 1),
      button('bag:' + userId + ':' + viewerId + ':0', '返回背包'),
      ...(userId === viewerId && [...C.CONSUMABLES,'修复道具'].includes(t.kind) ? [button('baguse:' + userId + ':' + ref, '使用一件', D.ButtonStyle.Success, M.available(state, userId, ref) < 1)] : []))
  ], r.color);
  result.embeds[0].addFields(field('分类 / 稀有度', t.kind + ' / ' + r.name, true),
    field('数量 / 重量', item.quantity + ' / ' + C.kg(M.itemWeight(item)), true), field('参考价值', t.value, true));
  if (['武器', '技能'].includes(t.kind)) {
    const distance = t.rangeMeters ?? (t.range ?? 1) * 50;
    result.embeds[0].addFields(field('射程 / 攻击距离', '基础 ' + distance + '米 · 有效 ' +
      C.round2(M.modify(M.stats(p).effects, 'range', distance)) + '米' + (t.melee ? '\n近战仍须同格' : '\n远程按实际米数判定')));
  }
  if (t.kind === '武器') result.embeds[0].addFields(field('持握方式', require('./weapons').label(t) + (t.handedness && t.handedness !== 'auto' ? ' · GM手动设置' : ' · 按类型自动分类'), true));
  if (C.CONSUMABLES.includes(t.kind)) result.embeds[0].addFields(field('使用效果', '恢复HP ' + (t.heal || '0') +
    '\n解除：' + ((t.clearConditions || []).map(id => state.conditionTemplates[id]?.name || id).join('、') || '无') +
    (t.duration && t.effects.length ? '\n持续 ' + t.duration.count + (t.duration.kind === 'minutes' ? '分钟' : '次自身行动') : '')));
  result.embeds[0].setFooter({ text: item.id + ' · 模板v' + item.version + ' · ' + (page + 1) + '/' + pages.length });
  return result;
}
function battleView(state, b) {
  const actorAt = {};
  b.actors.forEach((a, i) => { const key = Math.floor(a.x / 50) + ',' + Math.floor(a.y / 50); actorAt[key] = actorAt[key] ? '**' : String(i + 1).padStart(2, '0'); });
  let grid = '';
  for (let y = 0; y < b.height; y++) {
    const cells = [];
    for (let x = 0; x < b.width; x++) cells.push(actorAt[x + ',' + y] || ({ blocked: '##', difficult: '~~' }[b.terrain[x + ',' + y]] || '..'));
    grid += cells.join(' ') + '\n';
  }
  const current = b.actors.find(a => a.id === b.current?.actorId);
  const status = { recruiting: '报名中', active: '进行中', paused: '已暂停', ended: '已结束' }[b.status];
  const fence = String.fromCharCode(96).repeat(3);
  const header = status + ' · 动作点推进 ' + b.wave + ' · 每格50米\n' + (b.environment || '') +
    '\n当前：' + (current?.name || '等待GM') + (b.current ? ' · 快速' + b.current.quick + ' 正式' + b.current.formal + ' 移动' + b.current.move + '米' : '') +
    (b.pauseReason ? '\n' + b.pauseReason : '') + '\n\n' + fence + 'text\n' + grid + fence;
  const details = b.actors.map((a, n) => {
      const p = B.actorCharacter(state, a), s = M.stats(p);
      return (n + 1) + '. ' + a.name.slice(0, 24) + ' [' + (a.team === 'ally' ? '友方' : '敌方') + '] HP ' + p.hp + '/' + s.maxHP +
        ' AP ' + p.ap + ' (' + a.x + ',' + a.y + ') ' + (a.deathId ? '💀 已死亡' : a.retreated ? '离场' : '') +
        '\n' + a.id + (p.conditions.length ? ' · ' + p.conditions.map(c => c.template.name + '·' + c.severity).join('、').slice(0, 60) : '');
    }).join('\n') + '\n\n最近记录\n' + b.recent.slice(-4).map(e => e.message).join('\n');
  const rows = b.status === 'ended' ? [] : b.status === 'recruiting' ? [row(button('join:' + b.id, '参与战斗', D.ButtonStyle.Success),
    button('withdraw:' + b.id, '撤回报名'), button('start:' + b.id, 'GM正式开战', D.ButtonStyle.Primary),
    button('battle:' + b.id, '查看战场'))] : [row(button('personal:' + b.id, '开始行动／个人面板', D.ButtonStyle.Primary),
      button('battle:' + b.id, '刷新战场'), button('control:' + b.id, 'GM操作'))];
  if (b.pending) rows.push(row(button('defense:' + b.id + ':' + b.pending.id, '打开防守面板', D.ButtonStyle.Danger)));
  const color = b.status === 'ended' ? 0x95a5a6 : 0x5865f2;
  const result = payload('战场 · ' + b.name, header, rows, color);
  result.embeds.push(embed('参战者与记录', details, color));
  result.embeds[0].setFooter({ text: '战斗 ' + b.id + ' · ' + status });
  return result;
}
function personalView(state, b, a, viewer, tab = 'overview', statusPage = 0) {
  const p = B.actorCharacter(state, a), s = M.stats(p), turn = b.current?.actorId === a.id ? b.current : null;
  if (a.deathId) return payload('角色已死亡 · ' + a.name, '该角色不能继续操作。死亡记录已保存。', []);
  if (b.status === 'ended') return payload('战斗已结束 · ' + b.name, '操作面板已关闭。\n' + a.name + ' · HP ' + Math.min(p.hp, s.maxHP) + '/' + s.maxHP, [], 0x95a5a6);
  const prefix = b.id + ':' + a.id + ':' + viewer + ':' + (turn?.id || 'look');
  let body = characterView(p, true).embeds[0].data.description + '\n\n位置 (' + a.x + ',' + a.y + ')　动作点 ' + p.ap +
    '\n' + (turn ? '快速 ' + turn.quick + '／正式 ' + turn.formal + '／剩余移动 ' + turn.move + '米' : '当前不是此角色的行动机会。') +
    '\n吟唱：' + (a.casting ? a.casting.name + ' ' + a.casting.count + '/' + a.casting.required + (a.casting.confirmed ? ' · 已确认' : '') : '无') +
    '\n'+W.describe(p)+
    W.equipped(p).filter(ref=>p.inventory[ref].loaded?.current===0).map(ref=>'\n⚠️ '+p.inventory[ref].snapshot.name+'：无弹药，请装填。').join('')+
    W.equipped(p).filter(ref=>!require('./durability').usable(p.inventory[ref])).map(ref=>'\n⚠️ '+p.inventory[ref].snapshot.name+'耐久为0，请修复。').join('')+
    (!B.abilities(p).length?'\n⚠️ 先装备可用武器才能攻击。':'')+
    '\n装备：' + (M.equippedIds(p).map(ref => p.inventory[ref]?.snapshot.name).join('、').slice(0, 320) || '无') +
    '\n饰品槽位 头' + p.slots.head + ' 身' + p.slots.body + ' 戒' + p.slots.ring + '／卡牌槽位 ' + p.slots.card;
  const statePages = Math.max(1, Math.ceil(p.conditions.length / 3), Math.ceil((p.temporaryEffects || []).length / 3));
  statusPage = Math.max(0, Math.min(Number(statusPage) || 0, statePages - 1));
  if (tab === 'status') body += '\n\n异常详情 ' + (statusPage + 1) + '/' + statePages + '\n' +
    (p.conditions.slice(statusPage * 3, statusPage * 3 + 3).map(c => {
      const stage = c.template.levels[c.severity];
      return '**' + c.template.name + '·' + c.severity + '** ' + c.id +
        '\n持续 ' + (c.remaining === null ? stage.duration.kind === 'battle' ? '一场战斗' : '直到解除' : c.remaining + '次行动') +
        ' · 恶化 ' + c.elapsed + '/' + (stage.worsenAfter || '关闭') +
        '\n' + (stage.description || c.template.description || '无说明').slice(0, 160) +
        '\n数值修正：' + (c.modifiers.map(e => C.targetLabel(e.target) + ' ' + e.value).join('、').slice(0, 150) || '无持续属性修正');
    }).join('\n\n') || '无异常。') + '\n\n**食物与药品持续效果**\n' + temporaryText(p, statusPage);
  const rows = [row(select('tab:' + prefix, '操作分页', [
    ['overview', '概览'], ['move', '移动'], ['quick', '快速行动'], ['formal', '正式行动'], ['status', '装备与状态']
  ].map(([value, label]) => ({ value, label, default: value === tab }))))];
  const enabled = !!turn && b.status === 'active' && !b.pending;
  if (tab === 'move') rows.push(row(button('move:' + prefix, '输入移动位置', D.ButtonStyle.Primary, !enabled || s.overloaded)));
  if (tab === 'quick') rows.push(row(button('attackpick:' + prefix + ':quick:0', '快捷技能／超凡攻击', D.ButtonStyle.Primary, !enabled || !turn.quick),
    button('reloadweaponpick:' + prefix + ':0', '装填（选择武器）', undefined, !enabled || !turn.quick), button('weaponpick:' + prefix + ':0', '切换武器', undefined, !enabled || !turn.quick),
    button('itempick:' + prefix + ':0', '使用道具', undefined, !enabled || !turn.quick), button('cast:' + prefix, '确认吟唱', undefined, !enabled || !turn.quick)));
  if (tab === 'formal') rows.push(row(button('attackpick:' + prefix + ':formal:0', '攻击／释放技能', D.ButtonStyle.Primary, !enabled || !turn.formal),
    button('flee:' + prefix, '逃跑', undefined, !enabled || !turn.formal)));
  if (tab === 'status') rows.push(row(button('equippick:' + prefix + ':0', '装备／卸下', D.ButtonStyle.Primary, !['paused', 'recruiting'].includes(b.status)),
    button('attachpick:' + prefix + ':0', '装配／拆下配件', undefined, !['paused', 'recruiting'].includes(b.status)),
    button('statuspage:' + prefix + ':' + (statusPage - 1), '上一页异常', undefined, statusPage === 0),
    button('statuspage:' + prefix + ':' + (statusPage + 1), '下一页异常', undefined, statusPage >= statePages - 1)));
  rows.push(row(button('pass:' + prefix + ':quick', '放弃快速行动', undefined, !enabled || !turn.quick),
    button('pass:' + prefix + ':formal', '放弃正式行动', undefined, !enabled || !turn.formal),
    button('finish:' + prefix, '结束本次行动', D.ButtonStyle.Success, !enabled)));
  rows.push(row(button('view:' + prefix + ':' + tab + ':' + statusPage, '刷新'), button('battle:' + b.id, '查看战场')));
  if(a.userId===viewer)rows[rows.length-1].addComponents(button('profile:home:'+a.userId+':'+p.id,'角色设置 / 自由点'));
  const v = payload('个人行动面板 · ' + a.name, body, rows);
  v.rpgPortraits = p.portraits || {};
  v.embeds[0].addFields(...characterView(p, true, statusPage).embeds[0].data.fields);
  return v;
}
function offerView(state, offer, viewer) {
  const body = '交易编号 ' + offer.id + ' · ' + ({ editing: '等待报价', ready: '等待确认', completed: '已完成', cancelled: '已取消', expired: '已过期' }[offer.status]) +
    '\n截止 <t:' + Math.floor(offer.expiresAt / 1000) + ':R>\n报价版本 ' + offer.revision +
    (offer.type === 'buyback' ? '\nGM收购总价：' + offer.price : '') +
    '\n\n' + Object.entries(offer.sides).map(([uid, side]) => '<@' + uid + '>：' + (side.supplied ? '' : '尚未报价') +
      '\n游戏币 ' + side.coins + '\n' + (side.items.map(e => (state.players[uid]?.inventory[e.id]?.snapshot.name || e.id) + ' ×' + e.quantity).join('、') || '无物品') +
      '\n' + (offer.confirmations[uid] === offer.revision ? '已确认' : '未确认')).join('\n\n');
  const active = M.activeOffer(offer);
  return payload('资产交换 · 仅交易双方和GM可见', body, [row(
    button('quote:' + offer.id + ':' + viewer, '填写自己的报价', D.ButtonStyle.Primary, !active || offer.type !== 'trade' || !offer.sides[viewer]),
    button('offerconfirm:' + offer.id + ':' + viewer + ':' + offer.revision, '确认当前报价', D.ButtonStyle.Success, !active || offer.status !== 'ready'),
    button('offercancel:' + offer.id + ':' + viewer, '取消', D.ButtonStyle.Danger, !active),
    button('offer:' + offer.id, '刷新'))]);
}
module.exports = { D, E, row, button, select, embed, payload, modal, gm, playerRole, memberRoles,
  characterView, draftView, inventoryView, itemView, battleView, personalView, offerView, field, bar, effectsText, temporaryText };
