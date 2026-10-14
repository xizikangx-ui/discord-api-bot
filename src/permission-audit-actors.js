'use strict';
const { AuditLogEvent } = require('discord.js');

function relevant(entry) {
  const changes = entry.changes || [];
  if (entry.action === AuditLogEvent.RoleUpdate) return changes.some(c => c.key === 'permissions');
  return [AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete]
    .includes(entry.action) && changes.some(c => c.key === 'allow' || c.key === 'deny');
}

function createPermissionAuditActors({ client, logFailure }) {
  const pending = new Map();
  function verified(user, id) { return !!id && user?.id === id && typeof user.bot === 'boolean'; }
  async function isHuman(entry) {
    const id = entry.executorId;
    if (id && id === client.user?.id) return false;
    const cached = client.users.cache.get(id);
    const known = verified(entry.executor, id) ? entry.executor : verified(cached, id) ? cached : null;
    if (known) return !known.bot;
    if (!id || (!pending.has(id) && pending.size >= 64)) {
      logFailure('无法核实权限修改操作者，未自动扳回或处罚。', { code: id ? 'AUDIT_ACTOR_BUSY' : 'AUDIT_ACTOR_MISSING' });
      return false;
    }
    let lookup = pending.get(id);
    if (!lookup) {
      // Gateway audit events often contain only user_id. Force an authoritative
      // lookup for partial users; the existing bounded UserManager caches it.
      lookup = (async () => {
        try {
          const user = await client.users.fetch(id, { force: true });
          if (!verified(user, id)) throw Object.assign(new Error(), { code: 'AUDIT_ACTOR_INCOMPLETE' });
          return !user.bot;
        } catch (error) {
          logFailure('无法核实权限修改操作者，未自动扳回或处罚。', { code: error.code || 'AUDIT_ACTOR_LOOKUP_FAILED' });
          return false;
        }
      })();
      pending.set(id, lookup);
      void lookup.finally(() => { if (pending.get(id) === lookup) pending.delete(id); });
    }
    return lookup;
  }
  return { relevant, isHuman };
}

module.exports = { relevant, createPermissionAuditActors };
