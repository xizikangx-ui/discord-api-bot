'use strict';
const { gzipSync, gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const C = require('./constants');
const COLLECTIONS = new Set(['players', 'characterDrafts', 'forms', 'catalog', 'skillTemplates', 'checkSkillTemplates', 'checks', 'sessions', 'lootPublications', 'traits', 'conditionTemplates', 'mapCategories', 'roomTemplates', 'explorations', 'deaths', 'corpses', 'npcTemplates', 'battles', 'offers', 'rolePanels', 'containerDefinitions', 'templateTombstones', 'mapTombstones', 'deliveryJobs']);
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = state => createHash('sha256').update(canonical(state)).digest('hex');
function createPostgres({ connectionString, encrypt, decrypt, pool: suppliedPool, schema = 'rpg', metrics, onLeaseLost = () => {} }) {
  C.requireThat(/^(rpg|rpg_test_[a-z0-9_]+)$/.test(schema), '数据库命名空间不合法。');
  const pool = suppliedPool || new (require('pg').Pool)({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000, application_name: 'discord-rpg' });
  const table = name => '"' + schema + '".' + name;
  let initialized, lease, heartbeat, lost = false;
  pool.on?.('error', () => { metrics?.gauge('database.poolError', 1); });
  function seal(guild, scope, id, value) {
    return Buffer.from(encrypt({ kind: 'rpg-record-v1', guildId: guild, scope, id, body: gzipSync(Buffer.from(JSON.stringify(value))).toString('base64') }));
  }
  function open(guild, scope, id, bytes) {
    const result = decrypt(JSON.parse(Buffer.from(bytes).toString('utf8'))), e = result.value;
    C.requireThat(result.encrypted && e.kind === 'rpg-record-v1' && e.guildId === guild && e.scope === scope && e.id === id, '数据库加密记录归属不符。');
    return JSON.parse(gunzipSync(Buffer.from(e.body, 'base64'), { maxOutputLength: 128 * 1024 * 1024 }));
  }
  async function init() {
    if (!initialized) initialized = (async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table('guilds')} (guild_id text PRIMARY KEY, revision bigint NOT NULL, metadata bytea NOT NULL, imported_message_id text, imported_revision bigint, imported_digest text, updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS ${table('objects')} (guild_id text NOT NULL REFERENCES ${table('guilds')}(guild_id), collection text NOT NULL, object_id text NOT NULL, payload bytea NOT NULL, PRIMARY KEY(guild_id,collection,object_id));
        CREATE TABLE IF NOT EXISTS ${table('audit')} (guild_id text NOT NULL REFERENCES ${table('guilds')}(guild_id), sequence bigint NOT NULL, operation_id text NOT NULL, payload bytea NOT NULL, PRIMARY KEY(guild_id,sequence));
        CREATE INDEX IF NOT EXISTS rpg_audit_operation ON ${table('audit')}(guild_id,operation_id);
        CREATE TABLE IF NOT EXISTS ${table('receipts')} (guild_id text NOT NULL REFERENCES ${table('guilds')}(guild_id), operation_id text NOT NULL, at bigint NOT NULL, payload bytea NOT NULL, PRIMARY KEY(guild_id,operation_id));
        CREATE TABLE IF NOT EXISTS ${table('imports')} (guild_id text PRIMARY KEY, message_id text NOT NULL, revision bigint NOT NULL, digest text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());`);
    })();
    return initialized;
  }
  function assertLease() { C.requireThat(!lost, '数据库运行锁已丢失，跑团已暂停。'); }
  async function acquireLease(applicationId) {
    await init(); if (lease) return;
    const key = createHash('sha256').update('rpg-writer:' + applicationId + ':' + schema).digest().readBigInt64BE().toString();
    lease = await pool.connect();
    const r = await lease.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
    if (!r.rows[0].acquired) { lease.release(); lease = null; throw Error('另一个Bot实例持有数据库运行锁，拒绝重复启动。'); }
    const fail = () => { if (lost) return; lost = true; clearInterval(heartbeat); onLeaseLost(); };
    lease.on?.('error', fail); lease.on?.('end', fail);
    heartbeat = setInterval(() => lease.query('SELECT 1').catch(fail), 5000); heartbeat.unref();
  }
  async function load(guild, runner) {
    await init(); assertLease();
    if (!runner) {
      const reader = await pool.connect();
      try { await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const state = await load(guild, reader); await reader.query('COMMIT'); return state; }
      catch (error) { await reader.query('ROLLBACK').catch(() => {}); throw error; }
      finally { reader.release(); }
    }
    const head = (await runner.query(`SELECT revision,metadata,imported_revision,imported_digest FROM ${table('guilds')} WHERE guild_id=$1`, [guild])).rows[0];
    if (!head) return null;
    const state = open(guild, 'metadata', guild, head.metadata);
    C.requireThat(state.kind === 'tabletop-rpg' && state.guildId === guild && state.schema === 1 && Number(head.revision) === state.revision && Number.isSafeInteger(state.revision), '数据库存档格式或版本不符。');
    for (const key of COLLECTIONS) if (state._collections?.includes(key)) state[key] = {};
    delete state._collections;
    const objects = await runner.query(`SELECT collection,object_id,payload FROM ${table('objects')} WHERE guild_id=$1`, [guild]);
    for (const r of objects.rows) { C.requireThat(COLLECTIONS.has(r.collection), '数据库集合类型不合法。'); state[r.collection] ||= {}; state[r.collection][r.object_id] = open(guild, r.collection, r.object_id, r.payload); }
    state.events = (await runner.query(`SELECT operation_id,payload FROM ${table('audit')} WHERE guild_id=$1 ORDER BY sequence`, [guild])).rows.map(r => open(guild, 'audit', r.operation_id, r.payload));
    state.receipts = {};
    for (const r of (await runner.query(`SELECT operation_id,payload FROM ${table('receipts')} WHERE guild_id=$1`, [guild])).rows) state.receipts[r.operation_id] = open(guild, 'receipt', r.operation_id, r.payload);
    if(head.imported_digest&&Number(head.imported_revision)===state.revision)C.requireThat(digest(state)===head.imported_digest,'数据库首次导入内容校验失败，拒绝启用或恢复。');
    return state;
  }
  async function batch(runner, sql, rows, columns) {
    for (let n = 0; n < rows.length; n += 150) {
      const portion = rows.slice(n, n + 150), args = portion.flat(), values = portion.map((_, k) => '(' + Array.from({ length: columns }, (_, j) => '$' + (k * columns + j + 1)).join(',') + ')').join(',');
      await runner.query(sql.replace('VALUES_PLACEHOLDER', values), args);
    }
  }
  async function save(guild, before, next, source) {
    await init(); assertLease(); C.requireThat(lease, '尚未取得数据库独占运行锁，拒绝写入。'); const end = metrics?.start('database.commit'); const runner = await pool.connect();
    try {
      await runner.query('BEGIN');
      const head = (await runner.query(`SELECT revision FROM ${table('guilds')} WHERE guild_id=$1 FOR UPDATE`, [guild])).rows[0];
      C.requireThat(before ? head && Number(head.revision) === before.revision : !head, '数据库版本已有变化，停止写入以避免覆盖。');
      if (source) await runner.query(`INSERT INTO ${table('imports')}(guild_id,message_id,revision,digest) VALUES($1,$2,$3,$4)`, [guild, source.messageId, next.revision, digest(next)]);
      const metadata = Object.fromEntries(Object.entries(next).filter(([k]) => !COLLECTIONS.has(k) && !['events', 'receipts'].includes(k)));
      metadata._collections = [...COLLECTIONS].filter(k => Object.hasOwn(next, k));
      if (before) await runner.query(`UPDATE ${table('guilds')} SET revision=$2,metadata=$3,updated_at=now() WHERE guild_id=$1`, [guild, next.revision, seal(guild, 'metadata', guild, metadata)]);
      else await runner.query(`INSERT INTO ${table('guilds')}(guild_id,revision,metadata,imported_message_id,imported_revision,imported_digest) VALUES($1,$2,$3,$4,$5,$6)`, [guild, next.revision, seal(guild, 'metadata', guild, metadata), source?.messageId || null, source ? next.revision : null, source ? digest(next) : null]);
      const changed = [], deleted = [];
      for (const key of COLLECTIONS) {
        const old = before?.[key] || {}, current = next[key] || {};
        for (const [id, value] of Object.entries(current)) if (!Object.hasOwn(old, id) || JSON.stringify(old[id]) !== JSON.stringify(value)) changed.push([guild, key, id, seal(guild, key, id, value)]);
        for (const id of Object.keys(old)) if (!Object.hasOwn(current, id)) deleted.push([key, id]);
      }
      await batch(runner, `INSERT INTO ${table('objects')}(guild_id,collection,object_id,payload) VALUES VALUES_PLACEHOLDER ON CONFLICT(guild_id,collection,object_id) DO UPDATE SET payload=EXCLUDED.payload`, changed, 4);
      for (const [key, id] of deleted) await runner.query(`DELETE FROM ${table('objects')} WHERE guild_id=$1 AND collection=$2 AND object_id=$3`, [guild, key, id]);
      C.requireThat(!before || next.events.length >= before.events.length, '不能覆盖已有审计历史。');
      const audits = next.events.slice(before?.events.length || 0).map((e, n) => [guild, (before?.events.length || 0) + n, e.id, seal(guild, 'audit', e.id, e)]);
      await batch(runner, `INSERT INTO ${table('audit')}(guild_id,sequence,operation_id,payload) VALUES VALUES_PLACEHOLDER`, audits, 4);
      const receipts = Object.entries(next.receipts).filter(([id, v]) => !before?.receipts[id] || JSON.stringify(before.receipts[id]) !== JSON.stringify(v)).map(([id, v]) => [guild, id, v.at, seal(guild, 'receipt', id, v)]);
      await batch(runner, `INSERT INTO ${table('receipts')}(guild_id,operation_id,at,payload) VALUES VALUES_PLACEHOLDER ON CONFLICT(guild_id,operation_id) DO NOTHING`, receipts, 4);
      // Expiry follows the in-memory receipt policy, including migrated old receipts.
      for (const id of Object.keys(before?.receipts || {})) if (!Object.hasOwn(next.receipts, id)) await runner.query(`DELETE FROM ${table('receipts')} WHERE guild_id=$1 AND operation_id=$2`, [guild, id]);
      assertLease(); await runner.query('COMMIT'); metrics?.gauge('database.changedObjects', changed.length);
    } catch (error) { await runner.query('ROLLBACK').catch(() => {}); throw error; }
    finally { runner.release(); end?.(); }
  }
  async function importState(guild, state, messageId) {
    C.requireThat(messageId && state.guildId === guild, '导入须来自已定位的权威Discord存档。');
    await save(guild, null, state, { messageId });
    C.requireThat(digest(await load(guild)) === digest(state), '数据库导入校验失败，停止启用跑团。');
  }
  async function close() { lost = true; clearInterval(heartbeat); if (lease) { lease.release(true); lease = null; } await pool.end(); }
  return { init, load, save, importState, acquireLease, assertLease, close, digest, pool };
}
module.exports = { createPostgres, COLLECTIONS, digest };
