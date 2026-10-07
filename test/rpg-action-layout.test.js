'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../src/rpg/constants'), M = require('../src/rpg/model'), B = require('../src/rpg/combat');
const F = require('../src/rpg/forms'), X = require('../src/rpg/exploration'), Team = require('../src/rpg/team-movement');
const Layout = require('../src/rpg/encounter-layout'), Upgrade = require('../src/rpg/action-rules-upgrade');
const { state, harness, fight, minRng } = require('./helpers/rpg-harness');
function seeded(seed) { let z = seed; return (min, max) => { z = (Math.imul(z, 1664525) + 1013904223) >>> 0; return min + z % (max - min); }; }
function npc(s) {
  const t = B.validateNPC(s, { ...F.defaults('npc'), name: '障碍测试守卫', hpMax: 100 });
  t.id = C.id('t'); t.version = 1; t.published = true; s.npcTemplates[t.id] = t; return t;
}
function fixture(s = state(), extra = {}) {
  const t = npc(s), cf = F.create(s, 'GM', 'mapcategory'); cf.data.name = '测试建筑'; const cat = F.publish(s, cf);
  const rf = F.create(s, 'GM', 'room'); Object.assign(rf.data, { name: '测试办公室', categoryIds: [cat.id], npcIds: [t.id], ...extra });
  const room = F.publish(s, rf), m = X.create(s, 'GM', 'channel', '测试探索', 1, 3, 'random', cat.id);
  X.generate(s, m, seeded(5)); X.publish(s, m); X.join(s, m, '1'); m.participants['1'].cell = '2,0'; m.revealed['2,0'] = true;
  return { s, m, room, t, r: m.cells['2,0'].room };
}
test('paid opportunities double independently, preserve AP, and reset only after everyone finishes', () => {
  const { s, b } = fight(), a = b.actors[0], other = b.actors[1];
  s.players['1'].ap = 1500; s.players['2'].ap = 0;
  const costs = [b.current.apCost];
  for (const [cost, remaining] of [[200, 1300], [400, 900], [800, 100]]) {
    B.finish(s, b, b.current.id, minRng);
    assert.equal(b.current.actorId, a.id); assert.equal(b.current.apCost, cost); assert.equal(s.players['1'].ap, remaining); costs.push(cost);
  }
  assert.deepEqual(costs, [100, 200, 400, 800]); assert.equal(B.opportunityCost(b, a.id), 1600); assert.equal(b.actionRound.number, 1);
  B.finish(s, b, b.current.id, minRng); assert.equal(b.current.actorId, other.id); assert.equal(b.current.apCost, 100);
  assert.equal(b.actionRound.number, 1, 'last actor must finish, merely receiving a turn does not reset');
  const retained = s.players['1'].ap; B.finish(s, b, b.current.id, minRng);
  assert.equal(b.actionRound.number, 2); assert.equal(b.current.actorId, a.id); assert.equal(b.current.apCost, 100); assert.equal(s.players['1'].ap, retained - 100);
  assert.ok(b.history.some(e => e.details?.apCost === 800));
});
test('moves and free defenses cannot charge AP again within an opportunity', () => {
  const { s, b } = fight(), a = b.current.actorId, turn = b.current.id, before = s.players['1'].ap;
  B.move(s, b, turn, 26, 25); B.move(s, b, turn, 27, 25);
  B.attack(s, b, turn, s.players['1'].equipped.weapon, b.actors[1].id, 'formal', minRng);
  assert.throws(() => B.finish(s, b, turn), /待响应/);
  B.defend(s, b, b.pending.id, 'defend', minRng);
  assert.equal(s.players['1'].ap, before); assert.equal(b.actionRound.counts[a], 1); assert.equal(b.actionRound.completed.length, 0);
});
test('AOE targets resolve independently without charging another opportunity or resetting early', () => {
  const { s, b } = fight(), SK = require('../src/rpg/skills'), AO = require('../src/rpg/aoe');
  B.pause(b); const a = B.addNPC(s, b, npc(s).id, 'enemy'), c = B.addNPC(s, b, npc(s).id, 'enemy');
  a.x = 25; a.y = 25; c.x = 40; c.y = 25; B.pause(b, true);
  const t = SK.publish(s, { ...F.defaults('skill'), name: '轮次范围测试', rangeMeters: 100, damage: { physical: '1' }, aoe: { mode: 'selective', radius: 25 } }), ability = SK.grant(s.players['1'], t);
  const area = AO.preview(s, b, b.actors[0], t, { x: 25, y: 25 });
  B.attack(s, b, b.current.id, ability.id, a.id, 'formal', minRng, { aoe: area }); const hits = AO.hits(b).map(h => h.id), ap = s.players['1'].ap;
  assert.equal(hits.length, 2); B.defend(s, b, hits[0], 'defend', minRng); assert.ok(b.pending); assert.throws(() => B.finish(s, b, b.current.id), /待响应/);
  B.defend(s, b, hits[1], 'defend', minRng); assert.equal(b.pending, null); assert.equal(s.players['1'].ap, ap); assert.equal(b.actionRound.counts[b.actors[0].id], 1); assert.equal(b.actionRound.number, 1);
});
test('free surprise actions are outside the paid round and single actor rounds reset every completion', () => {
  const s = state(), b = B.createBattle(s, 'c', 'GM', '偷袭'); B.join(s, b, '1'); B.join(s, b, '2'); B.start(s, b, 'ally', minRng);
  assert.equal(b.current.apCost, 0); B.finish(s, b, b.current.id, minRng); assert.equal(b.current.free, true); assert.deepEqual(b.actionRound.counts, {});
  B.finish(s, b, b.current.id, minRng); assert.equal(b.current.apCost, 100); assert.equal(b.actionRound.number, 1);
  const solo = B.createBattle(s, 'solo', 'GM', '单人'); B.join(s, solo, '3'); B.start(s, solo, null, minRng);
  for (let n = 2; n <= 4; n++) { B.finish(s, solo, solo.current.id, minRng); assert.equal(solo.actionRound.number, n); assert.equal(solo.current.apCost, 100); }
});
test('dead, fleeing and GM removed members stop blocking round completion', () => {
  for (const mode of ['death', 'flee', 'remove']) {
    const { s, b } = fight(), a = b.actors[0], other = b.actors[1]; s.players['1'].ap = 0; s.players['2'].ap = 100;
    B.finish(s, b, b.current.id, minRng); assert.equal(b.current.actorId, other.id);
    if (mode === 'death') { s.players['2'].hp = 0; require('../src/rpg/mortality').settle(s, b, other); B.nextOpportunity(s, b, minRng); }
    else if (mode === 'flee') B.flee(s, b, b.current.id, minRng);
    else { B.pause(b); b.actors = b.actors.filter(x => x.id !== other.id); b.current = null; B.pause(b, true); B.nextOpportunity(s, b, minRng); }
    assert.equal(b.actionRound.number, 2, mode); assert.equal(b.current.actorId, a.id); assert.equal(b.current.apCost, 100);
  }
});
test('a NPC added while paused must finish once, while resume retains the paid opportunity', () => {
  const { s, b } = fight(); s.players['1'].ap = 0; s.players['2'].ap = 100; B.finish(s, b, b.current.id, minRng);
  const turn = b.current.id, ap = s.players['2'].ap; B.pause(b); const added = B.addNPC(s, b, npc(s).id, 'enemy'); added.character.ap = 100;
  B.pause(b, true); B.nextOpportunity(s, b, minRng); assert.equal(b.current.id, turn); assert.equal(s.players['2'].ap, ap);
  B.finish(s, b, turn, minRng); assert.equal(b.actionRound.number, 1); assert.equal(b.current.actorId, added.id); assert.equal(b.current.apCost, 100);
  B.finish(s, b, b.current.id, minRng); assert.equal(b.actionRound.number, 2);
});
test('an unaffordable exponential cost waits for reset without overflow or discount', () => {
  const { s, b } = fight(); b.actionRound.counts[b.actors[0].id] = 34; b.actionRound.completed = [b.actors[0].id]; b.current = null; b.queue = [];
  s.players['1'].ap = C.MAX_MONEY - 1000; s.players['2'].ap = 100;
  assert.equal(B.opportunityCost(b, b.actors[0].id), Infinity); B.nextOpportunity(s, b, minRng); assert.equal(b.current.actorId, b.actors[1].id);
  B.finish(s, b, b.current.id, minRng); assert.equal(b.current.apCost, 100); assert.equal(b.actionRound.number, 2);
});
test('layout covers every dimension boundary, room obstacle pool, quantity cap and connectivity', () => {
  for (const width of [2, 3]) for (const height of [2, 3, 4]) for (let seed = 0; seed < 30; seed++) {
    let draws = 0; const random = seeded(seed), rng = (min, max) => ++draws === 1 ? width : draws === 2 ? height : random(min, max);
    const layout = Layout.generate({ id: 'room_seed_0' }, rng);
    assert.equal(layout.width, width); assert.equal(layout.height, height); assert.ok(layout.actual >= 1 && layout.actual <= Math.min(3, Math.floor(width * height / 4)));
    assert.equal(Layout.connected(width, height, layout.terrain), true); assert.ok(layout.obstacles.every(o => ['货架', '收银台'].includes(o.name)));
    assert.equal(new Set(layout.obstacles.map(o => o.cell)).size, layout.actual);
  }
  assert.equal(Layout.generate({ obstacles: { names: '空地', min: 0, max: 0 } }, minRng).actual, 0);
  const difficult = Layout.generate({ obstacles: { names: '积水', terrain: 'difficult' } }, minRng); assert.equal(difficult.obstacles[0].terrain, 'difficult');
  assert.throws(() => Layout.validate({ names: '桌子', min: 3, max: 2 }), /最多障碍/); assert.throws(() => Layout.validate({ names: '桌子', terrain: 'none' }), /障碍地形/);
  assert.throws(() => Layout.validateLayout({ version: 1, width: 4, height: 4, terrain: {} }), /战场列数/);
});
test('twenty participants fit a small random arena with unique safe positions', () => {
  const { s, m, r } = fixture(); r.remainingNpcs[0].quantity = 19; const b = X.encounter(s, m, '2,0', ['1'], minRng);
  assert.equal(b.actors.length, 20); assert.equal(b.width, 2); assert.equal(b.height, 2);
  const coordinates = new Set(); for (const a of b.actors) { coordinates.add(a.x + ',' + a.y); assert.ok(a.x > 0 && a.x < b.width * 50 && a.y > 0 && a.y < b.height * 50); assert.notEqual(b.terrain[Math.floor(a.x / 50) + ',' + Math.floor(a.y / 50)], 'blocked'); }
  assert.equal(coordinates.size, 20); assert.equal(b.encounterSpawns.length, 20); assert.ok(new Set(b.actors.map(a => Math.floor(a.x / 50) + ',' + Math.floor(a.y / 50))).size > 1);
});
test('subsequent encounter batches reuse frozen terrain and template edits cannot reroll it', () => {
  const { s, m, r, room } = fixture(); r.remainingNpcs[0].quantity = 22; const first = X.encounter(s, m, '2,0', ['1'], seeded(8)), layout = C.clone(r.tacticalLayout);
  B.endBattle(s, first); X.resolve(s, m, '2,0'); room.obstacles = { names: '改后的障碍', min: 0, max: 0, terrain: 'difficult' };
  const second = X.encounter(s, m, '2,0', ['1'], seeded(90)); assert.equal(second.actors.length, 4); assert.deepEqual(r.tacticalLayout, layout); assert.deepEqual(second.terrain, first.terrain);
  assert.equal(second.width, first.width); assert.equal(second.height, first.height); assert.deepEqual(second.roomObstacles, first.roomObstacles);
});
test('automatic and GM encounter paths share saved layout and ignore obsolete fixed spawn coordinates', () => {
  const { s, m, r } = fixture(); r.snapshot.spawn.npcX = 9999; r.tacticalLayout = Layout.generate({ id: 'room_seed_4' }, seeded(12));
  const copy = C.clone(s), manual = X.encounter(copy, copy.explorations[m.id], '2,0', ['1'], seeded(2));
  const changed = Team.autoEncounters(s), automatic = s.battles[changed.battles[0]];
  assert.ok(automatic); assert.equal(automatic.status, 'active'); assert.deepEqual(automatic.terrain, manual.terrain); assert.deepEqual(automatic.roomObstacles, manual.roomObstacles);
  assert.equal(automatic.width, manual.width); assert.equal(automatic.height, manual.height); assert.ok(automatic.actors.every(a => a.x < automatic.width * 50));
});
test('layout failure rolls back automatic encounter without consuming the frozen NPC roster', () => {
  const { s, m, r } = fixture(); r.tacticalLayout = { version: 1, width: 2, height: 2, terrain: { '0,0': 'blocked', '1,1': 'blocked' } };
  const before = JSON.stringify(r.remainingNpcs); Team.autoEncounters(s); assert.equal(m.status, 'paused'); assert.equal(Object.keys(s.battles).length, 0); assert.equal(JSON.stringify(m.cells['2,0'].room.remainingNpcs), before);
});
test('room editing and variant overrides validate and expose obstacles without fixed spawn controls', () => {
  const { s, room } = fixture(), f = F.create(s, 'GM', 'room', null, room.id);
  const fields = F.fields(f); assert.ok(fields.some(d => d.key === 'obstacles.names')); assert.ok(!fields.some(d => d.key.startsWith('spawn.')));
  f.data.variants[0].overrides.obstacles = { names: '焦黑桌柜', min: 0, max: 1, terrain: 'difficult' };
  const validated = X.validateRoom(s, f.data), instance = X.instantiate(s, validated, seeded(99), 10, f.data.variants[0].id);
  assert.equal(instance.snapshot.obstacles.names, '焦黑桌柜'); assert.equal(instance.snapshot.obstacles.terrain, 'difficult');
});
test('legacy upgrade preserves paid AP, pending attacks and started room layouts, and is idempotent', () => {
  const { s, m, r } = fixture(), { b } = fight(s); s.upgrade = 5; delete b.actionRound; delete b.current.roundNumber; delete b.current.opportunity; delete b.current.apCost;
  b.pending = { id: 'saved-attack', targetId: b.actors[1].id }; r.battleId = b.id; r.encounter = 'battle';
  const ap = s.players['1'].ap, pending = JSON.stringify(b.pending); const ended = B.createBattle(s, 'ended', 'GM', '历史'); ended.status = 'ended'; delete ended.actionRound; const history = JSON.stringify(ended);
  const report = Upgrade.migrate(s); assert.equal(report.preservedEncounterLayouts, 1); assert.equal(s.upgrade, 6); assert.equal(s.players['1'].ap, ap); assert.equal(JSON.stringify(b.pending), pending);
  assert.equal(b.current.apCost, 100); assert.equal(B.opportunityCost(b, b.current.actorId), 200); assert.equal(r.tacticalLayout.width, 10); assert.equal(r.tacticalLayout.legacy, true); assert.equal(JSON.stringify(ended), history);
  assert.equal(Upgrade.migrate(s), null); assert.equal(s.players['1'].ap, ap); assert.equal(m.cells['2,0'].room.battleId, b.id);
});
test('durable duplicate receipts and restart preserve AP charges and random layout without another draw', async () => {
  const { s, m } = fixture(), h = harness(); let saved = C.clone(s); h.deps.database = { assertLease() {}, load: async () => C.clone(saved), save: async (_, before, next) => { assert.equal(saved.revision, before.revision); saved = C.clone(next); } };
  const store = require('../src/rpg/store').createStore(h.deps); await store.load(s.guildId); let draws = 0; const random = seeded(22);
  const make = () => store.transact(s.guildId, 'one-encounter', 'GM', st => { const b = X.encounter(st, st.explorations[m.id], '2,0', ['1'], (lo, hi) => { draws++; return random(lo, hi); }); B.start(st, b, null, minRng); return b.id; });
  const ids = await Promise.all(Array.from({ length: 20 }, make)); assert.equal(new Set(ids).size, 1); const snapshot = C.clone(saved), count = draws;
  const restored = require('../src/rpg/store').createStore(h.deps); await restored.load(s.guildId); const result = await restored.transact(s.guildId, 'one-encounter', 'GM', () => { throw Error('must not execute again'); });
  assert.equal(result, ids[0]); assert.equal(draws, count); assert.deepEqual(saved.players, snapshot.players); assert.deepEqual(saved.battles, snapshot.battles); assert.deepEqual(saved.explorations, snapshot.explorations);
});
test('disconnect before or after commit preserves the authoritative round charge and frozen layout', async () => {
  for (const fault of ['before', 'after']) {
    const { s, m } = fixture(), h = harness(); let saved = C.clone(s), injected = false;
    h.deps.database = { assertLease() {}, load: async () => C.clone(saved), save: async (_, before, next) => {
      assert.equal(before.revision, saved.revision); if (!injected && fault === 'before') { injected = true; throw Error('before COMMIT'); }
      saved = C.clone(next); if (!injected) { injected = true; throw Error('after COMMIT'); }
    } };
    const store = require('../src/rpg/store').createStore(h.deps); await store.load(s.guildId);
    const operation = () => store.transact(s.guildId, 'uncertain-encounter', 'GM', st => { const b = X.encounter(st, st.explorations[m.id], '2,0', ['1'], minRng); B.start(st, b, null, minRng); return b.id; });
    if (fault === 'before') { await assert.rejects(operation(), /暂停/); assert.equal(Object.keys(saved.battles).length, 0); assert.equal(saved.explorations[m.id].cells['2,0'].room.tacticalLayout, undefined); await store.recover(s.guildId); }
    const id = await operation(), ap = saved.players['1'].ap, layout = C.clone(saved.explorations[m.id].cells['2,0'].room.tacticalLayout);
    assert.equal(store.frozen(s.guildId), false); assert.equal(await operation(), id); assert.equal(saved.players['1'].ap, ap); assert.deepEqual(saved.explorations[m.id].cells['2,0'].room.tacticalLayout, layout); assert.equal(saved.battles[id].current.apCost, 100);
  }
});
