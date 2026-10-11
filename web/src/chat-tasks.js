export function chatTasks(game,userId){if(!game)return [];const out=[];
  for(const b of game.battles||[]){for(const h of b.pending||[])out.push({key:h.id,text:'待防守 · '+b.name,system:{battleId:b.id,hitId:h.id,kind:'webDefense'}});if(b.status==='active'&&b.actors.some(a=>a.userId===userId&&a.id===b.current?.actorId))out.push({key:b.id,text:'轮到你行动 · '+b.name,system:{battleId:b.id}});}
  for(const m of game.maps||[]){for(const r of Object.values(m.moves||{}))if(r.status==='pending'&&r.members.includes(userId))out.push({key:r.id,text:'全队移动待确认 · '+m.name,system:{mapId:m.id}});if(m.rpWaiting)out.push({key:m.id,text:'等待环境描述 · '+m.name,system:{mapId:m.id}});}
  for(const o of game.offers||[])if(['editing','ready'].includes(o.status))out.push({key:o.id,text:'交易待处理',tab:'bag'});
  const count=(game.corpses||[]).filter(c=>c.canClaim&&c.items.some(i=>!c.claims[i.id])).length;if(count)out.push({key:'loot',text:'待拾取战利品 · '+count+' 处',tab:'battle'});
  return out;
}
