'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs');
const D = require('discord.js');
const C = require('../src/rpg/constants'), M = require('../src/rpg/model'), B = require('../src/rpg/combat');
const F = require('../src/rpg/forms'), U = require('../src/rpg/ui');
const A = require('../src/rpg/activities'), AU = require('../src/rpg/activities-ui');
const FA = require('../src/rpg/factions'), BB = require('../src/rpg/buyback');
const X = require('../src/rpg/exploration'), XU = require('../src/rpg/exploration-ui');
const L = require('../src/rpg/loot'), DT = require('../src/rpg/mortality');
const R = require('../src/rpg/room-settings');
const { commands } = require('../src/rpg/commands'), { createStore } = require('../src/rpg/store'), { createRpg } = require('../src/rpg');
const AM=require('../src/rpg/ammunition'),AI=require('../src/rpg/npc-auto'),Team=require('../src/rpg/team-movement');
const minRng = min => min;
function training(s,uid){if(!s.players[uid].equipped.weapon){const t=weapon(s,{weightKg:0,damage:{physical:'1'}});const item=M.issue(s,uid,t.id)[0];M.equip(s,uid,item.id);}return s.players[uid].equipped.weapon;}
function reloadViaMagazine(s,b,turn,ammo,magazine){const a=B.actorById(b,b.current.actorId),weaponId=B.actorCharacter(s,a).equipped.weapon;const again=()=>{B.finish(s,b,b.current.id,minRng);while(b.current.actorId!==a.id)B.finish(s,b,b.current.id,minRng);};AM.battleOperation(s,b,turn,{type:'extract',weapon:weaponId});again();AM.battleOperation(s,b,b.current.id,{type:'fill',magazine,ammo});again();AM.battleOperation(s,b,b.current.id,{type:'swap',weapon:weaponId,magazine});}
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
  training(s,'1');training(s,'2');const b = B.createBattle(s, 'channel', 'GM', '测试战斗'); B.join(s, b, '1'); B.join(s, b, '2');
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
        getAttachment: k => options[k] ?? null, getUser: k => options[k] ? { id: options[k] } : null, getSubcommand: () => options.sub },
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
  assert.throws(()=>M.confirmCharacter(s,'1'),/性别|男性/); s.characterDrafts['1'].gender='male';
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
    const rarity = C.RARITIES.find(r => r.id === reward.snapshot.rarity); assert.ok(reward.snapshot.value >= rarity.min && reward.snapshot.value <= rarity.max);
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
  const before = M.weight(p); reloadViaMagazine(s, b, b.current.id, ammunition.id, item.magazineId);
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
    Object.assign(st, state());training(st,'1');training(st,'2');const b = B.createBattle(st, 'channel', 'GM', 'fight');
    B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng);
    B.attack(st, b, b.current.id, B.actorCharacter(st, B.actorById(b,b.current.actorId)).equipped.weapon, b.actors[1].id, 'formal', minRng); return b.id;
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
  const weight = M.weight(s.players['1']); reloadViaMagazine(s, b, b.current.id, ammo.id, w.magazineId);
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
  const oldName = s.players['1'].name; M.deleteCharacter(s, '1'); M.rollCharacter(s, '1', '新角色', false, minRng); s.characterDrafts['1'].gender='male'; M.confirmCharacter(s, '1');
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
  const { s, b } = fight(); const hit = B.attack(s, b, b.current.id, B.actorCharacter(s, B.actorById(b,b.current.actorId)).equipped.weapon, b.actors[1].id, 'formal', minRng);
  hit.hit = 11; const result = B.defend(s, b, hit.id, 'dodge', () => 7);
  assert.equal(result.dodge.total, 11); assert.ok(!result.dodge.success);
  B.finish(s, b, b.current.id, minRng);
  const current = b.current, target = b.actors.find(a => a.id !== current.actorId);
  const expired = B.attack(s, b, current.id, B.actorCharacter(s, B.actorById(b,b.current.actorId)).equipped.weapon, target.id, 'formal', minRng); expired.expiresAt = Date.now() - 1;
  const automatic = B.defend(s, b, expired.id, 'dodge', () => { throw new Error('must not dodge'); });
  assert.ok(automatic.defaulted); assert.equal(automatic.dodge, null);
  s.players['1'].conditions.push({ modifiers: [{ target: 'resist:mental', op: 'add', value: -3 }] });
  assert.equal(M.stats(s.players['1']).resist.mental, -3);
});
test('a full battle button flow supports move modal, attack selection, private defense and stale click', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const ref = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', st => {
      st.config.gmRoleIds = ['gm']; st.config.playerRoleIds = ['player']; Object.assign(st.players, state().players);training(st,'1');training(st,'2');
      const b = B.createBattle(st, 'channel', 'GM', 'test'); B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng); return b.id;
    });
    let s = rpg.store.snapshot(C.DEFAULT_GUILD_ID), b = s.battles[ref], a = b.actors[0], prefix = [b.id, a.id, '1', b.current.id].join(':');
    const openMove = h.interaction('1', null, {}, 'rpg:move:' + prefix); await rpg.handle(openMove); assert.ok(openMove.modal); openMove.modal.toJSON();
    const move = h.interaction('1', null, {}, 'rpg:movevalue:' + prefix, [], { x: '26', y: '25' }); await rpg.handle(move); validateMessage(move.result);
    const choices = h.interaction('1', null, {}, 'rpg:attackpick:' + prefix + ':formal:0'); await rpg.handle(choices); validateMessage(choices.result);
    const selectAttack = h.interaction('1', null, {}, 'rpg:attackpick:' + prefix + ':formal:select', [rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].equipped.weapon]); await rpg.handle(selectAttack); validateMessage(selectAttack.result);
    const target = h.interaction('1', null, {}, 'rpg:target:' + prefix + ':formal:'+s.players['1'].equipped.weapon, [b.actors[1].id]); await rpg.handle(target); validateMessage(target.result);
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
      Object.assign(st.players, state().players);training(st,'1');training(st,'2');
      const b = B.createBattle(st, 'channel', 'GM', 'test'); B.join(st, b, '1'); B.join(st, b, '2'); B.start(st, b, null, minRng);
      B.attack(st, b, b.current.id, B.actorCharacter(st, B.actorById(b,b.current.actorId)).equipped.weapon, b.actors[1].id, 'formal', minRng); b.pending.expiresAt = Date.now() - 1; return b.id;
    });
  } finally { first.stop(); }
  const second = createRpg(h.deps); await second.start();
  try { const s = second.store.snapshot(C.DEFAULT_GUILD_ID); assert.equal(s.battles[ref].pending, null); assert.equal(s.players['2'].hp, 9); }
  finally { second.stop(); }
  const third = createRpg(h.deps); await third.start();
  try { assert.equal(third.store.snapshot(C.DEFAULT_GUILD_ID).players['2'].hp, 9); } finally { third.stop(); }
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
    const gender=h.interaction('1',null,{},'rpg:profile:draftgender:1:'+current.id,['male']);await rpg.handle(gender);
    const confirm = h.interaction('1', null, {}, 'rpg:char:confirm:' + current.id); await rpg.handle(confirm); validateMessage(confirm.result);
  } finally { rpg.stop(); }
});
test('NPC controls and private state reject other players, GM uses quick switch and free defense', async () => {
  const h = harness(), rpg = createRpg(h.deps); await rpg.start();
  try {
    const ids = await rpg.store.transact(C.DEFAULT_GUILD_ID, 'setup', 'GM', st => {
      st.config.gmRoleIds = ['gm']; Object.assign(st.players, state().players);training(st,'1');
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
      return B.attack(st, b, b.current.id, B.actorCharacter(st, B.actorById(b,b.current.actorId)).equipped.weapon, ids.a, 'formal', minRng);
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
  const all = commands().map(c => c.toJSON()); assert.equal(all.length, 30); assert.equal(new Set(all.map(c => c.name)).size, all.length);
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
  assert.equal(saved.upgrade, 5); assert.equal(saved.players['1'].temporaryEffects[0].expiresAt, data.deadline);
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
    const selected = await click(h, rpg, '1', attack, '选择武器／技能', [rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].equipped.weapon]);
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
  let n = 0; const weights = [9950, 9850, 9000, 7000, 4500, 0];
  const mixed = M.openLoot(s, '1', '饭盒', (min, max) => {
    if (min === 1 && max === 7) return 6;
    if (min === 0 && max === 10000) return weights[n++]; return min;
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
    if (min === 0 && max === 10000) return n++ === 0 ? 0 : 9850; return min;
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
function mapFixture(s = state(), roomExtra = {}, mode = 'random') {
  const category = F.create(s, 'GM', 'mapcategory'); category.data.name = '研究所'; const cat = F.publish(s, category);
  const form = F.create(s, 'GM', 'room'); Object.assign(form.data, { name: '实验室', description: '密闭实验室，遗留研究设备。', categoryIds: [cat.id], boxes: ['大衣'], ...roomExtra });
  const room = F.publish(s, form), m = X.create(s, 'GM', 'channel', '研究所探索', 2, 5, mode, cat.id);
  if (mode === 'fixed') for (const c of Object.values(m.cells)) if (c.type === 'room') c.templateId = room.id;
  X.generate(s, m, minRng); X.publish(s, m); return { s, m, room, cat };
}
function npcTemplate(s, extra = {}) {
  const t = B.validateNPC(s, { ...F.defaults('npc'), name: '守卫', humanoid: true, baseXP: 1000, hpMax: 1, ...extra });
  t.id = C.id('t'); t.version = 1; t.published = true; s.npcTemplates[t.id] = t; return t;
}
test('safe probabilities use exact two-decimal weights, all boundaries, presets and independent configuration', () => {
  const s = state();
  for (const box of Object.keys(L.DEFAULT_SAFE_RATES)) {
    const rates = L.rates(s, box); assert.equal(rates.reduce((a,b)=>a+b),100); let at=0;
    for(let n=0;n<6;n++) { const size=Math.round(rates[n]*100); assert.equal(L.rarity(s,box,()=>at).id,L.COLORS[n]); assert.equal(L.rarity(s,box,()=>at+size-1).id,L.COLORS[n]); at+=size; }
  }
  assert.throws(()=>L.setRates(s,'保险箱',[0,0,0,0,0,99]),/100/);
  assert.throws(()=>L.setRates(s,'保险箱',[1.001,0,0,0,0,98.999]),/两位/);
  L.setRates(s,'保险箱',[0,0,0,0,0,100]); assert.equal(L.generate(s,'保险箱',minRng).items[0].snapshot.rarity,'red');
  assert.deepEqual(L.rates(s,'小型保险'),L.DEFAULT_SAFE_RATES.小型保险);
});
test('map categories and persistent room forms require published references and preserve content snapshots', () => {
  const s=state(), bad=F.create(s,'GM','room');bad.data.name='无大类';assert.throws(()=>F.publish(s,bad),/大类/);
  const {m,room}=mapFixture(s);assert.equal(Object.values(m.cells).filter(c=>c.room).length,4);
  assert.equal(m.cells['2,0'].room.snapshot.description,room.description);room.description='新描述';assert.notEqual(m.cells['2,0'].room.snapshot.description,room.description);
  for(const kind of ['mapcategory','room']) {const f=F.create(s,'GM',kind);validateMessage(F.view(s,f));for(let n=0;n<F.fields(f).length;n++){f.field=n;if(['refs','multi'].includes(F.fields(f)[n].type))validateMessage(F.choiceView(s,f));}}
});
test('map edit validates connectivity, entrance and stairs, fixed room selection and only prepublish rerolls', () => {
  const {s,m,cat}=mapFixture();assert.throws(()=>X.generate(s,m),/发布/);
  m.status='paused';X.editCell(s,m,1,2,'wall');assert.throws(()=>X.validateMap(m),/不可达/);
  X.editCell(s,m,1,2,'stairs');assert.equal(X.validateMap(m),'0,0');
  X.editCell(s,m,6,1,'room',cat.id);assert.equal(m.width,6);assert.ok(m.cells['5,0'].room);
  const draft=X.create(s,'GM','other','固定',1,3,'fixed',cat.id);assert.throws(()=>X.generate(s,draft),/固定地图/);
  X.editCell(s,draft,3,1,'entrance');assert.throws(()=>X.validateMap(draft),/一个入口/);
});
test('paused layouts may replace unexplored rooms but never cells with prior visits or claimed supplies', () => {
  const {s,m,cat}=mapFixture();m.status='paused';X.editCell(s,m,3,1,'corridor');assert.equal(m.cells['2,0'].type,'corridor');
  X.editCell(s,m,3,1,'room',cat.id);assert.ok(m.cells['2,0'].room);m.status='active';X.join(s,m,'1');X.move(s,m,'1','1,0');X.move(s,m,'1','2,0');X.move(s,m,'1','1,0');
  m.status='paused';assert.throws(()=>X.editCell(s,m,3,1,'empty'),/交互/);
});
test('exploration enforces original character, one map, shared fog, movement links and battle isolation', () => {
  const {s,m,cat}=mapFixture();X.join(s,m,'1');X.join(s,m,'1');assert.equal(Object.keys(m.participants).length,1);
  assert.ok(!XU.grid(m).includes('实验室'));assert.equal(m.revealed['2,0'],undefined);
  X.move(s,m,'1','1,0');X.move(s,m,'1','2,0');assert.ok(m.revealed['2,0']);assert.equal(m.participants['1'].cell,'2,0');
  assert.throws(()=>X.move(s,m,'1','4,1'),/相邻/);m.status='paused';assert.throws(()=>X.editCell(s,m,3,1,'wall'),/交互/);m.status='active';
  const other=X.create(s,'GM','second','别处',1,3,'random',cat.id);X.generate(s,other,minRng);X.publish(s,other);assert.throws(()=>X.join(s,other,'1'),/另一张/);
  const b=B.createBattle(s,'fight','GM','战斗');B.join(s,b,'1');assert.throws(()=>X.move(s,m,'1','1,0'),/参战/);
  B.endBattle(s,b);s.players['1'].id='replacement';assert.throws(()=>X.participant(s,m,'1'),/当前角色/);
});
test('key instances hold independent charges, forbid reserved keys and spend exactly once on a shared door', () => {
  const s=state(), key=M.publishTemplate(s,{...F.defaults('item','钥匙'),name:'研究钥匙',keyCharges:2});
  const {m}=mapFixture(s,{keyIds:[key.id]});const keys=M.issue(s,'1',key.id,2);assert.equal(keys.length,2);assert.equal(keys[0].quantity,1);
  X.join(s,m,'1');X.join(s,m,'2');X.move(s,m,'1','1,0');assert.throws(()=>X.move(s,m,'1','2,0'),/钥匙/);
  const offer=M.createOffer(s,'1','2','trade');M.updateOffer(s,offer.id,'1',[{id:keys[0].id,quantity:1}],0);assert.throws(()=>X.move(s,m,'1','2,0',keys[0].id),/钥匙/);
  M.cancelOffer(s,offer.id,'1');X.move(s,m,'1','2,0',keys[0].id);assert.equal(keys[0].keyCharges,1);assert.equal(keys[1].keyCharges,2);
  X.move(s,m,'1','1,0');X.move(s,m,'1','2,0',keys[0].id);assert.equal(keys[0].keyCharges,1);
  X.move(s,m,'2','1,0');X.move(s,m,'2','2,0');assert.ok(m.cells['2,0'].room.unlocked);
});
test('map containers are free, shared, batch-bound and transfer original overweight result without reroll', () => {
  const {s,m}=mapFixture();X.join(s,m,'1');X.join(s,m,'2');for(const u of ['1','2']){X.move(s,m,u,'1,0');X.move(s,m,u,'2,0');}
  const p=s.players['1'];p.attributes.strength=0;p.attributes.constitution=0;
  const c=m.cells['2,0'].room.containers[0], first=X.open(s,m,'1',c.id,minRng);assert.ok(first.result.pending);assert.equal(p.tickets.boxes.大衣,undefined);
  const retry=X.open(s,m,'1',c.id,()=>{throw Error('reroll')});assert.deepEqual(retry.result.items,first.result.items);
  assert.throws(()=>X.open(s,m,'2',c.id),/绑定/);m.status='paused';X.transfer(s,m,'2,0',c.id,'2');m.status='active';
  const claim=X.open(s,m,'2',c.id,()=>{throw Error('reroll')});assert.equal(claim.result.pending,false);assert.equal(claim.result.batchId,first.result.batchId);
  assert.equal(s.players['2'].tickets.boxes.大衣,undefined);assert.throws(()=>X.open(s,m,'1',c.id),/领取/);
});
test('room supplies are single copies, monster encounters require GM resolution and use frozen NPC loadouts', () => {
  const s=state(), npc=npcTemplate(s), item=Object.keys(s.catalog)[0];const {m}=mapFixture(s,{npcIds:[npc.id],supplyIds:[item]});
  X.join(s,m,'1');X.move(s,m,'1','1,0');assert.equal(X.move(s,m,'1','2,0'),true);
  assert.throws(()=>X.currentRoom(s,m,'1'),/遭遇/);assert.throws(()=>X.move(s,m,'1','1,0'),/遭遇/);
  npc.name='模板更新';const b=X.encounter(s,m,'2,0',['1']);assert.equal(b.actors[1].name,'守卫');
  assert.throws(()=>X.resolve(s,m,'2,0'),/结束/);B.endBattle(s,b);X.resolve(s,m,'2,0');
  const ref=m.cells['2,0'].room.supplies[0].id;X.take(s,m,'1',ref);assert.throws(()=>X.take(s,m,'1',ref),/领取/);
});
test('NPC lethal attack grants adaptation experience once and humanoid inventory becomes shared physical loot', () => {
  const s=state();s.players['1'].adaptation=5;const w=weapon(s), t=npcTemplate(s,{itemIds:[w.id],baseXP:1000});
  const b=B.createBattle(s,'c','GM','死亡');const player=B.join(s,b,'1'), n=B.addNPC(s,b,t.id,'enemy');B.position(b,n.id,25,25);B.start(s,b,null,minRng);
  const held=M.issue(s,'1',w.id)[0];M.equip(s,'1',held.id);const h=B.attack(s,b,b.current.id,held.id,n.id,'formal',minRng);B.defend(s,b,h.id,'none',minRng);
  assert.ok(n.deathId);const d=s.deaths[n.deathId];assert.equal(d.rewarded.characterId,s.players['1'].id);assert.equal(d.rewarded.result.credited,1200);assert.equal(s.players['1'].level,2);
  assert.throws(()=>DT.reward(s,b,d,'1'),/重复/);const corpse=s.corpses[d.corpseId];assert.equal(corpse.items.length,1);assert.equal(corpse.items[0].snapshot.name,w.name);
  assert.throws(()=>DT.claim(s,corpse.id,'1',corpse.items[0].id),/结束/);B.endBattle(s,b);const item=DT.claim(s,corpse.id,'1',corpse.items[0].id);assert.ok(s.players['1'].inventory[item.id]);assert.throws(()=>DT.claim(s,corpse.id,'1',item.id),/领取/);
});
test('NPC DOT death credits source, unknown or friendly death requires correct nonautomatic reward handling', () => {
  const s=state(), t=npcTemplate(s,{humanoid:false,baseXP:5});const b=B.createBattle(s,'c','GM','异常');const a=B.join(s,b,'1'),n=B.addNPC(s,b,t.id,'enemy');
  const condition=B.validateCondition({...F.defaults('condition'),name:'致命毒素',levels:{一般:{difficulty:100,duration:{kind:'actions',count:3},worsenAfter:0,effects:[{target:'hp',amount:'1'}]}}});
  condition.id='poison';condition.version=1;condition.published=true;s.conditionTemplates.poison=condition;B.applyCondition(s,n.character,{id:'poison',severity:'一般'},minRng,a.id);
  B.beginConditions(n.character,b,n,minRng,s);assert.equal(s.deaths[n.deathId].rewarded.userId,'1');assert.equal(Object.keys(s.corpses).length,0);
  const unknown=B.addNPC(s,b,t.id,'enemy');unknown.character.hp=0;const d=DT.settle(s,b,unknown);assert.equal(d.rewarded,null);DT.reward(s,b,d,'2');assert.equal(d.rewarded.userId,'2');
  const ally=B.addNPC(s,b,t.id,'ally');ally.character.hp=0;const friendly=DT.settle(s,b,ally,a.id);assert.equal(friendly.rewarded,null);assert.throws(()=>DT.reward(s,b,friendly,'1'),/不能/);
});
test('humanoid equipped attachments, magazine, ammo and keys drop once retaining instance state and overloaded claims stay', () => {
  const s=state();
  M.publishTemplate(s,{kind:'弹药',name:'9mm',ammoType:'9mm',rarity:'white',weightKg:.01});
  M.publishTemplate(s,{kind:'弹夹',name:'标准夹',ammoType:'9mm',magazineType:'标准',capacity:3,rarity:'white',weightKg:.2});
  const part=M.publishTemplate(s,{kind:'配件',name:'瞄具',compatible:['手枪'],attachmentSlot:'瞄具',rarity:'white',weightKg:.1});
  const gun=weapon(s,{weaponType:'手枪',melee:false,ammoType:'9mm',magazineType:'标准',capacity:3,current:2,preinstalled:[part.id]});
  const key=M.publishTemplate(s,{...F.defaults('item','钥匙'),name:'钥匙',keyCharges:3});const skill=M.publishTemplate(s,{...F.defaults('item','技能'),name:'技能'});
  const t=npcTemplate(s,{itemIds:[gun.id,key.id,skill.id]});const b=B.createBattle(s,'c','GM','装备');const a=B.join(s,b,'1'),n=B.addNPC(s,b,t.id,'enemy');
  const k=Object.values(n.character.inventory).find(i=>i.snapshot.kind==='钥匙');k.keyCharges=1;n.character.hp=0;const d=DT.settle(s,b,n,a.id),c=s.corpses[d.corpseId];
  assert.equal(c.items.filter(i=>i.snapshot.kind==='技能').length,0);assert.equal(c.items.find(i=>i.templateId===key.id).keyCharges,1);
  const root=c.items.find(i=>i.templateId===gun.id);assert.equal(root.loaded.current,2);assert.equal(root.bundle.length,2);assert.equal(c.items.filter(i=>i.snapshot.kind==='配件'||i.snapshot.kind==='弹夹').length,0);assert.equal(M.itemWeight(root),132);B.endBattle(s,b);
  s.players['1'].attributes.strength=0;s.players['1'].attributes.constitution=0;assert.throws(()=>DT.claim(s,c.id,'1',c.items.find(i=>i.templateId===gun.id).id),/超重/);assert.equal(Object.keys(c.claims).length,0);
});
test('player death cancels offers, removes exploration and turn, freezes history, clears all assets and lets new card start', () => {
  const {s,m}=mapFixture();X.join(s,m,'1');const p=s.players['1'];p.balance=100;p.tickets.card=10;M.issue(s,'1',Object.keys(s.catalog)[0]);
  const offer=M.createOffer(s,'1','2','trade'),b=B.createBattle(s,'f','GM','死亡');const a=B.join(s,b,'1'),n=B.addNPC(s,b,npcTemplate(s).id,'enemy');B.start(s,b,null,minRng);
  p.hp=0;const d=DT.settle(s,b,a,n.id);assert.ok(d.snapshot.inventory);assert.equal(s.players['1'],undefined);assert.equal(s.offers[offer.id].status,'cancelled');assert.equal(m.participants['1'],undefined);assert.ok(a.finalCharacter);assert.ok(!b.current || b.current.actorId!==a.id);
  M.rollCharacter(s,'1','新卡',false,minRng);s.characterDrafts['1'].gender='female';const fresh=M.confirmCharacter(s,'1');assert.notEqual(fresh.id,d.characterId);assert.equal(fresh.balance,0);assert.equal(fresh.tickets.card,0);assert.equal(Object.keys(fresh.inventory).length,0);assert.equal(M.battleFor(s,'1'),undefined);
  assert.equal(B.actorCharacter(s,a).id,d.characterId);assert.equal(DT.settle(s,b,a),null);
});
test('HP transaction reconciliation clears new noncombat deaths but preserves historical zero characters', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  await store.transact(C.DEFAULT_GUILD_ID,'seed','GM',st=>Object.assign(st.players,state().players));
  await store.transact(C.DEFAULT_GUILD_ID,'zero','GM',st=>{st.players['1'].hp=0;});assert.equal(store.snapshot(C.DEFAULT_GUILD_ID).players['1'],undefined);
  await store.transact(C.DEFAULT_GUILD_ID,'historical','GM',st=>{st.players['1']=state().players['1'];st.players['1'].hp=0;});
  await store.transact(C.DEFAULT_GUILD_ID,'noop','GM',()=>null);assert.equal(store.snapshot(C.DEFAULT_GUILD_ID).players['1'].hp,0);
  const copy=createStore(h.deps);await copy.load(C.DEFAULT_GUILD_ID);assert.equal(Object.keys(copy.snapshot(C.DEFAULT_GUILD_ID).deaths).length,1);
});
test('encrypted death failure rollback/reconciliation and duplicate receipts cannot award twice or wipe a recreated character', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const setup=await store.transact(C.DEFAULT_GUILD_ID,'setup','GM',st=>{Object.assign(st.players,state().players);const b=B.createBattle(st,'c','GM','死亡');const a=B.join(st,b,'1'),n=B.addNPC(st,b,npcTemplate(st).id,'enemy');return {b:b.id,n:n.id,a:a.id};});
  h.fail('after');const op=st=>{const b=st.battles[setup.b],n=B.actorById(b,setup.n);n.character.hp=0;return DT.settle(st,b,n,setup.a).id;};
  const id=await store.transact(C.DEFAULT_GUILD_ID,'kill','1',op);await store.transact(C.DEFAULT_GUILD_ID,'kill','1',()=>{throw Error('duplicate')});
  const st=store.snapshot(C.DEFAULT_GUILD_ID);assert.equal(Object.keys(st.deaths).length,1);assert.equal(st.deaths[id].rewarded.userId,'1');
  assert.ok([...h.fileBodies.values()].every(v=>!v.includes('守卫')));
});
test('runtime map configuration authenticates GM and supports category, map creation, editing, generation and registration', async () => {
  const h=harness(),rpg=createRpg(h.deps);await rpg.start();try {
    await rpg.store.transact(C.DEFAULT_GUILD_ID,'seed','GM',st=>{Object.assign(st.players,state().players);st.config.gmRoleIds=['gm'];st.config.playerRoleIds=['player'];mapFixture(st);});
    const denied=h.interaction('1','地图配置');await rpg.handle(denied);assert.match(denied.result.content,/GM/);
    const conf=h.interaction('GM','地图配置');await rpg.handle(conf);validateMessage(conf.result);
    const home=h.interaction('GM','地图');await rpg.handle(home);validateMessage(home.result);
    const s=rpg.store.snapshot(C.DEFAULT_GUILD_ID),m=Object.values(s.explorations)[0];
    const join=h.interaction('1',null,{},'rpg:map:join:'+m.id);await rpg.handle(join);assert.ok(rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[m.id].participants['1']);validateMessage(join.result);
    const move=h.interaction('1',null,{},'rpg:map:move:'+m.id+':1,0');await rpg.handle(move);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[m.id].participants['1'].cell,'1,0');validateMessage(move.result);
    const personal=h.interaction('1',null,{},'rpg:map:personal:'+m.id);await rpg.handle(personal);validateMessage(personal.result);
    const config=h.interaction('GM',null,{},'rpg:map:rates');await rpg.handle(config);validateMessage(config.result);
    const pick=h.interaction('GM',null,{},'rpg:map:ratepick',['保险箱']);await rpg.handle(pick);validateMessage(pick.result);
    const update=h.interaction('GM',null,{},'rpg:map:rateeditsubmit:保险箱',undefined,{values:'0 0 0 0 0 100'});await rpg.handle(update);assert.deepEqual(L.rates(rpg.store.snapshot(C.DEFAULT_GUILD_ID),'保险箱'),[0,0,0,0,0,100]);
  }finally{rpg.stop();}
});
test('GM setting player zero HP requires explicit confirmation and dead historical actor cannot be revived', async () => {
  const h=harness(),rpg=createRpg(h.deps);await rpg.start();try{
    const data=await rpg.store.transact(C.DEFAULT_GUILD_ID,'seed','GM',st=>{Object.assign(st.players,state().players);st.config.gmRoleIds=['gm'];const b=B.createBattle(st,'channel','GM','死亡');const a=B.join(st,b,'1');return {b:b.id,a:a.id,char:st.players['1'].id};});
    const zero=h.interaction('GM','战斗',{sub:'生命',角色:data.a,数值:0});await rpg.handle(zero);assert.ok(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1']);assert.match(zero.result.embeds[0].data.title,/确认/);
    const confirm=h.interaction('GM',null,{},'rpg:gmui:'+data.b+':deathconfirm:'+data.a+':'+data.char);await rpg.handle(confirm);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'],undefined);
    const duplicate=h.interaction('GM',null,{},'rpg:gmui:'+data.b+':deathconfirm:'+data.a+':'+data.char);await rpg.handle(duplicate);assert.match(duplicate.result.content,/死亡/);
  }finally{rpg.stop();}
});
test('large fog cards and redesigned public/private character data obey Discord limits and hide assets', () => {
  const s=state(),{m}=mapFixture(s);m.width=20;m.floors=20;validateMessage(XU.board(m));
  const p=s.players['1'];p.balance=12345678;p.tickets.card=87654321;const pub=U.characterView(p);validateMessage(pub);assert.ok(!JSON.stringify(pub).includes('12345678'));assert.ok(!JSON.stringify(pub).includes('87654321'));
  const b=B.createBattle(s,'c','GM','属性');const a=B.join(s,b,'1');const v=U.personalView(s,b,a,'1');validateMessage(v);assert.ok(JSON.stringify(v).includes('身体属性'));assert.ok(JSON.stringify(v).includes('12345678'));
});
test('full private map wizard updates original panel, edits room cells and publishes fog without secret content', async () => {
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const {cat,room}=await rpg.store.transact(C.DEFAULT_GUILD_ID,'room','GM',st=>{const {cat,room,m}=mapFixture(st);m.channelId='existing';return{cat,room};});
    let i=h.interaction('GM','地图');await rpg.handle(i);i=await click(h,rpg,'GM',i,'创建地图');i=await click(h,rpg,'GM',i,'选择一项',[cat.id]);i=await click(h,rpg,'GM',i,'地图方式',['fixed']);
    const opened=await click(h,rpg,'GM',i,'填写名称与大小');assert.ok(opened.modal);i=await submit(h,rpg,'GM',opened,{name:'固定研究所',floors:'1',width:'3'});
    const m=Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations).find(m=>m.name==='固定研究所');assert.ok(m);
    i=await click(h,rpg,'GM',i,'添加 / 修改 / 删除格子');i=await click(h,rpg,'GM',i,'格子类型',['room']);
    const coords=await click(h,rpg,'GM',i,'填写列与楼层');i=await submit(h,rpg,'GM',coords,{x:'3',y:'1'});
    i=await click(h,rpg,'GM',i,'指定房间');i=await click(h,rpg,'GM',i,'选择一项',[room.id]);i=await click(h,rpg,'GM',i,'确认保存');
    i=await click(h,rpg,'GM',i,'生成 / 重新抽取');const before=rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[m.id].cells['2,0'].room.id;
    i=await click(h,rpg,'GM',i,'确认发布');const saved=rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[m.id];assert.equal(saved.status,'active');assert.equal(saved.cells['2,0'].room.id,before);
    assert.ok(saved.messageId);const pub=h.messages.get(saved.messageId).lastPayload;validateMessage(pub);assert.ok(!JSON.stringify(pub).includes('密闭实验室'));
    const list=h.interaction('1','地图');await rpg.handle(list);const chosen=await click(h,rpg,'1',list,'选择一项',[m.id]);validateMessage(chosen.result);assert.match(chosen.result.embeds[0].data.title,/探索地图/);
    const join=await click(h,rpg,'1',chosen,'参与探索');assert.ok(join.updatedSource);validateMessage(join.result);
  }finally{rpg.stop();}
});
test('shared container concurrent transactions and encrypted restart retain same batch, charge no tickets and preserve claim binding', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const d=await store.transact(C.DEFAULT_GUILD_ID,'seed','GM',st=>{Object.assign(st.players,state().players);const{m}=mapFixture(st);for(const u of ['1','2']){X.join(st,m,u);X.move(st,m,u,'1,0');X.move(st,m,u,'2,0');}st.players['1'].attributes.constitution=0;st.players['1'].attributes.strength=0;return {m:m.id,c:m.cells['2,0'].room.containers[0].id};});
  const results=await Promise.allSettled(['1','2'].map(uid=>store.transact(C.DEFAULT_GUILD_ID,'open-'+uid,uid,st=>X.open(st,st.explorations[d.m],uid,d.c,minRng))));assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  const batch=results[0].value.result;const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);
  const retry=await restored.transact(C.DEFAULT_GUILD_ID,'retry','1',st=>X.open(st,st.explorations[d.m],'1',d.c,()=>{throw Error('reroll')}));assert.deepEqual(retry.result.items,batch.items);
  await restored.transact(C.DEFAULT_GUILD_ID,'transfer','GM',st=>{const m=st.explorations[d.m];m.status='paused';X.transfer(st,m,'2,0',d.c,'2');m.status='active';});
  const claimed=await restored.transact(C.DEFAULT_GUILD_ID,'claim','2',st=>X.open(st,st.explorations[d.m],'2',d.c,()=>{throw Error('reroll')}));assert.equal(claimed.result.batchId,batch.batchId);assert.equal(claimed.result.pending,false);
  assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).players['2'].tickets.boxes.大衣,undefined);
});
test('death on action condition advances current actor safely and minute HP clamp follows unified settlement', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const refs=await store.transact(C.DEFAULT_GUILD_ID,'setup','GM',st=>{Object.assign(st.players,state().players);const b=B.createBattle(st,'c','GM','毒素');B.join(st,b,'1');B.join(st,b,'2');
    const t=B.validateCondition({...F.defaults('condition'),name:'毒',levels:{一般:{difficulty:100,duration:{kind:'actions',count:3},worsenAfter:0,effects:[{target:'hp',amount:'100'}]}}});t.id='poison';t.version=1;t.published=true;st.conditionTemplates.poison=t;B.applyCondition(st,st.players['1'],{id:t.id,severity:'一般'},minRng,b.actors[1].id);return b.id;});
  await store.transact(C.DEFAULT_GUILD_ID,'start','GM',st=>B.start(st,st.battles[refs],null,minRng));const s=store.snapshot(C.DEFAULT_GUILD_ID);assert.equal(s.players['1'],undefined);assert.notEqual(s.battles[refs].current?.actorId,s.battles[refs].actors[0].id);assert.ok(s.battles[refs].actors[0].deathId);
  await store.transact(C.DEFAULT_GUILD_ID,'restore-base','GM',st=>{const p=st.players['2'];p.attributes.constitution=0;p.temporaryEffects=[{id:'buff',name:'生命增益',templateId:'a',modifiers:[{target:'hpMax',op:'add',value:30}],duration:{kind:'minutes',count:1},expiresAt:1}];});
  await store.transact(C.DEFAULT_GUILD_ID,'expire','BOT',st=>A.expireAll(st,100));assert.equal(store.snapshot(C.DEFAULT_GUILD_ID).players['2'],undefined);
});
test('simultaneous corpse claims transfer each bundle at most once and recreated original participant is rejected', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const data=await store.transact(C.DEFAULT_GUILD_ID,'seed','GM',st=>{Object.assign(st.players,state().players);const b=B.createBattle(st,'c','GM','掉落');B.join(st,b,'1');B.join(st,b,'2');const t=npcTemplate(st,{itemIds:[Object.keys(st.catalog)[0]]});const n=B.addNPC(st,b,t.id,'enemy');n.character.hp=0;const d=DT.settle(st,b,n);B.endBattle(st,b);return {c:d.corpseId,item:st.corpses[d.corpseId].items[0].id};});
  const results=await Promise.allSettled(['1','2'].map(uid=>store.transact(C.DEFAULT_GUILD_ID,'pick-'+uid,uid,st=>DT.claim(st,data.c,uid,data.item))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Object.keys(store.snapshot(C.DEFAULT_GUILD_ID).corpses[data.c].claims).length,1);
});
test('upgrade 4 only initializes new fields and never awards historical kills or deletes zero-HP saved players', () => {
  const s=state(),b=B.createBattle(s,'c','GM','历史');const a=B.join(s,b,'1'),n=B.addNPC(s,b,npcTemplate(s).id,'enemy');s.upgrade=3;s.players['1'].hp=0;n.character.hp=0;
  delete s.explorations;delete s.mapCategories;delete s.roomTemplates;delete s.deaths;delete s.corpses;delete n.humanoid;delete n.baseXP;delete a.characterId;
  const old=JSON.stringify(s.players),report=A.migrate(s);assert.ok(report.maps);assert.equal(s.upgrade,5);assert.equal(JSON.stringify(s.players),old);assert.equal(n.baseXP,0);assert.equal(n.humanoid,false);assert.equal(Object.keys(s.deaths).length,0);assert.equal(A.migrate(s),null);
});
test('fatal condition preserves original caster identity after actor removal and never rewards a replacement card', () => {
  for (const replacement of [false, true]) {
    const s=state(),b=B.createBattle(s,'c','GM','持续伤害'),a=B.join(s,b,'1'),n=B.addNPC(s,b,npcTemplate(s,{humanoid:false}).id,'enemy');
    const t=B.validateCondition({...F.defaults('condition'),name:'持续毒素',levels:{一般:{difficulty:100,duration:{kind:'actions',count:3},worsenAfter:0,effects:[{target:'hp',amount:'100'}]}}});
    t.id='fatal';t.version=1;t.published=true;s.conditionTemplates[t.id]=t;
    B.applyCondition(s,n.character,{id:t.id,severity:'一般'},minRng,{actorId:a.id,userId:'1',characterId:s.players['1'].id});
    b.actors=b.actors.filter(x=>x.id!==a.id);
    if(replacement)s.players['1'].id='new-character';
    B.beginConditions(n.character,b,n,minRng,s);const death=s.deaths[n.deathId];
    assert.ok(death);assert.equal(death.rewarded?.userId,replacement?undefined:'1');
    if(!replacement)assert.equal(death.rewarded.result.credited,1000);
  }
});
test('corpse public cards survive restart and require GM confirmation before resending deleted messages', async () => {
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const refs=await rpg.store.transact(C.DEFAULT_GUILD_ID,'corpse-seed','GM',st=>{
      const b=B.createBattle(st,'channel','GM','尸体公示');B.join(st,b,'1');const n=B.addNPC(st,b,npcTemplate(st,{itemIds:[Object.keys(st.catalog)[0]]}).id,'enemy');
      n.character.hp=0;const d=DT.settle(st,b,n);B.endBattle(st,b);return{b:b.id,c:d.corpseId};
    });
    await rpg.exploration.publishCorpses(C.DEFAULT_GUILD_ID,refs.b);const first=rpg.store.snapshot(C.DEFAULT_GUILD_ID).corpses[refs.c].messageId;
    validateMessage(h.messages.get(first).lastPayload);h.messages.delete(first);
    await assert.rejects(()=>rpg.exploration.publishCorpses(C.DEFAULT_GUILD_ID,refs.b),/核对/);
    await rpg.exploration.publishCorpses(C.DEFAULT_GUILD_ID,refs.b,true);
    const next=rpg.store.snapshot(C.DEFAULT_GUILD_ID).corpses[refs.c];assert.notEqual(next.messageId,first);assert.equal(next.items.length,1);
    const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).corpses[refs.c].messageId,next.messageId);
  }finally{rpg.stop();}
});
test('transactional life adjustment rotates a dead current player and expiry cannot mutate NPC death snapshots', async () => {
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const ref=await store.transact(C.DEFAULT_GUILD_ID,'rotation-seed','GM',st=>{Object.assign(st.players,state().players);const b=B.createBattle(st,'c','GM','轮换');B.join(st,b,'1');B.join(st,b,'2');B.start(st,b,null,minRng);return b.id;});
  const first=store.snapshot(C.DEFAULT_GUILD_ID).battles[ref].current.actorId;
  await store.transact(C.DEFAULT_GUILD_ID,'fatal-adjust','GM',st=>{const b=st.battles[ref];B.actorCharacter(st,B.actorById(b,first)).hp=0;});
  const s=store.snapshot(C.DEFAULT_GUILD_ID);assert.ok(s.battles[ref].current);assert.notEqual(s.battles[ref].current.actorId,first);
  const n=B.addNPC(s,B.createBattle(s,'other','GM','快照'),npcTemplate(s).id,'enemy'),b=Object.values(s.battles).find(b=>b.channelId==='other');
  n.character.temporaryEffects=[{id:'expired',duration:{kind:'minutes',count:1},expiresAt:1,modifiers:[]}];n.character.hp=0;DT.settle(s,b,n);const saved=JSON.stringify(n.finalCharacter);
  A.expireAll(s,Date.now());assert.equal(JSON.stringify(n.finalCharacter),saved);assert.equal(n.character.temporaryEffects.length,1);
});
const certainCount=(max,n)=>Array.from({length:max+1},(_,k)=>k===n ? 100 : 0);
test('room count distributions validate every 0-6 and 0-10 boundary and independent two-decimal probabilities',()=>{
  for(const max of [6,10])for(let n=0;n<=max;n++){assert.equal(R.draw(certainCount(max,n),()=>0),n);assert.equal(R.draw(certainCount(max,n),()=>9999),n);}
  const p=[12.34,17.66,10,10,10,20,20];let at=0;for(let n=0;n<p.length;n++){assert.equal(R.draw(p,()=>at),n);assert.equal(R.draw(p,()=>at+Math.round(p[n]*100)-1),n);at+=Math.round(p[n]*100);}
  assert.throws(()=>R.probabilities([0,1,0,0,0,0,0],6),/100/);assert.throws(()=>R.probabilities([0,1.001,0,0,0,0,98.999],6),/两位/);
});
test('room generation independently combines fixed and random containers supplies and NPCs, including absent types',()=>{
  const s=state(),npc=npcTemplate(s),key=M.publishTemplate(s,{...F.defaults('item','钥匙'),name:'独立钥匙',keyCharges:3});
  const {m,room}=mapFixture(s,{supplyIds:[key.id],randomContainers:[{ref:'保险箱',probabilities:certainCount(6,6)},{ref:'小型保险',probabilities:certainCount(6,0)}],
    randomSupplies:[{ref:key.id,probabilities:certainCount(6,6)}],randomNpcs:[{ref:npc.id,probabilities:certainCount(10,10)}]});
  const r=m.cells['2,0'].room;assert.equal(r.containers.filter(c=>c.box==='保险箱').length,6);assert.equal(r.containers.filter(c=>c.box==='大衣').length,1);assert.equal(r.containers.filter(c=>c.box==='小型保险').length,0);
  assert.equal(r.supplies.length,7);assert.equal(new Set(r.supplies.map(i=>i.id)).size,7);assert.ok(r.supplies.every(i=>i.keyCharges===3));assert.equal(r.npcs[0].quantity,10);assert.equal(r.encounter,'pending');
  room.randomNpcs[0].probabilities=certainCount(10,0);assert.equal(r.npcs[0].quantity,10);assert.equal(r.randomResults.find(e=>e.kind==='npc').quantity,10);
  const empty=mapFixture(state(),{randomContainers:[{ref:'保险箱',probabilities:certainCount(6,0)}]}).m.cells['2,0'].room;assert.equal(empty.encounter,'resolved');
});
test('random NPCs that exceed combat slots remain frozen for subsequent GM-started waves without duplicate spawns',()=>{
  const s=state(),n1=npcTemplate(s),n2=npcTemplate(s,{name:'第二守卫'}),{m}=mapFixture(s,{randomNpcs:[{ref:n1.id,probabilities:certainCount(10,10)},{ref:n2.id,probabilities:certainCount(10,10)}]});
  X.join(s,m,'1');X.move(s,m,'1','1,0');X.move(s,m,'1','2,0');const r=m.cells['2,0'].room;
  const b=X.encounter(s,m,'2,0',['1']);assert.equal(b.actors.length,20);assert.equal(r.remainingNpcs.reduce((a,e)=>a+e.quantity,0),1);
  B.endBattle(s,b);X.resolve(s,m,'2,0');assert.equal(r.encounter,'pending');assert.throws(()=>X.currentRoom(s,m,'1'),/遭遇/);
  const second=X.encounter(s,m,'2,0',['1']);assert.equal(second.actors.length,2);B.endBattle(s,second);X.resolve(s,m,'2,0');assert.equal(r.encounter,'resolved');
});
test('room distribution publishing rejects missing references and invalid drafts, while legacy layouts remain unchanged',()=>{
  const s=state(),{room}=mapFixture(s),before=JSON.stringify(room);const f=F.create(s,'GM','room',null,room.id);
  f.data.randomNpcs=[{ref:'missing',probabilities:certainCount(10,1)}];assert.throws(()=>F.publish(s,f),/有效/);assert.equal(JSON.stringify(s.roomTemplates[room.id]),before);
  f.data.randomNpcs=[];f.data.randomContainers=[{ref:'保险箱',probabilities:[0,0,0,0,0,0,0]}];assert.throws(()=>F.publish(s,f),/100/);
  const legacy=mapFixture(state()).m.cells['2,0'].room;assert.equal(legacy.containers.length,1);assert.equal(legacy.supplies.length,0);assert.equal(legacy.randomResults.length,0);
});
test('fixed room counts use dropdowns, legacy malformed drafts reopen and every room settings panel fits Discord',()=>{
  const s=state(),f=F.create(s,'GM','room');f.data.boxes=['大衣'];f.data.containerCounts='错误的旧编号\n大衣 2';
  assert.equal(R.quantities(f.data.containerCounts,f.data.boxes,10).大衣,2);
  for(const [index,d] of F.fields(f).entries())if(['randomRoom','fixedRoom'].includes(d.type)){
    f.field=index;validateMessage(R.view(s,f));const options=d.type==='fixedRoom' ? f.data[d.refs] : d.source==='boxes' ? C.BOXES : Object.keys(s[d.source]);
    if(options.length)validateMessage(R.detail(s,f,index,options[0]));
  }
  assert.ok(!F.fields(f).some(d=>d.type==='long'&&['containerCounts','supplyQuantities','npcQuantities'].includes(d.key)));
});
test('GM dropdown probability editor persists partial drafts, prevents stale saves and publishes only completed distributions',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const refs=await rpg.store.transact(C.DEFAULT_GUILD_ID,'probability-seed','GM',st=>{const {room}=mapFixture(st);const n=npcTemplate(st);return{room:room.id,npc:n.id};});
    let i=h.interaction('GM',null,{},'rpg:map:library:room:pick',[refs.room]);await rpg.handle(i);
    const f=Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms).filter(f=>f.existingId===refs.room).at(-1),index=F.fields(f).findIndex(d=>d.key==='randomNpcs');
    i=await click(h,rpg,'GM',i,'选择要填写的字段',[String(index)]);i=await click(h,rpg,'GM',i,'编辑：随机NPC · 0—10个概率');i=await click(h,rpg,'GM',i,'选择要配置的内容',[refs.npc]);
    const opened=await click(h,rpg,'GM',i,'选择出现数量，填写该数量概率',['10']);i=await submit(h,rpg,'GM',opened,{probability:'100'});validateMessage(i.result);
    const partial=rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[f.id].data.randomNpcs[0];assert.equal(partial.probabilities[10],100);assert.equal(partial.probabilities[1],100);
    const stale=await submit(h,rpg,'GM',opened,{probability:'0'});assert.match(stale.result.content,/失效|变化/);
    // Reopen the durable draft after the stale attempt invalidated the old navigation group.
    i=h.interaction('GM',null,{},'rpg:formedit:'+f.id);await rpg.handle(i);i=await click(h,rpg,'GM',i,'选择要配置的内容',[refs.npc]);
    const removeOne=await click(h,rpg,'GM',i,'选择出现数量，填写该数量概率',['1']);i=await submit(h,rpg,'GM',removeOne,{probability:'0'});
    i=await click(h,rpg,'GM',i,'返回草稿');i=await click(h,rpg,'GM',i,'发布模板');assert.match(i.result.embeds[0].data.title,/已发布/);
    assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).roomTemplates[refs.room].randomNpcs[0].probabilities,certainCount(10,10));
    const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);assert.deepEqual(restored.snapshot(C.DEFAULT_GUILD_ID).roomTemplates[refs.room].randomNpcs[0].probabilities,certainCount(10,10));
  }finally{rpg.stop();}
});
test('saved random room content survives encrypted restart and fixed maps use the same template probabilities',async()=>{
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);
  const ref=await store.transact(C.DEFAULT_GUILD_ID,'random-room-generate','GM',st=>{
    Object.assign(st.players,state().players);const n=npcTemplate(st);return mapFixture(st,{randomNpcs:[{ref:n.id,probabilities:certainCount(10,10)}],randomContainers:[{ref:'保险箱',probabilities:certainCount(6,6)}]},'fixed').m.id;
  });const old=store.snapshot(C.DEFAULT_GUILD_ID).explorations[ref].cells['2,0'].room;
  const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);assert.deepEqual(restored.snapshot(C.DEFAULT_GUILD_ID).explorations[ref].cells['2,0'].room,old);
  await assert.rejects(()=>restored.transact(C.DEFAULT_GUILD_ID,'repeat-generate','GM',st=>X.generate(st,st.explorations[ref],()=>{throw Error('reroll')})),/发布/);
});
test('fixed supply dropdown reaches quantity 100 without entering IDs and enforces owner GM and original field',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const data=await rpg.store.transact(C.DEFAULT_GUILD_ID,'fixed-dropdown-seed','GM',st=>{
      const f=F.create(st,'GM','room');f.data.supplyIds=[Object.keys(st.catalog)[0]];f.field=F.fields(f).findIndex(d=>d.key==='supplyQuantities');return{f:f.id,ref:f.data.supplyIds[0],index:f.field};
    });let i=h.interaction('GM',null,{},'rpg:formedit:'+data.f);await rpg.handle(i);assert.ok(!i.modal);
    i=await click(h,rpg,'GM',i,'选择要配置的内容',[data.ref]);for(let n=0;n<3;n++)i=await click(h,rpg,'GM',i,'下一页数量');
    i=await click(h,rpg,'GM',i,'选择数量',['100']);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[data.f].data.supplyQuantities[data.ref],100);
    const spoof=h.interaction('1',null,{},'rpg:formroomfixed:'+data.f+':'+data.index+':'+data.ref,['1']);await rpg.handle(spoof);assert.match(spoof.result.content,/属于/);
    h.members.GM.roles.cache.clear();const denied=h.interaction('GM',null,{},'rpg:formroomfixed:'+data.f+':'+data.index+':'+data.ref,['1']);await rpg.handle(denied);assert.match(denied.result.content,/GM/);
    h.members.GM.roles.cache.set('gm',{id:'gm'});await rpg.store.transact(C.DEFAULT_GUILD_ID,'change-room-field','GM',st=>{st.forms[data.f].field=0;});
    const stale=h.interaction('GM',null,{},'rpg:formroomfixed:'+data.f+':'+data.index+':'+data.ref,['1']);await rpg.handle(stale);assert.match(stale.result.content,/变化/);
    assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[data.f].data.supplyQuantities[data.ref],100);
  }finally{rpg.stop();}
});

