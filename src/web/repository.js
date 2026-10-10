"use strict";
const { ok } = require("./security");
function createRepository(pool, crypt, { schema = "web_platform" } = {}) {
  ok(
    /^(web_platform|web_content|web_test_[a-z0-9_]+)$/.test(schema),
    "网站数据库命名空间无效。",
  );
  let groupRepository;
  const uncertain = new Set();
  const table = '"' + schema + '".records',
    messages = '"' + schema + '".messages';
  async function init() {
    if (
      !(
        await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [
          schema,
        ])
      ).rowCount
    )
      await pool.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table}(kind text NOT NULL,id text NOT NULL,scope text NOT NULL DEFAULT '',lookup text,version bigint NOT NULL DEFAULT 1,payload bytea NOT NULL,PRIMARY KEY(kind,id));CREATE INDEX IF NOT EXISTS web_records_scope ON ${table}(kind,scope);CREATE UNIQUE INDEX IF NOT EXISTS web_records_lookup ON ${table}(kind,lookup) WHERE lookup IS NOT NULL;CREATE TABLE IF NOT EXISTS ${messages}(room_id text NOT NULL,sequence bigint NOT NULL,id text NOT NULL,author_id text NOT NULL,client_id text NOT NULL,payload bytea NOT NULL,PRIMARY KEY(room_id,sequence),UNIQUE(room_id,author_id,client_id),UNIQUE(id));`,
    );
  }
  async function get(kind, id, r = pool, lock = false) {
    const row = (
      await r.query(
        `SELECT payload FROM ${table} WHERE kind=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [kind, id],
      )
    ).rows[0];
    return row ? crypt.open(kind, id, row.payload) : null;
  }
  async function lookup(kind, key, r = pool) {
    const row = (
      await r.query(
        `SELECT id,payload FROM ${table} WHERE kind=$1 AND lookup=$2`,
        [kind, key],
      )
    ).rows[0];
    return row ? crypt.open(kind, row.id, row.payload) : null;
  }
  async function list(kind, scope, r = pool) {
    const rows = (
      await r.query(
        `SELECT id,payload FROM ${table} WHERE kind=$1${scope !== undefined ? " AND scope=$2" : ""} ORDER BY id`,
        scope !== undefined ? [kind, scope] : [kind],
      )
    ).rows;
    return rows.map((row) => crypt.open(kind, row.id, row.payload));
  }
  async function put(
    kind,
    value,
    { scope = "", lookup = null } = {},
    r = pool,
  ) {
    ok(value.id, "记录缺少编号。");
    if(scope && r===pool){const runner=await pool.connect();try{await runner.query('BEGIN');const result=await put(kind,value,{scope,lookup},runner);await runner.query('COMMIT');return result;}catch(e){await runner.query('ROLLBACK').catch(()=>{});throw e;}finally{runner.release();}}
    if(scope){const owner=groupRepository||{get};const group=await owner.get('group',scope,r,true);ok(!group?.deleting,'此团正在删除。','NOT_FOUND');const deletion=await owner.get("groupDeletion",scope,r);ok(!deletion,"此团正在删除或已删除。","NOT_FOUND");}
    await r.query(
      `INSERT INTO ${table}(kind,id,scope,lookup,version,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(kind,id) DO UPDATE SET scope=EXCLUDED.scope,lookup=EXCLUDED.lookup,version=EXCLUDED.version,payload=EXCLUDED.payload`,
      [
        kind,
        value.id,
        scope,
        lookup,
        value.version || 1,
        crypt.seal(kind, value.id, value),
      ],
    );
    return value;
  }
  async function remove(kind, id, r = pool) {
    await r.query(`DELETE FROM ${table} WHERE kind=$1 AND id=$2`, [kind, id]);
  }
  async function tx(operation, fn) {
    ok(!uncertain.size, "数据库提交结果待核对，网站修改已暂停。");
    const r = await pool.connect();
    let committing = false;
    try {
      await r.query("BEGIN");
      await r.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        schema + ":" + operation,
      ]);
      const prior = await get("receipt", operation, r);
      if (prior) {
        await r.query("COMMIT");
        return prior.result;
      }
      const result = await fn(r);
      await put("receipt", { id: operation, result, at: Date.now() }, {}, r);
      committing = true;
      await r.query("COMMIT");
      return result;
    } catch (e) {
      await r.query("ROLLBACK").catch(() => {});
      let authoritative;
      try {
        authoritative = await get("receipt", operation);
      } catch {
        if (committing) uncertain.add(operation);
      }
      if (authoritative) return authoritative.result;
      throw e;
    } finally {
      r.release();
    }
  }
  async function message(room, value, r) {
    await r.query(
      `INSERT INTO ${messages}(room_id,sequence,id,author_id,client_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        room,
        value.sequence,
        value.id,
        value.authorId,
        value.clientId,
        crypt.seal("message", value.id, value),
      ],
    );
    return value;
  }
  async function duplicate(room, author, client, r = pool) {
    const row = (
      await r.query(
        `SELECT id,payload FROM ${messages} WHERE room_id=$1 AND author_id=$2 AND client_id=$3`,
        [room, author, client],
      )
    ).rows[0];
    return row ? crypt.open("message", row.id, row.payload) : null;
  }
  async function history(
    room,
    {
      after = 0,
      before = Number.MAX_SAFE_INTEGER,
      limit = 50,
      forward = false,
    } = {},
    r = pool,
  ) {
    const rows = (
      await r.query(
        `SELECT id,payload FROM ${messages} WHERE room_id=$1 AND sequence>$2 AND sequence<$3 ORDER BY sequence ${forward || after ? "ASC" : "DESC"} LIMIT $4`,
        [room, after, before, Math.min(100, limit)],
      )
    ).rows;
    const out = rows.map((row) => crypt.open("message", row.id, row.payload));
    return forward || after ? out : out.reverse();
  }
  async function updateMessage(value, r) {
    await r.query(`UPDATE ${messages} SET payload=$2,sequence=$3 WHERE id=$1`, [
      value.id,
      crypt.seal("message", value.id, value),
      value.sequence,
    ]);
  }
  async function findMessage(id, r = pool) {
    const row = (
      await r.query(`SELECT payload FROM ${messages} WHERE id=$1`, [id])
    ).rows[0];
    return row ? crypt.open("message", id, row.payload) : null;
  }
  async function purgeGroup(group,rooms,r){
    await r.query(`DELETE FROM ${messages} WHERE room_id=ANY($1::text[])`,[rooms]);
    const owned=new Set([group,...rooms]);
    const rows=(await r.query(`SELECT kind,id,payload FROM ${table} WHERE scope=$1 OR (kind='group' AND id=$1)`,[group])).rows;
    for(const row of rows)owned.add(row.id);
    for(const row of (await r.query(`SELECT id,payload FROM ${table} WHERE kind='receipt'`)).rows){
      const receipt=crypt.open('receipt',row.id,row.payload);
      const contains=v=>typeof v==='string'?owned.has(v):v&&typeof v==='object'?Object.values(v).some(contains):false;
      if(contains(receipt.result))await put('receipt',{id:row.id,result:{groupId:group,status:'deleted'},at:receipt.at},{},r);
    }
    await r.query(`DELETE FROM ${table} WHERE scope=$1 OR (kind='group' AND id=$1)`,[group]);
  }
  async function dump() {
    const r = await pool.connect();
    try {
      await r.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const records = (
          await r.query(`SELECT * FROM ${table} ORDER BY kind,id`)
        ).rows.map((x) => ({ ...x, payload: x.payload.toString("base64") })),
        msgs = (
          await r.query(`SELECT * FROM ${messages} ORDER BY room_id,sequence`)
        ).rows.map((x) => ({ ...x, payload: x.payload.toString("base64") }));
      await r.query("COMMIT");
      return { records, messages: msgs };
    } finally {
      r.release();
    }
  }
  async function reconcile() {
    for (const operation of uncertain) {
      await get("receipt", operation);
      uncertain.delete(operation);
    }
    return { recovered: true };
  }
  return {
    setGroupRepository: value => { groupRepository=value; },
    reconcile,
    uncertain,
    init,
    get,
    lookup,
    list,
    put,
    remove,
    tx,
    message,
    duplicate,
    history,
    updateMessage,
    findMessage,
    dump,
    purgeGroup,
    pool,
    schema,
  };
}
module.exports = { createRepository };
