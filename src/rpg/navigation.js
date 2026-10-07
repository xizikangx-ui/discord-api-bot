'use strict';
const C = require('./constants'), U = require('./ui');
// Ephemeral webhook tokens stay in memory only. A restart requires reopening a
// private panel; durable drafts, assets and combat progress remain in the store.
function createNavigation(snapshot, selector = (guild, fn) => fn(snapshot(guild))) {
  const groups = new Map(), routes = new Map();
  function clean() {
    const now = Date.now();
    for (const [id, g] of groups) if (g.expiresAt <= now) groups.delete(id);
    for (const [id, r] of routes) if (!groups.has(r.group)) routes.delete(id);
  }
  function capture(guild, customId) {
    const match = customId.match(/^rpg:form[^:]*:([^:]+)/);
    const f = match && selector(guild, s => { const f=s.forms[match[1]];return f&&{id:f.id,version:f.version,field:f.field}; });
    return f ? { id: f.id, version: f.version || 0, field: f.field } : null;
  }
  function add(g, original, modal = false) {
    const id = 'rpg:n:' + C.id('n');
    routes.set(id, { group: g.id, generation: g.generation, original, modal, form: capture(g.guild, original) });
    if (modal) g.modal = id;
    for (const b of selector(g.guild,s=>Object.keys(s.battles))) if (original.includes(b)) g.battles.add(b);
    return id;
  }
  function wrap(i, result) {
    clean();
    let g = i.rpgNavigation && groups.get(i.rpgNavigation.group);
    if (!g) {
      g = { id: C.id('p'), owner: i.user.id, guild: i.guildId, characterId: selector(i.guildId,s=>s.players[i.user.id]?.id), generation: 0, battles: new Set() };
      groups.set(g.id, g);
    }
    g.generation++; g.modal = null; g.busy = false;
    g.expiresAt = Date.now() + 14 * 60000; g.handle = i;
    i.rpgResponseGroup=g.id;
    const out = { content: '', ...result };
    out.components = (result.components || []).map(r => {
      const json = typeof r.toJSON === 'function' ? r.toJSON() : C.clone(r);
      for (const c of json.components || []) if (c.custom_id?.startsWith('rpg:')) c.custom_id = add(g, c.custom_id);
      return U.D.ActionRowBuilder.from(json);
    });
    return out;
  }
  function resolve(i) {
    clean();
    if (!i.customId?.startsWith('rpg:n:')) return null;
    const r = routes.get(i.customId), g = r && groups.get(r.group);
    C.requireThat(g && g.owner === i.user.id && g.guild === i.guildId && r.generation === g.generation &&
      (!r.modal || g.modal === i.customId), '该步骤已失效，请重新打开个人面板或持久草稿。');
    C.requireThat(!g.characterId || selector(g.guild,s=>s.players[g.owner]?.id) === g.characterId, '角色已死亡或已更换，请重新打开面板。');
    if(g.busy)throw Object.assign(new Error('上一项操作仍在处理，完成后面板会自动更新。'),{code:'RPG_PANEL_BUSY'});
    if (r.form) {
      const f = selector(g.guild,s=>{const f=s.forms[r.form.id];return f&&{version:f.version,field:f.field};});
      C.requireThat(f && (f.version || 0) === r.form.version && f.field === r.form.field, '草稿步骤已经变化，请重新打开。');
    }
    g.busy = true; i.rpgNavigation = r; i.customId = r.original;
    return () => { g.busy = false; };
  }
  function modal(i, builder) {
    const r = i.rpgNavigation, g = r && groups.get(r.group);
    if (!g) return builder;
    const json = builder.toJSON(); json.custom_id = add(g, json.custom_id, true);
    return U.D.ModalBuilder.from(json);
  }
  function invalidate(i) {
    const g = i.rpgNavigation && groups.get(i.rpgNavigation.group);
    if (g) { g.generation++; g.modal = null; }
  }
  async function clearBattle(guild, battleId) {
    const matching = [...groups.values()].filter(g => g.guild === guild && g.battles.has(battleId));
    for (const g of matching) {
      groups.delete(g.id);
      await g.handle.editReply(U.payload('战斗已结束', '本次战斗操作面板已清理。战斗结果保留在公共战场卡中。')).catch(() => {});
    }
    clean();
  }
  async function clearUser(guild, uid, characterId) {
    for (const [id, g] of groups) if (g.guild === guild && g.owner === uid && g.characterId === characterId) {
      groups.delete(id);
      await g.handle.editReply(U.payload('角色已死亡', '原角色及资产已清空；可重新 /建卡。旧面板已关闭。')).catch(() => {});
    }
    clean();
  }
  function ticket(i){const g=groups.get(i.rpgResponseGroup);return g&&{id:g.id,generation:g.generation};}
  function current(i,t){const g=t&&groups.get(t.id);return !!g&&!g.busy&&g.handle===i&&g.generation===t.generation&&(!g.characterId||selector(g.guild,s=>s.players[g.owner]?.id)===g.characterId);}
  return { wrap, resolve, modal, clearBattle, clearUser, invalidate, ticket, current };
}
module.exports = { createNavigation };
