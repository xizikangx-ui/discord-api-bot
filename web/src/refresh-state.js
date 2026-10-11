export const sectionFields={core:['player','draft','roster','skills','historicalDeathIds'],bag:['offers','coupons'],battle:['battles','corpses'],explore:['maps'],activities:['checks','sessions','glossary','texts'],history:['actionDrafts','actionHistory'],management:[]};
export const allSections=Object.keys(sectionFields);
export function mergeGame(current,incoming){
  if(!current)return incoming;
  const result={...current,versions:{...current.versions},sectionVersions:{...current.sectionVersions},revision:Math.max(current.revision,incoming.revision)};
  const accepted=(incoming.sections||allSections).filter(k=>(incoming.sectionVersions?.[k]??incoming.revision)>=(current.sectionVersions?.[k]??-1));
  for(const k of accepted){for(const field of sectionFields[k]||[])if(Object.hasOwn(incoming,field))result[field]=incoming[field];result.sectionVersions[k]=incoming.sectionVersions?.[k]??incoming.revision;}
  if(incoming.revision>=current.revision)Object.assign(result.versions,incoming.versions);
  return result;
}
// One in-flight read per group; changes arriving during it form the next read.
export function refreshQueue(load,apply){let flight=null,queued=new Set();return function request(names=allSections){for(const k of names)queued.add(k);if(!flight)flight=(async()=>{try{while(queued.size){const keys=[...queued];queued.clear();apply(await load(keys));}}finally{flight=null;}})();return flight;};}
export function unreadEvent(rooms,event){return rooms.map(r=>{if(r.id!==event.roomId)return r;const sequence=Math.max(r.sequence||0,event.sequence),readSequence=r.readSequence??((r.sequence||0)-(r.unread||0));return {...r,sequence,readSequence,unread:Math.max(0,sequence-readSequence)};});}
export function markRead(rooms,roomId,value){return rooms.map(r=>{if(r.id!==roomId)return r;const sequence=Math.max(r.sequence||0,value),readSequence=Math.max(r.readSequence||0,value);return {...r,sequence,readSequence,unread:Math.max(0,sequence-readSequence)};});}
