'use strict';
const C=require('./constants'),U=require('./ui');
function definitions(){const F=require('./factions');return [...Object.entries(require('./rules').chapters).map(([name,value])=>({key:'rule/'+name,label:'规则 · '+name,value})),...Object.entries(F.FACTIONS).map(([key,f])=>({key:'faction/'+key,label:'势力 · '+f.name,value:f.description})),...Object.entries(F.DEPARTMENTS).map(([key,d])=>({key:'department/'+key,label:'部门 · '+d.name,value:d.description}))];}
function definition(key){const d=definitions().find(d=>d.key===key);C.requireThat(d,'文本章节已不存在。');return d;}
function get(s,key){const saved=s.config.textOverrides?.[key];return saved?.text ?? definition(key).value;}
function read(s,key,page=0){const d=definition(key),text=get(s,key),pages=Math.max(1,Math.ceil(text.length/3500));page=Math.max(0,Math.min(Number(page)||0,pages-1));return U.payload(d.label,text.slice(page*3500,(page+1)*3500),[U.row(U.button('text:read:'+key+':'+(page-1),'上一页',undefined,!page),U.button('text:read:'+key+':'+(page+1),'下一页',undefined,page>=pages-1))]);}
function createTexts({snapshot,tx,needGM,pickView}){
  function home(s,page=0){return pickView('GM文本编辑',definitions().map(d=>({value:d.key,label:d.label,description:s.config.textOverrides?.[d.key]?'已自定义':'默认文本'})),'text:list',Number(page)||0);}
  function view(s,uid,key,page=0){const d=definition(key),draft=s.config.textDrafts?.[uid]?.[key],text=draft?.text ?? get(s,key),pages=Math.max(1,Math.ceil(text.length/3500));page=Math.max(0,Math.min(Number(page)||0,pages-1));const version=s.config.textOverrides?.[key]?.version||0;return U.payload('文本预览 · '+d.label,text.slice(page*3500,(page+1)*3500),[
    U.row(U.button('text:preview:'+key+':'+(page-1),'上一页正文',undefined,!page),U.button('text:preview:'+key+':'+(page+1),'下一页正文',undefined,page>=pages-1)),
    U.row(U.button('text:edit:'+key,'编辑正文'),U.button('text:publish:'+key+':'+version,'发布文本',U.D.ButtonStyle.Success,!draft),U.button('text:resetpreview:'+key+':'+version,'恢复默认'),U.button('text:cancel:'+key,'丢弃草稿'),U.button('text:list:0','返回章节'))
  ]);}
  async function openModal(i,s){if(i.isModalSubmit?.()||!i.customId.startsWith('rpg:text:edit:'))return false;needGM(s,i.member);const key=i.customId.split(':')[3];definition(key);const draft=s.config.textDrafts?.[i.user.id]?.[key];await i.showModal(U.modal('text:save:'+key+':'+(s.config.textOverrides?.[key]?.version||0),'编辑背景或规则正文',[{key:'value',label:'正文（只修改展示文字，不改变计算公式）',long:true,max:4000,value:draft?.text ?? get(s,key)}]));return true;}
  async function component(i,member){const [,action,key,arg]=i.customId.split(':').slice(1),s=snapshot(i.guildId),uid=i.user.id;if(action==='read')return read(s,key,arg);needGM(s,member);
    if(action==='list')return key==='select'?view(s,uid,i.values[0]):home(s,key);
    if(action==='preview')return view(s,uid,key,arg);
    definition(key);
    if(action==='resetpreview')return U.payload('确认恢复默认',definition(key).label+'将恢复内置正文。',[U.row(U.button('text:reset:'+key+':'+arg,'确认恢复默认',U.D.ButtonStyle.Danger),U.button('text:preview:'+key+':0','取消'))]);
    await tx(i,st=>{needGM(st,member);st.config.textOverrides||={};st.config.textDrafts||={};st.config.textDrafts[uid]||={};const version=st.config.textOverrides[key]?.version||0;
      if(action==='save'){C.requireThat(version===Number(arg),'正文已被其他GM修改，请重新打开。');st.config.textDrafts[uid][key]={text:C.text(i.fields.getTextInputValue('value'),'正文',4000),baseVersion:version,at:Date.now()};}
      else if(action==='publish'){const draft=st.config.textDrafts[uid][key];C.requireThat(draft&&draft.baseVersion===version&&version===Number(arg),'正文已变化，请重新编辑并确认。');st.config.textOverrides[key]={text:draft.text,version:version+1,at:Date.now(),editor:uid};delete st.config.textDrafts[uid][key];}
      else if(action==='reset'){C.requireThat(version===Number(arg),'正文已变化，请重新打开。');st.config.textOverrides[key]={text:definition(key).value,version:version+1,at:Date.now(),editor:uid};delete st.config.textDrafts[uid][key];}
      else {C.requireThat(action==='cancel','操作已失效。');delete st.config.textDrafts[uid][key];}
      return {key,action};
    },'GM文本编辑');return view(snapshot(i.guildId),uid,key);
  }
  return {home,view,openModal,component};
}
module.exports={definitions,get,read,createTexts};
