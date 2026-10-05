'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), F = require('./forms'), U = require('./ui');
const { requireThat: ok, number: num } = C;
const { D, row, button, select, payload, modal } = U;
function createHandlers(context) {
  const { snapshot, tx, needGM, needConfig, owner, battle, canActor, configView, safeRoles, publishRoles,
    claim, formView, offerAccess, catalogView, pickView, publishBattle, store } = context;
  const parts = i => i.customId.split(':').slice(1);
  function prefixContext(i, s, args, member = i.member, requireTurn = false) {
    const [battleId, actorId, viewer, turnId] = args;
    owner(i, viewer);
    const b = battle(s, battleId), a = canActor(s, b, actorId, member, i.user.id);
    if (requireTurn) { const current = B.current(s, b, turnId); ok(current.actor.id === actorId, '行动者已改变。'); }
    return { b, a, p: B.actorCharacter(s, a), turnId, prefix: args.slice(0, 4).join(':') };
  }
  async function openModal(i, s) {
    if (i.isModalSubmit?.()) return false;
    const [action, ...args] = parts(i);
    if (action === 'formedit') {
      const f = F.owned(s, args[0], i.user.id);
      if (f.kind === 'rolepanel') needConfig(i.member); else needGM(s, i.member);
      const def = F.fields(f)[f.field];
      if (!['text', 'long', 'number'].includes(def.type)) return false;
      await i.showModal(modal('formvalue:' + f.id + ':' + f.field, def.label,
        [{ key: 'value', label: def.label, long: def.type === 'long', required: false, value: F.get(f.data, def.key) }]));
      return true;
    }
    if (action === 'formtarget') {
      const f = F.owned(s, args[0], i.user.id); needGM(s, i.member);
      const def = F.fields(f)[f.field], conditional = def.type === 'conditionEffects';
      const target = i.values[0], targets = conditional ? C.CONDITION_TARGETS : C.EFFECT_TARGETS;
      ok(targets.includes(target) && ['effects', 'conditionEffects'].includes(def.type), '效果目标已失效。');
      await i.showModal(modal('formeffectvalue:' + f.id + ':' + f.field + ':' + targets.indexOf(target) + ':' + f.effectOp,
        '新增' + C.targetLabel(target), [{ key: 'value', label: conditional ? '非负扣除数值或骰式，例如1d6' : '修正数值，可为负数', value: conditional ? '1' : '0' }]));
      return true;
    }
    if (action === 'move') {
      const { a, prefix } = prefixContext(i, s, args, i.member, true);
      await i.showModal(modal('movevalue:' + prefix, '移动（米）', [
        { key: 'x', label: '横向米数', value: a.x }, { key: 'y', label: '纵向米数', value: a.y }]));
      return true;
    }
    if (action === 'quote') {
      owner(i, args[1]); const offer = offerAccess(s, args[0], i.member, i.user.id);
      ok(offer.type === 'trade' && offer.sides[i.user.id] && M.activeOffer(offer), '不能修改此报价。');
      const side = offer.sides[i.user.id];
      await i.showModal(modal('quotevalue:' + offer.id + ':' + i.user.id, '填写自己的报价', [
        { key: 'items', label: '每行：背包物品编号 数量，最多10种', long: true, required: false,
          value: side.items.map(e => e.id + ' ' + e.quantity).join('\n') },
        { key: 'coins', label: '游戏币（没有填0）', value: side.coins }
      ]));
      return true;
    }
    return false;
  }
  function defenseView(s, b, pendingId, member, uid) {
    ok(b.pending?.id === pendingId, '攻击已结算。');
    const target = B.actorById(b, b.pending.targetId);
    if (target.userId) ok(target.userId === uid, '防守由被攻击玩家本人选择。'); else needGM(s, member);
    const hit = b.pending;
    return payload('免费防守反应 · ' + target.name, hit.attackName + '，固定命中 ' + hit.hit +
      '\n伤害分量：' + Object.entries(hit.damage).map(([k, v]) => C.DAMAGE_TYPES[k] + ' ' + v).join('、') +
      '\n截止 <t:' + Math.floor(hit.expiresAt / 1000) + ':R>；60秒未响应默认纯防御。\n闪避：2d20取低＋有效敏捷及修正，严格大于命中成功；同时防守且闪避失败时防御减半。', [
      row(...[['defend', '防御'], ['dodge', '闪避'], ['both', '同时'], ['none', '放弃']].map(([choice, label]) =>
        button('defend:' + b.id + ':' + hit.id + ':' + uid + ':' + choice, label, choice === 'none' ? D.ButtonStyle.Danger : D.ButtonStyle.Primary)))
    ]);
  }
  async function formComponent(i, member, action, args) {
    const s = snapshot(i.guildId), formId = args[0], f = F.owned(s, formId, i.user.id);
    if (f.kind === 'rolepanel') needConfig(member); else needGM(s, member);
    if (action === 'formpreview') return F.view(s, f, true);
    if (action === 'formdetail') {
      const def = F.fields(f)[f.field];
      return payload('字段全文 · ' + def.label, F.display(F.get(f.data, def.key), def, s, 4000),
        [row(button('formback:' + f.id, '返回草稿'), button('formedit:' + f.id, '编辑：' + def.label, D.ButtonStyle.Primary))]);
    }
    if (action === 'formback') return F.view(s, f);
    if (action === 'formexit') return payload('草稿已保存', '草稿编号 ' + f.id + '；用 /gm 草稿 恢复。配置用草稿也可从领取面板列表恢复。');
    if (action === 'formpublish') {
      if (f.kind === 'rolepanel') await safeRoles(i.guild, f.data.roleIds, s);
      const result = await tx(i, st => {
        const draft = F.owned(st, formId, i.user.id);
        if (draft.kind === 'rolepanel') needConfig(member); else needGM(st, member);
        return F.publish(st, draft);
      }, '发布跑团模板');
      if (f.kind === 'rolepanel') await publishRoles(i, result.id);
      return payload('已发布', result.name || result.title, [row(button('formback:' + formId, '继续修改草稿'))]);
    }
    if (action === 'formedit') {
      const def = F.fields(f)[f.field];
      if (['choice', 'refs', 'multi', 'conditions'].includes(def.type)) return F.choiceView(s, f);
      if (['effects', 'conditionEffects'].includes(def.type)) return F.effectsView(s, f);
      if (def.type === 'roles') return payload('选择领取身份组', '排除GM、管理操作角色、危险权限和托管角色。', [
        row(new D.RoleSelectMenuBuilder().setCustomId('rpg:formroles:' + formId).setPlaceholder('可领取的身份组').setMinValues(0).setMaxValues(20)),
        row(button('formback:' + formId, '返回草稿'))]);
      ok(def.type === 'bool', '请重新打开编辑字段。');
    }
    await tx(i, st => {
      const draft = F.owned(st, formId, i.user.id);
      const defs = F.fields(draft), def = defs[draft.field];
      if (action === 'formfield') { draft.field = num(i.values[0], '字段', 0, defs.length - 1); draft.choicePage = 0; }
      else if (action === 'formpage') { draft.page = num(args[1], '页', 0, Math.ceil(defs.length / 20) - 1); draft.field = draft.page * 20; }
      else if (action === 'formedit') F.set(draft.data, def.key, !F.get(draft.data, def.key));
      else if (action === 'formdelete') { delete st.forms[formId]; return '草稿已删除。'; }
      else if (action === 'formchoicepage') draft.choicePage = num(args[1], '页', 0, Math.max(0, Math.ceil(F.options(st, def).length / 25) - 1));
      else if (action === 'formchoice') F.setChoice(st, draft, num(args[1], '页', 0, 100000), i.values);
      else if (action === 'formroles') {
        ok(def.type === 'roles', '字段已变化。');
        F.set(draft.data, def.key, i.values);
      } else if (action === 'formclear') {
        ok(['effects', 'conditionEffects', 'multi', 'refs', 'conditions'].includes(def.type), '该字段不能清空。');
        F.set(draft.data, def.key, []);
      } else if (action === 'formop') draft.effectOp = draft.effectOp === 'add' ? 'percent' : 'add';
      else if (action === 'formremoveeffect') {
        ok(['effects', 'conditionEffects'].includes(def.type), '字段已变化。');
        const effects = F.get(draft.data, def.key); const n = num(i.values[0], '效果编号', 0, effects.length - 1); effects.splice(n, 1);
      } else if (action === 'formvalue') {
        const selected = defs[num(args[1], '字段', 0, defs.length - 1)];
        ok(['text', 'long', 'number'].includes(selected.type), '字段类型已变化。');
        let value = i.fields.getTextInputValue('value').trim();
        if (selected.type === 'number') value = num(value, selected.label, 0, C.MAX_MONEY, false);
        else value = C.text(value, selected.label, selected.type === 'long' ? 2000 : 100, true);
        F.set(draft.data, selected.key, value);
      } else if (action === 'formeffectvalue') {
        const selected = defs[num(args[1], '字段', 0, defs.length - 1)], conditional = selected.type === 'conditionEffects';
        ok(['effects', 'conditionEffects'].includes(selected.type), '字段类型已变化。');
        const targets = conditional ? C.CONDITION_TARGETS : C.EFFECT_TARGETS;
        const target = targets[num(args[2], '效果目标', 0, targets.length - 1)], value = i.fields.getTextInputValue('value').trim();
        const effects = F.get(draft.data, selected.key); ok(effects.length < (conditional ? 20 : 30), '效果数量达到上限。');
        if (conditional) { const result = C.dice(value, 'normal', min => min); ok(result.total >= 0, '扣除必须非负。'); effects.push({ target, amount: value }); }
        else { ok(['add', 'percent'].includes(args[3]), '运算已失效。'); effects.push({ target, op: args[3], value: num(value, '修正', -1000000, 1000000, false) }); }
      } else throw new Error('草稿操作未识别。');
      draft.updatedAt = Date.now();
      draft.version = (draft.version || 0) + 1;
      return { formId };
    });
    if (action === 'formdelete') return payload('已删除草稿', formId);
    const next = snapshot(i.guildId), draft = F.owned(next, formId, i.user.id);
    if (['formchoicepage', 'formchoice'].includes(action)) return F.choiceView(next, draft);
    if (['formop', 'formremoveeffect', 'formeffectvalue'].includes(action)) return F.effectsView(next, draft);
    return F.view(next, draft);
  }
  async function component(i, member) {
    const [action, ...args] = parts(i), uid = i.user.id, s = snapshot(i.guildId);
    if (action.startsWith('form')) return formComponent(i, member, action, args);
    if (action === 'configview') { needConfig(member); return configView(s); }
    if (action === 'config') {
      needConfig(member);
      if (args[0] === 'channel' && i.values.length) await context.textChannel(i.guildId, i.values[0]);
      await tx(i, st => {
        if (args[0] === 'gm') st.config.gmRoleIds = i.values;
        else if (args[0] === 'player') st.config.playerRoleIds = i.values;
        else if (args[0] === 'channel') st.config.announcementChannelId = i.values[0] || null;
        else throw new Error('配置字段无效。');
        return st.config;
      });
      return configView(snapshot(i.guildId));
    }
    if (action === 'newroles') {
      needConfig(member);
      const f = await tx(i, st => F.create(st, uid, 'rolepanel'));
      return F.view(snapshot(i.guildId), f);
    }
    if (action === 'rolelist' || action === 'drafts') {
      const page = Number(args[0] || 0);
      if (action === 'rolelist') {
        needConfig(member);
        if (args[0] === 'select') {
          const value = i.values[0];
          if (value.startsWith('draft-')) return formView(s, value.slice(6), uid);
          const panel = s.rolePanels[value.slice(6)]; ok(panel, '领取面板已失效。');
          const f = await tx(i, st => {
            const draft = F.create(st, uid, 'rolepanel', null, panel.id);
            draft.data.labels = Object.entries(panel.labels).map(([id, label]) => id + '=' + label).join('\n');
            return draft;
          });
          return F.view(snapshot(i.guildId), f);
        }
        const roles = Object.values(s.rolePanels);
        const drafts = Object.values(s.forms).filter(f => f.owner === uid && f.kind === 'rolepanel');
        return pickView('领取身份组面板或草稿', [...roles.map(p => ({ label: p.title, value: 'panel-' + p.id })),
          ...drafts.map(f => ({ label: '草稿：' + f.data.title, value: 'draft-' + f.id }))], 'rolelist', page);
      }
      needGM(s, member);
      if (args[0] === 'select') return formView(s, i.values[0], uid);
      return pickView('自己的持久草稿', Object.values(s.forms).filter(f => f.owner === uid && f.data && !f.done)
        .map(f => ({ label: f.data.name || f.data.title || f.kind, value: f.id })), 'drafts', page);
    }
    if (action === 'claim' || action === 'claimmulti') return payload('身份组领取', await claim(i, args[0], action === 'claim' ? [args[1]] : i.values, action === 'claim'));
    if (action === 'char') {
      if (args[0] === 'reroll') {
        const draft = await tx(i, st => {
          ok(st.characterDrafts[uid]?.id === args[1], '待确认属性已经变化，请重新 /建卡 查看。');
          return M.rollCharacter(st, uid, st.characterDrafts[uid]?.name, true);
        });
        return U.draftView(draft);
      }
      await tx(i, st => {
        ok(st.characterDrafts[uid]?.id === args[1], '待确认属性已经变化，请重新 /建卡 查看。');
        const p = M.confirmCharacter(st, uid); return { characterId: p.id, attributes: p.attributes, adaptation: p.adaptation };
      });
      return U.characterView(M.player(snapshot(i.guildId), uid));
    }
    if (action === 'bag') {
      owner(i, args[1]); if (args[0] !== uid) needGM(s, member);
      return U.inventoryView(s, args[0], uid, Number(args[2]));
    }
    if (action === 'bagitem' || action === 'itempage') {
      owner(i, args[1]); if (args[0] !== uid) needGM(s, member);
      return U.itemView(s, args[0], uid, action === 'bagitem' ? i.values[0] : args[2], action === 'itempage' ? Number(args[3]) : 0);
    }
    if (action === 'baguse') {
      owner(i, args[0]); const result = await context.use(i, args[1]);
      return payload('已使用 · ' + result.name, '恢复 ' + result.healed + ' HP · 当前 ' + result.hp +
        '\n解除：' + (result.cleared.join('、') || '无') + '\n持续效果：' + U.effectsText(result.effects),
        [row(button('bag:' + uid + ':' + uid + ':0', '返回背包'))], 0x2ecc71);
    }
    if (action === 'dropconfirm' || action === 'deleteconfirm') {
      const message = await tx(i, st => {
        const f = F.owned(st, args[0], uid);
        ok(f.expiresAt > Date.now() && !f.done, '确认已过期或已完成。');
        if (action === 'dropconfirm') {
          ok(f.kind === 'drop', '确认类型不符。');
          const name = M.drop(st, uid, f.itemId, f.quantity); f.done = true; return '已丢弃 ' + name + ' ×' + f.quantity;
        }
        needGM(st, member); ok(f.kind === 'delete' && M.player(st, f.target).id === f.characterId, '角色已变化。');
        M.deleteCharacter(st, f.target); f.done = true; return '角色及财产已清空；审计保留。';
      });
      for (const b of Object.values(snapshot(i.guildId).battles).filter(b => b.status !== 'ended')) await publishBattle(i.guildId, b.id);
      return payload('已保存', message);
    }
    if (action === 'offer') return U.offerView(s, offerAccess(s, args[0], member, uid), uid);
    if (['quotevalue', 'offerconfirm', 'offercancel'].includes(action)) {
      owner(i, args[1]); offerAccess(s, args[0], member, uid);
      await tx(i, st => {
        if (action === 'quotevalue') {
          const items = i.fields.getTextInputValue('items').trim().split('\n').filter(Boolean).map(line => {
            const match = line.trim().match(/^(i[0-9a-f]{12})\s+(?:[x×]\s*)?(\d+)$/);
            ok(match, '物品报价每行填写“背包编号 数量”。'); return { id: match[1], quantity: Number(match[2]) };
          });
          return M.updateOffer(st, args[0], uid, items, i.fields.getTextInputValue('coins'));
        }
        if (action === 'offerconfirm') return M.confirmOffer(st, args[0], uid, Number(args[2]));
        M.cancelOffer(st, args[0], uid, U.gm(st, member)); return '取消';
      });
      const next = snapshot(i.guildId); return U.offerView(next, offerAccess(next, args[0], member, uid), uid);
    }
    if (action === 'catalog') { needGM(s, member); return catalogView(s, args[0], Number(args[1])); }
    if (action === 'templateedit') {
      needGM(s, member);
      const source = args[0], ref = i.values[0], kind = { catalog: 'item', traits: 'trait', conditionTemplates: 'condition', npcTemplates: 'npc' }[source];
      ok(kind, '模板类型无效。');
      const f = await tx(i, st => { needGM(st, member); return F.create(st, uid, kind, null, ref); });
      return F.view(snapshot(i.guildId), f);
    }
    if (['battle', 'join', 'withdraw', 'start', 'personal', 'control', 'gmcontrol', 'gmstart', 'defense', 'defend'].includes(action)) {
      const b = battle(s, args[0]);
      if (action === 'battle') return U.battleView(s, b);
      if (action === 'control') { needGM(s, member); return context.gmUI.view(s, b); }
      if (action === 'start') { needGM(s, member); return context.gmUI.view(s, b); }
      if (action === 'personal') {
        const a = b.actors.find(a => a.userId === uid) || (U.gm(s, member) ? b.actors.find(a => a.id === b.current?.actorId) : null);
        ok(a, '未参加战斗，可查看公共战场。');
        return U.personalView(s, b, a, uid);
      }
      if (action === 'defense') return defenseView(s, b, args[1], member, uid);
      if (action === 'defend') {
        owner(i, args[2]); defenseView(s, b, args[1], member, uid);
        const result = await tx(i, st => {
          defenseView(st, battle(st, args[0]), args[1], member, uid);
          return B.defend(st, battle(st, args[0]), args[1], args[3]);
        });
        await publishBattle(i.guildId, b.id);
        return payload('防守已结算', (result.defaulted ? '响应已超时，按纯防御结算。\n' : '') + result.target + '：' +
          (result.dodge?.success ? '成功闪避' : '受到' + result.total + '伤害') + '，HP ' + result.hp);
      }
      await tx(i, st => {
        const next = battle(st, args[0]);
        if (action === 'join') { ok(U.playerRole(st, member), '需要配置的玩家身份组及有效角色卡。'); return B.join(st, next, uid); }
        if (action === 'withdraw') { B.withdraw(st, next, uid); return '已撤回'; }
        needGM(st, member);
        if (action === 'gmstart') B.start(st, next, args[1] === 'normal' ? null : args[1]);
        if (action === 'gmcontrol') {
          if (args[1] === 'pause') B.pause(next);
          else if (args[1] === 'resume') { B.pause(next, true); B.nextOpportunity(st, next); }
          else if (args[1] === 'end') B.endBattle(st, next);
          else if (args[1] === 'finish') {
            ok(next.current && !next.pending, '没有行动或等待防守。');
            if (next.status === 'paused') next.status = 'active';
            B.finish(st, next, next.current.id);
          } else throw new Error('GM操作无效。');
        }
        return { battleId: next.id };
      });
      await publishBattle(i.guildId, b.id);
      return ['gmcontrol', 'gmstart'].includes(action) ? context.gmUI.view(snapshot(i.guildId), battle(snapshot(i.guildId), b.id)) :
        U.battleView(snapshot(i.guildId), battle(snapshot(i.guildId), b.id));
    }
    const { b, a, p, turnId, prefix } = prefixContext(i, s, args, member,
      !['tab', 'view', 'statuspage', 'equippick', 'attachpick', 'attachpart', 'attachchoose', 'attachdo'].includes(action));
    if (action === 'tab' || action === 'view') return U.personalView(s, b, a, uid, action === 'tab' ? i.values[0] : args[4], args[5]);
    if (action === 'statuspage') return U.personalView(s, b, a, uid, 'status', args[4]);
    if (['equippick', 'attachpick', 'attachpart', 'attachchoose', 'attachdo'].includes(action)) {
      ok(['paused', 'recruiting'].includes(b.status), '请GM暂停战斗再调整装备。');
      function attachmentView(ref) {
        const equipment = p.inventory[ref]; ok(equipment, '装备已失效。');
        const parts = Object.values(p.inventory).filter(item => item.snapshot.kind === '配件');
        ok(parts.length, '没有配件。');
        const v = pickView('选择装配或拆下的配件', parts.map(item => ({
          label: item.snapshot.name + (equipment.attachments.includes(item.id) ? ' · 拆下' : ' · 装配'), value: item.id
        })), 'attachchoose:' + prefix + ':' + equipment.id, Number(args[5]) || 0);
        v.components.push(row(button('view:' + prefix + ':status', '返回装备与状态'))); return v;
      }
      if (action === 'attachpart' || (action === 'attachchoose' && args[5] !== 'select')) return attachmentView(args[4]);
      if ((action === 'equippick' || action === 'attachpick') && args[4] !== 'select') {
        const items = Object.values(p.inventory).filter(item => (action === 'attachpick' ? ['武器', '防具'] : ['武器', '防具', '饰品', '卡牌']).includes(item.snapshot.kind));
        return pickView('选择要调整的装备', items.map(item => ({ label: item.snapshot.name + (M.equippedIds(p).includes(item.id) ? ' · 已装备' : ''), value: item.id })),
          action + ':' + prefix, Number(args[4]));
      }
      if (action === 'attachpick') {
        return attachmentView(i.values[0]);
      }
      await tx(i, st => {
        const live = prefixContext(i, st, args, member);
        ok(['paused', 'recruiting'].includes(live.b.status), '战斗已恢复，不能调整。');
        if (action === 'equippick') {
          const ref = i.values[0], remove = M.equippedIds(live.p).includes(ref);
          if (live.a.userId) M.equip(st, live.a.userId, ref, remove); else M.equipCharacter(live.p, ref, remove);
        } else {
          const equipment = live.p.inventory[args[4]], ref = i.values[0];
          ok(equipment, '装备已失效。');
          const remove = equipment.attachments.includes(ref);
          if (live.a.userId) M.attach(st, live.a.userId, equipment.id, ref, remove);
          else M.attachCharacter(live.p, equipment.id, ref, remove);
        }
        return { battleId: b.id };
      });
      await publishBattle(i.guildId, b.id);
      const next = snapshot(i.guildId);
      return U.personalView(next, battle(next, b.id), B.actorById(battle(next, b.id), a.id), uid, 'status');
    }
    if (action === 'attackpick') {
      const type = args[4];
      const abilities = B.abilities(p).filter(x => type === 'formal' ? x.attack.kind !== '技能' || x.attack.action === 'formal' :
        x.attack.kind === '技能' ? x.attack.action === 'quick' : x.attack.supernatural);
      if (args[5] === 'select') {
        const ability = abilities.find(x => x.key === i.values[0]); ok(ability, '攻击方式已失效。');
        const targets = b.actors.filter(t => t.id !== a.id && !t.retreated && B.actorCharacter(s, t).hp > 0);
        ok(targets.length, '没有有效攻击目标。');
        return payload('选择目标 · ' + ability.attack.name, '固定命中 ' + ability.attack.hit + ' · 射程 ' + ability.attack.range + '格', [
          row(select('target:' + prefix + ':' + type + ':' + ability.key, '攻击目标', targets.map(t => ({ label: t.name, value: t.id })))),
          row(button('attackpick:' + prefix + ':' + type + ':0', '返回武器选择'), button('view:' + prefix + ':overview', '取消选择'))]);
      }
      return pickView('选择武器／技能', abilities.map(x => ({ label: x.attack.name, value: x.key })), 'attackpick:' + prefix + ':' + type, Number(args[5]));
    }
    if (action === 'reloadmagpick') {
      const weapon = p.inventory[p.equipped.weapon], ammo = p.inventory[args[4]];
      ok(weapon?.loaded && ammo?.snapshot.kind === '弹药', '武器或弹药不可用。');
      const entries = Object.values(p.inventory).filter(m => m.snapshot.kind === '弹夹' &&
        m.snapshot.magazineType === weapon.snapshot.magazineType && m.snapshot.ammoType === weapon.snapshot.ammoType &&
        m.snapshot.capacity >= weapon.loaded.capacity && (!M.isAttached(p, m.id) || weapon.magazineId === m.id) &&
        (!a.userId || M.available(s, a.userId, m.id) > 0)).map(m => ({ label: m.snapshot.name, value: m.id }));
      if (args[5] !== 'select') {
        const v = pickView('选择兼容弹夹 · 装填第二步', entries, 'reloadmagpick:' + prefix + ':' + args[4], Number(args[5]) || 0);
        return v;
      }
    }
    if (['reloadpick', 'weaponpick', 'itempick'].includes(action)) {
      const kind = { reloadpick: '弹药', weaponpick: '武器', itempick: '消耗品' }[action];
      let items = Object.values(p.inventory).filter(item => (action === 'itempick' ? C.CONSUMABLES.includes(item.snapshot.kind) : item.snapshot.kind === kind) &&
        (!a.userId || M.available(s, a.userId, item.id) > 0));
      if (action === 'reloadpick') items = items.filter(item => item.snapshot.ammoType === p.inventory[p.equipped.weapon]?.snapshot.ammoType);
      if (args[4] === 'select') {
        if (action === 'reloadpick') {
          const ammoId = i.values[0], weapon = p.inventory[p.equipped.weapon]; ok(weapon?.loaded && p.inventory[ammoId], '武器或弹药不可用。');
          const magazines = Object.values(p.inventory).filter(m => m.snapshot.kind === '弹夹' && m.snapshot.magazineType === weapon.snapshot.magazineType &&
            m.snapshot.ammoType === weapon.snapshot.ammoType && m.snapshot.capacity >= weapon.loaded.capacity &&
            (!M.isAttached(p, m.id) || weapon.magazineId === m.id));
          const v = pickView('选择兼容弹夹 · 装填第二步', magazines.map(m => ({ label: m.snapshot.name, value: m.id })),
            'reloadmagpick:' + prefix + ':' + ammoId, 0);
          return v;
        }
      } else return pickView('选择' + kind, [
        ...(action === 'weaponpick' ? [{ label: '徒手（卸下武器）', value: 'none' }] : []),
        ...items.map(item => ({ label: item.snapshot.name + ' ×' + item.quantity, value: item.id }))
      ], action + ':' + prefix, Number(args[4]));
    }
    const result = await tx(i, st => {
      const live = prefixContext(i, st, args, member, true), next = live.b;
      if (action === 'movevalue') B.move(st, next, turnId, i.fields.getTextInputValue('x'), i.fields.getTextInputValue('y'));
      else if (action === 'target') return B.attack(st, next, turnId, args[5], i.values[0], args[4]);
      else if (action === 'reloadmag' || action === 'reloadmagpick') B.reload(st, next, turnId, args[4], i.values[0]);
      else if (action === 'weaponpick') B.switchWeapon(st, next, turnId, i.values[0] === 'none' ? null : i.values[0]);
      else if (action === 'itempick') B.useItem(st, next, turnId, i.values[0]);
      else if (action === 'cast') B.confirmCasting(st, next, turnId);
      else if (action === 'pass') B.pass(st, next, turnId, args[4]);
      else if (action === 'finish') B.finish(st, next, turnId);
      else if (action === 'flee') B.flee(st, next, turnId);
      else throw new Error('操作未识别，请重新打开个人面板。');
      B.nextOpportunity(st, next);
      return { battleId: next.id };
    });
    await publishBattle(i.guildId, b.id);
    const next = snapshot(i.guildId), liveBattle = battle(next, b.id), liveActor = B.actorById(liveBattle, a.id);
    if (action === 'target') {
      if (result.casting) return U.personalView(next, liveBattle, liveActor, uid, 'quick');
      const target = B.actorById(liveBattle, result.targetId), ch = await context.textChannel(i.guildId, liveBattle.channelId);
      const roles = target.userId ? [] : next.config.gmRoleIds;
      const message = await ch.send({ content: (target.userId ? '<@' + target.userId + '>' : roles.map(r => '<@&' + r + '>').join(' ')) + ' 请为 **' + target.name + '** 选择防守方式。',
        components: [row(button('defense:' + b.id + ':' + result.id, '打开防守面板', D.ButtonStyle.Danger))],
        allowedMentions: { parse: [], users: target.userId ? [target.userId] : [], roles } });
      await store.transact(i.guildId, 'combat-prompt:' + message.id, uid, st => {
        st.battles[b.id].auxiliaryMessages ||= []; st.battles[b.id].auxiliaryMessages.push(message.id);
      }, '记录战斗防守面板');
    }
    return U.personalView(next, liveBattle, liveActor, uid);
  }
  return { component, openModal, defenseView };
}
module.exports = { createHandlers };
