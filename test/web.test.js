"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const S = require("../src/web/security"),
  L = require("../src/web/library"),
  C = require("../src/rpg/constants"),
  M = require("../src/rpg/model"),
  P = require("../src/web/game-service");
test("website ciphertext authenticates both content and record identity", () => {
  const c = S.codec(crypto.randomBytes(32).toString("base64")),
    b = c.seal("message", "id", { text: "隐私内容" });
  assert.ok(!b.includes(Buffer.from("隐私内容")));
  assert.deepEqual(c.open("message", "id", b), { text: "隐私内容" });
  assert.throws(() => c.open("message", "another", b));
  const broken = JSON.parse(b);
  broken.data = Buffer.from("tampered").toString("base64");
  assert.throws(() =>
    c.open("message", "id", Buffer.from(JSON.stringify(broken))),
  );
});
test("passwords use asynchronous scrypt, unique salts and verification", async () => {
  const p = await S.password("a long test password");
  assert.equal(p.algorithm, "scrypt-131072-8-1");
  assert.equal(await S.password("a long test password", p), true);
  assert.equal(await S.password("another long password", p), false);
  assert.notEqual((await S.password("a long test password")).salt, p.salt);
  await assert.rejects(S.password("short"));
});
test("public library preserves modified templates and frozen inventory snapshots", () => {
  const s = C.newState("web-test"),
    t = { id: "item", name: "新版物品", published: true, version: 1 },
    entry = {
      id: "catalog:item",
      collection: "catalog",
      templateId: "item",
      version: 1,
      template: t,
    };
  L.applySync(s, [entry], L.planSync(s, [entry]));
  const frozen = JSON.parse(JSON.stringify(t));
  s.players.a = { inventory: { i: { snapshot: frozen } } };
  s.catalog.item.name = "本地修改";
  const next = {
      ...entry,
      version: 2,
      template: { ...t, name: "公共更新", version: 2 },
    },
    preview = L.planSync(s, [next]);
  assert.equal(preview.conflicts.length, 1);
  L.applySync(s, [next], preview);
  assert.equal(s.catalog.item.name, "本地修改");
  L.applySync(s, [next], L.planSync(s, [next]), {
    resolutions: { "catalog:item": "replace" },
  });
  assert.equal(s.catalog.item.name, "公共更新");
  assert.equal(frozen.name, "新版物品");
  assert.throws(() => L.applySync(s, [next], preview), /变化/);
});
test("public library missing dependencies are held for GM resolution", () => {
  const s = C.newState("web-test"),
    e = {
      id: "roomTemplates:r",
      collection: "roomTemplates",
      templateId: "r",
      version: 1,
      template: { id: "r", npcIds: ["missing"] },
    };
  const p = L.planSync(s, [e]);
  assert.equal(p.changes.length, 0);
  assert.equal(p.conflicts[0].reason, "缺少依赖");
});
test("public synchronization keeps local versions monotonic without creating false local conflicts", () => {
  const state = C.newState("library-versions");
  state.catalog.item = {
    id: "item",
    name: "旧本地",
    version: 18,
    published: true,
  };
  const entry = {
    id: "catalog:item",
    collection: "catalog",
    templateId: "item",
    version: 1,
    template: { id: "item", name: "公共内容", version: 1, published: true },
  };
  L.applySync(state, [entry], L.planSync(state, [entry]), {
    resolutions: { "catalog:item": "replace" },
  });
  assert.equal(state.catalog.item.version, 19);
  const next = {
    ...entry,
    version: 2,
    template: { ...entry.template, version: 2, name: "第二版" },
  };
  assert.equal(L.planSync(state, [next]).conflicts.length, 0);
  L.applySync(state, [next], L.planSync(state, [next]));
  assert.equal(state.catalog.item.version, 20);
  assert.equal(state.catalog.item.name, "第二版");
});
test("website player projection does not expose unvisited rooms or unopened container contents", () => {
  const s = C.newState("web-test"),
    p = M.newCharacter("玩家", {
      strength: 5,
      constitution: 5,
      mind: 5,
      appearance: 5,
      intelligence: 5,
      agility: 5,
      knowledge: 5,
    });
  p.userId = "a";
  s.players.a = p;
  s.explorations.map = {
    id: "map",
    name: "地图",
    status: "active",
    width: 2,
    floors: 1,
    participants: {},
    revealed: { "0,0": true },
    cells: {
      "0,0": {
        type: "room",
        room: {
          id: "r",
          snapshot: { name: "可见" },
          encounter: "resolved",
          containers: [
            {
              id: "box",
              box: "工具箱",
              status: "ready",
              result: { secret: "hidden" },
            },
          ],
          supplies: [],
        },
      },
      "1,0": { type: "room", room: { snapshot: { name: "秘密BOSS" } } },
    },
    rps: {},
  };
  const v = P.playerView(s, "a");
  assert.equal(v.maps[0].cells["1,0"].hidden, true);
  assert.equal(v.maps[0].cells["0,0"].room.containers[0].result, undefined);
  assert.ok(!JSON.stringify(v).includes("秘密BOSS"));
});
test('kill effects require actual enemy deaths, aggregate completed AOE and ignore duplicate/history publications',async()=>{
  const {eventDeaths}=require('../src/web/effects'),{freshKills}=await import('../web/src/kill-effects.js');
  const state={deaths:{d1:{battleId:'b',team:'enemy'},d2:{battleId:'b',team:'enemy'},ally:{battleId:'b',team:'ally'}}},attack={type:'attack',details:{children:[{result:{deathId:'d1',killed:true}},{result:null}]}};
  const b={id:'b',publicEvents:[attack]};assert.deepEqual(eventDeaths(state,b,attack),[]);
  assert.deepEqual(eventDeaths(state,b,{type:'death',details:{deathId:'d1',killed:true}}),[]);
  attack.details.children[1].result={deathId:'d2',killed:true};assert.deepEqual(eventDeaths(state,b,attack),['d1','d2']);
  assert.deepEqual(eventDeaths(state,b,{type:'death',details:{deathId:'missing',killed:true}}),[]);
  assert.deepEqual(eventDeaths(state,b,{type:'death',details:{deathId:'ally',killed:true}}),[]);
  const seen=new Set(),event={type:'message',data:{system:{event:attack,effectDeaths:['d1','d2']}}};assert.deepEqual(freshKills(event,seen,false),[]);assert.deepEqual(freshKills({...event,type:'history'},seen,true),[]);assert.deepEqual(freshKills(event,seen,true),['d1','d2']);assert.deepEqual(freshKills(event,seen,true),[]);
  const meta=await require('sharp')(require('node:path').join(__dirname,'../web/public/effects/kill-v1.gif')).metadata();assert.ok(meta.pages>=2&&meta.pages<=12);assert.equal(meta.loop,1);assert.ok(meta.delay.reduce((a,b)=>a+b,0)<=2100);assert.ok(require('node:fs').statSync(require('node:path').join(__dirname,'../web/public/effects/kill-v1.gif')).size<512*1024);
});

