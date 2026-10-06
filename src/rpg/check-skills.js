'use strict';
const C=require('./constants'),M=require('./model'),U=require('./ui');
const {requireThat:ok}=C;
function personal(p,page=0){
  const skills=Object.values(p.checkSkills||{}),pages=Math.max(1,Math.ceil(skills.length/8));page=Math.max(0,Math.min(Number(page)||0,pages-1));
  const v=U.payload('鉴定技能 · '+p.name,'每100点技能经验升一级，余数保留。经验由GM发放，使用鉴定不自动获得经验。\n'+
    '鉴定：**1d20＋技能等级 ≥ 难度**'+(!skills.length?'\n尚未学习技能，请GM发放。':''),[
    U.row(U.button('checkskill:own:'+p.userId+':'+p.id+':'+(page-1),'上一页',undefined,page===0),
      U.button('checkskill:own:'+p.userId+':'+p.id+':'+(page+1),'下一页',undefined,page===pages-1),
      U.button('profile:card:'+p.userId+':'+p.id,'返回角色卡'))
  ],0x9b59b6);
  for(const t of skills.slice(page*8,page*8+8))v.embeds[0].addFields(U.field('📖 '+t.name,'等级 **'+t.level+'** · 技能经验 **'+t.xp+'/100**\n'+U.bar(t.xp,100),true));
  v.embeds[0].setFooter({text:'角色 '+p.id+' · '+(page+1)+'/'+pages+' · 本人技能'});return v;
}
function createCheckSkills({snapshot,tx,needGM,pickView}){
  function list(s,uid,cid,mode,page=0){
    const p=M.player(s,uid);ok(p.id===cid,'目标角色已变化。');ok(['发放','经验'].includes(mode),'技能操作无效。');
    const all=mode==='发放'?Object.values(s.checkSkillTemplates||{}).filter(t=>t.published&&!p.checkSkills?.[t.id]):Object.values(p.checkSkills||{});
    const v=pickView(mode==='发放'?'选择要发放的鉴定技能':'选择要增加经验的技能',all.map(t=>({value:t.id||t.templateId,label:t.name,description:'等级 '+t.level+(mode==='经验'?' · 经验 '+t.xp+'/100':'')})),
      'checkskill:pick:'+uid+':'+cid+':'+mode,Number(page)||0);
    v.embeds[0].setDescription('目标 <@'+uid+'>\n'+v.embeds[0].data.description);return v;
  }
  function owned(s,id,actor){const f=s.forms[id];ok(f?.kind==='skillaward'&&f.owner===actor&&!f.done&&f.expiresAt>Date.now(),'技能发放已完成或失效。');const p=M.player(s,f.target);ok(p.id===f.characterId,'目标角色已经变化。');return {f,p};}
  function preview(s,f){
    const p=M.player(s,f.target),t=f.mode==='发放'?s.checkSkillTemplates?.[f.ref]:p.checkSkills?.[f.ref];ok(t,'技能已不存在。');
    const description=f.mode==='发放'?'学习 **'+t.name+'** · 初始等级 **'+t.level+'**':
      '**'+t.name+'** · 发放 '+f.amount+' 点技能经验\n等级 '+t.level+' → **'+(t.level+Math.floor((t.xp+f.amount)/100))+'**\n技能经验 '+t.xp+'/100 → **'+((t.xp+f.amount)%100)+'/100**';
    return U.payload('确认GM鉴定技能操作','目标 <@'+f.target+'>\n'+description,[U.row(
      ...(f.mode==='经验'?[U.button('checkskill:amount:'+f.id,'填写技能经验')]:[]),
      U.button('checkskill:confirm:'+f.id,'确认'+f.mode,U.D.ButtonStyle.Success),U.button('checkskill:cancel:'+f.id,'取消'))]);
  }
  async function slash(i,member){
    const s=snapshot(i.guildId);
    if(i.commandName==='鉴定技能')return personal(M.player(s,i.user.id));
    needGM(s,member);const p=M.player(s,i.options.getUser('成员')?.id);return list(s,p.userId,p.id,i.options.getString('动作')||'发放');
  }
  async function openModal(i,s){
    if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:checkskill:amount:'))return false;
    needGM(s,i.member);const {f}=owned(s,i.customId.split(':')[3],i.user.id);ok(f.mode==='经验','本操作不需要经验数量。');
    await i.showModal(U.modal('checkskill:amountsave:'+f.id+':'+f.version,'发放技能经验',[{key:'amount',label:'技能经验（每100点升一级）',value:f.amount}]));return true;
  }
  async function component(i,member){
    const [, ,action,...args]=i.customId.split(':'),s=snapshot(i.guildId);
    if(action==='own'){ok(args[0]===i.user.id,'只能查看自己的技能。');const p=M.player(s,i.user.id);ok(p.id===args[1],'角色已变化。');return personal(p,args[2]);}
    needGM(s,member);
    if(action==='pick'){
      const [uid,cid,mode,page]=args;
      if(page!=='select')return list(s,uid,cid,mode,page);
      const f=await tx(i,st=>{
        needGM(st,member);const p=M.player(st,uid);ok(p.id===cid,'角色已变化。');ok(['发放','经验'].includes(mode),'技能操作无效。');
        const ref=i.values[0],t=mode==='发放'?st.checkSkillTemplates?.[ref]:p.checkSkills?.[ref];ok(t&& (mode==='经验'||t.published),'技能未发布或尚未学习。');
        ok(mode!=='发放'||!p.checkSkills?.[ref],'目标已经学习此技能，不会重置已有等级。');
        const f={id:C.id('f'),kind:'skillaward',owner:i.user.id,target:uid,characterId:cid,mode,ref,skillVersion:t.version||1,amount:100,version:0,expiresAt:Date.now()+14*60000};
        st.forms[f.id]=f;return f;
      },'准备GM鉴定技能操作');return preview(snapshot(i.guildId),f);
    }
    const result=await tx(i,st=>{
      needGM(st,member);const {f,p}=owned(st,args[0],i.user.id);
      if(action==='cancel'){f.done=true;return null;}
      if(action==='amountsave'){ok(f.mode==='经验'&&f.version===Number(args[1]),'技能步骤已经变化。');f.amount=C.number(i.fields.getTextInputValue('amount'),'技能经验',1,1000000000);f.version++;return {formId:f.id};}
      ok(action==='confirm','技能步骤无效。');p.checkSkills ||= {};
      if(f.mode==='发放'){
        const t=st.checkSkillTemplates?.[f.ref];ok(t?.published&&t.version===f.skillVersion,'模板已变化，请重新选择。');ok(!p.checkSkills[f.ref],'目标已经学会该技能。');
        p.checkSkills[f.ref]={templateId:t.id,name:t.name,level:t.level,xp:0,version:1,templateVersion:t.version};
      }else{
        const t=p.checkSkills[f.ref];ok(t&&(t.version||1)===f.skillVersion,'技能等级已变化，请重新发起。');
        const total=t.xp+f.amount;t.level+=Math.floor(total/100);t.xp=total%100;t.version=(t.version||1)+1;
      }
      f.done=true;f.completedAt=Date.now();f.result=C.clone(p.checkSkills[f.ref]);return {skill:f.result,target:f.target};
    },'GM鉴定技能'+(action==='confirm'?'确认发放':'操作'));
    if(!result)return U.payload('已取消','没有发放技能或经验。');
    if(result.formId)return preview(snapshot(i.guildId),snapshot(i.guildId).forms[result.formId]);
    return U.payload('鉴定技能已保存','目标 <@'+result.target+'>\n**'+result.skill.name+'** · 等级 '+result.skill.level+' · 技能经验 '+result.skill.xp+'/100');
  }
  return {slash,openModal,component};
}
module.exports={personal,createCheckSkills};
