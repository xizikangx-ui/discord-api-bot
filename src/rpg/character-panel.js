'use strict';
const C=require('./constants'),M=require('./model'),U=require('./ui');
const {requireThat:ok}=C;
const genders=[{value:'male',label:'男性'},{value:'female',label:'女性'}];
const fingerprint=p=>JSON.stringify([p.id,p.points,p.attributes,p.allocationVersion||0]);
function allocation(state, form, uid) {
  ok(form?.kind==='allocation'&&form.owner===uid&&!form.done&&form.expiresAt>Date.now(),'分配步骤已失效，请重新打开。');
  const p=M.player(state,uid);
  ok(p.id===form.characterId&&fingerprint(p)===form.fingerprint,'角色或属性点已经变化，请重新打开分配面板。');
  return p;
}
function commitAllocation(state,ref,uid) {
  const f=state.forms[ref],p=allocation(state,f,uid);
  ok(C.ATTRIBUTES[f.attribute],'请先选择属性。');
  M.allocate(state,uid,f.attribute,f.amount); f.done=true;
  return {characterId:p.id,attribute:f.attribute,amount:f.amount,remaining:p.points};
}
function createCharacterPanel({snapshot,tx}) {
  function own(s,uid,cid,actor) {ok(uid===actor,'只能修改自己的角色。');const p=M.player(s,uid);ok(p.id===cid,'角色已经变化，请重新打开。');return p;}
  function home(p) {
    return U.payload('个人角色设置 · '+p.name,'剩余自由点 **'+p.points+'**\n基础时运 '+(p.luck??1)+' → 有效时运 '+M.stats(p).luck+
      '\n选择性别、编辑个人背景或分配属性点。图片使用 /角色图片 上传。',[
      U.row(U.select('profile:gender:'+p.userId+':'+p.id,'性别',genders.map(g=>({...g,default:p.gender===g.value})))),
      U.row(U.button('profile:allocate:'+p.userId+':'+p.id,'分配自由属性点',U.D.ButtonStyle.Primary,p.points<1),
        U.button('profile:bio:'+p.userId+':'+p.id,'背景 / 外貌 / 信念'),U.button('profile:card:'+p.userId+':'+p.id,'查看自己的角色卡'))
    ]);
  }
  function view(s,f,uid) {
    const p=allocation(s,f,uid),paused=M.battleFor(s,uid)?.status==='active';
    const counts=Array.from({length:Math.min(25,p.points)},(_,i)=>({value:String(i+1),label:String(i+1)+'点',default:f.amount===i+1}));
    const body='剩余自由点 **'+p.points+'**\n'+(f.attribute ? C.ATTRIBUTES[f.attribute]+'：'+p.attributes[f.attribute]+' → **'+(p.attributes[f.attribute]+(f.amount||0))+'**\n消耗 '+(f.amount||0)+'点 · 确认后剩余 '+(p.points-(f.amount||0))+'点' : '第一步：下拉选择属性。')+
      (paused?'\n⚠️ 战斗进行中，请GM先暂停。':'');
    return U.payload('自由属性点 · 预览',body,[
      U.row(U.select('profile:attr:'+f.id,'选择要增加的属性',Object.entries(C.ATTRIBUTES).map(([value,label])=>({value,label,default:f.attribute===value})))),
      ...(counts.length?[U.row(U.select('profile:amount:'+f.id,'选择点数（1至25）',counts))]:[]),
      U.row(U.button('profile:all:'+f.id,'全部分配'),U.button('profile:more:'+f.id,'填写更多点数'),
        U.button('profile:confirm:'+f.id,'确认分配',U.D.ButtonStyle.Success,paused||!f.attribute||!f.amount),
        U.button('profile:cancel:'+f.id,'取消 / 返回'))
    ]);
  }
  async function openModal(i,s) {
    if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:profile:'))return false;
    const [, ,action,...args]=i.customId.split(':');
    if(action==='more') {const f=s.forms[args[0]],p=allocation(s,f,i.user.id);await i.showModal(U.modal('profile:moresave:'+f.id,'分配点数',[{key:'amount',label:'点数（最多 '+p.points+'）',value:f.amount||1}]));return true;}
    if(['bio','draftbio'].includes(action)) {
      const [uid,cid]=args;ok(uid===i.user.id,'只能编辑自己的角色。');
      const p=action==='bio'?own(s,uid,cid,i.user.id):s.characterDrafts[uid];ok(p?.id===cid,'角色或草稿已经变化。');
      await i.showModal(U.modal('profile:'+(action==='bio'?'biosave':'draftbiosave')+':'+uid+':'+cid+':'+(p.profileVersion||0),'个人背景与形象',
        [['background','个人背景'],['appearance','个人外貌描述'],['belief','个人信念']].map(([key,label])=>({key,label:label+'（最多2000字）',long:true,required:false,value:p.profile?.[key]||''}))));return true;
    }
    return false;
  }
  async function component(i) {
    const [, ,action,...args]=i.customId.split(':'),uid=i.user.id;
    if(['draftgender','draftbiosave'].includes(action)) {
      await tx(i,st=>{ok(args[0]===uid,'只能修改自己的草稿。');const d=st.characterDrafts[uid];ok(d?.id===args[1],'草稿已经变化，请重新建卡。');
        if(action==='draftgender'){ok(genders.some(g=>g.value===i.values[0]),'性别无效。');d.gender=i.values[0];}
        else saveBio(d,args[2],i);return {draftId:d.id};},'编辑角色草稿');return U.draftView(snapshot(i.guildId).characterDrafts[uid]);
    }
    if(['home','card'].includes(action)) {const p=own(snapshot(i.guildId),args[0],args[1],uid);return action==='home'?home(p):U.characterView(p);}
    if(['gender','biosave'].includes(action)) {
      await tx(i,st=>{const p=own(st,args[0],args[1],uid);
        if(action==='gender'){ok(genders.some(g=>g.value===i.values[0]),'性别无效。');p.gender=i.values[0];}
        else saveBio(p,args[2],i);return {characterId:p.id};},'修改角色设置');return home(M.player(snapshot(i.guildId),uid));
    }
    if(action==='allocate') {
      const f=await tx(i,st=>{const p=own(st,args[0],args[1],uid);ok(p.points>0,'没有剩余自由属性点。');
        const f={id:C.id('f'),kind:'allocation',owner:uid,characterId:p.id,fingerprint:fingerprint(p),amount:1,expiresAt:Date.now()+14*60000};st.forms[f.id]=f;return f;},'打开加点面板');return view(snapshot(i.guildId),f,uid);
    }
    if(action==='confirm') {const result=await tx(i,st=>commitAllocation(st,args[0],uid),'确认自由点分配');const p=M.player(snapshot(i.guildId),uid),out=home(p);out.content='✅ '+C.ATTRIBUTES[result.attribute]+'增加'+result.amount+'点，已保存。';return out;}
    if(action==='cancel') {await tx(i,st=>{allocation(st,st.forms[args[0]],uid);st.forms[args[0]].done=true;return null;},'取消未提交加点');return home(M.player(snapshot(i.guildId),uid));}
    await tx(i,st=>{const f=st.forms[args[0]],p=allocation(st,f,uid);
      if(action==='attr'){ok(C.ATTRIBUTES[i.values[0]],'属性无效。');f.attribute=i.values[0];}
      else if(['amount','all','moresave'].includes(action))f.amount=C.number(action==='all'?p.points:action==='amount'?i.values[0]:i.fields.getTextInputValue('amount'),'点数',1,p.points);
      else throw new Error('角色面板步骤无效。');return {formId:f.id};},'更新加点预览');const s=snapshot(i.guildId);return view(s,s.forms[args[0]],uid);
  }
  return {home,openModal,component};
}
function saveBio(p,version,i) {
  ok((p.profileVersion||0)===Number(version),'个人描述已经变化，请重新编辑。');
  p.profile=Object.fromEntries(['background','appearance','belief'].map(key=>[key,C.text(i.fields.getTextInputValue(key),'个人描述',2000,true)]));
  p.profileVersion=(p.profileVersion||0)+1;
}
module.exports={genders,fingerprint,allocation,commitAllocation,createCharacterPanel};
