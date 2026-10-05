'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs');
const D = require('discord.js');
const C = require('../src/rpg/constants'), M = require('../src/rpg/model'), B = require('../src/rpg/combat');
const F = require('../src/rpg/forms'), U = require('../src/rpg/ui');
const A = require('../src/rpg/activities'), AU = require('../src/rpg/activities-ui');
const FA = require('../src/rpg/factions'), BB = require('../src/rpg/buyback');
const { commands } = require('../src/rpg/commands'), { createStore } = require('../src/rpg/store'), { createRpg } = require('../src/rpg');
const minRng = min => min;
function state() {
  const s = C.newState(C.DEFAULT_GUILD_ID);
  for (const [uid, agility] of [['1', 6], ['2', 4], ['3', 2]]) {
    const p = M.newCharacter('角色' + uid, { strength: 5, constitution: 5, mind: 5, appearance: 5, intelligence: 5, agility, knowledge: 5 }, 1);
    p.userId = uid; s.players[uid] = p;
  }
  return s;
}
function weapon(s, extra = {}) {
  return M.publishTemplate(s, { kind: '武器', name: '测试武器', rarity: 'white', weightKg: 1, value: 10, quality: '标准', origin: '未知',
    traitIds: ['neutral'], weaponType: '剑', hit: 10, damage: { physical: '1d6' }, primary: 'physical', range: 1, ...extra });
}
function fight(s = state()) {
  const b = B.createBattle(s, 'channel', 'GM', '测试战斗'); B.join(s, b, '1'); B.join(s, b, '2');
  B.start(s, b, null, minRng); return { s, b };
}
function collection(entries) { return new D.Collection(entries); }
function harness() {
  const fileBodies = new Map(), messages = collection(), settings = {}, sent = [];
  let count = 0, failure = null;
  const key = crypto.randomBytes(32);
  const encrypt = value => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
  };
  const decrypt = value => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); d.setAuthTag(Buffer.from(value.tag, 'base64'));
    return { encrypted: true, value: JSON.parse(Buffer.concat([d.update(Buffer.from(value.body, 'base64')), d.final()])) };
  };
  function write(message, options) {
    message.content = options.content; message.lastPayload = options;
    message.attachments = collection((options.files || []).map((f, n) => {
      const url = 'memory:' + (++count); fileBodies.set(url, Buffer.from(f.attachment).toString());
      return [String(n), { name: f.name, url }];
    }));
    return message;
  }
  const ch = { id: 'storage', guild: { maximumFileSize: 10485760 }, guildId: C.DEFAULT_GUILD_ID, isTextBased: () => true,
    messages: { fetch: async options => {
      if (typeof options === 'string' || options.message) {
        const m = messages.get(typeof options === 'string' ? options : options.message);
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return m;
      }
      const batch = [...messages.entries()].filter(([id]) => !options.before || Number(id) < Number(options.before)).reverse().slice(0, options.limit || 100);
      return collection(batch);
    } },
    send: async options => {
      const id = String(1000 + (++count));
      const message = { id, channelId: 'channel', author: { id: 'BOT' }, attachments: collection(),
        edit: async options => {
          if (failure === 'before') { failure = null; throw new Error('network'); }
          write(message, options);
          if (failure === 'after') { failure = null; throw new Error('network'); }
          return message;
        } };
      messages.set(id, write(message, options)); sent.push(message); return message;
    } };
  const guild = { id: C.DEFAULT_GUILD_ID, roles: { cache: collection(), fetch: async () => guild.roles.cache },
    members: { fetch: async ({ user }) => members[user], fetchMe: async () => botMember } };
  function member(id, roles = [], manage = false) {
    return { id, user: { id, username: '成员' + id }, displayName: '成员' + id,
      permissions: new D.PermissionsBitField(manage ? D.PermissionFlagsBits.ManageGuild : 0n),
      roles: { cache: collection(roles.map(r => [r, { id: r }])), highest: { position: 10 },
        add: async ids => ids.forEach(r => members[id].roles.cache.set(r, { id: r })),
        remove: async ids => ids.forEach(r => members[id].roles.cache.delete(r)) } };
  }
  const members = { GM: member('GM', ['gm']), '1': member('1', ['player']), '2': member('2', ['player']), ADMIN: member('ADMIN', [], true), stranger: member('stranger') };
  const botMember = member('BOT'); botMember.permissions = new D.PermissionsBitField(D.PermissionFlagsBits.Administrator);
  const client = { user: { id: 'BOT' }, channels: { fetch: async () => ch } };
  const deps = { client, channel: () => ch, settingsFor: id => settings[id] ||= {}, saveIndex: async () => {},
    encrypt, decrypt, fetcher: async url => ({ ok: fileBodies.has(url), json: async () => JSON.parse(fileBodies.get(url)) }),
    guildIds: () => [C.DEFAULT_GUILD_ID], logFailure: () => {} };
  let interactionSeq = 0;
  function interaction(uid, commandName, options = {}, customId, values, fields) {
    const data = { id: 'interaction-' + (++interactionSeq), user: members[uid].user, member: members[uid], guild, guildId: guild.id, channelId: 'channel', channel: ch,
      commandName, customId, values, fields: { getTextInputValue: k => fields[k] },
      isChatInputCommand: () => !!commandName, isAutocomplete: () => false, isModalSubmit: () => !!fields,
      options: { getString: k => options[k] ?? null, getInteger: k => options[k] ?? null, getNumber: k => options[k] ?? null,
        getUser: k => options[k] ? { id: options[k] } : null, getSubcommand: () => options.sub },
      deferReply: async options => { data.deferred = true; data.deferOptions = options; },
      deferUpdate: async () => { data.deferred = true; data.updatedSource = true; },
      editReply: async value => { data.result = value; (data.edits ||= []).push(value); },
      reply: async value => { data.replied = true; data.result = value; },
      showModal: async value => { data.modal = value; } };
    return data;
  }
  return { deps, settings, messages, fileBodies, encrypt, decrypt, sent, ch, guild, members, interaction,
    fail: mode => { failure = mode; } };
}
function validateMessage(value) {
  if (typeof value === 'string') return;
  const components = value.components || []; assert.ok(components.length <= 5);
  for (const r of components) {
    const json = r.toJSON ? r.toJSON() : r; assert.ok(json.components.length <= 5);
    for (const c of json.components) {
      if (c.custom_id) assert.ok(c.custom_id.length <= 100, c.custom_id);
      if (c.options) assert.ok(c.options.length > 0 && c.options.length <= 25);
    }
  }
  const ids = components.flatMap(r => (r.toJSON ? r.toJSON() : r).components).map(c => c.custom_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate component IDs');
  let length = 0;
  for (const embed of value.embeds || []) {
    const json = embed.toJSON ? embed.toJSON() : embed; assert.ok((json.description || '').length <= 4096);
    assert.ok((json.fields || []).length <= 25);
    for (const f of json.fields || []) { assert.ok(f.name.length <= 256); assert.ok(f.value.length <= 1024); }
    length += (json.title || '').length + (json.description || '').length + (json.footer?.text || '').length +
      (json.author?.name || '').length + (json.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  }
  assert.ok(length <= 6000);
}
test('dice default notation, advantages and rarity exact integer weights', () => {
  assert.equal(C.dice('r2d100', 'normal', minRng).total, 2);
  assert.equal(C.dice('r1d20+2', 'normal', minRng).total, 3);
  assert.equal(C.dice('r1d10', 'normal', minRng).total, 1);
  let n = 0; const alternating = () => ++n % 2 ? 2 : 19;
  assert.equal(C.dice('1d20', 'advantage', alternating).total, 19);
  assert.equal(C.dice('1d20', 'disadvantage', alternating).total, 2);
  const counts = {};
  for (let i = 0; i < 1000; i++) { const id = C.rarity(() => i).id; counts[id] = (counts[id] || 0) + 1; }
  for (const r of C.RARITIES) assert.equal(counts[r.id], r.weight);
  assert.throws(() => C.dice('101d20')); assert.throws(() => C.dice('2d1'));
});
test('character whole rerolls include adaptation, confirm locks, allocates and titles', () => {
  const s = C.newState('x'); M.rollCharacter(s, '1', 'name', false, minRng);
  for (let i = 0; i < 3; i++) M.rollCharacter(s, '1', '', true, (min, max) => max - 1);
  assert.equal(s.characterDrafts['1'].adaptation, 10);
  assert.throws(() => M.rollCharacter(s, '1', '', true));
  const p = M.confirmCharacter(s, '1'); assert.equal(p.points, 2);
  assert.throws(() => M.rollCharacter(s, '1', ''));
  M.allocate(s, '1', 'constitution', 2); assert.equal(p.hp, 24);
  assert.equal(C.title(1), '凡人'); assert.equal(C.title(91), '半神'); assert.equal(C.title(100), '神');
});
test('experience precise multiplier, consecutive levels, point milestones and level cap', () => {
  const s = state(), p = s.players['1']; p.adaptation = 5;
  assert.equal(M.grantXP(s, '1', 1000).credited, 1200); assert.equal(p.level, 2); assert.equal(p.xpCenti, 20000);
  M.grantXP(s, '1', 4000); assert.equal(p.level, 4); assert.equal(p.points, 4);
  M.grantXP(s, '1', 1000000000); assert.equal(p.level, 100);
  assert.equal(p.points, 68); assert.ok(p.xpCenti > 0);
});
test('half load slows movement only; overloading and pending loot keep result and ticket', () => {
  const s = state(), p = s.players['1'];
  p.inventory.a = { id: 'a', quantity: 1, snapshot: { weight: 2501 } };
  assert.equal(M.stats(p).move, 12); assert.equal(M.stats(p).apGain, 30);
  p.inventory.a.snapshot.weight = 5000; p.tickets.boxes['大衣'] = 1;
  const first = M.openLoot(s, '1', '大衣', minRng);
  assert.ok(first.pending); assert.equal(p.tickets.boxes['大衣'], 1);
  const retry = M.openLoot(s, '1', '大衣', () => { throw new Error('must not reroll'); });
  assert.equal(first.item.id, retry.item.id);
  delete p.inventory.a;
  const claimed = M.openLoot(s, '1', '大衣', () => { throw new Error('must not reroll'); });
  assert.equal(claimed.item.id, first.item.id); assert.equal(p.tickets.boxes['大衣'], 0); assert.ok(!claimed.pending);
});
test('cards without templates are neutral, all 12 boxes have six colors and ranges', () => {
  const s = state(), p = s.players['1']; p.tickets.card = 1;
  const card = M.openLoot(s, '1', 'card', minRng).item;
  assert.equal(card.snapshot.weight, 0); assert.deepEqual(card.snapshot.effects, []);
  for (const box of C.BOXES) {
    for (const r of C.RARITIES) assert.ok(Object.values(s.catalog).some(t => t.boxes?.includes(box) && t.rarity === r.id));
    p.tickets.boxes[box] = 1; const reward = M.openLoot(s, '1', box, minRng).item;
    assert.ok(reward.snapshot.value >= 1500000 && reward.snapshot.value <= 23000000);
  }
});
test('versioned gun instances, ammo/magazine/attachments counted once and reloading conserves weight', () => {
  const s = state();
  const ammo = M.publishTemplate(s, { kind: '弹药', name: '9mm', ammoType: '9mm', rarity: 'white', weightKg: .01 });
  const magazine = M.publishTemplate(s, { kind: '弹夹', name: '夹', ammoType: '9mm', magazineType: '9mm-10', capacity: 10, rarity: 'white', weightKg: .2 });
  const part = M.publishTemplate(s, { kind: '配件', name: '瞄具', compatible: ['手枪'], attachmentSlot: '瞄具', rarity: 'white', weightKg: .1 });
  const t = weapon(s, { weaponType: '手枪', ammoType: '9mm', magazineType: '9mm-10', capacity: 10, current: 3, preinstalled: [part.id] });
  const item = M.issue(s, '1', t.id)[0], p = s.players['1']; M.equip(s, '1', item.id);
  assert.equal(M.weight(p), 133); assert.ok(p.inventory[item.magazineId]);
  const version2 = M.publishTemplate(s, { ...t, weightKg: 2 }, t.id);
  assert.equal(version2.version, 2); assert.equal(item.snapshot.weight, 100); assert.equal(item.loaded.current, 3);
  const ammunition = M.issue(s, '1', ammo.id, 20)[0];
  const { b } = fight(s);
  const before = M.weight(p); B.reload(s, b, b.current.id, ammunition.id, item.magazineId);
  assert.equal(item.loaded.current, 10); assert.equal(M.weight(p), before);
  assert.throws(() => B.reload(s, b, b.current.id, ammunition.id));
  assert.equal(magazine.capacity, 10);
});
test('armor coverage, card/accessory slot expansion caps and modifiers ordering', () => {
  const s = state(), p = s.players['1'];
  const armor = type => M.publishTemplate(s, { kind: '防具', name: type, armorType: type, rarity: 'white', weightKg: 1,
    quality: '标准', origin: '未知', traitIds: ['neutral'], defenses: { physical: 2 } });
  const full = M.issue(s, '1', armor('全甲').id)[0], inner = M.issue(s, '1', armor('内甲').id)[0], head = M.issue(s, '1', armor('头盔').id)[0];
  M.equip(s, '1', full.id); M.equip(s, '1', inner.id); assert.throws(() => M.equip(s, '1', head.id));
  assert.equal(M.stats(p).defenses.physical, 4);
  const heart = M.issue(s, '1', 'special_heart', 4)[0];
  for (let i = 0; i < 3; i++) M.useSpecial(s, '1', heart.id, 'head');
  assert.equal(p.slots.head, 4); assert.throws(() => M.useSpecial(s, '1', heart.id, 'head'));
  const tear = M.issue(s, '1', 'special_tear', 20)[0];
  for (let i = 0; i < 15; i++) M.useSpecial(s, '1', tear.id);
  assert.equal(p.slots.card, 20); assert.throws(() => M.useSpecial(s, '1', tear.id));
  assert.equal(M.modify([{ target: 'x', value: 2 }, { target: 'x', value: -1 }, { target: 'x', op: 'percent', value: 50 }], 'x', 10), 16.5);
});
test('mixed trades reserve assets, changes invalidate confirmations, transfer conserves coins', () => {
  const s = state(); s.players['1'].balance = 100; s.players['2'].balance = 20;
  const t = Object.values(s.catalog).find(t => t.kind === '杂物');
  const item = M.issue(s, '1', t.id, 3)[0], o = M.createOffer(s, '1', '2');
  M.updateOffer(s, o.id, '1', [{ id: item.id, quantity: 2 }], 50);
  assert.equal(M.available(s, '1', item.id), 1); assert.throws(() => M.drop(s, '1', item.id, 2));
  M.updateOffer(s, o.id, '2', [], 10);
  assert.ok(!M.confirmOffer(s, o.id, '1', o.revision).completed);
  const previous = o.revision; M.updateOffer(s, o.id, '2', [], 15); assert.deepEqual(o.confirmations, {});
  assert.throws(() => M.confirmOffer(s, o.id, '1', previous));
  M.confirmOffer(s, o.id, '1', o.revision); assert.ok(M.confirmOffer(s, o.id, '2', o.revision).completed);
  assert.equal(s.players['1'].balance, 65); assert.equal(s.players['2'].balance, 55);
  assert.throws(() => M.confirmOffer(s, o.id, '2', o.revision));
  const transfer = M.createOffer(s, '2', '1', 'transfer', null, 1, 5);
  assert.throws(() => M.confirmOffer(s, transfer.id, '1', 1)); M.confirmOffer(s, transfer.id, '2', 1);
  assert.equal(s.players['1'].balance, 70); assert.equal(s.players['2'].balance, 50);
});
test('GM buyback only mints on seller confirmation, expiry releases and deletion cancels', () => {
  const s = state(), t = Object.values(s.catalog)[0], item = M.issue(s, '1', t.id, 3)[0];
  const o = M.createOffer(s, 'GM', '1', 'buyback', item.id, 1, 500);
  assert.equal(s.players['1'].balance, 0); assert.throws(() => M.confirmOffer(s, o.id, 'GM', 1));
  M.confirmOffer(s, o.id, '1', 1); assert.equal(s.players['1'].balance, 500);
  const trade = M.createOffer(s, '1', '2'); M.updateOffer(s, trade.id, '1', [{ id: item.id, quantity: 1 }], 100);
  assert.equal(M.available(s, '1', item.id), 1);
  M.expireOffers(s, trade.expiresAt + 1); assert.equal(M.available(s, '1', item.id), 2);
  const pending = M.createOffer(s, '1', '2'); const b = B.createBattle(s, 'channel', 'GM', '报名'); B.join(s, b, '1');
  M.deleteCharacter(s, '1'); assert.ok(!s.players['1']); assert.equal(pending.status, 'cancelled'); assert.equal(b.actors.length, 0);
  M.rollCharacter(s, '1', 'new', false, minRng);
});
test('recruitment duplicate, withdraw, battle isolation, turn budget and auto rounds retain AP', () => {
  const s = state(), b = B.createBattle(s, 'channel', 'GM', 'test');
  B.join(s, b, '1'); assert.throws(() => B.join(s, b, '1'));
  B.withdraw(s, b, '1'); B.join(s, b, '1'); B.join(s, b, '2');
  assert.throws(() => B.createBattle(s, 'channel', 'GM', 'duplicate'));
  s.players['1'].attributes.agility = 40; B.start(s, b, null, minRng);
  assert.equal(s.players['1'].ap, 101); assert.equal(b.current.quick, 1); assert.equal(b.current.formal, 1);
  const first = b.current.id; B.finish(s, b, first, minRng);
  assert.notEqual(b.current.id, first); assert.equal(b.current.actorId, b.actors[0].id); assert.equal(s.players['1'].ap, 1);
  assert.throws(() => B.finish(s, b, first));
  B.pause(b); assert.throws(() => B.move(s, b, b.current.id, 26, 25));
  B.pause(b, true); B.move(s, b, b.current.id, 26, 25); assert.equal(b.current.move, 119);
});
test('same agility tie rerolls, surprise free action and no live actors pause', () => {
  const s = state(), b = B.createBattle(s, 'channel', 'GM', 'test'); B.join(s, b, '1'); B.join(s, b, '2');
  s.players['2'].attributes.agility = 6;
  const seq = [5, 5, 8, 9]; const order = B.order(s, b, b.actors, () => seq.shift());
  assert.equal(order[0], b.actors[1].id);
  B.start(s, b, 'ally', (() => { let n = 0; return () => ++n % 2 ? 10 : 11; })());
  assert.ok(b.current.free); assert.equal(s.players['1'].ap, 0); assert.equal(s.players['2'].ap, 0);
  s.players['1'].hp = 0; s.players['2'].hp = 0; b.current = null; b.queue = []; B.nextOpportunity(s, b);
  assert.equal(b.status, 'paused');
});
test('map obstacles, difficult terrain and partial movement budget', () => {
  const { s, b } = fight(); const current = b.current.id;
  b.terrain['0,0'] = 'difficult';
  B.move(s, b, current, 28, 25); assert.equal(b.current.move, 12);
  B.move(s, b, current, 30, 25); assert.equal(b.current.move, 8);
  b.terrain['0,0'] = 'blocked'; assert.throws(() => B.move(s, b, current, 31, 25));
  assert.throws(() => B.move(s, b, current, 1000, 25));
  b.terrain['0,0'] = 'normal'; s.players['1'].inventory.heavy = { id: 'heavy', quantity: 1, snapshot: { weight: 5001 } };
  assert.throws(() => B.move(s, b, current, 31, 25));
});
test('mixed damage, melee strength once, simultaneous half defense, dodge strict and no duplicate hit', () => {
  const s = state(), t = weapon(s, { damage: { physical: '10', magical: '10', mental: '10' }, primary: 'physical', hit: 10 });
  const w = M.issue(s, '1', t.id)[0]; M.equip(s, '1', w.id);
  const armor = M.publishTemplate(s, { kind: '防具', name: '防具', armorType: '全甲', rarity: 'white', weightKg: 0, quality: '标准', origin: '未知', traitIds: ['neutral'],
    defenses: { physical: 4, magical: 4, mental: 4 } });
  M.equip(s, '2', M.issue(s, '2', armor.id)[0].id); s.players['2'].hp = 100; s.players['2'].hpMaxOverride = 100;
  const { b } = fight(s); const hit = B.attack(s, b, b.current.id, w.id, b.actors[1].id, 'formal', minRng);
  assert.deepEqual(hit.damage, { physical: 15, magical: 15, mental: 15 });
  const result = B.defend(s, b, hit.id, 'both', minRng); assert.equal(result.total, 39); assert.equal(result.hp, 61);
  assert.throws(() => B.defend(s, b, hit.id, 'none'));
  B.finish(s, b, b.current.id, minRng); // next opportunity may belong to 2
  while (b.current.actorId !== b.actors[0].id) B.finish(s, b, b.current.id, minRng);
  const next = B.attack(s, b, b.current.id, w.id, b.actors[1].id, 'formal', minRng);
  const dodge = B.defend(s, b, next.id, 'dodge', () => 7); assert.ok(dodge.dodge.success); assert.equal(dodge.total, 0);
});
test('ranged distance, arrow/gun costs, weapon switch, casting uses own opportunities and flee', () => {
  const s = state(), skill = M.publishTemplate(s, { kind: '技能', name: '吟唱', rarity: 'white', weightKg: 0, hit: 1, range: 10, damage: { magical: '1' }, casting: 2, action: 'formal' });
  const spell = M.issue(s, '1', skill.id)[0], { b } = fight(s), a = b.actors[0], target = b.actors[1];
  B.attack(s, b, b.current.id, spell.id, target.id, 'formal', minRng); assert.equal(a.casting.count, 1);
  assert.throws(() => B.confirmCasting(s, b, b.current.id));
  B.finish(s, b, b.current.id, minRng);
  while (b.current.actorId !== a.id) B.finish(s, b, b.current.id, minRng);
  assert.equal(a.casting.count, 2); B.confirmCasting(s, b, b.current.id);
  const hit = B.attack(s, b, b.current.id, spell.id, target.id, 'formal', minRng); B.defend(s, b, hit.id, 'defend', minRng);
  B.finish(s, b, b.current.id, minRng);
  B.flee(s, b, b.current.id, minRng); assert.ok(b.actors.some(a => a.retreated));
  const bow = weapon(s, { weaponType: '弓', ammoType: '箭', range: 1 });
  const arrows = M.publishTemplate(s, { kind: '弹药', name: '箭', ammoType: '箭', rarity: 'white', weightKg: .02 });
  const p = s.players['1'], w = M.issue(s, '1', bow.id)[0], ammo = M.issue(s, '1', arrows.id, 2)[0]; p.equipped.weapon = w.id;
  b.current = { id: 'turn', actorId: a.id, quick: 1, formal: 1, move: 18 }; a.retreated = false; b.status = 'active'; target.retreated = false; target.hp = 10;
  target.x = 100; assert.throws(() => B.attack(s, b, 'turn', w.id, target.id, 'formal', minRng));
  target.x = 25; B.attack(s, b, 'turn', w.id, target.id, 'formal', minRng); assert.equal(ammo.quantity, 1);
});
test('condition saved penalties once, HP dice each action, worsening before expiry and restore does not heal', () => {
  const s = state(), p = s.players['1'], b = B.createBattle(s, 'c', 'GM', 'test'); const a = B.join(s, b, '1');
  const t = B.validateCondition({ name: '中毒', type: 'physical', effectType: 'numeric', levels: {
    '一般': { difficulty: 100, duration: { kind: 'actions', count: 1 }, worsenAfter: 1, effects: [{ target: 'attr:agility', amount: '1d6' }, { target: 'hp', amount: '1d6' }] },
    '严重': { difficulty: 100, duration: { kind: 'actions', count: 2 }, worsenAfter: 0, effects: [{ target: 'hpMax', amount: '1' }] }
  } });
  t.id = 'z'; t.published = true; s.conditionTemplates.z = t;
  B.applyCondition(s, p, { id: 'z', severity: '一般' }, minRng); assert.equal(M.stats(p).attributes.agility, 5);
  B.beginConditions(p, b, a, minRng); assert.equal(p.hp, 14);
  B.endConditions(p, b, a, minRng); assert.equal(p.conditions[0].severity, '严重'); assert.equal(M.stats(p).maxHP, 14);
  B.endConditions(p, b, a, minRng); B.endConditions(p, b, a, minRng);
  assert.equal(p.conditions.length, 0); assert.equal(M.stats(p).maxHP, 15); assert.equal(p.hp, 14);
});
test('same condition refreshes highest severity; successful save and successful worsening reset', () => {
  const s = state(), p = s.players['1'], b = B.createBattle(s, 'c', 'GM', 'test'), a = B.join(s, b, '1');
  s.conditionTemplates.z = { id: 'z', name: '文本', type: 'mental', effectType: 'text', published: true, levels: {
    '一般': { difficulty: 100, duration: { kind: 'actions', count: 1 }, worsenAfter: 1, effects: [] },
    '严重': { difficulty: 10, duration: { kind: 'actions', count: 3 }, worsenAfter: 0, effects: [] } } };
  assert.ok(B.applyCondition(s, p, { id: 'z', severity: '严重' }, () => 20).save.success);
  B.applyCondition(s, p, { id: 'z', severity: '一般' }, minRng); B.endConditions(p, b, a, () => 20);
  assert.equal(p.conditions[0].severity, '一般'); assert.equal(p.conditions[0].remaining, 1);
  B.applyCondition(s, p, { id: 'z', severity: '严重' }, minRng);
  B.applyCondition(s, p, { id: 'z', severity: '一般' }, minRng);
  assert.equal(p.conditions.length, 1); assert.equal(p.conditions[0].severity, '严重');
});
test('templates/forms expose every type and serialize all panels within Discord limits', () => {
  const s = state();
  for (const c of commands()) c.toJSON();
  for (const kind of ['item', 'trait', 'condition', 'npc', 'rolepanel']) {
    const itemKinds = kind === 'item' ? C.ITEM_KINDS : ['杂物'];
    for (const itemKind of itemKinds) {
      const f = F.create(s, 'GM', kind, itemKind);
      for (let n = 0; n < Math.ceil(F.fields(f).length / 20); n++) { f.page = n; f.field = n * 20; validateMessage(F.view(s, f)); }
      for (const [n, def] of F.fields(f).entries()) {
        f.field = n;
        if (['choice', 'refs', 'multi', 'conditions'].includes(def.type)) validateMessage(F.choiceView(s, f));
        if (['effects', 'conditionEffects'].includes(def.type)) validateMessage(F.effectsView(s, f));
      }
    }
  }
  const { b } = fight(s); validateMessage(U.battleView(s, b));
  for (const tab of ['overview', 'move', 'quick', 'formal', 'status']) validateMessage(U.personalView(s, b, b.actors[0], '1356391807285727337', tab));
  validateMessage(U.inventoryView(s, '1', 'GM')); validateMessage(U.offerView(s, M.createOffer(s, '1', '2'), '1'));
});
test('encrypted store serializes simultaneous writes and deduplicates receipts', async () => {
  const h = harness(), store = createStore(h.deps); await store.load(C.DEFAULT_GUILD_ID);
  await Promise.all(Array.from({ length: 8 }, (_, n) => store.transact(C.DEFAULT_GUILD_ID, 'op' + n, 'GM', s => { s.config.count = (s.config.count || 0) + 1; return s.config.count; })));
  assert.equal(store.snapshot(C.DEFAULT_GUILD_ID).config.count, 8);
  assert.equal(await store.transact(C.DEFAULT_GUILD_ID, 'op1', 'GM', () => { throw new Error('duplicate'); }), 2);
  const body = [...h.fileBodies.values()].at(-1); assert.ok(!body.includes('tabletop-rpg')); assert.ok(!body.includes('count'));
  const restored = createStore(h.deps); await restored.load(C.DEFAULT_GUILD_ID); assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).revision, 8);
});
test('write ambiguity reconciles committed result or freezes without reroll and can recover', async () => {
  const h = harness(), store = createStore(h.deps); await store.load(C.DEFAULT_GUILD_ID);
  h.fail('after');
  const result = await store.transact(C.DEFAULT_GUILD_ID, 'dice', '1', () => C.dice('1d20', 'normal', minRng));
  assert.equal(result.total, 1); assert.ok(!store.frozen(C.DEFAULT_GUILD_ID));
  h.fail('before'); await assert.rejects(store.transact(C.DEFAULT_GUILD_ID, 'ambiguous', '1', s => { s.config.loss = true; }));
  assert.ok(store.frozen(C.DEFAULT_GUILD_ID)); assert.ok(!store.snapshot(C.DEFAULT_GUILD_ID).config.loss);
  await assert.rejects(store.transact(C.DEFAULT_GUILD_ID, 'new', '1', () => 0));
  await store.recover(C.DEFAULT_GUILD_ID); assert.ok(!store.frozen(C.DEFAULT_GUILD_ID));
});
test('restart retains current turn, residual points, pending defense, conditions and dice', async () => {
  const h = harness(), store = createStore(h.deps); await store.load(C.DEFAULT_GUILD_ID);
  await store.transact(C.DEFAULT_GUILD_ID, 'fight', 'GM', st => {
    Object.assign(st, state()); const b = B.createBattle(st, 'channel', 'GM', 'fight');
    B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng);
    B.attack(st, b, b.current.id, 'unarmed', b.actors[1].id, 'formal', minRng); return b.id;
  });
  const old = store.snapshot(C.DEFAULT_GUILD_ID);
  const restored = createStore(h.deps); await restored.load(C.DEFAULT_GUILD_ID);
  assert.deepEqual(restored.snapshot(C.DEFAULT_GUILD_ID), old);
});
test('runtime role authentication, owner-bound components, non-target guild and template drafts', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'ADMIN', st => { st.config.gmRoleIds = ['gm']; st.config.playerRoleIds = ['player']; Object.assign(st.players, state().players); });
    const denied = h.interaction('stranger', 'gm', { sub: '次数', 成员: '1', 类型: '抽卡', 数量: 1 });
    await rpg.handle(denied); assert.match(denied.result.content, /GM身份组/);
    const config = h.interaction('ADMIN', '跑团配置面板'); await rpg.handle(config); validateMessage(config.result);
    const i = h.interaction('GM', '录入物品', { 类型: '武器' }); await rpg.handle(i); validateMessage(i.result);
    const form = Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms)[0];
    const wrong = h.interaction('1', null, {}, 'rpg:formback:' + form.id); await rpg.handle(wrong); assert.match(wrong.result.content, /不属于你/);
    const foreign = h.interaction('1', '建卡'); foreign.guildId = 'other'; await rpg.handle(foreign); assert.match(foreign.result.content, /指定/);
    const b = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'battle', 'GM', st => B.createBattle(st, 'channel', 'GM', '报名').id);
    const stranger = h.interaction('stranger', null, {}, 'rpg:join:' + b); await rpg.handle(stranger); assert.match(stranger.result.content, /玩家身份组/);
    const join = h.interaction('1', null, {}, 'rpg:join:' + b); await rpg.handle(join); validateMessage(join.result);
    const duplicate = h.interaction('1', null, {}, 'rpg:join:' + b); await rpg.handle(duplicate); assert.match(duplicate.result.content, /已经参加/);
    const opening = h.interaction('GM', null, {}, 'rpg:formedit:' + form.id); await rpg.handle(opening);
    assert.ok(opening.modal); opening.modal.toJSON();
  } finally { rpg.stop(); }
});
test('role claim blocks dangerous/GM/managed/higher roles, modifies only current panel roles', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const role = (id, bits = 0n, position = 1, managed = false) => ({ id, name: id, permissions: new D.PermissionsBitField(bits), position, managed });
    for (const r of [role('player'), role('safe'), role('unrelated'), role('bad', D.PermissionFlagsBits.Administrator), role('gm')]) h.guild.roles.cache.set(r.id, r);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'roles', 'ADMIN', st => {
      st.config.gmRoleIds = ['gm'];
      st.rolePanels.panel = { id: 'panel', version: 1, published: true, title: 'test', description: '', roleIds: ['player', 'safe'], exclusive: true, allowCancel: true, labels: {} };
    });
    h.members['1'].roles.cache.set('unrelated', { id: 'unrelated' });
    const i = h.interaction('1', null, {}, 'rpg:claim:panel:safe'); await rpg.handle(i);
    assert.ok(h.members['1'].roles.cache.has('safe')); assert.ok(!h.members['1'].roles.cache.has('player')); assert.ok(h.members['1'].roles.cache.has('unrelated'));
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'badrole', 'ADMIN', st => { st.rolePanels.panel.roleIds = ['bad']; });
    const bad = h.interaction('1', null, {}, 'rpg:claim:panel:bad'); await rpg.handle(bad); assert.match(bad.result.content, /不可领取/);
  } finally { rpg.stop(); }
});
test('rulebook is generated from the same source as the Discord command', () => {
  const { markdown } = require('../src/rpg/rules');
  const file = require('node:path').join(__dirname, '..', 'RPG_RULES.md');
  if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), markdown());
});
test('failed multi-item issue/trade transaction rolls back every asset and does not commit a receipt', async () => {
  const h = harness(), st = createStore(h.deps); await st.load(C.DEFAULT_GUILD_ID);
  await st.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', s => { Object.assign(s.players, state().players); });
  const before = st.snapshot(C.DEFAULT_GUILD_ID);
  await assert.rejects(st.transact(C.DEFAULT_GUILD_ID, 'overweight', 'GM', s => {
    const t = M.publishTemplate(s, { kind: '杂物', name: '重物', rarity: 'white', weightKg: 50, value: 0 });
    M.issue(s, '1', t.id, 2);
  }));
  assert.deepEqual(st.snapshot(C.DEFAULT_GUILD_ID), before);
});
test('mixed ammunition weights and bonuses are frozen per round, final shot receives its bonus', () => {
  const s = state();
  const baseAmmo = M.publishTemplate(s, { kind: '弹药', name: '普通弹', ammoType: '9mm', rarity: 'white', weightKg: .01,
    effects: [{ target: 'attack:physical', value: 2 }] });
  M.publishTemplate(s, { kind: '弹夹', name: '夹', ammoType: '9mm', magazineType: '9mm', capacity: 3, rarity: 'white', weightKg: .1 });
  const t = weapon(s, { weaponType: '手枪', ammoType: '9mm', magazineType: '9mm', capacity: 3, current: 1, damage: { physical: '1' } });
  const w = M.issue(s, '1', t.id)[0]; M.equip(s, '1', w.id);
  const heavy = M.publishTemplate(s, { ...baseAmmo, name: '重弹', weightKg: .03, effects: [{ target: 'attack:physical', value: 10 }] });
  const ammo = M.issue(s, '1', heavy.id, 2)[0], { b } = fight(s);
  const weight = M.weight(s.players['1']); B.reload(s, b, b.current.id, ammo.id, w.magazineId);
  assert.equal(M.weight(s.players['1']), weight);
  const first = B.attack(s, b, b.current.id, w.id, b.actors[1].id, 'formal', minRng);
  assert.equal(first.damage.physical, 3); assert.equal(w.loaded.current, 2); assert.equal(M.weight(s.players['1']), weight - 1);
  B.defend(s, b, first.id, 'defend', minRng);
  B.finish(s, b, b.current.id, minRng);
  while (b.current.actorId !== b.actors[0].id) B.finish(s, b, b.current.id, minRng);
  const second = B.attack(s, b, b.current.id, w.id, b.actors[1].id, 'formal', minRng);
  assert.equal(second.damage.physical, 11); assert.equal(M.weight(s.players['1']), weight - 4);
});
test('NPC versioned loadout, GM operation, no combat charge, ending freezes historical character', () => {
  const s = state(), t = weapon(s), npc = B.validateNPC(s, { name: 'NPC', attributes: { ...s.players['2'].attributes, agility: 10 }, hpMax: 100, itemIds: [t.id], quantities: t.id + ' 1' });
  npc.id = 'npc'; npc.published = true; s.npcTemplates.npc = npc;
  M.publishTemplate(s, { ...t, weightKg: 2 }, t.id);
  const b = B.createBattle(s, 'c', 'GM', 'NPC战斗'); B.join(s, b, '1'); const a = B.addNPC(s, b, 'npc', 'enemy');
  assert.equal(a.character.inventory[a.character.equipped.weapon].snapshot.weight, 100);
  B.start(s, b, null, minRng); assert.equal(b.current.actorId, a.id);
  B.move(s, b, b.current.id, a.x - 1, a.y); assert.equal(a.character.balance, 0); assert.equal(s.players['1'].balance, 0);
  B.pause(b); M.equipCharacter(a.character, a.character.equipped.weapon, true); B.pause(b, true);
  B.finish(s, b, b.current.id, minRng); B.endBattle(s, b);
  const oldName = s.players['1'].name; M.deleteCharacter(s, '1'); M.rollCharacter(s, '1', '新角色', false, minRng); M.confirmCharacter(s, '1');
  assert.equal(B.actorCharacter(s, b.actors[0]).name, oldName); validateMessage(U.battleView(s, b));
});
test('dead current actor is skipped on resume, terrain boundaries are checked after centimeter rounding', () => {
  const { s, b } = fight(), old = b.current.actorId;
  B.pause(b); s.players['1'].hp = 0; B.pause(b, true); B.nextOpportunity(s, b, minRng);
  assert.notEqual(b.current.actorId, old);
  const next = B.actorById(b, b.current.actorId);
  next.x = 49; next.y = 25; b.current.move = 20; b.terrain['1,0'] = 'blocked';
  assert.throws(() => B.move(s, b, b.current.id, 49.999, 25));
});
test('defense deadline forces pure defense, equality fails dodge, condition penalties can lower resistance', () => {
  const { s, b } = fight(); const hit = B.attack(s, b, b.current.id, 'unarmed', b.actors[1].id, 'formal', minRng);
  hit.hit = 11; const result = B.defend(s, b, hit.id, 'dodge', () => 7);
  assert.equal(result.dodge.total, 11); assert.ok(!result.dodge.success);
  B.finish(s, b, b.current.id, minRng);
  const current = b.current, target = b.actors.find(a => a.id !== current.actorId);
  const expired = B.attack(s, b, current.id, 'unarmed', target.id, 'formal', minRng); expired.expiresAt = Date.now() - 1;
  const automatic = B.defend(s, b, expired.id, 'dodge', () => { throw new Error('must not dodge'); });
  assert.ok(automatic.defaulted); assert.equal(automatic.dodge, null);
  s.players['1'].conditions.push({ modifiers: [{ target: 'resist:mental', op: 'add', value: -3 }] });
  assert.equal(M.stats(s.players['1']).resist.mental, -3);
});
test('a full battle button flow supports move modal, attack selection, private defense and stale click', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', st => {
      st.config.gmRoleIds = ['gm']; st.config.playerRoleIds = ['player']; Object.assign(st.players, state().players);
      const b = B.createBattle(st, 'channel', 'GM', 'test'); B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng); return b.id;
    });
    let s = rpg.store.snapshot(C.DEFAULT_GUILD_ID), b = s.battles[ref], a = b.actors[0], prefix = [b.id, a.id, '1', b.current.id].join(':');
    const openMove = h.interaction('1', null, {}, 'rpg:move:' + prefix); await rpg.handle(openMove); assert.ok(openMove.modal); openMove.modal.toJSON();
    const move = h.interaction('1', null, {}, 'rpg:movevalue:' + prefix, [], { x: '26', y: '25' }); await rpg.handle(move); validateMessage(move.result);
    const choices = h.interaction('1', null, {}, 'rpg:attackpick:' + prefix + ':formal:0'); await rpg.handle(choices); validateMessage(choices.result);
    const selectAttack = h.interaction('1', null, {}, 'rpg:attackpick:' + prefix + ':formal:select', ['unarmed']); await rpg.handle(selectAttack); validateMessage(selectAttack.result);
    const target = h.interaction('1', null, {}, 'rpg:target:' + prefix + ':formal:unarmed', [b.actors[1].id]); await rpg.handle(target); validateMessage(target.result);
    s = rpg.store.snapshot(C.DEFAULT_GUILD_ID); b = s.battles[ref]; const pending = b.pending.id;
    const unauthorized = h.interaction('1', null, {}, 'rpg:defense:' + ref + ':' + pending); await rpg.handle(unauthorized); assert.match(unauthorized.result.content, /本人/);
    const defense = h.interaction('2', null, {}, 'rpg:defense:' + ref + ':' + pending); await rpg.handle(defense); validateMessage(defense.result);
    const choose = h.interaction('2', null, {}, 'rpg:defend:' + ref + ':' + pending + ':2:defend'); await rpg.handle(choose); validateMessage(choose.result);
    const stale = h.interaction('2', null, {}, 'rpg:defend:' + ref + ':' + pending + ':2:defend'); await rpg.handle(stale); assert.match(stale.result.content, /已结算/);
    const finish = h.interaction('1', null, {}, 'rpg:finish:' + prefix); await rpg.handle(finish); validateMessage(finish.result);
    const wrong = h.interaction('2', null, {}, 'rpg:finish:' + prefix); await rpg.handle(wrong); assert.match(wrong.result.content, /不属于你/);
  } finally { rpg.stop(); }
});
test('restart scheduler settles exactly one expired attack without rerolling the attack', async () => {
  const h = harness(), first = createRpg(h.deps); await first.start();
  let ref;
  try {
    ref = await first.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', st => {
      Object.assign(st.players, state().players);
      const b = B.createBattle(st, 'channel', 'GM', 'test'); B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng);
      B.attack(st, b, b.current.id, 'unarmed', b.actors[1].id, 'formal', minRng); b.pending.expiresAt = Date.now() - 1; return b.id;
    });
  } finally { first.stop(); }
  const second = createRpg(h.deps); await second.start();
  try { const s = second.store.snapshot(C.DEFAULT_GUILD_ID); assert.equal(s.battles[ref].pending, null); assert.equal(s.players['2'].hp, 10); }
  finally { second.stop(); }
  const third = createRpg(h.deps); await third.start();
  try { assert.equal(third.store.snapshot(C.DEFAULT_GUILD_ID).players['2'].hp, 10); } finally { third.stop(); }
});
test('persistent role-panel wizard, publish, list reopen and defaults remain usable', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    h.guild.roles.cache.set('player', { id: 'player', name: '玩家', managed: false, position: 1, permissions: new D.PermissionsBitField(0n) });
    const create = h.interaction('ADMIN', null, {}, 'rpg:newroles'); await rpg.handle(create); validateMessage(create.result);
    let s = rpg.store.snapshot(C.DEFAULT_GUILD_ID); const f = Object.values(s.forms)[0];
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'pick-field', 'ADMIN', st => { st.forms[f.id].field = 2; });
    const choose = h.interaction('ADMIN', null, {}, 'rpg:formroles:' + f.id, ['player']); await rpg.handle(choose); validateMessage(choose.result);
    const publish = h.interaction('ADMIN', null, {}, 'rpg:formpublish:' + f.id); await rpg.handle(publish); validateMessage(publish.result);
    s = rpg.store.snapshot(C.DEFAULT_GUILD_ID); const panel = Object.values(s.rolePanels)[0]; assert.ok(panel.messageId);
    const list = h.interaction('ADMIN', null, {}, 'rpg:rolelist:0'); await rpg.handle(list); validateMessage(list.result);
    const edit = h.interaction('ADMIN', null, {}, 'rpg:rolelist:select', ['panel-' + panel.id]); await rpg.handle(edit); validateMessage(edit.result);
  } finally { rpg.stop(); }
});
test('frozen weapon condition version and refreshing lower severity preserve old modifiers', () => {
  const s = state();
  const condition = { id: 'z', version: 1, published: true, name: '异常', type: 'physical', effectType: 'numeric', levels: {
    '一般': { difficulty: 100, duration: { kind: 'actions', count: 3 }, effects: [{ target: 'attr:agility', amount: '1d6' }], worsenAfter: 0 } } };
  s.conditionTemplates.z = condition;
  const t = weapon(s, { conditions: [{ id: 'z', severity: '一般' }] });
  s.conditionTemplates.z = { ...condition, version: 2, name: '新异常' };
  B.applyCondition(s, s.players['2'], t.conditions[0], minRng);
  const old = s.players['2'].conditions[0]; assert.equal(old.template.version, 1);
  B.applyCondition(s, s.players['2'], { id: 'z', severity: '一般' }, (min, max) => max - 1);
  assert.equal(s.players['2'].conditions[0].modifiers[0].value, -1);
  assert.equal(s.players['2'].conditions[0].template.name, '异常');
});
test('public map has all 20 participants and numeric statuses without leaking inventory/balance', () => {
  const s = state(), b = B.createBattle(s, 'channel', 'GM', '大地图', 20, 20);
  for (let n = 0; n < 20; n++) {
    const p = M.newCharacter('很长的角色名'.repeat(8), { strength: 6, constitution: 6, mind: 6, appearance: 6, intelligence: 6, agility: n + 1, knowledge: 6 });
    p.userId = 'user' + n; p.balance = 123456789; s.players[p.userId] = p; B.join(s, b, p.userId);
  }
  const view = U.battleView(s, b); validateMessage(view);
  const body = view.embeds.map(e => e.data.description).join('\n');
  for (const actor of b.actors) assert.ok(body.includes(actor.id));
  assert.ok(!body.includes('123456789'));
});
test('stale character reroll cannot consume another reroll or confirm an unseen roll', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const create = h.interaction('1', '建卡', { 名字: '初始' }); await rpg.handle(create);
    const old = rpg.store.snapshot(C.DEFAULT_GUILD_ID).characterDrafts['1'];
    const first = h.interaction('1', null, {}, 'rpg:char:reroll:' + old.id); await rpg.handle(first); validateMessage(first.result);
    const second = h.interaction('1', null, {}, 'rpg:char:reroll:' + old.id); await rpg.handle(second); assert.match(second.result.content, /已经变化/);
    const stale = h.interaction('1', null, {}, 'rpg:char:confirm:' + old.id); await rpg.handle(stale); assert.match(stale.result.content, /已经变化/);
    const current = rpg.store.snapshot(C.DEFAULT_GUILD_ID).characterDrafts['1'];
    assert.equal(current.rerolls, 1);
    const confirm = h.interaction('1', null, {}, 'rpg:char:confirm:' + current.id); await rpg.handle(confirm); validateMessage(confirm.result);
  } finally { rpg.stop(); }
});
test('NPC controls and private state reject other players, GM uses quick switch and free defense', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const ids = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', st => {
      st.config.gmRoleIds = ['gm']; Object.assign(st.players, state().players);
      const w = weapon(st), t = B.validateNPC(st, { name: 'NPC', attributes: { ...st.players['1'].attributes, agility: 20 }, hpMax: 50, itemIds: [w.id] });
      t.id = 'npc'; t.published = true; st.npcTemplates.npc = t;
      const b = B.createBattle(st, 'channel', 'GM', 'test'); B.join(st, b, '1'); const a = B.addNPC(st, b, 'npc', 'enemy');
      B.position(b, a.id, 25, 25); B.start(st, b, null, minRng);
      return { b: b.id, a: a.id, turn: b.current.id };
    });
    const prefix = [ids.b, ids.a, 'GM', ids.turn].join(':');
    const unauthorized = h.interaction('1', null, {}, 'rpg:view:' + [ids.b, ids.a, '1', ids.turn].join(':') + ':overview:0');
    await rpg.handle(unauthorized); assert.match(unauthorized.result.content, /只能操作/);
    const menu = h.interaction('GM', null, {}, 'rpg:weaponpick:' + prefix + ':0'); await rpg.handle(menu); validateMessage(menu.result);
    const switchWeapon = h.interaction('GM', null, {}, 'rpg:weaponpick:' + prefix + ':select', ['none']); await rpg.handle(switchWeapon); validateMessage(switchWeapon.result);
    const finalState = rpg.store.snapshot(C.DEFAULT_GUILD_ID);
    assert.equal(finalState.battles[ids.b].current.quick, 0);
    assert.equal(finalState.battles[ids.b].actors[1].character.balance, 0);
    const hit = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'player-attack', 'GM', st => {
      const b = st.battles[ids.b];
      B.finish(st, b, b.current.id, minRng);
      while (b.current.actorId === ids.a) B.finish(st, b, b.current.id, minRng);
      return B.attack(st, b, b.current.id, 'unarmed', ids.a, 'formal', minRng);
    });
    const ownPlayer = h.interaction('1', null, {}, 'rpg:defense:' + ids.b + ':' + hit.id); await rpg.handle(ownPlayer); assert.match(ownPlayer.result.content, /GM身份组/);
    const defending = h.interaction('GM', null, {}, 'rpg:defend:' + ids.b + ':' + hit.id + ':GM:defend'); await rpg.handle(defending); validateMessage(defending.result);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[ids.b].current.quick, 1);
  } finally { rpg.stop(); }
});
test('audit and deduplication snapshots are immutable after later inventory changes', async () => {
  const h = harness(), st = createStore(h.deps); await st.load(C.DEFAULT_GUILD_ID);
  const first = await st.transact(C.DEFAULT_GUILD_ID, 'issue', 'GM', s => {
    Object.assign(s.players, state().players);
    const template = Object.values(s.catalog)[0]; return M.issue(s, '1', template.id, 3)[0];
  });
  await st.transact(C.DEFAULT_GUILD_ID, 'drop', '1', s => M.drop(s, '1', first.id, 1));
  const saved = st.snapshot(C.DEFAULT_GUILD_ID);
  assert.equal(saved.players['1'].inventory[first.id].quantity, 2);
  assert.equal(saved.receipts.issue.result.quantity, 3);
  assert.equal(saved.events.find(e => e.id === 'issue').result.quantity, 3);
});
test('consumables heal outside battle and in battle use one quick action with recorded dice', () => {
  const s = state(), p = s.players['1'];
  const t = M.publishTemplate(s, { kind: '消耗品', name: '医疗物品', rarity: 'white', weightKg: .1, heal: '1d6' });
  const i = M.issue(s, '1', t.id, 2)[0]; p.hp = 10;
  const result = M.consume(p, i.id, minRng); assert.equal(result.healed, 1); assert.equal(p.hp, 11);
  const { b } = fight(s); const healed = B.useItem(s, b, b.current.id, i.id, minRng);
  assert.equal(healed.roll.total, 1); assert.equal(b.current.quick, 0); assert.ok(!p.inventory[i.id]);
});

