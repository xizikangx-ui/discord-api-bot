"use strict";
const crypto = require("node:crypto"),
  S = require("./security"),
  C = require("../rpg/constants");
function createChat(repo, accounts, { broadcast = () => {} } = {}) {
  async function access(userId, roomId, r) {
    const room = await repo.get("room", roomId, r);
    S.ok(room && !room.archived, "频道不存在。", "NOT_FOUND");
    if (room.kind === "dm")
      S.ok(room.participants.includes(userId), "无权读取此私聊。", "FORBIDDEN");
    const a = await accounts.member(room.groupId, userId, r);
    if (room.kind === "gm") accounts.gm(a);
    if (room.members?.length && !["gm", "admin"].includes(a.role))
      S.ok(room.members.includes(userId), "无权读取此频道。", "FORBIDDEN");
    return { room, a };
  }
  async function rooms(group, userId) {
    const all = await repo.list("room", group),
      out = [];
    for (const c of all) {
      try {
        await access(userId, c.id);
        if (c.kind === "dm") {
          const other = await accounts.user(
            c.participants.find((id) => id !== userId),
          );
          c.name = other.displayName;
        }
        out.push(c);
      } catch {}
    }
    return out;
  }
  async function create(a, p) {
    accounts.gm(await accounts.member(a.group.id, a.user.id));
    S.ok(["chat", "rp", "gm"].includes(p.kind), "频道类型无效。");
    const members = [...new Set(p.members || [])];
    for (const id of members) await accounts.member(a.group.id, id);
    const c = {
      id: crypto.randomUUID(),
      groupId: a.group.id,
      name: S.text(p.name, "频道名", 50),
      kind: p.kind,
      members,
      sequence: 0,
      version: 1,
    };
    await repo.put("room", c, { scope: a.group.id });
    return c;
  }
  async function dm(a, other) {
    S.ok(other !== a.user.id, "请选择其他成员。");
    await accounts.member(a.group.id, other);
    const pair = [a.user.id, other].sort(),
      id = "dm:" + S.hash(a.group.id + ":" + pair.join(":"));
    return repo.tx(id, async (r) => {
      const old = await repo.get("room", id, r);
      if (old) return old;
      const u = await accounts.user(other, r),
        room = {
          id,
          groupId: a.group.id,
          name: u.displayName,
          kind: "dm",
          participants: pair,
          sequence: 0,
          version: 1,
        };
      await repo.put("room", room, { scope: a.group.id }, r);
      return room;
    });
  }
  async function send(userId, roomId, p, { system = false } = {}) {
    S.ok(/^[a-zA-Z0-9:_-]{8,150}$/.test(p.clientId || ""), "消息编号无效。");
    const { room } = system
      ? { room: await repo.get("room", roomId) }
      : await access(userId, roomId);
    S.ok(room, "频道不存在。");
    if (!system)
      S.ok(
        !["gmSystem", "system"].includes(room.kind),
        "系统频道只能记录操作结果。",
        "FORBIDDEN",
      );
    const result = await repo.tx(
      "chat:" + roomId + ":" + userId + ":" + p.clientId,
      async (r) => {
        if (!system) await access(userId, roomId, r);
        const old = await repo.duplicate(roomId, userId, p.clientId, r);
        if (old) return old;
        const live = await repo.get("room", roomId, r, true);
        S.ok(!live.archived, "频道已关闭。");
        const kind = system ? "system" : p.kind || "text";
        S.ok(
          ["text", "rp", "dice", "system"].includes(kind) &&
            (system || kind !== "system"),
          "消息类型无效。",
        );
        const body = S.text(
            p.text || "",
            "消息",
            kind === "rp" ? 1000 : 4000,
            0,
          ),
          attachments = p.attachments || [];
        S.ok(
          Array.isArray(attachments) && attachments.length <= 3,
          "每条最多3张图片。",
        );
        S.ok(body || attachments.length || kind === "dice", "消息不能为空。");
        for (const id of attachments) {
          const f = await repo.get("media", id, r);
          S.ok(
            f &&
              f.roomId === roomId &&
              f.owner === userId &&
              f.status === "ready",
            "图片不属于此消息。",
          );
        }
        let reply;
        if (p.replyTo) {
          reply = await repo.findMessage(p.replyTo, r);
          S.ok(reply && reply.roomId === roomId, "回复消息不属于此频道。");
        }
        const u = system
            ? { displayName: "系统" }
            : await accounts.user(userId, r),
          dice =
            kind === "dice"
              ? C.dice(p.expression || body || "1d100", p.mode || "normal")
              : undefined;
        let characterName;
        if (kind === "rp") {
          const character = await getCharacter(room.groupId, userId);
          S.ok(character, "请先在此团建卡。");
          characterName = character.name;
        }
        const m = {
          id: crypto.randomUUID(),
          roomId,
          sequence: ++live.sequence,
          authorId: userId,
          authorName: u.displayName,
          clientId: p.clientId,
          kind,
          text: body,
          attachments,
          replyTo: reply?.id,
          replySummary: reply
            ? {
                author: reply.authorName,
                text: reply.deleted ? "消息已删除" : reply.text.slice(0, 120),
              }
            : undefined,
          characterName,
          dice,
          system: p.system,
          at: Date.now(),
        };
        await repo.put("room", live, { scope: room.groupId }, r);
        for (const id of attachments) {
          const f = await repo.get("media", id, r);
          S.ok(!f.messageId, "图片已用于其他消息，请重新选择上传。");
          f.messageId = m.id;
          await repo.put("media", f, { scope: f.groupId }, r);
        }
        await repo.message(roomId, m, r);
        return m;
      },
    );
    broadcast(roomId, { type: "message", data: result });
    return result;
  }
  let getCharacter = async () => null;
  async function remove(userId, id) {
    const m = await repo.findMessage(id);
    S.ok(m, "消息不存在。");
    const { a } = await access(userId, m.roomId);
    S.ok(["text", "rp"].includes(m.kind), "系统和骰点记录不能删除。");
    S.ok(
      m.authorId === userId ||
        (m.roomId &&
          !m.roomId.startsWith("dm:") &&
          ["gm", "admin"].includes(a.role)),
      "不能删除此消息。",
      "FORBIDDEN",
    );
    const result = await repo.tx("delete:" + id, async (r) => {
      const live = await repo.findMessage(id, r);
      const { a } = await access(userId, live.roomId, r);
      S.ok(
        live.authorId === userId ||
          (!live.roomId.startsWith("dm:") && ["gm", "admin"].includes(a.role)),
        "不能删除此消息。",
        "FORBIDDEN",
      );
      live.deleted = true;
      live.deletedBy = userId;
      live.deletedAt = Date.now();
      const room = await repo.get("room", live.roomId, r, true);
      live.previousSequence = live.sequence;
      live.sequence = ++room.sequence;
      await repo.put("room", room, { scope: room.groupId }, r);
      await repo.updateMessage(live, r);
      return { ...live, text: "", attachments: [] };
    });
    broadcast(m.roomId, { type: "deleted", data: result });
    return result;
  }
  function visible(m) {
    return m.deleted
      ? { ...m, text: "", attachments: [], system: undefined, dice: undefined }
      : m;
  }
  async function history(userId, roomId, q) {
    await access(userId, roomId);
    S.ok(
      Number.isSafeInteger(q.after) &&
        q.after >= 0 &&
        Number.isSafeInteger(q.before) &&
        q.before >= 0,
      "消息游标无效。",
    );
    return (await repo.history(roomId, q)).map(visible);
  }
  async function update(a, id, p) {
    const value = await repo.tx(
      "room-update:" + id + ":" + (p.operationId || crypto.randomUUID()),
      async (r) => {
        accounts.gm(await accounts.member(a.group.id, a.user.id, r));
        const c = await repo.get("room", id, r, true);
        S.ok(
          c && c.groupId === a.group.id && !["system", "dm"].includes(c.kind),
          "此频道不能修改。",
        );
        S.ok(c.version === p.version, "频道已变化。", "CONFLICT");
        c.name = S.text(p.name || c.name, "频道名", 50);
        c.members = p.members || [];
        for (const id of c.members) await accounts.member(a.group.id, id);
        if (p.archived && c.kind === "gm")
          S.ok(
            (await repo.list("room", a.group.id, r)).filter(
              (v) => v.kind === "gm" && !v.archived && v.id !== c.id,
            ).length,
            "须保留至少一个GM隐藏频道。",
          );
        c.archived = !!p.archived;
        c.version++;
        await repo.put("room", c, { scope: a.group.id }, r);
        return c;
      },
    );
    broadcast(id, { type: "permissions", data: { roomId: id } });
    return value;
  }
  async function upsertSystem(roomId, key, revision, p) {
    const m = await repo.tx(
      "card:" + roomId + ":" + key + ":" + revision,
      async (r) => {
        const room = await repo.get("room", roomId, r, true),
          prior = await repo.get("card", roomId + ":" + key, r, true);
        if (prior?.revision >= revision)
          return repo.findMessage(prior.messageId, r);
        const old = prior && (await repo.findMessage(prior.messageId, r)),
          message = {
            ...(old || {
              id: crypto.randomUUID(),
              roomId,
              authorId: "system:web",
              authorName: "系统",
              clientId: S.hash(key),
              kind: "system",
              attachments: [],
            }),
            text: p.text,
            system: p.system,
            sequence: ++room.sequence,
            at: Date.now(),
          };
        await repo.put("room", room, { scope: room.groupId }, r);
        if (old) await repo.updateMessage(message, r);
        else await repo.message(roomId, message, r);
        await repo.put(
          "card",
          { id: roomId + ":" + key, revision, messageId: message.id },
          { scope: room.groupId },
          r,
        );
        return message;
      },
    );
    const current = await repo.findMessage(m.id);
    broadcast(roomId, { type: "message", data: current });
    return current;
  }
  return {
    access,
    rooms,
    create,
    dm,
    send,
    upsertSystem,
    history,
    remove,
    update,
    setCharacterReader: (fn) => {
      getCharacter = fn;
    },
  };
}
module.exports = { createChat };
