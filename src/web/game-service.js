"use strict";
const C = require("../rpg/constants"),
  M = require("../rpg/model"),
  B = require("../rpg/combat"),
  G = require("../rpg/gm-service"),
  H = require("../rpg/health"),
  S = require("./security"),
  D = require("../rpg/action-drafts");
const playerCommands = {
  "character.roll": "生成／重掷角色",
  "character.confirm": "确认角色",
  "character.profile": "角色资料",
  "character.allocate": "分配属性点",
  "character.faction": "选择势力",
  "character.portrait": "角色图片",
  "loot.open": "抽卡／开箱",
  "inventory.drop": "丢弃物品",
  "inventory.equip": "装备／卸下",
  "inventory.attach": "装配／拆下",
  "inventory.repair": "修复装备",
  "inventory.special": "特殊道具",
  "inventory.use": "批量使用／治疗",
  "inventory.ammo": "弹药管理",
  "trade.create": "发起交易／转账",
  "trade.update": "修改报价",
  "trade.confirm": "确认交易",
  "trade.cancel": "取消交易",
  "coupon.redeem": "兑换奖励",
  "showcase.select": "收藏展示",
  "map.leave": "退出探索",
  "map.join": "加入探索",
  "map.move": "全队移动",
  "map.vote": "确认／拒绝移动",
  "map.link": "进出建筑",
  "map.open": "开启容器",
  "map.take": "领取物资",
  "battle.join": "加入战斗",
  "battle.withdraw": "退出招募",
  "battle.action": "战斗行动",
  "corpse.claim": "领取战利品",
  "check.roll": "进行鉴定",
  "session.join": "开团报名",
};
function ownActor(s, uid, bid) {
  const b = s.battles[bid];
  S.ok(b, "战斗不存在。");
  const a = b.actors.find(
    (a) => a.userId === uid && a.characterId === s.players[uid]?.id,
  );
  S.ok(a, "你未参加此战斗。", "FORBIDDEN");
  return { b, a };
}
function normalizeAction(s, uid, p) {
  const { b, a } = ownActor(s, uid, p.battleId),
    x = C.clone(p.params || {}),
    turnId = p.turnId;
  S.ok(
    p.action === "defend" || b.current?.id === turnId,
    "行动机会已经变化。",
    "CONFLICT",
  );
  if (p.action === "move") {
    const Move = require("../rpg/movement-panel");
    let point;
    if (x.relative)
      point = Move.relative(
        s,
        b,
        a,
        B.actorById(b, x.targetId),
        x.distance,
        x.relative === "away",
      );
    else {
      const choices = Move.points(
        s,
        b,
        a,
        C.number(x.cellX, "列", 0, b.width - 1),
        C.number(x.cellY, "行", 0, b.height - 1),
      );
      point = choices.find((v) => v.key === Number(x.pointKey));
      S.ok(point?.cost, "选点已不可达。");
    }
    return { ...point, movementFingerprint: Move.fingerprint(s, b, a) };
  }
  if (p.action === "attack") {
    const ability = B.abilities(B.actorCharacter(s, a)).find(
      (v) => v.key === x.abilityKey,
    );
    S.ok(ability, "武器或技能已变化。");
    if (ability.attack.aoe && ability.attack.aoe.mode !== "single") {
      const A = require("../rpg/aoe"),
        preview = A.preview(s, b, a, ability.attack, x.center, x.targets);
      S.ok(preview.targets.length, "请选择有效范围和目标。");
      x.firing = { ...x.firing, aoe: preview };
    } else if (x.firing) {
      delete x.firing.aoe;
    }
  }
  if (p.action === "item" && x.recipientId)
    x.recipientCharacterId = B.actorCharacter(
      s,
      B.actorById(b, x.recipientId),
    ).id;
  return x;
}
function applyPlayer(s, uid, command, p) {
  if (command === "character.roll")
    return M.rollCharacter(s, uid, p.name, !!p.reroll);
  if (command === "character.confirm") {
    S.ok(s.characterDrafts[uid]?.id === p.draftId, "角色草稿已变化。");
    S.ok(["male", "female"].includes(p.gender), "请选择角色性别。");
    s.characterDrafts[uid].gender = p.gender;
    return M.confirmCharacter(s, uid);
  }
  const character = () => M.player(s, uid);
  if (command === "character.profile") {
    const c = character();
    H.requireAction(c);
    S.ok(c.id === p.characterId, "角色已变化。");
    const data = p.data || {};
    S.ok(
      Object.keys(data).every((k) =>
        ["gender", "age", "profile", "name"].includes(k),
      ),
      "资料字段无效。",
    );
    if (data.name) c.name = C.text(data.name, "名字", 80);
    if (data.gender !== undefined) {
      S.ok(["male", "female", null].includes(data.gender), "性别无效。");
      c.gender = data.gender;
    }
    if (data.age !== undefined) c.age = C.number(data.age, "年龄", 1, 10000);
    if (data.profile) {
      S.ok(
        Object.keys(data.profile).every((k) =>
          ["background", "appearance", "belief"].includes(k),
        ),
        "背景字段无效。",
      );
      c.profile = Object.fromEntries(
        Object.entries(data.profile).map(([k, v]) => [
          k,
          C.text(v, "背景", 2000, true),
        ]),
      );
    }
    c.profileVersion++;
    return { name: c.name, profile: c.profile };
  }
  if (command === "character.allocate")
    return M.allocate(s, uid, p.attribute, p.amount);
  if (command === "character.faction") {
    const c = character();
    H.requireAction(c);
    return require("../rpg/factions").choose(
      s,
      uid,
      p.characterId,
      p.faction,
      p.department,
    );
  }
  if (command === "character.portrait") {
    const c = character();
    H.requireAction(c);
    S.ok(["avatar", "illustration"].includes(p.slot), "图片位置无效。");
    c.portraits ||= {};
    if (p.clear) delete c.portraits[p.slot];
    else c.portraits[p.slot] = { webMediaId: p.mediaId };
    return { slot: p.slot };
  }
  if (command === "loot.open") return M.openLoot(s, uid, p.box || "card");
  if (command === "inventory.drop")
    return M.drop(s, uid, p.itemId, p.quantity || 1);
  if (command === "inventory.equip")
    return M.equip(s, uid, p.itemId, !!p.remove, p.hand || "auto");
  if (command === "inventory.attach")
    return M.attach(s, uid, p.itemId, p.attachmentId, !!p.remove);
  if (command === "inventory.repair") {
    const c = character();
    H.requireAction(c);
    S.ok(!M.battleFor(s, uid), "战斗中从道具行动修复。");
    S.ok(
      M.available(s, uid, p.itemId) > 0 && M.available(s, uid, p.targetId) > 0,
      "道具或装备已预留。",
    );
    return require("../rpg/durability").repair(c, p.itemId, p.targetId);
  }
  if (command === "inventory.special")
    return M.useSpecial(s, uid, p.itemId, p.slot);
  if (command === "inventory.use") {
    S.ok(!M.battleFor(s, uid), "战斗道具请从行动面板使用。");
    const c = character(),
      target = require("../rpg/treatment").outside(s, uid, p.targetUid || uid),
      n = C.number(p.quantity || 1, "数量", 1, 100);
    H.requireAction(c);
    S.ok(M.available(s, uid, p.itemId) >= n, "道具不足或已被预留。");
    return M.consumeMany(c, p.itemId, n, undefined, null, Date.now(), target);
  }
  if (command === "inventory.ammo") {
    const c = character();
    H.requireAction(c);
    S.ok(
      !M.battleFor(s, uid) || M.battleFor(s, uid).status === "paused",
      "战斗中请用战斗弹药入口。",
    );
    const A = require("../rpg/ammunition"),
      x = p.operation;
    for (const id of [x.weaponId, x.magazineId, x.ammoId].filter(Boolean))
      S.ok(M.available(s, uid, id) > 0, "物品被交易预留。");
    return x.type === "fill"
      ? A.fill(c, x.magazineId, x.ammoId, x.quantity)
      : A.swap(c, x.weaponId, x.type === "extract" ? null : x.magazineId);
  }
  if (command === "trade.create") {
    S.ok(["trade", "transfer"].includes(p.type || "trade"), "交易类型无效。");
    S.ok(
      p.targetUid !== uid && s.players[p.targetUid],
      "请选择本团其他有效角色。",
    );
    return M.createOffer(
      s,
      uid,
      p.targetUid,
      p.type === "transfer" ? "transfer" : "trade",
      undefined,
      1,
      p.type === "transfer" ? C.number(p.amount, "金额", 1, C.MAX_MONEY) : 0,
    );
  }
  if (command === "trade.update")
    return M.updateOffer(s, p.offerId, uid, p.items || [], p.coins || 0);
  if (command === "trade.confirm")
    return M.confirmOffer(s, p.offerId, uid, p.revision);
  if (command === "trade.cancel") return M.cancelOffer(s, p.offerId, uid);
  if (command === "coupon.redeem") {
    const P = require("../rpg/coupons"),
      f = P.preview(s, uid, p.poolId, p.selected);
    return P.redeem(s, uid, f.id);
  }
  if (command === "showcase.select")
    return require("../rpg/showcase").select(
      s,
      uid,
      p.characterId,
      p.page || 0,
      p.refs || [],
    );
  if (command === "map.leave") {
    const m = s.explorations[p.mapId];
    S.ok(!M.battleFor(s, uid), "战斗期间请GM移出。");
    H.requireAction(character());
    S.ok(
      m?.participants[uid] && !m.excursion && !m.parentContext,
      "请先返回区域地图，并确认仍在本地图中。",
    );
    S.ok(
      !Object.values(m.moves || {}).some((r) => r.status === "pending"),
      "请先处理全队移动确认。",
    );
    delete m.participants[uid];
    require("../rpg/map-links").releaseEmpty(s, m);
    m.version++;
    return { left: true };
  }
  if (command === "map.join")
    return require("../rpg/exploration").join(s, s.explorations[p.mapId], uid);
  if (command === "map.move")
    return require("../rpg/team-movement").propose(
      s,
      s.explorations[p.mapId],
      uid,
      p.cell,
      p.keyId,
    );
  if (command === "map.vote")
    return require("../rpg/team-movement").vote(
      s,
      s.explorations[p.mapId],
      p.requestId,
      uid,
      !!p.yes,
    );
  if (command === "map.link")
    return require("../rpg/map-links").propose(
      s,
      s.explorations[p.mapId],
      uid,
      p.kind,
    );
  if (command === "map.open")
    return require("../rpg/exploration").open(
      s,
      s.explorations[p.mapId],
      uid,
      p.ref,
    );
  if (command === "map.take")
    return require("../rpg/exploration").take(
      s,
      s.explorations[p.mapId],
      uid,
      p.ref,
    );
  if (command === "battle.join") return B.join(s, s.battles[p.battleId], uid);
  if (command === "battle.withdraw")
    return B.withdraw(s, s.battles[p.battleId], uid);
  if (command === "battle.action") {
    const { b, a } = ownActor(s, uid, p.battleId),
      f = D.create(s, uid, {
        battleId: b.id,
        actorId: a.id,
        turnId: p.turnId,
        action: p.action,
        params: normalizeAction(s, uid, p),
        expiresAt: p.expiresAt,
      });
    return D.execute(s, f.id, uid, p.rp || "");
  }
  if (command === "corpse.claim")
    return require("../rpg/mortality").claim(s, p.corpseId, uid, p.itemId);
  if (command === "check.roll")
    return require("../rpg/activities").rollCheck(s, p.checkId, uid);
  if (command === "session.join")
    return require("../rpg/activities").sessionJoin(
      s,
      p.sessionId,
      uid,
      !!p.withdraw,
    );
  S.fail("玩家操作不存在。", "NOT_FOUND");
}
function playerGuards(s, uid, command, p) {
  const refs = [
    { source: "players", id: uid, hash: G.fingerprint(s.players[uid]) },
  ];
  for (const [key, source] of Object.entries({
    mapId: "explorations",
    battleId: "battles",
    offerId: "offers",
    poolId: "couponPools",
    checkId: "checks",
    sessionId: "sessions",
    corpseId: "corpses",
    targetUid: "players",
  }))
    if (p[key]) {
      S.ok(s[source]?.[p[key]], "引用已经不存在。");
      refs.push({ source, id: p[key], hash: G.fingerprint(s[source][p[key]]) });
    }
  if (command.startsWith("character."))
    refs.push({
      source: "characterDrafts",
      id: uid,
      hash: G.fingerprint(s.characterDrafts[uid]),
    });
  if (p.battleId)
    for (const a of s.battles[p.battleId].actors)
      if (a.userId && s.players[a.userId])
        refs.push({
          source: "players",
          id: a.userId,
          hash: G.fingerprint(s.players[a.userId]),
        });
  if (command === "coupon.redeem")
    for (const e of s.couponPools[p.poolId].entries)
      refs.push({
        source: "catalog",
        id: e.ref,
        hash: G.fingerprint(s.catalog[e.ref]),
      });
  return refs;
}
function playerView(s, uid, { roomIds } = {}) {
  const visible = (o) => !roomIds || !o.channelId || roomIds.has(o.channelId);
  const p = s.players[uid],
    maps = Object.values(s.explorations).filter(
      (m) => visible(m) && m.status !== "draft" && m.status !== "ended",
    ),
    battles = Object.values(s.battles).filter(
      (b) => visible(b) && b.status !== "ended",
    ),
    result = {
      actionDrafts: Object.values(s.forms).filter(
        (f) =>
          f.kind === "webAction" &&
          f.owner === uid &&
          f.expiresAt > Date.now() &&
          f.status === "ready",
      ),
      actionHistory: Object.values(s.forms)
        .filter(
          (f) =>
            f.kind === "webAction" && f.owner === uid && f.status === "done",
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 50)
        .map((f) => ({
          id: f.id,
          command: f.command,
          at: f.at,
          result: f.result,
        })),
      revision: s.revision,
      player: p ? { ...p, stats: M.stats(p), health: H.snapshot(p) } : null,
      draft: s.characterDrafts[uid],
      roster: Object.values(s.players).map((p) => ({
        userId: p.userId,
        id: p.id,
        name: p.name,
        level: p.level,
        health: H.snapshot(p),
        profile: p.profile,
        portraits: p.portraits,
        showcase: require("../rpg/showcase").entries(s, p.userId),
      })),
      maps: maps.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        mapType: m.mapType,
        rows: m.floors,
        width: m.width,
        participants: m.participants,
        revealed: m.revealed,
        moves: m.moves,
        rpWaiting: require("../rpg/rp").waiting(m),
        cells: Object.fromEntries(
          Object.entries(m.cells).map(([id, c]) => [
            id,
            m.revealed[id]
              ? {
                  id,
                  type: c.type,
                  passable: c.passable,
                  name: c.name,
                  description: c.description,
                  room:
                    c.room && !require("../rpg/rp").waiting(m)
                      ? {
                          id: c.room.id,
                          name: c.room.snapshot.name,
                          encounter: c.room.encounter,
                          unlocked: c.room.unlocked,
                          containers:
                            c.room.encounter === "resolved"
                              ? c.room.containers.map((v) => ({
                                  id: v.id,
                                  box: v.box,
                                  status: v.status,
                                }))
                              : [],
                          supplies:
                            c.room.encounter === "resolved"
                              ? c.room.supplies
                              : [],
                          merchant: c.room.merchant,
                        }
                      : undefined,
                }
              : { id, hidden: true },
          ]),
        ),
      })),
      battles: battles.map((b) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        current: b.current,
        actionRound: b.actionRound,
        movementFingerprint: b.actors.some(a=>a.userId===uid)?require("../rpg/movement-panel").fingerprint(s,b,b.actors.find(a=>a.userId===uid)):null,
        terrain: b.terrain,
        width: b.width,
        height: b.height,
        pending: require("../rpg/aoe")
          .hits(b)
          .filter(
            (h) => b.actors.find((a) => a.id === h.targetId)?.userId === uid,
          ),
        actors: b.actors.map((a) => ({
          id: a.id,
          name: a.name,
          userId: a.userId,
          team: a.team,
          x: a.x,
          y: a.y,
          retreated: a.retreated,
          deathId: a.deathId,
          health: H.snapshot(B.actorCharacter(s, a)),
          ap: B.actorCharacter(s, a).ap,
          nextCost: B.opportunityCost(b, a.id),
        })),
        abilities:
          b.actors.some((a) => a.userId === uid && !a.deathId) && p
            ? B.abilities(p)
            : [],
      })),
      offers: Object.values(s.offers).filter((o) =>
        [o.creatorId, o.targetId].includes(uid),
      ),
      coupons: Object.values(s.couponPools)
        .filter((t) => (p?.couponBalances?.[t.id] || 0) > 0)
        .map((t) => ({ ...t, balance: p.couponBalances[t.id] })),
      checks: Object.values(s.checks).filter(
        (c) => visible(c) && c.status === "open",
      ),
      sessions: Object.values(s.sessions).filter(
        (x) => visible(x) && !["cancelled"].includes(x.status),
      ),
      glossary: Object.values(s.glossaryTerms).filter((t) => t.published),
      texts: require("../rpg/texts")
        .definitions()
        .map((d) => ({ ...d, text: require("../rpg/texts").get(s, d.key) })),
      corpses: Object.values(s.corpses)
        .filter((c) =>
          s.battles[c.battleId]?.actors.some((a) => a.userId === uid),
        )
        .map((c) => ({
          id: c.id,
          battleId: c.battleId,
          items: c.items,
          claims: c.claims,
        })),
    };
  return result;
}
module.exports = {
  playerCommands,
  applyPlayer,
  playerGuards,
  playerView,
  ownActor,
  normalizeAction,
};
