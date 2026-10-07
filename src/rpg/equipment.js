'use strict';
const C=require('./constants'),M=require('./model'),U=require('./ui'),W=require('./weapons'),Dur=require('./durability');
const ARMOR={head:'头部',chest:'胸部',arms:'双臂',legs:'双腿',feet:'靴子',inner:'内甲'};
const TABS={overview:'装备总览',weapon:'武器',armor:'盔甲',accessories:'饰品',cards:'卡牌'};
function ammoText(p,w){if(!require('./ammunition').usesMagazine(w.snapshot))return '';const m=p.inventory[w.magazineId],names=[...new Set((w.loaded?.rounds||[]).map(r=>r.template?.name||r.template?.ammoType||'旧弹药'))];return '\n弹夹／箭匣：'+(m?.snapshot.name||'未装入')+'\n弹种：'+(names.join('、')||'无')+' · 载弹 '+(w.loaded?.current||0)+'/'+(w.loaded?.capacity||w.snapshot.capacity)+(w.loaded?.current?'':' ⚠️ 缺弹');}
function detail(item){return item.snapshot.name.slice(0,80)+(['武器','防具'].includes(item.snapshot.kind)?' · 耐久 '+Dur.current(item)+'/'+Dur.maximum(item)+(Dur.usable(item)?'':' ⚠️损坏'):'');}
function view(state,uid,cid,tab='overview',page=0){
  const p=M.player(state,uid);C.requireThat(p.id===cid,'角色已变化，请重新打开装备面板。');
  C.requireThat(TABS[tab],'装备分页无效。');
  const prefix='gear:',route=(action,extra='')=>prefix+action+':'+uid+':'+cid+(extra?':'+extra:'');
  require('./ammunition').normalize(p);
  const stats=M.stats(p),equipped=M.equippedIds(p),items=refs=>refs.map(id=>p.inventory[id]).filter(Boolean);
  const armor=items(p.equipped.armor),accessories=items(p.equipped.accessories),cards=items(p.equipped.cards);
  const slots=Object.keys(ARMOR).map(slot=>({slot,item:armor.find(i=>C.ARMOR_COVERAGE[i.snapshot.armorType]?.includes(slot))}));
  const cardPages=Math.max(1,Math.ceil(p.slots.card/8));page=Math.max(0,Math.min(Number(page)||0,cardPages-1));
  const active=M.battleFor(state,uid)?.status==='active';
  const v=U.payload('装备槽位 · '+p.name,'**'+TABS[tab]+'** · 已装备 '+equipped.length+' 件\n'+
    '负重 **'+C.kg(stats.carried)+' / '+C.kg(stats.limit)+'** '+U.bar(stats.carried,stats.limit)+'\n'+
    (active?'⚔️ 战斗中：武器切换须在自己的行动消耗快速行动；其他装备请GM暂停。':'🟢 当前可快捷装备或卸下。')+'\n○ 空位　● 已占用　⚠️ 损坏仍占槽位',[
    U.row(U.select(route('tab'),'查看装备分类',Object.entries(TABS).map(([value,label])=>({value,label,default:value===tab})))),
    U.row(U.button(route('equip'),'快捷装备',U.D.ButtonStyle.Success),U.button(route('remove'),'快捷卸下',undefined,active),
      U.button('ammo:p:'+uid+':_:home','弹夹管理'),U.button(route('view',tab+':'+page),'刷新槽位'),U.button('profile:card:'+uid+':'+cid,'返回角色卡'))
  ],0x1abc9c);
  if(tab==='overview'||tab==='weapon'){
    const main=p.inventory[p.equipped.weapon],off=p.inventory[p.equipped.offhand],two=main&&W.hands(main.snapshot)===2;
    v.embeds[0].addFields(U.field('⚔️ 主手',main?'● '+detail(main)+'\n'+W.label(main.snapshot)+ammoText(p,main):'○ 空位',true),
      U.field('🗡️ 副手',two?'● 由双手武器占用':off?'● '+detail(off)+ammoText(p,off):'○ 空位',true));
    if(tab==='weapon')for(const ref of W.equipped(p)){
      const item=p.inventory[ref],t=item.snapshot;
      v.embeds[0].addFields(U.field(t.name.slice(0,80),'射程 '+(t.rangeMeters??(t.range??1)*50)+'米 · 有效 '+C.round2(M.modify(stats.effects,'range',t.rangeMeters??(t.range??1)*50))+'米'+
        (t.melee?' · 近战同格':'')+ammoText(p,item)));
    }
  }
  if(tab==='overview'||tab==='armor')v.embeds[0].addFields(U.field('🛡️ 盔甲 · '+slots.filter(s=>s.item).length+'/6位置',slots.map(s=>(s.item?'● ':'○ ')+ARMOR[s.slot]+'：'+(s.item?detail(s.item):'空位')).join('\n')));
  if(tab==='overview'||tab==='accessories')for(const [key,name]of Object.entries(C.ACCESSORY_NAMES)){
    const refs=accessories.filter(i=>i.snapshot.accessoryType===key),limit=p.slots[key];
    v.embeds[0].addFields(U.field('💠 '+name+'饰品 · '+refs.length+'/'+limit,Array.from({length:limit},(_,n)=>(refs[n]?'● ':'○ ')+(n+1)+'：'+(refs[n]?detail(refs[n]):'空位')).join('\n'),true));
  }
  if(tab==='overview')v.embeds[0].addFields(U.field('🃏 生效卡牌 · '+cards.length+'/'+p.slots.card,U.bar(cards.length,p.slots.card)+'\n空余 '+Math.max(0,p.slots.card-cards.length)+' 位；切换到卡牌分页查看每个位置。'));
  if(tab==='cards'){
    const totalPages=cardPages;
    v.embeds[0].addFields(U.field('🃏 卡牌槽位 · '+cards.length+'/'+p.slots.card,Array.from({length:Math.min(8,p.slots.card-page*8)},(_,n)=>{const index=page*8+n;return(cards[index]?'● ':'○ ')+(index+1)+'：'+(cards[index]?detail(cards[index]):'空位');}).join('\n')));
    v.components.push(U.row(U.button(route('view','cards:'+(page-1)),'上一页卡牌',undefined,page===0),U.button(route('view','cards:'+(page+1)),'下一页卡牌',undefined,page===totalPages-1)));
  }
  v.embeds[0].setFooter({text:'角色 '+cid+' · 装备实时读取 · 仅本人可操作'});
  return v;
}
function createEquipment({snapshot,selections}){
  async function component(i){
    const [, ,action,uid,cid,tab,page]=i.customId.split(':');
    C.requireThat(uid===i.user.id,'只能查看和操作自己的装备槽位。');
    const s=snapshot(i.guildId);C.requireThat(M.player(s,uid).id===cid,'角色已经变化。');
    if(action==='equip'||action==='remove')return selections.list(s,uid,action==='equip'?'装备':'卸下',0,'equipment');
    if(action==='tab')return view(s,uid,cid,i.values[0]);
    C.requireThat(action==='view','装备步骤无效。');return view(s,uid,cid,tab||'overview',page);
  }
  return {component};
}
module.exports={view,createEquipment};
