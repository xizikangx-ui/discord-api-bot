'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs');
const D = require('discord.js');
const C = require('../src/rpg/constants'), M = require('../src/rpg/model'), B = require('../src/rpg/combat');
const F = require('../src/rpg/forms'), U = require('../src/rpg/ui');
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
      deferReply: async () => { data.deferred = true; },
      editReply: async value => { data.result = value; }, reply: async value => { data.replied = true; data.result = value; },
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
    const json = r.toJSON(); assert.ok(json.components.length <= 5);
    for (const c of json.components) {
      if (c.custom_id) assert.ok(c.custom_id.length <= 100, c.custom_id);
      if (c.options) assert.ok(c.options.length > 0 && c.options.length <= 25);
    }
  }
  let length = 0;
  for (const embed of value.embeds || []) {
    const json = embed.toJSON(); assert.ok((json.description || '').length <= 4096);
    length += (json.title || '').length + (json.description || '').length;
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