// Upgrade acceptance uses the same isolated AES-GCM harness as the original
// regression suite. No production bot, user DMs or guild mutations are made.
function food(s, extra = {}) {
  return M.publishTemplate(s, { kind: '食物', name: '能量棒', rarity: 'green', description: '压制谷物与坚果，可补充体力。',
    weightKg: 0.1, value: 20, boxes: ['饭盒'], heal: '1d6', clearConditions: [], effects: [],
    duration: { kind: 'actions', count: 2 }, ...extra });
}
function jsonComponents(result) { return result.components.flatMap(r => (r.toJSON ? r.toJSON() : r).components); }
function control(result, label) {
  const c = jsonComponents(result).find(c => c.label === label || c.placeholder === label);
  assert.ok(c, 'Missing control: ' + label); return c.custom_id;
}
async function click(h, rpg, uid, from, label, values) {
  const i = h.interaction(uid, null, {}, control(from.result, label), values);
  i.message = { id: from.message?.id || from.id, flags: new D.MessageFlagsBitField(D.MessageFlags.Ephemeral) };
  await rpg.handle(i); if (!i.modal) validateMessage(i.result); return i;
}
async function submit(h, rpg, uid, opened, values) {
  const i = h.interaction(uid, null, {}, opened.modal.toJSON().custom_id, null, values);
  i.message = opened.message; await rpg.handle(i); validateMessage(i.result); return i;
}
async function setupUpgrade(h, rpg) {
  await rpg.start();
  await rpg.store.transact(C.DEFAULT_GUILD_ID, 'upgrade-setup', 'ADMIN', st => {
    st.config.gmRoleIds = ['gm']; st.config.playerRoleIds = ['player']; Object.assign(st.players, state().players);
  });
}
const bodyOf = result => (result.embeds || []).map(e => (e.toJSON ? e.toJSON() : e).description || '').join('\n');

