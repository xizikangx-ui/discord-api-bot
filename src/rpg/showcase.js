'use strict';
const C=require('./constants'),M=require('./model');
const eligible = p => Object.values(p.inventory).filter(i=>['gold','red'].includes(i.snapshot.rarity));
function entries(s,uid) {const p=M.player(s,uid),byId=new Map(eligible(p).map(i=>[i.id,i]));return (p.showcase||[]).map(id=>byId.get(id)).filter(Boolean);}
function select(s,uid,characterId,page,refs) {
  const p=M.player(s,uid);C.requireThat(p.id===characterId,'角色已变化，请重新打开收藏柜。');const group=eligible(p).slice(page*20,page*20+20),ids=group.map(i=>i.id);
  C.requireThat(new Set(refs).size===refs.length&&refs.every(id=>ids.includes(id)),'展示物品已变化，请重新选择。');
  p.showcase=[...(p.showcase||[]).filter(id=>!ids.includes(id)&&p.inventory[id]),...refs];return p.showcase;
}
module.exports={eligible,entries,select};
