"use strict";
const crypto = require("node:crypto"),
  { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt),
  hash = (v) =>
    crypto
      .createHash("sha256")
      .update(Buffer.isBuffer(v) ? v : String(v))
      .digest("hex"),
  token = () => crypto.randomBytes(32).toString("base64url");
function fail(message, code = "VALIDATION", details) {
  const e = Error(message);
  e.code = code;
  e.details = details;
  throw e;
}
function ok(condition, message, code) {
  if (!condition) fail(message, code);
}
function text(v, label, max = 80, min = 1) {
  ok(
    typeof v === "string" && v.trim().length >= min && v.trim().length <= max,
    label + "长度须为" + min + "—" + max + "字。",
  );
  return v.trim();
}
function codec(encoded) {
  const key = Buffer.from(encoded || "", "base64");
  ok(key.length === 32, "网站加密密钥必须为32字节Base64。");
  return {
    seal(scope, id, value) {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(scope + ":" + id));
      const bytes = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return Buffer.from(
        JSON.stringify({
          v: 1,
          iv: iv.toString("base64"),
          tag: c.getAuthTag().toString("base64"),
          data: bytes.toString("base64"),
        }),
      );
    },
    open(scope, id, bytes) {
      const e = JSON.parse(Buffer.from(bytes).toString()),
        d = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(e.iv, "base64"),
        );
      ok(e.v === 1, "加密数据版本错误。");
      d.setAAD(Buffer.from(scope + ":" + id));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          d.update(Buffer.from(e.data, "base64")),
          d.final(),
        ]).toString(),
      );
    },
  };
}
let active = 0;
const waiting = [];
async function password(value, prior) {
  ok(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
    "密码须为12—128字，可使用长句。",
  );
  ok(waiting.length < 32, "登录请求较多，请稍后再试。", "RATE_LIMIT");
  if (active >= 2) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    const salt = prior?.salt || crypto.randomBytes(16).toString("hex"),
      bytes = await scrypt(value, salt, 32, {
        N: 131072,
        r: 8,
        p: 1,
        maxmem: 192 * 1024 * 1024,
      });
    return prior
      ? crypto.timingSafeEqual(bytes, Buffer.from(prior.digest, "hex"))
      : { salt, digest: bytes.toString("hex"), algorithm: "scrypt-131072-8-1" };
  } finally {
    active--;
    waiting.shift()?.();
  }
}
function rpgCodec(encoded) {
  const key = Buffer.from(encoded || "", "base64");
  ok(key.length === 32, "跑团密钥格式错误。");
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv("aes-256-gcm", key, iv),
        data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return JSON.stringify({
        encrypted: true,
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      });
    },
    decrypt(e) {
      const d = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(e.iv, "base64"),
      );
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      return {
        encrypted: true,
        value: JSON.parse(
          Buffer.concat([
            d.update(Buffer.from(e.data, "base64")),
            d.final(),
          ]).toString(),
        ),
      };
    },
  };
}
module.exports = { hash, token, fail, ok, text, codec, password, rpgCodec };
