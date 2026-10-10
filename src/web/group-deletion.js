'use strict';
const S = require('./security');
function createDeletion({ repo, content, accounts, games, database, storage, disconnected = () => {} }) {
  const running = new Map();
  const publicStatus = j => ({ groupId: j.id, status: j.status, startedAt: j.startedAt, completedAt: j.completedAt });
  async function status(user, group) {
    accounts.admin(await accounts.user(user.id));
    const j = await repo.get('groupDeletion', group);
    S.ok(j, '未找到删除记录。', 'NOT_FOUND');
    return publicStatus(j);
  }
  async function start(user, group, p) {
    accounts.admin(await accounts.user(user.id));
    S.ok(/^[a-zA-Z0-9_-]{8,100}$/.test(p.operationId || ''), '操作编号无效。');
    const job = await repo.tx('group-delete:' + group, async r => {
      accounts.admin(await accounts.user(user.id, r));
      const previous = await repo.get('groupDeletion', group, r);
      if (previous) return previous;
      const g = await repo.get('group', group, r, true);
      S.ok(g, '跑团不存在。', 'NOT_FOUND');
      S.ok(g.version === p.baseVersion, '团资料已变化，请刷新后再删除。', 'CONFLICT');
      g.deleting = true;
      await repo.put('group', g, {}, r);
      const j = { id: group, actorId: user.id, operationId: p.operationId, groupVersion: g.version, status: 'deleting', startedAt: Date.now(), keys: (await repo.list('media', group, r)).map(f => f.key), rooms: (await repo.list('room', group, r)).map(c => c.id) };
      await repo.put('groupDeletion', j, {}, r);
      return j;
    });
    disconnected(group);
    void run(group).catch(() => {});
    return publicStatus(await repo.get('groupDeletion',group)||job);
  }
  async function run(group) {
    if (running.has(group)) return running.get(group);
    const task = (async () => {
      let j = await repo.get('groupDeletion', group);
      if (!j || j.status === 'deleted') return;
      try {
        await games.store.removeGuild(group, async () => {
          await repo.tx('group-purge:' + group, async r => {
            await database.deleteGuild(group, r);
            await repo.purgeGroup(group, j.rooms || [], r);
            if(content)await content.purgeGroup(group,[],r);
            return { groupId: group, status: 'deleting' };
          });
        });
        for (const key of j.keys || []) {
          S.ok(storage.client && storage.bucket && storage.commands?.DeleteObjectCommand, '图片清理服务未配置。');
          await storage.client.send(new storage.commands.DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
        }
        // After purge only this minimal tombstone remains; no names, messages or assets.
        j = { id: group, actorId: j.actorId, operationId: j.operationId, groupVersion: j.groupVersion, startedAt: j.startedAt, completedAt: Date.now(), status: 'deleted' };
        await repo.put('groupDeletion', j);
      } catch (e) {
        await repo.put('groupDeletion', { ...j, status: 'cleanup_error', errorCode: e.code || 'CLEANUP' });
      }
    })();
    running.set(group, task);
    try { await task; } finally { running.delete(group); }
  }
  async function resume() { for(const f of await repo.list('mediaCleanup')){try{await storage.client.send(new storage.commands.DeleteObjectCommand({Bucket:storage.bucket,Key:f.key}));await repo.remove('mediaCleanup',f.id);}catch{/* resume later */}}for (const j of await repo.list('groupDeletion')) if (j.status !== 'deleted') await run(j.id); }
  return { start, status, resume, drain: () => Promise.allSettled([...running.values()]) };
}
module.exports = { createDeletion };
