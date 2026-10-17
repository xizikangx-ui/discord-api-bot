'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const state = import('../web/src/avatar-state.js');
const account = { webMediaId: 'account', version: 4 }, character = { webMediaId: 'character', version: 7 };
test('chat chooses current account portrait while RP chooses the current character portrait', async () => {
  const { avatarSource } = await state, member = { avatar: account, characterAvatar: character };
  assert.equal(avatarSource({ kind: 'text' }, member), account);
  assert.equal(avatarSource({ kind: 'rp' }, member), character);
  assert.equal(avatarSource({ kind: 'text' }, { avatar: null, characterAvatar: character }), character);
  assert.equal(avatarSource({ kind: 'rp' }, { avatar: account, characterAvatar: null }), account);
});
test('old messages use current member portraits, including clearing both portraits', async () => {
  const { avatarSource } = await state, message = { kind: 'rp', avatar: character, accountAvatar: account, characterAvatar: character };
  assert.equal(avatarSource(message, { avatar: null, characterAvatar: null }), null);
  assert.equal(avatarSource(message, { avatar: account, characterAvatar: { webMediaId: 'new' } }).webMediaId, 'new');
  assert.equal(avatarSource(message, undefined), character);
});
test('avatar reads always name the currently authorized group and version', async () => {
  const { avatarUrl } = await state;
  assert.equal(avatarUrl({ ...account, groupId: 'old' }, 'current'), '/api/web/v1/media/account?groupId=current&v=4');
  assert.equal(avatarUrl(account, ''), '');
  assert.equal(avatarUrl(null, 'current'), '');
  assert.equal(avatarUrl({ webMediaId: 'x/y', version: 5 }, 'a&b'), '/api/web/v1/media/x%2Fy?groupId=a%26b&v=5');
});
test('a delayed member read cannot restore a replaced or cleared account avatar', async () => {
  const { mergeAvatarMembers } = await state;
  const old = [{ userId: 'u', avatar: null, avatarVersion: 6 }];
  assert.deepEqual(mergeAvatarMembers(old, [{ userId: 'u', name: 'new name', avatar: account, avatarVersion: 4 }]), [{ userId: 'u', name: 'new name', avatar: null, avatarVersion: 6 }]);
  assert.equal(mergeAvatarMembers(old, [{ userId: 'u', avatar: account, avatarVersion: 7 }])[0].avatar, account);
});
test('account uploads reject unsupported, empty or oversized files before reading them', async () => {
  const { checkAvatarFile } = await state;
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.doesNotThrow(() => checkAvatarFile({ type, size: 4 * 1024 * 1024 }));
  assert.throws(() => checkAvatarFile({ type: 'image/gif', size: 1 }), /PNG/);
  assert.throws(() => checkAvatarFile({ type: 'image/png', size: 0 }), /为空/);
  assert.throws(() => checkAvatarFile({ type: 'image/png', size: 4 * 1024 * 1024 + 1 }), /4 MiB/);
});
