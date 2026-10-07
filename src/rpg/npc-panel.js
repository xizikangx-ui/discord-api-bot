'use strict';
const C=require('./constants'),M=require('./model'),B=require('./combat'),U=require('./ui'),AI=require('./npc-auto'),NE=require('./npc-equipment'),W=require('./weapons');
const GROUPS={quick:'快速行动',formal:'正式行动',defense:'防守'};
const NAMES={reload:'更换已填装弹夹',extract:'抽出空弹夹',fill:'向抽出的弹夹填弹',heal:'使用恢复道具',switch:'切换武器',cast:'确认吟唱',move:'移动',pass:'放弃该行动',finish:'结束行动机会',defend:'纯防御',dodge:'闪避',both:'防御及闪避',none:'放弃防守','attack:*':'所有武器／技能（未单独配置者）'};
function createNpcPanel({snapshot,tx,needGM,publishBattle}) {
  function source(s,type,ref,actor,uid) {
    C.requireThat(['f','b'].includes(type),'NPC面板类型无效。');
    if(type==='f'){const f=s.forms[ref];C.requireThat(f?.kind==='npc'&&f.owner===uid,'该NPC草稿不属于你。');
      const data=C.clone(f.data);delete data.loadout;data.skillSnapshots=(data.skillIds||[]).map(id=>s.skillTemplates?.[id]).filter(Boolean);return {value:f.data,p:NE.create(data,s.catalog,true),container:f};}
    const b=s.battles[ref],a=b&&B.actorById(b,actor);C.requireThat(a&&!a.userId&&!a.deathId&&b.status!=='ended','请选择仍有效的NPC。');
    return {value:a,p:B.actorCharacter(s,a),container:a,b};
  }
  function prefix(type,ref,actor){return 'npcui:'+type+':'+ref+':'+actor+':';}
  function home(s,type,ref,actor,uid){const x=source(s,type,ref,actor,uid),cfg=AI.config(x.value.ai),base=prefix(type,ref,actor);
    return U.payload('NPC操作配置 · '+x.p.name,'控制 **'+(cfg.mode==='auto'?'自动':'手操')+'** · 目标 **'+({random:'随机敌人',nearest:'最近敌人',lowest:'最低HP敌人'}[cfg.target])+'**\n决策 '+(cfg.strategy==='smart'?'智能（最高合法预期伤害）':'GM概率')+'\n'+(x.value.aiDecision?.reason||'尚未执行自动决策')+'\n自动操作沿用现有行动、弹药、耐久与攻防规则。',[
      U.row(U.select(base+'mode','选择控制方式',[{label:'自动操作',value:'auto',default:cfg.mode==='auto'},{label:'GM手操',value:'manual',default:cfg.mode==='manual'}])),
      U.row(U.select(base+'strategy','选择NPC决策方式',[{value:'smart',label:'智能策略 · 优先最高合法伤害',default:cfg.strategy==='smart'},{value:'probability',label:'原概率策略',default:cfg.strategy==='probability'}])),
      U.row(U.select(base+'target','选择攻击目标策略',Object.entries({nearest:'最近敌人',random:'随机敌人',lowest:'最低HP敌人'}).map(([value,label])=>({value,label,default:cfg.target===value})))),
      U.row(U.button(base+'gear:overview:0','装备槽位',U.D.ButtonStyle.Primary),U.button(base+'weights:quick:0','操作概率'),U.button(base+'skills:grant:0','战斗技能'),U.button(type==='f'?'formpreview:'+ref:'gmui:'+ref+':view','返回'))
    ],0x9b59b6);
  }
  function operations(x,group){if(group==='defense')return Object.keys(AI.DEFAULTS.defense).map(key=>({key,label:NAMES[key]}));
    const entries=Object.keys(NAMES).filter(k=>!['defend','dodge','both','none'].includes(k)).map(key=>({key,label:NAMES[key]}));
    for(const item of Object.values(x.p.inventory).filter(i=>['武器','技能'].includes(i.snapshot.kind))) {
      const key='attack:'+item.templateId;if(!entries.some(e=>e.key===key))entries.push({key,label:item.snapshot.name});}
    for(const ability of B.abilities(x.p))if(!x.p.inventory[ability.key]){const key='attack:'+(ability.attack.id||ability.key);if(!entries.some(e=>e.key===key))entries.push({key,label:ability.attack.name});}
    const raw=x.container.aiDraft?.weights?.[group]||AI.config(x.value.ai).weights[group];
    for(const key of Object.keys(raw))if(!entries.some(e=>e.key===key))entries.push({key,label:key});return entries;}
  function weights(s,type,ref,actor,uid,group='quick',page=0){const x=source(s,type,ref,actor,uid);C.requireThat(GROUPS[group],'概率分类无效。');
    const cfg=x.container.aiDraft||AI.config(x.value.ai),entries=operations(x,group),count=Math.max(1,Math.ceil(entries.length/20));page=Math.max(0,Math.min(Number(page)||0,count-1));
    const base=prefix(type,ref,actor),version=x.container.npcVersion||0,w=cfg.weights[group]||{};
    return U.payload('NPC概率 · '+GROUPS[group], '每组总和须为100%；不可用操作自动排除。\n当前合计 **'+C.round2(Object.values(w).reduce((n,v)=>n+Number(v),0))+'%**\n'+entries.slice(page*20,page*20+20).map(e=>e.label+'：'+(w[e.key]||0)+'%').join('\n'),[
      U.row(U.select(base+'group','概率分类',Object.entries(GROUPS).map(([value,label])=>({value,label,default:value===group})))),
      U.row(U.select(base+'probpick:'+group+':'+version,'选择操作，再填写概率',entries.slice(page*20,page*20+20).map((e,n)=>({label:e.label,value:String(page*20+n)})))),
      U.row(U.button(base+'weights:'+group+':'+(page-1),'上一页',undefined,!page),U.button(base+'weights:'+group+':'+(page+1),'下一页',undefined,page===count-1)),
      U.row(U.button(base+'apply','保存全部概率',U.D.ButtonStyle.Success),U.button(base+'reset','恢复默认'),U.button(base+'discard','取消未保存修改'),U.button(base+'home','返回NPC'))
    ]);}
  function gear(s,type,ref,actor,uid,tab='overview',page=0){const x=source(s,type,ref,actor,uid),base=prefix(type,ref,actor);
    const v=require('./equipment').view({...s,players:{npc:x.p},battles:{}},'npc',x.p.id,tab,page);
    v.components=[U.row(U.select(base+'geartab','装备分类',Object.entries({overview:'装备总览',weapon:'武器',armor:'盔甲',accessories:'饰品',cards:'卡牌'}).map(([value,label])=>({value,label,default:value===tab})))),
      U.row(U.button(base+'equip:0','装备随身物品',U.D.ButtonStyle.Success),U.button(base+'remove:0','卸下装备'),U.button(base+'gear:'+tab+':'+page,'刷新'),U.button(base+'home','返回NPC'))];
    if(tab==='cards')v.components.push(U.row(U.button(base+'gear:cards:'+Math.max(0,page-1),'上一页'),U.button(base+'gear:cards:'+(Number(page)+1),'下一页')));
    v.embeds[0].setFooter({text:type==='f'?'NPC模板装备预设 · 发布后对新实例生效':'NPC实例装备 · 招募或暂停时可调整'});return v;}
  function categories(type,ref,actor,action){const base=prefix(type,ref,actor);return U.payload('NPC装备 · 选择大类','装备页只展示武器、盔甲、饰品和卡牌。',[
    U.row(U.select(base+'kind:'+action,'装备大类',[{label:'武器',value:'武器'},{label:'盔甲',value:'防具'},{label:'饰品',value:'饰品'},{label:'卡牌',value:'卡牌'}])),U.row(U.button(base+'gear:overview:0','返回装备槽位'))]);}
  function subtype(item){return item.snapshot.weaponType||item.snapshot.armorType||item.snapshot.accessoryType||item.snapshot.rarity;}
  function pick(s,type,ref,actor,uid,action,page=0,kind='',sub=''){const x=source(s,type,ref,actor,uid),base=prefix(type,ref,actor),equipped=M.equippedIds(x.p);
    const entries=Object.values(x.p.inventory).filter(i=>['武器','防具','饰品','卡牌'].includes(i.snapshot.kind)&&!M.isAttached(x.p,i.id)&&(action!=='remove'||equipped.includes(i.id)));
    const filtered=entries.filter(i=>i.snapshot.kind===kind&&subtype(i)===sub);entries.splice(0,entries.length,...filtered);
    const count=Math.max(1,Math.ceil(entries.length/20));page=Math.max(0,Math.min(Number(page)||0,count-1));
    return U.payload('NPC · '+(action==='remove'?'卸下':'装备'),'当前装备 '+equipped.length+' 件 · 第'+(page+1)+'/'+count+'页',[
      ...(entries.length?[U.row(U.select(base+'gearpick:'+action+':'+(x.container.npcVersion||0),'选择已有物品',entries.slice(page*20,page*20+20).map(i=>({label:i.snapshot.name,value:i.id,description:(equipped.includes(i.id)?'已装备':'随身携带')+' · '+i.id}))))]:[]),
      U.row(U.button(base+'items:'+action+':'+kind+':'+sub+':'+(page-1),'上一页',undefined,!page),U.button(base+'items:'+action+':'+kind+':'+sub+':'+(page+1),'下一页',undefined,page===count-1),U.button(base+action+':0','返回大类'))
    ]);}
  async function openModal(i,s){if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:npcui:'))return false;
    const [,,type,ref,actor,action,group,index,version]=i.customId.split(':');if(action!=='probedit')return false;
    needGM(s,i.member);const x=source(s,type,ref,actor,i.user.id);C.requireThat((x.container.npcVersion||0)===Number(version),'配置已经变化，请刷新。');
    const entry=operations(x,group)[Number(index)];C.requireThat(entry,'操作已变化。');
    await i.showModal(U.modal(prefix(type,ref,actor)+'probsubmit:'+group+':'+index+':'+version,'设置操作概率',[{key:'value',label:entry.label+'（0—100%，两位小数）',value:(x.container.aiDraft||AI.config(x.value.ai)).weights[group][entry.key]||0}]));return true;}
  async function component(i,member){const [,,type,ref,actor,action,arg,extra,last]=i.customId.split(':');const s=snapshot(i.guildId),uid=i.user.id;needGM(s,member);const x=source(s,type,ref,actor,uid),base=prefix(type,ref,actor);
    if(action==='skills'){const grant=arg!=='remove',entries=grant?Object.values(s.skillTemplates||{}).filter(t=>t.published):Object.values(x.p.learnedSkills||{}).map(e=>({...e.snapshot,id:e.id})),page=Math.max(0,Math.min(Number(extra)||0,Math.max(0,Math.ceil(entries.length/20)-1)));return U.payload('NPC独立战斗技能','已学：'+(Object.values(x.p.learnedSkills||{}).map(e=>e.snapshot.name).join('、')||'无'),[...(entries.length?[U.row(U.select(base+'skillpick:'+arg+':'+(x.container.npcVersion||0),grant?'选择授予技能':'选择移除技能',entries.slice(page*20,page*20+20).map(e=>({label:e.name,value:e.id}))))]:[]),U.row(U.button(base+'skills:'+arg+':'+(page-1),'上一页',undefined,!page),U.button(base+'skills:'+arg+':'+(page+1),'下一页',undefined,(page+1)*20>=entries.length),U.button(base+'skills:'+(grant?'remove':'grant')+':0',grant?'切换移除':'切换授予'),U.button(base+'home','返回NPC'))]);}
    if(action==='home')return home(s,type,ref,actor,uid);if(action==='gear')return gear(s,type,ref,actor,uid,arg,Number(extra));if(action==='geartab')return gear(s,type,ref,actor,uid,i.values[0]);
    if(['equip','remove'].includes(action))return categories(type,ref,actor,action);
    if(action==='kind'){const kind=i.values[0],equipped=M.equippedIds(x.p),subs=[...new Set(Object.values(x.p.inventory).filter(item=>item.snapshot.kind===kind&&(arg!=='remove'||equipped.includes(item.id))).map(subtype))];
      return U.payload('NPC装备 · '+kind,'选择类型，再选择具体道具。',[
        ...(subs.length?[U.row(U.select(base+'sub:'+arg+':'+kind,'具体类型',subs.map(value=>({value,label:C.ACCESSORY_NAMES[value]||C.RARITIES.find(r=>r.id===value)?.name||value}))))]:[]),U.row(U.button(base+arg+':0','返回大类'))]);}
    if(action==='sub')return pick(s,type,ref,actor,uid,arg,0,extra,i.values[0]);
    if(action==='items'){const parts=i.customId.split(':');return pick(s,type,ref,actor,uid,arg,Number(parts[9]),extra,last);}
    if(action==='weights'||action==='group')return weights(s,type,ref,actor,uid,action==='group'?i.values[0]:arg,Number(extra));
    if(action==='probpick'){const entry=operations(x,arg)[Number(i.values[0])];C.requireThat(entry,'操作已经变化。');return U.payload('设置概率 · '+entry.label,'点击填写概率，全部调整后点击保存。',[U.row(U.button(base+'probedit:'+arg+':'+i.values[0]+':'+extra,'填写概率',U.D.ButtonStyle.Primary),U.button(base+'weights:'+arg+':0','返回'))]);}
    if(action==='gearpick'&&arg==='equip'&&W.hands(x.p.inventory[i.values[0]]?.snapshot)===1&&x.p.inventory[i.values[0]]?.snapshot.kind==='武器')return U.payload('单手武器位置','选择主手或副手。',[U.row(U.select(base+'hand:'+i.values[0]+':'+extra,'持握位置',[{label:'主手',value:'main'},{label:'副手',value:'off'}])),U.row(U.button(base+'gear:overview:0','取消'))]);
    await tx(i,st=>{needGM(st,member);const live=source(st,type,ref,actor,uid);const cfg=AI.config(live.value.ai);
      if(action==='mode'||action==='target'||action==='strategy'){cfg[action]=i.values[0];live.value.ai=AI.validate(cfg);}
      else if(action==='probsubmit'){C.requireThat((live.container.npcVersion||0)===Number(last),'概率配置已变化，请刷新。');const entry=operations(live,arg)[Number(extra)];C.requireThat(entry,'操作已经变化。');const value=C.number(i.fields.getTextInputValue('value'),'概率',0,100,false);C.requireThat(Math.abs(value*100-Math.round(value*100))<.000001,'最多两位小数。');live.container.aiDraft ||= cfg;live.container.aiDraft.weights[arg][entry.key]=value;}
      else if(action==='reset'){live.value.ai={...cfg,weights:C.clone(AI.DEFAULTS)};delete live.container.aiDraft;}
      else if(action==='discard')delete live.container.aiDraft;
      else if(action==='apply'){const draft=live.container.aiDraft||cfg;draft.mode=cfg.mode;draft.target=cfg.target;draft.strategy=cfg.strategy;live.value.ai=AI.validate(draft);delete live.container.aiDraft;}
      else if(action==='skillpick'){C.requireThat(!live.b||(['recruiting','paused'].includes(live.b.status)&&!live.b.pending),'请暂停并完成攻防后修改技能。');C.requireThat((live.container.npcVersion||0)===Number(extra),'技能配置已变化。');if(type==='f'){if(arg==='grant')live.value.skillIds=[...new Set([...(live.value.skillIds||[]),i.values[0]])];else{const entry=live.p.learnedSkills[i.values[0]];C.requireThat(entry,'技能已失效。');live.value.skillIds=(live.value.skillIds||[]).filter(id=>id!==entry.templateId);}}else if(arg==='grant')require('./skills').grant(live.p,st.skillTemplates[i.values[0]]);else {C.requireThat(live.p.learnedSkills[i.values[0]],'技能已经移除。');delete live.p.learnedSkills[i.values[0]];}}
      else if(action==='gearpick'||action==='hand'){
        C.requireThat(!live.b||(['recruiting','paused'].includes(live.b.status)&&!live.b.pending),'请暂停战斗并完成攻防响应后调整装备。');
        C.requireThat((live.container.npcVersion||0)===Number(extra),'装备配置已变化，请重新选择。');
        M.equipCharacter(live.p,action==='hand'?arg:i.values[0],action==='gearpick'&&arg==='remove',action==='hand'?i.values[0]:'auto');
        C.requireThat(!M.stats(live.p).overloaded,'NPC超过极限负重。');
        if(type==='f')live.value.equipmentPreset=NE.preset(live.p);
      }else throw new Error('NPC操作已失效。');
      live.container.npcVersion=(live.container.npcVersion||0)+1;
      if(live.b)B.record(live.b,'GM '+uid+'调整NPC '+live.p.name+'：'+action);return {action};
    },'NPC配置面板');
    if(type==='b')await publishBattle(i.guildId,ref);
    const next=snapshot(i.guildId);return action==='probsubmit'?weights(next,type,ref,actor,uid,arg):['gearpick','hand'].includes(action)?gear(next,type,ref,actor,uid):home(next,type,ref,actor,uid);
  }
  return {home,component,openModal};
}
module.exports={createNpcPanel};
