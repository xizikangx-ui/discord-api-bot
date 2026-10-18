'use strict';
const C=require('./constants'),X=require('./exploration'),{randomInt}=require('node:crypto');
function shuffled(list,rng){const a=[...list];for(let n=a.length-1;n>0;n--){const k=rng(0,n+1);[a[n],a[k]]=[a[k],a[n]];}return a;}
function options(raw={}){return {blockedPercent:C.number(raw.blockedPercent??15,'阻挡比例',0,30),stairsMin:C.number(raw.stairsMin??1,'最少楼梯连接',1,3),stairsMax:C.number(raw.stairsMax??3,'最多楼梯连接',raw.stairsMin??1,3),maxRank:C.number(raw.maxRank??3,'怪物等级上限',1,10),combatPercent:C.number(raw.combatPercent??30,'普通内容房战斗比例',0,100)};}
function stairLinks(cells,extents,width,rows,o,rng){
 const choices=[];
 for(let y=1;y<rows;y++){
  const overlap=Array.from({length:width},(_,x)=>x).filter(x=>cells[X.key(x,y)]&&cells[X.key(x,y-1)]),minimum=Math.min(o.stairsMin,overlap.length);
  // A maximum is a ceiling, not a request to fill a narrow floor with stairs.
  const maximum=Math.max(minimum,Math.min(o.stairsMax,Math.floor(overlap.length/3)||1)),count=rng(minimum,maximum+1),sets=[];
  const visit=(start,picked)=>{if(picked.length===count){sets.push(picked);return;}for(let n=start;n<=overlap.length-(count-picked.length);n++)visit(n+1,[...picked,overlap[n]]);};visit(0,[]);
  choices.push(shuffled(sets,rng));
 }
 const selected=[],failed=new Set();
 function choose(index,previous=[]){
  if(index===choices.length)return true;
  const memo=index+':'+previous.join(',');if(failed.has(memo))return false;
  for(const next of choices[index]){
   // Adjacent connections may share a landing. Keep a real room on each floor.
   if(new Set([...previous,...next]).size>=extents[index].len||next.length>=extents[index+1].len)continue;
   selected[index]=next;if(choose(index+1,next))return true;
  }
  failed.add(memo);return false;
 }
 C.requireThat(choose(0),'当前尺寸和楼梯设置不能为每层保留房间，请增加列数或减少最少楼梯连接。');
 for(let n=0;n<selected.length;n++)for(const x of selected[n])for(const y of [n,n+1])cells[X.key(x,y)].type='stairs';
 return selected;
}
function build(m,raw={},rng=randomInt){C.requireThat(m.status==='draft','只能重新生成草稿布局。');C.requireThat(!Object.values(m.cells||{}).some(c=>c.room?.boss||c.room?.merchant),'请先移除手动BOSS房或行商节点再重抽布局。');const o=options(raw),cells={},width=m.width,rows=m.floors,region=m.mapType==='region';
 const extents=[];for(let y=0;y<rows;y++){const len=raw.irregular===false?width:rng(Math.min(4,width),width+1);const possible=Array.from({length:width-len+1},(_,x)=>x).filter(x=>!y||Math.min(x+len,extents[y-1].x+extents[y-1].len)-Math.max(x,extents[y-1].x)>=Math.min(region?2:o.stairsMin+1,len));C.requireThat(possible.length,'无法连接不规则楼层，请增加宽度。');const x=possible[rng(0,possible.length)];extents.push({x,len});for(let n=x;n<x+len;n++){const type=region?['road','wild','forest','ruins','landmark','building'][rng(0,6)]:rng(0,100)<70?'room':'corridor';cells[X.key(n,y)]={type,categoryId:m.categoryId,...(region?{hasContents:false,passable:true}:{})};}}
 const links=region?[]:stairLinks(cells,extents,width,rows,o,rng);
 const topStairs=links[0]||[],startX=topStairs.length?topStairs[rng(0,topStairs.length)]:extents[0].x+rng(0,extents[0].len),entrance=X.key(startX,0);cells[entrance]={type:'entrance',categoryId:m.categoryId};m.cells=cells;
 if(region){
  // Terrain is not a room. Spread saved content across the region instead of
  // treating every forest, ruin and unbound building as a monster room.
  const candidates=shuffled(Object.keys(cells).filter(ref=>ref!==entrance&&cells[ref].type!=='road'),rng),limit=Math.min(candidates.length,Math.max(1,Math.floor((Object.keys(cells).length-1)/2)));
  for(const ref of candidates.slice(0,limit))cells[ref].hasContents=true;
 }else for(let y=0;y<rows;y++){
  const floor=Object.keys(cells).filter(ref=>X.xy(ref)[1]===y&&!['entrance','stairs'].includes(cells[ref].type));
  if(!floor.some(ref=>cells[ref].type==='room')&&floor.length)cells[floor[rng(0,floor.length)]].type='room';
 }
 const target=Math.floor(Object.keys(cells).length*o.blockedPercent/100);let blocked=0;
 for(const ref of shuffled(Object.keys(cells),rng)){if(blocked>=target)break;const c=cells[ref];if(['entrance','stairs'].includes(c.type))continue;if(!region&&c.type==='room'&&!Object.entries(cells).some(([r,v])=>r!==ref&&X.xy(r)[1]===X.xy(ref)[1]&&v.type==='room'))continue;const old=C.clone(c);cells[ref]=region?{type:rng(0,2)?'water':'mountain',passable:false,categoryId:m.categoryId}:{type:'wall',categoryId:m.categoryId};try{X.validateMap(m);blocked++;}catch{cells[ref]=old;}}
 if(!Object.values(cells).some(c=>c.type==='room'||c.hasContents)){
  let placed=false;
  for(const ref of Object.keys(cells).filter(r=>cells[r].type!=='entrance'&&X.passable(cells[r]))){
   const old=cells[ref];cells[ref]={...old,type:region?'landmark':'room',...(region?{hasContents:true}:{})};
   const [,cy]=X.xy(ref),pairs=[cy,cy+1].filter(y=>y>0&&y<rows);
   const enough=region||pairs.every(y=>{let overlap=0,links=0;for(let x=0;x<width;x++){const a=cells[X.key(x,y-1)],b=cells[X.key(x,y)];if(a&&b)overlap++;if(['stairs','entrance'].includes(a?.type)&&['stairs','entrance'].includes(b?.type))links++;}return links>=Math.min(o.stairsMin,overlap);});
   if(enough){try{X.validateMap(m);placed=true;break;}catch{}}
   cells[ref]=old;
  }
  C.requireThat(placed,'当前尺寸和楼梯设置没有可用房间，请增加列数或减少最少楼梯连接。');
 }
 X.validateMap(m);m.generation={mode:raw.mode||'manual',...o,extents,blocked,at:Date.now()};m.generated=false;m.maxRank=o.maxRank;m.version++;return m;
}
function repairStairs(state,m,rng=randomInt){
 C.requireThat(['draft','paused'].includes(m.status),'请先暂停地图，再修复多余楼梯。');C.requireThat(m.mapType!=='region','区域地图没有室内楼梯可修复。');
 const staged=C.clone(m),changed=[],minimum=m.generation?.stairsMin??1;
 for(const [ref,c] of Object.entries(staged.cells)){
  if(c.type!=='stairs'||c.room||X.touched(m,ref))continue;
  const old=C.clone(c);c.type='room';
  const [,y]=X.xy(ref),enough=[y,y+1].filter(n=>n>0&&n<m.floors).every(n=>{
   let overlap=0,links=0;for(let x=0;x<m.width;x++){const a=staged.cells[X.key(x,n-1)],b=staged.cells[X.key(x,n)];if(a&&b)overlap++;if(['stairs','entrance'].includes(a?.type)&&['stairs','entrance'].includes(b?.type))links++;}return links>=Math.min(minimum,overlap);
  });
  try{C.requireThat(enough,'必要楼梯');X.validateMap(staged);}catch{staged.cells[ref]=old;continue;}
  // Only the newly created room is rolled. Existing rooms, enemies and loot
  // are frozen, including a room that another player has already revealed.
  if(m.generated)c.room=X.instantiate(state,X.selectRoom(state,staged,c,rng),rng,m.maxRank??10,c.variantId);
  changed.push(ref);
 }
 C.requireThat(changed.length,'没有可安全替换的多余楼梯；已进入格、已有内容和必要连接会保留。');
 staged.version++;staged.lastEvent='已修复 '+changed.length+' 处多余楼梯，原房间、物资和NPC保持原结果。';Object.assign(m,staged);
 return {id:m.id,changed,count:changed.length,version:m.version};
}
function create(state,owner,channel,name,type,mode,categoryId,rows,width,raw={},rng=randomInt){C.requireThat(['full','manual','fixed'].includes(mode),'生成方式无效。');const pool=Object.values(state.mapCategories).filter(t=>t.published&&(t.mapTypes||['indoor','region']).includes(type));if(mode==='full'){C.requireThat(pool.length,'没有适用大类。');categoryId=pool[rng(0,pool.length)].id;rows=rng(4,9);width=rng(4,9);}const category=state.mapCategories[categoryId];C.requireThat(category?.published&&(category.mapTypes||['indoor','region']).includes(type),'大类不适用于该地图类型。');const m=X.create(state,owner,channel,name,rows,width,mode==='fixed'?'fixed':'random',categoryId,type);m.maxRank=options(raw).maxRank;if(raw.autoEncounters!==undefined)m.autoEncounters=!!raw.autoEncounters;if(mode!=='fixed')build(m,{...raw,mode},rng);return m;}
module.exports={create,build,options,shuffled,repairStairs};
