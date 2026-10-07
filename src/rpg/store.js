'use strict';
const { gzipSync, gunzipSync } = require('node:zlib');
const C = require('./constants');
const { migrate } = require('./activities');

// A failed Discord write is not retried with fresh dice. The canonical attachment
// must be read first; unresolved outcomes freeze this guild until a GM recovers it.
function createStore({ client, channel, settingsFor, saveIndex, encrypt, decrypt, fetcher = fetch, database, allowImport = false, backgroundPublications = !!database, metrics }) {
  const states = new Map(), messages = new Map(), queues = new Map(), frozen = new Map();
  const depths = new Map(), listeners = new Set(), backupMessages = new Map(), backedUp = new Map(), backupJobs = new Map();
  const loadedDatabaseGuilds = new Set();
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
    const queuedAt = performance.now(); depths.set(guild, (depths.get(guild) || 0) + 1);
    metrics?.gauge('transaction.queue', [...depths.values()].reduce((a, b) => a + b, 0));
    const job = (queues.get(guild) || Promise.resolve()).catch(() => {}).then(async () => {
      metrics?.observe('transaction.wait', performance.now() - queuedAt);
      try { database?.assertLease(); return await fn(); } finally { depths.set(guild, depths.get(guild) - 1);metrics?.gauge('transaction.queue', [...depths.values()].reduce((a,b)=>a+b,0)); }
    });
    queues.set(guild, job);
    job.finally(() => { if (queues.get(guild) === job) queues.delete(guild); }).catch(() => {});
    return job;
  }
  async function load(guild) {
    let state, message;
    if (database) {
      state = await database.load(guild);
      if (!state) {
        C.requireThat(allowImport&&!loadedDatabaseGuilds.has(guild), '数据库没有跑团存档。首次迁移须显式开启RPG_IMPORT_DISCORD_ONCE，拒绝自动回退旧存档。');
        message = await find(guild);
        C.requireThat(message, '数据库没有存档且未找到权威Discord存档，拒绝创建空存档。');
        state = await read(message, guild);
        await database.importState(guild, state, message.id);
        console.log('跑团数据库导入校验完成：版本 ' + state.revision + '。');
      }
      loadedDatabaseGuilds.add(guild);
    } else {
      message = await find(guild);
      state = message ? await read(message, guild) : C.newState(guild);
      if (message) messages.set(guild, message);
      else await persist(guild, state);
    }
    const before = database ? C.clone(state) : null;
    const migration = migrate(state);
    if (migration) {
      state.revision++;
      state.events.push({ id: 'rpg-upgrade-' + state.upgrade, at: Date.now(), actorId: client.user.id, label: '跑团存档升级', result: migration, revision: state.revision });
      if (database) await database.save(guild, before, state); else await persist(guild, state);
    }
    states.set(guild, state); frozen.delete(guild);
    return C.clone(state);
  }
  async function recover(guild) { return serial(guild, () => load(guild)); }
  async function transact(guild, operation, actorId, fn, label = '操作', options = {}) {
    return serial(guild, async () => {
      C.requireThat(states.has(guild), '跑团存档尚未读取，请稍后。');
      C.requireThat(!frozen.has(guild), '存档写入结果待核对，跑团已暂停。GM请使用 /gm 恢复存档。');
      const before = states.get(guild);
      if (before.receipts[operation]) return C.clone(before.receipts[operation].result);
      const computeDone = metrics?.start('transaction.compute');
      const next = C.clone(before);
      const result = await fn(next);
      require('./mortality').reconcile(next, before);
      const savedResult = C.clone(result ?? null);
      next.revision++;
      next.receipts[operation] = { at: Date.now(), result: C.clone(savedResult) };
      next.events.push({ id: operation, at: Date.now(), actorId, label, revision: next.revision, result: C.clone(savedResult) });
      // Interaction IDs cannot be reused after 24h. Full audit entries remain.
      for (const [key, receipt] of Object.entries(next.receipts)) if (Date.now() - receipt.at > 86400000) delete next.receipts[key];
      if (backgroundPublications && options.delivery !== false) require('./outbox').derive(before, next);
      computeDone?.();
      try {
        if (database) await database.save(guild, before, next); else await persist(guild, next);
        states.set(guild, next);
        for (const listener of listeners) { try { listener(guild); } catch { /* Notification cannot invalidate a durable commit. */ } }
        return C.clone(savedResult);
      } catch (error) {
        frozen.set(guild, error.message);
        try {
          let canonical;
          if (database) canonical = await database.load(guild);
          else {
            const canonicalMessage = await find(guild);
            C.requireThat(canonicalMessage, '存档无法定位。');
            canonical = await read(canonicalMessage, guild); messages.set(guild, canonicalMessage);
          }
          C.requireThat(canonical, '权威存档无法定位。');
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
  function select(guild, picker) { C.requireThat(states.has(guild), '跑团尚未初始化。'); return C.clone(picker(states.get(guild))); }
  async function enqueue(guild, kind, ref, options = {}) {
    const key = kind + ':' + ref, job = select(guild, st => st.deliveryJobs?.[key]);
    if (job && ['pending', 'running'].includes(job.status) && !options.force) return key;
    await transact(guild, 'outbox-enqueue:' + C.id('j'), client.user.id, st => require('./outbox').put(st, kind, ref, options), '安排后台公示', { delivery: false });
    return key;
  }
  async function backup(guild) {
    if (backupJobs.has(guild)) return backupJobs.get(guild);
    const job = backupNow(guild); backupJobs.set(guild, job);
    try { return await job; } finally { backupJobs.delete(guild); }
  }
  async function backupNow(guild) {
    if (!database || frozen.has(guild)) return;
    const state = snapshot(guild), ch = channel(), buffer = pack(state), settings = settingsFor(guild);
    C.requireThat(buffer.length < (ch.guild.maximumFileSize || 10 * 1024 * 1024), '数据库加密备份超过Discord附件限制。');
    const day = Math.floor((Date.now() + 8 * 3600000) / 86400000), monday = day - (day + 3) % 7;
    const copies = [{ key: 'latest', period: String(state.revision), label: 'discord-api-bot-rpg-backup-v2:' + guild },
      { key: 'daily-' + day % 6, period: String(day), label: 'discord-api-bot-rpg-backup-v2:' + guild + ':daily:' + day },
      { key: 'weekly-' + Math.floor((day + 3) / 7) % 4, period: String(monday), label: 'discord-api-bot-rpg-backup-v2:' + guild + ':weekly:' + monday }];
    settings.rpgPeriodicBackups ||= {};
    for (const copy of copies) {
      if (copy.key === 'latest' && backedUp.get(guild) === state.revision) continue;
      const pointer = copy.key === 'latest' ? { messageId: settings.rpgDatabaseBackupMessageId, status: settings.rpgDatabaseBackupStatus } : settings.rpgPeriodicBackups[copy.key] || {};
      if (copy.key !== 'latest' && pointer.period === copy.period && pointer.status === 'sent') continue;
      let message = backupMessages.get(copy.key + ':' + guild);
      if (!message && pointer.messageId) message = await ch.messages.fetch({ message: pointer.messageId, force: true });
      const prefix = copy.key === 'latest' ? copy.label : 'discord-api-bot-rpg-backup-v2:' + guild + ':' + copy.key.split('-')[0] + ':';
      if (message) C.requireThat(message.author.id === client.user.id && (copy.key === 'latest' ? message.content === prefix : message.content.startsWith(prefix)), '数据库备份消息归属不符。');
      function record(status, id) {
        if (copy.key === 'latest') { settings.rpgDatabaseBackupStatus = status; if (id) settings.rpgDatabaseBackupMessageId = id; }
        else settings.rpgPeriodicBackups[copy.key] = { ...pointer, status, ...(id ? { messageId: id } : {}), period: copy.period };
      }
      if (!message) {
        C.requireThat(!['sending', 'uncertain'].includes(pointer.status), '数据库备份发送结果待核对，拒绝重复发送。');
        record('sending'); await saveIndex();
      }
      const payload = { content: copy.label, allowedMentions: { parse: [] }, attachments: [], files: [{ attachment: buffer, name: 'rpg-' + guild + '.json.enc' }] };
      try { message = message ? await message.edit(payload) : await ch.send({ ...payload, nonce: require('node:crypto').createHash('sha256').update(copy.label).digest('hex').slice(0, 24), enforceNonce: true }); }
      catch (error) { record('uncertain'); await saveIndex(); throw error; }
      backupMessages.set(copy.key + ':' + guild, message); record('sent', message.id); await saveIndex();
      if (copy.key === 'latest') backedUp.set(guild, state.revision);
    }
  }
  return { load, recover, transact, snapshot, select, enqueue, backup, database, backgroundPublications, get clientId(){return client.user?.id;},
    guilds: () => [...states.keys()], drain: () => Promise.allSettled([...queues.values(),...backupJobs.values()]), onCommit: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    freeze: guild => frozen.set(guild, '运行锁已丢失'), frozen: guild => frozen.has(guild), pack };
}
module.exports = { createStore };
