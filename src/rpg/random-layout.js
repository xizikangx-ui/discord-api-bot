'use strict';
const C=require('./constants'),X=require('./exploration'),{randomInt}=require('node:crypto');
function shuffled(list,rng){const a=[...list];for(let n=a.length-1;n>0;n--){const k=rng(0,n+1);[a[n],a[k]]=[a[k],a[n]];}return a;}
function options(raw={}){return {blockedPercent:C.number(raw.blockedPercent??15,'阻挡比例',0,30),stairsMin:C.number(raw.stairsMin??1,'最少楼梯连接',1,3),stairsMax:C.number(raw.stairsMax??3,'最多楼梯连接',raw.stairsMin??1,3),maxRank:C.number(raw.maxRank??3,'怪物等级上限',1,10)};}
function build(m,raw={},rng=randomInt){C.requireThat(m.status==='draft','只能重新生成草稿布局。');C.requireThat(!Object.values(m.cells||{}).some(c=>c.room?.boss||c.room?.merchant),'请先移除手动BOSS房或行商节点再重抽布局。');const o=options(raw),cells={},width=m.width,rows=m.floors,region=m.mapType==='region';
 const extents=[];for(let y=0;y<rows;y++){const len=raw.irregular===false?width:rng(Math.min(4,width),width+1);const possible=Array.from({length:width-len+1},(_,x)=>x).filter(x=>!y||Math.min(x+len,extents[y-1].x+extents[y-1].len)-Math.max(x,extents[y-1].x)>=Math.min(2,len));C.requireThat(possible.length,'无法连接不规则楼层，请增加宽度。');const x=possible[rng(0,possible.length)];extents.push({x,len});for(let n=x;n<x+len;n++){const type=region?['road','wild','forest','ruins','landmark','building'][rng(0,6)]:rng(0,100)<70?'room':'corridor';cells[X.key(n,y)]={type,categoryId:m.categoryId,...(region?{hasContents:type!=='road',passable:true}:{})};}}
 if(!region)for(let y=1;y<rows;y++){const overlap=[];for(let x=0;x<width;x++)if(cells[X.key(x,y)]&&cells[X.key(x,y-1)])overlap.push(x);const count=rng(Math.min(o.stairsMin,overlap.length),Math.min(o.stairsMax,overlap.length)+1);for(const x of shuffled(overlap,rng).slice(0,count)){cells[X.key(x,y)].type='stairs';cells[X.key(x,y-1)].type='stairs';}}
 const startX=extents[0].x+rng(0,extents[0].len),entrance=X.key(startX,0);cells[entrance]={type:'entrance',categoryId:m.categoryId};m.cells=cells;
 const target=Math.floor(Object.keys(cells).length*o.blockedPercent/100);let blocked=0;
 for(const ref of shuffled(Object.keys(cells),rng)){if(blocked>=target)break;const c=cells[ref];if(['entrance','stairs'].includes(c.type))continue;const old=C.clone(c);cells[ref]=region?{type:rng(0,2)?'water':'mountain',passable:false,categoryId:m.categoryId}:{type:'wall',categoryId:m.categoryId};try{X.validateMap(m);blocked++;}catch{cells[ref]=old;}}
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
function create(state,owner,channel,name,type,mode,categoryId,rows,width,raw={},rng=randomInt){C.requireThat(['full','manual','fixed'].includes(mode),'生成方式无效。');const pool=Object.values(state.mapCategories).filter(t=>t.published&&(t.mapTypes||['indoor','region']).includes(type));if(mode==='full'){C.requireThat(pool.length,'没有适用大类。');categoryId=pool[rng(0,pool.length)].id;rows=rng(4,9);width=rng(4,9);}const category=state.mapCategories[categoryId];C.requireThat(category?.published&&(category.mapTypes||['indoor','region']).includes(type),'大类不适用于该地图类型。');const m=X.create(state,owner,channel,name,rows,width,mode==='fixed'?'fixed':'random',categoryId,type);m.maxRank=options(raw).maxRank;if(mode!=='fixed')build(m,{...raw,mode},rng);return m;}
module.exports={create,build,options,shuffled};
