"use strict";
// Isolated browser QA. Listens only on loopback and never connects to production.
const C = require("../../src/rpg/constants"),
  M = require("../../src/rpg/model"),
  crypto = require("node:crypto"),
  S = require("../../src/web/security");
function memoryRepository() {
  let records = new Map(),
    messages = new Map(),
    tail = Promise.resolve();
  const key = (k, id) => k + ":" + id;
  const repo = {
    schema: "web_test_demo",
    init: async () => {},
    get: async (k, id) => C.clone(records.get(key(k, id))?.value || null),
    lookup: async (k, lookup) =>
      C.clone(
        [...records.values()].find((r) => r.kind === k && r.lookup === lookup)
          ?.value || null,
      ),
    list: async (k, scope) =>
      [...records.values()]
        .filter(
          (r) => r.kind === k && (scope === undefined || r.scope === scope),
        )
        .map((r) => C.clone(r.value)),
    put: async (k, v, o = {}) => {
      records.set(key(k, v.id), { kind: k, value: C.clone(v), ...o });
      return v;
    },
    remove: async (k, id) => records.delete(key(k, id)),
    message: async (room, v) => {
      messages.set(v.id, C.clone(v));
      return v;
    },
    findMessage: async (id) => C.clone(messages.get(id) || null),
    updateMessage: async (v) => messages.set(v.id, C.clone(v)),
    duplicate: async (room, author, client) =>
      C.clone(
        [...messages.values()].find(
          (m) =>
            m.roomId === room && m.authorId === author && m.clientId === client,
        ) || null,
      ),
    history: async (
      room,
      { after = 0, before = Number.MAX_SAFE_INTEGER, limit = 50 } = {},
    ) => {
      const m = [...messages.values()]
        .filter(
          (m) => m.roomId === room && m.sequence > after && m.sequence < before,
        )
        .sort((a, b) => a.sequence - b.sequence);
      return C.clone(after ? m.slice(0, limit) : m.slice(-limit));
    },
    tx: (id, fn) => {
      const p = tail
        .catch(() => {})
        .then(async () => {
          const old = await repo.get("receipt", id);
          if (old) return old.result;
          const before = new Map(records),
            beforeMessages = new Map(messages);
          try {
            const result = await fn({ query: async () => ({ rows: [] }) });
            await repo.put("receipt", { id, result });
            return result;
          } catch (e) {
            records = before;
            messages = beforeMessages;
            throw e;
          }
        });
      tail = p;
      return p;
    },
    uncertain: new Set(),
  };
  return repo;
}
async function main() {
  process.env.WEB_TEST_DIAGNOSTICS = "1";
  const repo = memoryRepository(),
    content = memoryRepository(),
    states = new Map(),
    database = {
      assertLease() {},
      acquireLease: async () => {},
      load: async (id) => C.clone(states.get(id) || null),
      save: async (id, b, s) => states.set(id, C.clone(s)),
    },
    key = crypto.randomBytes(32).toString("base64"),
    crypt = S.codec(key),
    gameCrypt = S.rpgCodec(key),
    app = require("../../src/web/server").createWeb({
      database,
      repository: repo,
      contentRepository: content,
      crypt,
      gameCrypt,
      bootstrapHash: S.hash("demo-initializer"),
      allowHttp: true,
    });
  const a = await app.accounts.register(
      {
        name: "demo",
        displayName: "荒原指挥官",
        password: "local demo password",
        token: "demo-initializer",
      },
      true,
    ),
    u = await app.accounts.user(a.user.id),
    g = await app.accounts.createGroup(
      u,
      { name: "灰烬营地 · 第七远征队" },
      crypto.randomUUID(),
    );
  await app.games.ensure(g.id);
  await app.games.store.transact(g.id, "demo-seed", u.id, (s) => {
    require("../../src/rpg/content-pack").install(s);
    const p = M.newCharacter("林鸦", {
      strength: 6,
      constitution: 6,
      mind: 5,
      appearance: 4,
      intelligence: 5,
      agility: 6,
      knowledge: 5,
    });
    p.userId = u.id;
    p.gender = "female";
    p.balance = 1680;
    p.profile = { background: "在旧世界的边缘收集还未熄灭的故事。" };
    s.players[u.id] = p;
    require("../../src/rpg/health").ensure(p);
    for (const t of Object.values(s.catalog)
      .filter((t) => t.published && ["武器", "药品", "红色"].includes(t.kind))
      .slice(0, 4))
      try {
        M.issue(s, u.id, t.id, 1);
      } catch {}
    const cat = Object.values(s.mapCategories).find((t) => t.published),
      x = require("../../src/rpg/exploration"),
      m = x.create(
        s,
        u.id,
        s.config.announcementChannelId,
        "灰烬旧城",
        1,
        5,
        "random",
        cat.id,
        "region",
      );
    x.generate(s, m);
    x.publish(s, m);
    x.join(s, m, u.id);
    return true;
  });
  const room = (await repo.list("room", g.id)).find((c) => c.kind === "chat");
  await app.chat.send(u.id, room.id, {
    clientId: crypto.randomUUID(),
    text: "欢迎回到灰烬营地。地图、角色与聊天都在这里，故事由我们继续。",
  });
  await app.chat.send(u.id, room.id, {
    clientId: crypto.randomUUID(),
    kind: "rp",
    text: "林鸦拢紧风衣，抹去旧终端上的浮尘。信号灯仍在闪烁——远征队没有失联。",
  });
  await app.chat.send(u.id, room.id, {
    clientId: crypto.randomUUID(),
    kind: "dice",
    expression: "2d20+3",
    text: "侦察废墟",
  });
  const addr = await app.start(47840);
  app.server.prependListener("request", (req) => {
    req.headers.cookie = "web_session=" + a.secret;
  });
  app.server.prependListener("upgrade", (req) => {
    req.headers.cookie = "web_session=" + a.secret;
  });
  console.log("Local isolated browser QA: http://127.0.0.1:" + addr.port);
  process.on("SIGINT", () => void app.stop());
}
module.exports = { memoryRepository };
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
