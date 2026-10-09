// Keep display and read cursors scoped before effects run after a channel switch.
export const roomMessages=(messages,roomId)=>messages.filter(m=>m.roomId===roomId);
export function mergeMessages(old,incoming){
 const map=new Map(old.map(m=>[m.id,m]));
 for(const m of incoming){const prior=map.get(m.id);if(!prior||(!prior.deleted&&m.sequence>=prior.sequence)||m.deleted)map.set(m.id,m);}
 return [...map.values()].sort((a,b)=>a.sequence-b.sequence);
}
