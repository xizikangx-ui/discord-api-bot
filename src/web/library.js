"use strict";
const crypto = require("node:crypto"),
  C = require("../rpg/constants"),
  G = require("../rpg/gm-service"),
  S = require("./security");
const collections = Object.values(G.KINDS).filter((k) => k !== "rolePanels"),
  hash = G.fingerprint;
function dependencyIds(entry) {
  const ids = new Set(),
    walk = (v, k) => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x, k);
        return;
      }
      if (v && typeof v === "object") {
        for (const [name, x] of Object.entries(v)) walk(x, name);
        return;
      }
      if (
        typeof v === "string" &&
        v &&
        [
          "ref",
          "templateId",
          "skillId",
          "conditionId",
          "categoryId",
          "traitIds",
          "itemIds",
          "skillIds",
          "categoryIds",
          "roomIds",
          "npcIds",
          "allowedRooms",
        ].includes(k)
      )
        ids.add(v);
    };
  walk(entry);
  return [...ids];
}
function planSync(state, entries) {
  const current = state.librarySync?.entries || {},
    byId = new Map(entries.map((e) => [e.templateId, e])),
    changes = [],
    conflicts = [];
  for (const e of entries) {
    const old = state[e.collection]?.[e.templateId],
      base = current[e.id];
    if (base?.version === e.version) continue;
    const missing = dependencyIds(e.template).filter(
      (id) => !byId.has(id) && !collections.some((c) => state[c]?.[id]),
    );
    if (missing.length) {
      conflicts.push({
        id: e.id,
        name: e.template.name,
        reason: "缺少依赖",
        missing,
      });
      continue;
    }
    if (
      old &&
      hash(old) !== hash(e.template) &&
      (!base || hash(old) !== base.hash)
    ) {
      conflicts.push({
        id: e.id,
        name: e.template.name,
        reason: "本团已有本地修改",
        current: old,
        incoming: e.template,
      });
      continue;
    }
    changes.push({
      id: e.id,
      name: e.template.name || e.template.title,
      collection: e.collection,
      templateId: e.templateId,
      version: e.version,
      from: base?.version || 0,
      published: e.template.published !== false,
    });
  }
  // A conflicting dependency must not be silently paired with an incoming version.
  let changed = true;
  while (changed) {
    changed = false;
    const bad = new Set(
      conflicts.map((c) =>
        byId.has(c.id.split(":").slice(1).join(":"))
          ? c.id.split(":").slice(1).join(":")
          : entries.find((e) => e.id === c.id)?.templateId,
      ),
    );
    for (let n = changes.length - 1; n >= 0; n--) {
      const e = entries.find((x) => x.id === changes[n].id);
      if (dependencyIds(e.template).some((id) => bad.has(id))) {
        conflicts.push({ ...changes[n], reason: "依赖存在冲突" });
        changes.splice(n, 1);
        changed = true;
      }
    }
  }
  return {
    changes,
    conflicts,
    sourceHash: hash(entries.map((e) => ({ id: e.id, version: e.version }))),
    stateHash: hash({
      entries: current,
      templates: Object.fromEntries(collections.map((c) => [c, state[c]])),
    }),
  };
}
function applySync(state, entries, preview, { resolutions = {} } = {}) {
  const live = planSync(state, entries);
  S.ok(
    live.sourceHash === preview.sourceHash &&
      live.stateHash === preview.stateHash,
    "模板版本或本地修改已变化，请重新预览。",
    "CONFLICT",
  );
  state.librarySync ||= { entries: {} };
  state.librarySync.entries ||= {};
  const selected = [...live.changes];
  for (const c of live.conflicts)
    if (resolutions[c.id] === "replace") {
      const e = entries.find((e) => e.id === c.id);
      S.ok(e && !c.missing?.length, "无法覆盖缺少依赖的模板。");
      selected.push({ id: e.id });
    }
  const applying = new Set(selected.map((v) => v.id)),
    remaining = new Set(
      live.conflicts
        .filter((c) => !applying.has(c.id))
        .map((c) => entries.find((e) => e.id === c.id)?.templateId),
    );
  for (const change of selected)
    S.ok(
      !dependencyIds(entries.find((e) => e.id === change.id).template).some(
        (id) => remaining.has(id),
      ),
      "请一并处理依赖冲突，或保留此模板。",
      "CONFLICT",
    );
  for (const change of selected) {
    const e = entries.find((e) => e.id === change.id);
    state[e.collection] ||= {};
    const old = state[e.collection][e.templateId],
      installed = C.clone(e.template);
    if (old && hash(old) !== hash(installed))
      installed.version = Math.max(
        (old.version || 0) + 1,
        installed.version || 1,
      );
    state[e.collection][e.templateId] = installed;
    state.librarySync.entries[e.id] = {
      version: e.version,
      sourceId: e.id,
      localModified: false,
      hash: hash(installed),
    };
  }
  state.librarySync.lastSyncAt = Date.now();
  state.librarySync.conflicts = live.conflicts
    .filter((c) => resolutions[c.id] !== "replace")
    .map((c) => ({ id: c.id, name: c.name, reason: c.reason }));
  return { updated: selected.length, conflicts: state.librarySync.conflicts };
}
function createLibrary(repo) {
  const published = () => repo.list("entry");
  async function propose(a, state, p) {
    S.ok(["gm", "admin"].includes(a.role), "需要本团GM。", "FORBIDDEN");
    S.ok(collections.includes(p.collection), "公共模板类别无效。");
    const t = state[p.collection]?.[p.templateId];
    S.ok(t, "模板不存在。");
    const clean = C.clone(t);
    for (const key of [
      "owner",
      "userId",
      "channelId",
      "messageId",
      "portraits",
    ])
      delete clean[key];
    const id = crypto.randomUUID(),
      f = {
        id,
        groupId: a.group.id,
        owner: a.user.id,
        collection: p.collection,
        templateId: t.id,
        template: clean,
        baseVersion: p.baseVersion ?? null,
        status: "pending",
        at: Date.now(),
      };
    await repo.put("proposal", f, { scope: a.group.id });
    return f;
  }
  async function approve(u, id, p) {
    S.ok(u.admin, "只有网站管理员可审核公共库。", "FORBIDDEN");
    return repo.tx("review:" + id + ":" + p.operationId, async (r) => {
      const f = await repo.get("proposal", id, r, true);
      S.ok(f?.status === "pending", "申请已经处理。");
      if (p.reject) {
        f.status = "rejected";
        f.reason = S.text(p.reason, "驳回理由", 1000);
        await repo.put("proposal", f, { scope: f.groupId }, r);
        return f;
      }
      const key = f.collection + ":" + f.templateId,
        old = await repo.get("entry", key, r, true);
      S.ok(
        (old?.version || 0) === Number(p.baseVersion),
        "公共版本已变化，请重新核对。",
        "CONFLICT",
      );
      const e = {
        id: key,
        collection: f.collection,
        templateId: f.templateId,
        version: (old?.version || 0) + 1,
        template: C.clone(f.template),
        approvedBy: u.id,
        at: Date.now(),
      };
      e.template.version = Math.max(e.version, e.template.version || 1);
      const all = await repo.list("entry", undefined, r),
        ids = new Set([...all.map((x) => x.templateId), f.templateId]);
      S.ok(
        dependencyIds(e.template).every((id) => ids.has(id)),
        "请先发布所依赖的公共模板。",
      );
      await repo.put("entry", e, { scope: e.collection }, r);
      f.status = "approved";
      f.publicVersion = e.version;
      await repo.put("proposal", f, { scope: f.groupId }, r);
      return e;
    });
  }
  async function seed(entries, operation) {
    return repo.tx("seed:" + operation, async (r) => {
      S.ok(
        !(await repo.list("entry", undefined, r)).length,
        "公共库已有内容，不能再次初始化。",
      );
      for (const e of entries) {
        S.ok(collections.includes(e.collection), "导入类别无效。");
        await repo.put(
          "entry",
          {
            ...e,
            id: e.collection + ":" + e.templateId,
            version: 1,
            at: Date.now(),
            source: "discord-initial-import",
          },
          { scope: e.collection },
          r,
        );
      }
      return { imported: entries.length };
    });
  }
  return { published, propose, approve, seed };
}
module.exports = {
  createLibrary,
  planSync,
  applySync,
  collections,
  dependencyIds,
};
