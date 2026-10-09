'use strict';
const C=require('./constants'), B=require('./combat'), H=require('./health');
function battle(s,id,actorId){
  const b=s.battles[id];C.requireThat(b,'战斗不存在。');
  const actor=b.actors.find(a=>a.id===(actorId||b.current?.actorId)),character=actor&&B.actorCharacter(s,actor);
  return {id:b.id,version:b.version,current:b.current,actionRound:b.actionRound,
    actors:b.actors.map(a=>({...a,ap:B.actorCharacter(s,a).ap,round:b.actionRound?.number||1,
      opportunities:b.actionRound?.counts?.[a.id]||0,nextCost:B.opportunityCost(b,a.id),health:H.snapshot(B.actorCharacter(s,a))})),
    character,abilities:character?B.abilities(character):[],pending:b.pending,judgment:b.judgment};
}
function mapOptions(s){
  const rooms=Object.values(s.roomTemplates).filter(t=>t.published);
  return {channelId:s.config.announcementChannelId,categories:Object.values(s.mapCategories).filter(t=>t.published).map(t=>({
    id:t.id,name:t.name,mapTypes:t.mapTypes||['indoor','region'],
    usable:rooms.some(r=>!r.manualOnly&&r.categoryIds?.includes(t.id))
  })),rooms:rooms.map(t=>({id:t.id,name:t.name,categoryIds:t.categoryIds,variants:(t.variants||[]).map(v=>({id:v.id,name:v.name}))})),
    cellTypes:{indoor:require('./exploration').TYPES||{room:'房间',corridor:'走廊',stairs:'楼梯',wall:'墙',entrance:'入口'},
      region:{entrance:'入口',road:'道路',wild:'荒野',forest:'森林',water:'水域',mountain:'山地',ruins:'废墟',landmark:'地标',building:'建筑'}},
    bossPools:Object.values(s.bossPools).filter(t=>t.published).map(t=>({id:t.id,name:t.name})),
    merchants:Object.values(s.merchantTemplates).filter(t=>t.published).map(t=>({id:t.id,name:t.name}))};
}
function validateQuick(s,p){
  C.text(p.name,'地图名称',80);C.requireThat(p.channelId,'请选择有效公示频道。');
  C.requireThat(['indoor','region'].includes(p.mapType),'地图类型无效。');
  C.requireThat(['full','manual','fixed'].includes(p.mode),'生成方式无效。');
  const o=require('./random-layout').options(p);
  const available=mapOptions(s).categories.filter(c=>c.mapTypes.includes(p.mapType)&&(p.mode==='fixed'||c.usable));
  if(p.mode==='full')C.requireThat(available.length,'没有适用主题，请先发布分类及房间。');
  else {
    C.number(p.rows,'层／行数',1,20);C.number(p.width,'列数',1,20);
    C.requireThat(available.some(c=>c.id===p.categoryId),'主题没有可生成房间，或不适用于该地图类型。');
    if(p.mode!=='fixed'){
      C.requireThat(p.rows*p.width>1,'随机地图至少需要入口和一个内容格。');
      if(p.mapType==='indoor'&&p.rows>1)C.requireThat(p.width>o.stairsMin,'请增加列数或减少最少楼梯连接，为房间保留空间。');
    }
  }
  return {name:p.name,type:p.mapType==='indoor'?'室内':'区域',theme:p.mode==='full'?'随机主题':available.find(c=>c.id===p.categoryId)?.name,
    size:p.mode==='full'?'随机4—8行／列':p.rows+'行 × '+p.width+'列',status:p.mode==='fixed'?'待布置':'生成后保存草稿',note:'确认时生成一次并保存；不会自动发布。'};
}
module.exports={battle,mapOptions,validateQuick};