const Dur=require('../src/rpg/durability'),Texts=require('../src/rpg/texts');
function gunFixture(s,extra={}){
  const ammo=M.publishTemplate(s,{kind:'弹药',name:'测试弹',rarity:'white',weightKg:.01,damage:{physical:'2'}});
  const mag=M.publishTemplate(s,{kind:'弹夹',name:'测试弹夹',rarity:'white',weightKg:.1,ammoIds:[ammo.id],capacity:4});
  const gun=weapon(s,{weaponType:'步枪',ammoIds:[ammo.id],magazineIds:[mag.id],capacity:4,current:4,fireModes:['semi','auto'],damage:{physical:'3'},...extra});
  return{ammo,mag,gun};
}
test('RPG ID-based slash entries all open selectors without mandatory identifiers',()=>{
  for(const command of commands().map(c=>c.toJSON())){assert.ok((command.options||[]).length<=25);for(const o of command.options||[]){if(o.options)for(const f of o.options)assert.ok(!f.required||!['物品','模板','角色','编号','配件'].includes(f.name));else assert.ok(!o.required||!['物品','模板','角色','编号','配件'].includes(o.name));}}
});
test('ammo and magazine wizards expose damage conditions weight capacity and reference dropdowns',()=>{
  const s=state(),{ammo,mag,gun}=gunFixture(s);assert.equal(ammo.ammoType,'测试弹');assert.equal(mag.magazineType,'测试弹夹');assert.equal(gun.initialAmmo.id,ammo.id);assert.equal(gun.initialMagazine.id,mag.id);
  for(const kind of ['弹药','弹夹','武器','防具','修复道具']){const f=F.create(s,'GM','item',kind);validateMessage(F.view(s,f));const fields=F.fields(f);assert.ok(!fields.some(d=>['ammoType','magazineType'].includes(d.key)));if(['武器','弹夹'].includes(kind))assert.equal(fields.find(d=>d.key==='ammoIds').type,'refs');}
  const wrong=M.publishTemplate(s,{kind:'弹药',name:'不兼容',rarity:'white',weightKg:0});assert.throws(()=>weapon(s,{weaponType:'步枪',ammoIds:[wrong.id],magazineIds:[mag.id],capacity:4,current:0}),/不兼容/);
});
test('template reference and NPC quantity editors paginate without handwritten identifiers',()=>{
  const s=state();for(let n=0;n<31;n++)M.publishTemplate(s,{kind:'弹药',name:'子弹'+n,rarity:'white',weightKg:0});
  const f=F.create(s,'GM','item','武器');f.field=F.fields(f).findIndex(d=>d.key==='ammoIds');validateMessage(F.choiceView(s,f));f.choicePage=1;validateMessage(F.choiceView(s,f));const ref=F.options(s,F.fields(f)[f.field])[30].value;F.setChoice(s,f,1,[ref]);assert.deepEqual(f.data.ammoIds,[ref]);
  const npc=F.create(s,'GM','npc');npc.data.name='NPC';npc.data.itemIds=[ref];npc.field=F.fields(npc).findIndex(d=>d.key==='quantities');validateMessage(R.view(s,npc));validateMessage(R.detail(s,npc,npc.field,ref,3));npc.data.quantities={[ref]:100};assert.equal(B.validateNPC(s,npc.data).loadout[0].quantity,100);
});
test('effects beyond 25 are reachable on a second dropdown page',()=>{
  const s=state(),f=F.create(s,'GM','trait');f.field=F.fields(f).findIndex(d=>d.key==='effects');f.data.effects=Array.from({length:30},()=>({target:'hit',op:'add',value:1}));f.effectPage=1;const v=F.effectsView(s,f);validateMessage(v);const menu=v.components.flatMap(r=>r.toJSON().components).find(c=>c.placeholder==='删除某项效果');assert.equal(menu.options[4].value,'29');
});
test('GM can issue through paginated named templates with no own character and stale duplicate rejected',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const i=h.interaction('GM','gm',{sub:'发放',成员:'1'});await rpg.handle(i);validateMessage(i.result);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players.GM,undefined);
    const next=await click(h,rpg,'GM',i,'下一页');const menu=next.result.components.flatMap(r=>r.toJSON().components).find(c=>c.options);const ref=menu.options[0].value;
    const selected=await click(h,rpg,'GM',next,'下拉选择 · 发放',[ref]);const opened=await click(h,rpg,'GM',selected,'填写数量');const preview=await submit(h,rpg,'GM',opened,{quantity:'2'});const token=control(preview.result,'确认发放');const confirmed=await click(h,rpg,'GM',preview,'确认发放');assert.match(bodyOf(confirmed.result),/已完成/);assert.equal(Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory)[0].quantity,2);
    const duplicate=h.interaction('GM',null,{},token);await rpg.handle(duplicate);assert.match(duplicate.result.content,/失效/);assert.equal(Object.values(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory)[0].quantity,2);
  }finally{rpg.stop();}
});
test('inventory dropdown drop confirm is owner bound and cannot debit twice',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'drop-seed','GM',s=>M.issue(s,'1',Object.keys(s.catalog)[0],2)[0].id);
    const i=h.interaction('1','丢弃');await rpg.handle(i);const selection=await click(h,rpg,'1',i,'下拉选择 · 丢弃',[ref]);const opened=await click(h,rpg,'1',selection,'填写数量');const preview=await submit(h,rpg,'1',opened,{quantity:'1'});const token=control(preview.result,'确认丢弃');const bad=h.interaction('2',null,{},token);await rpg.handle(bad);assert.match(bad.result.content,/失效/);
    const done=await click(h,rpg,'1',preview,'确认丢弃');assert.match(bodyOf(done.result),/已完成/);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[ref].quantity,1);
  }finally{rpg.stop();}
});
test('trade quote selector saves item quantities coins and clears confirmations on change',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const data=await rpg.store.transact(C.DEFAULT_GUILD_ID,'quote-seed','GM',s=>{const item=M.issue(s,'1',Object.keys(s.catalog)[0],3)[0];s.players['1'].balance=20;const offer=M.createOffer(s,'1','2','trade');return{item:item.id,offer:offer.id};});
    let i=h.interaction('1',null,{},'rpg:quote:'+data.offer+':1');await rpg.handle(i);validateMessage(i.result);assert.equal(i.modal,undefined);let opened=await click(h,rpg,'1',i,'选择自己的报价物品',[data.item]);i=await submit(h,rpg,'1',opened,{value:'2'});assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers[data.offer].sides['1'].items[0].quantity,2);
    opened=await click(h,rpg,'1',i,'填写游戏币');i=await submit(h,rpg,'1',opened,{value:'5'});assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers[data.offer].sides['1'].coins,5);
    opened=await click(h,rpg,'1',i,'选择自己的报价物品',[data.item]);i=await submit(h,rpg,'1',opened,{value:'0'});assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers[data.offer].sides['1'].items,[]);assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).offers[data.offer].confirmations,{});
  }finally{rpg.stop();}
});
test('battle slash management routes select NPC actors and conditions with no mandatory IDs',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    await rpg.store.transact(C.DEFAULT_GUILD_ID,'battle-select-seed','GM',s=>{const b=B.createBattle(s,'channel','GM','下拉战斗');B.join(s,b,'1');const n=B.validateNPC(s,{...F.defaults('npc'),name:'NPC'});s.npcTemplates.n={...n,id:'n',version:1,published:true};});
    for(const sub of ['添加npc','位置','生命','异常','解除异常','移出']){const i=h.interaction('GM','战斗',{sub});await rpg.handle(i);validateMessage(i.result);assert.ok(i.result.components.some(r=>r.toJSON().components.some(c=>c.options)));}
  }finally{rpg.stop();}
});
test('semi and auto each freeze ammo bonuses, debit rounds, and defend each bullet once',()=>{
  const s=state(),{gun}=gunFixture(s),w=M.issue(s,'1',gun.id)[0];M.equip(s,'1',w.id);const armor=M.publishTemplate(s,{kind:'防具',name:'甲',rarity:'white',weightKg:0,traitIds:['neutral'],quality:'标准',origin:'未知',armorType:'胸甲',defenses:{physical:2}});const a=M.issue(s,'2',armor.id)[0];M.equip(s,'2',a.id);const {b}=fight(s);
  const hit=B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng,{mode:'auto',count:2});assert.equal(hit.shots.length,2);assert.equal(hit.damage.physical,10);assert.equal(w.loaded.current,2);assert.equal(w.durability,98);assert.equal(b.current.formal,0);const result=B.defend(s,b,hit.id,'defend',minRng);assert.equal(result.total,6);assert.throws(()=>B.defend(s,b,hit.id,'defend',minRng),/已结算/);
});
test('empty magazine is recorded immediately and unsupported or insufficient burst leaves assets unchanged',()=>{
  const s=state(),{gun}=gunFixture(s),w=M.issue(s,'1',gun.id)[0];M.equip(s,'1',w.id);const {b}=fight(s);let before=C.clone(s);assert.throws(()=>B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng,{mode:'auto',count:5}),/弹药/);assert.deepEqual(s,before);
  const hit=B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng,{mode:'auto',count:4});assert.equal(hit.ammoEmpty,true);assert.equal(w.loaded.current,0);assert.match(b.recent.at(-1).message,/无弹药/);assert.match(bodyOf(U.personalView(s,b,b.actors[0],'1')),/无弹药/);
});
test('ammo damage and condition snapshots survive magazine reload and template edits',()=>{
  const s=state(),{ammo,gun}=gunFixture(s),condition=(()=>{const f=F.create(s,'GM','condition');f.data.name='弹药异常';f.data.effectType='text';return F.publish(s,f);})();const t=M.publishTemplate(s,{...ammo,name:'附带异常弹',damage:{physical:'4'},conditions:[{id:condition.id,severity:'一般'}]});gun.ammoIds=[ammo.id,t.id];gun.initialMagazine.ammoIds=[ammo.id,t.id];const w=M.issue(s,'1',gun.id)[0];w.loaded.current=0;w.loaded.rounds=[];M.equip(s,'1',w.id);const rounds=M.issue(s,'1',t.id,4)[0];const {b}=fight(s);reloadViaMagazine(s,b,b.current.id,rounds.id,w.magazineId);s.catalog[t.id].damage.physical='999';const hit=B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng);assert.equal(hit.damage.physical,7);assert.equal(hit.conditions[0].template.name,'弹药异常');assert.equal(w.loaded.rounds[0].damage.physical,'4');
});
test('armor weakening subtracts resistance and broken armor loses defense on subsequent bullets',()=>{
  const s=state(),{gun}=gunFixture(s,{armorWeakening:{type:'physical',amount:5}}),w=M.issue(s,'1',gun.id)[0];M.equip(s,'1',w.id);const armor=M.publishTemplate(s,{kind:'防具',name:'易损甲',rarity:'white',weightKg:0,traitIds:['neutral'],quality:'标准',origin:'未知',armorType:'胸甲',durabilityMax:3,weakeningResistance:{physical:2},defenses:{physical:4}}),a=M.issue(s,'2',armor.id)[0];M.equip(s,'2',a.id);const {b}=fight(s);const hit=B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng,{mode:'auto',count:2});const result=B.defend(s,b,hit.id,'defend',minRng);assert.equal(result.total,6);assert.equal(a.durability,0);assert.equal(M.stats(s.players['2']).defenses.physical,0);assert.equal(result.armorDamage[0].lost,3);
});
test('broken weapons cannot attack; repair tools cap durability and combined tools repair either type',()=>{
  const s=state(),t=weapon(s,{durabilityMax:1}),w=M.issue(s,'1',t.id)[0];M.equip(s,'1',w.id);const {b}=fight(s);B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng);assert.equal(w.durability,0);assert.ok(!B.abilities(s.players['1']).some(a=>a.key===w.id));
  const tool=M.publishTemplate(s,{kind:'修复道具',name:'组合工具',rarity:'white',weightKg:.1,repairKinds:['武器','防具'],repairAmount:10}),i=M.issue(s,'1',tool.id,2)[0];const result=Dur.repair(s.players['1'],i.id,w.id);assert.equal(result.repaired,1);assert.equal(i.quantity,1);assert.throws(()=>Dur.repair(s.players['1'],i.id,w.id),/耐久已满/);assert.equal(i.quantity,1);
  delete w.durability;delete w.durabilityMax;delete w.snapshot.durabilityMax;assert.equal(Dur.current(w),100);
});
test('repair selection is private, confirms named target and duplicated use consumes only one tool',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const refs=await rpg.store.transact(C.DEFAULT_GUILD_ID,'repair-seed','GM',s=>{const w=M.issue(s,'1',weapon(s).id)[0];w.durability=10;const t=M.publishTemplate(s,{kind:'修复道具',name:'武器工具',rarity:'white',weightKg:0,repairKinds:['武器'],repairAmount:5}),tool=M.issue(s,'1',t.id,2)[0];return{w:w.id,t:tool.id};});
    const i=h.interaction('1','使用',{物品:refs.t});await rpg.handle(i);validateMessage(i.result);const preview=await click(h,rpg,'1',i,'选择要修复的装备',[refs.w]);assert.match(bodyOf(preview.result),/测试武器/);const token=control(preview.result,'确认使用');const done=await click(h,rpg,'1',preview,'确认使用');assert.match(bodyOf(done.result),/耐久/);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[refs.w].durability,15);const old=h.interaction('1',null,{},token);await rpg.handle(old);assert.match(old.result.content,/失效/);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[refs.t].quantity,1);
  }finally{rpg.stop();}
});
test('GM text drafts are private persistent versioned, rules reflect edits and others cannot publish',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const i=h.interaction('GM','gm',{sub:'文本编辑'});await rpg.handle(i);validateMessage(i.result);let view=await click(h,rpg,'GM',i,'GM文本编辑',['rule/世界背景']);const opened=await click(h,rpg,'GM',view,'编辑正文');view=await submit(h,rpg,'GM',opened,{value:'新的原点背景'});assert.equal(Texts.get(rpg.store.snapshot(C.DEFAULT_GUILD_ID),'rule/世界背景'),FA.WORLD);const published=await click(h,rpg,'GM',view,'发布文本');validateMessage(published.result);assert.equal(Texts.get(rpg.store.snapshot(C.DEFAULT_GUILD_ID),'rule/世界背景'),'新的原点背景');
    const rules=h.interaction('1','规则',{章节:'世界背景'});await rpg.handle(rules);assert.equal(bodyOf(rules.result),'新的原点背景');const lore=h.interaction('1',null,{},'rpg:faction:world');await rpg.handle(lore);assert.equal(bodyOf(lore.result),'新的原点背景');const bad=h.interaction('1','gm',{sub:'文本编辑'});await rpg.handle(bad);assert.match(bad.result.content,/GM身份组/);
    const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);assert.equal(Texts.get(restored.snapshot(C.DEFAULT_GUILD_ID),'rule/世界背景'),'新的原点背景');
  }finally{rpg.stop();}
});
test('role label selection edits configured role only and old ID-based drafts remain readable',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    h.guild.roles.cache.set('player',{id:'player',name:'玩家'});const id=await rpg.store.transact(C.DEFAULT_GUILD_ID,'label-seed','ADMIN',s=>{const f=F.create(s,'ADMIN','rolepanel');f.data.roleIds=['player'];f.data.labels='player=旧标签';f.field=F.fields(f).findIndex(d=>d.key==='labels');return f.id;});const i=h.interaction('ADMIN',null,{},'rpg:formedit:'+id);await rpg.handle(i);const opened=await click(h,rpg,'ADMIN',i,'选择身份组',['player']);const saved=await submit(h,rpg,'ADMIN',opened,{value:'加入探险'});validateMessage(saved.result);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[id].data.labels.player,'加入探险');
  }finally{rpg.stop();}
});