test('72 modern descriptions migrate exact placeholders only and preserve customized instances and history', () => {
  const s = state(); delete s.upgrade; delete s.checks; delete s.sessions; delete s.lootPublications;
  const seeds = Object.values(s.catalog).filter(t => t.boxes?.length);
  assert.equal(seeds.length, 72); assert.equal(new Set(seeds.map(t => t.description)).size, 72);
  for (const t of seeds) { assert.ok(!t.description.startsWith('现代场景中的')); t.description = '现代场景中的' + t.name + '，价值为游戏内估值。'; }
  const custom = seeds[0]; custom.description = 'GM手写说明';
  const old = M.makeItem(seeds[1]), pending = M.makeItem(seeds[2]); s.players['1'].inventory[old.id] = old;
  s.players['1'].pendingLoot['饭盒'] = pending; delete s.players['1'].temporaryEffects;
  s.events.push({ historicalDescription: seeds[1].description });
  const report = A.migrate(s); assert.equal(report.descriptions, 73);
  assert.equal(s.catalog[custom.id].description, 'GM手写说明');
  assert.equal(s.catalog[seeds[1].id].version, 2); assert.equal(old.version, 1);
  assert.equal(old.snapshot.description, C.seedCatalog()[seeds[1].id].description);
  assert.ok(s.events[0].historicalDescription.startsWith('现代场景中的'));
  assert.deepEqual(s.players['1'].temporaryEffects, []); assert.equal(A.migrate(s), null);
});

