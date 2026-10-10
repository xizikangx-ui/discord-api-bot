"use strict";
const crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  S = require("./security");
const definitions = {
  platform: { schema: "web_platform", tables: ["records", "messages"] },
  content: { schema: "web_content", tables: ["records", "messages"] },
  game: {
    schema: "rpg_web",
    tables: ["guilds", "objects", "audit", "receipts", "imports"],
  },
};
const valid = (s) =>
  /^(web_platform|web_content|rpg_web|web_test_[a-z0-9_]+|rpg_test_[a-z0-9_]+)$/.test(
    s,
  );
async function snapshot(pool, { names = {} } = {}) {
  const r = await pool.connect(),
    out = {
      format: "wasteland-web-backup-v1",
      at: Date.now(),
      sourceSchemas: {},
      namespaces: {},
    };
  try {
    await r.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const [key, d] of Object.entries(definitions)) {
      const schema = names[key] || d.schema;
      S.ok(valid(schema), "备份命名空间无效。");
      out.sourceSchemas[key] = schema;
      out.namespaces[key] = {};
      for (const table of d.tables) {
        const rows = (await r.query('SELECT * FROM "' + schema + '".' + table))
          .rows;
        out.namespaces[key][table] = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [
              k,
              Buffer.isBuffer(v) ? { base64: v.toString("base64") } : v,
            ]),
          ),
        );
      }
    }
    await r.query("COMMIT");
    return out;
  } catch (e) {
    await r.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    r.release();
  }
}
async function restore(pool, archive, { names } = {}) {
  S.ok(
    archive.format === "wasteland-web-backup-v1" && names,
    "请指定空的隔离恢复命名空间。",
  );
  const r = await pool.connect();
  try {
    await r.query("BEGIN");
    const source=archive.sourceSchemas?.platform||'web_platform';S.ok(valid(source),'备份来源命名空间无效。');
    const marks=(await r.query('SELECT id FROM "'+source+'".records WHERE kind=$1',['groupDeletion'])).rows;
    const groups=new Set((archive.namespaces.game.guilds||[]).map(g=>g.guild_id));
    for(const row of archive.namespaces.platform.records||[])if(row.kind==='group')groups.add(row.id);
    S.ok(!marks.some(m=>groups.has(m.id)),'备份包含已永久删除的团，禁止恢复以免复活。');
    for (const [key, d] of Object.entries(definitions)) {
      const schema = names[key];
      S.ok(
        (key === "game"
          ? /^rpg_test_restore_[a-z0-9_]+$/
          : /^web_test_restore_[a-z0-9_]+$/
        ).test(schema),
        "恢复演练须使用隔离命名空间。",
      );
      const runner = { query: (...args) => r.query(...args) };
      if (key === "game")
        await require("../rpg/postgres")
          .createPostgres({ pool: runner, schema })
          .init();
      else
        await require("./repository")
          .createRepository(runner, null, { schema })
          .init();
      for (const table of d.tables) {
        const target = '"' + schema + '".' + table;
        S.ok(
          Number(
            (await r.query("SELECT count(*) AS n FROM " + target)).rows[0].n,
          ) === 0,
          "恢复目标必须为空。",
        );
        for (const row of archive.namespaces[key][table]) {
          const keys = Object.keys(row);
          S.ok(
            keys.every((k) => /^[a-z_]+$/.test(k)),
            "备份字段无效。",
          );
          await r.query(
            "INSERT INTO " +
              target +
              "(" +
              keys.map((k) => '"' + k + '"').join(",") +
              ") VALUES(" +
              keys.map((_, n) => "$" + (n + 1)).join(",") +
              ")",
            keys.map((k) =>
              row[k]?.base64 ? Buffer.from(row[k].base64, "base64") : row[k],
            ),
          );
        }
      }
    }
    await r.query("COMMIT");
    return { restored: true };
  } catch (e) {
    await r.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    r.release();
  }
}
function createBackups({ pool, repo, crypt, storage, names }) {
  let timer, running;
  async function run(force = false) {
    if (running) return running;
    if (!storage.bucket) return;
    running = (async () => {
      const day = Math.floor(Date.now() / 86400000),
        week = Math.floor((day + 3) / 7),
        state = await repo.get("backup", "schedule");
      if (!force && state?.day === day) return;
      const id = Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
        archive = await snapshot(pool, { names }),
        images = archive.namespaces.platform.records
          .filter((row) => row.kind === "media")
          .map((row) =>
            crypt.open(
              "media",
              row.id,
              Buffer.from(row.payload.base64, "base64"),
            ),
          );
      archive.images = [];
      for (const image of images.filter((i) => i.status === "ready")) {
        const object = await storage.client.send(
            new storage.commands.GetObjectCommand({
              Bucket: storage.bucket,
              Key: image.key,
            }),
          ),
          bytes = await object.Body.transformToByteArray(),
          key = "backups/" + id + "/" + image.key;
        await storage.client.send(
          new storage.commands.PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: bytes,
          }),
        );
        archive.images.push({
          id: image.id,
          key,
          original: image.key,
          digest: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
      const zipped = zlib.gzipSync(Buffer.from(JSON.stringify(archive))),
        body = crypt.seal("backup", id, { gzip: zipped.toString("base64") }),
        key = "backups/" + id + "/manifest.enc";
      await storage.client.send(
        new storage.commands.PutObjectCommand({
          Bucket: storage.bucket,
          Key: key,
          Body: body,
        }),
      );
      const saved = {
        id,
        backupId: id,
        manifest: key,
        at: Date.now(),
        day,
        week,
        images: archive.images.length,
      };
      await repo.put("backup", saved);
      await repo.put("backup", { ...saved, id: "daily:" + day });
      if (!state || state.week !== week)
        await repo.put("backup", { ...saved, id: "weekly:" + week });
      await repo.put("backup", { ...saved, id: "schedule" });
      return saved;
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    run,
    start() {
      void run().catch(() => console.error("网站加密备份失败。"));
      timer = setInterval(
        () => void run().catch(() => console.error("网站加密备份失败。")),
        3600000,
      );
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
module.exports = { snapshot, restore, createBackups, definitions };
