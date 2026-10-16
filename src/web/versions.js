'use strict';
const G = require('../rpg/gm-service');
// Opaque baselines describe objects already available to this user. They carry no contents.
function versions(s, { uid, roomIds, gm = false, sources },hash=(source,id)=>G.fingerprint(id?s[source]?.[id]:s[source])) {
  const result = { 'config:': hash('config') };
  for (const source of [...new Set([...Object.values(G.KINDS), 'players', 'characterDrafts', 'battles', 'explorations', 'offers', 'checks', 'sessions', 'deaths', 'corpses','markets'])]) {
    if(sources&&!sources.includes(source))continue;
    for (const [id, value] of Object.entries(s[source] || {})) {
      if(!gm&&Object.values(G.KINDS).includes(source)&&!value.published)continue;
      if(!gm&&source==='offers'&&![value.creatorId,value.targetId].includes(uid))continue;
      if(!gm&&['deaths','corpses'].includes(source)&&(!s.battles[value.battleId]||s.battles[value.battleId].channelId&&!roomIds.has(s.battles[value.battleId].channelId)))continue;
      if (!gm && source === 'characterDrafts' && id !== uid) continue;
      if (!gm && ['battles', 'explorations', 'checks', 'sessions'].includes(source) && (value.status === 'draft' || value.channelId && !roomIds.has(value.channelId))) continue;
      if(source==='markets')continue;
      result[source + ':' + id] = hash(source,id);
    }
  }
  for (const source of ['players', 'characterDrafts']) result[source + ':' + uid] = hash(source,uid);
  return result;
}
function createVersionCache(){const groups=new Map();return {
 get(s,options){let c=groups.get(s.guildId);if(!c||c.revision!==s.revision){c={revision:s.revision,hashes:new Map()};groups.set(s.guildId,c);}return versions(s,options,(source,id)=>{const key=source+':'+(id||'');if(!c.hashes.has(key))c.hashes.set(key,{source,id,hash:G.fingerprint(id?s[source]?.[id]:s[source])});return c.hashes.get(key).hash;});},
 commit(before,next){const c=groups.get(next.guildId);if(!c)return;for(const e of c.hashes.values()){const hash=G.fingerprint(e.id?next[e.source]?.[e.id]:next[e.source]);if(hash!==e.hash)e.hash=hash;}c.revision=next.revision;},
 forget(group){groups.delete(group);}
};}
module.exports = { versions,createVersionCache };