test('food and medicine templates validate dice, cures and required positive duration', () => {
  const s = state();
  const bad = { effects: [{ target: 'attr:agility', op: 'add', value: 2 }], duration: null };
  assert.throws(() => food(s, bad));
  assert.throws(() => food(s, { effects: bad.effects, duration: { kind: 'minutes', count: 0 } }));
  assert.throws(() => food(s, { heal: '-2' }));
  assert.throws(() => food(s, { clearConditions: ['missing'] }));
  const t = food(s, { kind: '药品', heal: '5', effects: bad.effects, duration: { kind: 'minutes', count: 5 } });
  assert.equal(t.kind, '药品'); assert.equal(t.duration.count, 5);
  for (const kind of ['食物', '药品']) {
    const f = F.create(s, 'GM', 'item', kind), keys = F.fields(f).map(d => d.key);
    for (const key of ['heal', 'clearConditions', 'duration.kind', 'duration.count', 'effects', 'boxes']) assert.ok(keys.includes(key));
    validateMessage(F.view(s, f)); validateMessage(F.view(s, f, true));
  }
});

test('consumable use cures independently, replaces same template buffs and does not heal increased HP automatically', () => {
  const s = state(), p = s.players['1']; p.hp = 5;
  p.conditions.push({ id: 'z', templateId: 'cold', template: { name: '感冒', effectType: 'text', levels: { '一般': {} } }, severity: '一般', modifiers: [] });
  const t = food(s, { heal: '0', effects: [{ target: 'hpMax', op: 'add', value: 10 }, { target: 'attr:agility', op: 'add', value: 2 }],
    clearConditions: [] });
  const item = M.issue(s, '1', t.id, 2)[0];
  // Freeze a cure reference as on a previously published item.
  item.snapshot.clearConditions = ['cold']; item.snapshot.heal = '3';
  const first = M.consume(p, item.id, minRng, 'turn1');
  assert.deepEqual(first.cleared, ['感冒']); assert.equal(first.healed, 3); assert.equal(p.hp, 8);
  assert.equal(M.stats(p).maxHP, 25); assert.equal(M.stats(p).attributes.agility, 8);
  p.temporaryEffects[0].remaining = 1;
  const second = M.consume(p, item.id, minRng, 'turn2');
  assert.equal(second.cleared.length, 0); assert.equal(p.temporaryEffects.length, 1); assert.equal(p.temporaryEffects[0].remaining, 2);
  assert.equal(p.hp, 11); assert.equal(p.inventory[item.id], undefined);
});

