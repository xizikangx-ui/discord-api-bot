'use strict';
// Keep the disabled entry point independent from the RPG implementation.
const DEFAULT_GUILD_ID='1549280540505411635';
const names=new Set(['跑团配置面板','rd','建卡','角色卡','角色设置','角色图片','npc图片','分配属性点','抽卡','开箱','地图配置','地图','势力','背包','使用','兑换券','收藏柜','名词解释','开团','丢弃','装备','交易','转账','录入物品','录入词条','录入异常','规则','录入技能','技能','录入鉴定技能','鉴定技能','鉴定','行商','gm','战斗','弹药管理']);
function createDisabled(){return {
 async handle(i){if(!names.has(i.commandName)&&!i.customId?.startsWith('rpg:'))return false;const payload={content:'Discord 跑团已停用。网站跑团继续开放，原存档保留。',flags:64,allowedMentions:{parse:[]}};if(i.deferred||i.replied)await i.followUp(payload).catch(()=>{});else await i.reply(payload).catch(()=>{});return true;},
 async start(){console.log('Discord 跑团已停用：未启动数据库、渲染和跑团后台任务。');},stop(){},async drain(){},renderStats:()=>({workers:0,queued:0,cacheBytes:0,cacheEntries:0}),store:{guilds:()=>[],freeze(){}},
};}
module.exports={DEFAULT_GUILD_ID,names,createDisabled};