test('auto fire wizard uses a short receipt, chooses mode and amount and publishes empty warning immediately',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const uid='123456789012345678';h.members[uid]={...h.members['1'],id:uid,user:{id:uid,username:'长ID玩家'}};const data=await rpg.store.transact(C.DEFAULT_GUILD_ID,'burst-wizard-seed','GM',s=>{s.players[uid]=s.players['1'];delete s.players['1'];s.players[uid].userId=uid;const {gun}=gunFixture(s),w=M.issue(s,uid,gun.id)[0];M.equip(s,uid,w.id);const b=B.createBattle(s,'channel','GM','连射');B.join(s,b,uid);B.join(s,b,'2');B.start(s,b,null,minRng);return{b:b.id,w:w.id};});
    const i=h.interaction(uid,'战斗',{sub:'面板'});await rpg.handle(i);let view=await click(h,rpg,uid,i,'操作分页',['formal']);view=await click(h,rpg,uid,view,'攻击／释放技能');view=await click(h,rpg,uid,view,'选择武器／技能',[data.w]);view=await click(h,rpg,uid,view,'选择射击模式',['auto']);const target=rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[data.b].actors.find(a=>a.userId==='2');view=await click(h,rpg,uid,view,'攻击目标',[target.id]);const opened=await click(h,rpg,uid,view,'填写连射发数');assert.ok(opened.modal);const token=opened.modal.toJSON().custom_id;assert.ok(token.length<=100);const done=await submit(h,rpg,uid,opened,{count:'4'});assert.match(bodyOf(done.result),/无弹药/);const s=rpg.store.snapshot(C.DEFAULT_GUILD_ID);assert.equal(s.battles[data.b].pending.shotCount,4);assert.equal(s.players[uid].inventory[data.w].loaded.current,0);assert.ok(h.sent.some(v=>v.content?.includes('弹夹已空')));
    const restored=createStore(h.deps);await restored.load(C.DEFAULT_GUILD_ID);assert.deepEqual(restored.snapshot(C.DEFAULT_GUILD_ID).battles[data.b].pending,s.battles[data.b].pending);assert.equal(restored.snapshot(C.DEFAULT_GUILD_ID).players[uid].inventory[data.w].durability,96);
  }finally{rpg.stop();}
});
test('text chapters beyond a page remain editable and stale edits cannot overwrite published text',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    let i=h.interaction('GM','gm',{sub:'文本编辑'});await rpg.handle(i);i=await click(h,rpg,'GM',i,'下一页');const key=Texts.definitions().at(-1).key;let view=await click(h,rpg,'GM',i,'GM文本编辑',[key]);const edit=await click(h,rpg,'GM',view,'编辑正文');await rpg.store.transact(C.DEFAULT_GUILD_ID,'other-gm-text','GM',s=>{s.config.textOverrides||={};s.config.textOverrides[key]={text:'其他GM的新文本',version:1};});const stale=h.interaction('GM',null,{},edit.modal.toJSON().custom_id,null,{value:'旧编辑覆盖'});await rpg.handle(stale);assert.match(stale.result.content,/其他GM修改/);assert.equal(Texts.get(rpg.store.snapshot(C.DEFAULT_GUILD_ID),key),'其他GM的新文本');
  }finally{rpg.stop();}
});

