"use strict";
const crypto = require("node:crypto"),
  S = require("./security");
function createMedia(
  repo,
  crypt,
  {
    bucket,
    client,
    commands,
    chat,
    accounts,
    portraitAllowed = async () => false,
  },
) {
  async function upload(a, p) {
    S.ok(bucket && client, "图片存储尚未配置。", "UNAVAILABLE");
    S.ok(/^[a-zA-Z0-9_-]{8,100}$/.test(p.uploadId || ""), "上传编号无效。");
    const id = S.hash(a.user.id + ":" + p.uploadId);
    if (p.roomId) {
      const { room } = await chat.access(a.user.id, p.roomId);
      S.ok(room.groupId === a.group.id, "图片频道不属于此团。");
    }
    const bytes = Buffer.from(p.data || "", "base64");
    S.ok(bytes.length && bytes.length <= 4 * 1024 * 1024, "图片最多4 MiB。");
    const sharp = require("sharp"),
      meta = await sharp(bytes, { limitInputPixels: 24000000 }).metadata();
    S.ok(
      ["png", "jpeg", "webp"].includes(meta.format) && !meta.pages,
      "仅支持静态PNG、JPEG、WebP。",
    );
    const image = await sharp(bytes, { limitInputPixels: 24000000 })
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toBuffer(),
      record = {
        id,
        owner: a.user.id,
        groupId: a.group.id,
        roomId: p.roomId || null,
        kind: p.roomId ? "chat" : "portrait",
        status: "sending",
        key: "media/" + id + ".enc",
        hash: S.hash(image),
        at: Date.now(),
      };
    const nonce = crypto.randomUUID();
    const reservation = await repo.tx("upload:" + id, async (r) => {
      await accounts.member(a.group.id, a.user.id, r);
      if (p.roomId) await chat.access(a.user.id, p.roomId, r);
      await repo.put("media", record, { scope: a.group.id }, r);
      return { nonce };
    });
    if (reservation.nonce !== nonce) {
      const old = await repo.get("media", id);
      S.ok(
        old?.owner === a.user.id &&
          old.roomId === record.roomId &&
          old.groupId === record.groupId &&
          old.hash === record.hash,
        "上传编号或图片内容冲突。",
        "CONFLICT",
      );
      if (old.status === "ready") return { id };
      S.fail("该次上传结果待核对，请勿重复上传。", "UNCERTAIN");
    }
    try {
      await client.send(
        new commands.PutObjectCommand({
          Bucket: bucket,
          Key: record.key,
          Body: crypt.seal("image", id, { data: image.toString("base64") }),
          ContentType: "application/octet-stream",
        }),
      );
      record.status = "ready";
      await repo.put("media", record, { scope: a.group.id });
      return { id };
    } catch {
      record.status = "uncertain";
      await repo.put("media", record, { scope: a.group.id }).catch(() => {});
      S.fail("图片上传结果待核对，原操作编号已保留。", "UNCERTAIN");
    }
  }
  async function read(userId, id) {
    const f = await repo.get("media", id);
    S.ok(f?.status === "ready", "图片不存在。", "NOT_FOUND");
    await accounts.member(f.groupId, userId);
    if (f.roomId) {
      await chat.access(userId, f.roomId);
      const m = f.messageId && (await repo.findMessage(f.messageId));
      S.ok(
        (m && !m.deleted && m.attachments?.includes(id)) ||
          (!f.messageId && f.owner === userId),
        "图片尚未发布或消息已删除。",
        "FORBIDDEN",
      );
    }
    if (!f.roomId)
      S.ok(
        f.owner === userId || (await portraitAllowed(userId, f.groupId, id)),
        "图片尚未用于公开角色资料。",
        "FORBIDDEN",
      );
    const r = await client.send(
      new commands.GetObjectCommand({ Bucket: bucket, Key: f.key }),
    );
    const body = await r.Body.transformToByteArray();
    return Buffer.from(crypt.open("image", id, body).data, "base64");
  }
  async function reconcile(a, id) {
    const f = await repo.get("media", id);
    S.ok(
      f?.owner === a.user.id && f.groupId === a.group.id,
      "图片不属于你。",
      "FORBIDDEN",
    );
    if (f.status === "ready") return { id };
    const object = await client.send(
      new commands.GetObjectCommand({ Bucket: bucket, Key: f.key }),
    );
    const decoded = crypt.open(
      "image",
      id,
      await object.Body.transformToByteArray(),
    );
    S.ok(
      S.hash(Buffer.from(decoded.data, "base64")) === f.hash,
      "图片内容核对失败。",
      "UNCERTAIN",
    );
    f.status = "ready";
    await repo.put("media", f, { scope: f.groupId });
    return { id };
  }
  return { upload, read, reconcile };
}
module.exports = { createMedia };
