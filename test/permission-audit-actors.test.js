'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), D = require('discord.js');
const A = require('../src/permission-audit-actors');

function fixture(fetch = async id => ({ id, bot: false })) {
  const reads = [], errors = [], client = { user: { id: 'self' }, users: { cache: new Map(), fetch: async (id, options) => {
    reads.push({ id, options });const user = await fetch(id);client.users.cache.set(id, user);return user;
  } } };
  return { client, reads, errors, guard: A.createPermissionAuditActors({ client, logFailure: (label, data) => errors.push({ label, data }) }) };
}

test('permission changes include role permissions and all three channel overwrite events, not unrelated audits', () => {
  assert.equal(A.relevant({ action: D.AuditLogEvent.RoleUpdate, changes: [{ key: 'permissions' }] }), true);
  assert.equal(A.relevant({ action: D.AuditLogEvent.RoleUpdate, changes: [{ key: 'name' }] }), false);
  for (const action of [D.AuditLogEvent.ChannelOverwriteCreate, D.AuditLogEvent.ChannelOverwriteUpdate, D.AuditLogEvent.ChannelOverwriteDelete])
    for (const key of ['allow', 'deny']) assert.equal(A.relevant({ action, changes: [{ key }] }), true);
  assert.equal(A.relevant({ action: D.AuditLogEvent.MemberRoleUpdate, changes: [{ key: '$add' }] }), false);
  assert.equal(A.relevant({ action: D.AuditLogEvent.ChannelUpdate }), false);
});

test('self, known bot executors and cached bots are ignored without REST; verified humans remain protected', async () => {
  const h = fixture();
  assert.equal(await h.guard.isHuman({ executorId: 'self' }), false);
  assert.equal(await h.guard.isHuman({ executorId: 'bot', executor: { id: 'bot', bot: true } }), false);
  h.client.users.cache.set('cached', { id: 'cached', bot: true });
  assert.equal(await h.guard.isHuman({ executorId: 'cached', executor: null }), false);
  assert.equal(await h.guard.isHuman({ executorId: 'human', executor: { id: 'human', bot: false } }), true);
  assert.equal(h.reads.length, 0);assert.equal(h.errors.length, 0);
});

test('an uncached bot in a gateway user_id-only event is fetched once and never treated as a human', async () => {
  const h = fixture(async id => ({ id, bot: true })), entry = { executorId: 'other-bot', executor: null };
  assert.equal(await h.guard.isHuman(entry), false);assert.equal(h.reads.length, 1);
  assert.deepEqual(h.reads[0].options, { force: true });
  assert.equal(await h.guard.isHuman(entry), false);assert.equal(h.reads.length, 1);
});

test('partial or mismatched executor data is verified; failure or missing identity cannot trigger rollback or sanctions', async () => {
  const h = fixture(async id => ({ id, bot: false }));
  assert.equal(await h.guard.isHuman({ executorId: 'human', executor: { id: 'human' } }), true);
  assert.equal(await h.guard.isHuman({ executorId: 'next', executor: { id: 'different', bot: false } }), true);
  assert.equal(h.reads.length, 2);
  const failed = fixture(async () => { throw Object.assign(new Error('private content'), { code: 10013 }); });
  assert.equal(await failed.guard.isHuman({ executorId: 'unknown' }), false);
  assert.equal(await failed.guard.isHuman({ executorId: null, executor: null }), false);
  assert.equal(await failed.guard.isHuman({}), false);
  const incomplete = fixture(async () => ({ id: 'wrong', bot: false }));
  assert.equal(await incomplete.guard.isHuman({ executorId: 'expected' }), false);
  assert.equal(incomplete.errors[0].data.code, 'AUDIT_ACTOR_INCOMPLETE');
  assert.deepEqual(failed.errors.map(e => e.data.code), [10013, 'AUDIT_ACTOR_MISSING', 'AUDIT_ACTOR_MISSING']);
  assert.equal(JSON.stringify(failed.errors).includes('private content'), false);
});

