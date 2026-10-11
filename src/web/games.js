"use strict";
const crypto = require("node:crypto"),
  C = require("../rpg/constants"),
  G = require("../rpg/gm-service"),
  M = require("../rpg/model"),
  B = require("../rpg/combat"),
  S = require("./security"),
  P = require("./game-service"),
  Loot = require("./battle-loot"),
  L = require("./library");
const Sections=require('./game-sections');
function needsLifecycle(s){return Object.values(s.battles).some(b=>B.terminalOutcome(s,b))||Object.values(s.explorations).some(m=>m.status==='active'&&Object.values(m.cells).some(c=>c.room?.encounter==='battle'&&s.battles[c.room.battleId]?.status==='ended'&&s.battles[c.room.battleId]?.outcome==='victory'));}
function derive(before, next) {
  next.deliveryJobs ||= {};
  for (const [id, b] of Object.entries(next.battles)) {
    const old = before.battles[id],
      known = new Set((old?.publicEvents || []).map((e) => e.id));
    if(b.status==='ended'&&old?.status!=='ended')next.deliveryJobs['web:end:'+id]={key:'web:end:'+id,kind:'webBattleEnd',battleId:id,roomId:b.channelId,status:'pending',desiredRevision:next.revision,priority:1};
    const corpses = Object.values(next.corpses || {}).filter(c => c.battleId === id),
      previousCorpses = Object.values(before.corpses || {}).filter(c => c.battleId === id),
      lootKey = "web:corpses:" + id;
    if (b.status === "ended" && corpses.some(c => c.items.length) &&
      (old?.status !== "ended" || G.fingerprint(corpses) !== G.fingerprint(previousCorpses) ||
        Loot.forBattle(next, id)[0]?.ready !== Loot.forBattle(before, id)[0]?.ready ||
        !next.deliveryJobs[lootKey] && corpses.some(c => c.items.some(i => !c.claims?.[i.id])))) {
      next.deliveryJobs[lootKey] = {
        key: lootKey, kind: "webCorpses", battleId: id, roomId: b.channelId,
        status: "pending", desiredRevision: next.revision, priority: 2,
      };
    }
    const previousHits = new Set(
      old
        ? require("../rpg/aoe")
            .hits(old)
            .map((h) => h.id)
        : [],
    );
    for (const hit of require("../rpg/aoe").hits(b))
      if (!previousHits.has(hit.id)) {
        const target = b.actors.find((a) => a.id === hit.targetId),
          key = "web:defense:" + id + ":" + hit.id;
        if (target?.userId)
          next.deliveryJobs[key] = {
            key,
            kind: "webDefense",
            battleId: id,
            roomId: b.channelId,
            targetId: target.id,
            hitId: hit.id,
            expiresAt: hit.expiresAt,
            text:
              target.name +
              "受到攻击，请打开战斗面板防守。截止 " +
              new Date(hit.expiresAt).toISOString(),
            status: "pending",
            desiredRevision: next.revision,
            priority: 0,
          };
      }
    for (const e of b.publicEvents || [])
      if (
        !known.has(e.id) ||
        (old?.publicEvents || []).find((x) => x.id === e.id)?.version !==
          e.version
      ) {
        const actor = b.actors.find((a) => a.id === e.actorId);
        if (actor && !actor.userId && b.npcCards?.[actor.id]?.eventId !== e.id)
          continue;
        const key =
          actor && !actor.userId
            ? "web:npc:" + id + ":" + actor.id
            : "web:event:" + id + ":" + e.id;
        next.deliveryJobs[key] = {
          key,
          kind: "webEvent",
          battleId: id,
          roomId: b.channelId,
          eventId: e.id,
          npcId: actor && !actor.userId ? actor.id : null,
          status: "pending",
          desiredRevision: next.revision,
          priority: 5,
        };
      }
    if (
      b.judgment &&
      G.fingerprint(b.judgment) !== G.fingerprint(old?.judgment)
    ) {
      const key = "web:judgment:" + id;
      next.deliveryJobs[key] = {
        key,
        kind: "webNotice",
        text: "全队倒地，等待GM裁决。",
        battleId: id,
        status: "pending",
        desiredRevision: next.revision,
        priority: 0,
      };
    }
  }
  for (const source of ["checks", "sessions"])
    for (const [id, value] of Object.entries(next[source] || {})) {
      if (G.fingerprint(value) === G.fingerprint(before[source]?.[id]))
        continue;
      const key = "web:" + source + ":" + id;
      next.deliveryJobs[key] = {
        key,
        kind: "webActivity",
        source,
        objectId: id,
        roomId: value.channelId,
        status: "pending",
        desiredRevision: next.revision,
        priority: 2,
      };
    }
  for (const [id, m] of Object.entries(next.explorations)) {
    const old = before.explorations[id];
    if (
      m.status !== "draft" &&
      (m.version !== old?.version || m.lastEvent !== old?.lastEvent)
    ) {
      const key = "web:map:" + id;
      next.deliveryJobs[key] = {
        key,
        kind: "webMap",
        mapId: id,
        roomId: m.channelId,
        status: "pending",
        desiredRevision: next.revision,
        priority: 3,
      };
    }
    for (const r of Object.values(m.rps || {})) {
      if (
        ["pending", "publishing"].includes(r.status) &&
        G.fingerprint(r) !== G.fingerprint(old?.rps?.[r.id])
      ) {
        const key = "web:rp:" + id + ":" + r.id;
        next.deliveryJobs[key] = {
          key,
          kind: r.status === "publishing" ? "webRP" : "webNotice",
          roomId: r.status === "publishing" ? m.channelId : undefined,
          mapId: id,
          rpId: r.id,
          text: "环境描述待GM发布：" + r.name,
          status: "pending",
          desiredRevision: next.revision,
          priority: 1,
        };
      }
    }
    for (const [cell, c] of Object.entries(m.cells)) {
      const r = c.room?.bossRequest;
      if (
        r &&
        G.fingerprint(r) !== G.fingerprint(old?.cells[cell]?.room?.bossRequest)
      ) {
        const key = "web:boss:" + id + ":" + cell;
        next.deliveryJobs[key] = {
          key,
          kind: "webNotice",
          mapId: id,
          cell,
          text: "BOSS房等待GM确认。",
          status: "pending",
          desiredRevision: next.revision,
          priority: 0,
        };
      }
    }
  }
  // Rules may enqueue a platform-neutral intent. Website workers never send it to Discord.
  for (const job of Object.values(next.deliveryJobs))
    if (!job.kind.startsWith("web") && job.status !== "done")
      job.status = "done";
}
function createGames({
  database,
  repo,
  accounts,
  library,
  chat,
  encrypt,
  decrypt,
  broadcast = () => {},
  metrics,
}) {
  const store = require("../rpg/store").createStore({
      database,
      systemActorId: "system:web",
      encrypt,
      decrypt,
      backgroundPublications: true,
      deriveDelivery: derive,
      metrics,
    }),
    loading = new Map(), stamps=new Map();
  let timer,
    pumping = false,
    stopped = false,
    pumpPromise, wakeAt=Infinity, scheduled=false;
  function versions(group){return store.select(group,s=>({revision:s.revision,sectionVersions:stamps.get(group)||Object.fromEntries(Object.keys(Sections.definitions).map(k=>[k,s.revision]))}));}
  function wake(delay=0){if(stopped||!scheduled)return;const at=Date.now()+delay;if(at>=wakeAt)return;clearTimeout(timer);wakeAt=at;timer=setTimeout(()=>{wakeAt=Infinity;pumpPromise=tick();},Math.max(0,delay));timer.unref();}
  async function ensure(id) {
    if (store.guilds().includes(id)) return;
    if (loading.has(id)) return loading.get(id);
    const job = store.initialize(id, async () => {
      const group = await repo.get("group", id);
      S.ok(group && !group.deleting && !(await repo.get("groupDeletion", id)), "跑团不存在或已删除。");
      let s = await database.load(id);
      if (!s) {
        s = C.newState(id);
        const rooms = await repo.list("room", id);
        s.config.rpChannelId = rooms.find((r) => r.kind === "gm")?.id;
        s.config.announcementChannelId = rooms.find(
          (r) => r.kind === "system",
        )?.id;
        s.platform = "web";
        require("../rpg/skills").migrate(s);
        require("../rpg/ammunition").migrate(s);
        const entries = await library.published();
        if (entries.some(e=>e.source!=="conditions-v1"))
          for (const collection of L.collections) if(collection!=="conditionTemplates")s[collection] = {};
        L.applySync(s, entries, L.planSync(s, entries));
        await database.save(id, null, s);
      }
      await store.load(id);
    });
    loading.set(id, job);
    try {
      await job;
      if(!stamps.has(id))stamps.set(id,versions(id).sectionVersions);
      if(store.select(id,needsLifecycle))await store.transact(id,'web-lifecycle-recover:'+store.select(id,s=>s.revision),'system:web',()=>({recovered:true}),'恢复战斗结束检查');
      if (store.select(id, Loot.needsBackfill))
        await store.transact(id, "web-loot-backfill-v1", "system:web", () => ({ queued: true }), "恢复战后战利品入口");
    } finally {
      loading.delete(id);
    }
  }
  async function authorize(group, user, gm = false) {
    const a = await accounts.member(group, user);
    if (gm) accounts.gm(a);
    await ensure(group);
    return a;
  }
  function operation(id) {
    S.ok(/^[a-zA-Z0-9_-]{8,100}$/.test(id || ""), "操作编号无效。");
    return id;
  }
  async function preview(group, uid, command, params, clientId, gm = false) {
    S.ok(typeof command === "string", "操作名称无效。");
    G.rowsFor(command, params);
    const a = await authorize(group, uid, gm);
    S.ok(gm || P.playerCommands[command], "操作不存在。");
    if (gm)
      S.ok(
        !["config.save", "publication.repair"].includes(command),
        "此配置使用网站成员和频道管理入口。",
      );
    await validateReferences(a, command, params, gm);
    return store.transact(
      group,
      "web-preview:" + uid + ":" + operation(clientId),
      uid,
      async (s) => {
        await authorize(group, uid, gm);
        let expiresAt = C.confirmationDeadline(300000),
          normalized = C.clone(params),
          display;
        if (!gm && command === "battle.action") {
          normalized.params = P.normalizeAction(s, uid, params);
          if (params.action === "defend") {
            const hit = require("../rpg/aoe").hit(
              s.battles[params.battleId],
              params.params.hitId,
            );
            S.ok(hit, "防守已结算。");
            expiresAt = Math.min(expiresAt, hit.expiresAt);
          }
          display = {
            action: params.action,
            params: normalized.params,
            rp: params.rp || "",
            note: "提交后一次执行，骰点不会在预览生成。",
          };
        } else if (gm && command === "templates.publish") {
          display = G.validateBatch(s, params.rows, uid);
        } else if (gm && command === "grant")
          display = G.grantBatch(C.clone(s), params.rows);
        else if (gm && command === "npc.portrait") {
          const t = s.npcTemplates[params.id];
          S.ok(
            t && ["avatar", "illustration"].includes(params.slot),
            "NPC或图片位置无效。",
          );
          G.version(t.version, params.baseVersion);
          display = { name: t.name, slot: params.slot, clear: !!params.clear };
        } else if (gm)
          display = require("../rpg/gm-web-preview").preview(
            s,
            uid,
            command,
            params,
          );
        else if (command === "coupon.redeem")
          display = require("../rpg/coupons").preview(
            C.clone(s),
            uid,
            params.poolId,
            params.selected,
          );
        else
          display = {
            operation: P.playerCommands[command],
            params,
            note: "确认后按当前规则执行；失败不消耗资源。",
          };
        const f = {
          id: C.id("wf"),
          kind: "webAction",
          owner: uid,
          gm,
          command,
          params: normalized,
          guards: gm
            ? G.guards(s, command, params)
            : P.playerGuards(s, uid, command, params),
          preview: display,
          canCommit:
            command === "grant" ||
            !Array.isArray(display) ||
            display.every((r) => r.success !== false),
          expiresAt,
          status: "ready",
          at: Date.now(),
        };
        s.forms[f.id] = f;
        return f;
      },
      "网站操作预览",
      { delivery: false },
    );
  }
  async function validateReferences(a, command, p, gm) {
    const rows = G.rowsFor(command, p);
    S.ok(p.users === undefined || Array.isArray(p.users), "参战玩家须为列表。");
    const channelIds = store.select(a.group.id, (s) =>
      [
        p.mapId && s.explorations[p.mapId]?.channelId,
        p.battleId && s.battles[p.battleId]?.channelId,
        command.startsWith("check.") && s.checks[p.id || p.checkId]?.channelId,
        command.startsWith("session.") &&
          s.sessions[p.id || p.sessionId]?.channelId,
        p.corpseId && s.battles[s.corpses[p.corpseId]?.battleId]?.channelId,
      ].filter(Boolean),
    );
    for (const id of new Set(channelIds)) await chat.access(a.user.id, id);
    if (p.channelId) {
      const room = await repo.get("room", p.channelId);
      S.ok(
        room?.groupId === a.group.id && room.kind !== "dm" && !room.archived,
        "请选择本团有效频道。",
      );
    }
    for (const id of [
      p.targetUid,
      ...(p.users || []),
      ...rows.filter((r) => r.uid).map((r) => r.uid),
    ].filter(Boolean))
      await accounts.member(a.group.id, id);
    if (
      (command === "character.portrait" && !p.clear) ||
      (command === "npc.portrait" && !p.clear)
    ) {
      const f = await repo.get("media", p.mediaId);
      S.ok(
        f &&
          f.owner === a.user.id &&
          f.groupId === a.group.id &&
          f.kind === "portrait" &&
          f.status === "ready",
        "请选择本人上传的图片。",
      );
    }
    if (gm && command === "templates.publish")
      S.ok(
        rows.every((r) => r.kind !== "rolepanel"),
        "网站身份请使用成员管理。",
      );
  }
  async function commit(group, uid, id) {
    await authorize(group, uid);
    const operationId = "web-action:" + uid + ":" + id;
    return store.transact(
      group,
      operationId,
      uid,
      async (s) => {
        const f = s.forms[id];
        S.ok(
          f?.kind === "webAction" && f.owner === uid,
          "操作不属于你。",
          "FORBIDDEN",
        );
        await authorize(group, uid, f.gm);
        if (f.status === "done") return f.result;
        S.ok(
          f.status === "ready" &&
            f.expiresAt > Date.now() &&
            f.canCommit !== false,
          "确认已失效，请重新选择。",
        );
        G.verifyGuards(s, f.guards);
        await validateReferences(
          await accounts.member(group, uid),
          f.command,
          f.params,
          f.gm,
        );
        return applyForm(s, uid, f, operationId);
      },
      "网站 · " + id,
    );
  }
  async function applyForm(s, uid, f, operationId) {
        let result;
        if (!f.gm && f.command === "battle.action") {
          const p = f.params,
            { b, a } = P.ownActor(s, uid, p.battleId),
            action = require("../rpg/action-drafts").create(s, uid, {
              battleId: b.id,
              actorId: a.id,
              turnId: p.turnId,
              action: p.action,
              params: p.params,
              expiresAt: f.expiresAt,
            });
          result = require("../rpg/action-drafts").execute(
            s,
            action.id,
            uid,
            p.rp || "",
          );
        } else if (f.command === "npc.portrait") {
          const t = s.npcTemplates[f.params.id];
          G.version(t.version, f.params.baseVersion);
          t.portraits ||= {};
          if (f.params.clear) delete t.portraits[f.params.slot];
          else t.portraits[f.params.slot] = { webMediaId: f.params.mediaId };
          t.version++;
          result = { id: t.id, version: t.version };
        } else
          result = f.gm
            ? G.apply(s, uid, f.command, f.params)
            : P.applyPlayer(s, uid, f.command, f.params);
        f.status = "done";
        f.done = true;
        f.result = {
          operationId,
          status: "committed",
          result: C.clone(result ?? null),
        };
        if (f.command === "loot.open" && result?.batchId) {
          s.deliveryJobs ||= {};
          const key = "web:loot:" + result.batchId;
          s.deliveryJobs[key] = {
            key,
            kind: "webLoot",
            uid,
            status: "pending",
            desiredRevision: s.revision + 1,
            priority: 4,
            text:
              (s.players[uid]?.name || "角色") +
              "开启" +
              (result.box === "card" ? "抽卡" : result.box) +
              "：\n" +
              result.items
                .map((i) => i.snapshot.name + " ×" + i.quantity)
                .join("\n") +
              (result.pending ? "\n超重，整批等待领取。" : ""),
            items: C.clone(result.items),
          };
        }
        if (f.gm && f.command === "session.retry") {
          const x = s.sessions[f.params.id];
          x.reminder.status = "sent";
          x.status = "notified";
          x.version++;
        }
        return f.result;
  }
  const directId=(uid,op)=>'wd_'+S.hash(uid+':'+op).slice(0,32);
  const inFlight = new Map(), operationKey = (group,uid,id) => group+":"+uid+":"+id;
  async function execute(...args) {
    const key = operationKey(args[0],args[1],args[4]);
    inFlight.set(key,(inFlight.get(key)||0)+1);
    try { return await executeNow(...args); }
    finally { const count=inFlight.get(key)-1;if(count)inFlight.set(key,count);else inFlight.delete(key); }
  }
  async function executeNow(group,uid,command,params,clientId,expected,gm=false) {
    operation(clientId);
    S.ok(typeof command==='string' && params && typeof params==='object' && !Array.isArray(params),'操作参数格式无效。');
    G.rowsFor(command,params);
    const a=await authorize(group,uid,gm);
    S.ok(gm || P.playerCommands[command],'操作不存在。');
    if(gm)S.ok(!['config.save','publication.repair'].includes(command),'请使用网站配置入口。');
    await validateReferences(a,command,params,gm);
    const id=directId(uid,clientId), operationId='web-direct:'+uid+':'+clientId;
    const prior=store.select(group,s=>s.forms[id]);if(prior)S.ok(prior.command===command && G.fingerprint(prior.originalParams)===G.fingerprint(params),"同一操作编号不可用于不同操作。","CONFLICT");
    const result=await store.transact(group,operationId,uid,async s=>{
      await authorize(group,uid,gm);
      const previous=s.forms[id];
      if(previous){S.ok(previous.command===command && G.fingerprint(previous.originalParams)===G.fingerprint(params),'同一操作编号不可用于不同操作。','CONFLICT');return previous.result;}
      const guards=gm?G.guards(s,command,params):P.playerGuards(s,uid,command,params);
      S.ok(expected && typeof expected==='object','页面版本缺失，请刷新后重新操作。','CONFLICT');
      const conflicts=guards.filter(g=>expected[g.source+':'+(g.id||'')]!==g.hash);
      if(conflicts.length){const e=Error('相关内容已变化，已保留输入。请核对最新状态后再次提交。');e.code='CONFLICT';e.details=conflicts.map(g=>({source:g.source,name:(g.id?s[g.source]?.[g.id]:null)?.name||'相关设置',current:g.id?s[g.source]?.[g.id]:undefined}));throw e;}
      await validateReferences(await accounts.member(group,uid),command,params,gm);
      const normalized=C.clone(params);let expiresAt=C.confirmationDeadline(300000);
      if(!gm && command==='battle.action'){
        normalized.params=P.normalizeAction(s,uid,params);
        if(params.action==='defend'){const hit=require('../rpg/aoe').hit(s.battles[params.battleId],normalized.params.hitId);S.ok(hit,'防守已结算。');expiresAt=Math.min(expiresAt,hit.expiresAt);}
      }
      const f={id,kind:'webAction',owner:uid,gm,command,params:normalized,originalParams:C.clone(params),guards,expiresAt,status:'ready',at:Date.now(),direct:true};
      s.forms[id]=f;
      return applyForm(s,uid,f,operationId);
    },'网站直接执行 · '+(P.playerCommands[command]||command));
    const saved=store.select(group,s=>s.forms[id]);S.ok(saved?.command===command && G.fingerprint(saved.originalParams)===G.fingerprint(params),'同一操作编号不可用于不同操作。','CONFLICT');
    return result;
  }
  async function operationReceipt(group,uid,clientId){
    await authorize(group,uid);operation(clientId);
    return store.select(group,s=>s.forms[directId(uid,clientId)]?.result||{status:store.frozen(group)?'uncertain':inFlight.has(operationKey(group,uid,clientId))?'processing':'uncommitted'});
  }
  async function receipt(group, uid, id) {
    await authorize(group, uid);
    return store.select(group, (s) => {
      const f = s.forms[id];
      S.ok(f?.owner === uid, "回执不属于你。", "FORBIDDEN");
      return (
        f.result || {
          operationId: "web-action:" + uid + ":" + id,
          status: store.frozen(group)
            ? "uncertain"
            : f.status === "ready"
              ? "uncommitted"
              : f.status,
        }
      );
    });
  }
  async function sync(group, uid, p) {
    await authorize(group, uid, true);
    const entries = await library.published();
    if (!p.commit) return store.select(group, (s) => L.planSync(s, entries));
    return store.transact(
      group,
      "web-sync:" + uid + ":" + operation(p.operationId),
      uid,
      async (s) => {
        await authorize(group, uid, true);
        return L.applySync(s, entries, p.preview, {
          resolutions: p.resolutions,
        });
      },
      "公共库同步",
      { delivery: false },
    );
  }
  async function publishJobs(group) {
    const tasks = store.select(group, (s) =>
        Object.values(s.deliveryJobs || {})
          .filter((j) => j.status === "pending" && j.kind.startsWith("web"))
          .sort((a, b) => a.priority - b.priority)
          .slice(0, 10),
      ),
      rooms = tasks.length ? await repo.list("room", group) : [],
      publicRoom = rooms.find((c) => c.kind === "system" && !c.archived),
      gmRoom = rooms.find((c) => c.kind === "gm" && !c.archived);
    for (const j of tasks) {
      const room = j.roomId
        ? rooms.find((r) => r.id === j.roomId && !r.archived)
        : j.kind === "webNotice"
          ? gmRoom
          : publicRoom;
      if (!room) continue;
      const s = store.select(group,st=>{
        const b=st.battles[j.battleId],mapId=j.mapId||b?.exploration?.mapId;
        return {players:Object.fromEntries(Object.entries(st.players).map(([id,p])=>[id,{id:p.id,name:p.name}])),
          battles:b?{[b.id]:b}:{},deaths:Object.fromEntries(Object.entries(st.deaths).filter(([,d])=>d.battleId===j.battleId)),
          corpses:Object.fromEntries(Object.entries(st.corpses).filter(([,c])=>c.battleId===j.battleId)),
          explorations:mapId?{[mapId]:st.explorations[mapId]}:{},
          ...(j.source?{[j.source]:{[j.objectId]:st[j.source]?.[j.objectId]}}:{})};
      });
      let text, system;
      if (j.kind === "webActivity") {
        const value = s[j.source]?.[j.objectId];
        if (!value) continue;
        text =
          (j.source === "checks" ? "鉴定 · " : "开团 · ") +
          value.name +
          "\n" +
          value.description +
          "\n状态：" +
          value.status;
        if (j.source === "checks")
          text +=
            "\n" +
            Object.values(value.attempts)
              .flat()
              .map(
                (a) =>
                  (s.players[a.userId]?.name || "角色") +
                  "：" +
                  a.total +
                  (a.success ? " 成功" : " 未通过") +
                  "（骰点 " +
                  a.roll.rolls.flatMap((r) => r.dice).join("/") +
                  "）",
              )
              .join("\n");
        else
          text +=
            "\n北京时间 " +
            require("../rpg/activities").beijing(value.startsAt) +
            " · 已报名 " +
            Object.keys(value.participants).length +
            " 人";
        system = { source: j.source, id: value.id };
      } else if (j.kind === "webEvent") {
        const b = s.battles[j.battleId],
          e = b?.publicEvents?.find((e) => e.id === j.eventId);
        if (!e) continue;
        text = e.text || e.description || e.message || "战斗操作已保存";
        system = {
          battleId: b.id,
          event: e,
          effectDeaths: require("./effects").eventDeaths(s,b,e),
          npcId: j.npcId,
          cardKey: j.npcId ? b.id + ":" + j.npcId : undefined,
        };
      } else if (j.kind === "webBattleEnd") {
        const b=s.battles[j.battleId];if(b?.status!=='ended')continue;
        const deaths=Object.values(s.deaths).filter(d=>d.battleId===b.id);
        text='战斗结束 · '+b.name+'\n'+({victory:'战斗胜利',defeat:'战斗失败'}[b.outcome]||'GM已结束战斗')+'\n'+deaths.filter(d=>d.rewarded).map(d=>d.name+'：经验已结算 '+(d.rewarded.result?.credited||0)).join('\n');
        system={battleId:b.id,outcome:b.outcome||'manual',ended:true};
      } else if (j.kind === "webCorpses") {
        const b = s.battles[j.battleId];
        if (b?.status !== "ended") continue;
        const corpses = Loot.forBattle(s, b.id);
        const remaining = corpses.reduce((n, c) => n + c.items.filter(i => !c.claims[i.id]).length, 0);
        text = "战后战利品 · " + b.name + "\n" + (remaining ? "剩余 " + remaining + " 项物品，参战角色可在下方快速拾取。" : "本场战利品已全部领取。");
        system = { battleId: b.id, corpses };
      } else if (j.kind === "webRP") {
        const r = s.explorations[j.mapId]?.rps[j.rpId];
        if (r?.status !== "publishing") continue;
        text = r.name + "\n" + r.description;
        system = { mapId: j.mapId, rpId: j.rpId };
      } else if (j.kind === "webMap") {
        const m = s.explorations[j.mapId];
        text =
          "探索 · " +
          m.name +
          "\n" +
          (require("../rpg/rp").waiting(m)
            ? "等待GM描述环境。"
            : m.lastEvent || "地图状态已更新。");
        system = { mapId: m.id };
      } else {
        text = j.text;
        system = {
          battleId: j.battleId,
          mapId: j.mapId,
          cell: j.cell,
          items: j.items,
          kind: j.kind,
          hitId: j.hitId,
        };
      }
      const clientId = S.hash(j.key + ":" + j.desiredRevision);
      if (["webEvent", "webActivity", "webLoot", "webCorpses", "webBattleEnd"].includes(j.kind))
        await chat.upsertSystem(room.id, j.key, j.desiredRevision, {
          text,
          system,
        });
      else
        await chat.send(
          "system:web",
          room.id,
          { clientId, text, system },
          { system: true },
        );
      await store.transact(
        group,
        "web-job:" + j.key + ":" + j.desiredRevision,
        "system:web",
        (st) => {
          const live = st.deliveryJobs[j.key];
          if (live?.desiredRevision === j.desiredRevision) {
            live.status = "done";
            if (j.kind === "webRP") {
              const m = st.explorations[j.mapId],
                r = m.rps[j.rpId];
              if (r?.status === "publishing") {
                r.publication.status = "sent";
                require("../rpg/rp").release(m, r);
              }
            }
          }
          return { done: j.key };
        },
        "网站通知送达",
        { delivery: false },
      );
    }
  }
  async function tick() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      database.assertLease();
      for (const group of store.guilds()) {
        if (store.frozen(group)) continue;
        const s = store.select(group,st=>({
          librarySync:st.librarySync,
          battles:Object.fromEntries(Object.entries(st.battles).map(([id,b])=>[id,{id,status:b.status,pending:{hits:require('../rpg/aoe').hits(b).map(h=>({expiresAt:h.expiresAt}))},due:require('../rpg/npc-auto').due(st,b),terminal:!!B.terminalOutcome(st,b)}])),
          offers:Object.values(st.offers).map(o=>({status:o.status,expiresAt:o.expiresAt})),sessions:Object.values(st.sessions).map(x=>({startsAt:x.startsAt,reminder:x.reminder})),
          explorations:Object.values(st.explorations).map(m=>({status:m.status,moves:Object.values(m.moves||{}).map(r=>({status:r.status,expiresAt:r.expiresAt})),pending:Object.values(m.cells).some(c=>c.room?.encounter==='pending'&&(c.room.autoStart??c.room.snapshot.autoStart))})),
          players:Object.values(st.players).map(p=>({temporaryEffects:(p.temporaryEffects||[]).map(e=>({expiresAt:e.expiresAt}))})),lifecycle:needsLifecycle(st),
        })),
          now = Date.now(),
          due = Object.values(s.battles).some(
            (b) =>
              b.status === "active" &&
              (b.pending.hits
                .some((h) => h.expiresAt <= now) ||
                b.due || b.terminal),
          ),
          expires = Object.values(s.offers).some(
            (o) =>
              ["editing", "ready"].includes(o.status) && o.expiresAt <= now,
          ),
          sessions = Object.values(s.sessions).some(
            (x) => x.startsAt <= now && x.reminder.status === "pending",
          ),
          maps = Object.values(s.explorations).some(
            (m) =>
              m.status === "active" &&
              (Object.values(m.moves || {}).some(
                (r) => r.status === "pending" && r.expiresAt <= now,
              ) ||
                m.pending),
          );
        if (
          due ||
          s.lifecycle ||
          expires ||
          sessions ||
          maps ||
          Object.values(s.players).some((p) =>
            p.temporaryEffects?.some((e) => e.expiresAt <= now),
          )
        )
          await store.transact(
            group,
            "web-tick:" + crypto.randomUUID(),
            "system:web",
            (st) => {
              require("../rpg/activities").expireAll(st, now);
              for (const session of Object.values(st.sessions))
                if (
                  session.startsAt <= now &&
                  session.reminder.status === "pending"
                ) {
                  session.status = "notified";
                  session.reminder.status = "sent";
                  session.reminder.webDeliveredAt = now;
                  session.version++;
                }
              for (const m of Object.values(st.explorations))
                require("../rpg/team-movement").expire(st, m, now);
              for (const b of Object.values(st.battles).filter(
                (b) => b.status === "active",
              )) {
                for (const h of [...require("../rpg/aoe").hits(b)])
                  if (h.expiresAt <= now) B.defend(st, b, h.id, "defend");
                if (require("../rpg/npc-auto").due(st, b))
                  require("../rpg/npc-auto").step(st, b);
              }
              require("../rpg/team-movement").autoEncounters(st);
              return { tick: true };
            },
            "网站定时结算",
          );
        await publishJobs(group);
        const g = await repo.get("group", group);
        if (
          g && !g.deleting && g.autoSync !== false &&
          now - (s.librarySync?.lastSyncAt || 0) >= 86400000
        ) {
          const entries = await library.published();
          await store.transact(
            group,
            "web-auto-sync:" + Math.floor(now / 86400000),
            "system:web",
            (st) => L.applySync(st, entries, L.planSync(st, entries)),
            "公共库每日同步",
            { delivery: false },
          );
        }
      }
    } catch (e) {
      console.error(
        process.env.WEB_TEST_DIAGNOSTICS === "1"
          ? e.stack
          : "网站后台任务失败：" + (e.code || "TASK"),
      );
    } finally {
      pumping = false;
      if(!stopped&&scheduled){let delay=30000;for(const group of store.guilds())if(!store.frozen(group))delay=Math.min(delay,store.select(group,s=>{
        const now=Date.now(),times=[];
        for(const b of Object.values(s.battles))if(b.status==='active'){if(require('../rpg/npc-auto').due(s,b)||B.terminalOutcome(s,b))return 100;for(const h of require('../rpg/aoe').hits(b))times.push(h.expiresAt);if(b.current&&!b.pending&&b.actors.some(a=>a.id===b.current.actorId&&!a.userId&&require('../rpg/npc-auto').config(a.ai).mode==='auto'))times.push(now+1000);}
        for(const j of Object.values(s.deliveryJobs||{}))if(j.kind.startsWith('web')&&j.status==='pending')times.push(now+1000);
        for(const o of Object.values(s.offers))if(['editing','ready'].includes(o.status))times.push(o.expiresAt);
        for(const x of Object.values(s.sessions))if(x.reminder.status==='pending')times.push(x.startsAt);
        for(const p of Object.values(s.players))for(const e of p.temporaryEffects||[])if(e.expiresAt)times.push(e.expiresAt);
        for(const m of Object.values(s.explorations))for(const r of Object.values(m.moves||{}))if(r.status==='pending')times.push(r.expiresAt);
        return Math.max(100,Math.min(30000,...times.map(t=>t-now)));
      }));wake(delay);}
    }
  }
  const unsubscribe = store.onCommit((group,change) => {
    const sections=change?Sections.changed(change.before,change.next):Object.keys(Sections.definitions),v=versions(group);
    const next={...v.sectionVersions};for(const key of sections)next[key]=v.revision;stamps.set(group,next);
    if(sections.length)broadcast(group, {
      type: "state",
      data: {
        groupId: group,
        revision: store.select(group, (s) => s.revision),
        sections,sectionVersions:next,
      },
    });wake();
  });
  return {
    store,
    ensure,
    authorize,
    preview,
    execute,
    operationReceipt,
    commit,
    receipt,
    sync,
    tick,
    versions,
    start: () => {
      stopped = false;scheduled=true;
      wake();
    },
    stop: async () => {
      stopped = true;scheduled=false;
      clearTimeout(timer);
      unsubscribe();
      await pumpPromise;
      await store.drain();
    },
    view: async (group, uid, sections=null) => {
      const done=metrics?.start('game.read');
      try{
      const a=await authorize(group, uid);
      const roomIds = new Set((await chat.rooms(group, uid,undefined,a)).map((r) => r.id));
      return store.select(group, (s) => ({...P.playerView(s, uid, { roomIds,fields:sections&&Sections.fields(sections) }),...versions(group),sections,versions:require("./versions").versions(s,{uid,roomIds,gm:["admin","gm"].includes(a.role),sources:sections&&Sections.sources(sections)})}));
      }finally{done?.();}
    },
  };
}
module.exports = { createGames, derive };
