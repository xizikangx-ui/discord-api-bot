const names={entrance:'入口',corridor:'通道',stairs:'楼梯',room:'房间',wall:'墙体',road:'道路',wild:'荒野',forest:'森林',ruins:'遗迹',water:'水域',mountain:'山地',landmark:'地标',building:'建筑',empty:'空地'};
export const terrainNames=names;
// Read saved encounters, never a template's possible enemy pool. A cleared
// encounter remains a battle room in the GM summary, rather than becoming a
// newly generated peaceful room after its enemies have been defeated.
export function roomEncounterView(room){
 if(!room)return{kind:'unknown',label:'待生成'};
 if(room.boss)return{kind:'boss',label:'BOSS'};
 if(room.merchant)return{kind:'merchant',label:'行商'};
 const actualEnemies=Array.isArray(room.npcs)?room.npcs.reduce((n,e)=>n+Math.max(0,Number(e.quantity)||0),0):0;
 const battle=room.encounter==='pending'||room.encounter==='battle'||room.encounterKind==='battle'||room.generation?.role==='battle'||actualEnemies>0||!!room.battleId;
 if(battle)return{kind:'battle',label:room.encounter==='battle'?'战斗中':room.encounter==='resolved'?'遭遇已解除':'战斗遭遇'};
 if(room.encounter==='resolved'||room.encounterKind==='safe')return{kind:'safe',label:'平静探索'};
 return{kind:'unknown',label:'等待处理'};
}
export function mapRoomSummary(map,{revealedOnly=false}={}){
 const summary={ordinary:0,combat:0,safe:0,ungenerated:0,explicit:0,explicitCombat:0,explicitSafe:0,boss:0,merchant:0,containers:0};
 for(const [ref,c]of Object.entries(map?.cells||{})){
  if(!c||c.hidden||revealedOnly&&!map.revealed?.[ref])continue;
  if(c.passable===false||['entrance','stairs','corridor','road','wall'].includes(c.type))continue;
  const room=c.room;if(!room&&c.type!=='room'&&!c.hasContents)continue;
  const view=roomEncounterView(room);
  if(view.kind==='boss')summary.boss++;else if(view.kind==='merchant')summary.merchant++;
  else if(c.templateId||c.variantId){summary.explicit++;if(view.kind==='battle')summary.explicitCombat++;else if(view.kind==='safe')summary.explicitSafe++;}
  else{summary.ordinary++;if(view.kind==='battle')summary.combat++;else if(view.kind==='safe')summary.safe++;else summary.ungenerated++;}
  summary.containers+=Array.isArray(room?.containers)?room.containers.length:0;
 }
 return summary;
}
export function cellName(cell){if(!cell)return '地图外';if(cell.hidden)return '未探索区域';return cell.displayName||cell.room?.merchant?.name||cell.room?.name||cell.name||names[cell.type]||'地点';}
export function floorOf(ref){const n=Number(String(ref||'0,0').split(',')[1]);return Number.isFinite(n)?n:0;}
export function shortPosition(map,ref){if(!ref)return '尚未进入';const [x,y]=ref.split(',').map(Number);return map?.mapType==='region'?String.fromCharCode(65+x)+(y+1):'第'+(y+1)+'层 · '+String.fromCharCode(65+x)+'室';}
export function directionLabel(map,from,to){if(!from||!to)return '前往';const [x,y]=from.split(',').map(Number),[tx,ty]=to.split(',').map(Number);if(tx<x)return map?.mapType==='region'?'向西':'向左';if(tx>x)return map?.mapType==='region'?'向东':'向右';if(ty===y)return '当前位置';return map?.mapType==='region'?(ty>y?'向南':'向北'):(ty>y?'上层':'下层');}
export function directionArrow(map,from,to){const label=directionLabel(map,from,to);return({向左:'←',向右:'→',向东:'→',向西:'←',向南:'↓',向北:'↑',上层:'↗',下层:'↙'})[label]||'◆';}
export function movementReason(map,userId,to){
 const part=map?.participants?.[userId];if(!part)return '先加入探索，再选择相邻地点。';
 if(map.status!=='active')return ({paused:'地图已暂停，请等待 GM 恢复。',draft:'地图尚未发布，请等待 GM 开放。',ended:'地图已经结束，不能继续移动。'})[map.status]||'地图目前不可移动。';
 if(map.rpWaiting)return '等待 GM 发布环境描述后继续。';
 if(map.canMove===false)return map.moveBlockedReason||'当前暂时不能移动。';
 if(map.canMove===undefined&&Object.values(map.moves||{}).some(r=>r.status==='pending'&&r.valid!==false&&r.expiresAt>Date.now()))return '先处理当前全队移动确认。';
 if(!to)return '选择地图上高亮的相邻地点。';
 if(to===part.cell)return '队伍已经在这里。';
 if(!Array.isArray(map.neighbors))return '等待地图状态更新后再移动。';
 if(!map.neighbors.includes(to))return '只能进入高亮的相邻可达地点。';
 return '';
}
export function floorChoices(map,userId){if(!map||map.mapType==='region')return [];const position=map.participants?.[userId]?.cell,current=position?floorOf(position):-1;return Array.from({length:Math.max(1,Number(map.rows)||1)},(_,index)=>({index,label:'第'+(index+1)+'层',current:index===current,present:Object.keys(map.cells||{}).some(ref=>floorOf(ref)===index)}));}
export function boardCells(map,floor=0){if(!map)return [];const width=Number(map.width)||1,rows=map.mapType==='region'?Number(map.rows)||1:1;return Array.from({length:width*rows},(_,n)=>{const x=n%width,y=map.mapType==='region'?Math.floor(n/width):floor,ref=x+','+y;return{ref,x,y,cell:map.cells?.[ref]||null};});}
export function tileView(map,ref,userId,roster=[]){
 const c=map?.cells?.[ref];if(!c)return{ref,empty:true,name:'地图外',type:'empty',party:[],connections:[]};
 if(c.hidden)return{ref,hidden:true,name:'未探索区域',type:'fog',party:[],connections:[]};
 const byUser=Object.fromEntries(roster.map(p=>[p.userId,p.name]));
 const party=Object.entries(map.participants||{}).filter(([,p])=>p.cell===ref).map(([id,p])=>({userId:id,name:p.name||byUser[id]||(id===userId?'你':'队友'),self:id===userId}));
 const [x,y]=ref.split(',').map(Number),directions=[['west',x-1,y],['east',x+1,y],['north',x,y-1],['south',x,y+1]];
 const connections=directions.filter(([,nx,ny])=>{const n=map.cells?.[nx+','+ny];return n&&!n.hidden&&n.type!=='wall'&&n.passable!==false&&(map.mapType==='region'||ny===y);}).map(([d])=>d);
 return{ref,type:c.type||'room',name:cellName(c),typeName:c.typeName||names[c.type]||'地点',description:c.room?.description||c.description||'',blocked:c.type==='wall'||c.passable===false,party,connections,locked:c.room?.unlocked===false,encounter:c.room?.encounter||null,encounterView:c.room?roomEncounterView(c.room):null,merchant:!!c.room?.merchant,here:ref===map.participants?.[userId]?.cell};
}
export function pageItems(list,page,size=8){const pages=Math.max(1,Math.ceil((list||[]).length/size)),index=Math.max(0,Math.min(Number(page)||0,pages-1));return {items:(list||[]).slice(index*size,(index+1)*size),index,pages};}
export function mapDraft(drafts,groupId,mapId){return drafts[groupId+':'+mapId]||{cell:'',key:'',choice:{quantity:1},floor:null};}
export function followResultMap(command,response,{submittedScope,currentScope,active,navigationUnchanged=true}){
 if(!active||!navigationUnchanged||submittedScope!==currentScope||!['map.link','map.vote'].includes(command)||response?.status!=='committed'||response.result?.status!=='completed')return null;
 return typeof response.result.resultMapId==='string'&&response.result.resultMapId?response.result.resultMapId:null;
}
export function merchantReason(map,userId,player,inBattle=false){
 if(!map?.participants?.[userId]||map.participants[userId].validCharacter===false)return '先以当前角色加入这张地图。';
 if(map.status!=='active')return map.status==='paused'?'地图暂停期间不能交易。':'地图尚未开放或已经结束。';
 if(map.rpWaiting)return '等待 GM 发布环境描述后交易。';
 if(!player)return '先创建有效角色。';
 if(player.health?.downed||player.life?.state==='downed'||player.hp!==undefined&&player.hp<=0)return '倒地期间不能交易。';
 if(inBattle)return '战斗结束后才能与行商交易。';
 return '';
}