test('concurrent events for one executor share a lookup; pending lookups remain bounded and recover after completion', async () => {
  let release;const wait = new Promise(r => release = r), h = fixture(async id => { await wait;return { id, bot: true }; });
  const first = h.guard.isHuman({ executorId: 'bot-0' }), duplicate = h.guard.isHuman({ executorId: 'bot-0' });
  const others = Array.from({ length: 63 }, (_, i) => h.guard.isHuman({ executorId: 'bot-' + (i + 1) }));
  assert.equal(h.reads.length, 64);
  assert.equal(await h.guard.isHuman({ executorId: 'overflow' }), false);assert.equal(h.reads.length, 64);
  release();assert.ok((await Promise.all([first, duplicate, ...others])).every(v => v === false));
  assert.equal(await h.guard.isHuman({ executorId: 'overflow' }), false);assert.equal(h.reads.length, 65);
});

test('the live audit route skips every permission side effect for uncached bots and unresolved actors, while human changes still restore', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('../src/bot.js'), 'utf8');
  const begin = source.indexOf("client.on('guildAuditLogEntryCreate'"), end = source.indexOf("client.on('channelCreate'", begin);
  const h = fixture(async id => { if (id === 'offline') throw Object.assign(Error(), { code: 'ETIMEDOUT' });return { id, bot: id === 'other-bot' }; });
  const effects = [], bits = D.PermissionFlagsBits.ManageRoles;let route;
  const context = { client: { ...h.client, on: (_, fn) => route = fn }, permissionAuditActors: h.guard, handledPermissionAuditEntries: new Set(), managementNoticeAudit: { handle: async () => false },
    settingsFor: () => { effects.push('settings');return { permissionRollbackWhitelistUserIds: [], permissionRollbackEnabled: true }; },
    noticeExemptions: { isExempt: () => false }, AuditLogEvent: D.AuditLogEvent, monitoredPermissionBits: x => x,
    permissionInteger: value => BigInt(value || 0),
    changedPermissionBits: (a, b) => BigInt(a) ^ BigInt(b),
    restoreRolePermissionChanges: async () => { effects.push('restore-role');return { restored: bits }; },
    restoreChannelOverwriteChanges: async () => { effects.push('restore-channel');return { restored: bits }; },
    applyPermissionViolationPolicy: async () => { effects.push('sanction');return null; },
    sendPermissionAlert: async () => effects.push('notice'), console: { warn: () => effects.push('warning') },
    guardedPermissionKeys: ['ManageRoles'], escalationPermissionKeys: new Set(), permissionNamesForBits: () => ['ManageRoles'], permissionLabel: x => x,
    EmbedBuilder: D.EmbedBuilder, logFailure: (_, e) => { throw e; } };
  vm.runInNewContext(source.slice(begin, end), context);
  const guild = { id: 'guild', roles: { cache: new Map() }, channels: { cache: new Map() } }, entries = [
    { action: D.AuditLogEvent.RoleUpdate, changes: [{ key: 'permissions', old: '0', new: String(bits) }] },
    ...[D.AuditLogEvent.ChannelOverwriteCreate, D.AuditLogEvent.ChannelOverwriteUpdate, D.AuditLogEvent.ChannelOverwriteDelete]
      .map(action => ({ action, changes: [{ key: 'allow', old: '0', new: String(bits) }] }))
  ];
  for (const executorId of ['other-bot', 'offline', null]) for (const [i, values] of entries.entries())
    await route({ id: executorId + '-' + i, executorId, executor: null, targetId: 'target', ...values }, guild);
  assert.deepEqual(effects, []);
  const entry = { id: 'human-role', executorId: 'human', targetId: 'target', createdAt: new Date(), ...entries[0] };
  await route(entry, guild);await route(entry, guild);
  await route({ ...entry, id: 'human-channel', ...entries[2] }, guild);
  assert.equal(effects.filter(e => e === 'restore-role').length, 1);
  assert.equal(effects.filter(e => e === 'restore-channel').length, 1);
  assert.equal(effects.filter(e => e === 'sanction').length, 2);
  assert.equal(effects.filter(e => e === 'notice').length, 2);
  assert.equal(h.reads.filter(r => r.id === 'other-bot').length, 1);
});
