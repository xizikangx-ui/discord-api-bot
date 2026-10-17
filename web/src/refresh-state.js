export const sectionFields={world:['world'],dashboard:['dashboard','containers'],market:['markets'],core:['player','draft','roster','skills','historicalDeathIds'],bag:['offers','coupons'],battle:['battles','corpses'],explore:['maps'],activities:['checks','sessions','glossary','texts'],history:['actionDrafts','actionHistory'],management:[]};
export function visibleSections(tab,game,panelOpen=true){if(!panelOpen&&tab!=='gm')return ['dashboard'];const base=['dashboard','market'];const extra={character:['core'],bag:['core','bag'],skills:['core','battle'],battle:['core','battle','explore'],explore:['core','explore','battle','world'],activities:['activities'],settings:['core'],home:['activities','battle','explore'],library:[],more:[],gm:allSections};if(extra[tab])return [...new Set([...base,...extra[tab]])];if(!game?.dashboard)return base;if(!game.dashboard.player)return [...base,'core'];return game.dashboard.battle?[...base,'core','battle','explore']:game.dashboard.map?[...base,'core','explore','battle']:base;}
export const allSections=Object.keys(sectionFields);
const emptyGame=()=>({player:null,draft:null,roster:[],skills:[],historicalDeathIds:[],offers:[],coupons:[],battles:[],corpses:[],maps:[],checks:[],sessions:[],glossary:[],texts:[],actionDrafts:[],actionHistory:[],containers:[],markets:[],versions:{},sectionVersions:{},revision:-1});
export function mergeGame(current,incoming){
  if(!current)current=emptyGame();
  const result={...current,versions:{...current.versions},sectionVersions:{...current.sectionVersions},revision:Math.max(current.revision,incoming.revision)};
  const accepted=(incoming.sections||allSections).filter(k=>(incoming.sectionVersions?.[k]??incoming.revision)>=(current.sectionVersions?.[k]??-1));
  for(const k of accepted){for(const field of sectionFields[k]||[])if(Object.hasOwn(incoming,field))result[field]=incoming[field];result.sectionVersions[k]=incoming.sectionVersions?.[k]??incoming.revision;}
  if(incoming.revision>=current.revision)Object.assign(result.versions,incoming.versions);
  return result;
}
// One in-flight read per group; changes arriving during it form the next read.
export function refreshQueue(load,apply,needed=()=>true){
  let flight=null,queued=new Map(),reading=new Set();
  return function request(names=allSections,expected={}){
    if(!names.length)return flight||Promise.resolve();
    for(const k of names){const target=expected[k];if(!needed(k,target??-1)||target===undefined&&reading.has(k))continue;queued.set(k,Math.max(queued.get(k)??-1,target??-1));}
    if(!queued.size)return flight||Promise.resolve();
    if(!flight)flight=(async()=>{try{while(queued.size){const keys=[...queued].filter(([k,v])=>needed(k,v)).map(([k])=>k);queued.clear();if(!keys.length)break;reading=new Set(keys);apply(await load(keys));reading.clear();}}finally{reading.clear();flight=null;}})();
    return flight;
  };
}
export function unreadEvent(rooms,event){return rooms.map(r=>{if(r.id!==event.roomId)return r;const sequence=Math.max(r.sequence||0,event.sequence),readSequence=r.readSequence??((r.sequence||0)-(r.unread||0));return {...r,sequence,readSequence,unread:Math.max(0,sequence-readSequence)};});}
export function markRead(rooms,roomId,value){return rooms.map(r=>{if(r.id!==roomId)return r;const sequence=Math.max(r.sequence||0,value),readSequence=Math.max(r.readSequence||0,value);return {...r,sequence,readSequence,unread:Math.max(0,sequence-readSequence)};});}
