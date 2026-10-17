'use strict';
const S = require('./security'), crypto = require('node:crypto');
const MAX_BYTES = 12 * 1024 * 1024;
function audioType(bytes) {
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 4).toString() === 'OggS' && (bytes.subarray(0, 512).includes(Buffer.from('OpusHead')) || bytes.subarray(0, 512).includes(Buffer.from('vorbis')))) return 'audio/ogg';
  S.fail('请选择 MP3、WAV 或 Ogg 音频文件。');
}
function createMusic({ repo, accounts, crypt, storage, changed = () => {} }) {
  const safe = f => ({ id: f.id, name: f.name, category: f.category, loop: f.loop, bytes: f.bytes||0, version: f.version, retired: !!f.retired });
  const empty = group => ({ id: group, version: 0, status: 'stopped', trackId: null, position: 0, startedAt: null });
  async function read(uid, group) {
    const a = await accounts.member(group, uid);
    return { tracks: (await repo.list('media', group)).filter(f=>f.kind==='music'&&f.status==='ready'&&(!f.retired||['gm','admin'].includes(a.role))).map(safe), playback: await repo.get('musicState', group) || empty(group), serverTime: Date.now() };
  }
  async function upload(a, p) {
    accounts.gm(a);
    S.ok(storage.bucket && storage.client, '音乐存储尚未配置。', 'UNAVAILABLE');
    S.ok(/^[\w-]{8,100}$/.test(p.operationId || ''), '操作编号无效。');
    const name = S.text(p.name, '音乐名称', 80), category = p.category || 'other';
    S.ok(['battle', 'event', 'other'].includes(category), '请选择战斗、事件或其他音乐。');
    const bytes = Buffer.from(p.data || '', 'base64');
    S.ok(bytes.length > 12 && bytes.length <= MAX_BYTES, '单首音乐最多 12 MiB。');
    const mime = audioType(bytes), id = S.hash(a.user.id + ':music:' + p.operationId), hash = S.hash(bytes), nonce = crypto.randomUUID();
    const saved = await repo.tx('music-reserve:' + id, async r => {
      accounts.gm(await accounts.member(a.group.id, a.user.id, r));
      const old = await repo.get('media', id, r);
      if (old) { S.ok(old.hash === hash && old.groupId === a.group.id && old.name === name && old.category === category && old.loop === (p.loop !== false), '同次上传的内容已变化。', 'CONFLICT'); return old; }
      const all = (await repo.list('media', a.group.id, r)).filter(f => f.kind === 'music');
      S.ok(all.length < 30 && all.reduce((n, f) => n + f.bytes, 0) + bytes.length <= 120 * 1024 * 1024, '本团音乐库最多 30 首、合计 120 MiB。');
      const f = { id, owner: a.user.id, groupId: a.group.id, kind: 'music', name, category, loop: p.loop !== false, bytes: bytes.length, mime, hash, status: 'sending', key: 'music/' + id + '.enc', version: 1, nonce, at: Date.now() };
      await repo.put('media', f, { scope: a.group.id }, r); return f;
    });
    const current = await repo.get('media', id);
    if (current?.status === 'ready') return safe(current);
    try {
      // A repeated upload writes the same encrypted object key and cannot create a second track.
      await storage.client.send(new storage.commands.PutObjectCommand({ Bucket: storage.bucket, Key: saved.key, Body: crypt.seal('audio', id, { data: bytes.toString('base64') }), ContentType: 'application/octet-stream' }));
      await repo.tx('music-ready:' + id, async r => {
        accounts.gm(await accounts.member(a.group.id, a.user.id, r));
        await repo.put('media', { ...saved, status: 'ready' }, { scope: a.group.id }, r); return { id };
      });
    } catch (e) {
      if (await repo.get('groupDeletion', a.group.id)) await repo.put('mediaCleanup', { id, key: saved.key, groupId: a.group.id });
      S.fail('音乐上传尚未确认，请保留文件并按原请求重试。', 'UNCERTAIN');
    }
    changed(a.group.id); return safe(saved);
  }
  async function command(a, p) {
    accounts.gm(a);
    S.ok(/^[\w-]{8,100}$/.test(p.operationId || ''), '操作编号无效。');
    S.ok(['play', 'pause', 'stop', 'edit', 'retire','restore'].includes(p.action), '音乐操作无效。');
    if(p.loop!==undefined)S.ok(typeof p.loop==='boolean','循环选项无效。');
    const result = await repo.tx('music-command:' + a.group.id + ':' + p.operationId, async r => {
      accounts.gm(await accounts.member(a.group.id, a.user.id, r));
      let state = await repo.get('musicState', a.group.id, r, true) || empty(a.group.id);
      S.ok(p.baseVersion === state.version, '音乐播放状态已变化，请刷新后操作。', 'CONFLICT');
      const track = p.trackId && await repo.get('media', p.trackId, r, true);
      if (['play', 'edit', 'retire','restore'].includes(p.action)) S.ok(track?.groupId === a.group.id && track.kind === 'music' && track.status === 'ready', '音乐不存在。', 'NOT_FOUND');
      if (['edit','retire','restore'].includes(p.action)) {
        if (p.action === 'edit') {
          S.ok(['battle', 'event', 'other'].includes(p.category), '音乐分类无效。');
          track.name = S.text(p.name, '音乐名称', 80); track.category = p.category; track.loop = p.loop !== false;
        } else track.retired = p.action === 'retire';
        track.version++; await repo.put('media', track, { scope: a.group.id }, r);
      }
      if (p.action === 'play') {
        S.ok(!track.retired, '此音乐已停用。');
        const position = p.position ?? (state.trackId === track.id && state.status === 'paused' ? state.position : 0);
        S.ok(Number.isFinite(position) && position >= 0 && position <= 86400, '播放位置无效。');
        state = { ...state, status: 'playing', trackId: track.id, position, startedAt: Date.now(), loop: p.loop ?? track.loop };
      } else if (p.action === 'pause') state = { ...state, status: 'paused', position: state.position + (state.status === 'playing' ? (Date.now() - state.startedAt) / 1000 : 0), startedAt: null };
      else if (p.action === 'stop' || (p.action === 'retire' && state.trackId === track.id)) state = { ...state, status: 'stopped', trackId: null, position: 0, startedAt: null };
      state.version++; await repo.put('musicState', state, { scope: a.group.id }, r);
      return { playback: state, serverTime: Date.now() };
    });
    changed(a.group.id); return result;
  }
  async function bytes(uid, group, id) {
    await accounts.member(group, uid);
    const f = await repo.get('media', id);
    S.ok(f?.groupId === group && f.kind === 'music' && f.status === 'ready' && !f.retired, '音乐不可用。', 'NOT_FOUND');
    const object = await storage.client.send(new storage.commands.GetObjectCommand({ Bucket: storage.bucket, Key: f.key }));
    return { bytes: Buffer.from(crypt.open('audio', id, await object.Body.transformToByteArray()).data, 'base64'), mime: f.mime };
  }
  return { read, upload, command, bytes };
}
module.exports = { createMusic, audioType, MAX_BYTES };
