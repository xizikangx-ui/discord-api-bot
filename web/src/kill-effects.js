export function killIds(value){
 const ids=new Set();const walk=v=>{if(!v||typeof v!=='object')return;if(v.killed===true&&typeof v.deathId==='string')ids.add(v.deathId);for(const child of Object.values(v))if(typeof child==='object')walk(child);};walk(value);return [...ids];
}
// Only live socket publications are eligible. History and reconnect catch-up seed this set.
export function freshKills(event,seen,ready){if(!ready||event?.type!=='message')return [];const ids=(Array.isArray(event.data?.system?.effectDeaths)?event.data.system.effectDeaths:killIds(event.data?.system?.event)).filter(id=>!seen.has(id));ids.forEach(id=>seen.add(id));return ids;}
