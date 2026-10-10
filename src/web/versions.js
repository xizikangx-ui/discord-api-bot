'use strict';
const G = require('../rpg/gm-service');
// Opaque baselines describe objects already available to this user. They carry no contents.
function versions(s, { uid, roomIds, gm = false }) {
  const result = { 'config:': G.fingerprint(s.config) };
  for (const source of [...new Set([...Object.values(G.KINDS), 'players', 'characterDrafts', 'battles', 'explorations', 'offers', 'checks', 'sessions', 'deaths', 'corpses'])]) {
    for (const [id, value] of Object.entries(s[source] || {})) {
      if(!gm&&Object.values(G.KINDS).includes(source)&&!value.published)continue;
      if(!gm&&source==='offers'&&![value.creatorId,value.targetId].includes(uid))continue;
      if(!gm&&['deaths','corpses'].includes(source)&&(!s.battles[value.battleId]||s.battles[value.battleId].channelId&&!roomIds.has(s.battles[value.battleId].channelId)))continue;
      if (!gm && source === 'characterDrafts' && id !== uid) continue;
      if (!gm && ['battles', 'explorations', 'checks', 'sessions'].includes(source) && (value.status === 'draft' || value.channelId && !roomIds.has(value.channelId))) continue;
      result[source + ':' + id] = G.fingerprint(value);
    }
  }
  for (const source of ['players', 'characterDrafts']) result[source + ':' + uid] = G.fingerprint(s[source]?.[uid]);
  return result;
}
module.exports = { versions };