test('ended battle loot remains visible independently, with live eligibility and room permissions', () => {
  const {s,b}=require('./helpers/rpg-harness').fight(),Loot=require('../src/web/battle-loot');
  s.corpses.loot={id:'loot',battleId:b.id,name:'敌方拾荒者',items:[{id:'drop',quantity:2,snapshot:{name:'止血药',rarity:'green'}}],claims:{},eligible:{'1':s.players['1'].id,'2':s.players['2'].id}};
  let corpse=P.playerView(s,'1').corpses[0];assert.equal(corpse.canClaim,false);
  require('../src/rpg/combat').endBattle(s,b);
  const v=P.playerView(s,'1');assert.equal(v.battles.length,0);assert.equal(v.corpses.length,1);assert.equal(v.corpses[0].battleName,b.name);assert.equal(v.corpses[0].canClaim,true);assert.equal(v.corpses[0].items[0].name,'止血药');
  assert.equal(P.playerView(s,'1',{roomIds:new Set()}).corpses.length,0);
  assert.equal(P.playerView(s,'3').corpses.length,0);
  s.players['1'].hp=0;assert.equal(Loot.view(s,s.corpses.loot,'1').canClaim,false);
  s.players['1'].hp=1;s.corpses.loot.eligible['1']='old-character';assert.equal(Loot.view(s,s.corpses.loot,'1').canClaim,false);
  b.exploration={mapId:'missing',cell:'0,0'};assert.equal(Loot.view(s,s.corpses.loot,'2').ready,false);
});

test('battle loot publication merges claims, backfills only unclaimed ended loot and resumes by stable key', () => {
  const {s,b}=require('./helpers/rpg-harness').fight(),{derive}=require('../src/web/games'),Loot=require('../src/web/battle-loot');
  s.corpses.loot={id:'loot',battleId:b.id,name:'敌方',items:[{id:'drop',snapshot:{name:'战利品'}}],claims:{},eligible:{'1':s.players['1'].id}};
  const before=structuredClone(s);require('../src/rpg/combat').endBattle(s,b);s.revision++;
  derive(before,s);const key='web:corpses:'+b.id;assert.equal(s.deliveryJobs[key].kind,'webCorpses');assert.equal(s.deliveryJobs[key].roomId,b.channelId);
  s.deliveryJobs[key].status='done';assert.equal(Loot.needsBackfill(s),false);
  const claimBefore=structuredClone(s);s.corpses.loot.claims.drop={userId:'1',characterId:s.players['1'].id};s.revision++;derive(claimBefore,s);
  assert.equal(s.deliveryJobs[key].status,'pending');assert.equal(s.deliveryJobs[key].desiredRevision,s.revision);assert.equal(Loot.forBattle(s,b.id)[0].claims.drop.name,s.players['1'].name);
  delete s.deliveryJobs[key];assert.equal(Loot.needsBackfill(s),false);delete s.corpses.loot.claims.drop;assert.equal(Loot.needsBackfill(s),true);
  s.deliveryJobs={};const restored=structuredClone(s);derive(restored,s);assert.equal(s.deliveryJobs[key].status,'pending');
  const jobs=structuredClone(s.deliveryJobs);derive(structuredClone(s),s);assert.deepEqual(s.deliveryJobs,jobs);
});

test('unread and pending notifications navigate without executing a game operation',async()=>{
  const {notificationTarget:target}=await import('../web/src/notification-target.js');
  assert.equal(target(undefined),null);
  assert.equal(target({battleId:'b',kind:'webDefense'}).tab,'battle');
  assert.deepEqual(target({battleId:'b',kind:'webNotice'},true),{tab:'gm',gmTab:'battles',id:'b',type:'battle'});
  assert.equal(target({mapId:'m',kind:'webNotice'},true).tab,'gm');
  assert.equal(target({mapId:'m',kind:'webNotice'},false).tab,'explore');
  assert.deepEqual(target({source:'sessions'}),{tab:'activities'});
});
