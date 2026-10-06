'use strict';
const C=require('./constants');
const maximum=item=>item.durabilityMax ?? item.snapshot.durabilityMax ?? 100;
const current=item=>item.durability ?? maximum(item);
const usable=item=>!['武器','防具'].includes(item.snapshot.kind)||current(item)>0;
function drain(item,amount){const before=current(item);item.durability=Math.max(0,before-amount);return before-item.durability;}
function weaken(p,rule){if(!rule?.amount)return [];const results=[];for(const ref of p.equipped.armor){const item=p.inventory[ref];if(!item||!usable(item)||!(item.snapshot.defenses?.[rule.type]>0))continue;const amount=Math.max(0,rule.amount-(item.snapshot.weakeningResistance?.[rule.type]||0)),lost=drain(item,amount);if(lost)results.push({id:ref,name:item.snapshot.name,lost,durability:current(item)});}return results;}
function repair(p,toolId,targetId){const tool=p.inventory[toolId],target=p.inventory[targetId];C.requireThat(tool?.snapshot.kind==='修复道具'&&tool.quantity>0,'请选择修复道具。');C.requireThat(target&&tool.snapshot.repairKinds?.includes(target.snapshot.kind),'修复道具不支持此装备类型。');C.requireThat(current(target)<maximum(target),'目标耐久已满。');const before=current(target),oldMaximum=maximum(target);target.durabilityMax=Math.max(1,oldMaximum-(tool.snapshot.repairMaxLoss||0));target.durability=Math.min(maximum(target),before+tool.snapshot.repairAmount);tool.quantity--;if(!tool.quantity)delete p.inventory[toolId];return {name:tool.snapshot.name,target:target.snapshot.name,repaired:target.durability-before,durability:target.durability,maximum:maximum(target),maximumLost:oldMaximum-maximum(target)};}
module.exports={maximum,current,usable,drain,weaken,repair};
