export function mapStage(m){
  if(!m)return '未选择';
  if(m.status!=='draft')return {active:'进行中',paused:'已暂停',ended:'已结束'}[m.status]||m.status;
  const content=Object.values(m.cells||{}).filter(c=>c.type==='room'||c.hasContents);
  if(m.mode==='fixed'&&content.some(c=>!c.templateId&&!c.room))return '待布置';
  return m.generated&&content.every(c=>c.room)?'可发布':'待生成';
}
export function gridCells(width,rows,cells){return Array.from({length:width*rows},(_,i)=>({ref:(i%width)+','+Math.floor(i/width),cell:cells[(i%width)+','+Math.floor(i/width)]}));}
export function mapCommandAllowed(command,m,cell){
  if(['map.create','map.quickCreate','map.cleanup'].includes(command))return true;
  if(!m||m.status==='ended')return false;
  const c=m.cells?.[cell],r=c?.room,editable=['draft','paused'].includes(m.status);
  if(command==='map.boss')return editable&&!!r&&!r.boss&&!r.merchant&&!c.touched;
  if(command==='map.bossClear')return editable&&!!r?.boss&&!c.touched;
  if(command==='map.bossConfirm')return r?.bossRequest?.status==='pending';
  if(command==='map.merchant')return editable&&!!c&&!r?.boss&&!r?.merchant&&!c.touched&&(c.type==='room'||c.hasContents);
  if(command==='map.merchantClear')return editable&&!!r?.merchant&&!c.touched;
  if(command==='map.restock')return !!r?.merchant;
  if(command==='map.auto')return editable&&!!r;
  if(command==='map.transfer')return !!r?.containers?.some(v=>v.status==='pending');
  if(command==='map.encounter')return !!r&&r.encounter==='pending'&&m.status!=='draft'&&!r.boss;
  if(command==='map.resolve')return !!r&&r.encounter!=='resolved';
  if(command==='map.link')return editable&&c?.type==='building';
  if(['map.layout','map.generate','map.publish'].includes(command))return m.status==='draft'&&(command!=='map.publish'||mapStage(m)==='可发布');
  if(command==='map.pause')return m.status==='active';
  if(command==='map.resume')return m.status==='paused';
  if(['map.cell','map.link','map.boss','map.bossClear','map.merchant','map.merchantClear','map.auto','map.rpEnabled'].includes(command))return ['draft','paused'].includes(m.status)&&(!['map.rpEnabled'].includes(command)?!!cell:true);
  if(['map.playerPosition','map.playerRemove'].includes(command))return m.status==='paused';
  if(['map.restock','map.transfer','map.encounter','map.resolve','map.bossConfirm'].includes(command))return !!cell;
  if(command==='map.rp')return !!m.rpPendingId;
  return true;
}
// A response belongs to both its selected object and the request that produced it.
export function requestGate(){let version=0;return {next:()=>++version,valid:n=>n===version,invalidate:()=>++version};}