test('action effects skip use opportunity, persist outside combat and expire after the next own opportunities', () => {
  const s = state(), p = s.players['1'], t = food(s, { heal: '0', effects: [{ target: 'attr:agility', op: 'add', value: 2 }] });
  const item = M.issue(s, '1', t.id)[0]; M.consume(p, item.id, minRng, 'used');
  M.finishEffects(p, 'used'); assert.equal(p.temporaryEffects[0].remaining, 2);
  assert.equal(A.expireAll(s, Date.now() + 100000000).length, 0);
  M.finishEffects(p, 'next'); assert.equal(p.temporaryEffects[0].remaining, 1);
  const expired = M.finishEffects(p, 'third'); assert.equal(expired.length, 1); assert.equal(M.stats(p).attributes.agility, 6);
});

test('minute effects expire while paused, clamp HP and remaining movement without granting HP', () => {
  const { s, b } = fight(), p = s.players['1']; B.pause(b);
  const t = food(s, { heal: '0', effects: [{ target: 'hpMax', op: 'add', value: 10 }, { target: 'attr:agility', op: 'add', value: 2 }],
    duration: { kind: 'minutes', count: 1 } });
  const item = M.issue(s, '1', t.id)[0], now = Date.now(); M.consume(p, item.id, minRng, null, now);
  assert.equal(p.hp, 15); p.hp = 25; b.current.move = 24; b.current.moveSpent = 6;
  assert.deepEqual(A.expireAll(s, now + 59999), []);
  assert.deepEqual(A.expireAll(s, now + 60000), [p.id]); assert.equal(p.hp, 15); assert.equal(b.current.move, 12);
  assert.equal(b.status, 'paused'); assert.equal(p.temporaryEffects.length, 0);
});

test('food flat and percent modifiers combine with equipment in existing order', () => {
  const s = state(), p = s.players['1'], t = food(s, { heal: '0', effects: [
    { target: 'attr:strength', op: 'add', value: 5 }, { target: 'attr:strength', op: 'percent', value: 20 }] });
  M.consume(p, M.issue(s, '1', t.id)[0].id, minRng);
  assert.equal(M.stats(p).attributes.strength, 12);
  const negative = food(s, { name: '虚弱剂', heal: '0', effects: [{ target: 'attr:constitution', op: 'add', value: -2 }] });
  p.hp = 15; const r = M.consume(p, M.issue(s, '1', negative.id)[0].id, minRng);
  assert.equal(p.hp, 9); assert.equal(r.healed, 0); assert.equal(r.hpChange, -6);
});

test('use command and bag detail are self-only, reject reserved goods, paused battle and duplicate panel clicks', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'food', 'GM', s => M.issue(s, '1', food(s).id, 2)[0].id);
    const bag = h.interaction('1', '背包'); await rpg.handle(bag);
    const detail = await click(h, rpg, '1', bag, '选择物品查看描述与使用效果', [ref]); assert.ok(detail.updatedSource);
    const wrong = h.interaction('2', null, {}, control(detail.result, '使用一件')); await rpg.handle(wrong);
    assert.match(wrong.result.content, /不属于你|失效/);
    const once = await click(h, rpg, '1', detail, '使用一件'); assert.ok(once.updatedSource);
    const repeat = h.interaction('1', null, {}, control(detail.result, '使用一件')); await rpg.handle(repeat);
    assert.match(repeat.result.content, /失效/); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[ref].quantity, 1);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'reserve', '1', s => {
      const o = M.createOffer(s, '1', '2'); M.updateOffer(s, o.id, '1', [{ id: ref, quantity: 1 }], 0);
    });
    const denied = h.interaction('1', '使用', { 物品: ref }); await rpg.handle(denied); assert.match(denied.result.content, /预留/);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'pause', 'GM', s => {
      for (const o of Object.values(s.offers)) M.cancelOffer(s, o.id, '1');
      const b = B.createBattle(s, 'channel', 'GM', '道具战斗'); B.join(s, b, '1'); B.start(s, b, null, minRng); B.pause(b);
    });
    const paused = h.interaction('1', '使用', { 物品: ref }); await rpg.handle(paused); assert.match(paused.result.content, /暂停/);
    const battleId = Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles)[0];
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'resume', 'GM', s => B.pause(s.battles[battleId], true));
    const used = h.interaction('1', '使用', { 物品: ref }); await rpg.handle(used);
    const b = rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[battleId]; assert.equal(b.current.quick, 0); assert.ok(!used.result.content);
  } finally { rpg.stop(); }
});

test('public loot announces item in command channel without private assets and failed publication can resend without redraw', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'tickets', 'GM', s => { s.players['1'].tickets.card = 2; s.players['1'].balance = 987654; });
    const draw = h.interaction('1', '抽卡'); await rpg.handle(draw); validateMessage(draw.result);
    const s = rpg.store.snapshot(C.DEFAULT_GUILD_ID), record = Object.values(s.lootPublications)[0];
    const message = h.messages.get(record.messageId); assert.ok(bodyOf(message.lastPayload).includes('<@1>'));
    assert.equal(record.channelId, draw.channelId); assert.equal(s.players['1'].tickets.card, 1);
    assert.ok(!JSON.stringify(message.lastPayload).includes('987654'));
    const originalSend = h.ch.send; let failed = false;
    h.ch.send = async opts => { if (opts.embeds && !failed) { failed = true; throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } return originalSend(opts); };
    const second = h.interaction('1', '抽卡'); await rpg.handle(second); assert.match(bodyOf(second.result), /待核对|不会重新/);
    const saved = rpg.store.snapshot(C.DEFAULT_GUILD_ID), r = Object.values(saved.lootPublications).find(r => !r.messageId);
    assert.equal(saved.players['1'].tickets.card, 0); assert.equal(r.publication.status, 'failed');
    const retry = await click(h, rpg, '1', second, '核对后补发已存结果');
    assert.ok(rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications[r.id].messageId);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.card, 0);
    assert.ok(bodyOf(retry.result).includes(r.result.item.snapshot.name));
  } finally { rpg.stop(); }
});

test('pending public loot keeps item and ticket on retry, claim updates same public record', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'heavy', 'GM', s => {
      s.players['1'].tickets.boxes['大衣'] = 1;
      s.players['1'].inventory.heavy = { id: 'heavy', quantity: 1, snapshot: { name: '重物', kind: '杂物', weight: 5000 } };
    });
    const first = h.interaction('1', '开箱', { 箱型: '大衣' }); await rpg.handle(first);
    const r = Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications)[0];
    assert.equal(r.result.pending, true); assert.match(bodyOf(h.messages.get(r.messageId).lastPayload), /未扣次数/);
    const second = h.interaction('1', '开箱', { 箱型: '大衣' }); await rpg.handle(second);
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications).length, 1);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.boxes['大衣'], 1);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'remove-heavy', '1', s => { delete s.players['1'].inventory.heavy; });
    const claim = h.interaction('1', '开箱', { 箱型: '大衣' }); await rpg.handle(claim);
    const saved = rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications[r.id];
    assert.equal(saved.messageId, r.messageId); assert.equal(saved.result.pending, false);
    assert.equal(saved.result.item.id, r.result.item.id); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.boxes['大衣'], 0);
  } finally { rpg.stop(); }
});

test('checks use effective attributes, exact d20/d100 boundaries, attempt caps and stop after success', () => {
  const s = state(); const t = food(s, { heal: '0', effects: [{ target: 'attr:strength', op: 'add', value: 2 }] });
  M.consume(s.players['1'], M.issue(s, '1', t.id)[0].id, minRng);
  const c = A.createCheck(s, 'GM', 'channel', { name: '举起', rule: 'd20', attribute: 'strength', threshold: 8, maxAttempts: 2 });
  const r = A.rollCheck(s, c.id, '1', minRng); assert.equal(r.modifier, 7); assert.equal(r.total, 8); assert.ok(r.success);
  assert.throws(() => A.rollCheck(s, c.id, '1'));
  const d100 = A.createCheck(s, 'GM', 'channel', { name: '搜索', rule: 'd100', threshold: 10, attribute: 'strength', maxAttempts: 2 });
  assert.equal(A.rollCheck(s, d100.id, '2', () => 11).success, false);
  const at = A.rollCheck(s, d100.id, '2', () => 10); assert.equal(at.success, true); assert.equal(at.modifier, 0);
  assert.throws(() => A.rollCheck(s, d100.id, '2'));
  assert.throws(() => A.validateCheck({ name: 'x', rule: 'd100', threshold: 101 }));
  const capped = A.createCheck(s, 'GM', 'channel', { name: '难题', rule: 'd20', threshold: 20 });
  A.rollCheck(s, capped.id, '2', minRng); assert.throws(() => A.rollCheck(s, capped.id, '2'));
  capped.status = 'ended'; assert.throws(() => A.rollCheck(s, capped.id, '1'));
});

test('runtime checks require player role and valid card, publish dice, remain free and recover results', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const denied = h.interaction('1', '鉴定', { sub: '发布', 名称: '任务', 规则: 'd100', 门槛: 100 });
    await rpg.handle(denied); assert.match(denied.result.content, /GM/);
    const gm = h.interaction('GM', '鉴定', { sub: '发布', 名称: '任务', 规则: 'd100', 门槛: 100 });
    await rpg.handle(gm); const c = Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks)[0];
    const stranger = h.interaction('stranger', null, {}, 'rpg:activity:check:roll:' + c.id); await rpg.handle(stranger);
    assert.match(stranger.result.content, /玩家身份组/);
    h.members.stranger.roles.cache.set('player', { id: 'player' });
    const nocard = h.interaction('stranger', null, {}, 'rpg:activity:check:roll:' + c.id); await rpg.handle(nocard);
    assert.match(nocard.result.content, /角色/);
    const i = h.interaction('1', null, {}, 'rpg:activity:check:roll:' + c.id); await rpg.handle(i);
    const at = rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks[c.id].attempts['1'][0];
    assert.ok(at.messageId); assert.equal(at.modifier, 0); assert.equal(at.success, true);
    assert.match(bodyOf(h.messages.get(at.messageId).lastPayload), /成功/); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].balance, 0);
    const duplicate = h.interaction('1', null, {}, 'rpg:activity:check:roll:' + c.id); await rpg.handle(duplicate);
    assert.match(duplicate.result.content, /已经成功/);
    const restored = createStore(h.deps); await restored.load(C.DEFAULT_GUILD_ID);
    assert.deepEqual(restored.snapshot(C.DEFAULT_GUILD_ID).checks[c.id].attempts, rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks[c.id].attempts);
  } finally { rpg.stop(); }
});

test('Beijing session time is timezone-independent, validates dates and exactly handles 15-minute boundary', () => {
  const now = Date.UTC(2026, 9, 5, 0, 0);
  const timestamp = A.parseBeijing('2026-10-05 20:30', now); assert.equal(timestamp, Date.UTC(2026, 9, 5, 12, 30));
  assert.equal(A.beijing(timestamp), '2026-10-05 20:30');
  for (const text of ['2026-02-30 20:00', '2026-10-05 24:00', '2026-10-05 08:00', '2026/10/05 20:00']) assert.throws(() => A.parseBeijing(text, now));
  const s = state(), at = now + 1000;
  const first = A.createSession(s, 'GM', 'channel', { name: '准时', startsAt: at }, now);
  A.sessionJoin(s, first.id, '1', false, now); A.sessionJoin(s, first.id, '1', false, now);
  assert.equal(Object.keys(first.participants).length, 1);
  assert.deepEqual(A.prepareReminder(s, first.id, at + 900000), ['1']); assert.equal(first.reminder.status, 'preparing');
  const late = A.createSession(s, 'GM', 'channel', { name: '过时', startsAt: at }, now);
  assert.equal(A.prepareReminder(s, late.id, at + 900001), null); assert.equal(late.status, 'overdue');
  assert.deepEqual(A.prepareReminder(s, late.id, at + 900001, true), []);
});

