"use strict";
// Operator-only tool. Recovery always targets new isolated namespaces and object keys.
const crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  S = require("./security"),
  B = require("./backup");
async function storageFromEnv() {
  const aws = require("@aws-sdk/client-s3");
  S.ok(process.env.WEB_BUCKET, "请配置网站私有存储。");
  return {
    bucket: process.env.WEB_BUCKET,
    commands: aws,
    client: new aws.S3Client({
      endpoint: process.env.WEB_S3_ENDPOINT,
      region: process.env.WEB_S3_REGION || "auto",
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
      credentials: {
        accessKeyId: process.env.WEB_S3_ACCESS_KEY,
        secretAccessKey: process.env.WEB_S3_SECRET_KEY,
      },
    }),
  };
}
async function readArchive(storage, crypt, record) {
  S.ok(
    record?.manifest &&
      /^backups\/[a-zA-Z0-9_-]+\/manifest\.enc$/.test(record.manifest),
    "备份索引无效。",
  );
  const object = await storage.client.send(
    new storage.commands.GetObjectCommand({
      Bucket: storage.bucket,
      Key: record.manifest,
    }),
  );
  const decoded = crypt.open(
    "backup",
    record.backupId || record.id,
    await object.Body.transformToByteArray(),
  );
  const archive = JSON.parse(
    zlib.gunzipSync(Buffer.from(decoded.gzip, "base64"), {
      maxOutputLength: 256 * 1024 * 1024,
    }),
  );
  S.ok(archive.format === "wasteland-web-backup-v1", "备份格式无效。");
  return archive;
}
async function restoreImages(storage, crypt, archive, repo, prefix) {
  S.ok(
    /^recovery\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(prefix),
    "恢复图片须使用独立路径。",
  );
  const keys = [];
  for (const image of archive.images || []) {
    const object = await storage.client.send(
      new storage.commands.GetObjectCommand({
        Bucket: storage.bucket,
        Key: image.key,
      }),
    );
    const bytes = await object.Body.transformToByteArray();
    S.ok(
      crypto.createHash("sha256").update(bytes).digest("hex") === image.digest,
      "备份图片摘要不符。",
    );
    const decoded = crypt.open("image", image.id, bytes),
      record = await repo.get("media", image.id);
    S.ok(
      record && record.hash === S.hash(Buffer.from(decoded.data, "base64")),
      "备份图片与元数据不符。",
    );
    const key = prefix + image.id + ".enc";
    await storage.client.send(
      new storage.commands.PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
    keys.push(key);
    record.key = key;
    await repo.put("media", record, { scope: record.groupId });
  }
  return keys;
}
async function main() {
  const [mode, id] = process.argv.slice(2),
    { Pool } = require("pg"),
    pool = new Pool({
      connectionString:
        process.env.WEB_RESTORE_DATABASE_URL || process.env.WEB_DATABASE_URL,
      max: 5,
    }),
    crypt = S.codec(process.env.WEB_DATA_ENCRYPTION_KEY),
    repo = require("./repository").createRepository(pool, crypt),
    storage = await storageFromEnv();
  try {
    if (mode === "backup") {
      const result = await B.createBackups({ pool, repo, crypt, storage }).run(
        true,
      );
      console.log(JSON.stringify(result));
      return;
    }
    if (mode === "list") {
      console.log(
        JSON.stringify(
          (await repo.list("backup"))
            .filter((r) => /^\d+-/.test(r.id))
            .map(({ id, at, images }) => ({ id, at, images })),
        ),
      );
      return;
    }
    S.ok(
      ["verify", "drill", "restore"].includes(mode),
      "用法：backup-cli.js list | backup | verify <编号> | drill <编号> | restore <编号>",
    );
    const record = await repo.get("backup", id),
      archive = await readArchive(storage, crypt, record);
    if (mode === "verify") {
      for (const image of archive.images || []) {
        const object = await storage.client.send(
          new storage.commands.GetObjectCommand({
            Bucket: storage.bucket,
            Key: image.key,
          }),
        );
        S.ok(
          S.hash(Buffer.from(await object.Body.transformToByteArray())) ===
            image.digest,
          "图片备份校验失败。",
        );
      }
      console.log(
        JSON.stringify({
          verified: true,
          images: archive.images?.length || 0,
          at: archive.at,
        }),
      );
      return;
    }
    S.ok(
      process.env.WEB_RESTORE_DATABASE_URL,
      "恢复请设置具有隔离建表权限的WEB_RESTORE_DATABASE_URL。",
    );
    const suffix = crypto.randomBytes(8).toString("hex"),
      names = {
        platform: "web_test_restore_p_" + suffix,
        content: "web_test_restore_c_" + suffix,
        game: "rpg_test_restore_" + suffix,
      };
    let keys = [];
    try {
      await B.restore(pool, archive, { names });
      const restored = require("./repository").createRepository(pool, crypt, {
        schema: names.platform,
      });
      keys = await restoreImages(
        storage,
        crypt,
        archive,
        restored,
        "recovery/" + record.id + "/" + suffix + "/",
      );
      const current = await B.snapshot(pool, { names });
      for (const part of Object.keys(B.definitions))
        for (const table of B.definitions[part].tables)
          S.ok(
            current.namespaces[part][table].length ===
              archive.namespaces[part][table].length,
            "恢复行数不符。",
          );
      console.log(
        JSON.stringify({
          restored: true,
          isolated: true,
          images: keys.length,
          names,
          cleanup: mode === "drill",
        }),
      );
    } finally {
      if (mode === "drill") {
        for (const name of Object.values(names)) {
          S.ok(
            /^(web|rpg)_test_restore_[a-z0-9_]+$/.test(name),
            "恢复清理目标错误。",
          );
          await pool.query('DROP SCHEMA IF EXISTS "' + name + '" CASCADE');
        }
        for (const Key of keys)
          await storage.client.send(
            new storage.commands.DeleteObjectCommand({
              Bucket: storage.bucket,
              Key,
            }),
          );
      }
    }
  } finally {
    await pool.end();
    storage.client.destroy?.();
  }
}
module.exports = { readArchive, restoreImages, storageFromEnv };
if (require.main === module)
  main().catch((e) => {
    console.error("网站备份工具失败：" + (e.code || "VERIFY"));
    process.exitCode = 1;
  });
