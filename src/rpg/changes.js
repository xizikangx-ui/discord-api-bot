'use strict';
const {createHash}=require('node:crypto'),cache=new WeakMap();
function hash(v){if(v&&typeof v==='object'){if(!cache.has(v))cache.set(v,createHash('sha256').update(JSON.stringify(v)).digest('hex'));return cache.get(v);}return JSON.stringify(v);}
// Full persistence fingerprints include public events and publication state.
// Presentation/version hashes deliberately omit them and must not drive writes.
function changes(before,next){const sources=new Map();for(const key of require('./postgres').COLLECTIONS){const old=before?.[key]||{},current=next[key]||{},ids=new Set();for(const id of new Set([...Object.keys(old),...Object.keys(current)]))if(hash(old[id])!==hash(current[id]))ids.add(id);if(ids.size)sources.set(key,ids);}if(hash(before?.config)!==hash(next.config))sources.set('config',new Set(['']));return sources;}
module.exports={changes};