test('GM opening panel supports modal, preview, edit, publish and private-source update', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const i = h.interaction('GM', '开团'); await rpg.handle(i); validateMessage(i.result);
    const open = await click(h, rpg, 'GM', i, '创建开团'); assert.ok(open.modal);
    const preview = await submit(h, rpg, 'GM', open, { name: '测试团', time: A.beijing(Date.now() + 3600000), description: '团说明' });
    assert.ok(preview.updatedSource); assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions).length, 0);
    const edit = await click(h, rpg, 'GM', preview, '返回修改'); assert.ok(edit.modal);
    const edited = await submit(h, rpg, 'GM', edit, { name: '修订团', time: A.beijing(Date.now() + 7200000), description: '新说明' });
    const published = await click(h, rpg, 'GM', edited, '确认发布');
    const s = Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions)[0];
    assert.equal(s.name, '修订团'); assert.ok(s.messageId); assert.ok(published.updatedSource);
    assert.equal(h.messages.get(s.messageId).lastPayload.components[0].toJSON().components[0].custom_id, 'rpg:activity:session:join:' + s.id);
    const again = h.interaction('GM', null, {}, control(edited.result, '确认发布')); await rpg.handle(again); assert.match(again.result.content, /失效/);
  } finally { rpg.stop(); }
});

test('session enrollment needs player role only, supports duplicate/withdraw and preserves time edits and cancellation', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    h.members.stranger.roles.cache.set('player', { id: 'player' });
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'session', 'GM', s => A.createSession(s, 'GM', 'channel', { name: '无卡报名', startsAt: Date.now() + 3600000 }).id);
    for (let n = 0; n < 2; n++) { const join = h.interaction('stranger', null, {}, 'rpg:activity:session:join:' + ref); await rpg.handle(join); assert.ok(!join.result.content); }
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].participants).length, 1);
    const leave = h.interaction('stranger', null, {}, 'rpg:activity:session:withdraw:' + ref); await rpg.handle(leave);
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].participants).length, 0);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'edit-session', 'GM', s => A.editSession(s, ref, { name: '改时间', startsAt: Date.now() + 7200000 }, 1));
    const restore = createStore(h.deps); await restore.load(C.DEFAULT_GUILD_ID);
    assert.equal(restore.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].version, 2);
    const cancel = h.interaction('GM', null, {}, 'rpg:activity:session:cancel:' + ref); await rpg.handle(cancel);
    await rpg.activities.remind(C.DEFAULT_GUILD_ID, ref, true);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].reminder.status, 'cancelled');
  } finally { rpg.stop(); }
});

test('session reminders chunk real mentions, filter departed members and never ping again after restart', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg); rpg.activities.remember(h.guild);
  try {
    const valid = Array.from({ length: 121 }, (_, n) => String(100000000000000000n + BigInt(n)));
    h.guild.members.fetch = async ({ user }) => {
      if (user === 'departed') throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      return h.members[user] || (valid.includes(user) ? { id: user } : null);
    };
    const now = Date.now(), ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'group-session', 'GM', s => {
      const r = A.createSession(s, 'GM', 'channel', { name: '批次提醒', startsAt: now + 1 }, now);
      for (const uid of [...valid, 'departed']) A.sessionJoin(s, r.id, uid, false, now); return r.id;
    });
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'session', ref);
    await rpg.activities.remind(C.DEFAULT_GUILD_ID, ref, false, now + 1);
    const sent = h.sent.filter(m => m.lastPayload.content?.includes('到开团时间了'));
    assert.equal(sent.length, 3); assert.deepEqual(sent.flatMap(m => m.lastPayload.allowedMentions.users), valid);
    assert.ok(sent.every(m => m.lastPayload.content.length <= 2000)); assert.ok(sent.every(m => m.lastPayload.content.includes('https://discord.com/channels/')));
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].status, 'notified');
    rpg.stop(); const restored = createRpg(h.deps); await restored.start();
    try { await restored.activities.remind(C.DEFAULT_GUILD_ID, ref, true); assert.equal(h.sent.filter(m => m.lastPayload.content?.includes('到开团时间了')).length, 3); }
    finally { restored.stop(); }
  } finally { rpg.stop(); }
});

test('late sessions require GM decision and ambiguous reminder batches stop automatic retries across restart', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg); rpg.activities.remember(h.guild);
  try {
    const now = Date.now(), ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'late-session', 'GM', s => {
      const r = A.createSession(s, 'GM', 'channel', { name: '迟到', startsAt: now + 1 }, now);
      A.sessionJoin(s, r.id, '1', false, now); return r.id;
    });
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'session', ref);
    await rpg.activities.remind(C.DEFAULT_GUILD_ID, ref, false, now + 900002);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].status, 'overdue');
    const original = h.ch.send; h.ch.send = async options => {
      if (options.content?.includes('到开团时间了')) { await original(options); throw new Error('connection reset after delivery'); }
      return original(options);
    };
    await rpg.activities.remind(C.DEFAULT_GUILD_ID, ref, true);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].reminder.status, 'uncertain');
    assert.equal(h.sent.filter(m => m.lastPayload.content?.includes('到开团时间了')).length, 1);
    rpg.stop(); const restored = createRpg(h.deps); await restored.start();
    try {
      await restored.tickGuild(C.DEFAULT_GUILD_ID);
      assert.equal(h.sent.filter(m => m.lastPayload.content?.includes('到开团时间了')).length, 1);
      const delivered = h.interaction('GM', null, {}, 'rpg:activity:session:delivered:' + ref); await restored.handle(delivered);
      assert.equal(restored.store.snapshot(C.DEFAULT_GUILD_ID).sessions[ref].status, 'notified');
    } finally { restored.stop(); }
  } finally { rpg.stop(); }
});

test('GM battle dropdown chooses existing NPC, supports HP/location forms and clears public and private controls at end', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const template = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'npc-template', 'GM', s => {
      const f = F.create(s, 'GM', 'npc'); f.data.name = '巡逻员'; f.data.description = '穿着反光背心的巡逻员。'; return F.publish(s, f).id;
    });
    const gm = h.interaction('GM', '战斗', { sub: '招募', 名称: 'GUI战斗' }); await rpg.handle(gm);
    const b = Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles)[0]; validateMessage(gm.result);
    const npcs = await click(h, rpg, 'GM', gm, 'NPC模板下拉');
    const choose = await click(h, rpg, 'GM', npcs, 'GM · 选择已有NPC', [template]); assert.match(bodyOf(choose.result), /巡逻员/);
    const added = await click(h, rpg, 'GM', choose, '选择加入的阵营', ['enemy']);
    const actor = rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[b.id].actors[0]; assert.equal(actor.team, 'enemy');
    const tab = await click(h, rpg, 'GM', added, '选择管理操作', ['actors']);
    const detail = await click(h, rpg, 'GM', tab, 'GM · 选择角色', [actor.id]);
    const hp = await click(h, rpg, 'GM', detail, '调整生命');
    const savedHP = await submit(h, rpg, 'GM', hp, { hp: '5' }); assert.ok(savedHP.updatedSource);
    const position = await click(h, rpg, 'GM', savedHP, '位置 / 阵营');
    const moved = await submit(h, rpg, 'GM', position, { x: '60', y: '70', team: '友方' });
    const stored = rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[b.id].actors[0];
    assert.equal(stored.character.hp, 5); assert.equal(stored.x, 60); assert.equal(stored.team, 'ally');
    const overview = await click(h, rpg, 'GM', moved, '返回GM概览');
    const started = await click(h, rpg, 'GM', overview, '正式开战');
    const personal = await click(h, rpg, 'GM', started, '操作当前角色');
    const publicPayload = h.messages.get(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[b.id].messageId);
    assert.ok(publicPayload.lastPayload.components.length);
    const manager = h.interaction('GM', '战斗', { sub: '面板' }); await rpg.handle(manager);
    const end = await click(h, rpg, 'GM', manager, '结束战斗'); await click(h, rpg, 'GM', end, '确认结束并清理面板');
    assert.equal(publicPayload.lastPayload.components.length, 0);
    assert.equal(personal.result.components.length, 0);
    const old = h.interaction('GM', null, {}, control(started.edits[0], '操作当前角色')); await rpg.handle(old); assert.match(old.result.content, /失效/);
  } finally { rpg.stop(); }
});

test('private navigation updates one message, rejects owner spoof and stale modal after leaving its step', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const entry = h.interaction('GM', '录入物品', { 类型: '药品' }); await rpg.handle(entry);
    const field = jsonComponents(entry.result).find(c => c.type === 3);
    const next = await click(h, rpg, 'GM', entry, field.placeholder, ['0']);
    const edit = await click(h, rpg, 'GM', next, '编辑：名称'); assert.ok(edit.modal);
    const change = await click(h, rpg, 'GM', next, field.placeholder, ['1']); assert.ok(change.updatedSource);
    const stale = await submit(h, rpg, 'GM', edit, { value: '不能写入' }); assert.match(stale.result.content, /失效|变化/);
    assert.equal(Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms)[0].data.name, '');
    const stranger = h.interaction('1', null, {}, jsonComponents(change.result)[0].custom_id, ['2']); await rpg.handle(stranger);
    assert.match(stranger.result.content, /失效|不属于/);
  } finally { rpg.stop(); }
});

test('upgrade cards and commands meet full Discord limits with long real IDs and maximal descriptions', () => {
  const s = state(), b = B.createBattle(s, 'channel', 'GM', '卡片结构');
  s.players['1234567890123456789'] = s.players['1']; B.join(s, b, '1234567890123456789'); B.start(s, b, null, minRng);
  const p = s.players['1'];
  for (const kind of C.ITEM_KINDS) {
    const f = F.create(s, 'GM', 'item', kind); f.data.name = '长名称'.repeat(20); f.data.description = '字'.repeat(2000);
    f.data.effects = Array.from({ length: 30 }, () => ({ target: 'attr:agility', op: 'percent', value: 999999 }));
    for (let page = 0; page < Math.ceil(F.fields(f).length / 20); page++) { f.page = page; validateMessage(F.view(s, f, true)); }
  }
  for (let n = 0; n < 12; n++) p.temporaryEffects.push({ id: String(n), name: '效果'.repeat(40), duration: { kind: 'actions' }, remaining: 5,
    modifiers: Array.from({ length: 30 }, () => ({ target: 'attr:agility', value: 100, op: 'percent' })) });
  for (let page = 0; page < 4; page++) validateMessage(U.personalView(s, b, b.actors[0], '1234567890123456789', 'status', page));
  validateMessage(U.characterView(p)); validateMessage(U.inventoryView(s, '1', '1234567890123456789'));
  validateMessage(AU.checkView(A.createCheck(s, 'GM', 'channel', { name: '鉴定', description: '字'.repeat(2000), rule: 'd20', threshold: 10 })));
  validateMessage(AU.sessionView(A.createSession(s, 'GM', 'channel', { name: '开团', description: '字'.repeat(2000), startsAt: Date.now() + 100000 })));
  const all = commands().map(c => c.toJSON()); assert.equal(all.length, 22); assert.equal(new Set(all.map(c => c.name)).size, all.length);
  function validOptions(options) {
    let optional = false;
    for (const o of options || []) { if (o.type > 2) { if (!o.required) optional = true; else assert.equal(optional, false, o.name); }
      assert.ok(!o.choices || o.choices.length <= 25); validOptions(o.options); }
  }
  all.forEach(c => validOptions(c.options));
});

test('restart preserves minute deadlines, action duration and published templates, migration is saved once encrypted', async () => {
  const h = harness(), store = createStore(h.deps); await store.load(C.DEFAULT_GUILD_ID);
  const data = await store.transact(C.DEFAULT_GUILD_ID, 'effects-before-restart', 'GM', s => {
    Object.assign(s.players, state().players); const p = s.players['1'];
    const t = food(s, { heal: '0', effects: [{ target: 'attr:agility', op: 'add', value: 2 }], duration: { kind: 'minutes', count: 5 } });
    M.consume(p, M.issue(s, '1', t.id)[0].id, minRng);
    const actions = food(s, { name: '持续恢复', heal: '0', effects: [{ target: 'attr:mind', op: 'add', value: 2 }] });
    M.consume(p, M.issue(s, '1', actions.id)[0].id, minRng, 'use-turn');
    delete s.upgrade; delete s.checks; delete s.sessions; delete s.lootPublications;
    const old = Object.values(s.catalog).find(t => t.boxes.length && t.kind === '杂物');
    old.description = '现代场景中的' + old.name + '，价值为游戏内估值。';
    return { deadline: p.temporaryEffects[0].expiresAt, oldRef: old.id };
  });
  const restore = createStore(h.deps); await restore.load(C.DEFAULT_GUILD_ID); const saved = restore.snapshot(C.DEFAULT_GUILD_ID);
  assert.equal(saved.upgrade, 3); assert.equal(saved.players['1'].temporaryEffects[0].expiresAt, data.deadline);
  assert.equal(saved.players['1'].temporaryEffects[1].skipTurnId, 'use-turn');
  assert.equal(saved.players['1'].temporaryEffects[1].remaining, 2);
  assert.equal(saved.catalog[data.oldRef].description, C.seedCatalog()[data.oldRef].description);
  const revision = saved.revision; await restore.load(C.DEFAULT_GUILD_ID); assert.equal(restore.snapshot(C.DEFAULT_GUILD_ID).revision, revision);
  assert.ok([...h.fileBodies.values()].every(body => !body.includes('能量棒')));
});

test('minute debuff expiry restores unused movement allowance without refunding already moved distance', () => {
  const { s, b } = fight(), p = s.players['1'], now = Date.now();
  const t = food(s, { heal: '0', effects: [{ target: 'attr:agility', op: 'add', value: -2 }], duration: { kind: 'minutes', count: 1 } });
  M.consume(p, M.issue(s, '1', t.id)[0].id, minRng, null, now);
  b.current.move = 7; b.current.moveSpent = 5;
  A.expireAll(s, now + 60000); assert.equal(b.current.move, 13);
});