test('repair maximum loss is per instance, defaults to zero, clamps current and preserves a minimum of one',()=>{
  const s=state(),w=M.issue(s,'1',weapon(s,{durabilityMax:100}).id)[0];w.durability=80;
  const t=M.publishTemplate(s,{kind:'修复道具',name:'应急修复',rarity:'white',weightKg:0,repairKinds:['武器'],repairAmount:50,repairMaxLoss:30});const tool=M.issue(s,'1',t.id,2)[0];const result=Dur.repair(s.players['1'],tool.id,w.id);assert.equal(result.maximum,70);assert.equal(result.maximumLost,30);assert.equal(w.durability,70);assert.equal(w.snapshot.durabilityMax,100);
  w.durability=0;tool.snapshot.repairMaxLoss=9999;const second=Dur.repair(s.players['1'],tool.id,w.id);assert.equal(second.maximum,1);assert.equal(w.durability,1);assert.equal(s.players['1'].inventory[tool.id],undefined);
});
test('reserved repair tools reject use and combat repairs consume exactly one quick action',()=>{
  const s=state(),w=M.issue(s,'1',weapon(s).id)[0];w.durability=10;const t=M.publishTemplate(s,{kind:'修复道具',name:'工具',rarity:'white',weightKg:0,repairKinds:['武器','防具'],repairAmount:20}),tool=M.issue(s,'1',t.id,2)[0];const offer=M.createOffer(s,'1','2','trade');M.updateOffer(s,offer.id,'1',[{id:tool.id,quantity:2}],0);const {b}=fight(s);assert.throws(()=>B.useItem(s,b,b.current.id,tool.id,minRng,w.id),/预留/);assert.equal(w.durability,10);assert.equal(b.current.quick,1);M.cancelOffer(s,offer.id,'1');const result=B.useItem(s,b,b.current.id,tool.id,minRng,w.id);assert.equal(result.repaired,20);assert.equal(b.current.quick,0);assert.equal(tool.quantity,1);assert.throws(()=>B.useItem(s,b,b.current.id,tool.id,minRng,w.id),/快速/);
});

