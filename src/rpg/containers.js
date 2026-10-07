'use strict';
const GROUPS = {
  white:['大衣','外套','饭盒','塑料收纳盒','纸箱','抽屉','衣柜','鞋柜','购物袋','帆布袋','塑料篮'],
  green:['书柜','医疗包','旅行包','工具包','双肩背包','公文包','手提箱','汽车手套箱','汽车后备箱','储物柜','快递周转箱'],
  blue:['武器箱','高级旅行包','行李箱','摄影器材包','电工工具箱','机械维修箱','冷藏箱','药品柜','消防装备柜','电脑机箱'],
  purple:['小型保险','实验样本箱','生物运输箱','医疗急救箱','服务器机柜','安保装备柜','电子防潮柜','战术补给箱','档案密集柜'],
  gold:['保险箱','军需保险箱','珠宝保险柜','贵重仪器箱','涉密文件柜','野战指挥箱'],
  red:['武库保险箱','银行金库柜','文物保管柜','特种军械柜','核心数据保险柜']
};
// Internal order is white, green, blue, purple, gold, red throughout loot math.
const DEFAULTS = { white:[45,25,20,8.5,1,.5],green:[40,25,23,10,1.4,.6],blue:[35,25,25,12,2.2,.8],
  purple:[28,23,27,16,5,1],gold:[20,20,30,20,8.5,1.5],red:[9.09,27.27,36.37,15.91,9.09,2.27] };
const ALL = Object.values(GROUPS).flat();
const grade = box => Object.keys(GROUPS).find(g=>GROUPS[g].includes(box));
function definitions(){return Object.fromEntries(ALL.map(name=>[name,{name,grade:grade(name),enabled:true,version:1}]));}
function get(state,box){return state.containerDefinitions?.[box] || definitions()[box];}
function setGrade(state,box,value){const C=require('./constants');C.requireThat(ALL.includes(box)&&DEFAULTS[value],'容器或六色档位无效。');state.containerDefinitions||=definitions();const d=state.containerDefinitions[box];d.grade=value;d.version++;return d;}
function tags(box){
  if(/医疗|药品|生物/.test(box))return ['medical','science','collect'];
  if(/摄影|电脑|服务器|电子|数据|仪器/.test(box))return ['electronic','photo','science','collect','document'];
  if(/武器|军|安保|消防|战术|指挥/.test(box))return ['tool','outdoor','medical','electronic','document','collect'];
  if(/书|档案|文件|文物/.test(box))return ['document','stationery','collect'];
  if(/工具|维修|电工|机械/.test(box))return ['tool','industrial','electronic','collect'];
  if(/饭盒|冷藏/.test(box))return ['kitchen','medical','collect'];
  if(/珠宝|银行|保险/.test(box))return ['collect','document','electronic'];
  return ['daily','stationery','outdoor','electronic','tool','kitchen','collect','document'];
}
function compatible(box,item){return (item.tags||[]).some(t=>tags(box).includes(t)) && (!/大衣|外套|饭盒|手套箱/.test(box)||item.weight<=100);}
module.exports={GROUPS,DEFAULTS,ALL,grade,definitions,get,setGrade,tags,compatible};
