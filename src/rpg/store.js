'use strict';
const { gzipSync, gunzipSync } = require('node:zlib');
const C = require('./constants');

// A failed Discord write is not retried with fresh dice. The canonical attachment
// must be read first; unresolved outcomes freeze this guild until a GM recovers it.
function createStore({ client, channel, settingsFor, saveIndex, encrypt, decrypt, fetcher = fetch }) {
  const states = new Map(), messages = new Map(), queues = new Map(), frozen = new Map();
  const marker = guild => 'discord-api-bot-rpg-v1:' + guild;
  function pack(state) {
    return Buffer.from(encrypt({ kind: 'rpg-gzip', guildId: state.guildId, revision: state.revision,
      body: gzipSync(Buffer.from(JSON.stringify(state))).toString('base64') }));
  }
  async function read(message, guild) {
    C.requireThat(message.author.id === client.user.id && message.content === marker(guild), '跑团存档归属不符。');
    const attachment = [...message.attachments.values()].find(a => a.name === 'rpg-' + guild + '.json.enc');
    C.requireThat(attachment, '跑团加密存档附件缺失，停止写入。');
    const response = await fetcher(attachment.url);
    C.requireThat(response.ok, '跑团存档下载失败，停止写入。');
    const decrypted = decrypt(await response.json());
    const envelope = decrypted.value;
    C.requireThat(decrypted.encrypted && envelope.kind === 'rpg-gzip' && envelope.guildId === guild, '跑团存档须为本服务器加密数据。');
    const state = JSON.parse(gunzipSync(Buffer.from(envelope.body, 'base64'), { maxOutputLength: 128 * 1024 * 1024 }));
    C.requireThat(state.kind === 'tabletop-rpg' && state.schema === 1 && state.guildId === guild &&
      Number.isSafeInteger(state.revision) && state.revision === envelope.revision, '跑团存档格式或版本不符。');
    return state;
  }
  async function find(guild) {
    const ch = channel();
    C.requireThat(ch?.messages && ch.guild, '私密存储频道未连接。');
    const pointer = settingsFor(guild).rpgStorageMessageId;
    if (pointer) return ch.messages.fetch({ message: pointer, force: true });
    let before;
    // Scan to the end rather than silently treating an old archive as a new game.
    while (true) {
      const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const matches = [...batch.values()].filter(m => m.author.id === client.user.id && m.content === marker(guild));
      C.requireThat(matches.length <= 1, '存在多个跑团存档，请管理员核对。');
      if (matches.length) return matches[0];
      if (batch.size < 100) return null;
      before = batch.last().id;
    }
  }
  async function persist(guild, state) {
    const ch = channel(), buffer = pack(state);
    C.requireThat(buffer.length < (ch.guild.maximumFileSize || 10 * 1024 * 1024), '跑团存档达到附件限制，请先由管理员归档旧审计。');
    const payload = { content: marker(guild), allowedMentions: { parse: [] }, attachments: [],
      files: [{ attachment: buffer, name: 'rpg-' + guild + '.json.enc' }] };
    let message = messages.get(guild);
    message = message ? await message.edit(payload) : await ch.send(payload);
    messages.set(guild, message);
    if (settingsFor(guild).rpgStorageMessageId !== message.id) {
      settingsFor(guild).rpgStorageMessageId = message.id;
      await saveIndex();
    }
  }
  function serial(guild, fn) {
    const job = (queues.get(guild) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(guild, job); return job;
  }
  async function load(guild) {
    const message = await find(guild);
    const state = message ? await read(message, guild) : C.newState(guild);
    if (message) messages.set(guild, message);
    else await persist(guild, state);
    states.set(guild, state); frozen.delete(guild);
    return C.clone(state);
  }
  async function recover(guild) { return serial(guild, () => load(guild)); }
  async function transact(guild, operation, actorId, fn, label = '操作') {
    return serial(guild, async () => {
      C.requireThat(states.has(guild), '跑团存档尚未读取，请稍后。');
      C.requireThat(!frozen.has(guild), '存档写入结果待核对，跑团已暂停。GM请使用 /gm 恢复存档。');
      const before = states.get(guild);
      if (before.receipts[operation]) return C.clone(before.receipts[operation].result);
      const next = C.clone(before);
      const result = await fn(next);
      const savedResult = C.clone(result ?? null);
      next.revision++;
      next.receipts[operation] = { at: Date.now(), result: C.clone(savedResult) };
      next.events.push({ id: operation, at: Date.now(), actorId, label, revision: next.revision, result: C.clone(savedResult) });
      // Interaction IDs cannot be reused after 24h. Full audit entries remain.
      for (const [key, receipt] of Object.entries(next.receipts)) if (Date.now() - receipt.at > 86400000) delete next.receipts[key];
      try {
        await persist(guild, next);
        states.set(guild, next);
        return C.clone(savedResult);
      } catch (error) {
        frozen.set(guild, error.message);
        try {
          const canonicalMessage = await find(guild);
          C.requireThat(canonicalMessage, '存档无法定位。');
          const canonical = await read(canonicalMessage, guild);
          messages.set(guild, canonicalMessage);
          states.set(guild, canonical);
          if (canonical.receipts[operation]) {
            frozen.delete(guild);
            return C.clone(canonical.receipts[operation].result);
          }
        } catch { /* Leave frozen: never overwrite a possibly newer archive. */ }
        throw new Error('存档写入结果不明确，已暂停修改并保留原记录；GM核对 /gm 恢复存档后再操作。');
      }
    });
  }
  function snapshot(guild) { C.requireThat(states.has(guild), '跑团尚未初始化。'); return C.clone(states.get(guild)); }
  return { load, recover, transact, snapshot, frozen: guild => frozen.has(guild), pack };
}
module.exports = { createStore };