test('luck combines signed flat and percent effects, clamps and cannot consume free points',()=>{
  const s=state(),p=s.players['1'];assert.equal(M.stats(p).luck,1);p.temporaryEffects=[{duration:{kind:'actions'},modifiers:[{target:'attr:luck',op:'add',value:2},{target:'attr:luck',op:'percent',value:50}]}];assert.equal(M.stats(p).luck,4);p.luck=-9;assert.equal(M.stats(p).luck,-9);p.luck=11;assert.equal(M.stats(p).luck,11);assert.throws(()=>M.allocate(s,'1','luck',1),/属性无效/);assert.throws(()=>M.allocate(s,'1','adaptation',1),/属性无效/);assert.equal(p.points,2);
});
test('luck tiers preserve exact integer probability totals, zeros and saturation',()=>{
  const s=state();assert.deepEqual(L.adjustedRates(s,'card',1),[45,25,20,8.5,1,.5]);assert.deepEqual(L.adjustedRates(s,'card',0),[45.5,25.5,20.5,7.23,.85,.42]);assert.deepEqual(L.adjustedRates(s,'card',2),[44.25,24.58,19.67,9,1.5,1]);assert.deepEqual(L.adjustedRates(s,'card',5),[42,23.33,18.67,10.5,3,2.5]);
  for(let luck=-9;luck<=11;luck++)for(const box of ['card',...C.BOXES]){const v=L.adjustedRates(s,box,luck);assert.equal(v.reduce((n,x)=>n+Math.round(x*100),0),10000);assert.ok(v.every(x=>x>=0));}
  L.setRates(s,'保险箱',[99,0,0,1,0,0]);assert.deepEqual(L.adjustedRates(s,'保险箱',-9),[100,0,0,0,0,0]);assert.deepEqual(L.adjustedRates(s,'保险箱',11),[95.8,0,0,4.2,0,0]);L.setRates(s,'保险箱',[0,0,0,0,0,100]);assert.deepEqual(L.adjustedRates(s,'保险箱',11),[0,0,0,0,0,100]);
});
test('pending personal loot freezes luck rates and exact template prices even after luck changes',()=>{
  const s=state(),p=s.players['1'];p.tickets.boxes.饭盒=2;p.luck=5;p.inventory.heavy={id:'heavy',quantity:1,snapshot:{weight:99999}};const first=M.openLoot(s,'1','饭盒',minRng);assert.ok(first.pending);assert.equal(first.luck,5);assert.deepEqual(first.rates,L.adjustedRates(s,'饭盒',5));assert.equal(first.item.snapshot.value,s.catalog[first.item.templateId].value);p.luck=-9;const again=M.openLoot(s,'1','饭盒',()=>{throw Error('reroll');});assert.deepEqual(again,first);delete p.inventory.heavy;const claimed=M.openLoot(s,'1','饭盒',()=>{throw Error('reroll');});assert.equal(claimed.luck,5);assert.equal(p.tickets.boxes.饭盒,1);
});
test('economy upgrade zeros only balances, migrates live values and ranges once and retains history',()=>{
  const s=state(),p=s.players['1'];s.upgrade=4;p.balance=888;p.tickets.card=4;const t=weapon(s,{rarity:'purple',value:90000,range:3}),item=M.issue(s,'1',t.id)[0];p.pendingLoot.饭盒={id:'pending',items:[M.makeItem(s.catalog.seed_6_white)]};s.offers.a={status:'ready',price:20000};s.offers.b={status:'completed',price:20000};s.events.push({result:C.clone(item)});s.lootPublications.old={result:C.clone(item)};const inv=Object.keys(p.inventory),history=JSON.stringify(s.events),report=A.migrate(s);assert.equal(report.balancesReset,3);assert.equal(p.balance,0);assert.deepEqual(Object.keys(p.inventory),inv);assert.equal(p.tickets.card,4);assert.equal(item.snapshot.value,1000);assert.equal(item.snapshot.rangeMeters,150);assert.equal(p.pendingLoot.饭盒.items[0].snapshot.value,12);assert.equal(s.offers.a.status,'cancelled');assert.equal(s.offers.b.price,20000);assert.equal(JSON.stringify(s.events),history);assert.equal(s.lootPublications.old.result.snapshot.value,90000);p.balance=42;assert.equal(A.migrate(s),null);assert.equal(p.balance,42);
});
test('all 72 modern items have individual values in the new bands and system placeholders stay zero',()=>{
  const s=state(),items=Object.values(s.catalog).filter(t=>t.id.startsWith('seed_'));assert.equal(items.length,72);for(const t of items){const r=C.RARITIES.find(r=>r.id===t.rarity);assert.ok(t.value>=r.min&&t.value<=r.max);}assert.ok(new Set(items.filter(t=>t.rarity==='white').map(t=>t.value)).size>5);assert.equal(s.catalog.special_heart.value,0);
});
test('new cards require gender and preserve all three personal descriptions across rerolls',()=>{
  const s=C.newState('x'),d=M.rollCharacter(s,'1','本人',false,minRng);assert.throws(()=>M.confirmCharacter(s,'1'),/男性/);d.gender='female';d.profile={background:'来自废墟',appearance:'灰色外套',belief:'守护同伴'};const next=M.rollCharacter(s,'1','',true,minRng);assert.equal(next.gender,'female');assert.deepEqual(next.profile,d.profile);const p=M.confirmCharacter(s,'1');assert.equal(p.gender,'female');assert.equal(p.luck,1);assert.equal(p.profile.belief,'守护同伴');assert.deepEqual(p.attributes,next.attributes);assert.deepEqual(p.portraits,{});
});
test('long personal descriptions paginate completely without exposing assets and obey Discord limits',()=>{
  const s=state(),p=s.players['1'];p.profile={background:'背'.repeat(2000),appearance:'貌'.repeat(2000),belief:'信'.repeat(2000)};p.gender='male';p.balance=987654321;
  let serialized='',content='';for(let n=0;n<7;n++){const r=U.characterView(p,false,n);validateMessage(r);serialized+=JSON.stringify(r.embeds[0].toJSON());content+=r.embeds[0].data.fields.filter(f=>['个人背景','个人外貌描述','个人信念'].includes(f.name)).map(f=>f.value).join('');}
  assert.equal((content.match(/背/g)||[]).length,2000);assert.equal((content.match(/貌/g)||[]).length,2000);assert.equal((content.match(/信/g)||[]).length,2000);assert.match(serialized,/男性/);assert.doesNotMatch(serialized,/987654321/);
});
test('allocation rejects changed points, live combat, another owner and repeated confirmations',()=>{
  const CP=require('../src/rpg/character-panel'),s=state(),p=s.players['1'];const form=()=>({id:C.id('f'),kind:'allocation',owner:'1',characterId:p.id,fingerprint:CP.fingerprint(p),attribute:'strength',amount:1,expiresAt:Date.now()+10000});let f=form();s.forms[f.id]=f;assert.throws(()=>CP.commitAllocation(s,f.id,'2'),/失效/);assert.equal(CP.commitAllocation(s,f.id,'1').remaining,1);assert.throws(()=>CP.commitAllocation(s,f.id,'1'),/失效/);f=form();s.forms[f.id]=f;p.points++;assert.throws(()=>CP.commitAllocation(s,f.id,'1'),/已经变化/);f=form();s.forms[f.id]=f;const b=B.createBattle(s,'channel','GM','加点');B.join(s,b,'1');B.start(s,b,null,minRng);assert.throws(()=>CP.commitAllocation(s,f.id,'1'),/暂停/);b.status='paused';CP.commitAllocation(s,f.id,'1');
});
test('private allocation dropdown previews, confirms and prevents a duplicate deduction',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const home=h.interaction('1','角色设置');await rpg.handle(home);const panel=await click(h,rpg,'1',home,'分配自由属性点'),attr=await click(h,rpg,'1',panel,'选择要增加的属性',['constitution']),amount=await click(h,rpg,'1',attr,'选择点数（1至25）',['2']);assert.match(bodyOf(amount.result),/5 → \*\*7/);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].points,2);const confirmed=await click(h,rpg,'1',amount,'确认分配');assert.match(confirmed.result.content,/已保存/);const stale=await click(h,rpg,'1',amount,'确认分配');assert.match(stale.result.content,/失效/);const p=rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'];assert.equal(p.points,0);assert.equal(p.attributes.constitution,7);}finally{rpg.stop();}
});
test('role settings validate ownership, gender and bio modals, and cancel does not allocate',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const p=rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'];const wrong=h.interaction('2',null,{},'rpg:profile:home:1:'+p.id);await rpg.handle(wrong);assert.match(wrong.result.content,/自己的/);const home=h.interaction('1','角色设置');await rpg.handle(home);const sex=await click(h,rpg,'1',home,'性别',['female']),opened=await click(h,rpg,'1',sex,'背景 / 外貌 / 信念'),saved=await submit(h,rpg,'1',opened,{background:'出生在IX区',appearance:'穿着大衣',belief:'追寻真相'});assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].profile.belief,'追寻真相');const panel=await click(h,rpg,'1',saved,'分配自由属性点');await click(h,rpg,'1',panel,'取消 / 返回');assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].points,2);}finally{rpg.stop();}
});
test('allocation supports a paginated-size dropdown, larger amount modal and all remaining points',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{await rpg.store.transact(C.DEFAULT_GUILD_ID,'points-70','GM',s=>{s.players['1'].points=70;});const home=h.interaction('1','角色设置');await rpg.handle(home);const panel=await click(h,rpg,'1',home,'分配自由属性点');assert.equal(jsonComponents(panel.result).find(c=>c.placeholder==='选择点数（1至25）').options.length,25);const attr=await click(h,rpg,'1',panel,'选择要增加的属性',['agility']),opened=await click(h,rpg,'1',attr,'填写更多点数'),value=await submit(h,rpg,'1',opened,{amount:'40'});assert.match(bodyOf(value.result),/消耗 40点/);const all=await click(h,rpg,'1',value,'全部分配');await click(h,rpg,'1',all,'确认分配');const p=rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'];assert.equal(p.points,0);assert.equal(p.attributes.agility,76);}finally{rpg.stop();}
});
test('GM luck changes only base luck with GM authorization and no GM character required',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const denied=h.interaction('1','gm',{sub:'时运',成员:'1',数值:5});await rpg.handle(denied);assert.match(denied.result.content,/GM/);const i=h.interaction('GM','gm',{sub:'时运',成员:'1',数值:5});await rpg.handle(i);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].luck,5);assert.match(bodyOf(i.result),/基础时运 5/);}finally{rpg.stop();}
});
test('range metres applies flat then percentage and rejects out of range before consuming resources',()=>{
  const {s,b}=fight(),p=s.players['1'],t=weapon(s,{weaponType:'法杖',rangeMeters:40,damage:{physical:'1'},effects:[{target:'range',op:'add',value:10},{target:'range',op:'percent',value:20}]}),w=M.issue(s,'1',t.id)[0];p.equipped.weapon=w.id;b.actors[1].x=b.actors[0].x+60;b.actors[1].y=b.actors[0].y;B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng);assert.equal(w.durability,99);const f=fight(),t2=weapon(f.s,{weaponType:'法杖',rangeMeters:59.99,damage:{physical:'1'}}),w2=M.issue(f.s,'1',t2.id)[0];f.s.players['1'].equipped.weapon=w2.id;f.b.actors[1].x=f.b.actors[0].x+60;f.b.actors[1].y=f.b.actors[0].y;const before=JSON.stringify(f.s);assert.throws(()=>B.attack(f.s,f.b,f.b.current.id,w2.id,f.b.actors[1].id,'formal',minRng),/射程/);assert.equal(JSON.stringify(f.s),before);
});
test('new luck and range effect choices remain valid under Discord component limits',()=>{
  const s=state(),f=F.create(s,'GM','item','武器');f.field=F.fields(f).findIndex(d=>d.key==='effects');const v=F.effectsView(s,f);validateMessage(v);const opts=jsonComponents(v).flatMap(c=>c.options||[]);assert.ok(opts.some(o=>o.label==='时运'));assert.ok(opts.some(o=>o.label==='攻击距离（米）'));const c=F.create(s,'GM','condition');c.field=F.fields(c).findIndex(d=>d.type==='conditionEffects');validateMessage(F.effectsView(s,c));
});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=','base64');
function imageHarness(){const h=harness();h.fileBodies.set('memory:picture',PNG);h.deps.fetcher=async url=>({ok:h.fileBodies.has(url),arrayBuffer:async()=>Buffer.from(h.fileBodies.get(url)),json:async()=>JSON.parse(h.fileBodies.get(url))});return h;}
test('portrait validation checks binary format and size rather than file extension',()=>{const P=require('../src/rpg/portraits');assert.equal(P.format(PNG),'png');assert.throws(()=>P.format(Buffer.alloc(100)),/实际格式/);assert.throws(()=>P.format(Buffer.alloc(P.LIMIT+1)),/4 MiB/);});
test('player dual portraits are encrypted, previewed, saved and readable after restart',async()=>{
  const h=imageHarness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const i=h.interaction('1','角色图片',{头像:{size:PNG.length,url:'memory:picture'},立绘:{size:PNG.length,url:'memory:picture'}});await rpg.handle(i);validateMessage(i.result);assert.equal(i.result.files.length,2);assert.match(i.result.embeds[0].data.thumbnail.url,/attachment:/);assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits,{});const media=h.sent.filter(m=>m.content.startsWith('discord-api-bot-rpg-image:'));assert.equal(media.length,2);assert.ok(!Buffer.from(media[0].lastPayload.files[0].attachment).toString().includes(PNG.toString('base64')));await click(h,rpg,'1',i,'确认保存图片');const refs=rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits;assert.ok(refs.avatar.messageId&&refs.illustration.messageId);const restored=createRpg(h.deps);await restored.start();try{const card=h.interaction('1','角色卡');await restored.handle(card);assert.equal(card.result.files.length,2);assert.ok(card.result.embeds[0].data.image.url);assert.ok(!('rpgPortraits'in card.result));}finally{restored.stop();}}finally{rpg.stop();}
});
test('portrait cancellation and upload failure preserve old images, clear removes only selected slot',async()=>{
  const h=imageHarness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const i=h.interaction('1','角色图片',{头像:{size:PNG.length,url:'memory:picture'},立绘:{size:PNG.length,url:'memory:picture'}});await rpg.handle(i);await click(h,rpg,'1',i,'确认保存图片');const before=C.clone(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits);const cancel=h.interaction('1','角色图片',{清除:'both'});await rpg.handle(cancel);await click(h,rpg,'1',cancel,'取消');assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits,before);const failed=h.interaction('1','角色图片',{头像:{size:10,url:'missing'}});await rpg.handle(failed);assert.match(failed.result.content,/下载失败/);assert.deepEqual(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits,before);const clear=h.interaction('1','角色图片',{清除:'avatar'});await rpg.handle(clear);await click(h,rpg,'1',clear,'确认保存图片');const after=rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].portraits;assert.equal(after.avatar,undefined);assert.deepEqual(after.illustration,before.illustration);}finally{rpg.stop();}
});
test('missing encrypted portrait falls back to text character card',async()=>{
  const h=imageHarness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{await rpg.store.transact(C.DEFAULT_GUILD_ID,'missing-image','GM',s=>{s.players['1'].portraits.avatar={id:'missing',messageId:'missing',ext:'png',hash:'x'};});const card=h.interaction('1','角色卡');await rpg.handle(card);assert.match(card.result.content,/图片暂时/);assert.ok(card.result.embeds.length);assert.equal(card.result.files.length,0);}finally{rpg.stop();}
});
test('NPC image picker requires GM, updates version and preserves existing battle images',async()=>{
  const h=imageHarness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{const data=await rpg.store.transact(C.DEFAULT_GUILD_ID,'npc-images','GM',s=>{const n=npcTemplate(s),b=B.createBattle(s,'npc','GM','快照'),a=B.addNPC(s,b,n.id,'enemy');return {n:n.id,b:b.id,a:a.id,version:n.version};});const denied=h.interaction('1','npc图片',{头像:{size:PNG.length,url:'memory:picture'}});await rpg.handle(denied);assert.match(denied.result.content,/GM/);const i=h.interaction('GM','npc图片',{头像:{size:PNG.length,url:'memory:picture'}});await rpg.handle(i);const id=jsonComponents(i.result).find(c=>c.options).custom_id,choose=h.interaction('GM',null,{},id,[data.n]);choose.message={flags:new D.MessageFlagsBitField(D.MessageFlags.Ephemeral)};await rpg.handle(choose);await click(h,rpg,'GM',choose,'确认保存图片');const s=rpg.store.snapshot(C.DEFAULT_GUILD_ID);assert.equal(s.npcTemplates[data.n].version,data.version+1);assert.ok(s.npcTemplates[data.n].portraits.avatar);assert.deepEqual(B.actorById(s.battles[data.b],data.a).character.portraits,{});const a=B.addNPC(s,s.battles[data.b],data.n,'enemy');assert.deepEqual(a.character.portraits,s.npcTemplates[data.n].portraits);}finally{rpg.stop();}
});

