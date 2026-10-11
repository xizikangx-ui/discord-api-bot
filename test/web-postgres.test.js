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
      await t.test('direct submission uses relevant versions, receipt recovery and concurrent independent grants',async()=>{
        const u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'单次提交隔离验收'},crypto.randomUUID());await app.games.ensure(g.id);
        const users=Array.from({length:50},()=>crypto.randomUUID());
        for(const id of users){await repo.put('user',{id,name:id,displayName:'隔离成员',version:1});await repo.put('member',{id:g.id+':'+id,groupId:g.id,userId:id,role:'player',active:true,version:1},{scope:g.id});}
        await app.games.store.transact(g.id,'direct-fixture',u.id,st=>{for(const uid of users){const p=M.newCharacter('隔离角色',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5});p.userId=uid;st.players[uid]=p;}return true;});
        for(const n of [20,50]){const view=await app.games.view(g.id,u.id),times=[];await Promise.all(users.slice(0,n).map(async(uid,i)=>{const begin=performance.now(),op=crypto.randomUUID(),params={rows:[{uid,characterId:view.roster.find(p=>p.userId===uid).id,type:'xp',quantity:1}]};const result=await app.games.execute(g.id,u.id,'grant',params,op,view.versions,true);assert.equal(result.status,'committed');times.push(performance.now()-begin);const duplicate=await app.games.execute(g.id,u.id,'grant',params,op,view.versions,true);assert.deepEqual(duplicate,result);const receipt=await app.games.operationReceipt(g.id,u.id,op);assert.deepEqual(receipt,result);}));times.sort((a,b)=>a-b);console.log(JSON.stringify({type:'direct-postgres-load',requests:n,resultP95ms:Math.round(times[Math.ceil(n*.95)-1]),environment:process.platform+' private Railway PG isolated namespaces, blocked renderer'}));}
        const stale=await app.games.view(g.id,u.id),params={rows:[{uid:users[0],characterId:stale.roster[0].id,type:'xp',quantity:1}]};params.rows[0].characterId=stale.player?.id||stale.roster.find(p=>p.userId===users[0]).id;
        await app.games.store.transact(g.id,'change-before-direct',u.id,st=>{st.players[users[0]].balance++;return true;});await assert.rejects(app.games.execute(g.id,u.id,'grant',params,crypto.randomUUID(),stale.versions,true),e=>e.code==='CONFLICT');
        const player=users[1],pv=await app.games.view(g.id,player);const done=await app.games.execute(g.id,player,'character.profile',{characterId:pv.player.id,data:{profile:{background:'保存一次'}}},crypto.randomUUID(),pv.versions);assert.equal(done.status,'committed');
        const secret=S.token(),csrf=S.token();await repo.put('session',{id:S.hash(secret),userId:player,csrf,expiresAt:Date.now()+60000},{scope:player});
        const webUser={secret,csrf},view=await app.games.view(g.id,player),operationId=crypto.randomUUID(),body={operationId,command:'character.profile',params:{characterId:view.player.id,data:{name:'一次保存的角色'}},versions:view.versions};
        const http=await call(webUser,'/groups/'+g.id+'/game/execute',body);assert.equal(http.status,200);assert.equal(http.data.status,'committed');assert.deepEqual((await call(webUser,'/groups/'+g.id+'/game/execute',body)).data,http.data);
        assert.equal((await call(webUser,'/groups/'+g.id+'/game/execute',{...body,params:{...body.params,data:{name:'不应覆盖'}}})).status,409);
        const Z=require('../src/rpg/conditions'),B=require('../src/rpg/combat');let index=0;
        await app.games.store.transact(g.id,'all-conditions-once',u.id,st=>{for(const t of Z.templates())for(const severity of Object.keys(t.levels)){const p=st.players[users[index++]];B.applyCondition(st,p,{id:t.id,severity},lo=>lo);}return true;});
        const before=require('../src/rpg/postgres').digest(await db.load(g.id));await app.games.store.recover(g.id);assert.equal(require('../src/rpg/postgres').digest(await db.load(g.id)),before);assert.equal(index,19);assert.equal(app.games.store.snapshot(g.id).conditionPackVersion,1);
      });
      await t.test('website manual battle ends atomically after saved defense, publishes summary once and restores the result',async()=>{
        const u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'自动结束隔离验收'},crypto.randomUUID());await app.games.ensure(g.id);
        const B=require('../src/rpg/combat'),H=require('../src/rpg/health');let bid;
        await app.games.store.transact(g.id,'auto-end-fixture',u.id,s=>{
          s.traits.neutral={id:'neutral',name:'无附加效果',effects:[],published:true,version:1};
          const p=M.newCharacter('终局验收角色',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:50,knowledge:5});p.userId=u.id;s.players[u.id]=p;
          const t=require('./helpers/rpg-harness').weapon(s,{hit:1000,damage:{physical:'1000'},weightKg:0});const item=M.issue(s,u.id,t.id)[0];M.equip(s,u.id,item.id);
          const b=B.createBattle(s,s.config.announcementChannelId,u.id,'手动战终局');bid=b.id;B.join(s,b,u.id);
          const enemy=M.newCharacter('最后敌人',{strength:1,constitution:1,mind:1,appearance:1,intelligence:1,agility:1,knowledge:1});enemy.hp=1;
          b.actors.push({id:'last-foe',name:enemy.name,team:'enemy',character:enemy,x:45,y:25,retreated:false,baseXP:10,ai:{mode:'manual'}});B.start(s,b,null,min=>min);return true;
        });
        const view=await app.games.view(g.id,u.id),b=view.battles[0],op=crypto.randomUUID(),params={battleId:bid,turnId:b.current.id,action:'attack',params:{abilityKey:b.abilities[0].key,targetId:'last-foe'}};
        const result=await app.games.execute(g.id,u.id,'battle.action',params,op,view.versions);assert.equal(result.status,'committed');const pending=app.games.store.snapshot(g.id).battles[bid];assert.ok(pending.pending);const count=structuredClone(pending.actionRound.counts);
        await app.games.store.transact(g.id,'last-defense',u.id,s=>B.defend(s,s.battles[bid],require('../src/rpg/aoe').hits(s.battles[bid])[0].id,'defend'));
        const final=app.games.store.snapshot(g.id),ended=final.battles[bid];assert.equal(ended.status,'ended');assert.equal(ended.outcome,'victory');assert.deepEqual(ended.actionRound.counts,count);assert.equal(Object.keys(final.deaths).length,1);assert.equal(ended.current,null);
        assert.deepEqual(await app.games.execute(g.id,u.id,'battle.action',params,op,view.versions),result);
        const rooms=await repo.list('room',g.id);let messages=[];
        for(let attempt=0;attempt<100;attempt++){await app.games.tick();messages=(await Promise.all(rooms.map(r=>repo.history(r.id,{after:0,before:Number.MAX_SAFE_INTEGER,limit:100})))).flat();if(messages.some(m=>m.system?.ended&&m.system.battleId===bid))break;await new Promise(r=>setTimeout(r,50));}
        assert.equal(messages.filter(m=>m.system?.ended&&m.system.battleId===bid).length,1);
        await app.games.store.recover(g.id);const restored=app.games.store.snapshot(g.id);assert.equal(restored.battles[bid].outcome,'victory');assert.equal(Object.keys(restored.deaths).length,1);assert.deepEqual(await app.games.operationReceipt(g.id,u.id,op),result);
      });
      await t.test('section API and chat commits keep gameplay versions independent with compressed public assets',async()=>{
        const u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'增量聊天隔离验收'},crypto.randomUUID());await app.games.ensure(g.id);
        const r=(await repo.list('room',g.id)).find(r=>r.kind==='chat');
        const before=app.games.versions(g.id),core=await call(admin,'/groups/'+g.id+'/game?sections=core');assert.equal(core.status,200);assert.equal(core.data.maps,undefined);assert.equal(core.data.actionHistory,undefined);assert.ok(core.data.sectionVersions.core!==undefined);
        assert.equal((await call(admin,'/groups/'+g.id+'/game?sections=private')).status,422);
        for(let i=0;i<20;i++)await app.chat.send(u.id,r.id,{clientId:crypto.randomUUID(),text:'增量聊天 '+i});
        assert.deepEqual(app.games.versions(g.id),before);
        const index=await fetch(origin),html=await index.text(),asset=html.match(/src="([^" ]+\.js)"/)[1],compressed=await fetch(origin+asset,{headers:{'accept-encoding':'gzip'}});assert.equal(compressed.headers.get('content-encoding'),'gzip');assert.match(compressed.headers.get('cache-control'),/immutable/);const tag=compressed.headers.get('etag');assert.equal((await fetch(origin+asset,{headers:{'accept-encoding':'gzip','if-none-match':tag}})).status,304);
      });
      async function accountsUser(){return app.accounts.user(admin.user.id);}
      await t.test('ended battle loot chat card survives restart, concurrent quick pickup and overweight rollback',async()=>{
        const B=require('../src/rpg/combat'),u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'战利品隔离验收'},crypto.randomUUID());await app.games.ensure(g.id);
        const partner=crypto.randomUUID();await repo.put('user',{id:partner,name:partner,displayName:'队友',version:1});await repo.put('member',{id:g.id+':'+partner,groupId:g.id,userId:partner,role:'player',active:true,version:1},{scope:g.id});
        const fixture=await app.games.store.transact(g.id,'loot-fixture',u.id,s=>{
          s.traits.neutral={id:'neutral',name:'无附加效果',effects:[],published:true,version:1};
          for(const uid of [u.id,partner]){s.players[uid]=M.newCharacter('拾荒者',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5});s.players[uid].userId=uid;}
          const b=B.createBattle(s,s.config.announcementChannelId,u.id,'已结束战斗',2,2);B.join(s,b,u.id);B.join(s,b,partner);B.endBattle(s,b);
          const t=require('./helpers/rpg-harness').weapon(s,{name:'战利品短剑',weightKg:1}),item=M.issue(s,u.id,t.id)[0];delete s.players[u.id].inventory[item.id];
          s.corpses.loot={id:'loot',battleId:b.id,name:'敌方拾荒者',items:[item],claims:{},eligible:{[u.id]:s.players[u.id].id,[partner]:s.players[partner].id}};
          return {battleId:b.id,itemId:item.id,roomId:b.channelId};
        },'测试战利品',{delivery:false});
        // Exercise startup backfill against a newly loaded store, without replaying the battle.
        const fresh=require('../src/web/games').createGames({database:db,repo,accounts:app.accounts,library:app.library,chat:app.chat,...gameCrypt});
        try{
          await fresh.ensure(g.id);let v=await fresh.view(g.id,u.id);assert.equal(v.battles.length,0);assert.equal(v.corpses[0].canClaim,true);
          await fresh.tick();await fresh.tick();let history=await app.chat.history(u.id,fixture.roomId,{after:0,before:Number.MAX_SAFE_INTEGER});
          assert.equal(history.filter(m=>m.system?.corpses).length,1);assert.equal(history.find(m=>m.system?.corpses).system.corpses[0].items[0].name,'战利品短剑');
          const originalId=history.find(m=>m.system?.corpses).id,params={corpseId:'loot',itemId:fixture.itemId},ops=[crypto.randomUUID(),crypto.randomUUID()],users=[u.id,partner];
          const op=crypto.randomUUID(),pv=await fresh.view(g.id,u.id),transact=fresh.store.transact;
          let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
          fresh.store.transact=async(...args)=>{if(args[1]==='web-direct:'+u.id+':'+op){enter();await gate;}return transact(...args);};
          const saving=fresh.execute(g.id,u.id,'character.profile',{characterId:pv.player.id,data:{profile:{background:'等待结果核对'}}},op,pv.versions);
          try{await entered;assert.equal((await fresh.operationReceipt(g.id,u.id,op)).status,'processing');}finally{release();fresh.store.transact=transact;}
          const savedResult=await saving;assert.deepEqual(await fresh.operationReceipt(g.id,u.id,op),savedResult);
          const views=await Promise.all(users.map(uid=>fresh.view(g.id,uid)));
          const claims=await Promise.allSettled(users.map((uid,i)=>fresh.execute(g.id,uid,'corpse.claim',params,ops[i],views[i].versions)));
          assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);const winner=claims.findIndex(x=>x.status==='fulfilled');assert.deepEqual(await fresh.execute(g.id,users[winner],'corpse.claim',params,ops[winner],views[winner].versions),claims[winner].value);
          assert.deepEqual(await fresh.operationReceipt(g.id,users[winner],ops[winner]),claims[winner].value);
          await fresh.tick();await fresh.tick();history=await app.chat.history(u.id,fixture.roomId,{after:0,before:Number.MAX_SAFE_INTEGER});const card=history.filter(m=>m.system?.corpses);assert.equal(card.length,1);assert.equal(card[0].id,originalId);assert.ok(card[0].system.corpses[0].claims[fixture.itemId]);
          await fresh.store.transact(g.id,'heavy-loot',u.id,s=>{const item={...structuredClone(s.corpses.loot.items[0]),id:'heavy',snapshot:{...s.corpses.loot.items[0].snapshot,name:'超重战利品',weight:10000000}};s.corpses.loot.items.push(item);return item.id;}).then(async itemId=>{v=await fresh.view(g.id,u.id);await assert.rejects(fresh.execute(g.id,u.id,'corpse.claim',{corpseId:'loot',itemId},crypto.randomUUID(),v.versions),/负重|超重/);assert.equal(fresh.store.snapshot(g.id).corpses.loot.claims[itemId],undefined);});
          const saved=fresh.store.snapshot(g.id);await fresh.store.recover(g.id);assert.deepEqual(fresh.store.snapshot(g.id).corpses,saved.corpses);
        }finally{await fresh.stop();await app.games.store.recover(g.id);}
      });
      await t.test('permanent deletion fences game writes, purges DM/content/media, resumes failed cleanup and retains other groups',async()=>{
        const u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'仅删除隔离测试团'},crypto.randomUUID());await app.games.ensure(g.id);
        const rooms=await repo.list('room',g.id),publicRoom=rooms.find(r=>r.kind==='chat');
        await app.chat.send(u.id,publicRoom.id,{clientId:crypto.randomUUID(),text:'必须永久清理的测试正文'});
        const key='test/'+crypto.randomUUID();storage.set(key,Buffer.from('private'));await repo.put('media',{id:crypto.randomUUID(),key,groupId:g.id,owner:u.id,status:'ready'},{scope:g.id});
        await content.put('proposal',{id:crypto.randomUUID(),groupId:g.id,template:{name:'未发布测试内容'}},{scope:g.id});
        const member=crypto.randomUUID();await repo.put('user',{id:member,name:'delete-qa',displayName:'隔离成员',version:1});await repo.put('member',{id:g.id+':'+member,groupId:g.id,userId:member,role:'player',active:true},{scope:g.id});
        const privateRoom=await app.chat.dm(await app.accounts.member(g.id,u.id),member);await app.chat.send(u.id,privateRoom.id,{clientId:crypto.randomUUID(),text:'必须清理的私聊'});
        const BK=require('../src/web/backup'),oldBackup=await BK.snapshot(pool,{names:{platform:schemas[0],content:schemas[1],game:schemas[2]}});
        const beforeOther=require('../src/rpg/postgres').digest(await db.load(other.id));
        await assert.rejects(app.deletion.start(await app.accounts.user(alice.user.id),g.id,{operationId:crypto.randomUUID(),baseVersion:g.version}),/管理员/);
        let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
        const write=app.games.store.transact(g.id,'already-entered',u.id,async st=>{entered();await gate;st.config.test=1;return true;});await started;
        const request={operationId:crypto.randomUUID(),baseVersion:g.version};const result=await app.deletion.start(u,g.id,request);assert.equal(result.status,'deleting');await assert.rejects(app.accounts.member(g.id,u.id),/不存在/);release();await write;await app.deletion.drain();
        const failed=await app.deletion.status(u,g.id);assert.equal(failed.status,'cleanup_error');assert.equal(await db.load(g.id),null);assert.equal(await repo.get('group',g.id),null);
        commands.DeleteObjectCommand=class{constructor(input){this.input=input;this.type='delete';}};const send=bucket.client.send;bucket.client.send=async c=>{if(c.type==='delete'){storage.delete(c.input.Key);return {};}return send(c);};
        const resumed=require('../src/web/group-deletion').createDeletion({repo,content,accounts:app.accounts,games:app.games,database:db,storage:bucket});await resumed.resume();assert.equal((await resumed.status(u,g.id)).status,'deleted');assert.equal(storage.has(key),false);
        assert.equal((await repo.list('room',g.id)).length,0);assert.equal((await content.list('proposal',g.id)).length,0);assert.equal((await repo.history(publicRoom.id)).length,0);assert.ok(await app.accounts.user(u.id));assert.equal(require('../src/rpg/postgres').digest(await db.load(other.id)),beforeOther);
        assert.equal((await app.deletion.start(u,g.id,request)).status,'deleted');await assert.rejects(app.games.store.transact(g.id,'late-write',u.id,()=>true),/删除/);await assert.rejects(app.chat.send(u.id,publicRoom.id,{clientId:crypto.randomUUID(),text:'旧连接'}));await assert.rejects(app.games.ensure(g.id));
        await assert.rejects(BK.restore(pool,oldBackup,{names:{platform:'web_test_restore_deleted_'+suffix,content:'web_test_restore_deleted_c_'+suffix,game:'rpg_test_restore_deleted_'+suffix}}),/永久删除/);
        await assert.rejects(content.put('proposal',{id:crypto.randomUUID(),groupId:g.id,template:{name:'迟到申请'}},{scope:g.id}),/删除/);assert.equal((await repo.history(privateRoom.id)).length,0);
        const tombstone=await repo.get('groupDeletion',g.id);assert.equal(tombstone.keys,undefined);assert.equal(tombstone.rooms,undefined);assert.doesNotMatch(JSON.stringify(tombstone),/正文|仅删除隔离测试团/);
      });
      await t.test('deletion waits for first game initialization and cannot resurrect an empty save',async()=>{
        const u=await accountsUser(),g=await app.accounts.createGroup(u,{name:'首次初始化并发删除验收'},crypto.randomUUID());
        let entered,release;
        const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),originalLoad=db.load;
        db.load=async id=>{if(id===g.id){entered();await gate;}return originalLoad(id);};
        try{
          const initializing=app.games.ensure(g.id);await started;
          await app.deletion.start(u,g.id,{operationId:crypto.randomUUID(),baseVersion:g.version});
          release();await assert.rejects(initializing,/删除/);await app.deletion.drain();
          assert.equal(await originalLoad(g.id),null);
          assert.equal((await app.deletion.status(u,g.id)).status,'deleted');
          await assert.rejects(app.games.ensure(g.id),/删除/);
          assert.equal(await originalLoad(g.id),null);
        }finally{release();db.load=originalLoad;}
      });
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
