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
  const metrics=require('./metrics').createMetrics();
  const repo =
      repository || require("./repository").createRepository(pool, crypt),
    content =
      contentRepository ||
      require("./repository").createRepository(pool, contentCrypt, {
        schema: "web_content",
      });
  content.setGroupRepository?.(repo);
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
    const knownRoom=room?await repo.get("room",scope):null,auths=new Map(),memberships=new Map();
    const once=(cache,key,fn)=>{if(!cache.has(key))cache.set(key,fn());return cache.get(key);};
    await Promise.allSettled(
      [...sockets]
        .filter((ws) => (room ? ws.roomId === scope : ws.groupId === scope))
        .map(async (ws) => {
          try {
            const auth=await once(auths,ws.credential,()=>accounts.session(ws.credential));
            const a=await once(memberships,ws.userId,()=>accounts.member(room?knownRoom?.groupId:scope,ws.userId,undefined,auth.user));
            if(room)await chat.access(ws.userId,scope,undefined,a,knownRoom);
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
      metrics,
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
  const deletion=require('./group-deletion').createDeletion({repo,content,accounts,games,database,storage,disconnected:group=>{for(const ws of sockets)if(ws.groupId===group)ws.close(4003,'此团正在删除');}});
  let deletionTimer;
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
        let encoding;
        for(const [name,suffix] of [['br','.br'],['gzip','.gz']])if(String(req.headers['accept-encoding']||'').split(',').some(v=>{const [n,q]=v.trim().split(';');return n===name&&!/q=0(?:\.0*)?$/.test(q||'');})){
          try{bytes=await fs.promises.readFile(selected+suffix);encoding=name;break;}catch{}
        }
        const etag='"'+crypto.createHash('sha256').update(bytes).digest('hex').slice(0,24)+'"';
        if(req.headers['if-none-match']===etag){res.writeHead(304,{etag,vary:'Accept-Encoding'});return res.end();}
        res.writeHead(200, {
          etag,vary:'Accept-Encoding',...(encoding?{'content-encoding':encoding}:{}),
          "content-type":
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".svg": "image/svg+xml",
              ".png": "image/png",
              ".gif": "image/gif",
              ".ttf": "font/ttf",
              ".woff2": "font/woff2",
            }[path.extname(selected)] || "application/octet-stream",
          "cache-control":
            path.extname(selected) === ".html"
              ? "no-cache"
              : /\/(assets|effects|fonts)\//.test(u.pathname)?"public,max-age=31536000,immutable":"public,max-age=3600",
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
      if(pth==='/preferences' && p){
        S.ok(['tactical','magic','psychic'].includes(p.artStyle),'请选择战术、魔法或精神风格。');
        return answer(await repo.tx('preferences:'+uid+':'+crypto.randomUUID(),async r=>{const u=await accounts.user(uid,r);u.preferences={artStyle:p.artStyle,killEffects:p.killEffects!==false};u.version++;await repo.put('user',u,{lookup:S.hash(u.name)},r);return u.preferences;}));
      }
      const deletePath=pth.match(/^\/admin\/groups\/([^/]+)\/(delete|deletion)$/);
      if(deletePath){accounts.admin(auth.user);return answer(deletePath[2]==='delete'&&p?await deletion.start(auth.user,deletePath[1],p):await deletion.status(auth.user,deletePath[1]));}
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
        const channels = await chat.rooms(group, uid,undefined,a),
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
        return answer(games.versions(group));
      if (rest === "/game" && !p) return answer(await games.view(group, uid,require('./game-sections').parse(u.searchParams.get('sections'))));
      if(['/game/execute','/gm/execute'].includes(rest)&&p){
        const key=group+':'+uid+':'+p.operationId;
        if(p.command==='npc.portrait'&&p.params)p.params.mediaId ||= p.params.uploadId;
        const job=games.execute(group,uid,p.command,p.params||{},p.operationId,p.versions,rest==='/gm/execute');pending.set(key,job);
        try{return answer(await job);}finally{if(pending.get(key)===job)pending.delete(key);}
      }
      if(rest.startsWith('/game/operations/')&&!p){const op=rest.slice('/game/operations/'.length);return answer(pending.has(group+':'+uid+':'+op)?{status:'processing'}:await games.operationReceipt(group,uid,op));}
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
      if(rest==='/game/skill-check'&&p){
        try{const st=games.store.snapshot(group),P=require('./game-service'),{b}=P.ownActor(st,uid,p.battleId),x=P.normalizeAction(st,uid,p);require('../rpg/combat').validateOperation(st,b,{type:'attack',ability:x.abilityKey,target:x.targetId,group:x.action,firing:x.firing});return answer({available:true});}catch(e){return answer({available:false,reason:e.message});}
      }
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
          fingerprint:require("../rpg/movement-panel").fingerprint(s,b,actor),
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
      if(rest.startsWith('/merchant/receipt/')&&!p){
        const f=games.store.select(group,s=>s.forms[rest.slice('/merchant/receipt/'.length)]);
        S.ok(f?.kind==='merchantTrade'&&f.owner===uid,'交易回执不属于你。','FORBIDDEN');
        return answer({status:f.status==='done'?'committed':games.store.frozen(group)?'uncertain':'uncommitted',result:f.result});
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
            .map((c) => ({ id: c.id, name: c.name, kind:c.kind })),
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
      if (gpath === "/context/battle") return answer(require("../rpg/gm-context-data").battle(s,u.searchParams.get("id"),u.searchParams.get("actorId")));
      if (gpath === "/context/maps") return answer(require("../rpg/gm-context-data").mapOptions(s));
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
        S.ok(
          p.params && typeof p.params === "object" && !Array.isArray(p.params),
          "操作参数格式无效。",
        );
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
      if (gpath === "/portraits" && p) {
        const npc=s.npcTemplates[p.npcId];
        S.ok(npc && ["avatar","illustration"].includes(p.slot),"先选择NPC模板和图片位置。");
        const baseVersion=npc.version;
        const uploaded=await media.upload(a,p);
        return answer({...uploaded,baseVersion});
      }
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
    for (const g of await repo.list("group")) if(!g.deleting) await games.ensure(g.id);
    server = http.createServer((req, res) => {
      const done=metrics.start(req.url.startsWith('/api/')?'request.api':'request.static');res.once('finish',()=>{done();metrics.gauge('http.lastStatus',res.statusCode);});
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
    metrics.startReporting(pool);
    await library.installConditions();
    games.start();
    void deletion.resume();
    deletionTimer=setInterval(()=>void deletion.resume().catch(()=>{}),30000);deletionTimer.unref();
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
    metrics.stop();
    clearInterval(deletionTimer);
    await deletion.drain();
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
    deletion,
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
