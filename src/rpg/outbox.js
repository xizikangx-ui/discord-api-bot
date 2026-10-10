'use strict';
const C = require('./constants');
// Delivery metadata never dirties a public projection. Business changes do.
const omitted = new Set(['publication', 'publicationParts', 'messageId', 'auxiliaryMessages', 'notifiedTurn', 'notifiedPause', 'notified', 'defenseNotifications', 'npcCards', 'npcCardCleanup', 'boardPublication', 'notification', 'recruitAnnouncement', 'draft','imagePublication','operationContext']);
const fingerprint = value => JSON.stringify(value, (key, v) => omitted.has(key) ? undefined : v);
// PostgreSQL already records whether a projection is done, retrying or awaiting
// GM review. A restart resumes that task; it must not recreate every task.
function needsRecovery(store,guild,kind,ref){return !store.backgroundPublications||!store.select(guild,s=>s.deliveryJobs?.[kind+':'+ref]);}
function put(state, kind, ref, options = {}) {
  state.deliveryJobs ||= {};
  const key = kind + ':' + ref, old = state.deliveryJobs[key];
  state.deliveryJobs[key] = { ...old, key, kind, ref, desiredRevision: state.revision, queuedAt: ['pending','running'].includes(old?.status)?old.queuedAt||Date.now():Date.now(),status: old?.status === 'running' ? 'running' : 'pending', priority: options.priority ?? 10, force: options.force || false, attempts: 0, availableAt: Date.now() };
  return key;
}
function derive(before, next) {
  for (const [ref, b] of Object.entries(next.battles || {})) {
    if(b.judgment && fingerprint(before.battles?.[ref]?.judgment)!==fingerprint(b.judgment))put(next,'gmNotice','rescue/'+ref,{priority:1});
    if (fingerprint(before.battles?.[ref]) !== fingerprint(b)) put(next, 'battle', ref, { priority: b.pending ? 0 : 5 });
    if (require('./aoe').hits(b).some(h=>!h.notified&&b.actors.some(a=>a.id===h.targetId&&(a.userId||require('./npc-auto').config(a.ai).mode!=='auto')))) put(next,'defense',ref,{priority:0});
  }
  for (const [ref, m] of Object.entries(next.explorations || {})) {
    for(const [cell,c] of Object.entries(m.cells))if(c.room?.bossRequest&&fingerprint(before.explorations?.[ref]?.cells[cell]?.room?.bossRequest)!==fingerprint(c.room.bossRequest))put(next,'gmNotice','boss/'+ref+'/'+cell,{priority:1});
    if (m.status !== 'draft' && fingerprint(before.explorations?.[ref]) !== fingerprint(m)) put(next, 'map', ref);
    for(const [id,r] of Object.entries(m.moves||{}))if(fingerprint(before.explorations?.[ref]?.moves?.[id])!==fingerprint(r))put(next,'move',ref+'/'+id,{priority:1});
    for(const [id,r] of Object.entries(m.rps||{})){
      const old=before.explorations?.[ref]?.rps?.[id];
      if(r.status==='publishing'&&r.publication?.status==='pending'&&(old?.status!=='publishing'||old?.publication?.status!=='pending'))put(next,'rp',ref+'/'+id,{priority:2});
      if(r.status==='pending'&&r.draft?.status==='pending'&&!old)put(next,'rpDraft',ref,{priority:3});
    }
  }
  for(const [ref,c]of Object.entries(next.corpses||{}))if(fingerprint(before.corpses?.[ref])!==fingerprint(c))put(next,'corpses',c.battleId);
  for(const [ref,o]of Object.entries(next.offers||{}))if(o.channelId&&o.status==='ready'&&(!before.offers?.[ref]||before.offers[ref].status!=='ready'))put(next,'offer',ref,{priority:2});
  for (const [ref, r] of Object.entries(next.lootPublications || {})) if (!r.cleanedAt && fingerprint(before.lootPublications?.[ref]) !== fingerprint(r)) put(next, 'loot', ref);
  for (const [ref, c] of Object.entries(next.checks || {})) {
    const old = before.checks?.[ref];
    if (fingerprint(old) !== fingerprint(c)) put(next, 'check', ref);
    const oldAttempts = new Map(Object.values(old?.attempts || {}).flat().map(a => [a.id, a]));
    for (const a of Object.values(c.attempts || {}).flat()) if (fingerprint(oldAttempts.get(a.id)) !== fingerprint(a)) put(next, 'attempt', a.id, { priority: 5 });
  }
  for (const [ref, s] of Object.entries(next.sessions || {})) if (fingerprint(before.sessions?.[ref]) !== fingerprint(s)) put(next, 'session', ref);
}
function createOutbox({ store, handlers, client, logFailure, metrics, concurrency = 3 }) {
  const active = new Set(), urgent = new Set(); let timer, fallback, unsubscribe, queued = false, stopped = true, pumping = false;
  async function run(guild, task) {
    const token = guild + ':' + task.key, version = task.desiredRevision;
    active.add(token); if(task.kind==='defense')urgent.add(token); metrics?.observe('publication.wait',Date.now()-(task.queuedAt||Date.now()));const end = metrics?.start('publication.' + task.kind);
    try {
      await store.transact(guild, 'outbox-claim:' + C.id('j'), client.user.id, st => {
        const live = st.deliveryJobs[task.key]; live.status = 'running'; live.claimedRevision = version;
      }, '后台公示任务领取', { delivery: false });
      await handlers[task.kind]?.(guild, task.ref, task.force);
      await store.transact(guild, 'outbox-done:' + C.id('j'), client.user.id, st => {
        const live = st.deliveryJobs[task.key]; if (!live) return;
        live.status = live.desiredRevision > version ? 'pending' : 'done'; live.force = false; live.attempts = 0;
      }, '后台公示任务完成', { delivery: false });
    } catch (error) {
      if (!store.frozen(guild)) await store.transact(guild, 'outbox-error:' + C.id('j'), client.user.id, st => {
        const live = st.deliveryJobs[task.key]; if (!live) return;
        live.attempts = error.code==='RPG_RENDER_BUSY'?(live.attempts||0):(live.attempts||0)+1; live.status = live.attempts >= 3 ? 'failed' : 'pending';
        live.availableAt = Date.now() + Math.min(30000, 1000 * 2 ** live.attempts);
      }, '后台公示任务等待处理', { delivery: false }).catch(() => {});
      // Never include record contents, credentials or interaction IDs in metrics.
      if(error.code==='RPG_RENDER_BUSY')metrics?.count('render.busy');
      else logFailure('后台跑团公示未完成（' + task.kind + '）。', error);
    } finally { active.delete(token); urgent.delete(token); end?.(); wake(); }
  }
  async function pump() {
    if (stopped || pumping) return; pumping = true;
    try {
      const work = []; let next = Infinity;
      clearTimeout(timer);
      for (const guild of store.guilds()) if (!store.frozen(guild)) for (const task of store.select(guild, st => Object.values(st.deliveryJobs || {}).filter(t=>['pending','running'].includes(t.status)&&!active.has(guild+':'+t.key)).map(({key,kind,ref,priority,availableAt,desiredRevision,queuedAt,force})=>({key,kind,ref,priority,availableAt,desiredRevision,queuedAt,force})))) {
        if ((task.availableAt || 0) <= Date.now()) work.push({ guild, task });
        else next = Math.min(next, task.availableAt);
      }
      work.sort((a, b) => a.task.priority - b.task.priority || a.task.availableAt - b.task.availableAt);
      metrics?.gauge('publication.queue', work.length);
      // A reserved notification lane cannot be occupied by render/upload waits.
      for (const { guild, task } of work.filter(w=>w.task.kind==='defense').slice(0,Math.max(0,1-urgent.size))) void run(guild,task);
      for (const { guild, task } of work.filter(w=>w.task.kind!=='defense').slice(0, Math.max(0, concurrency - (active.size-urgent.size)))) void run(guild, task);
      if (Number.isFinite(next)) { timer=setTimeout(wake, Math.max(1,next-Date.now())); timer.unref(); }
    } finally { pumping = false; }
  }
  function wake() { if (!stopped&&!queued) { queued=true; setImmediate(() => {queued=false; return pump().catch(e => logFailure('后台跑团队列扫描失败。', e));}); } }
  function start() { if (!stopped) return; stopped = false; unsubscribe=store.onCommit?.(wake); fallback = setInterval(wake, 30000); fallback.unref(); wake(); }
  async function drain() { while (active.size) await new Promise(resolve => setTimeout(resolve, 20)); }
  function stop() { stopped = true; clearTimeout(timer); clearInterval(fallback); unsubscribe?.(); unsubscribe=null; }
  return { start, stop, wake, drain, active, register(kind,handler){handlers[kind]=handler;} };
}
module.exports = { fingerprint, put, derive, createOutbox,needsRecovery };
