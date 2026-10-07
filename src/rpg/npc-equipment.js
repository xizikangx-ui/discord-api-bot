'use strict';
const C=require('./constants'),M=require('./model');
function create(template, catalog, virtual = false) {
  const p=M.newCharacter(template.name || 'NPC',C.clone(template.attributes));
  p.portraits=C.clone(template.portraits||{});p.luck=template.luck??1;p.points=0;p.hpMaxOverride=template.hpMax;p.hp=template.hpMax;
  const loadout=template.loadout || (template.itemIds||[]).filter(ref=>catalog[ref]?.published).map(ref=>({template:catalog[ref],quantity:template.quantities?.[ref]||template.itemQuantities?.[ref]||1}));
  p.learnedSkills={};for(const skill of template.skillSnapshots||[])require('./skills').grant(p,skill);
  const legacy=template.equipmentPreset===undefined;
  for(const entry of loadout) {
    if(entry.template.kind==='技能'){require('./skills').grant(p,{...entry.template,requiresWeapon:entry.template.requiresWeapon??true});continue;}
    const stateful=['武器','防具','饰品','卡牌','配件','弹夹','技能','钥匙'].includes(entry.template.kind);
    for(let n=0;n<(stateful?entry.quantity:1);n++) {
      const item=M.makeItem(entry.template,stateful?1:entry.quantity);
      if(virtual)item.id=entry.template.id+'_'+n;item.npcSlotRef=entry.template.id+'~'+n;
      for(const part of M.bundleItems(item)){p.inventory[part.id]=part;delete part.bundle;}
      if(legacy&&['武器','防具','饰品','卡牌'].includes(item.snapshot.kind))M.equipCharacter(p,item.id);
    }
  }
  if(!legacy)for(const entry of template.equipmentPreset) {
    const item=Object.values(p.inventory).find(i=>i.npcSlotRef===entry.ref);
    if(!item&&virtual)continue;
    C.requireThat(item,'NPC预设装备已不在随身物品中，请重新配置。');
    if(virtual){try{M.equipCharacter(p,item.id,false,entry.hand||'auto');}catch{}}else M.equipCharacter(p,item.id,false,entry.hand||'auto');
  }
  C.requireThat(virtual||!M.stats(p).overloaded,'NPC随身物品超过极限负重，请调整物品或属性。');
  return p;
}
function preset(p) {return M.equippedIds(p).filter(ref=>p.inventory[ref]?.npcSlotRef).map(ref=>({ref:p.inventory[ref].npcSlotRef,hand:p.equipped.weapon===ref?'main':p.equipped.offhand===ref?'off':'auto'}));}
module.exports={create,preset};
