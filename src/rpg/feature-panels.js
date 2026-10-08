'use strict';
const C=require('./constants'),M=require('./model'),U=require('./ui'),Coupons=require('./coupons'),Boss=require('./boss'),Glossary=require('./glossary'),Showcase=require('./showcase');
const ok=C.requireThat, PAGE=20;
const prefix=(type,action,...args)=>['features',type,action,...args].join(':');
function createPanels({snapshot,tx,store,needGM}) {
  function owned(s,id,uid,version) {const f=s.forms[id];ok(f&&f.owner===uid&&f.expiresAt>Date.now(),'草稿已过期或不属于你。');if(version!==undefined)ok(f.version===Number(version),'面板已更新，请重新打开。');return f;}
  function fresh(s,uid,kind,data={}) {const f={id:C.id('f'),kind,owner:uid,version:0,expiresAt:Date.now()+86400000,...data};s.forms[f.id]=f;return f;}
  const poolSource=(s,type)=>type==='boss'?s.bossPools:s.couponPools;
  function home(s,type,page=0) {
    const pools=Object.values(poolSource(s,type)||{}),part=pools.slice(page*PAGE,page*PAGE+PAGE);
    return U.payload(type==='boss'?'GM · BOSS池':'GM · 兑换券管理',part.map(p=>p.name+' · v'+p.version+(p.enabled===false?' · 停止发券':'')).join('\n')||'尚无池，请先新建。',[
      ...(part.length?[U.row(U.select(prefix(type,'edit'),'选择池编辑',part.map(p=>({label:p.name,value:p.id}))))]:[]),
      U.row(U.button(prefix(type,'new'),'新建池',U.D.ButtonStyle.Primary),...(type==='coupon'?[U.button(prefix(type,'grantstart'),'批量发券'),U.button(prefix(type,'audit',0),'兑换记录')]:[])),
      U.row(U.button(prefix(type,'home',Math.max(0,page-1)),'上一页',undefined,page===0),U.button(prefix(type,'home',page+1),'下一页',undefined,(page+1)*PAGE>=pools.length))]);
  }
  function recipe(s,f,preview=false) {
    const type=f.type,base=(a,...x)=>prefix(type,a,f.id,f.version,...x),source=type==='boss'?s.npcTemplates:s.catalog;
    const entries=f.data.entries||[],part=Object.values(source).filter(t=>t.published&&(type==='boss'||t.kind!=='技能'&&require('./item-categories').matches(t,f.category||'all',true))).slice((f.page||0)*PAGE,(f.page||0)*PAGE+PAGE);
    const body='**'+f.data.name+'**\n'+f.data.description+'\n'+(type==='coupon'?'模式：'+(f.data.mode==='bundle'?'整套领取':'单一领取')+' · '+(f.data.enabled===false?'停止新发券':'允许发券')+'\n':'整组生成 · 每图最多一间BOSS房\n')+
      entries.slice((f.entryPage||0)*PAGE,(f.entryPage||0)*PAGE+PAGE).map(e=>(source[e.ref]?.name||'模板失效')+' ×'+e.quantity).join('\n')+'\n条目 '+((f.entryPage||0)+1)+'/'+Math.max(1,Math.ceil(entries.length/PAGE));
    if(preview)return U.payload('发布前确认',body,[U.row(U.button(base('publish'),'确认发布',U.D.ButtonStyle.Success),U.button(base('back'),'返回编辑'),U.button(base('entrypage'),'下一页条目',undefined,entries.length<=PAGE))]);
    const rows=[];if(part.length)rows.push(U.row(U.select(base('add'),'选择模板加入或修改数量',part.map(t=>({label:t.name,value:t.id})))));
    if(type==='coupon')rows.push(require('./item-categories').row(base('category'),f.category||'all',true));
    rows.push(U.row(U.button(base('page',Math.max(0,(f.page||0)-1)),'上一页',undefined,!f.page),U.button(base('page',(f.page||0)+1),'下一页',undefined,part.length<PAGE),U.button(base('name'),'名称与说明'),...(type==='coupon'?[U.button(base('mode'),f.data.mode==='bundle'?'改为单一领取':'改为整套领取'),U.button(base('toggle'),f.data.enabled===false?'允许发券':'停止发券')]:[])));
    if(entries.length)rows.push(U.row(U.select(base('quantity'),'修改已有条目数量；输入0移除',entries.slice((f.entryPage||0)*PAGE,(f.entryPage||0)*PAGE+PAGE).map(e=>({label:(source[e.ref]?.name||'失效')+' ×'+e.quantity,value:e.ref})))));
    rows.push(U.row(U.button(base('preview'),'预览发布',U.D.ButtonStyle.Success),U.button(base('entrypage'), '下一页已有条目',undefined,entries.length<=PAGE),U.button(prefix(type,'home',0),'返回池列表')));
    return U.payload('GM持久池草稿',body,rows);
  }
  function grantView(s,f,confirm=false) {
    const pools=Object.values(s.couponPools||{}).filter(p=>p.published&&p.enabled!==false),base=(a)=>prefix('grant',a,f.id,f.version),p=s.couponPools[f.poolId];
    const targets=f.targets||[],rows=[];if(confirm)return U.payload('确认批量发券',(p?.name||'未选择池')+'\n'+targets.map(t=>s.players[t.uid]?.name+' ×'+t.quantity).join('\n'),[U.row(U.button(base('commit'),'确认发放',U.D.ButtonStyle.Success),U.button(base('back'),'返回修改'))]);
    if(pools.length)rows.push(U.row(U.select(base('pool'),'选择兑换券池',pools.slice((f.page||0)*PAGE,(f.page||0)*PAGE+PAGE).map(p=>({label:p.name,value:p.id,default:p.id===f.poolId})))));
    rows.push(U.row(new U.D.UserSelectMenuBuilder().setCustomId('rpg:'+base('users')).setPlaceholder('选择1—25名有效角色').setMinValues(1).setMaxValues(25)));
    if(targets.length)rows.push(U.row(U.select(base('target'),'选择目标调整个人发券数',targets.map(t=>({label:(s.players[t.uid]?.name||t.uid)+' ×'+t.quantity,value:t.uid})))));
    rows.push(U.row(U.button(base('page'),'下一页池',undefined,pools.length<=PAGE),U.button(base('preview'),'预览发放',U.D.ButtonStyle.Success),U.button(prefix('coupon','home',0),'返回')));
    return U.payload('GM批量发券',(p?.name||'请选择池')+'\n'+targets.map(t=>s.players[t.uid]?.name+' ×'+t.quantity).join('\n'),rows);
  }
  function redeemHome(s,uid,page=0) {
    const p=M.player(s,uid),pools=Object.values(s.couponPools||{}).filter(v=>(p.couponBalances?.[v.id]||0)>0),part=pools.slice(page*PAGE,page*PAGE+PAGE);
    return U.payload('我的兑换券',part.map(v=>v.name+' **×'+p.couponBalances[v.id]+'**').join('\n')||'暂无兑换券。',[
      ...(part.length?[U.row(U.select(prefix('redeem','pool'),'查看兑换池',part.map(v=>({label:v.name+' ×'+p.couponBalances[v.id],value:v.id}))))]:[]),U.row(U.button(prefix('redeem','home',Math.max(0,page-1)),'上一页',undefined,!page),U.button(prefix('redeem','home',page+1),'下一页',undefined,(page+1)*PAGE>=pools.length))]);
  }
  function redeemPool(s,uid,id,page=0) {
    M.player(s,uid);const p=Coupons.pool(s,id),part=p.entries.slice(page*PAGE,page*PAGE+PAGE),rows=[];
    if(p.mode==='bundle')rows.push(U.row(U.button(prefix('redeem','prepare',id),'预览整套领取',U.D.ButtonStyle.Success)));
    else if(part.length)rows.push(U.row(U.select(prefix('redeem','choose',id),'选择一种领取',part.map(e=>({label:(s.catalog[e.ref]?.name||'模板失效')+' ×'+e.quantity,value:e.ref})))));
    rows.push(U.row(U.button(prefix('redeem','page',id,Math.max(0,page-1)),'上一页',undefined,!page),U.button(prefix('redeem','page',id,page+1),'下一页',undefined,(page+1)*PAGE>=p.entries.length),U.button(prefix('redeem','home',0),'返回')));
    return require('./loot-icons').grid(U.payload(p.name+' · v'+p.version,p.description+'\n每次消耗1券 · '+(p.mode==='bundle'?'领取整套':'选择一种')+'\n'+part.map(e=>(s.catalog[e.ref]?.name||'模板失效')+' ×'+e.quantity).join('\n')+'\n参战或倒地期间只能查看。',rows),p.name,part.slice(0,12).map(e=>({snapshot:s.catalog[e.ref]||{name:'失效'},templateId:e.ref,quantity:e.quantity})));
  }
  function confirmView(s,f,page=0) {const part=f.entries.slice(page*PAGE,page*PAGE+PAGE);return U.payload('确认消耗1券',part.map(e=>(s.catalog[e.ref]?.name||e.ref)+' ×'+e.quantity).join('\n')+'\n超重或状态变化时不会扣券。 条目 '+(page+1)+'/'+Math.ceil(f.entries.length/PAGE),[U.row(U.button(prefix('redeem','commit',f.id),'确认兑换',U.D.ButtonStyle.Success),U.button(prefix('redeem','confirmview',f.id,Math.max(0,page-1)),'上一页',undefined,!page),U.button(prefix('redeem','confirmview',f.id,page+1),'下一页',undefined,(page+1)*PAGE>=f.entries.length),U.button(prefix('redeem','home',0),'取消'))]);}
  function redemptionView(r,page=0) {const part=r.items.slice(page*12,page*12+12);return require('./loot-icons').grid(U.payload('兑换已保存 · '+r.name,part.map(i=>i.snapshot.name+' ×'+i.quantity).join('\n')+'\n剩余券数 '+r.remaining,[U.row(U.button(prefix('redeem','result',r.id,Math.max(0,page-1)),'上一页',undefined,!page),U.button(prefix('redeem','result',r.id,page+1),'下一页',undefined,(page+1)*12>=r.items.length),U.button(prefix('redeem','home',0),'返回兑换券'))]),r.name,part);}
  function showcase(s,viewer,uid,page=0,edit=false) {
    const p=M.player(s,uid);ok(!edit||viewer===uid,'只能编辑自己的收藏柜。');const items=edit?Showcase.eligible(p):Showcase.entries(s,uid),size=edit?PAGE:12,part=items.slice(page*size,page*size+size),rows=[];
    if(edit&&part.length)rows.push(U.row(U.select(prefix('showcase','save',uid,p.id,page),'本页勾选的物品将公开展示',part.map(i=>({label:i.snapshot.name+' ×'+i.quantity,value:i.id,default:(p.showcase||[]).includes(i.id)})),0,part.length)));
    rows.push(U.row(U.button(prefix('showcase',edit?'edit':'view',uid,Math.max(0,page-1)),'上一页',undefined,!page),U.button(prefix('showcase',edit?'edit':'view',uid,page+1),'下一页',undefined,(page+1)*size>=items.length),...(viewer===uid?[U.button(prefix('showcase',edit?'view':'edit',uid,0),edit?'查看公开收藏柜':'选择展示物品')]:[])));
    const v=U.payload(p.name+'的收藏柜',(edit?'仅金色/红色实物可选；勾选即同意公开这些物品。\n':'')+(part.map(i=>'**'+i.snapshot.name+'** ×'+i.quantity+'\n'+(i.snapshot.description||'').slice(0,100)).join('\n')||'暂无展示物品。'),rows,0xa74356);
    return require('./loot-icons').grid(v,p.name+'的收藏柜',part.slice(0,12));
  }
  function glossary(s,q='',page=0,gm=false,searchId='_') {
    const terms=Glossary.search(s,q,gm),part=terms.slice(page*PAGE,page*PAGE+PAGE),type=gm?'glossary':'terms';return U.payload(gm?'GM名词库':'名词解释',part.map(t=>t.name+(t.published?'':'（已停用）')).join('\n')||'没有匹配名词。',[
      ...(part.length?[U.row(U.select(prefix(type,gm?'edit':'read',searchId),'选择名词',part.map(t=>({label:t.name,value:t.id}))))]:[]),U.row(U.button(prefix(type,'home',Math.max(0,page-1),searchId),'上一页',undefined,!page),U.button(prefix(type,'home',page+1,searchId),'下一页',undefined,(page+1)*PAGE>=terms.length),...(gm?[U.button(prefix(type,'new'),'录入名词')]:[]))]);
  }
  async function openModal(i,s) {
    if(i.isModalSubmit?.()||!i.customId?.startsWith('rpg:features:'))return false;
    const [type,action,id,version]=i.customId.split(':').slice(2);
    if(!['new','name','quantity','target'].includes(action))return false;needGM(s,i.member);
    let fields,title,custom;
    if(['coupon','boss'].includes(type)&&['new','name'].includes(action)) {const f=action==='name'?owned(s,id,i.user.id,version):null;fields=[{key:'name',label:'名称',value:f?.data.name,maxLength:80},{key:'description',label:'说明',value:f?.data.description,maxLength:1000,style:U.D.TextInputStyle.Paragraph,required:false}];title='录入'+(type==='boss'?'BOSS池':'兑换券池');custom=prefix(type,action+'submit',id||'new',version||0);}
    else if(['coupon','boss'].includes(type)&&action==='quantity') {const f=owned(s,id,i.user.id,version),ref=i.values[0];fields=[{key:'quantity',label:'数量，0移除条目',value:f.data.entries.find(e=>e.ref===ref)?.quantity||1}];title='修改数量';custom=prefix(type,'quantitysubmit',id,version,ref);}
    else if(type==='grant'&&action==='target'){const f=owned(s,id,i.user.id,version),uid=i.values[0];fields=[{key:'quantity',label:'此角色发券数量',value:f.targets.find(t=>t.uid===uid)?.quantity||1}];title='个人发券数';custom=prefix(type,'amountsubmit',id,version,uid);}
    else if(type==='glossary'&&action==='new') {fields=[{key:'name',label:'名词',maxLength:80},{key:'description',label:'解释',maxLength:4000,style:U.D.TextInputStyle.Paragraph}];title='录入名词';custom=prefix(type,'newsubmit');}
    else if(type==='glossary'&&action==='name') {const f=owned(s,id,i.user.id,version);fields=[{key:'name',label:'名词',value:f.data.name,maxLength:80},{key:'description',label:'解释',value:f.data.description,maxLength:4000,style:U.D.TextInputStyle.Paragraph}];title='编辑名词';custom=prefix(type,'namesubmit',id,version);}
    else return false;
    await i.showModal(U.modal(custom,title,fields));return true;
  }
  async function component(i,member) {
    const [type,action,id,version,extra]=i.customId.split(':').slice(2),uid=i.user.id,s=snapshot(i.guildId);
    if(['coupon','boss','grant','glossary'].includes(type))needGM(s,member);
    if(['coupon','boss'].includes(type)) {
      if(action==='home')return home(s,type,Number(id)||0);
      if(action==='audit'){const rows=Object.values(s.couponRedemptions||{}).reverse().slice((Number(id)||0)*PAGE,(Number(id)||0)*PAGE+PAGE);return U.payload('GM兑换记录',rows.map(r=>'<@'+r.owner+'> · '+r.name+' · '+r.items.map(i=>i.snapshot.name+' ×'+i.quantity).join('、')).join('\n')||'无记录',[U.row(U.button(prefix(type,'audit',(Number(id)||0)+1),'下一页'),U.button(prefix(type,'home',0),'返回'))]);}
      if(action==='grantstart'){const f=await tx(i,st=>fresh(st,uid,'couponGrant',{targets:[],page:0}),'创建发券草稿');return grantView(snapshot(i.guildId),f);}
      const result=await tx(i,st=>{needGM(st,member);
        if(action==='newsubmit')return fresh(st,uid,'recipeEdit',{type,baseVersion:0,data:{name:C.text(i.fields.getTextInputValue('name'),'名称',80),description:i.fields.getTextInputValue('description'),mode:'choice',enabled:true,entries:[]},category:'all',page:0});
        if(action==='edit'){const p=poolSource(st,type)?.[i.values[0]];ok(p,'池已不存在。');return fresh(st,uid,'recipeEdit',{type,poolId:p.id,baseVersion:p.version,data:C.clone(p),category:'all',page:0});}
        const f=owned(st,id,uid,version);ok(f.kind==='recipeEdit'&&f.type===type&&!f.done,'草稿类型不符。');
        if(action==='namesubmit'){f.data.name=C.text(i.fields.getTextInputValue('name'),'名称',80);f.data.description=C.text(i.fields.getTextInputValue('description'),'说明',1000,true);}
        else if(action==='mode')f.data.mode=f.data.mode==='bundle'?'choice':'bundle';
        else if(action==='toggle')f.data.enabled=f.data.enabled===false;
        else if(action==='category'){ok(require('./item-categories').valid(i.values[0],true),'分类无效。');f.category=i.values[0];f.page=0;}
        else if(action==='page')f.page=Number(extra)||0;
        else if(action==='entrypage')f.entryPage=((f.entryPage||0)+1)%Math.max(1,Math.ceil(f.data.entries.length/PAGE));
        else if(['add','quantitysubmit'].includes(action)){const ref=action==='add'?i.values[0]:extra,source=type==='boss'?st.npcTemplates:st.catalog;ok(source[ref]?.published&&(type==='boss'||source[ref].kind!=='技能'),'模板已失效。');const n=action==='add'?1:C.number(i.fields.getTextInputValue('quantity'),'数量',0,type==='boss'?19:100);f.data.entries=f.data.entries.filter(e=>e.ref!==ref);if(n)f.data.entries.push({ref,quantity:n});}
        else if(action==='preview'){(type==='boss'?Boss:Coupons).validate(st,f.data);f.preview=true;}
        else if(action==='back')f.preview=false;
        else if(action==='publish'){ok(f.preview&&!f.done,'请先预览发布。');const p=(type==='boss'?Boss:Coupons).publish(st,f.data,f.poolId,f.baseVersion);f.done=true;return {published:p.name};}
        else ok(false,'未知池操作。');f.version++;return f;
      },'GM编辑内容池');if(result.published)return U.payload('已发布',result.published,[U.row(U.button(prefix(type,'home',0),'返回池列表'))]);return recipe(snapshot(i.guildId),result,result.preview);
    }
    if(type==='grant') {
      const f=await tx(i,st=>{needGM(st,member);const f=owned(st,id,uid,version);ok(f.kind==='couponGrant'&&!f.done,'发券已完成或草稿无效。');
        if(action==='pool'){const p=Coupons.pool(st,i.values[0]);ok(p.enabled,'该池已停止发券。');f.poolId=p.id;f.poolVersion=p.version;}
        else if(action==='users')f.targets=i.values.map(uid=>({uid,characterId:M.player(st,uid).id,quantity:f.targets.find(t=>t.uid===uid)?.quantity||1}));
        else if(action==='amountsubmit'){const t=f.targets.find(t=>t.uid===extra);ok(t,'目标已变化。');t.quantity=C.number(i.fields.getTextInputValue('quantity'),'发券数量',1,100000);}
        else if(action==='page')f.page=((f.page||0)+1)%Math.max(1,Math.ceil(Object.values(st.couponPools).filter(p=>p.enabled).length/PAGE));
        else if(action==='preview'){ok(f.poolId&&f.targets.length,'请选择池及玩家。');ok(Coupons.pool(st,f.poolId).version===f.poolVersion,'池已更新，请重新选择。');f.preview=true;}
        else if(action==='back')f.preview=false;
        else if(action==='commit'){ok(f.preview&&Coupons.pool(st,f.poolId).version===f.poolVersion,'请重新预览发放。');const result=Coupons.grant(st,f.poolId,f.targets);f.done=true;return {...f,result};}
        else ok(false,'发券入口失效。');f.version++;return f;
      },'批量发放兑换券');return f.done?U.payload('兑换券已发放',f.result.length+'名角色',[U.row(U.button(prefix('coupon','home',0),'返回'))]):grantView(snapshot(i.guildId),f,f.preview);
    }
    if(type==='redeem') {
      if(action==='home')return redeemHome(s,uid,Number(id)||0);
      if(action==='pool')return redeemPool(s,uid,i.values[0]);if(action==='page')return redeemPool(s,uid,id,Number(version)||0);
      if(['prepare','choose','commit'].includes(action))ok(U.playerRole(s,member)||U.gm(s,member),'需要玩家身份组。');
      if(['prepare','choose'].includes(action)){const f=await tx(i,st=>Coupons.preview(st,uid,id,action==='choose'?i.values[0]:null),'预览兑换');return confirmView(snapshot(i.guildId),f);}
      if(action==='confirmview'){const f=s.forms[id];ok(f?.owner===uid&&f.kind==='couponRedeem','兑换确认不属于你。');return confirmView(s,f,Number(version)||0);}
      if(action==='result'){const r=s.couponRedemptions[id];ok(r?.owner===uid,'兑换记录不属于你。');return redemptionView(r,Number(version)||0);}
      if(action==='commit'){const r=await store.transact(i.guildId,'coupon:'+id,uid,st=>Coupons.redeem(st,uid,id),'兑换券原子领取');return redemptionView(r);}
    }
    if(type==='showcase'){if(action==='save'){ok(id===uid,'只能编辑自己的收藏柜。');await tx(i,st=>Showcase.select(st,uid,version,Number(extra)||0,i.values),'调整公开收藏柜');return showcase(snapshot(i.guildId),uid,uid,Number(extra)||0,true);}return showcase(s,uid,id,Number(version)||0,action==='edit');}
    if(type==='terms'){const searchId=action==='read'?id:version,search=searchId&&searchId!=='_'?owned(s,searchId,uid):null;ok(!search||search.kind==='termSearch','检索已失效。');if(action==='read'){const t=s.glossaryTerms?.[i.values[0]];ok(t?.published,'该名词未发布。');return U.payload(t.name,t.description,[U.row(U.button(prefix('terms','home',0,searchId||'_'),'返回名词库'))]);}return glossary(s,search?.query||'',Number(id)||0,false,searchId||'_');}
    if(type==='glossary') {
      if(action==='home')return glossary(s,'',Number(id)||0,true);
      const f=await tx(i,st=>{needGM(st,member);
        if(action==='newsubmit')return fresh(st,uid,'glossaryEdit',{data:{name:C.text(i.fields.getTextInputValue('name'),'名词',80),description:C.text(i.fields.getTextInputValue('description'),'解释',4000)},baseVersion:0});
        if(action==='edit'){const t=st.glossaryTerms[i.values[0]];ok(t,'名词不存在。');return fresh(st,uid,'glossaryEdit',{data:C.clone(t),termId:t.id,baseVersion:t.version});}
        const f=owned(st,id,uid,version);ok(f.kind==='glossaryEdit'&&!f.done,'名词草稿失效。');
        if(action==='namesubmit'){f.data.name=C.text(i.fields.getTextInputValue('name'),'名词',80);f.data.description=C.text(i.fields.getTextInputValue('description'),'解释',4000);}
        else if(action==='publish'){Glossary.publish(st,f.data,f.termId,f.baseVersion);f.done=true;}
        else if(action==='disable'){const t=st.glossaryTerms[f.termId];ok(t&&t.version===f.baseVersion,'名词已更新。');t.published=false;t.version++;f.done=true;}
        else ok(false,'名词入口已失效。');f.version++;return f;
      },'GM名词草稿与发布');return f.done?glossary(snapshot(i.guildId),'',0,true):U.payload('名词发布预览 · '+f.data.name,f.data.description,[U.row(U.button(prefix('glossary','publish',f.id,f.version),'确认发布',U.D.ButtonStyle.Success),U.button(prefix('glossary','name',f.id,f.version),'继续修改'),...(f.termId?[U.button(prefix('glossary','disable',f.id,f.version),'停用')]:[]))]);
    }
    ok(false,'功能入口已经失效。');
  }
  async function slash(i,member) {const s=snapshot(i.guildId);if(i.commandName==='兑换券')return redeemHome(s,i.user.id);if(i.commandName==='收藏柜')return showcase(s,i.user.id,i.options.getUser('成员')?.id||i.user.id);if(i.commandName==='名词解释'){const query=i.options.getString('关键词')||'';if(!query)return glossary(s);const f=await tx(i,st=>fresh(st,i.user.id,'termSearch',{query}),'保存名词检索');return glossary(snapshot(i.guildId),query,0,false,f.id);}needGM(s,member);return i.options.getSubcommand()==='名词'?glossary(s,'',0,true):home(s,'coupon');}
  return {home,recipe,grantView,redeemHome,redeemPool,showcase,glossary,openModal,component,slash};
}
module.exports={createPanels};
