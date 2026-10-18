'use strict';
const S = require('./security'), crypto = require('node:crypto');
const MAX_BYTES = 12 * 1024 * 1024, LIBRARY_MAX_BYTES = 300 * 1024 * 1024;
// A shared asset scope must remain separate from any group's lifecycle.
const MUSIC_SCOPE = 'shared-music-library';
function audioType(bytes) {
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 4).toString() === 'OggS' && (bytes.subarray(0, 512).includes(Buffer.from('OpusHead')) || bytes.subarray(0, 512).includes(Buffer.from('vorbis')))) return 'audio/ogg';
  S.fail('请选择 MP3、WAV 或 Ogg 音频文件。');
}
function isMusic(f) { return f?.kind === 'music'; }
async function libraryLock(repo, r) {
  await r.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [repo.schema + ':shared-music-library']);
}
async function libraryVersion(repo, r) { return (await repo.get('musicLibrary', MUSIC_SCOPE, r))?.version || 0; }
async function advanceLibrary(repo, r) {
  const version = await libraryVersion(repo, r) + 1;
  await repo.put('musicLibrary', { id: MUSIC_SCOPE, version }, { scope: MUSIC_SCOPE }, r);
  return version;
}
async function preserveGroupMusic(repo, group, r) {
  // Move only metadata before an old group is purged. Existing encrypted audio
  // keys and AAD remain unchanged, so this never copies or re-uploads a song.
  const old = (await repo.list('media', group, r)).filter(isMusic);
  if (!old.length) return 0;
  await libraryLock(repo, r);
  for (const f of old) {
    // The catalog may have changed while this group waited for the shared lock.
    const current = await repo.get('media', f.id, r, true);
    if (!isMusic(current)) continue;
    await repo.put('media', { ...current, shared: true, sourceGroupId: current.sourceGroupId || current.groupId, playbackEpoch: current.playbackEpoch || (current.retired ? 1 : 0) }, { scope: MUSIC_SCOPE }, r);
  }
  await advanceLibrary(repo, r);
  return old.length;
}
function playbackPosition(state, now = Date.now()) {
  const base = Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
  return base + (state.status === 'playing' && Number.isFinite(state.startedAt) ? Math.max(0, now - state.startedAt) / 1000 : 0);
}
function audioRange(bytes, range) {
  if (!range) return { status: 200, start: 0, end: bytes.length - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) return { status: 416 };
  const start = m[1] ? Number(m[1]) : Math.max(0, bytes.length - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1) : bytes.length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start || (!m[1] && !Number(m[2]))) return { status: 416 };
  return { status: 206, start, end };
}
function createMusic({ repo, accounts, crypt, storage, changed = () => {} }) {
  const canManage = (a, f) => ['gm', 'admin'].includes(a.role) && (a.user.admin || f.owner === a.user.id);
  const safe = (f, a) => ({ id: f.id, name: f.name, category: f.category, loop: f.loop, bytes: f.bytes || 0, version: f.version, retired: !!f.retired, ownerId: f.owner, canManage: canManage(a, f) });
  const empty = group => ({ id: group, version: 0, status: 'stopped', trackId: null, position: 0, startedAt: null });
  function effective(state, track) {
    // Retiring a shared track invalidates every active use. Restoring the
    // library entry must not unexpectedly resume old sessions in other groups.
    if (state.trackId && (!track || track.status !== 'ready' || track.retired || (state.trackEpoch || 0) !== (track.playbackEpoch || 0))) return { ...state, status: 'stopped', trackId: null, position: 0, startedAt: null };
    return state;
  }
  async function migrateLegacy() {
    const legacy = (await repo.list('media')).filter(f => isMusic(f) && !f.shared);
    if (!legacy.length) return { migrated: 0 };
    let migrated = 0;
    for (const f of legacy) {
      const value = await repo.tx('music-share-v1:' + f.id, async r => {
        await libraryLock(repo, r);
        const current = await repo.get('media', f.id, r, true);
        if (!current || current.shared) return { migrated: false };
        await repo.put('media', { ...current, shared: true, sourceGroupId: current.groupId, playbackEpoch: current.playbackEpoch || (current.retired ? 1 : 0) }, { scope: MUSIC_SCOPE }, r);
        await advanceLibrary(repo, r);
        return { migrated: true };
      });
      if (value.migrated) migrated++;
    }
    return { migrated };
  }
  async function read(uid, group) {
    const a = await accounts.member(group, uid);
    // Verify that the catalog did not change between its rows and playback
    // projection; an older HTTP reply must not undo a later shared retirement.
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await libraryVersion(repo), all = (await repo.list('media', MUSIC_SCOPE)).filter(isMusic);
      const state = await repo.get('musicState', group) || empty(group), track = all.find(f => f.id === state.trackId);
      if (version !== await libraryVersion(repo)) continue;
      return {
        tracks: all.filter(f => f.status === 'ready' && (!f.retired || ['gm', 'admin'].includes(a.role))).map(f => safe(f, a)),
        playback: { ...effective(state, track), libraryVersion: version }, serverTime: Date.now(),
        library: { version, bytes: all.reduce((n, f) => n + (f.bytes || 0), 0), trackCount: all.length, maxBytes: LIBRARY_MAX_BYTES, maxTrackBytes: MAX_BYTES },
      };
    }
    S.fail('共享曲库正在更新，请稍后刷新。', 'CONFLICT');
  }
  async function upload(a, p) {
    accounts.gm(a);
    S.ok(storage.bucket && storage.client, '音乐存储尚未配置。', 'UNAVAILABLE');
    S.ok(/^[\w-]{8,100}$/.test(p.operationId || ''), '操作编号无效。');
    const name = S.text(p.name, '音乐名称', 80), category = p.category || 'other';
    S.ok(['battle', 'event', 'other'].includes(category), '请选择战斗、事件或其他音乐。');
    S.ok(p.loop === undefined || typeof p.loop === 'boolean', '循环选项无效。');
    const bytes = Buffer.from(p.data || '', 'base64');
    S.ok(bytes.length > 12 && bytes.length <= MAX_BYTES, '单首音乐最多 12 MiB。');
    const mime = audioType(bytes), id = S.hash(a.user.id + ':music:' + p.operationId), hash = S.hash(bytes), nonce = crypto.randomUUID();
    const saved = await repo.tx('music-reserve:' + id, async r => {
      accounts.gm(await accounts.member(a.group.id, a.user.id, r));
      await libraryLock(repo, r);
      const old = await repo.get('media', id, r, true);
      if (old) return old;
      const all = (await repo.list('media', MUSIC_SCOPE, r)).filter(isMusic);
      S.ok(all.reduce((n, f) => n + (f.bytes || 0), 0) + bytes.length <= LIBRARY_MAX_BYTES, '共享音乐库合计最多 300 MiB，已停用曲目仍占空间。');
      const f = { id, owner: a.user.id, groupId: a.group.id, sourceGroupId: a.group.id, shared: true, kind: 'music', name, category, loop: p.loop !== false, bytes: bytes.length, mime, hash, status: 'sending', key: 'music/' + id + '.enc', version: 1, playbackEpoch: 0, nonce, at: Date.now() };
      await repo.put('media', f, { scope: MUSIC_SCOPE }, r);
      await advanceLibrary(repo, r); return f;
    });
    // Replayed reservations must retain their original content even after a
    // track has since been renamed, restored or used in another group.
    S.ok(saved.owner === a.user.id && saved.hash === hash && saved.name === name && saved.category === category && saved.loop === (p.loop !== false), '同次上传的内容已变化。', 'CONFLICT');
    const current = await repo.get('media', id);
    if (current?.status === 'ready') return safe(current, a);
    try {
      await storage.client.send(new storage.commands.PutObjectCommand({ Bucket: storage.bucket, Key: saved.key, Body: crypt.seal('audio', id, { data: bytes.toString('base64') }), ContentType: 'application/octet-stream' }));
      await repo.tx('music-ready:' + id, async r => {
        accounts.gm(await accounts.member(a.group.id, a.user.id, r));
        await libraryLock(repo, r);
        const latest = await repo.get('media', id, r, true);
        S.ok(latest?.hash === hash && latest.owner === a.user.id, '上传记录已变化。', 'CONFLICT');
        if (latest.status !== 'ready') {
          await repo.put('media', { ...latest, status: 'ready' }, { scope: MUSIC_SCOPE }, r);
          await advanceLibrary(repo, r);
        }
        return { id };
      });
    } catch {
      S.fail('音乐上传尚未确认，请保留文件并按原请求核对重试。', 'UNCERTAIN');
    }
    changed(null);
    return safe(await repo.get('media', id), a);
  }
  async function command(a, p) {
    accounts.gm(a);
    S.ok(/^[\w-]{8,100}$/.test(p.operationId || ''), '操作编号无效。');
    S.ok(['play', 'resume', 'pause', 'stop', 'seek', 'edit', 'retire', 'restore'].includes(p.action), '音乐操作无效。');
    if (p.loop !== undefined) S.ok(typeof p.loop === 'boolean', '循环选项无效。');
    const metadata = ['edit', 'retire', 'restore'].includes(p.action);
    if (metadata) S.ok(Number.isSafeInteger(p.trackVersion) && p.trackVersion > 0, '曲目信息已更新，请刷新后重新操作。', 'CONFLICT');
    const fingerprint = S.hash(JSON.stringify({ action: p.action, trackId: p.trackId, baseVersion: p.baseVersion, trackVersion: p.trackVersion, position: p.position, name: p.name, category: p.category, loop: p.loop }));
    const saved = await repo.tx('music-command-v2:' + a.group.id + ':' + a.user.id + ':' + p.operationId, async r => {
      const auth = await accounts.member(a.group.id, a.user.id, r);
      accounts.gm(auth);
      await libraryLock(repo, r);
      let state = await repo.get('musicState', a.group.id, r, true) || empty(a.group.id);
      S.ok(p.baseVersion === state.version, '音乐播放状态已变化，请刷新后操作。', 'CONFLICT');
      const previousTrack = state.trackId ? await repo.get('media', state.trackId, r, true) : null;
      state = effective(state, previousTrack);
      const trackId = p.trackId || (['resume', 'seek'].includes(p.action) ? state.trackId : null);
      const track = trackId ? await repo.get('media', trackId, r, true) : null;
      if (['play', 'resume', 'seek'].includes(p.action) || metadata) S.ok(isMusic(track) && track.status === 'ready', '音乐不存在。', 'NOT_FOUND');
      if (metadata) {
        S.ok(canManage(auth, track), '只能管理自己上传的曲目；网站管理员可管理全部曲目。', 'FORBIDDEN');
        S.ok(p.trackVersion === track.version, '曲目信息已变化，请刷新后操作。', 'CONFLICT');
        if (p.action === 'edit') {
          S.ok(['battle', 'event', 'other'].includes(p.category), '音乐分类无效。');
          if (state.trackId === track.id && track.loop !== (p.loop !== false)) state.loop = p.loop !== false;
          track.name = S.text(p.name, '音乐名称', 80); track.category = p.category; track.loop = p.loop !== false;
        } else {
          track.retired = p.action === 'retire';
          if (track.retired) track.playbackEpoch = (track.playbackEpoch || 0) + 1;
        }
        track.version++;
        await repo.put('media', { ...track, shared: true, sourceGroupId: track.sourceGroupId || track.groupId }, { scope: MUSIC_SCOPE }, r);
        await advanceLibrary(repo, r);
        if (state.trackId === track.id) state = effective(state, track);
      }
      const now = Date.now();
      if (['play', 'resume', 'seek'].includes(p.action)) {
        S.ok(!track.retired, '此音乐已停用，请恢复曲目或选择其他音乐。');
        if (['resume', 'seek'].includes(p.action)) S.ok(state.trackId === track.id && ['playing', 'paused'].includes(state.status), '当前播放曲目已变化，请重新选择。', 'CONFLICT');
        if (p.action === 'seek') S.ok(p.position !== undefined, '请选择播放位置。');
        const same = state.trackId === track.id && ['playing', 'paused'].includes(state.status);
        const position = p.position ?? (same ? playbackPosition(state, now) : 0);
        S.ok(Number.isFinite(position) && position >= 0 && (p.position === undefined || position <= 86400), '播放位置须为 0—86400 秒。');
        const status = p.action === 'seek' ? state.status : 'playing';
        state = { ...state, status, trackId: track.id, trackEpoch: track.playbackEpoch || 0, position, startedAt: status === 'playing' ? now : null, loop: p.loop ?? (same ? state.loop : track.loop) };
      } else if (p.action === 'pause') {
        S.ok(state.trackId && ['playing', 'paused'].includes(state.status), '当前没有可暂停的音乐。');
        state = { ...state, status: 'paused', position: playbackPosition(state, now), startedAt: null };
      } else if (p.action === 'stop') state = { ...state, status: 'stopped', trackId: null, position: 0, startedAt: null };
      state.version++;
      state.libraryVersion = await libraryVersion(repo, r);
      await repo.put('musicState', state, { scope: a.group.id }, r);
      return { fingerprint, result: { playback: state, serverTime: now, ...(metadata ? { track: safe(track, auth) } : {}) } };
    });
    S.ok(saved.fingerprint === fingerprint, '同次音乐操作的内容已变化，请先核对原操作结果。', 'CONFLICT');
    changed(metadata ? null : a.group.id);
    return saved.result;
  }
  async function bytes(uid, group, id) {
    await accounts.member(group, uid);
    S.ok(storage.bucket && storage.client, '音乐存储尚未配置。', 'UNAVAILABLE');
    const f = await repo.get('media', id);
    S.ok(isMusic(f) && f.status === 'ready' && !f.retired, '音乐不可用。', 'NOT_FOUND');
    const object = await storage.client.send(new storage.commands.GetObjectCommand({ Bucket: storage.bucket, Key: f.key }));
    return { bytes: Buffer.from(crypt.open('audio', id, await object.Body.transformToByteArray()).data, 'base64'), mime: f.mime };
  }
  return { read, upload, command, bytes, migrateLegacy };
}
module.exports = { createMusic, audioType, audioRange, playbackPosition, preserveGroupMusic, MUSIC_SCOPE, MAX_BYTES, LIBRARY_MAX_BYTES };
