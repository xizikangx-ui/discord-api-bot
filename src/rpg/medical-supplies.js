'use strict';
const C=require('./constants');
const BOXES=['医疗包','药品柜','医疗急救箱','生物运输箱','实验样本箱','冷藏箱','家用药箱','急救腰包','药瓶收纳盒','随车急救箱'];
const PRICES={green:60,blue:240,purple:900,gold:3200};
const ROWS=[
 ['随身医疗包','green','6',25],['综合医疗包','blue','12',75],['急救医疗箱','purple','18',150],['野战医疗箱','gold','30',300,['bleeding']],
 ['活性修复针','green','2d4'],['深层修复针','blue','2d6'],['细胞再生针','purple','3d6'],
 ['止血凝胶针','green','1d4',5,['bleeding']],['广谱解毒针','green','1d4',5,['poison']],
 ['热损修复针','blue','1d6',5,['burning']],['抗疫净化针','blue','1d6',5,['disease']],
 ['神经清醒针','blue','0',5,['stun']],['共鸣解缄针','purple','0',5,['silence']],['肌束舒缓针','green','0',5,['slow']],
 ['上肢重构针','gold','2d6',5,['arms']],['下肢重构针','gold','2d6',5,['legs']],
 ['力量激发针','blue','0',5,[],'attr:strength'],['反射提速针','blue','0',5,[],'attr:agility'],
 ['耐受强化针','blue','0',5,[],'attr:constitution'],['专注醒脑针','blue','0',5,[],'attr:knowledge'],
 ['神经稳态针','blue','0',5,[],'attr:mind'],['感知增幅针','purple','0',5,[],'hit'],
 ['护体凝膜针','purple','0',5,[],'defense:physical'],['复合救援针','gold','3d6',5,['bleeding','poison','burning']]
];
function templates(){return ROWS.map(([name,rarity,heal,weight=5,cures=[],target],index)=>({
 id:'medical_supply_v1_'+String(index+1).padStart(2,'0'),version:1,published:true,kind:'药品',name,rarity,heal,weight,value:PRICES[rarity],
 description:(index<4?'一次性医疗消耗品，使用后整件消耗；不是可开箱容器。':'游戏内医疗针剂，使用后整件消耗。')+
   (target?'获得临时增益，持续受疗者3次行动机会。':'沿用治疗与异常解除规则。'),
 clearConditions:cures.map(k=>'core_condition_'+k),effects:target?[{target,op:'add',value:2}]:[],ownEffects:target?[{target,op:'add',value:2}]:[],
 duration:{kind:'actions',count:3},traitIds:[],boxes:[...BOXES],tags:['medical'],seedPackage:'medical-supplies-v1'
}));}
module.exports={BOXES,PRICES,templates};