test('failed check publication can resend saved attempt without another roll or attempt', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'check', 'GM', s => A.createCheck(s, 'GM', 'channel', { name: '补发测试', rule: 'd100', threshold: 100 }).id);
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'check', ref);
    const send = h.ch.send; h.ch.send = async options => { if (options.nonce?.startsWith('attempt:')) throw Object.assign(new Error('Missing Permission'), { code: 50013 }); return send(options); };
    const i = h.interaction('1', null, {}, 'rpg:activity:check:roll:' + ref); await rpg.handle(i);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks[ref].attempts['1'].length, 1);
    const result = await click(h, rpg, '1', i, '核对后补发结果'); h.ch.send = send;
    const id = rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks[ref].attempts['1'][0].id;
    const repost = await click(h, rpg, '1', result, '已核对频道，补发失败结果', [id]); assert.match(bodyOf(repost.result), /成功/);
    const attempts = rpg.store.snapshot(C.DEFAULT_GUILD_ID).checks[ref].attempts['1'];
    assert.equal(attempts.length, 1); assert.ok(attempts[0].messageId);
  } finally { rpg.stop(); }
});

test('GM dropdown pages all NPC templates and supports terrain, condition save audit, cure and removal', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const data = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'many-npc', 'GM', s => {
      const npcs = [];
      for (let n = 0; n < 26; n++) { const f = F.create(s, 'GM', 'npc'); f.data.name = 'NPC' + n; npcs.push(F.publish(s, f).id); }
      const f = F.create(s, 'GM', 'condition'); f.data.name = '虚弱'; f.data.levels['一般'].difficulty = 99999;
      f.data.levels['一般'].effects = [{ target: 'attr:strength', amount: '1' }]; const condition = F.publish(s, f).id;
      const b = B.createBattle(s, 'channel', 'GM', '管理操作测试'); B.addNPC(s, b, npcs[25], 'enemy');
      return { npc: npcs[25], condition, battle: b.id, actor: b.actors[0].id };
    });
    const gm = h.interaction('GM', '战斗', { sub: '面板' }); await rpg.handle(gm);
    const list = await click(h, rpg, 'GM', gm, 'NPC模板下拉');
    const next = await click(h, rpg, 'GM', list, '下一页');
    assert.ok(jsonComponents(next.result).find(c => c.options)?.options.some(o => o.value === data.npc));
    const overview = await click(h, rpg, 'GM', next, '返回GM概览');
    const terrain = await click(h, rpg, 'GM', overview, '选择管理操作', ['terrain']);
    const type = await click(h, rpg, 'GM', terrain, '地形类型', ['difficult']);
    const modal = await click(h, rpg, 'GM', type, '填写坐标');
    const changed = await submit(h, rpg, 'GM', modal, { x: '2', y: '3' });
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[data.battle].terrain['1,2'], 'difficult');
    const actors = await click(h, rpg, 'GM', changed, '选择管理操作', ['conditions']);
    const conditionView = await click(h, rpg, 'GM', actors, 'GM · 选择角色', [data.actor]);
    const templates = await click(h, rpg, 'GM', conditionView, '施加已录入异常');
    const select = await click(h, rpg, 'GM', templates, '选择异常模板', [data.condition]);
    const applied = await click(h, rpg, 'GM', select, '等级', ['一般']);
    const b = rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[data.battle], z = b.actors[0].character.conditions[0];
    assert.ok(z); assert.ok(b.recent.some(r => r.details?.save));
    const cured = await click(h, rpg, 'GM', applied, '选择要解除的异常', [z.id]);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[data.battle].actors[0].character.conditions.length, 0);
    const back = await click(h, rpg, 'GM', cured, '返回GM概览');
    const remove = await click(h, rpg, 'GM', back, '选择管理操作', ['remove']);
    const preview = await click(h, rpg, 'GM', remove, 'GM · 选择移出角色', [data.actor]);
    await click(h, rpg, 'GM', preview, '确认移出'); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[data.battle].actors.length, 0);
  } finally { rpg.stop(); }
});

test('raw public button creates private child while return/cancel avoids new action and modal writes', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'combat', 'GM', s => { const { b } = fight(s); return b.id; });
    const i = h.interaction('1', null, {}, 'rpg:personal:' + ref);
    i.message = { id: 'public', flags: new D.MessageFlagsBitField() }; await rpg.handle(i);
    assert.equal(i.updatedSource, undefined); assert.equal(i.deferOptions.flags, D.MessageFlags.Ephemeral);
    const tab = await click(h, rpg, '1', i, '操作分页', ['formal']);
    const attack = await click(h, rpg, '1', tab, '攻击／释放技能');
    const selected = await click(h, rpg, '1', attack, '选择武器／技能', ['unarmed']);
    await click(h, rpg, '1', selected, '取消选择');
    const b = rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[ref]; assert.equal(b.current.formal, 1); assert.equal(b.pending, null);
    assert.ok(!jsonComponents(i.result).some(c => c.custom_id === 'rpg:personal:' + ref));
  } finally { rpg.stop(); }
});

test('failed private UI response invalidates the consumed step instead of allowing a second item charge', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'ui-failure-items', 'GM', s => M.issue(s, '1', food(s).id, 2)[0].id);
    const bag = h.interaction('1', '背包'); await rpg.handle(bag);
    const detail = await click(h, rpg, '1', bag, '选择物品查看描述与使用效果', [ref]);
    const id = control(detail.result, '使用一件'), first = h.interaction('1', null, {}, id);
    first.editReply = async () => { throw new Error('private reply unavailable'); };
    await rpg.handle(first); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[ref].quantity, 1);
    const again = h.interaction('1', null, {}, id); await rpg.handle(again);
    assert.match(again.result.content, /失效/); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[ref].quantity, 1);
  } finally { rpg.stop(); }
});

test('GM buyback autocomplete reads raw user ID with actual Discord resolver and excludes unavailable goods', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'sellable', 'GM', s => M.issue(s, '1', food(s).id, 4)[0].id);
    const Resolver = D.CommandInteractionOptionResolver;
    const i = h.interaction('GM', 'gm'); i.isAutocomplete = () => true;
    i.options = new Resolver({}, [{ name: '收购', type: 1, options: [
      { name: '成员', type: 6, value: '1' }, { name: '物品', type: 3, value: '', focused: true }
    ] }]);
    assert.equal(i.options.getUser('成员'), null); i.respond = async value => { i.choices = value; };
    await rpg.handle(i); assert.equal(i.choices[0].value, ref); assert.match(i.choices[0].name, /可售 4/);
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'reserved-for-other', 'GM', s => M.createOffer(s, 'GM', '1', 'buyback', ref, 4, 1));
    await rpg.handle(i); assert.deepEqual(i.choices, []);
    const nonGM = h.interaction('2', 'gm'); nonGM.isAutocomplete = () => true; nonGM.options = i.options;
    nonGM.respond = async value => { nonGM.choices = value; }; await rpg.handle(nonGM); assert.deepEqual(nonGM.choices, []);
  } finally { rpg.stop(); }
});

test('GM without a card selects backpack item, previews quote and seller alone completes exactly once', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'buyback-stock', 'GM', s => M.issue(s, '1', food(s).id, 4)[0].id);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players.GM, undefined);
    const opened = h.interaction('GM', 'gm', { sub: '收购', 成员: '1' }); await rpg.handle(opened);
    assert.equal(opened.deferOptions.flags, D.MessageFlags.Ephemeral);
    const item = await click(h, rpg, 'GM', opened, '选择收购物品', [ref]);
    const edit = await click(h, rpg, 'GM', item, '填写 / 修改报价');
    const preview = await submit(h, rpg, 'GM', edit, { quantity: '2', price: '500' });
    assert.match(bodyOf(preview.result), /总价 \*\*500/);
    const confirmId = control(preview.result, '确认并向玩家报价');
    await click(h, rpg, 'GM', preview, '确认并向玩家报价');
    const saved = rpg.store.snapshot(C.DEFAULT_GUILD_ID), offer = Object.values(saved.offers)[0];
    assert.equal(saved.players['1'].balance, 0); assert.equal(saved.players['1'].inventory[ref].quantity, 4);
    const duplicate = h.interaction('GM', null, {}, confirmId); await rpg.handle(duplicate); assert.match(duplicate.result.content, /失效/);
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers).length, 1);
    const seller = h.interaction('1', null, {}, 'rpg:offer:' + offer.id); await rpg.handle(seller);
    const confirmation = control(seller.result, '确认当前报价'); await click(h, rpg, '1', seller, '确认当前报价');
    const twice = h.interaction('1', null, {}, confirmation); await rpg.handle(twice);
    const completed = rpg.store.snapshot(C.DEFAULT_GUILD_ID); assert.equal(completed.players['1'].balance, 500);
    assert.equal(completed.players['1'].inventory[ref].quantity, 2); assert.equal(completed.offers[offer.id].status, 'completed');
  } finally { rpg.stop(); }
});

test('buyback pages empty and large backpacks, explains equipped and reserved goods and handles cancellation', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const empty = h.interaction('GM', 'gm', { sub: '收购', 成员: '2' }); await rpg.handle(empty); assert.match(bodyOf(empty.result), /背包为空/);
    const refs = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'large-buyback-stock', 'GM', s => {
      const t = food(s), ids = Array.from({ length: 17 }, () => M.issue(s, '1', t.id, 1)[0].id);
      const w = M.issue(s, '1', weapon(s).id)[0]; M.equip(s, '1', w.id);
      M.createOffer(s, 'GM', '1', 'buyback', ids[0], 1, 0); return ids;
    });
    const opened = h.interaction('GM', 'gm', { sub: '收购', 成员: '1' }); await rpg.handle(opened);
    assert.match(bodyOf(opened.result), /预留/);
    const page = await click(h, rpg, 'GM', opened, '下一页'); assert.match(bodyOf(page.result), /装备/);
    const selected = await click(h, rpg, 'GM', page, '选择收购物品', [refs[16]]);
    await click(h, rpg, 'GM', selected, '取消收购');
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers).length, 1);
    assert.equal(BB.availability(rpg.store.snapshot(C.DEFAULT_GUILD_ID), '1', rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[refs[0]]).quantity, 0);
  } finally { rpg.stop(); }
});

test('buyback rechecks quantities after preview and rejects a stale modal or another operator', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'stock-race', 'GM', s => M.issue(s, '1', food(s).id, 3)[0].id);
    const opened = h.interaction('GM', 'gm', { sub: '收购', 成员: '1' }); await rpg.handle(opened);
    const picked = await click(h, rpg, 'GM', opened, '选择收购物品', [ref]);
    const edit = await click(h, rpg, 'GM', picked, '填写 / 修改报价');
    const preview = await submit(h, rpg, 'GM', edit, { quantity: '3', price: '900' });
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'consume-between', '1', s => { s.players['1'].inventory[ref].quantity = 2; });
    const rejected = await click(h, rpg, 'GM', preview, '确认并向玩家报价'); assert.match(rejected.result.content, /数量不足/);
    assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers).length, 0);
    const oldModal = await submit(h, rpg, 'GM', edit, { quantity: '1', price: '10' }); assert.match(oldModal.result.content, /失效/);
    const outsider = h.interaction('2', 'gm', { sub: '收购', 成员: '1' }); await rpg.handle(outsider); assert.match(outsider.result.content, /GM/);
  } finally { rpg.stop(); }
});

test('quick buyback retains explicit parameters and rejects missing price before creating an offer', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'quick-stock', 'GM', s => M.issue(s, '1', food(s).id, 2)[0].id);
    const missing = h.interaction('GM', 'gm', { sub: '收购', 成员: '1', 物品: ref }); await rpg.handle(missing);
    assert.match(missing.result.content, /价格/); assert.equal(Object.keys(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers).length, 0);
    const quick = h.interaction('GM', 'gm', { sub: '收购', 成员: '1', 物品: ref, 数量: 2, 价格: 0 }); await rpg.handle(quick);
    assert.equal(Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers)[0].price, 0);
  } finally { rpg.stop(); }
});

test('container draws 1 to 6 independently weighted items, allows duplicates and card draw remains one', () => {
  const s = state(), p = s.players['1']; p.attributes.strength = 100; p.attributes.constitution = 100;
  p.tickets.boxes['饭盒'] = 3;
  const one = M.openLoot(s, '1', '饭盒', minRng); assert.equal(one.items.length, 1);
  let first = true;
  const six = M.openLoot(s, '1', '饭盒', (min, max) => { if (first) { first = false; return 6; } return min; });
  assert.equal(six.items.length, 6); assert.equal(new Set(six.items.map(i => i.id)).size, 6);
  assert.equal(new Set(six.items.map(i => i.templateId)).size, 1); assert.equal(p.tickets.boxes['饭盒'], 1);
  let n = 0; const weights = [0, 5, 15, 100, 300, 550];
  const mixed = M.openLoot(s, '1', '饭盒', (min, max) => {
    if (min === 1 && max === 7) return 6;
    if (min === 0 && max === 1000) return weights[n++]; return min;
  });
  assert.deepEqual(mixed.items.map(i => i.snapshot.rarity), ['red', 'gold', 'purple', 'blue', 'green', 'white']);
  p.tickets.card = 1; const card = M.openLoot(s, '1', 'card', minRng); assert.equal(card.items.length, 1); assert.equal(p.tickets.card, 0);
});

