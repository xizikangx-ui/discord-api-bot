'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), U = require('./ui');
const { requireThat: ok, number: num } = C;
const { payload, row, button, select, modal, D, field } = U;
const statusLabel = { recruiting: '招募中', active: '战斗中', paused: '已暂停', ended: '已结束' };
function createBattleGM(context) {
  const { snapshot, tx, needGM, battle, publishBattle, pickView } = context;
  function view(s, b) {
    if (b.status === 'ended') return U.battleView(s, b);
    const v = payload('GM战斗操作 · ' + b.name, '状态 **' + statusLabel[b.status] + '** · ' + b.actors.length +
      '名参战者\n通过下拉菜单配置NPC、阵容、位置、生命、异常和地形。调整阵容前请暂停战斗。', [
      row(select('gmui:' + b.id + ':tab', '选择管理操作', [
        { label: '添加已有NPC', value: 'npc' }, { label: '角色位置、阵营与生命', value: 'actors' },
        { label: '施加或解除异常', value: 'conditions' }, { label: '调整地形', value: 'terrain' },
        { label: '移出参战者', value: 'remove' }
      ])),
      row(button('gmcontrol:' + b.id + ':pause', '暂停', undefined, b.status !== 'active'),
        button('gmcontrol:' + b.id + ':resume', '恢复', D.ButtonStyle.Success, b.status !== 'paused'),
        button('gmcontrol:' + b.id + ':finish', '代结束行动', undefined, !b.current || !!b.pending),
        button('gmui:' + b.id + ':endpreview', '结束战斗', D.ButtonStyle.Danger)),
      ...(b.status === 'recruiting' ? [row(button('gmstart:' + b.id + ':normal', '正式开战', D.ButtonStyle.Success),
        button('gmstart:' + b.id + ':ally', '确认友方偷袭'), button('gmstart:' + b.id + ':enemy', '确认敌方偷袭'))] : []),
      row(button('gmui:' + b.id + ':npc:0', 'NPC模板下拉'), button('gmui:' + b.id + ':current', '操作当前角色', D.ButtonStyle.Primary, !b.current),
        button('gmui:' + b.id + ':view', '刷新GM面板'))
    ]);
    v.embeds[0].setFooter({ text: b.id + ' · GM个人操作面板 · 战斗结束后清理' }); return v;
  }
  function editable(b) { ok(['recruiting', 'paused'].includes(b.status) && !b.pending, '请先暂停战斗，并完成待响应的攻击。'); }
  function pick(s, b, action, entries, page) {
    const v = pickView('GM · ' + ({ npc: '选择已有NPC', actors: '选择角色', conditions: '选择角色', remove: '选择移出角色' }[action] || '选择'), entries,
      'gmui:' + b.id + ':' + action, page);
    // The two navigation labels must use distinct IDs.
    v.components.push(row(button('gmui:' + b.id + ':view', '返回GM概览'))); return v;
  }
  function actorView(s, b, a) {
    const p = B.actorCharacter(s, a), stats = M.stats(p);
    const v = payload('GM角色配置 · ' + a.name, '阵营 ' + (a.team === 'ally' ? '友方' : '敌方') +
      '\n位置 (' + a.x + ', ' + a.y + ')米\n生命 ' + U.bar(p.hp, stats.maxHP) + ' ' + p.hp + '/' + stats.maxHP, [
      row(button('gmui:' + b.id + ':position:' + a.id, '位置 / 阵营', D.ButtonStyle.Primary),
        button('gmui:' + b.id + ':hp:' + a.id, '调整生命'), button('gmui:' + b.id + ':conditions:select:' + a.id, '调整异常')),
      row(button('gmui:' + b.id + ':view', '返回GM概览'))
    ]); v.embeds[0].setFooter({ text: '角色 ' + a.id + ' · ' + b.id }); return v;
  }
  function conditions(s, b, a, page = 0) {
    const count = Math.max(1, Math.ceil(B.actorCharacter(s, a).conditions.length / 20));
    page = Math.max(0, Math.min(Number(page) || 0, count - 1));
    const p = B.actorCharacter(s, a), v = payload('GM异常 · ' + a.name, p.conditions.map(c => c.template.name + ' · ' +
      c.severity).slice(page * 20, page * 20 + 20).join('\n') || '暂无异常', [
      row(button('gmui:' + b.id + ':conditionpick:' + a.id + ':0', '施加已录入异常', D.ButtonStyle.Primary)),
      ...(p.conditions.length ? [row(select('gmui:' + b.id + ':clear:' + a.id, '选择要解除的异常',
        p.conditions.slice(page * 20, page * 20 + 20).map(c => ({ label: c.template.name, value: c.id }))))] : []),
      row(button('gmui:' + b.id + ':conditionpage:' + a.id + ':' + (page - 1), '上一页异常', undefined, !page),
        button('gmui:' + b.id + ':conditionpage:' + a.id + ':' + (page + 1), '下一页异常', undefined, page >= count - 1),
        button('gmui:' + b.id + ':view', '返回GM概览'))
    ]); return v;
  }
  async function openModal(i, s) {
    if (i.isModalSubmit?.() || !i.customId?.startsWith('rpg:gmui:')) return false;
    const [, ref, action, actorId] = i.customId.split(':').slice(1);
    if (!['position', 'hp', 'terrainvalue'].includes(action)) return false;
    needGM(s, i.member); const b = battle(s, ref); editable(b);
    const a = action !== 'terrainvalue' ? B.actorById(b, actorId) : null;
    const inputs = action === 'position' ? [
      { key: 'x', label: '横坐标（米）', value: a.x }, { key: 'y', label: '纵坐标（米）', value: a.y },
      { key: 'team', label: '阵营：友方 或 敌方', value: a.team === 'ally' ? '友方' : '敌方' }
    ] : action === 'hp' ? [{ key: 'hp', label: '生命值', value: B.actorCharacter(s, a).hp }] : [
      { key: 'x', label: '列（从1开始）', value: 1 }, { key: 'y', label: '行（从1开始）', value: 1 }
    ];
    await i.showModal(modal('gmui:' + ref + ':' + action + 'submit:' + (actorId || ''), 'GM ' +
      ({ position: '位置与阵营', hp: '生命调整', terrainvalue: '地形坐标' }[action]), inputs)); return true;
  }
  async function component(i, member) {
    const [, ref, action, arg, extra] = i.customId.split(':').slice(1);
    const s = snapshot(i.guildId); needGM(s, member); const b = battle(s, ref);
    if (b.status === 'ended') return U.battleView(s, b);
    if (action === 'view') return view(s, b);
    if (action === 'current') {
      ok(b.current, '当前没有行动者。'); const a = B.actorById(b, b.current.actorId);
      return U.personalView(s, b, a, i.user.id);
    }
    if (action === 'endpreview') return payload('确认结束战斗', '将保留战斗结果，撤销公共和个人面板上的操作按钮。', [
      row(button('gmcontrol:' + ref + ':end', '确认结束并清理面板', D.ButtonStyle.Danger), button('gmui:' + ref + ':view', '返回'))]);
    const selected = action === 'tab' ? i.values[0] : action;
    if (['npc', 'actors', 'conditions', 'remove'].includes(selected)) {
      if (arg === 'select') {
        const id = extra || i.values[0];
        if (selected === 'npc') {
          const t = s.npcTemplates[id]; ok(t, 'NPC模板不存在。');
          const v = payload('NPC预览 · ' + t.name, t.description || '选择阵营后加入战斗。', [
            row(select('gmui:' + ref + ':npcadd:' + id + ':' + t.version, '选择加入的阵营', [
              { label: '友方NPC', value: 'ally' }, { label: '敌方NPC', value: 'enemy' }])),
            row(button('gmui:' + ref + ':npc:0', '返回NPC列表'), button('gmui:' + ref + ':view', '取消选择'))
          ]);
          v.embeds[0].addFields(field('属性', Object.entries(t.attributes).map(([k, v]) => C.ATTRIBUTES[k] + ' ' + v).join(' · ')),
            field('装备数量', t.itemIds?.length || 0, true), field('生命上限', t.hpMax, true)); v.embeds[0].setFooter({ text: t.id + ' · v' + t.version }); return v;
        }
        const a = B.actorById(b, id);
        if (selected === 'actors') return actorView(s, b, a);
        if (selected === 'conditions') return conditions(s, b, a);
        return payload('确认移出 · ' + a.name, '移出前必须暂停战斗，并完成待响应攻击。', [
          row(button('gmui:' + ref + ':removedo:' + id, '确认移出', D.ButtonStyle.Danger), button('gmui:' + ref + ':view', '取消'))
        ]);
      }
      const entries = selected === 'npc' ? Object.values(s.npcTemplates).map(t => ({ label: t.name, value: t.id, description: '版本 ' + t.version })) :
        b.actors.map(a => ({ label: a.name + (a.npc ? ' · NPC' : ''), value: a.id }));
      return pick(s, b, selected, entries, action === 'tab' ? 0 : Number(arg) || 0);
    }
    if (selected === 'terrain') return payload('调整战场地形', '选择类型，再填写所在列和行。', [
      row(select('gmui:' + ref + ':terrainselect', '地形类型', [
        { label: '普通', value: 'normal' }, { label: '困难（双倍移动消耗）', value: 'difficult' }, { label: '阻挡', value: 'blocked' }])),
      row(button('gmui:' + ref + ':view', '返回'))
    ]);
    if (action === 'terrainselect') return payload('地形坐标', '已选择 ' + i.values[0] + '。点击填写坐标。', [
      row(button('gmui:' + ref + ':terrainvalue:' + i.values[0], '填写坐标', D.ButtonStyle.Primary), button('gmui:' + ref + ':view', '取消'))
    ]);
    if (action === 'conditionpick') {
      const entries = Object.values(s.conditionTemplates).map(t => ({ label: t.name, value: t.id }));
      if (extra === 'select') return payload('异常等级', '选择要施加的等级。', [
        row(select('gmui:' + ref + ':conditionapply:' + arg + ':' + i.values[0], '等级', [
          ...C.SEVERITIES.filter(level => s.conditionTemplates[i.values[0]]?.levels[level]).map(level => ({ label: level, value: level }))])),
        row(button('gmui:' + ref + ':conditions:select:' + arg, '返回角色异常'))
      ]);
      const v = pickView('选择异常模板', entries, 'gmui:' + ref + ':conditionpick:' + arg, Number(extra) || 0);
      v.components.push(row(button('gmui:' + ref + ':conditions:select:' + arg, '返回'))); return v;
    }
    if (action === 'conditionpage') return conditions(s, b, B.actorById(b, arg), Number(extra));
    await tx(i, st => {
      needGM(st, member); const live = battle(st, ref); editable(live);
      if (action === 'npcadd') {
        ok(st.npcTemplates[arg]?.version === Number(extra), 'NPC模板已更新，请重新选择。');
        B.addNPC(st, live, arg, i.values[0]);
      } else if (action === 'terrainvaluesubmit') B.setTerrain(live, i.fields.getTextInputValue('x'), i.fields.getTextInputValue('y'), arg);
      else {
        const a = B.actorById(live, arg), p = B.actorCharacter(st, a);
        if (action === 'positionsubmit') {
          const value = i.fields.getTextInputValue('team').trim(), team = ({ '友方': 'ally', '敌方': 'enemy', ally: 'ally', enemy: 'enemy' })[value];
          ok(team, '阵营请填写友方或敌方。');
          B.position(live, arg, i.fields.getTextInputValue('x'), i.fields.getTextInputValue('y'), team);
        } else if (action === 'hpsubmit') {
          p.hp = num(i.fields.getTextInputValue('hp'), '生命', 0, M.stats(p).maxHP);
        } else if (action === 'conditionapply') B.record(live, 'GM给' + a.name + '施加异常并结算豁免。',
          B.applyCondition(st, p, { id: extra, severity: i.values[0] }));
        else if (action === 'clear') {
          ok(p.conditions.some(c => c.id === i.values[0]), '异常已失效。'); p.conditions = p.conditions.filter(c => c.id !== i.values[0]); M.syncHP(p);
        } else if (action === 'removedo') {
          live.actors = live.actors.filter(x => x.id !== arg); live.queue = live.queue.filter(x => x.actorId !== arg);
          if (live.current?.actorId === arg) live.current = null; p.ap = 0; delete a.casting;
        } else throw new Error('GM操作已失效，请重新打开面板。');
        B.record(live, 'GM ' + i.user.id + '操作' + a.name + '：' + action + '。');
      }
      return { battleId: ref, action };
    }, 'GM战斗面板');
    await publishBattle(i.guildId, ref);
    const next = snapshot(i.guildId), live = battle(next, ref);
    return ['conditionapply', 'clear'].includes(action) ? conditions(next, live, B.actorById(live, arg)) :
      ['positionsubmit', 'hpsubmit'].includes(action) ? actorView(next, live, B.actorById(live, arg)) : view(next, live);
  }
  return { view, component, openModal };
}
module.exports = { createBattleGM };
