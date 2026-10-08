'use strict';
const C=require('./constants'),M=require('./model'),B=require('./combat'),U=require('./ui'),AM=require('./ammunition'),W=require('./weapons');
function createAmmunitionPanel({snapshot,tx,needGM,publishBattle,actionPanel}) {
  function access(s,i,member,type,ref,actor){
    if(type==='p'){C.requireThat(ref===i.user.id,'只能管理自己的弹药。');const p=M.player(s,ref),b=M.battleFor(s,ref);C.requireThat(!b||b.status!=='active','战斗中请使用当前行动面板的弹夹管理。');AM.normalize(p);return {p};}
    C.requireThat(type==='b','弹药面板无效。');const b=s.battles[ref];C.requireThat(b&&b.status!=='ended','战斗已经结束。');const a=B.actorById(b,actor);
    if(a.userId)C.requireThat(a.userId===i.user.id,'只能操作自己的弹药。');else needGM(s,member);
    C.requireThat(!a.deathId,'该角色已经死亡。');const p=B.actorCharacter(s,a);AM.normalize(p);return {p,b,a};
  }
  const base=(type,ref,actor)=>'ammo:'+type+':'+ref+':'+actor+':';
  function home(s,i,member,type,ref,actor){const {p,b}=access(s,i,member,type,ref,actor),route=base(type,ref,actor);
    const mags=Object.values(p.inventory).filter(m=>m.snapshot.kind==='弹夹');
    const v=U.payload('弹夹与箭匣 · '+p.name,'**弹药 → 弹夹／箭匣 → 武器**\n'+(b?.status==='active'?'抽出、填弹、更换各消耗一次快速行动。':'非战斗场景自由填弹及更换。')+'\n\n'+W.equipped(p).filter(id=>AM.usesMagazine(p.inventory[id].snapshot)).map(id=>{const w=p.inventory[id],m=p.inventory[w.magazineId];return '**'+w.snapshot.name+'**：'+(m?m.snapshot.name+' '+m.loaded.current+'/'+m.loaded.capacity:'未装弹夹／箭匣');}).join('\n')+'\n随身弹夹／箭匣 '+mags.length+' 个',[
      U.row(U.button(route+'weapons:0','更换 / 抽出弹夹',U.D.ButtonStyle.Primary),U.button(route+'magazines:0','向抽出的弹夹填弹'),U.button(route+'home','刷新')),
      U.row(U.button(type==='p'?'gear:view:'+ref+':'+p.id+':overview:0':'view:'+ref+':'+actor+':'+i.user.id+':'+(b.current?.id||'none')+':quick','返回装备 / 行动'))
    ],0xe67e22);v.embeds[0].setFooter({text:'弹夹保存独立弹种与剩余弹药 · 同一面板递进操作'});return v;
  }
  function picker(title,entries,route,page,back){const count=Math.max(1,Math.ceil(entries.length/20));page=Math.max(0,Math.min(Number(page)||0,count-1));
    return U.payload(title,'第'+(page+1)+'/'+count+'页',[
      ...(entries.length?[U.row(U.select(route+':pick','选择一项',entries.slice(page*20,page*20+20)))]:[]),
      U.row(U.button(route+':'+(page-1),'上一页',undefined,!page),U.button(route+':'+(page+1),'下一页',undefined,page===count-1),U.button(back,'返回弹药概览'))]);}
  async function component(i,member){const [,,type,ref,actor,action,arg,extra,last]=i.customId.split(':');const s=snapshot(i.guildId),x=access(s,i,member,type,ref,actor),p=x.p,route=base(type,ref,actor);
    if(action==='home')return home(s,i,member,type,ref,actor);
    if(action==='weapons'){if(arg==='pick'){const w=p.inventory[i.values[0]];C.requireThat(W.equipped(p).includes(w?.id)&&AM.usesMagazine(w.snapshot),'武器已变化。');return U.payload('弹夹管理 · '+w.snapshot.name,'当前 '+(p.inventory[w.magazineId]?.snapshot.name||'未装弹夹'),[
      U.row(U.button(route+'swaplist:'+w.id+':0','选择备用弹夹',U.D.ButtonStyle.Primary),U.button(route+'extractpreview:'+w.id,'抽出当前弹夹',undefined,!w.magazineId)),U.row(U.button(route+'home','返回'))]);}
      return picker('选择已装备枪械 / 弩',W.equipped(p).filter(id=>AM.usesMagazine(p.inventory[id].snapshot)).map(id=>({value:id,label:p.inventory[id].snapshot.name})),route+'weapons',arg,route+'home');}
    if(action==='magazines'){if(arg==='pick'){const mag=p.inventory[i.values[0]];C.requireThat(mag?.snapshot.kind==='弹夹'&&!AM.attached(p,mag.id),'弹夹已变化。');return picker('选择兼容弹药',Object.values(p.inventory).filter(a=>a.snapshot.kind==='弹药'&&AM.ammoCompatible(mag.snapshot,a.snapshot)).map(a=>({value:a.id,label:a.snapshot.name})),route+'ammolist:'+mag.id,0,route+'home');}
      return picker('选择抽出的弹夹 / 箭匣',Object.values(p.inventory).filter(m=>m.snapshot.kind==='弹夹'&&!AM.attached(p,m.id)).map(m=>({value:m.id,label:m.snapshot.name,description:m.loaded.current+'/'+m.loaded.capacity+'发'})),route+'magazines',arg,route+'home');}
    if(action==='swaplist'){
      if(extra==='pick'){const mag=i.values[0];return preview(x,route,{type:'swap',weapon:arg,magazine:mag});}
      const w=p.inventory[arg];C.requireThat(w&&W.equipped(p).includes(arg),'武器已经变化。');
      return picker('选择兼容备用弹夹 / 箭匣',Object.values(p.inventory).filter(m=>m.snapshot.kind==='弹夹'&&!AM.attached(p,m.id)&&AM.magazineCompatible(w.snapshot,m.snapshot)&&m.loaded.rounds.every(r=>AM.ammoCompatible(w.snapshot,r.template||{}))).map(m=>({value:m.id,label:m.snapshot.name,description:m.loaded.current+'/'+m.loaded.capacity+'发'})),route+'swaplist:'+arg,extra,route+'home');}
    if(action==='ammolist'){
      const mag=p.inventory[arg];C.requireThat(mag?.snapshot.kind==='弹夹'&&!AM.attached(p,arg),'先抽出弹夹，再填弹。');
      if(extra==='pick')return preview(x,route,{type:'fill',magazine:arg,ammo:i.values[0]});
      return picker('选择兼容弹药',Object.values(p.inventory).filter(a=>a.snapshot.kind==='弹药'&&AM.ammoCompatible(mag.snapshot,a.snapshot)).map(a=>({value:a.id,label:a.snapshot.name,description:'可用 '+(x.a?.userId?M.available(s,x.a.userId,a.id):type==='p'?M.available(s,ref,a.id):a.quantity)+'发'})),route+'ammolist:'+arg,extra,route+'home');}
    if(action==='extractpreview')return preview(x,route,{type:'extract',weapon:arg});
    C.requireThat(action==='do','弹药步骤已失效。');
    // args encode operation, weapon/magazine, ammo/magazine, character version, turn.
    const [,,,,,,opType,item,part,version,turn]=i.customId.split(':');
    const op=opType==='fill'?{type:'fill',magazine:item,ammo:part}:{type:opType,weapon:item,magazine:part==='_'?null:part};
    if(x.b?.status==='active')return actionPanel.prepare(i,{battleId:x.b.id,actorId:x.a.id,turnId:turn,action:'ammo',params:{operation:op,ammoVersion:Number(version)}});
    await tx(i,st=>{const live=access(st,i,member,type,ref,actor);C.requireThat((live.p.ammoVersion||0)===Number(version)&&live.p.id===p.id,'弹药或角色已经变化，请刷新。');
      if(live.b?.status==='active')AM.battleOperation(st,live.b,turn,op);
      else {const user=type==='p'?ref:live.a.userId;for(const id of [op.weapon,op.magazine,op.ammo].filter(Boolean))if(user)C.requireThat(M.available(st,user,id)>0,'物品已被预留。');
        if(op.type==='fill'){const available=user?M.available(st,user,op.ammo):live.p.inventory[op.ammo]?.quantity;AM.fill(live.p,op.magazine,op.ammo,Math.min(live.p.inventory[op.magazine].loaded.capacity-live.p.inventory[op.magazine].loaded.current,available||0));}
        else AM.swap(live.p,op.weapon,op.type==='extract'?null:op.magazine);M.syncHP(live.p);}
    },'弹夹操作');if(x.b)await publishBattle(i.guildId,ref);return home(snapshot(i.guildId),i,member,type,ref,actor);
  }
  function preview(x,route,op){const p=x.p,item=p.inventory[op.weapon||op.magazine],part=p.inventory[op.ammo||op.magazine];
    return U.payload('确认弹药操作',({fill:'向弹夹填入所选弹药，最多填满或用完可用弹药',swap:'更换兼容备用弹夹，原弹夹回到背包',extract:'抽出弹夹，保留其中剩余弹药'}[op.type])+'\n'+item.snapshot.name+(part?' → '+part.snapshot.name:'')+(x.b?.status==='active'?'\n消耗一次快速行动':''),[
      U.row(U.button(route+'do:'+op.type+':'+(op.weapon||op.magazine)+':'+(op.ammo||op.magazine||'_')+':'+(p.ammoVersion||0)+':'+(x.b?.current?.id||'_'),'确认',U.D.ButtonStyle.Success),U.button(route+'home','取消'))]);}
  return {component,home};
}
module.exports={createAmmunitionPanel};
