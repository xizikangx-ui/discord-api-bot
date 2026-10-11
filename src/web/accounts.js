"use strict";
const crypto = require("node:crypto"),
  S = require("./security");
const uid = () => crypto.randomUUID();
function createAccounts(repo, { bootstrapHash, changed = () => {} } = {}) {
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    displayName: u.displayName,
    admin: !!u.admin,
    disabled: !!u.disabled,
    preferences: u.preferences || {artStyle:"tactical",killEffects:true},
  });
  async function user(id, r) {
    const u = await repo.get("user", id, r);
    S.ok(u && !u.disabled, "账号已停用或不存在。", "UNAUTHORIZED");
    return u;
  }
  async function member(group, account, r, knownUser) {
    const u = knownUser?.id===account ? knownUser : await user(account, r),
      g = await repo.get("group", group, r, !!r);
    S.ok(g && !g.archived && !g.deleting, "跑团不存在。", "NOT_FOUND");
    const m = await repo.get("member", group + ":" + account, r, !!r);
    S.ok(u.admin || m?.active, "你不是此团的成员。", "FORBIDDEN");
    return { user: u, group: g, role: u.admin ? "admin" : m.role, member: m };
  }
  function gm(a) {
    S.ok(["admin", "gm"].includes(a.role), "需要本团GM权限。", "FORBIDDEN");
  }
  function admin(u) {
    S.ok(u.admin, "需要网站管理员权限。", "FORBIDDEN");
  }
  async function session(value) {
    S.ok(value, "请登录。", "UNAUTHORIZED");
    const s = await repo.get("session", S.hash(value));
    S.ok(
      s && !s.revokedAt && s.expiresAt > Date.now(),
      "登录已失效，请重新登录。",
      "UNAUTHORIZED",
    );
    return { session: s, user: await user(s.userId) };
  }
  async function issueSession(u, name = "浏览器") {
    const secret = S.token(),
      s = {
        id: S.hash(secret),
        userId: u.id,
        name: String(name).slice(0, 80),
        csrf: S.token(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 86400000,
      };
    await repo.put("session", s, { scope: u.id });
    return { secret, csrf: s.csrf, user: publicUser(u) };
  }
  async function revokeAll(account, r) {
    for (const s of await repo.list("session", account, r))
      await repo.put(
        "session",
        { ...s, revokedAt: Date.now() },
        { scope: account },
        r,
      );
  }
  async function register(p, bootstrap = false) {
    const name = S.text(p.name, "用户名", 32, 3)
      .normalize("NFKC")
      .toLowerCase();
    S.ok(/^[a-z0-9_-]+$/.test(name), "用户名使用英文、数字、下划线或短横线。");
    const digest = await S.password(p.password),
      recovery = S.token();
    const result = await repo.tx("register:" + uid(), async (r) => {
      await r.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "web:user:" + name,
      ]);
      S.ok(
        !(await repo.lookup("user", S.hash(name), r)),
        "用户名已被使用。",
        "CONFLICT",
      );
      let invite;
      if (bootstrap) {
        S.ok(
          bootstrapHash && S.hash(p.token || "") === bootstrapHash,
          "初始化凭证无效。",
          "FORBIDDEN",
        );
        await r.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "web:bootstrap",
        ]);
        S.ok(
          !(await repo.list("user", undefined, r)).some((x) => x.admin),
          "管理员已初始化。",
          "CONFLICT",
        );
      } else {
        invite = await repo.get("invite", S.hash(p.invite || ""), r, true);
        S.ok(
          invite &&
            !invite.usedBy &&
            !invite.revokedAt &&
            invite.expiresAt > Date.now(),
          "邀请码已失效或已使用。",
        );
        const issuer = await user(invite.issuer, r),
          a = await member(invite.groupId, issuer.id, r);
        gm(a);
      }
      const u = {
        id: uid(),
        name,
        displayName: S.text(p.displayName || name, "昵称", 40),
        password: digest,
        recoveryHash: S.hash(recovery),
        admin: bootstrap,
        createdAt: Date.now(),
        version: 1,
      };
      await repo.put("user", u, { lookup: S.hash(name) }, r);
      if (invite) {
        invite.usedBy = u.id;
        await repo.put("invite", invite, { scope: invite.groupId }, r);
        await repo.put(
          "member",
          {
            id: invite.groupId + ":" + u.id,
            groupId: invite.groupId,
            userId: u.id,
            role: "player",
            active: true,
            version: 1,
          },
          { scope: invite.groupId },
          r,
        );
      }
      return { userId: u.id };
    });
    return {
      ...(await issueSession(await user(result.userId), p.deviceName)),
      recovery,
    };
  }
  async function login(p) {
    const name = String(p.name || "")
        .normalize("NFKC")
        .toLowerCase()
        .trim(),
      u = await repo.lookup("user", S.hash(name));
    const valid =
      u && !u.disabled
        ? await S.password(p.password, u.password).catch(() => false)
        : await S.password(p.password)
            .then(() => false)
            .catch(() => false);
    S.ok(valid, "用户名或密码错误。", "UNAUTHORIZED");
    return issueSession(u, p.deviceName);
  }
  async function recover(p) {
    const name = String(p.name || "")
        .normalize("NFKC")
        .toLowerCase()
        .trim(),
      u = await repo.lookup("user", S.hash(name));
    S.ok(u && !u.disabled, "恢复信息无效。");
    const digest = await S.password(p.password),
      recovery = S.token();
    await repo.tx("recover:" + uid(), async (r) => {
      const live = await repo.get("user", u.id, r, true),
        t =
          p.resetToken &&
          (await repo.get("reset", S.hash(p.resetToken), r, true));
      S.ok(
        (p.recoveryCode && live.recoveryHash === S.hash(p.recoveryCode)) ||
          (t && t.userId === live.id && !t.usedAt && t.expiresAt > Date.now()),
        "恢复信息无效或已使用。",
      );
      live.password = digest;
      live.recoveryHash = S.hash(recovery);
      live.version++;
      await repo.put("user", live, { lookup: S.hash(live.name) }, r);
      if (t) {
        t.usedAt = Date.now();
        await repo.put("reset", t, { scope: live.id }, r);
      }
      await revokeAll(live.id, r);
      return { reset: true };
    });
    changed(u.id);
    return { recovery };
  }
  async function changePassword(a, p) {
    const digest = await S.password(p.password),
      valid = await S.password(p.currentPassword, a.user.password);
    S.ok(valid, "当前密码错误。");
    const recovery = S.token();
    await repo.tx("password:" + uid(), async (r) => {
      const u = await repo.get("user", a.user.id, r, true);
      S.ok(
        u.version === a.user.version,
        "账号已变化，请重新登录。",
        "CONFLICT",
      );
      u.password = digest;
      u.recoveryHash = S.hash(recovery);
      u.version++;
      await repo.put("user", u, { lookup: S.hash(u.name) }, r);
      await revokeAll(u.id, r);
      return { changed: true };
    });
    changed(a.user.id);
    return { recovery };
  }
  async function resetToken(a, id) {
    admin(a);
    await user(id);
    const secret = S.token();
    await repo.put(
      "reset",
      { id: S.hash(secret), userId: id, expiresAt: Date.now() + 15 * 60000 },
      { scope: id },
    );
    return { token: secret, expiresAt: Date.now() + 15 * 60000 };
  }
  async function invite(a) {
    gm(a);
    const secret = S.token(),
      i = {
        id: S.hash(secret),
        groupId: a.group.id,
        issuer: a.user.id,
        expiresAt: Date.now() + 7 * 86400000,
      };
    await repo.tx("invite:"+i.id,async r=>{gm(await member(a.group.id,a.user.id,r));await repo.put("invite", i, { scope: a.group.id },r);return {issued:true};});
    return { code: secret, expiresAt: i.expiresAt };
  }
  async function join(u, code) {
    return repo.tx("join:" + u.id + ":" + S.hash(code), async (r) => {
      const i = await repo.get("invite", S.hash(code), r, true);
      S.ok(
        i && !i.usedBy && !i.revokedAt && i.expiresAt > Date.now(),
        "邀请码已失效。",
      );
      gm(await member(i.groupId, i.issuer, r));
      i.usedBy = u.id;
      await repo.put("invite", i, { scope: i.groupId }, r);
      const old = await repo.get("member", i.groupId + ":" + u.id, r, true);
      await repo.put(
        "member",
        {
          id: i.groupId + ":" + u.id,
          groupId: i.groupId,
          userId: u.id,
          role: old?.active ? old.role : "player",
          active: true,
          version: (old?.version || 0) + 1,
        },
        { scope: i.groupId },
        r,
      );
      return { groupId: i.groupId };
    });
  }
  async function createGroup(u, p, operation) {
    admin(u);
    S.ok(/^[a-zA-Z0-9_-]{8,100}$/.test(operation || ""), "操作编号无效。");
    return repo.tx("group:" + u.id + ":" + operation, async (r) => {
      const g = {
        id: uid(),
        name: S.text(p.name, "团名", 80),
        description: S.text(p.description || "", "介绍", 2000, 0),
        owner: u.id,
        version: 1,
        createdAt: Date.now(),
        autoSync: true,
      };
      await repo.put("group", g, {}, r);
      await repo.put(
        "member",
        {
          id: g.id + ":" + u.id,
          groupId: g.id,
          userId: u.id,
          role: "gm",
          active: true,
          version: 1,
        },
        { scope: g.id },
        r,
      );
      for (const [kind, name] of [
        ["chat", "营地闲聊"],
        ["rp", "剧情 RP"],
        ["system", "行动记录"],
        ["gm", "GM 指挥室"],
      ]) {
        const c = {
          id: uid(),
          groupId: g.id,
          name,
          kind,
          sequence: 0,
          version: 1,
        };
        await repo.put("room", c, { scope: g.id }, r);
      }
      return g;
    });
  }
  async function setMember(a, p) {
    gm(a);
    S.ok(["player", "gm"].includes(p.role || "player"), "成员身份无效。");
    if (p.role === "gm" || (p.active === false && p.userId === a.group.owner))
      admin(a.user);
    await user(p.userId);
    const result = await repo.tx("member:" + uid(), async (r) => {
      const liveActor = await member(a.group.id, a.user.id, r);
      gm(liveActor);
      if (p.role === "gm") admin(liveActor.user);
      const current = await repo.get(
        "member",
        a.group.id + ":" + p.userId,
        r,
        true,
      );
      if (current)
        S.ok(current.version === p.version, "成员已变化。", "CONFLICT");
      S.ok(
        current || liveActor.user.admin,
        "新玩家请通过邀请码加入。",
        "FORBIDDEN",
      );
      S.ok(
        a.user.admin || current?.role !== "gm",
        "只有管理员可修改GM。",
        "FORBIDDEN",
      );
      const m = {
        id: a.group.id + ":" + p.userId,
        groupId: a.group.id,
        userId: p.userId,
        role: p.role || current?.role || "player",
        active: p.active !== false,
        version: (current?.version || 0) + 1,
      };
      await repo.put("member", m, { scope: a.group.id }, r);
      return m;
    });
    changed(p.userId);
    return result;
  }
  return {
    publicUser,
    user,
    member,
    gm,
    admin,
    session,
    register,
    login,
    recover,
    changePassword,
    resetToken,
    invite,
    join,
    createGroup,
    setMember,
    revokeAll,
  };
}
module.exports = { createAccounts };
