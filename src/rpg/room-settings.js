'use strict';
const { randomInt } = require('node:crypto');
const C = require('./constants'), U = require('./ui');
const { requireThat: ok } = C;
function probabilities(values, max) {
  ok(Array.isArray(values) && values.length === max + 1, '请配置0—' + max + '的每个数量概率。');
  const weights = values.map(v => {
    const n = C.number(v, '概率', 0, 100, false);
    ok(Math.abs(n * 100 - Math.round(n * 100)) < 1e-7, '概率最多两位小数。'); return Math.round(n * 100);
  });
  ok(weights.reduce((a,b) => a+b, 0) === 10000, '每一项的数量概率之和必须为100%。');
  return weights.map(n => n/100);
}
function defaultProbabilities(max) { return Array.from({length:max+1}, (_,n) => n===1 ? 100 : 0); }
function draw(values, rng = randomInt) {
  const valid = probabilities(values, values.length-1); let roll = rng(0,10000);
  for(let n=0;n<valid.length;n++){ roll-=Math.round(valid[n]*100); if(roll<0)return n; }
  throw Error('数量概率无效。');
}
function validateEntries(state, entries, kind) {
  const max = kind==='npc' ? 10 : 6, limit = kind==='container' ? 52 : 25;
  ok(Array.isArray(entries || []) && (entries || []).length<=limit, '随机配置项目过多。');
  const refs = new Set();
  return (entries || []).map(e => {
    ok(!refs.has(e.ref), '同一随机类型不能重复配置。'); refs.add(e.ref);
    const t = kind==='container' ? null : state[kind==='npc' ? 'npcTemplates' : 'catalog'][e.ref];
    ok(kind==='container' ? C.BOXES.includes(e.ref) : t?.published && (kind==='npc' || t.kind!=='技能'), '请选择已发布且有效的随机内容。');
    return {ref:e.ref, probabilities:probabilities(e.probabilities,max), ...(t ? {template:C.clone(t)} : {})};
  });
}
function quantities(value, refs, max) {
  const counts=Object.fromEntries(refs.map(r=>[r,1]));
  if(value && typeof value==='object' && !Array.isArray(value)) {
    for(const ref of refs) if(value[ref]!=null) counts[ref]=C.number(value[ref],'数量',1,max);
  } else for(const line of String(value || '').split('\n').filter(l=>l.trim())) {
    const [ref,count,extra]=line.trim().split(/\s+/);
    if(refs.includes(ref)&&!extra) {try {counts[ref]=C.number(count,'数量',1,max);} catch { /* Invalid old drafts reopen with the visible default of one. */ }}
  }
  return counts;
}
const summary = entries => (entries || []).map(e => e.probabilities.map((p,n)=>p ? n+'个 '+p+'%' : '').filter(Boolean).join(' / ')).join('；') || '未配置';
function definition(f, index) {
  const def=require('./forms').fields(f)[index];ok(['room','npc'].includes(f.kind) && f.field===index && ['randomRoom','fixedRoom'].includes(def?.type),'房间配置字段已变化。');return def;
}
function choices(s,f,def) {
  if(def.type==='fixedRoom') return (f.data[def.refs] || []).filter(ref=>f.kind!=='npc'||s.catalog[ref]?.kind!=='杂物').map(ref=>({value:ref,label:def.source==='boxes' ? ref : s[def.source][ref]?.name || ref}));
  return def.source==='boxes' ? C.BOXES.map(value=>({value,label:value})) : Object.values(s[def.source]).filter(t=>t.published&&(!def.predicate||def.predicate(t))).map(t=>({value:t.id,label:t.name}));
}
function entries(f,def){return f.data[def.key] || [];}
function view(s,f,index=f.field,page=0) {
  const def=definition(f,index), options=choices(s,f,def);page=Math.max(0,Math.min(Number(page)||0,Math.max(0,Math.ceil(options.length/20)-1)));
  const current=def.type==='randomRoom' ? entries(f,def).map(e=>(options.find(o=>o.value===e.ref)?.label || e.template?.name || e.ref)+'：'+summary([e])).join('\n') :
    Object.entries(quantities(f.data[def.key],f.data[def.refs] || [],def.max)).map(([ref,n])=>(options.find(o=>o.value===ref)?.label || ref)+' ×'+n).join('\n');
  return U.payload(def.label,'下拉选择名称，再设置数量'+(def.type==='randomRoom' ? '对应的概率。每种内容独立抽取，单项合计100%。' : '。先在对应固定内容字段选择类型。')+'\n\n'+(current || '尚未选择。').slice(0,3300),[
    ...(options.length ? [U.row(U.select('formroomselect:'+f.id+':'+index,'选择要配置的内容',options.slice(page*20,page*20+20)))] : []),
    U.row(U.button('formroomlist:'+f.id+':'+index+':'+(page-1),'上一页',undefined,!page),U.button('formroomlist:'+f.id+':'+index+':'+(page+1),'下一页',undefined,(page+1)*20>=options.length),U.button('formback:'+f.id,'返回草稿'))
  ]);
}
function detail(s,f,index,ref,page=0) {
  const def=definition(f,index), option=choices(s,f,def).find(o=>o.value===ref);ok(option,'选择已失效，请重新选择。');
  if(def.type==='fixedRoom') {
    const counts=quantities(f.data[def.key],f.data[def.refs]||[],def.max);page=Math.max(0,Math.min(Number(page)||0,Math.ceil(def.max/25)-1));
    return U.payload('固定数量 · '+option.label,'当前 '+counts[ref]+' 个／件。下拉选择后保存到草稿。',[
      U.row(U.select('formroomfixed:'+f.id+':'+index+':'+ref,'选择数量',Array.from({length:Math.min(25,def.max-page*25)},(_,n)=>({label:String(n+page*25+1),value:String(n+page*25+1)})))),
      U.row(U.button('formroomdetail:'+f.id+':'+index+':'+ref+':'+(page-1),'上一页数量',undefined,!page),U.button('formroomdetail:'+f.id+':'+index+':'+ref+':'+(page+1),'下一页数量',undefined,(page+1)*25>=def.max),U.button('formroomlist:'+f.id+':'+index+':0','返回内容列表'))
    ]);
  }
  const rule=entries(f,def).find(e=>e.ref===ref), values=rule?.probabilities || defaultProbabilities(def.max),total=C.round2(values.reduce((a,b)=>a+b,0));
  return U.payload('出现概率 · '+option.label,(rule ? '已加入随机规则。' : '尚未加入；保存概率后加入。')+'\n'+values.map((p,n)=>n+' 个／件：**'+p+'%**').join('\n')+'\n合计 **'+total+'%**'+(total===100 ? '' : ' · ⚠️ 发布前必须合计100%'),[
    U.row(U.select('formroomprobpick:'+f.id+':'+index+':'+ref,'选择出现数量，填写该数量概率',values.map((p,n)=>({label:n+' 个／件 · '+p+'%',value:String(n)})))),
    U.row(U.button('formroomremove:'+f.id+':'+index+':'+ref,'移除此随机规则',U.D.ButtonStyle.Danger,!rule),U.button('formroomreset:'+f.id+':'+index+':'+ref,'恢复1个100%'),U.button('formroomlist:'+f.id+':'+index+':0','返回内容列表'),U.button('formback:'+f.id,'返回草稿'))
  ]);
}
async function openModal(i,s,needGM) {
  if(i.isModalSubmit?.() || !i.customId.startsWith('rpg:formroomprobpick:'))return false;
  const [, , fid,index,ref]=i.customId.split(':'),F=require('./forms'),f=F.owned(s,fid,i.user.id);needGM(s,i.member);
  const def=definition(f,Number(index)), n=C.number(i.values[0],'出现数量',0,def.max);ok(def.type==='randomRoom' && choices(s,f,def).some(o=>o.value===ref),'选择已失效。');
  const rule=entries(f,def).find(e=>e.ref===ref),value=(rule?.probabilities || defaultProbabilities(def.max))[n];
  await i.showModal(U.modal('formroomprobsubmit:'+fid+':'+index+':'+ref+':'+n,'设置出现 '+n+' 个／件的概率',[{key:'probability',label:'概率百分比（0—100，最多两位小数）',value}]));return true;
}
async function handle(i,member,context) {
  const [action,fid,index,ref,arg]=i.customId.split(':').slice(1),F=require('./forms'),s=context.snapshot(i.guildId),f=F.owned(s,fid,i.user.id),n=Number(index);
  context.needGM(s,member);const def=definition(f,n);
  if(action==='formroomlist')return view(s,f,n,ref);
  if(action==='formroomselect')return detail(s,f,n,i.values[0]);
  if(action==='formroomdetail')return detail(s,f,n,ref,arg);
  await context.tx(i,st=>{
    context.needGM(st,member);const live=F.owned(st,fid,i.user.id),d=definition(live,n);ok(choices(st,live,d).some(o=>o.value===ref),'选择已失效。');
    if(action==='formroomfixed') {ok(d.type==='fixedRoom','字段类型已变化。');const counts=quantities(live.data[d.key],live.data[d.refs]||[],d.max);counts[ref]=C.number(i.values[0],'数量',1,d.max);live.data[d.key]=counts;}
    else {
      ok(d.type==='randomRoom','字段类型已变化。');live.data[d.key] ||= [];let rule=live.data[d.key].find(e=>e.ref===ref);
      if(action==='formroomremove')live.data[d.key]=live.data[d.key].filter(e=>e.ref!==ref);
      else {
        ok(['formroomreset','formroomprobsubmit'].includes(action),'操作已失效。');
        if(!rule){ok(live.data[d.key].length<(d.limit || 25),'随机规则数量已满。');rule={ref,probabilities:defaultProbabilities(d.max)};live.data[d.key].push(rule);}
        if(action==='formroomreset')rule.probabilities=defaultProbabilities(d.max);
        else {const v=C.number(i.fields.getTextInputValue('probability'),'概率',0,100,false);ok(Math.abs(v*100-Math.round(v*100))<1e-7,'概率最多两位小数。');rule.probabilities[C.number(arg,'出现数量',0,d.max)]=v;}
      }
    }
    live.version=(live.version || 0)+1;
  },'保存房间数量概率草稿');
  const next=context.snapshot(i.guildId),live=F.owned(next,fid,i.user.id);return action==='formroomremove' ? view(next,live,n) : detail(next,live,n,ref);
}
module.exports={probabilities,defaultProbabilities,draw,validateEntries,quantities,summary,view,detail,openModal,handle};
