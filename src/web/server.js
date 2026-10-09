"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const S = require("./security"),
  C = require("../rpg/constants"),
  G = require("../rpg/gm-service"),
  F = require("../rpg/forms");
const { body } = require("../rpg/gm-web");
function createWeb({
  pool,
  database,
  repository,
  contentRepository,
  crypt,
  gameCrypt,
  contentCrypt = crypt,
  bootstrapHash,
  origin,
  staticDir = path.resolve(__dirname, "../../web/dist"),
  storage = {},
  allowHttp = false,
  renderer: providedRenderer,
}) {
  const repo =
      repository || require("./repository").createRepository(pool, crypt),
    content =
      contentRepository ||
      require("./repository").createRepository(pool, contentCrypt, {
        schema: "web_content",
      });
  const sockets = new Set(),
    limits = new Map(),
    pending = new Map();
  let backups;
  let ready = false,
    server,
    websocket;
  const accounts = require("./accounts").createAccounts(repo, {
    bootstrapHash,
    changed: (uid) => {
      for (const ws of sockets)
        if (ws.userId === uid) ws.close(4001, "权限已变化");
    },
  });
  async function emit(scope, event, room = false) {
    await Promise.allSettled(
      [...sockets]
        .filter((ws) => (room ? ws.roomId === scope : ws.groupId === scope))
        .map(async (ws) => {
          try {
            await accounts.session(ws.credential);
            if (room) await chat.access(ws.userId, scope);
            else await accounts.member(scope, ws.userId);
            if (ws.bufferedAmount > 262144) {
              ws.close(1013, "请重新同步");
              return;
            }
            if (ws.readyState === 1) ws.send(JSON.stringify(event));
          } catch {
            ws.close(4003, "权限已失效");
          }
        }),
    );
  }
  const chat = require("./chat").createChat(repo, accounts, {
      broadcast: (room, event) => {
        void emit(room, event, true);
        if (["message", "deleted"].includes(event.type))
          void notifyUnread(room, event.data.sequence).catch(() => {});
      },
    }),
    library = require("./library").createLibrary(content),
    games = require("./games").createGames({
      database,
      repo,
      accounts,
      library,
      chat,
      ...gameCrypt,
      broadcast: (group, event) => void emit(group, event),
    });
  async function notifyUnread(roomId, sequence) {
    const room = await repo.get("room", roomId);
    if (!room) return;
    await Promise.allSettled(
      [...sockets]
        .filter(
          (ws) =>
            ws.groupId === room.groupId &&
            ws.roomId !== roomId &&
            ws.readyState === 1,
        )
        .map(async (ws) => {
          try {
            await accounts.session(ws.credential);
            await chat.access(ws.userId, roomId);
            if (ws.bufferedAmount > 262144) return ws.close(1013, "请重新同步");
            ws.send(
              JSON.stringify({
                type: "room-unread",
                data: { roomId, sequence },
              }),
            );
          } catch {
            /* A hidden channel must not reveal that a message exists. */
          }
        }),
    );
  }
  chat.setCharacterReader(async (g, u) => {
    await games.ensure(g);
    return games.store.select(g, (s) => s.players[u]);
  });
  const media = require("./media").createMedia(repo, crypt, {
      ...storage,
      chat,
      accounts,
      portraitAllowed: async (uid, group, id) => {
        const a = await accounts.member(group, uid);
        const s = games.store.snapshot(group);
        const has = (p) =>
          Object.values(p?.portraits || {}).some((f) => f.webMediaId === id);
        if (Object.values(s.players).some(has)) return true;
        if (
          ["admin", "gm"].includes(a.role) &&
          Object.values(s.npcTemplates).some(has)
        )
          return true;
        return Object.values(s.battles)
          .filter((b) => b.status !== "ended")
          .some((b) =>
            b.actors.some((actor) =>
              has(require("../rpg/combat").actorCharacter(s, actor)),
            ),
          );
      },
    }),
    renderer =
      providedRenderer ||
      require("../rpg/map-image").createRenderer({ logFailure: () => {} }),
    context = require("../rpg/gm-web-context").createContext({
      store: games.store,
      renderer,
    });
  const json = (res, status, value) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  const cookie = (req) =>
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("web_session="))
      ?.slice(12);
  function limit(key, max = 240) {
    const now = Date.now();
    let x = limits.get(key);
    if (!x || now - x.at > 60000) {
      x = { at: now, n: 0 };
      limits.set(key, x);
    }
    S.ok(++x.n <= max, "请求过于频繁，请稍后。", "RATE_LIMIT");
    if (limits.size > 5000)
      for (const [k, v] of limits) if (now - v.at > 60000) limits.delete(k);
  }
  function setSession(res, value) {
    res.setHeader(
      "set-cookie",
      "web_session=" +
        value +
        "; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000" +
        (allowHttp ? "" : "; Secure"),
    );
  }
  function checkOrigin(req) {
    S.ok(req.headers.origin === origin, "请求来源无效。", "FORBIDDEN");
  }
  async function route(req, res) {
    const started = performance.now();
    let isGM = false;
    try {
      const u = new URL(req.url, origin),
        api = u.pathname.startsWith("/api/web/v1/");
      if (u.pathname === "/healthz")
        return json(res, ready ? 200 : 503, { ready });
      if (u.pathname === "/privacy" && req.method === "GET") {
        const policy = await fs.promises.readFile(
          path.resolve(__dirname, "../../PRIVACY.md"),
          "utf8",
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        return res.end(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>荒原档案 · 隐私说明</title><style>body{background:#132023;color:#ddd;font:16px/1.8 system-ui;max-width:900px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' +
            policy
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;") +
            "</pre>",
        );
      }
      if (!api) {
        S.ok(req.method === "GET", "页面不存在。", "NOT_FOUND");
        S.ok(!u.pathname.startsWith("/api/"), "接口不存在。", "NOT_FOUND");
        const file = path.resolve(
            staticDir,
            "." + decodeURIComponent(u.pathname),
          ),
          selected = path.extname(file)
            ? file
            : path.join(staticDir, "index.html");
        S.ok(
          selected.startsWith(path.resolve(staticDir) + path.sep),
          "页面路径无效。",
          "NOT_FOUND",
        );
        let bytes;
        try {
          bytes = await fs.promises.readFile(selected);
        } catch {
          S.fail("页面不存在。", "NOT_FOUND");
        }
        res.writeHead(200, {
          "content-type":
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".svg": "image/svg+xml",
              ".png": "image/png",
            }[path.extname(selected)] || "application/octet-stream",
          "cache-control":
            path.extname(selected) === ".html"
              ? "no-cache"
              : "public,max-age=3600",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
        });
        return res.end(bytes);
      }
      S.ok(ready, "网站尚未准备好。", "UNAVAILABLE");
      const pth = u.pathname.slice("/api/web/v1".length),
        ip = S.hash(
          req.headers["x-real-ip"] || req.socket.remoteAddress || "local",
        );
      limit("ip:" + ip, 600);
      let p;
      if (req.method === "POST") {
        checkOrigin(req);
        database.assertLease();
        S.ok(
          !repo.uncertain.size || /^\/groups\/[^/]+\/gm\/recover$/.test(pth),
          "数据库结果待核对，网站修改已暂停。",
          "UNCERTAIN",
        );
        p = await body(
          req,
          pth.endsWith("/media") || pth.endsWith("/portraits")
            ? 6 * 1024 * 1024
            : 2 * 1024 * 1024,
        );
      }
      if (pth === "/auth/status" && req.method === "GET")
        return json(res, 200, {
          data: { initialized: (await repo.list("user")).some((x) => x.admin) },
        });
      if (
        [
          "/auth/login",
          "/auth/register",
          "/auth/bootstrap",
          "/auth/recover",
        ].includes(pth) &&
        req.method === "POST"
      ) {
        limit("auth:" + ip, 12);
        const result =
          pth === "/auth/login"
            ? await accounts.login(p)
            : pth === "/auth/recover"
              ? await accounts.recover(p)
              : await accounts.register(p, pth === "/auth/bootstrap");
        if (result.secret) setSession(res, result.secret);
        const { secret, ...safe } = result;
        return json(res, 200, { data: safe });
      }
      const auth = await accounts.session(cookie(req)),
        uid = auth.user.id;
      limit("user:" + uid);
      if (req.method === "POST") {
        S.ok(
          req.headers["x-web-csrf"] === auth.session.csrf,
          "请求校验失败，请重新登录。",
          "FORBIDDEN",
        );
        limit("write:" + uid, 120);
      }
      const answer = (value) => json(res, 200, { data: value });
      if (pth === "/admin/backup" && p) {
        accounts.admin(auth.user);
        return answer(await backups.run(true));
      }
      if (pth === "/auth/me")
        return answer({
          user: accounts.publicUser(auth.user),
          csrf: auth.session.csrf,
          expiresAt: auth.session.expiresAt,
        });
      if (pth === "/auth/logout" && p) {
        await repo.put(
          "session",
          { ...auth.session, revokedAt: Date.now() },
          { scope: uid },
        );
        setSession(res, "");
        return answer({ loggedOut: true });
      }
      if (pth === "/auth/password" && p)
        return answer(await accounts.changePassword(auth, p));
      if (pth === "/auth/devices" && !p)
        return answer(
          (await repo.list("session", uid)).map(({ csrf, ...s }) => ({
            ...s,
            current: s.id === auth.session.id,
          })),
        );
      if (pth === "/auth/devices/revoke" && p) {
        const s = await repo.get("session", p.id);
        S.ok(s?.userId === uid, "设备不属于你。", "FORBIDDEN");
        await repo.put(
          "session",
          { ...s, revokedAt: Date.now() },
          { scope: uid },
        );
        for (const ws of sockets)
          if (S.hash(ws.credential) === s.id) ws.close(4001, "设备已退出");
        return answer({ revoked: true });
      }
      if (pth === "/groups" && !p) {
        const groups = await repo.list("group"),
          mine = [];
        for (const g of groups) {
          try {
            const a = await accounts.member(g.id, uid);
            mine.push({ ...g, role: a.role });
          } catch {}
        }
        return answer(mine);
      }
      if (pth === "/groups" && p) {
        const g = await accounts.createGroup(auth.user, p, p.operationId);
        await games.ensure(g.id);
        return answer(g);
      }
      if (pth === "/groups/join" && p)
        return answer(await accounts.join(auth.user, p.code));
      if (pth === "/admin/users" && !p) {
        accounts.admin(auth.user);
        return answer((await repo.list("user")).map(accounts.publicUser));
      }
      if (pth === "/admin/reset" && p)
        return answer(await accounts.resetToken(auth.user, p.userId));
      if (pth === "/admin/user" && p) {
        accounts.admin(auth.user);
        S.ok(p.userId !== uid, "不能停用当前管理员。");
        const user = await repo.get("user", p.userId);
        S.ok(user, "账号不存在。", "NOT_FOUND");
        user.disabled = !!p.disabled;
        user.version++;
        await repo.tx("disable:" + crypto.randomUUID(), async (r) => {
          await repo.put("user", user, { lookup: S.hash(user.name) }, r);
          await accounts.revokeAll(user.id, r);
          return { saved: true };
        });
        for (const ws of sockets)
          if (ws.userId === user.id) ws.close(4001, "账号停用");
        return answer(accounts.publicUser(user));
      }
      if (pth === "/library" && !p) return answer(await library.published());
      if (pth === "/library/proposals" && !p) {
        accounts.admin(auth.user);
        return answer(await content.list("proposal"));
      }
      if (pth === "/library/review" && p)
        return answer(await library.approve(auth.user, p.id, p));
      if (pth.startsWith("/media/") && !p) {
        const bytes = await media.read(uid, pth.slice(7));
        res.writeHead(200, {
          "content-type": "image/webp",
          "cache-control": "private,no-store",
          "x-content-type-options": "nosniff",
        });
        return res.end(bytes);
      }
      if (pth.startsWith("/rooms/")) {
        const [, , roomId, action] = pth.split("/");
        if (action === "messages" && !p)
          return answer(
            await chat.history(uid, roomId, {
              after: Number(u.searchParams.get("after") || 0),
              forward: u.searchParams.has("after"),
              before: Number(
                u.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
              ),
              limit: 50,
            }),
          );
        if (action === "messages" && p) {
          limit("chat:" + uid, 60);
          return answer(await chat.send(uid, roomId, p));
        }
        if (action === "read" && p) {
          const { room } = await chat.access(uid, roomId);
          const sequence = Math.min(
            room.sequence,
            C.number(p.sequence, "已读位置", 0, Number.MAX_SAFE_INTEGER),
          );
          await repo.put(
            "read",
            { id: uid + ":" + roomId, sequence },
            { scope: uid },
          );
          return answer({ sequence });
        }
      }
      if (pth === "/messages/delete" && p)
        return answer(await chat.remove(uid, p.id));
      const parts = pth.split("/"),
        group = parts[2];
      S.ok(parts[1] === "groups" && group, "接口不存在。", "NOT_FOUND");
      const a = await accounts.member(group, uid),
        rest = "/" + parts.slice(3).join("/");
      isGM = ["admin", "gm"].includes(a.role);
      await games.ensure(group);
      if (rest === "/members" && !p) {
        const members = await repo.list("member", group),
          result = [];
        for (const m of members) {
          const user = await repo.get("user", m.userId);
          result.push({ ...m, name: user?.displayName || m.userId });
        }
        return answer(result);
      }
      if (rest === "/members" && p)
        return answer(await accounts.setMember(a, p));
      if (rest === "/invite" && p) return answer(await accounts.invite(a));
      if (rest === "/settings" && p) {
        return answer(
          await repo.tx("group-settings:" + crypto.randomUUID(), async (r) => {
            accounts.gm(await accounts.member(group, uid, r));
            const g = await repo.get("group", group, r, true);
            S.ok(g.version === p.version, "团配置已变化。", "CONFLICT");
            g.autoSync = p.autoSync !== false;
            if (p.announcement !== undefined)
              g.announcement = S.text(p.announcement, "公告", 4000, 0);
            g.description = S.text(
              p.description ?? g.description,
              "介绍",
              2000,
              0,
            );
            g.version++;
            await repo.put("group", g, {}, r);
            return g;
          }),
        );
      }
      if (rest === "/rooms" && !p) {
        const channels = await chat.rooms(group, uid),
          reads = await repo.list("read", uid);
        return answer(
          channels.map((c) => ({
            ...c,
            unread: Math.max(
              0,
              c.sequence -
                (reads.find((x) => x.id === uid + ":" + c.id)?.sequence || 0),
            ),
          })),
        );
      }
      if (rest === "/rooms" && p) return answer(await chat.create(a, p));
      if (rest === "/rooms/update" && p)
        return answer(await chat.update(a, p.id, p));
      if (rest === "/dm" && p) return answer(await chat.dm(a, p.userId));
      if (rest === "/media" && p) return answer(await media.upload(a, p));
      if (rest === "/media/reconcile" && p)
        return answer(await media.reconcile(a, p.id));
      if (
        !p &&
        ["/icons/", "/map-image/", "/battle-image/"].some((prefix) =>
          rest.startsWith(prefix),
        )
      ) {
        const type = rest.startsWith("/icons/")
            ? "icon"
            : rest.startsWith("/map-image/")
              ? "map"
              : "battle",
          id = rest.split("/")[2];
        if (type === "map")
          S.ok(
            games.store.select(
              group,
              (s) =>
                s.explorations[id]?.status !== "draft" && !!s.explorations[id],
            ),
            "地图不可查看。",
            "FORBIDDEN",
          );
        if (type !== "icon") {
          const channel = games.store.select(
            group,
            (s) =>
              (type === "map" ? s.explorations[id] : s.battles[id])?.channelId,
          );
          if (channel) await chat.access(uid, channel);
        }
        u.searchParams.delete("gm");
        const image = await context.media(
          { g: group },
          type + "/" + id,
          u.searchParams,
        );
        res.writeHead(200, {
          "content-type": image.type,
          "cache-control": "private,max-age=10",
        });
        return res.end(image.bytes);
      }
      if (rest === "/version" && !p)
        return answer({
          revision: games.store.select(group, (s) => s.revision),
        });
      if (rest === "/game" && !p) return answer(await games.view(group, uid));
      if (rest === "/game/preview" && p)
        return answer(
          await games.preview(
            group,
            uid,
            p.command,
            p.params || {},
            p.clientId,
          ),
        );
      if (rest === "/game/commit" && p) {
        const job = games.commit(group, uid, p.draftId),
          key = group + ":" + uid + ":" + p.draftId;
        pending.set(key, job);
        try {
          return answer(await job);
        } finally {
          pending.delete(key);
        }
      }
      if (rest.startsWith("/game/receipt/") && !p)
        return answer(
          await games.receipt(group, uid, rest.slice("/game/receipt/".length)),
        );
      if (rest === "/game/movement" && !p) {
        const s = games.store.snapshot(group),
          { b, a: actor } = require("./game-service").ownActor(
            s,
            uid,
            u.searchParams.get("battleId"),
          );
        if (b.channelId) await chat.access(uid, b.channelId);
        return answer({
          cells: await require("../rpg/movement-panel").reachable(s, b, actor),
          budget: b.current?.move,
          turnId: b.current?.id,
        });
      }
      if (rest === "/merchant/quote" && p) {
        S.ok(/^[a-zA-Z0-9_-]{8,100}$/.test(p.clientId || ""), "操作编号无效。");
        const channel = games.store.select(
          group,
          (s) => s.explorations[p.mapId]?.channelId,
        );
        if (channel) await chat.access(uid, channel);
        const result = await games.store.transact(
          group,
          "web-merchant-preview:" + uid + ":" + p.clientId,
          uid,
          async (s) => {
            await accounts.member(group, uid);
            return require("../rpg/merchant").quote(
              s,
              uid,
              p.mapId,
              p.cell,
              p.mode,
              p.itemId,
              p.quantity,
            );
          },
          "行商预览",
          { delivery: false },
        );
        return answer(result);
      }
      if (rest === "/merchant/commit" && p)
        return answer(
          await games.store.transact(
            group,
            "web-merchant:" + uid + ":" + p.id,
            uid,
            async (s) => {
              await accounts.member(group, uid);
              return require("../rpg/merchant").execute(s, uid, p.id);
            },
            "行商交易",
          ),
        );
      if (rest === "/library/sync" && p)
        return answer(await games.sync(group, uid, p));
      if (rest === "/library/propose" && p)
        return answer(await library.propose(a, games.store.snapshot(group), p));
      S.ok(rest.startsWith("/gm/"), "接口不存在。", "NOT_FOUND");
      accounts.gm(a);
      const gpath = rest.slice(3),
        s = games.store.snapshot(group);
      if (gpath === "/session")
        return answer({
          guildId: group,
          guildName: a.group.name,
          userId: uid,
          userName: a.user.displayName,
          revision: s.revision,
          canConfig: a.role === "admin",
          frozen: !!games.store.frozen(group),
          config: s.config,
        });
      if (gpath === "/schemas")
        return answer({
          kinds: Object.fromEntries(
            Object.entries(G.KINDS).filter(([k]) => k !== "rolepanel"),
          ),
          commands: require("../rpg/gm-web")
            .commandSchema()
            .filter(
              (c) => !["config.save", "publication.repair"].includes(c.id),
            ),
          attributeLabels: C.ATTRIBUTES,
          effectTargets: C.EFFECT_TARGETS.map((value) => ({
            value,
            label: C.targetLabel(value),
          })),
          conditionTargets: C.CONDITION_TARGETS.map((value) => ({
            value,
            label: C.targetLabel(value),
          })),
          severities: C.SEVERITIES,
          itemKinds: C.ITEM_KINDS.filter((k) => k !== "技能"),
          boxes: C.BOXES,
          categories: require("../rpg/item-categories").groups.map(
            ([value, label]) => ({ value, label }),
          ),
          defaults: context.defaults(),
        });
      if (gpath === "/directory")
        return answer({
          channels: (await chat.rooms(group, uid))
            .filter((c) => c.kind !== "dm")
            .map((c) => ({ id: c.id, name: c.name })),
          roles: [],
          texts: require("../rpg/texts")
            .definitions()
            .map((d) => ({
              ...d,
              value: require("../rpg/texts").get(s, d.key),
              version: s.config.textOverrides?.[d.key]?.version || 0,
            })),
        });
      if (gpath === "/fields" && p) {
        if (["coupon", "boss", "merchant", "glossary"].includes(p.kind))
          return answer(context.specialFields(p.kind));
        S.ok(G.KINDS[p.kind] && p.kind !== "rolepanel", "类型无效。");
        return answer(
          [
            ...F.fields({
              kind: p.kind,
              data: p.data || F.defaults(p.kind, p.itemKind),
            }),
            ...(p.kind === "npc"
              ? [
                  {
                    key: "equipmentPreset",
                    label: "初始装备槽位",
                    type: "equipmentPreset",
                  },
                  { key: "ai", label: "AI策略", type: "object" },
                ]
              : []),
          ].map((d) => ({
            ...d,
            predicate: undefined,
            options: ["refs", "multi", "choice", "conditions"].includes(d.type)
              ? F.options(s, d)
              : undefined,
          })),
        );
      }
      if (gpath === "/template" && p) {
        S.ok(G.KINDS[p.kind] && p.kind !== "rolepanel", "类型无效。");
        if (["coupon", "boss", "merchant", "glossary"].includes(p.kind)) {
          const t = s[G.KINDS[p.kind]][p.id];
          S.ok(t, "模板不存在。");
          return answer({ data: t, baseVersion: t.version });
        }
        const f = F.create(s, uid, p.kind, undefined, p.id);
        return answer({ ...f, baseVersion: f.baseTemplateVersion });
      }
      if (gpath.startsWith("/collections/")) {
        const source = gpath.slice(13),
          allowed = [
            ...Object.values(G.KINDS),
            "players",
            "explorations",
            "battles",
            "offers",
            "checks",
            "sessions",
            "deaths",
            "corpses",
            "forms",
            "events",
            "deliveryJobs",
            "lootPublications",
            "containerDefinitions",
            "couponRedemptions",
            "merchantTrades",
          ];
        S.ok(allowed.includes(source), "查询类型无效。");
        let all = Object.values(s[source] || {});
        if (source === "forms") all = all.filter((f) => f.owner === uid);
        const id = u.searchParams.get("id");
        if (id) {
          const item = all.find((x) => [x.id, x.userId, x.key].includes(id));
          S.ok(item, "对象不存在。");
          return answer({
            item:
              source === "players" ? { ...item, stats: Mstats(item) } : item,
            revision: s.revision,
          });
        }
        const q = (u.searchParams.get("q") || "").toLowerCase(),
          category = u.searchParams.get("category");
        all = all.filter((t) =>
          (t.name || t.title || t.label || t.id || t.key || "")
            .toLowerCase()
            .includes(q),
        );
        if (source === "catalog" && category)
          all = all.filter((t) =>
            require("../rpg/item-categories").matches(t, category, true),
          );
        if (source === "events") all.reverse();
        const size = C.number(u.searchParams.get("size") || 25, "每页", 1, 100),
          page = C.number(u.searchParams.get("page") || 0, "页", 0, 100000);
        return answer({
          revision: s.revision,
          total: all.length,
          items: all
            .slice(page * size, (page + 1) * size)
            .map((t) =>
              source === "players" ? { ...t, stats: Mstats(t) } : t,
            ),
        });
      }
      if (gpath === "/context/battle") {
        const b = s.battles[u.searchParams.get("id")];
        S.ok(b, "战斗不存在。");
        const actor = b.actors.find(
            (a) =>
              a.id === (u.searchParams.get("actorId") || b.current?.actorId),
          ),
          character =
            actor && require("../rpg/combat").actorCharacter(s, actor);
        return answer({
          actors: b.actors.map((a) => ({
            ...a,
            health: require("../rpg/health").snapshot(
              require("../rpg/combat").actorCharacter(s, a),
            ),
            nextCost: require("../rpg/combat").opportunityCost(b, a.id),
          })),
          character,
          current: b.current,
          abilities: character
            ? require("../rpg/combat").abilities(character)
            : [],
          pending: b.pending,
          judgment: b.judgment,
        });
      }
      if (gpath === "/drafts" && !p)
        return answer(
          Object.values(s.forms).filter(
            (f) => f.owner === uid && f.kind === "gmWebDraft",
          ),
        );
      if (gpath === "/drafts" && p)
        return answer(
          await games.store.transact(
            group,
            "web-draft:" + crypto.randomUUID(),
            uid,
            async (st) => {
              await accounts.member(group, uid).then(accounts.gm);
              const old = p.id && st.forms[p.id];
              S.ok(
                !p.id || (old?.owner === uid && old.kind === "gmWebDraft"),
                "草稿不属于你。",
              );
              if (old) G.version(old.version, p.version);
              const f = {
                id: p.id || C.id("f"),
                kind: "gmWebDraft",
                owner: uid,
                data: p.data,
                version: (old?.version || 0) + 1,
              };
              st.forms[f.id] = f;
              return f;
            },
            "保存网站GM草稿",
            { delivery: false },
          ),
        );
      if (gpath === "/previews" && p) {
        if (p.command === "npc.portrait")
          p.params.mediaId = p.params.mediaId || p.params.uploadId;
        return answer(
          await games.preview(
            group,
            uid,
            p.command,
            p.params,
            p.clientId || crypto.randomUUID(),
            true,
          ),
        );
      }
      if (gpath === "/commands" && p)
        return answer(await games.commit(group, uid, p.draftId));
      if (gpath.startsWith("/operations/"))
        return answer(await games.receipt(group, uid, gpath.split(":").at(-1)));
      if (gpath === "/recover" && p) {
        await repo.reconcile();
        await games.store.recover(group);
        return answer({
          status: "recovered",
          revision: games.store.select(group, (s) => s.revision),
        });
      }
      if (gpath === "/portraits" && p) return answer(await media.upload(a, p));
      if (gpath.startsWith("/media/")) {
        const result = await context.media(
          { g: group },
          gpath.slice(7),
          u.searchParams,
        );
        res.writeHead(200, {
          "content-type": result.type,
          "cache-control": "private,max-age=20",
          "x-content-type-options": "nosniff",
        });
        return res.end(result.bytes);
      }
      S.fail("接口不存在。", "NOT_FOUND");
    } catch (e) {
      if (res.writableEnded) return;
      const databaseError = /^[0-9A-Z]{5}$/.test(e.code || "");
      const status = databaseError
        ? 503
        : {
            UNAUTHORIZED: 401,
            FORBIDDEN: 403,
            NOT_FOUND: 404,
            CONFLICT: 409,
            RATE_LIMIT: 429,
            TOO_LARGE: 413,
            UNAVAILABLE: 503,
            UNCERTAIN: 503,
          }[e.code] || 422;
      json(res, status, {
        error: {
          code: databaseError ? "UNAVAILABLE" : e.code || "VALIDATION",
          message: databaseError
            ? "数据库暂时不可用，请查询原操作回执。"
            : e.message,
          details: isGM
            ? e.details
            : e.details?.map?.(({ source, id }) => ({ source, id })),
        },
      });
    } finally {
      if (performance.now() - started > 3000)
        console.log(
          JSON.stringify({
            metric: "web.slow",
            ms: Math.round(performance.now() - started),
          }),
        );
    }
  }
  const Mstats = (p) => require("../rpg/model").stats(p);
  async function start(
    port = Number(process.env.PORT || 47832),
    host = "127.0.0.1",
  ) {
    await repo.init();
    await content.init();
    await database.acquireLease("standalone-web");
    for (const g of await repo.list("group")) await games.ensure(g.id);
    server = http.createServer((req, res) => {
      void route(req, res);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    const { WebSocketServer } = require("ws");
    websocket = new WebSocketServer({
      noServer: true,
      maxPayload: 8192,
      perMessageDeflate: false,
    });
    server.on("upgrade", async (req, socket, head) => {
      try {
        S.ok(
          new URL(req.url, origin).pathname === "/ws" &&
            req.headers.origin === origin,
          "连接来源无效。",
        );
        S.ok(ready, "尚未准备好。");
        const a = await accounts.session(cookie(req));
        limit("ws:" + a.user.id, 30);
        websocket.handleUpgrade(req, socket, head, (ws) => {
          ws.userId = a.user.id;
          ws.credential = cookie(req);
          ws.alive = true;
          sockets.add(ws);
          ws.on("pong", () => {
            ws.alive = true;
          });
          ws.on("close", () => {
            sockets.delete(ws);
            if (ws.roomId)
              void emit(
                ws.roomId,
                {
                  type: "presence",
                  data: [
                    ...new Set(
                      [...sockets]
                        .filter((s) => s.roomId === ws.roomId)
                        .map((s) => s.userId),
                    ),
                  ],
                },
                true,
              );
          });
          ws.on("error", () => {});
          ws.on("message", async (bytes) => {
            try {
              limit("ws-message:" + ws.userId, 60);
              const p = JSON.parse(bytes);
              await accounts.session(ws.credential);
              S.ok(p.type === "subscribe", "实时接口仅供订阅。");
              if (p.groupId) await accounts.member(p.groupId, ws.userId);
              if (p.roomId) {
                const { room } = await chat.access(ws.userId, p.roomId);
                S.ok(room.groupId === p.groupId, "频道不属于此团。");
              }
              ws.groupId = p.groupId;
              ws.roomId = p.roomId;
              ws.send(
                JSON.stringify({
                  type: "subscribed",
                  data: { groupId: p.groupId, roomId: p.roomId },
                }),
              );
              if (p.roomId)
                await emit(
                  p.roomId,
                  {
                    type: "presence",
                    data: [
                      ...new Set(
                        [...sockets]
                          .filter((s) => s.roomId === p.roomId)
                          .map((s) => s.userId),
                      ),
                    ],
                  },
                  true,
                );
            } catch {
              ws.close(4003, "订阅无效");
            }
          });
        });
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    if (!origin) origin = "http://" + host + ":" + server.address().port;
    ready = true;
    games.start();
    const heartbeat = setInterval(async () => {
      for (const ws of sockets) {
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        try {
          await accounts.session(ws.credential);
          if (ws.groupId) await accounts.member(ws.groupId, ws.userId);
          if (ws.roomId) await chat.access(ws.userId, ws.roomId);
          ws.alive = false;
          ws.ping();
        } catch {
          ws.close(4003, "权限失效");
        }
      }
    }, 30000);
    heartbeat.unref();
    server.once("close", () => clearInterval(heartbeat));
    backups = require("./backup").createBackups({
      pool,
      repo,
      crypt,
      storage,
      names: {
        platform: repo.schema,
        content: content.schema,
        game: process.env.WEB_TEST_DIAGNOSTICS === "1" ? undefined : "rpg_web",
      },
    });
    if (process.env.WEB_TEST_DIAGNOSTICS !== "1") backups.start();
    return server.address();
  }
  async function stop() {
    ready = false;
    await backups?.stop();
    for (const ws of sockets) ws.close(1001, "网站维护");
    await games.stop();
    await Promise.allSettled([...pending.values()]);
    renderer.close();
    websocket?.close();
    if (server)
      await new Promise((resolve) => {
        server.closeIdleConnections();
        server.close(resolve);
      });
  }
  return {
    start,
    stop,
    route,
    repo,
    content,
    accounts,
    chat,
    library,
    games,
    renderer,
    get server() {
      return server;
    },
  };
}
module.exports = { createWeb };
if (require.main === module) {
  let app, db;
  const shutdown = async () => {
    await app?.stop();
    await db?.close();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  (async () => {
    S.ok(process.env.WEB_ENABLED === "1", "网站入口未启用。");
    S.ok(
      (process.env.WEB_PUBLIC_URL || "").startsWith("https://"),
      "网站生产网址必须使用HTTPS。",
    );
    const { Pool } = require("pg"),
      pool = new Pool({
        connectionString: process.env.WEB_DATABASE_URL,
        max: 5,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      }),
      crypt = S.codec(process.env.WEB_DATA_ENCRYPTION_KEY),
      contentCrypt = S.codec(process.env.WEB_CONTENT_ENCRYPTION_KEY),
      gameCrypt = S.rpgCodec(process.env.WEB_DATA_ENCRYPTION_KEY);
    db = require("../rpg/postgres").createPostgres({
      pool,
      schema: "rpg_web",
      ...gameCrypt,
      onLeaseLost: () => {
        void shutdown();
        process.exitCode = 1;
      },
    });
    let storage = {};
    if (process.env.WEB_BUCKET) {
      const aws = require("@aws-sdk/client-s3");
      storage = {
        bucket: process.env.WEB_BUCKET,
        client: new aws.S3Client({
          endpoint: process.env.WEB_S3_ENDPOINT,
          region: process.env.WEB_S3_REGION || "auto",
          forcePathStyle: true,
          maxAttempts: 2,
          requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
          credentials: {
            accessKeyId: process.env.WEB_S3_ACCESS_KEY,
            secretAccessKey: process.env.WEB_S3_SECRET_KEY,
          },
        }),
        commands: aws,
      };
    }
    const isolation = await pool.query(
      "SELECT has_schema_privilege(current_user,'rpg','USAGE') AS forbidden",
    );
    S.ok(!isolation.rows[0].forbidden, "网站数据库账号必须与Discord隔离。");
    app = createWeb({
      pool,
      database: db,
      crypt,
      gameCrypt,
      contentCrypt,
      bootstrapHash: process.env.WEB_BOOTSTRAP_HASH,
      origin: process.env.WEB_PUBLIC_URL,
      storage,
    });
    await app.start(Number(process.env.PORT || 3000), "0.0.0.0");
    console.log("独立跑团网站已就绪。");
  })().catch((e) => {
    console.error("网站启动失败：" + (e.code || "CONFIG"));
    process.exitCode = 1;
    void shutdown();
  });
}
