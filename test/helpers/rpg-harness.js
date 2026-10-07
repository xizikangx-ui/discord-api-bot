'use strict';
const crypto=require('node:crypto'),D=require('discord.js');
const C=require('../../src/rpg/constants'),M=require('../../src/rpg/model'),B=require('../../src/rpg/combat'),AM=require('../../src/rpg/ammunition');
const minRng = min => min;
function training(s,uid){if(!s.players[uid].equipped.weapon){const t=weapon(s,{weightKg:0,damage:{physical:'1'}});const item=M.issue(s,uid,t.id)[0];M.equip(s,uid,item.id);}return s.players[uid].equipped.weapon;}
function reloadViaMagazine(s,b,turn,ammo,magazine){const a=B.actorById(b,b.current.actorId),weaponId=B.actorCharacter(s,a).equipped.weapon;const again=()=>{B.finish(s,b,b.current.id,minRng);while(b.current.actorId!==a.id)B.finish(s,b,b.current.id,minRng);};AM.battleOperation(s,b,turn,{type:'extract',weapon:weaponId});again();AM.battleOperation(s,b,b.current.id,{type:'fill',magazine,ammo});again();AM.battleOperation(s,b,b.current.id,{type:'swap',weapon:weaponId,magazine});}
function state() {
  const s = C.newState(C.DEFAULT_GUILD_ID);
  for (const [uid, agility] of [['1', 6], ['2', 4], ['3', 2]]) {
    const p = M.newCharacter('角色' + uid, { strength: 5, constitution: 5, mind: 5, appearance: 5, intelligence: 5, agility, knowledge: 5 }, 1);
    p.userId = uid; s.players[uid] = p;
  }
  return s;
}
function weapon(s, extra = {}) {
  return M.publishTemplate(s, { kind: '武器', name: '测试武器', rarity: 'white', weightKg: 1, value: 10, quality: '标准', origin: '未知',
    traitIds: ['neutral'], weaponType: '剑', hit: 10, damage: { physical: '1d6' }, primary: 'physical', range: 1, ...extra });
}
function fight(s = state()) {
  training(s,'1');training(s,'2');const b = B.createBattle(s, 'channel', 'GM', '测试战斗'); B.join(s, b, '1'); B.join(s, b, '2');
  B.start(s, b, null, minRng); return { s, b };
}
function collection(entries) { return new D.Collection(entries); }
function harness() {
  const fileBodies = new Map(), messages = collection(), settings = {}, sent = [];
  let count = 0, failure = null;
  const key = crypto.randomBytes(32);
  const encrypt = value => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
  };
  const decrypt = value => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); d.setAuthTag(Buffer.from(value.tag, 'base64'));
    return { encrypted: true, value: JSON.parse(Buffer.concat([d.update(Buffer.from(value.body, 'base64')), d.final()])) };
  };
  function write(message, options) {
    message.content = options.content; message.lastPayload = options;
    message.attachments = collection((options.files || []).map((f, n) => {
      const url = 'memory:' + (++count); fileBodies.set(url, Buffer.from(f.attachment).toString());
      return [String(n), { name: f.name, url }];
    }));
    return message;
  }
  const ch = { id: 'storage', guild: { maximumFileSize: 10485760 }, guildId: C.DEFAULT_GUILD_ID, isTextBased: () => true,
    messages: { fetch: async options => {
      if (typeof options === 'string' || options.message) {
        const m = messages.get(typeof options === 'string' ? options : options.message);
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return m;
      }
      const batch = [...messages.entries()].filter(([id]) => !options.before || Number(id) < Number(options.before)).reverse().slice(0, options.limit || 100);
      return collection(batch);
    } },
    send: async options => {
      const id = String(1000 + (++count));
      const message = { id, channelId: 'channel', author: { id: 'BOT' }, attachments: collection(),
        edit: async options => {
          if (failure === 'before') { failure = null; throw new Error('network'); }
          write(message, options);
          if (failure === 'after') { failure = null; throw new Error('network'); }
          return message;
        } };
      messages.set(id, write(message, options)); sent.push(message); return message;
    } };
  const guild = { id: C.DEFAULT_GUILD_ID, roles: { cache: collection(), fetch: async () => guild.roles.cache },
    members: { fetch: async ({ user }) => members[user], fetchMe: async () => botMember } };
  function member(id, roles = [], manage = false) {
    return { id, user: { id, username: '成员' + id }, displayName: '成员' + id,
      permissions: new D.PermissionsBitField(manage ? D.PermissionFlagsBits.ManageGuild : 0n),
      roles: { cache: collection(roles.map(r => [r, { id: r }])), highest: { position: 10 },
        add: async ids => ids.forEach(r => members[id].roles.cache.set(r, { id: r })),
        remove: async ids => ids.forEach(r => members[id].roles.cache.delete(r)) } };
  }
  const members = { GM: member('GM', ['gm']), '1': member('1', ['player']), '2': member('2', ['player']), ADMIN: member('ADMIN', [], true), stranger: member('stranger') };
  const botMember = member('BOT'); botMember.permissions = new D.PermissionsBitField(D.PermissionFlagsBits.Administrator);
  const client = { user: { id: 'BOT' }, channels: { fetch: async () => ch } };
  const deps = { client, channel: () => ch, settingsFor: id => settings[id] ||= {}, saveIndex: async () => {},
    encrypt, decrypt, fetcher: async url => ({ ok: fileBodies.has(url), json: async () => JSON.parse(fileBodies.get(url)) }),
    guildIds: () => [C.DEFAULT_GUILD_ID], logFailure: () => {} };
  let interactionSeq = 0;
  function interaction(uid, commandName, options = {}, customId, values, fields) {
    const data = { id: 'interaction-' + (++interactionSeq), user: members[uid].user, member: members[uid], guild, guildId: guild.id, channelId: 'channel', channel: ch,
      commandName, customId, values, fields: { getTextInputValue: k => fields[k] },
      isChatInputCommand: () => !!commandName, isAutocomplete: () => false, isModalSubmit: () => !!fields,
      options: { getString: k => options[k] ?? null, getInteger: k => options[k] ?? null, getNumber: k => options[k] ?? null,
        getAttachment: k => options[k] ?? null, getUser: k => options[k] ? { id: options[k] } : null, getSubcommand: () => options.sub },
      deferReply: async options => { data.deferred = true; data.deferOptions = options; },
      deferUpdate: async () => { data.deferred = true; data.updatedSource = true; },
      editReply: async value => { data.result = value; (data.edits ||= []).push(value); },
      reply: async value => { data.replied = true; data.result = value; },
      showModal: async value => { data.modal = value; } };
    return data;
  }
  return { deps, settings, messages, fileBodies, encrypt, decrypt, sent, ch, guild, members, interaction,
    fail: mode => { failure = mode; } };
}

module.exports={harness,state,weapon,fight,minRng};