test('whole container pending batch survives encrypted restart, retains all values and debits once on claim', async () => {
  const h = harness(), store = createStore(h.deps); await store.load(C.DEFAULT_GUILD_ID);
  const first = await store.transact(C.DEFAULT_GUILD_ID, 'six-pending', '1', s => {
    Object.assign(s.players, state().players); const p = s.players['1'];
    p.tickets.boxes['饭盒'] = 1; p.inventory.heavy = { id: 'heavy', quantity: 1, snapshot: { weight: 99999 } };
    let start = true; return M.openLoot(s, '1', '饭盒', (min, max) => { if (start) { start = false; return 6; } return min; });
  });
  assert.ok(first.pending); assert.equal(first.items.length, 6);
  const restore = createStore(h.deps); await restore.load(C.DEFAULT_GUILD_ID);
  const again = await restore.transact(C.DEFAULT_GUILD_ID, 'retry-six', '1', s => M.openLoot(s, '1', '饭盒', () => { throw new Error('reroll'); }));
  assert.deepEqual(again, first); assert.equal(restore.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.boxes['饭盒'], 1);
  const result = await restore.transact(C.DEFAULT_GUILD_ID, 'claim-six', '1', s => {
    delete s.players['1'].inventory.heavy; return M.openLoot(s, '1', '饭盒', () => { throw new Error('reroll'); });
  });
  assert.equal(result.pending, false); assert.deepEqual(result.items, first.items);
  assert.equal(Object.keys(restore.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory).length, 6);
  assert.equal(restore.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.boxes['饭盒'], 0);
});

test('upgrade 3 migrates legacy pending item without changing history, templates, assets or faction', () => {
  const s = state(); s.upgrade = 2; const p = s.players['1']; delete p.faction;
  const item = M.makeItem(Object.values(s.catalog).find(t => t.boxes.includes('大衣')));
  p.pendingLoot['大衣'] = item; p.tickets.boxes['大衣'] = 1;
  s.lootPublications.old = { id: 'old', result: { item: C.clone(item), pending: true }, messageId: '123' };
  s.events.push({ id: 'historic', result: C.clone(item) });
  const history = JSON.stringify(s.events), publicRecord = JSON.stringify(s.lootPublications.old), templates = JSON.stringify(s.catalog);
  const report = A.migrate(s); assert.equal(report.pendingBatches, 1); assert.equal(p.faction, null);
  assert.deepEqual(p.pendingLoot['大衣'].items, [item]); assert.equal(A.migrate(s), null);
  assert.equal(JSON.stringify(s.events), history); assert.equal(JSON.stringify(s.lootPublications.old), publicRecord);
  assert.equal(JSON.stringify(s.catalog), templates);
  const claimed = M.openLoot(s, '1', '大衣', () => { throw new Error('reroll'); }); assert.equal(claimed.items[0].id, item.id);
});

test('batch public messages fit Discord limits, contain every description and never reveal balance or tickets', () => {
  const s = state(), p = s.players['1']; p.attributes.strength = 100; p.attributes.constitution = 100; p.tickets.boxes['饭盒'] = 1;
  let first = true; const result = M.openLoot(s, '1', '饭盒', min => { if (first) { first = false; return 6; } return min; });
  for (const item of result.items) item.snapshot.description = '说明'.repeat(1000);
  const record = { id: 'public', userId: '1356391807285727337', result };
  const messages = AU.lootMessages(record); assert.ok(messages.length > 1); messages.forEach(validateMessage);
  const text = messages.map(m => JSON.stringify(m.embeds.map(e => e.toJSON()))).join('');
  result.items.forEach(item => assert.ok(text.includes(item.id)));
  assert.equal(messages.flatMap(m => m.embeds).filter(e => e.toJSON().description === '说明'.repeat(1000)).length, 6);
  assert.ok(!text.includes('余额')); assert.ok(!text.includes('剩余次数'));
});

test('partial batch publication resends only missing parts, preserves IDs and does not debit again', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const record = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'publish-six-setup', '1', s => {
      const p = s.players['1']; p.attributes.strength = 100; p.attributes.constitution = 100; p.tickets.boxes['饭盒'] = 1;
      let first = true; const result = M.openLoot(s, '1', '饭盒', min => { if (first) { first = false; return 6; } return min; });
      result.items.forEach(i => { i.snapshot.description = '物品描述'.repeat(500); });
      const r = { id: 'ltest', userId: '1', channelId: 'channel', at: Date.now(), result, publication: { status: 'pending' } };
      s.lootPublications[r.id] = r; return r;
    });
    const original = h.ch.send; let publicSends = 0;
    h.ch.send = async opts => { if (opts.embeds && ++publicSends === 2) throw Object.assign(new Error('cannot send'), { code: 50013 }); return original(opts); };
    await assert.rejects(rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', record.id));
    const failed = rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications[record.id];
    assert.equal(failed.publicationParts[0].status, 'sent'); assert.equal(failed.publicationParts[1].status, 'failed');
    const firstMessageId = failed.messageId; h.ch.send = original;
    const before = h.sent.filter(m => m.lastPayload.embeds).length;
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', record.id, true);
    const saved = rpg.store.snapshot(C.DEFAULT_GUILD_ID), r = saved.lootPublications[record.id];
    assert.equal(r.messageId, firstMessageId); assert.ok(r.publicationParts.every(p => p.status === 'sent'));
    assert.equal(h.sent.filter(m => m.lastPayload.embeds).length - before, r.publicationParts.length - 1);
    assert.equal(saved.players['1'].tickets.boxes['饭盒'], 0); assert.deepEqual(r.result.items, record.result.items);
    const done = h.sent.length; await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', record.id, true); assert.equal(h.sent.length, done);
  } finally { rpg.stop(); }
});

test('missing drop pool fails without partial inventory or charged ticket', () => {
  const s = state(), p = s.players['1']; p.tickets.boxes['饭盒'] = 1;
  for (const t of Object.values(s.catalog)) if (t.rarity === 'gold') t.boxes = [];
  let n = 0;
  assert.throws(() => M.openLoot(s, '1', '饭盒', (min, max) => {
    if (min === 1 && max === 7) return 2;
    if (min === 0 && max === 1000) return n++ === 0 ? 550 : 5; return min;
  }), /掉落池/);
  assert.equal(Object.keys(p.inventory).length, 0); assert.equal(p.tickets.boxes['饭盒'], 1); assert.equal(p.pendingLoot['饭盒'], undefined);
});

test('faction lore is available without a card; all factions and departments can be freely chosen and shown publicly', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const guest = h.interaction('stranger', '势力'); await rpg.handle(guest); assert.match(bodyOf(guest.result), /确认角色卡/);
    const world = await click(h, rpg, 'stranger', guest, '世界背景'); assert.match(bodyOf(world.result), /2055/);
    const returned = await click(h, rpg, 'stranger', world, '返回势力面板');
    const lore = await click(h, rpg, 'stranger', returned, '阅读势力介绍', ['apocalypse']); assert.match(bodyOf(lore.result), /死亡部｜内政/);
    const before = rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'];
    for (const [faction, department] of [['explorer', null], ['scavenger', null], ...Object.keys(FA.DEPARTMENTS).map(d => ['apocalypse', d])]) {
      const panel = h.interaction('1', '势力'); await rpg.handle(panel);
      const select = await click(h, rpg, '1', panel, '选择 / 修改势力');
      let chosen = await click(h, rpg, '1', select, '选择角色所属势力', [faction]);
      if (department) chosen = await click(h, rpg, '1', chosen, '选择一个部门', [department]);
      await click(h, rpg, '1', chosen, '确认归属');
      const p = rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1']; assert.equal(p.faction.id, faction); assert.equal(p.faction.department, department);
      assert.match(bodyOf(U.characterView(p)), new RegExp(FA.FACTIONS[faction].name));
      if (department) assert.match(bodyOf(U.characterView(p)), new RegExp(FA.DEPARTMENTS[department].name));
      assert.deepEqual(p.attributes, before.attributes); assert.equal(p.balance, before.balance); assert.equal(p.hp, before.hp);
    }
    const restored = createStore(h.deps); await restored.load(C.DEFAULT_GUILD_ID);
    assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).players['1'].faction.department, 'famine');
  } finally { rpg.stop(); }
});

test('faction preview cancellation writes nothing, rejects another owner and stale recreated character', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const panel = h.interaction('1', '势力'); await rpg.handle(panel);
    const selecting = await click(h, rpg, '1', panel, '选择 / 修改势力');
    const chosen = await click(h, rpg, '1', selecting, '选择角色所属势力', ['explorer']);
    const old = control(chosen.result, '确认归属');
    const stranger = h.interaction('2', null, {}, old); await rpg.handle(stranger); assert.match(stranger.result.content, /失效/);
    await click(h, rpg, '1', chosen, '取消'); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].faction, null);
    const stale = h.interaction('1', null, {}, old); await rpg.handle(stale); assert.match(stale.result.content, /失效/);
    const s = rpg.store.snapshot(C.DEFAULT_GUILD_ID); assert.throws(() => FA.choose(s, '1', 'old-character', 'explorer'), /角色卡已变化/);
    assert.throws(() => FA.choose(s, '1', s.players['1'].id, 'apocalypse', 'missing'), /无效/);
  } finally { rpg.stop(); }
});

test('failed buyback announcement can publish the same saved offer without creating or charging another', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'notification-stock', 'GM', s => M.issue(s, '1', food(s).id)[0].id);
    const opened = h.interaction('GM', 'gm', { sub: '收购', 成员: '1' }); await rpg.handle(opened);
    const item = await click(h, rpg, 'GM', opened, '选择收购物品', [ref]);
    const edit = await click(h, rpg, 'GM', item, '填写 / 修改报价');
    const preview = await submit(h, rpg, 'GM', edit, { quantity: '1', price: '50' });
    const send = h.ch.send; h.ch.send = async options => {
      if (options.content?.includes('待确认的')) throw Object.assign(new Error('send denied'), { code: 50013 }); return send(options);
    };
    const saved = await click(h, rpg, 'GM', preview, '确认并向玩家报价'); assert.match(saved.result.content, /报价已保存/);
    h.ch.send = send; await click(h, rpg, 'GM', saved, '核对后补发报价通知');
    const s = rpg.store.snapshot(C.DEFAULT_GUILD_ID); assert.equal(Object.keys(s.offers).length, 1);
    assert.equal(s.players['1'].balance, 0); assert.equal(s.players['1'].inventory[ref].quantity, 1);
    assert.equal(h.sent.filter(m => m.content?.includes('待确认的GM收购报价')).length, 1);
  } finally { rpg.stop(); }
});

test('claim during batch publication refreshes all original public messages to the saved claimed state', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'pending-concurrent', '1', s => {
      const p = s.players['1']; p.tickets.boxes['饭盒'] = 1; p.inventory.heavy = { id: 'heavy', quantity: 1, snapshot: { weight: 999999 } };
      let first = true; const result = M.openLoot(s, '1', '饭盒', min => { if (first) { first = false; return 6; } return min; });
      s.lootPublications.race = { id: 'race', userId: '1', channelId: 'channel', result, at: Date.now(), publication: { status: 'pending' } };
    });
    const send = h.ch.send; let changed = false;
    h.ch.send = async options => {
      if (options.embeds && !changed) {
        changed = true;
        await rpg.store.transact(C.DEFAULT_GUILD_ID, 'claim-concurrent', '1', s => {
          delete s.players['1'].inventory.heavy; s.lootPublications.race.result = M.openLoot(s, '1', '饭盒', () => { throw new Error('reroll'); });
        });
      }
      return send(options);
    };
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'race');
    h.ch.send = send;
    const s = rpg.store.snapshot(C.DEFAULT_GUILD_ID), ids = s.lootPublications.race.publicationParts.map(p => p.messageId), before = h.sent.length;
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'race');
    const saved = rpg.store.snapshot(C.DEFAULT_GUILD_ID); assert.equal(h.sent.length, before);
    assert.deepEqual(saved.lootPublications.race.publicationParts.map(p => p.messageId), ids);
    assert.ok(saved.lootPublications.race.publicationParts.every(p => p.pending === false));
    ids.forEach(id => assert.match(JSON.stringify(h.messages.get(id).lastPayload.embeds.map(e => e.toJSON())), /已入包/));
    assert.equal(saved.players['1'].tickets.boxes['饭盒'], 0); assert.equal(Object.keys(saved.players['1'].inventory).length, 6);
  } finally { rpg.stop(); }
});

test('deleted or uncertain batch segments require explicit resend and do not reannounce completed segments', async () => {
  const h = harness(), rpg = createRpg(h.deps); await setupUpgrade(h, rpg);
  try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID, 'uncertain-batch', '1', s => {
      const p = s.players['1']; p.attributes.strength = 100; p.attributes.constitution = 100; p.tickets.boxes['饭盒'] = 1;
      let first = true; const result = M.openLoot(s, '1', '饭盒', min => { if (first) { first = false; return 6; } return min; });
      s.lootPublications.uncertain = { id: 'uncertain', userId: '1', channelId: 'channel', result, at: Date.now() };
    });
    const send = h.ch.send; h.ch.send = async options => { if (options.embeds) throw new Error('timeout'); return send(options); };
    await assert.rejects(rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'uncertain'));
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications.uncertain.publicationParts[0].status, 'uncertain');
    h.ch.send = send;
    const restored = createStore(h.deps); await restored.load(C.DEFAULT_GUILD_ID);
    assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).lootPublications.uncertain.publicationParts[0].status, 'uncertain');
    await assert.rejects(rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'uncertain'), /待核对/);
    await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'uncertain', true);
    const r = rpg.store.snapshot(C.DEFAULT_GUILD_ID).lootPublications.uncertain;
    const deleted = r.publicationParts[1].messageId; h.messages.delete(deleted);
    await assert.rejects(rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'uncertain'), /删除/);
    const before = h.sent.length; await rpg.activities.publish(C.DEFAULT_GUILD_ID, 'loot', 'uncertain', true);
    assert.equal(h.sent.length, before + 1); assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].tickets.boxes['饭盒'], 0);
  } finally { rpg.stop(); }
});
