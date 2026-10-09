"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  { Pool } = require("pg"),
  S = require("../src/web/security"),
  C = require("../src/rpg/constants"),
  M = require("../src/rpg/model");
test(
  "independent web service: real PostgreSQL permissions, concurrency and recovery",
  { skip: !process.env.RPG_TEST_DATABASE_URL },
  async (t) => {
    const suffix = crypto.randomBytes(6).toString("hex"),
      pool = new Pool({
        connectionString: process.env.RPG_TEST_DATABASE_URL,
        max: 5,
      }),
      crypt = S.codec(crypto.randomBytes(32).toString("base64")),
      gameCrypt = S.rpgCodec(crypto.randomBytes(32).toString("base64")),
      schemas = [
        "web_test_platform_" + suffix,
        "web_test_content_" + suffix,
        "rpg_test_web_" + suffix,
      ],
      repo = require("../src/web/repository").createRepository(pool, crypt, {
        schema: schemas[0],
      }),
      content = require("../src/web/repository").createRepository(pool, crypt, {
        schema: schemas[1],
      }),
      db = require("../src/rpg/postgres").createPostgres({
        pool,
        schema: schemas[2],
        ...gameCrypt,
      });
    const storage = new Map(),
      commands = {
        PutObjectCommand: class {
          constructor(input) {
            this.input = input;
            this.type = "put";
          }
        },
        GetObjectCommand: class {
          constructor(input) {
            this.input = input;
            this.type = "get";
          }
        },
      },
      bucket = {
        bucket: "isolated",
        commands,
        client: {
          async send(c) {
            if (c.type === "put") {
              storage.set(c.input.Key, c.input.Body);
              return {};
            }
            return {
              Body: {
                transformToByteArray: async () => storage.get(c.input.Key),
              },
            };
          },
        },
      };
    const app = require("../src/web/server").createWeb({
      pool,
      database: db,
      repository: repo,
      contentRepository: content,
      crypt,
      gameCrypt,
      bootstrapHash: S.hash("private-initializer"),
      allowHttp: true,
      storage: bucket,
      renderer: { queue: () => new Promise(() => {}), close() {} },
    });
    let origin, admin, alice, bob, group, other, room, gmRoom, dm, invite;
    const call = async (user, path, p) => {
      const r = await fetch(origin + "/api/web/v1" + path, {
        method: p === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "content-type": "application/json",
          ...(user
            ? { cookie: "web_session=" + user.secret, "x-web-csrf": user.csrf }
            : {}),
        },
        body: p === undefined ? undefined : JSON.stringify(p),
      });
      return { status: r.status, ...(await r.json()) };
    };
    async function register(name, code) {
      return app.accounts.register({
        name,
        password: "long isolated password",
        invite: code,
      });
    }
    try {
      const addr = await app.start(0);
      origin = "http://127.0.0.1:" + addr.port;
      await t.test(
        "initializer closes permanently; homepage and API are separate",
        async () => {
          admin = await app.accounts.register(
            {
              name: "owner",
              password: "long isolated password",
              token: "private-initializer",
            },
            true,
          );
          await assert.rejects(
            app.accounts.register(
              {
                name: "owner2",
                password: "long isolated password",
                token: "private-initializer",
              },
              true,
            ),
          );
          const home = await fetch(origin);
          assert.equal(home.status, 200);
          assert.match(await home.text(), /荒原档案/);
          assert.equal((await call(admin, "/unknown")).status, 404);
        },
      );
      await t.test(
        "single-use invitations cannot be raced; campaign assets are isolated",
        async () => {
          group = await app.accounts.createGroup(
            await app.accounts.user(admin.user.id),
            { name: "营地甲" },
            crypto.randomUUID(),
          );
          other = await app.accounts.createGroup(
            await app.accounts.user(admin.user.id),
            { name: "营地乙" },
            crypto.randomUUID(),
          );
          await app.games.ensure(group.id);
          await app.games.ensure(other.id);
          const a = await app.accounts.member(group.id, admin.user.id);
          invite = await app.accounts.invite(a);
          const attempts = await Promise.allSettled([
            register("alice", invite.code),
            register("bob", invite.code),
          ]);
          assert.equal(
            attempts.filter((r) => r.status === "fulfilled").length,
            1,
          );
          alice = attempts.find((r) => r.status === "fulfilled").value;
          bob = await register("third", (await app.accounts.invite(a)).code);
          await assert.rejects(app.accounts.member(other.id, alice.user.id));
          room = (await repo.list("room", group.id)).find(
            (r) => r.kind === "chat",
          );
          gmRoom = (await repo.list("room", group.id)).find(
            (r) => r.kind === "gm",
          );
          assert.equal(
            (await call(alice, "/groups/" + other.id + "/game")).status,
            403,
          );
          await assert.rejects(
            app.chat.history(alice.user.id, gmRoom.id, {
              after: 0,
              before: Number.MAX_SAFE_INTEGER,
            }),
          );
        },
      );
      await t.test(
        "GM creation HTTP accepts numeric map rows and validates independent battle recruitment",
        async () => {
          const createdGroup = await app.accounts.createGroup(
            await app.accounts.user(admin.user.id),
            { name: "创建入口验收" },
            crypto.randomUUID(),
          );
          await app.games.ensure(createdGroup.id);
          const categoryId = await app.games.store.transact(
            createdGroup.id,
            "map-category-fixture",
            admin.user.id,
            (s) => {
              const F = require("../src/rpg/forms"),
                f = F.create(s, admin.user.id, "mapcategory");
              f.data.name = "室内与区域";
              f.data.mapTypes = ["indoor", "region"];
              const cat=F.publish(s,f),room=F.create(s,admin.user.id,"room");room.data.name="快速房间";room.data.categoryIds=[cat.id];F.publish(s,room);return cat.id;
            },
          );
          const channelId = (await repo.list("room", createdGroup.id)).find(
            (r) => r.kind === "chat",
          ).id;
          const base = "/groups/" + createdGroup.id + "/gm",
            params = {
              name: "创建地图",
              channelId,
              categoryId,
              mapType: "indoor",
              mode: "manual",
              rows: 4,
              width: 3,
              blockedPercent: 15,
              stairsMin: 1,
              stairsMax: 3,
              maxRank: 3,
            };
          for (const mapType of ["indoor", "region"])
            for (const mode of ["manual", "fixed", "full"]) {
              const before = Object.keys(
                app.games.store.snapshot(createdGroup.id).explorations,
              ).length;
              const preview = await call(admin, base + "/previews", {
                command: "map.create",
                params: { ...params, mapType, mode },
                clientId: crypto.randomUUID(),
              });
              assert.equal(preview.status, 200, JSON.stringify(preview.error));
              assert.equal(
                Object.keys(
                  app.games.store.snapshot(createdGroup.id).explorations,
                ).length,
                before,
              );
              const result = await call(admin, base + "/commands", {
                draftId: preview.data.id,
              });
              assert.equal(result.status, 200, JSON.stringify(result.error));
              const duplicates = await Promise.all(
                Array.from({ length: 20 }, () =>
                  app.games.commit(createdGroup.id,admin.user.id,preview.data.id).then(data=>({status:200,data})),
                ),
              );
              assert.ok(
                duplicates.every(
                  (r) =>
                    r.status === 200 &&
                    r.data.result.id === result.data.result.id,
                ),
              );
              const current = await db.load(createdGroup.id),
                map = current.explorations[result.data.result.id];
              assert.equal(
                Object.keys(current.explorations).length,
                before + 1,
              );
              assert.equal(map.mapType, mapType);
              if (mode !== "full") {
                assert.equal(map.floors, 4);
                assert.equal(map.width, 3);
              }
              assert.doesNotThrow(() =>
                require("../src/rpg/exploration").validateMap(map),
              );
              assert.deepEqual(
                map.cells,
                app.games.store.snapshot(createdGroup.id).explorations[map.id]
                  .cells,
              );
            }
          for(const mapType of ['indoor','region'])for(const mode of ['manual','full','fixed']){
            const f=await call(admin,base+'/previews',{command:'map.quickCreate',params:{...params,mapType,mode},clientId:crypto.randomUUID()});assert.equal(f.status,200,JSON.stringify(f.error));
            const first=await call(admin,base+'/commands',{draftId:f.data.id});assert.equal(first.status,200,JSON.stringify(first.error));
            await Promise.all(Array.from({length:20},()=>app.games.commit(createdGroup.id,admin.user.id,f.data.id)));
            const stored=(await db.load(createdGroup.id)).explorations[first.data.result.id];assert.equal(stored.status,'draft');assert.equal(!!stored.generated,mode!=='fixed');assert.deepEqual(stored.cells,app.games.store.snapshot(createdGroup.id).explorations[stored.id].cells);
          }
          const opts=await call(admin,base+'/context/maps');assert.equal(opts.status,200);assert.ok(opts.data.categories.some(c=>c.id===categoryId&&c.usable));
          const battleParams = {
            name: "创建战斗",
            channelId,
            width: 3,
            height: 4,
          };
          const f = await call(admin, base + "/previews", {
            command: "battle.create",
            params: battleParams,
          });
          assert.equal(f.status, 200, JSON.stringify(f.error));
          assert.equal(
            Object.keys((await db.load(createdGroup.id)).battles).length,
            0,
          );
          const b = await call(admin, base + "/commands", {
            draftId: f.data.id,
          });
          assert.equal(b.status, 200, JSON.stringify(b.error));
          assert.equal(b.data.result.status, "recruiting");
          assert.equal(
            (await call(admin, base + "/commands", { draftId: f.data.id })).data
              .result.id,
            b.data.result.id,
          );
          assert.equal(
            (
              await call(admin, base + "/previews", {
                command: "battle.create",
                params: battleParams,
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await call(alice, base + "/previews", {
                command: "map.create",
                params,
              })
            ).status,
            403,
          );
          for (const command of ["grant", "templates.publish"])
            for (const rows of [4, {}, [null]]) {
              const invalid = await call(admin, base + "/previews", {
                command,
                params: { rows },
              });
              assert.equal(invalid.status, 422);
              assert.match(invalid.error.message, /列表|清单/);
              assert.doesNotMatch(
                invalid.error.message,
                /function|iterable|TypeError/,
              );
            }
          const invalid = await call(admin, base + "/previews", {
            command: "npc.portrait",
          });
          assert.equal(invalid.status, 422);
          assert.match(invalid.error.message, /参数格式/);
        },
      );
      await t.test(
        "private messages exclude GM; images require room and message permissions",
        async () => {
          dm = await app.chat.dm(
            await app.accounts.member(group.id, alice.user.id),
            bob.user.id,
          );
          await assert.rejects(app.chat.access(admin.user.id, dm.id));
          const image = await require("sharp")({
              create: { width: 4, height: 4, channels: 3, background: "red" },
            })
              .png()
              .toBuffer(),
            uploaded = await call(alice, "/groups/" + group.id + "/media", {
              roomId: dm.id,
              uploadId: crypto.randomUUID(),
              data: image.toString("base64"),
            });
          assert.equal(uploaded.status, 200);
          const sent = await app.chat.send(alice.user.id, dm.id, {
            clientId: crypto.randomUUID(),
            text: "私聊图片",
            attachments: [uploaded.data.id],
          });
          const read = await fetch(
            origin + "/api/web/v1/media/" + uploaded.data.id,
            { headers: { cookie: "web_session=" + bob.secret } },
          );
          assert.equal(read.status, 200);
          const denied = await fetch(
            origin + "/api/web/v1/media/" + uploaded.data.id,
            { headers: { cookie: "web_session=" + admin.secret } },
          );
          assert.equal(denied.status, 403);
          await app.chat.remove(alice.user.id, sent.id);
          assert.equal(
            (
              await fetch(origin + "/api/web/v1/media/" + uploaded.data.id, {
                headers: { cookie: "web_session=" + bob.secret },
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "20 concurrent messages and 50 duplicate submissions: ordered once, isolated from game queue",
        async () => {
          const times = [];
          await Promise.all(
            Array.from({ length: 20 }, async (_, n) => {
              const at = performance.now(),
                r = await call(alice, "/rooms/" + room.id + "/messages", {
                  clientId: crypto.randomUUID(),
                  text: "并发消息" + n,
                });
              assert.equal(r.status, 200);
              times.push(performance.now() - at);
            }),
          );
          const id = crypto.randomUUID(),
            replies = await Promise.all(
              Array.from({ length: 50 }, () =>
                app.chat.send(alice.user.id, room.id, {
                  clientId: id,
                  kind: "dice",
                  expression: "2d20",
                  text: "2d20",
                }),
              ),
            );
          assert.equal(new Set(replies.map((m) => m.id)).size, 1);
          assert.equal(
            new Set(replies.map((m) => JSON.stringify(m.dice))).size,
            1,
          );
          const h = await app.chat.history(alice.user.id, room.id, {
            after: 0,
            before: Number.MAX_SAFE_INTEGER,
          });
          assert.equal(h.length, 21);
          assert.equal(new Set(h.map((m) => m.sequence)).size, 21);
          times.sort((a, b) => a - b);
          console.log(
            JSON.stringify({
              test: "web-chat-private-postgres",
              concurrent: 20,
              duplicateBurst: 50,
              p95Ms: Math.ceil(times[18]),
              transport: "loopback HTTP; private PostgreSQL",
            }),
          );
          assert.ok(times[18] < 1000);
        },
      );
      await t.test(
        "duplicate game commits grant once; game state does not enter another campaign",
        async () => {
          await app.games.store.transact(
            group.id,
            "seed-test",
            admin.user.id,
            (s) => {
              for (const u of [alice, bob]) {
                const p = M.newCharacter("隔离玩家", {
                  strength: 5,
                  constitution: 5,
                  mind: 5,
                  appearance: 5,
                  intelligence: 5,
                  agility: 5,
                  knowledge: 5,
                });
                p.userId = u.user.id;
                s.players[p.userId] = p;
              }
              return true;
            },
          );
          const player = app.games.store.select(
              group.id,
              (s) => s.players[alice.user.id],
            ),
            f = await app.games.preview(
              group.id,
              admin.user.id,
              "grant",
              {
                rows: [
                  {
                    uid: alice.user.id,
                    characterId: player.id,
                    type: "points",
                    quantity: 3,
                  },
                ],
              },
              crypto.randomUUID(),
              true,
            ),
            before = player.points;
          const times = [];
          await Promise.all(
            Array.from({ length: 50 }, async () => {
              const at = performance.now(),
                r = await app.games.commit(group.id, admin.user.id, f.id);
              assert.equal(r.status, "committed");
              times.push(performance.now() - at);
            }),
          );
          assert.equal(
            (await db.load(group.id)).players[alice.user.id].points,
            before + 3,
          );
          assert.equal(
            (await db.load(other.id)).players[alice.user.id],
            undefined,
          );
          await app.games.store.recover(group.id);
          assert.equal(
            (await app.games.receipt(group.id, admin.user.id, f.id)).status,
            "committed",
          );
          times.sort((a, b) => a - b);
          console.log(
            JSON.stringify({
              test: "web-game-private-postgres",
              duplicateBurst: 50,
              p95Ms: Math.ceil(times[47]),
              blockedRenderer: true,
            }),
          );
          assert.ok(times[47] < 3000);
        },
      );
      await t.test(
        "20 different game submissions finish with notifications blocked",
        async () => {
          const participants = [];
          for (let n = 0; n < 20; n++) {
            const id = "load-" + suffix + "-" + n;
            await repo.put("user", {
              id,
              name: id,
              displayName: "并发角色" + n,
              password: {},
              version: 1,
            });
            await repo.put(
              "member",
              {
                id: group.id + ":" + id,
                userId: id,
                groupId: group.id,
                role: "player",
                active: true,
                version: 1,
              },
              { scope: group.id },
            );
            participants.push(id);
          }
          await app.games.store.transact(
            group.id,
            "seed-load",
            admin.user.id,
            (s) => {
              for (const uid of participants) {
                const p = M.newCharacter("压力角色", {
                  strength: 5,
                  constitution: 5,
                  mind: 5,
                  appearance: 5,
                  intelligence: 5,
                  agility: 5,
                  knowledge: 5,
                });
                p.userId = uid;
                s.players[uid] = p;
              }
              return true;
            },
          );
          const drafts = [],
            ack = [];
          for (const uid of participants) {
            const at = performance.now(),
              p = app.games.store.select(group.id, (s) => s.players[uid]),
              f = await app.games.preview(
                group.id,
                admin.user.id,
                "grant",
                {
                  rows: [
                    { uid, characterId: p.id, type: "points", quantity: 1 },
                  ],
                },
                crypto.randomUUID(),
                true,
              );
            drafts.push(f);
            ack.push(performance.now() - at);
          }
          let unblock;
          const pendingNotice = new Promise((r) => {
              unblock = r;
            }),
            off = app.games.store.onCommit(() => pendingNotice),
            times = [];
          await Promise.all(
            drafts.map(async (f) => {
              const at = performance.now();
              assert.equal(
                (
                  await call(admin, "/groups/" + group.id + "/game/commit", {
                    draftId: f.id,
                  })
                ).status,
                200,
              );
              times.push(performance.now() - at);
            }),
          );
          off();
          unblock();
          times.sort((a, b) => a - b);
          ack.sort((a, b) => a - b);
          assert.ok(ack[18] < 1000 && times[18] < 3000);
          console.log(
            JSON.stringify({
              test: "web-game-20-concurrent",
              previewP95Ms: Math.ceil(ack[18]),
              commitP95Ms: Math.ceil(times[18]),
              blockedNotifications: true,
              blockedRenderer: true,
            }),
          );
        },
      );
      await t.test(
        "NPC cards update one message; player action history retains every event",
        async () => {
          const a = await app.chat.upsertSystem(room.id, "npc:one", 1, {
              text: "行动一",
            }),
            b = await app.chat.upsertSystem(room.id, "npc:one", 2, {
              text: "行动二",
            }),
            old = await app.chat.upsertSystem(room.id, "npc:one", 1, {
              text: "过期行动",
            });
          assert.equal(a.id, b.id);
          assert.equal(old.text, "行动二");
          assert.equal((await repo.findMessage(a.id)).text, "行动二");
          assert.equal(
            (await repo.history(room.id, { after: a.sequence })).filter(
              (m) => m.id === a.id,
            ).length,
            1,
          );
        },
      );
      await t.test(
        "origin, CSRF and hidden-channel access are enforced",
        async () => {
          for (const headers of [
            { Origin: "https://outside.invalid", "x-web-csrf": admin.csrf },
            { Origin: origin, "x-web-csrf": "wrong" },
          ]) {
            const r = await fetch(
              origin + "/api/web/v1/groups/" + group.id + "/invite",
              {
                method: "POST",
                headers: {
                  ...headers,
                  cookie: "web_session=" + admin.secret,
                  "content-type": "application/json",
                },
                body: "{}",
              },
            );
            assert.equal(r.status, 403);
          }
          const hidden = await app.chat.create(
            await app.accounts.member(group.id, admin.user.id),
            { name: "限成员频道", kind: "chat", members: [alice.user.id] },
          );
          await assert.rejects(
            app.chat.history(bob.user.id, hidden.id, {
              after: 0,
              before: 99999,
            }),
            { code: "FORBIDDEN" },
          );
          await app.games.store.transact(
            group.id,
            "hidden-check",
            admin.user.id,
            (s) =>
              require("../src/rpg/activities").createCheck(
                s,
                admin.user.id,
                gmRoom.id,
                { name: "隐藏鉴定", rule: "d20", threshold: 5 },
              ),
          );
          assert.equal(
            (await app.games.view(group.id, alice.user.id)).checks.some(
              (c) => c.name === "隐藏鉴定",
            ),
            false,
          );
        },
      );
      await t.test(
        "websocket reconnect cursors retain order and deletion; permission revocation closes subscriptions",
        async () => {
          const { WebSocket } = require("ws");
          const connect = () =>
            new Promise((resolve, reject) => {
              const w = new WebSocket(origin.replace("http:", "ws:") + "/ws", {
                headers: {
                  Origin: origin,
                  Cookie: "web_session=" + bob.secret,
                },
              });
              w.once("open", () => resolve(w));
              w.once("error", reject);
            });
          const w = await connect();
          const room = await app.chat.create(
            await app.accounts.member(group.id, admin.user.id),
            { name: "实时权限测试", kind: "chat", members: [] },
          );
          const subscribed = new Promise((resolve) =>
            w.once("message", (data) => resolve(JSON.parse(data))),
          );
          w.send(
            JSON.stringify({
              type: "subscribe",
              groupId: group.id,
              roomId: room.id,
            }),
          );
          assert.equal((await subscribed).type, "subscribed");
          w.close();
          await new Promise((resolve) => w.once("close", resolve));
          let first;
          for (let n = 0; n < 67; n++) {
            const m = await app.chat.send(alice.user.id, room.id, {
              clientId: crypto.randomUUID(),
              text: "断线期间" + n,
            });
            first ||= m;
          }
          let cursor = 0,
            all = [];
          for (;;) {
            const batch = (
              await call(bob, "/rooms/" + room.id + "/messages?after=" + cursor)
            ).data;
            all.push(...batch);
            if (batch.length < 50) break;
            cursor = batch.at(-1).sequence;
          }
          assert.equal(all.length, 67);
          assert.equal(new Set(all.map((m) => m.sequence)).size, 67);
          const removed = await app.chat.remove(alice.user.id, first.id),
            delta = (
              await call(
                bob,
                "/rooms/" + room.id + "/messages?after=" + all.at(-1).sequence,
              )
            ).data;
          assert.equal(delta[0].id, first.id);
          assert.equal(delta[0].text, "");
          assert.equal(removed.sequence, 68);
          const live = await connect();
          const joined = new Promise((resolve) =>
            live.once("message", resolve),
          );
          live.send(
            JSON.stringify({
              type: "subscribe",
              groupId: group.id,
              roomId: room.id,
            }),
          );
          await joined;
          const closed = new Promise((resolve) =>
            live.once("close", (code) => resolve(code)),
          );
          await app.chat.update(
            await app.accounts.member(group.id, admin.user.id),
            room.id,
            {
              name: room.name,
              version: room.version,
              members: [alice.user.id],
            },
          );
          assert.equal(await closed, 4003);
        },
      );
      await t.test(
        "unclear platform commits recover the original receipt and safe recovery remains accessible",
        async () => {
          let disconnect = false,
            blockReads = false;
          const faulty = {
            query: (...args) =>
              blockReads
                ? Promise.reject(Error("offline"))
                : pool.query(...args),
            connect: async () => {
              const r = await pool.connect();
              return {
                release: () => r.release(),
                query: async (...args) => {
                  const result = await r.query(...args);
                  if (args[0] === "COMMIT" && disconnect) {
                    disconnect = false;
                    throw Error("lost commit acknowledgement");
                  }
                  return result;
                },
              };
            },
          };
          const f = require("../src/web/repository").createRepository(
            faulty,
            crypt,
            { schema: schemas[0] },
          );
          let executions = 0;
          disconnect = true;
          assert.equal(
            (
              await f.tx("after-commit", async (r) => {
                executions++;
                await f.put("fault-test", { id: "once", value: 1 }, {}, r);
                return { saved: true };
              })
            ).saved,
            true,
          );
          assert.equal(executions, 1);
          disconnect = true;
          blockReads = true;
          await assert.rejects(
            f.tx("unclear-commit", async () => ({ saved: true })),
          );
          assert.equal(f.uncertain.size, 1);
          await assert.rejects(f.tx("must-freeze", async () => {}));
          blockReads = false;
          await f.reconcile();
          assert.equal(f.uncertain.size, 0);
          assert.equal(
            (await f.get("receipt", "unclear-commit")).result.saved,
            true,
          );
          repo.uncertain.add("operator-reconcile");
          assert.equal(
            (await call(admin, "/groups/" + group.id + "/invite", {})).status,
            503,
          );
          assert.equal(
            (await call(admin, "/groups/" + group.id + "/gm/recover", {}))
              .status,
            200,
          );
          assert.equal(repo.uncertain.size, 0);
        },
      );
      await t.test(
        "web player executor creates characters and preserves AP, defense results and action RP",
        async () => {
          const B = require("../src/rpg/combat");
          await app.accounts.join(
            await app.accounts.user(bob.user.id),
            (
              await app.accounts.invite(
                await app.accounts.member(other.id, admin.user.id),
              )
            ).code,
          );
          const perform = async (uid, command, params) => {
            const f = await app.games.preview(
              other.id,
              uid,
              command,
              params,
              crypto.randomUUID(),
            );
            return app.games.commit(other.id, uid, f.id);
          };
          for (const u of [admin, bob]) {
            await perform(u.user.id, "character.roll", { name: "网页角色" });
            const d = app.games.store.select(
              other.id,
              (s) => s.characterDrafts[u.user.id],
            );
            await perform(u.user.id, "character.confirm", {
              draftId: d.id,
              gender: "female",
            });
          }
          const bid = await app.games.store.transact(
            other.id,
            "web-battle-fixture",
            admin.user.id,
            (s) => {
              const w = require("./helpers/rpg-harness").weapon(s, {
                hit: 100,
                damage: { physical: "1d2" },
                range: 50,
              });
              for (const u of [admin, bob]) {
                const item = M.issue(s, u.user.id, w.id)[0];
                M.equip(s, u.user.id, item.id);
              }
              const room = s.config.announcementChannelId,
                b = B.createBattle(
                  s,
                  room,
                  admin.user.id,
                  "网页规则测试",
                  2,
                  2,
                );
              B.join(s, b, admin.user.id);
              B.join(s, b, bob.user.id);
              B.position(b, b.actors[1].id, 26, 25, "enemy");
              let rollIndex = 0;
              B.start(
                s,
                b,
                null,
                (min, max) => min + (rollIndex++ % (max - min + 1)),
              );
              return b.id;
            },
          );
          let state = app.games.store.snapshot(other.id),
            b = state.battles[bid],
            actor = b.actors.find((a) => a.id === b.current.actorId),
            target = b.actors.find((a) => a.id !== actor.id),
            turn = b.current.id,
            ap = B.actorCharacter(state, actor).ap;
          const f = await app.games.preview(
            other.id,
            actor.userId,
            "battle.action",
            {
              battleId: bid,
              turnId: turn,
              action: "attack",
              params: {
                abilityKey: B.abilities(B.actorCharacter(state, actor))[0].key,
                targetId: target.id,
                action: "formal",
              },
              rp: "抬起武器，掩护同伴。",
            },
            crypto.randomUUID(),
          );
          const first = await app.games.commit(other.id, actor.userId, f.id);
          await app.games.commit(other.id, actor.userId, f.id);
          assert.equal(first.status, "committed");
          state = app.games.store.snapshot(other.id);
          b = state.battles[bid];
          assert.equal(B.actorCharacter(state, actor).ap, ap);
          const hit = require("../src/rpg/aoe").hits(b)[0];
          assert.ok(hit);
          await perform(target.userId, "battle.action", {
            battleId: bid,
            action: "defend",
            params: { hitId: hit.id, choice: "none" },
            rp: "护住身后的背包。",
          });
          state = await db.load(other.id);
          b = state.battles[bid];
          assert.equal(require("../src/rpg/aoe").hits(b).length, 0);
          assert.ok(
            b.publicEvents.some((e) =>
              e.rpEntries?.some((r) => r.text.includes("掩护同伴")),
            ),
          );
          assert.equal(state.players[admin.user.id].gender, "female");
        },
      );
      await t.test(
        "password recovery revokes devices, rotates recovery code and member removal is immediate",
        async () => {
          await app.accounts.recover({
            name: alice.user.name,
            recoveryCode: alice.recovery,
            password: "new isolated password",
          });
          await assert.rejects(app.accounts.session(alice.secret));
          await assert.rejects(
            app.accounts.recover({
              name: alice.user.name,
              recoveryCode: alice.recovery,
              password: "new isolated password",
            }),
          );
          const a = await app.accounts.member(group.id, admin.user.id),
            m = (await repo.list("member", group.id)).find(
              (m) => m.userId === bob.user.id,
            );
          await app.accounts.setMember(a, {
            userId: bob.user.id,
            role: "player",
            active: false,
            version: m.version,
          });
          await assert.rejects(app.chat.access(bob.user.id, dm.id));
        },
      );
      await t.test(
        "public review and sync reject stale previews and preserve local changes",
        async () => {
          const a = await app.accounts.member(group.id, admin.user.id);
          await app.games.store.transact(
            group.id,
            "library-fixture",
            admin.user.id,
            (s) => {
              s.glossaryTerms.term = {
                id: "term",
                name: "测试名词",
                description: "第一版",
                published: true,
                version: 1,
              };
              return true;
            },
          );
          const f = await app.library.propose(
            a,
            app.games.store.snapshot(group.id),
            { collection: "glossaryTerms", templateId: "term" },
          );
          await assert.rejects(
            app.library.approve({ id: alice.user.id, admin: false }, f.id, {}),
          );
          await app.library.approve(
            await app.accounts.user(admin.user.id),
            f.id,
            { baseVersion: 0, operationId: crypto.randomUUID() },
          );
          const preview = await app.games.sync(other.id, admin.user.id, {});
          assert.equal(preview.changes.length, 1);
          await app.games.sync(other.id, admin.user.id, {
            commit: true,
            preview,
            operationId: crypto.randomUUID(),
          });
          assert.equal(
            app.games.store.select(other.id, (s) => s.glossaryTerms.term.name),
            "测试名词",
          );
          await assert.rejects(
            app.games.sync(other.id, admin.user.id, {
              commit: true,
              preview,
              operationId: crypto.randomUUID(),
            }),
          );
        },
      );
      await t.test(
        "Discord public-library adapter previews, confirms and respects GM ownership without touching frozen assets",
        async () => {
          const previous = process.env.RPG_SHARED_LIBRARY_ENABLED,
            key = process.env.WEB_LIBRARY_KEY;
          process.env.RPG_SHARED_LIBRARY_ENABLED = "1";
          process.env.WEB_LIBRARY_KEY = "isolated-injection";
          const controller =
            require("../src/rpg/library-sync").createLibrarySync({
              store: app.games.store,
              contentRepository: content,
              client: { user: { id: admin.user.id } },
              needGM: (s, m) => assert.equal(m.gm, true),
              logFailure: (text, e) => {
                throw e;
              },
            });
          const i = {
            guildId: group.id,
            id: crypto.randomUUID(),
            user: { id: admin.user.id },
            member: { gm: true },
          };
          try {
            const before = app.games.store.select(group.id, (s) => s.players),
              panel = await controller.panel(i);
            assert.ok(panel.embeds?.length);
            const f = app.games.store.select(group.id, (s) =>
              Object.values(s.forms).find(
                (f) =>
                  f.kind === "publicLibrarySync" && f.owner === admin.user.id,
              ),
            );
            assert.ok(f.expiresAt - Date.now() <= 360000);
            await controller.component({
              ...i,
              id: crypto.randomUUID(),
              customId: "rpg:library:confirm:" + f.id,
            });
            assert.deepEqual(
              app.games.store.select(group.id, (s) => s.players),
              before,
            );
            await assert.rejects(
              controller.panel({
                ...i,
                id: crypto.randomUUID(),
                member: { gm: false },
              }),
            );
            controller.start();
            controller.stop();
            await controller.drain();
          } finally {
            if (previous === undefined)
              delete process.env.RPG_SHARED_LIBRARY_ENABLED;
            else process.env.RPG_SHARED_LIBRARY_ENABLED = previous;
            if (key === undefined) delete process.env.WEB_LIBRARY_KEY;
            else process.env.WEB_LIBRARY_KEY = key;
          }
        },
      );
      await t.test(
        "encrypted database and private images restore into empty isolated schemas",
        async () => {
          const BK = require("../src/web/backup"),
            names = {
              platform: schemas[0],
              content: schemas[1],
              game: schemas[2],
            },
            manager = BK.createBackups({
              pool,
              repo,
              crypt,
              storage: bucket,
              names,
            }),
            saved = await manager.run(true),
            sealed = storage.get(saved.manifest),
            archive = JSON.parse(
              require("node:zlib").gunzipSync(
                Buffer.from(
                  crypt.open("backup", saved.id, sealed).gzip,
                  "base64",
                ),
              ),
            );
          assert.ok(archive.images.length > 0);
          for (const image of archive.images) {
            const bytes = storage.get(image.key);
            assert.equal(
              crypto.createHash("sha256").update(bytes).digest("hex"),
              image.digest,
            );
          }
          const restored = {
            platform: "web_test_restore_p_" + suffix,
            content: "web_test_restore_c_" + suffix,
            game: "rpg_test_restore_" + suffix,
          };
          try {
            await BK.restore(pool, archive, { names: restored });
            const fresh = require("../src/web/repository").createRepository(
              pool,
              crypt,
              { schema: restored.platform },
            );
            assert.equal((await fresh.get("group", group.id)).name, "营地甲");
            const recoveredKeys =
              await require("../src/web/backup-cli").restoreImages(
                bucket,
                crypt,
                archive,
                fresh,
                "recovery/test/" + suffix + "/",
              );
            assert.equal(recoveredKeys.length, archive.images.length);
            for (const image of archive.images) {
              const media = await fresh.get("media", image.id);
              assert.ok(media.key.startsWith("recovery/test/"));
              assert.equal(S.hash(storage.get(media.key)), image.digest);
              assert.equal(
                S.hash(
                  Buffer.from(
                    crypt.open("image", image.id, storage.get(media.key)).data,
                    "base64",
                  ),
                ),
                media.hash,
              );
            }
            const reread = await BK.snapshot(pool, { names: restored });
            for (const key of Object.keys(names))
              for (const table of Object.keys(archive.namespaces[key]))
                assert.equal(
                  reread.namespaces[key][table].length,
                  archive.namespaces[key][table].length,
                );
            await assert.rejects(
              BK.restore(pool, archive, { names: restored }),
              /为空/,
            );
          } finally {
            for (const schema of Object.values(restored))
              await pool.query(
                'DROP SCHEMA IF EXISTS "' + schema + '" CASCADE',
              );
          }
        },
      );
      await t.test(
        "encrypted data can be read from fresh repositories after restart",
        async () => {
          const fresh = require("../src/web/repository").createRepository(
            pool,
            crypt,
            { schema: schemas[0] },
          );
          assert.equal((await fresh.get("group", group.id)).name, "营地甲");
          const bytes = (
            await pool.query(
              'SELECT payload FROM "' + schemas[0] + '".messages',
            )
          ).rows;
          assert.ok(
            bytes.every((r) => !r.payload.includes(Buffer.from("并发消息"))),
          );
        },
      );
    } finally {
      await app.stop();
      for (const schema of schemas)
        await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await db.close();
    }
  },
);
