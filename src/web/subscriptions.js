"use strict";
const S = require("./security");

// One account connection can watch several groups, but receives message bodies
// only for the active room. Authorization is checked again for every delivery.
function createSubscriptions({ accounts, chat, limit = () => {}, presence = async () => {} }) {
  const send = (ws, type, data) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 262144) return ws.close(1013, "请重新同步");
    ws.send(JSON.stringify({ type, data }));
  };
  function clearGroup(ws, groupId, error = {}) {
    ws.watchGroups?.delete(groupId);
    if (ws.groupId === groupId) {
      ws.groupId = undefined;
      ws.roomId = undefined;
    }
    send(ws, "subscription-error", {
      groupId, requestId: error.requestId,
      code: error.code || "FORBIDDEN",
      message: error.message || "此团的访问权限已变化，请选择其他团。",
    });
  }
  function failure(ws, error, groupId, requestId) {
    if (error.code === "UNAUTHORIZED") return ws.close(4001, "登录已失效");
    if (["FORBIDDEN", "NOT_FOUND"].includes(error.code)) return clearGroup(ws, groupId, { code:error.code,message:error.message,requestId });
    send(ws, "subscription-error", {
      groupId, requestId, code: error.code || "UNAVAILABLE",
      message: error.code === "RATE_LIMIT" ? error.message : "实时订阅暂时不可用，请稍后重连。",
    });
  }
  function enqueue(ws, bytes) {
    // Allocate before any await, so an old authorization response cannot apply
    // after a newer group/room selection arrived on the same socket.
    const generation = ws.subscriptionGeneration = (ws.subscriptionGeneration || 0) + 1;
    let p;
    try {
      limit("ws-message:" + ws.userId, 60);
      p = JSON.parse(bytes);
      S.ok(p.type === "subscribe", "实时接口仅供订阅。");
      S.ok(p.requestId === undefined || ["string", "number"].includes(typeof p.requestId) && String(p.requestId).length <= 100, "订阅编号无效。");
      S.ok(!p.groupId || typeof p.groupId === "string" && p.groupId.length <= 150, "团编号无效。");
      S.ok(!p.roomId || typeof p.roomId === "string" && p.roomId.length <= 200, "群聊编号无效。");
      S.ok(p.watchGroups === undefined || Array.isArray(p.watchGroups) && p.watchGroups.length <= 100 && p.watchGroups.every(id => typeof id === "string" && id.length <= 150), "订阅团列表无效。");
    } catch (e) { failure(ws, e, undefined, p?.requestId); return Promise.resolve(); }
    if(ws.groupId!==(p.groupId||undefined)||ws.roomId!==(p.roomId||undefined)){
      const departed=ws.roomId;
      ws.groupId=undefined;ws.roomId=undefined;
      // While the next scope is being authorized, the previous group receives
      // summary notifications only. A failed switch cannot leave its body feed on.
      if(departed)Promise.resolve(presence(departed)).catch(()=>{});
    }
    const work = async () => {
      if (ws.readyState !== 1 || generation !== ws.subscriptionGeneration) return;
      try {
        const auth = await accounts.session(ws.credential);
        const watches = new Set(), memberships = new Map();
        const member = id => {
          if (!memberships.has(id)) memberships.set(id, accounts.member(id, ws.userId, undefined, auth.user));
          return memberships.get(id);
        };
        if (p.groupId) await member(p.groupId);
        S.ok(!p.roomId || p.groupId, "请先选择团。", "FORBIDDEN");
        if (p.roomId) {
          const { room } = await chat.access(ws.userId, p.roomId, undefined, await member(p.groupId));
          S.ok(room.groupId === p.groupId, "群聊不属于此团。", "FORBIDDEN");
        }
        for (const id of new Set([...(p.watchGroups || []), p.groupId].filter(Boolean))) {
          try { await member(id); watches.add(id); }
          catch (e) { if (!["FORBIDDEN", "NOT_FOUND"].includes(e.code)) throw e; }
        }
        if (generation !== ws.subscriptionGeneration || ws.readyState !== 1) return;
        const oldRoom = ws.roomId;
        ws.groupId = p.groupId;
        ws.roomId = p.roomId;
        ws.watchGroups = watches;
        send(ws, "subscribed", { requestId: p.requestId, groupId: p.groupId, roomId: p.roomId, watchGroups: [...watches] });
        if (oldRoom && oldRoom !== p.roomId) await presence(oldRoom);
        if (p.roomId) await presence(p.roomId);
      } catch (e) {
        if (generation === ws.subscriptionGeneration) failure(ws, e, p.groupId, p.requestId);
      }
    };
    ws.subscriptionTail = (ws.subscriptionTail || Promise.resolve()).catch(() => {}).then(work);
    return ws.subscriptionTail;
  }
  async function check(ws) {
    try {
      const auth = await accounts.session(ws.credential);
      for (const id of new Set([...(ws.watchGroups || []), ws.groupId].filter(Boolean))) {
        try { await accounts.member(id, ws.userId, undefined, auth.user); }
        catch (e) {
          if (["FORBIDDEN", "NOT_FOUND"].includes(e.code)) clearGroup(ws, id, e);
          else throw e;
        }
      }
      if (ws.roomId) {
        const roomId=ws.roomId,groupId=ws.groupId,generation=ws.subscriptionGeneration;
        try { await chat.access(ws.userId, roomId); }
        catch (e) { if(generation===ws.subscriptionGeneration&&roomId===ws.roomId)failure(ws, e, groupId); }
      }
    } catch (e) { failure(ws, e, ws.groupId); }
  }
  return { enqueue, check, failure, clearGroup, send };
}
module.exports = { createSubscriptions };
