// A connection boundary prevents history, receipt recovery and delayed outbox
// replay from celebrating old results. IDs unify the HTTP and chat paths.
export function createRareLootTracker({clock=()=>Date.now(),maxSeen=1200,maxQueue=5}={}){
 let group='',cutoff=Infinity;const seen=new Set();
 function remember(id){seen.add(id);while(seen.size>maxSeen)seen.delete(seen.values().next().value);}
 return {
  configure(scope,options={}){group=String(options.groupId||scope);cutoff=clock();seen.clear();},
  reconnect(){cutoff=clock();},
  baseline(values=[]){for(const e of values)if(e?.id)remember(e.id);},
  ingest(values=[],options={}){
   const cues=[];for(const e of values){
    if(!e?.id||seen.has(e.id))continue;
    // Room and audience permissions are enforced by the server for every
    // delivery. A GM's valid hidden-room receipt belongs to this group too.
    if(String(e.groupId)!==group)continue;
    remember(e.id);
    if(options.source==='history'||!Number.isFinite(e.committedAt)||e.committedAt<cutoff||e.committedAt>clock()+60000)continue;
    const items=(e.items||[]).filter(i=>['gold','red'].includes(i.rarity)&&i.name);
    if(items.length)cues.push({...e,items,red:items.some(i=>i.rarity==='red')});
   }return cues.slice(-maxQueue);
  },size:()=>seen.size,
 };
}