test('map batch uses first opener luck and retains probabilities after transferring to another player',()=>{
  const {s,m}=mapFixture();for(const u of ['1','2']){X.join(s,m,u);X.move(s,m,u,'1,0');X.move(s,m,u,'2,0');}const p=s.players['1'];p.luck=11;p.attributes.strength=0;p.attributes.constitution=0;s.players['2'].luck=-9;
  const c=m.cells['2,0'].room.containers[0],first=X.open(s,m,'1',c.id,minRng);assert.equal(first.result.luck,11);assert.deepEqual(first.result.rates,L.adjustedRates(s,c.box,11));assert.ok(first.result.pending);m.status='paused';X.transfer(s,m,'2,0',c.id,'2');m.status='active';const claim=X.open(s,m,'2',c.id,()=>{throw Error('reroll');});assert.equal(claim.result.luck,11);assert.deepEqual(claim.result.rates,first.result.rates);assert.deepEqual(claim.result.items,first.result.items);assert.equal(claim.result.pending,false);
});
test('upgrade failure preserves canonical balances and successful recovery persists the reset only once',async()=>{
  const h=harness(),store=createStore(h.deps);await store.load(C.DEFAULT_GUILD_ID);await store.transact(C.DEFAULT_GUILD_ID,'pre-upgrade','GM',s=>{Object.assign(s.players,state().players);s.players['1'].balance=333;s.upgrade=4;});const upgraded=createStore(h.deps);h.fail('before');await assert.rejects(upgraded.load(C.DEFAULT_GUILD_ID));const fresh=createStore(h.deps);await fresh.load(C.DEFAULT_GUILD_ID);assert.equal(fresh.snapshot(C.DEFAULT_GUILD_ID).players['1'].balance,0);assert.equal(fresh.snapshot(C.DEFAULT_GUILD_ID).economyMigration.version,1);await fresh.transact(C.DEFAULT_GUILD_ID,'new-money','GM',s=>{s.players['1'].balance=10;});const again=createStore(h.deps);await again.load(C.DEFAULT_GUILD_ID);assert.equal(again.snapshot(C.DEFAULT_GUILD_ID).players['1'].balance,10);assert.equal(again.snapshot(C.DEFAULT_GUILD_ID).events.filter(e=>e.id==='rpg-upgrade-5').length,1);
});
test('NPC image edits are preserved when a previously opened statistics draft publishes later',()=>{
  const s=state(),t=npcTemplate(s),f=F.create(s,'GM','npc',null,t.id);s.npcTemplates[t.id].portraits={avatar:{id:'image'}};s.npcTemplates[t.id].version++;f.data.name='改名字';const result=F.publish(s,f);assert.deepEqual(result.portraits,{avatar:{id:'image'}});
});
test('effect targets can paginate independently of existing effects without exceeding five rows',()=>{
  const s=state(),f=F.create(s,'GM','item');f.field=F.fields(f).findIndex(d=>d.key==='effects');const original=C.EFFECT_TARGETS.length;
  try{for(let n=0;n<10;n++)C.EFFECT_TARGETS.push('extra:'+n);f.data.effects=Array.from({length:30},()=>({target:'attr:strength',value:1}));f.targetPage=1;f.effectPage=1;const v=F.effectsView(s,f);validateMessage(v);assert.ok(jsonComponents(v).some(c=>c.label==='上一页目标'));assert.equal(jsonComponents(v).find(c=>c.placeholder==='删除某项效果').options.length,5);}finally{C.EFFECT_TARGETS.splice(original);}
});

function automaticFight(extra={}){
  const s=state(),t=weapon(s,{weightKg:0,damage:{physical:'1'},...extra}),npc=npcTemplate(s,{hpMax:100,itemIds:[t.id],equipmentPreset:[{ref:t.id+'~0',hand:'main'}],ai:{mode:'auto'}});
  training(s,'1');const b=B.createBattle(s,'channel','GM','自动战斗'),player=B.join(s,b,'1'),a=B.addNPC(s,b,npc.id,'enemy');B.position(b,a.id,25,25);B.start(s,b,null,minRng);
  b.current={id:'npc-turn',actorId:a.id,quick:1,formal:1,move:18,moveSpent:0};return {s,b,a,player,t,npc};
}
test('NPC automatic action preserves the player defense and respects a manual toggle',()=>{
  const {s,b,a}=automaticFight();AI.step(s,b,minRng);assert.equal(b.current.quick,0);AI.step(s,b,minRng);assert.ok(b.pending);assert.equal(b.pending.targetId,b.actors[0].id);
  const frozen=C.clone(b.pending),hp=s.players['1'].hp;assert.equal(AI.step(s,b,minRng),false);assert.equal(s.players['1'].hp,hp);assert.deepEqual(b.pending,frozen);
  B.defend(s,b,b.pending.id,'defend',minRng);a.ai.mode='manual';assert.equal(AI.step(s,b,minRng),false);
});
test('NPC automatic defense chooses configured probability and does not spend an action',()=>{
  const {s,b,a,player}=automaticFight();b.current={id:'player-turn',actorId:player.id,quick:1,formal:1,move:18};B.attack(s,b,b.current.id,s.players['1'].equipped.weapon,a.id,'formal',minRng);
  a.ai.weights=C.clone(AI.DEFAULTS);a.ai.weights.defense={defend:0,dodge:0,both:0,none:100};AI.step(s,b,minRng);assert.equal(b.pending,null);assert.equal(b.current.quick,1);assert.equal(b.history.at(-1).details.choice,'none');
});
test('NPC probability validation preserves decimals, rejects totals and ignores unavailable attacks',()=>{
  assert.throws(()=>AI.validate({weights:{quick:{pass:99},formal:{pass:100},defense:{defend:100}}}),/100/);
  const weights={quick:{pass:100},formal:{'attack:missing':99,'attack:*':1},defense:{defend:33.33,dodge:66.67}};
  assert.equal(AI.validate({weights}).weights.defense.dodge,66.67);const {s,b,a}=automaticFight();a.ai.weights=weights;AI.step(s,b,minRng);AI.step(s,b,minRng);assert.ok(b.pending);
});
test('NPC targeting selects lowest HP and no preview changes live resources or random results',()=>{
  const {s,b,a}=automaticFight({melee:false});training(s,'2');b.status='paused';b.actors.push({id:'low',userId:'2',characterId:s.players['2'].id,name:'低血角色',team:'ally',x:25,y:25});s.players['2'].hp=2;b.status='active';a.ai.target='lowest';
  const before=JSON.stringify(s);AI.options(s,b,a);assert.equal(JSON.stringify(s),before);AI.step(s,b,minRng);AI.step(s,b,minRng);assert.equal(b.pending.targetId,'low');
});
test('automatic NPC routes around walls and pauses if its step limit is exceeded',()=>{
  const {s,b,a,player}=automaticFight();a.x=25;a.y=25;player.x=125;player.y=25;b.terrain['1,0']='blocked';const move=AI.approach(b,a,player,18);assert.ok(move.y>25);assert.ok(B.movementCost(b,a,move)<=18);
  a.aiTurn=b.current.id;a.aiSteps=64;AI.step(s,b,minRng);assert.equal(b.status,'paused');assert.match(b.pauseReason,/64/);
});
test('NPC explicit equipment is independent of inventory order and duplicate instances have unique IDs',()=>{
  const s=state(),first=weapon(s),second=weapon(s,{name:'第二把'}),t=npcTemplate(s,{itemIds:[first.id,second.id],equipmentPreset:[{ref:first.id+'~0',hand:'main'}]});
  const b=B.createBattle(s,'channel','GM','装备'),one=B.addNPC(s,b,t.id,'enemy'),two=B.addNPC(s,b,t.id,'enemy');assert.equal(one.character.inventory[one.character.equipped.weapon].templateId,first.id);
  assert.notEqual(one.character.equipped.weapon,two.character.equipped.weapon);assert.equal(Object.values(one.character.inventory).length,2);
  t.equipmentPreset=[];assert.ok(one.character.equipped.weapon);assert.throws(()=>B.validateNPC(s,{...t,equipmentPreset:[{ref:'missing',hand:'main'}]}),/预设装备/);
});
test('team movement saves votes and moves all participants only on the last confirmation',()=>{
  const {s,m}=mapFixture();X.join(s,m,'1');X.join(s,m,'2');const r=Team.propose(s,m,'1','1,0');assert.equal(m.participants['1'].cell,'0,0');assert.deepEqual(r.yes,['1']);
  const restored=C.clone(s),live=restored.explorations[m.id];Team.vote(restored,live,r.id,'2',true);assert.equal(live.participants['1'].cell,'1,0');assert.equal(live.participants['2'].cell,'1,0');assert.throws(()=>Team.vote(restored,live,r.id,'2',true),/结束/);
});
test('team movement rejects split teams, duplicates, outsiders, overloading, refusal and expiration',()=>{
  const {s,m}=mapFixture();X.join(s,m,'1');X.join(s,m,'2');const r=Team.propose(s,m,'1','1,0');assert.throws(()=>Team.propose(s,m,'2','1,0'),/已有/);assert.throws(()=>Team.vote(s,m,r.id,'3',true),/有效角色/);
  Team.vote(s,m,r.id,'2',false);assert.equal(m.participants['1'].cell,'0,0');const again=Team.propose(s,m,'1','1,0');Team.expire(s,m,again.expiresAt);assert.equal(m.moves[again.id].status,'expired');
  m.participants['2'].cell='1,0';assert.throws(()=>Team.propose(s,m,'1','1,0'),/同一格/);m.participants['2'].cell='0,0';s.players['2'].inventory.heavy={id:'heavy',quantity:1,snapshot:{weight:999999}};assert.throws(()=>Team.propose(s,m,'1','1,0'),/超重/);
});
test('team movement invalidates membership, character, pause and layout changes',()=>{
  for(const change of [(s,m)=>delete m.participants['2'],(s)=>s.players['2'].id='new',(s,m)=>m.status='paused',(s,m)=>m.cells['1,0'].type='wall']){
    const {s,m}=mapFixture();X.join(s,m,'1');X.join(s,m,'2');const r=Team.propose(s,m,'1','1,0');change(s,m);Team.expire(s,m);assert.equal(m.moves[r.id].status,'cancelled');assert.equal(m.participants['1'].cell,'0,0');
  }
});
test('one shared locked door consumes one charge and failed final checks consume nothing',()=>{
  const s=state(),key=M.publishTemplate(s,{kind:'钥匙',name:'实验室钥匙',rarity:'white',weightKg:0,keyCharges:2}),{m}=mapFixture(s,{keyIds:[key.id]});X.join(s,m,'1');X.join(s,m,'2');for(const uid of ['1','2'])X.move(s,m,uid,'1,0');
  const item=M.issue(s,'1',key.id)[0],r=Team.propose(s,m,'1','2,0',item.id);assert.equal(item.keyCharges,2);Team.vote(s,m,r.id,'2',true);assert.equal(item.keyCharges,1);assert.equal(m.participants['2'].cell,'2,0');
});
test('automatic encounters preserve the capacity, continue waves and unlock only on victory',()=>{
  const s=state(),npc=npcTemplate(s),{m}=mapFixture(s,{npcIds:[npc.id]});
  // Use an explicit larger frozen encounter to cover overflow independent of room probability validation.
  m.cells['2,0'].room.remainingNpcs=[{template:C.clone(npc),quantity:22}];X.join(s,m,'1');m.participants['1'].cell='2,0';m.revealed['2,0']=true;
  let changed=Team.autoEncounters(s);const first=s.battles[changed.battles[0]];assert.equal(first.actors.length,20);assert.equal(m.cells['2,0'].room.remainingNpcs[0].quantity,3);
  for(const a of first.actors.filter(a=>!a.userId)){a.character.hp=0;require('../src/rpg/mortality').settle(s,first,a,first.actors[0].id);}
  changed=Team.autoEncounters(s);const second=s.battles[changed.battles.at(-1)];assert.equal(first.status,'ended');assert.equal(second.actors.length,4);assert.equal(m.cells['2,0'].room.encounter,'battle');
  for(const a of second.actors.filter(a=>!a.userId)){a.character.hp=0;require('../src/rpg/mortality').settle(s,second,a,second.actors[0].id);}Team.autoEncounters(s);assert.equal(m.cells['2,0'].room.encounter,'resolved');
});
test('automatic encounter configuration failure pauses without leaving partial actors or consuming the roster',()=>{
  const s=state(),npc=npcTemplate(s),{m}=mapFixture(s,{npcIds:[npc.id]});X.join(s,m,'1');m.participants['1'].cell='2,0';m.revealed['2,0']=true;m.cells['2,0'].room.snapshot.spawn.npcX=9999;
  const before=JSON.stringify(m.cells['2,0'].room.remainingNpcs);Team.autoEncounters(s);assert.equal(m.status,'paused');assert.equal(Object.keys(s.battles).length,0);assert.equal(JSON.stringify(m.cells['2,0'].room.remainingNpcs),before);
});
test('magazines store mixed supported ammunition, keep weight once and reject filling inserted magazines',()=>{
  const s=state(),{gun,ammo,mag}=gunFixture(s),other=M.publishTemplate(s,{...ammo,name:'第二弹种',damage:{physical:'4'}});mag.ammoIds=[ammo.id,other.id];gun.ammoIds=[ammo.id,other.id];gun.initialMagazine=C.clone(mag);
  const w=M.issue(s,'1',gun.id)[0],p=s.players['1'];M.equip(s,'1',w.id);const m=p.inventory[w.magazineId];AM.normalize(p);m.loaded.rounds=[];m.loaded.current=0;
  const base=M.weight(p),a=M.issue(s,'1',ammo.id,2)[0],o=M.issue(s,'1',other.id,2)[0];assert.throws(()=>AM.fill(p,m.id,a.id),/抽出/);AM.swap(p,w.id,null);AM.fill(p,m.id,a.id,2);AM.fill(p,m.id,o.id,2);assert.equal(M.weight(p),base+4);AM.swap(p,w.id,m.id);assert.equal(M.weight(p),base+4);
  assert.equal(w.loaded.rounds[2].template.id,other.id);
});
test('battle magazine extraction, filling and replacement each spend one quick action',()=>{
  const s=state(),{gun,ammo}=gunFixture(s),w=M.issue(s,'1',gun.id)[0];M.equip(s,'1',w.id);const p=s.players['1'],clip=w.magazineId;AM.normalize(p);w.loaded.rounds=[];w.loaded.current=0;const rounds=M.issue(s,'1',ammo.id,4)[0],{b}=fight(s);
  AM.battleOperation(s,b,b.current.id,{type:'extract',weapon:w.id});assert.equal(b.current.quick,0);assert.throws(()=>AM.battleOperation(s,b,b.current.id,{type:'fill',magazine:clip,ammo:rounds.id}),/快速/);
  const owner=b.current.actorId;const again=()=>{B.finish(s,b,b.current.id,minRng);while(b.current.actorId!==owner)B.finish(s,b,b.current.id,minRng);};again();AM.battleOperation(s,b,b.current.id,{type:'fill',magazine:clip,ammo:rounds.id});assert.equal(b.current.quick,0);again();AM.battleOperation(s,b,b.current.id,{type:'swap',weapon:w.id,magazine:clip});assert.equal(b.current.quick,0);assert.equal(w.loaded.current,4);
});
test('multiple compatible clips and ammunition validate and unsupported rounds reject before replacement',()=>{
  const s=state(),{gun,ammo,mag}=gunFixture(s),ammo2=M.publishTemplate(s,{...ammo,name:'第二种'}),mag2=M.publishTemplate(s,{...mag,name:'大弹夹',capacity:8,ammoIds:[ammo.id,ammo2.id]});
  const t=M.publishTemplate(s,{...gun,ammoIds:[ammo.id,ammo2.id],magazineIds:[mag.id,mag2.id]}),w=M.issue(s,'1',t.id)[0],m=M.issue(s,'1',mag2.id)[0],a=M.issue(s,'1',ammo2.id,8)[0],p=s.players['1'];AM.fill(p,m.id,a.id);AM.swap(p,w.id,m.id);assert.equal(w.loaded.capacity,8);
  const incompatible=M.publishTemplate(s,{...ammo,name:'错误弹种'}),bad=M.issue(s,'1',incompatible.id)[0];AM.swap(p,w.id,null);assert.throws(()=>AM.fill(p,m.id,bad.id),/不兼容/);assert.equal(m.loaded.current,8);
});
test('NPC empty magazines prefer a filled spare, then use the same extract-fill-insert sequence',()=>{
  const s=state(),{gun,ammo,mag}=gunFixture(s,{current:0}),t=npcTemplate(s,{hpMax:100,itemIds:[gun.id,mag.id,ammo.id],quantities:{[ammo.id]:8},equipmentPreset:[{ref:gun.id+'~0',hand:'main'}],ai:{mode:'auto'}}),b=B.createBattle(s,'channel','GM','NPC换弹');B.join(s,b,'1');const a=B.addNPC(s,b,t.id,'enemy'),p=a.character;B.position(b,a.id,25,25);B.start(s,b,null,minRng);b.current={id:'reload1',actorId:a.id,quick:1,formal:1,move:0};
  const spare=Object.values(p.inventory).find(i=>i.templateId===mag.id&&!AM.attached(p,i.id)),rounds=Object.values(p.inventory).find(i=>i.templateId===ammo.id);AM.fill(p,spare.id,rounds.id,4);AI.step(s,b,minRng);assert.equal(p.inventory[p.equipped.weapon].magazineId,spare.id);assert.equal(b.current.quick,0);
});
test('legacy magazine rounds migrate once, preserve damage and restart does not refill',()=>{
  const s=state(),{gun}=gunFixture(s),w=M.issue(s,'1',gun.id)[0],p=s.players['1'],m=p.inventory[w.magazineId];delete m.loaded;delete w.magazineStorage;w.loaded.current=2;w.loaded.rounds=w.loaded.rounds.slice(0,2);const before=M.itemWeight(w)+M.itemWeight(m);
  AM.migrate(s);assert.equal(m.loaded.current,2);assert.equal(M.weight(p),before);const copy=C.clone(s);assert.equal(AM.migrate(copy),false);AM.normalize(copy.players['1']);assert.equal(copy.players['1'].inventory[w.magazineId].loaded.current,2);
});
test('crossbows use compatible arrow magazines rather than loose arrows',()=>{
  const s=state(),arrow=M.publishTemplate(s,{kind:'弹药',name:'弩箭',rarity:'white',weightKg:.02}),mag=M.publishTemplate(s,{kind:'弹夹',name:'弩箭匣',rarity:'white',weightKg:.1,capacity:3,ammoIds:[arrow.id]}),bow=weapon(s,{weaponType:'弩',ammoIds:[arrow.id],magazineIds:[mag.id],capacity:3,current:1}),w=M.issue(s,'1',bow.id)[0];M.equip(s,'1',w.id);const {b}=fight(s);B.attack(s,b,b.current.id,w.id,b.actors[1].id,'formal',minRng);assert.equal(w.loaded.current,0);assert.equal(b.pending.ammoEmpty,true);
});
test('NPC equipment panel is a three-level filtered selector and saves a template preset',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'npc-panel-setup','GM',s=>{const w=weapon(s),f=F.create(s,'GM','npc');f.data.name='装备守卫';f.data.itemIds=[w.id,Object.keys(s.catalog)[0]];return f.id;});
    const i=h.interaction('GM',null,{},'rpg:npcui:f:'+ref+':_:home');await rpg.handle(i);validateMessage(i.result);const gear=await click(h,rpg,'GM',i,'装备槽位'),category=await click(h,rpg,'GM',gear,'装备随身物品'),kind=await click(h,rpg,'GM',category,'装备大类',['武器']),items=await click(h,rpg,'GM',kind,'具体类型',['剑']);
    const choices=jsonComponents(items.result).find(c=>c.options).options;assert.equal(choices.length,1);const hand=await click(h,rpg,'GM',items,'选择已有物品',[choices[0].value]);const saved=await click(h,rpg,'GM',hand,'持握位置',['main']);validateMessage(saved.result);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[ref].data.equipmentPreset.length,1);
  }finally{rpg.stop();}
});
test('NPC probability wizard requires explicit validated save and restricts GM access',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'npc-config','GM',s=>{const f=F.create(s,'GM','npc');f.data.name='配置守卫';return f.id;});const open=h.interaction('GM',null,{},'rpg:npcui:f:'+ref+':_:home');await rpg.handle(open);
    const mode=await click(h,rpg,'GM',open,'选择控制方式',['auto']);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).forms[ref].data.ai.mode,'auto');const weights=await click(h,rpg,'GM',mode,'操作概率'),op=await click(h,rpg,'GM',weights,'选择操作，再填写概率',['0']),edit=await click(h,rpg,'GM',op,'填写概率');assert.ok(edit.modal);
    const modal=h.interaction('GM',null,{},edit.modal.toJSON().custom_id,[],{value:'99'});await rpg.handle(modal);const bad=await click(h,rpg,'GM',modal,'保存全部概率');assert.match(bad.result.content,/100/);
    const denied=h.interaction('1',null,{},'rpg:npcui:f:'+ref+':_:home');await rpg.handle(denied);assert.match(denied.result.content,/GM/);
  }finally{rpg.stop();}
});
test('public exploration request really mentions the roster, remains private on clicks and updates after all approve',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'team-map','GM',s=>{const {m}=mapFixture(s);X.join(s,m,'1');X.join(s,m,'2');return m.id;});const i=h.interaction('1',null,{},'rpg:map:move:'+ref+':1,0');await rpg.handle(i);
    const m=rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[ref],r=m.moves[m.moveRequestId],message=h.messages.get(r.messageId);assert.deepEqual(message.lastPayload.allowedMentions.users,['1','2']);assert.match(message.content,/<@2>/);
    const approve=h.interaction('2',null,{},'rpg:map:movevote:'+ref+':'+r.id+':yes');await rpg.handle(approve);validateMessage(approve.result);assert.equal(approve.deferOptions.flags,D.MessageFlags.Ephemeral);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).explorations[ref].participants['1'].cell,'1,0');
    const before=h.sent.length;await rpg.exploration.publishMove(C.DEFAULT_GUILD_ID,ref,r.id);assert.equal(h.sent.length,before);
  }finally{rpg.stop();}
});
test('ordinary ammunition panel fills an extracted magazine and refuses another owner',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);try{
    const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'ammo-panel','GM',s=>{const {mag,ammo}=gunFixture(s);M.issue(s,'1',ammo.id,4);return M.issue(s,'1',mag.id)[0].id;});const open=h.interaction('1','弹药管理');await rpg.handle(open);
    const clips=await click(h,rpg,'1',open,'向抽出的弹夹填弹'),rounds=await click(h,rpg,'1',clips,'选择一项',[ref]),option=jsonComponents(rounds.result).find(c=>c.options).options[0],preview=await click(h,rpg,'1',rounds,'选择一项',[option.value]),done=await click(h,rpg,'1',preview,'确认');validateMessage(done.result);assert.equal(rpg.store.snapshot(C.DEFAULT_GUILD_ID).players['1'].inventory[ref].loaded.current,4);
    const denied=h.interaction('2',null,{},'rpg:ammo:p:1:_:home');await rpg.handle(denied);assert.match(denied.result.content,/自己/);
  }finally{rpg.stop();}
});
test('rendered exploration and battle maps are valid PNGs and all new panels obey Discord limits',()=>{
  const {s,b}=automaticFight(),maps=require('../src/rpg/map-image'),{m}=mapFixture(s),battle=U.battleView(s,b),board=XU.board(m);validateMessage(battle);validateMessage(board);
  for(const data of [maps.battle(s,b),maps.exploration(m),maps.exploration(m,false,0)]){assert.deepEqual([...data.slice(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(data.length<4*1024*1024);}
  const r=Team.propose(s,m,(()=>{X.join(s,m,'2');return '2';})(),'1,0');validateMessage(XU.moveCard(m,r));assert.match(battle.embeds[0].toJSON().image.url,/attachment:\/\//);
});
test('saved automatic combat resumes a step without repeating attacks or losing pending defense on restart',async()=>{
  const h=harness(),rpg=createRpg(h.deps);await setupUpgrade(h,rpg);let restored;
  try{const ref=await rpg.store.transact(C.DEFAULT_GUILD_ID,'auto-runtime','GM',s=>{const sample=automaticFight();s.players=sample.s.players;s.catalog=sample.s.catalog;s.npcTemplates=sample.s.npcTemplates;s.battles=sample.s.battles;return sample.b.id;});
    await rpg.tickGuild(C.DEFAULT_GUILD_ID);await rpg.tickGuild(C.DEFAULT_GUILD_ID);const saved=rpg.store.snapshot(C.DEFAULT_GUILD_ID).battles[ref];assert.ok(saved.pending);const pending=C.clone(saved.pending),seq=saved.aiSequence;
    const notices=h.sent.filter(m=>m.lastPayload.allowedMentions?.users?.includes('1')&&m.content?.includes('受到NPC攻击'));assert.equal(notices.length,1);rpg.stop();restored=createRpg(h.deps);await restored.start();
    const after=restored.store.snapshot(C.DEFAULT_GUILD_ID).battles[ref];assert.deepEqual(after.pending,pending);assert.equal(after.aiSequence,seq);assert.equal(h.sent.filter(m=>m.content?.includes('受到NPC攻击')).length,1);
    const home=h.interaction('1',null,{},'rpg:ammo:b:'+ref+':'+after.actors[0].id+':home');await restored.handle(home);const ret=await click(h,restored,'1',home,'返回装备 / 行动');validateMessage(ret.result);assert.ok(ret.result.embeds?.length);
  }finally{rpg.stop();restored?.stop();}
});

test('NPC without a spare magazine extracts, fills and reinstalls across distinct opportunities',()=>{
  const s=state(),{gun,ammo}=gunFixture(s),t=npcTemplate(s,{itemIds:[gun.id,ammo.id],quantities:{[ammo.id]:4},equipmentPreset:[{ref:gun.id+'~0',hand:'main'}],ai:{mode:'auto'}}),b=B.createBattle(s,'channel','GM','补弹');training(s,'1');B.join(s,b,'1');const a=B.addNPC(s,b,t.id,'enemy');B.position(b,a.id,25,25);B.start(s,b,null,minRng);const p=a.character,w=p.inventory[p.equipped.weapon],mag=w.magazineId;AM.normalize(p);w.loaded.rounds=[];w.loaded.current=0;
  for(let n=0;n<3;n++){b.current={id:'reload-turn-'+n,actorId:a.id,quick:1,formal:1,move:0};AI.step(s,b,minRng);assert.equal(b.current.quick,0);if(n===0)assert.equal(w.magazineId,undefined);if(n===1)assert.equal(p.inventory[mag].loaded.current,4);}
  assert.equal(w.magazineId,mag);assert.equal(w.loaded.current,4);assert.equal(b.aiSequence,3);
});

test('multiple ammo selection chooses an initial round actually compatible with the first magazine',()=>{
  const s=state(),{gun,ammo,mag}=gunFixture(s),other=M.publishTemplate(s,{...ammo,id:undefined,name:'不同初始弹种'}),clip=M.publishTemplate(s,{...mag,id:undefined,name:'第二弹夹',ammoIds:[other.id]});
  const w=M.publishTemplate(s,{...gun,id:undefined,ammoIds:[ammo.id,other.id],magazineIds:[clip.id,mag.id]});assert.equal(w.initialAmmo.id,other.id);assert.equal(w.initialMagazine.id,clip.id);
});

test('NPC draft equipment can be corrected after removing a preset inventory item',()=>{
  const s=state(),w=weapon(s),data={...F.defaults('npc'),itemIds:[],equipmentPreset:[{ref:w.id+'~0',hand:'main'}]};const p=require('../src/rpg/npc-equipment').create(data,s.catalog,true);assert.equal(M.equippedIds(p).length,0);assert.throws(()=>require('../src/rpg/npc-equipment').create(data,s.catalog),/预设装备/);
});
