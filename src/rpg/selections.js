'use strict';
const C = require('./constants'), M = require('./model'), B = require('./combat'), F = require('./forms'), U = require('./ui');
const W = require('./weapons');
const { requireThat: ok } = C;
const operations = ['装备','卸下','装配','拆下','使用道具','使用世界树之心-头部','使用世界树之心-身体','使用世界树之心-戒指','使用世界树之泪'];
function createSelections(context) {
  const { snapshot, tx, needGM, pickView, use, publishBattle, offerAccess } = context;
  function entries(s, uid, op, offerId) {
    const p = M.player(s,uid);
    return Object.values(p.inventory).filter(item => {
      if(op==='使用'||op==='使用道具') return [...C.CONSUMABLES,'修复道具'].includes(item.snapshot.kind)&&M.available(s,uid,item.id)>0;
      if(op==='丢弃'||op==='报价') { try { M.transferable(s,uid,item.id,1,offerId); return true; } catch { return false; } }
      if(op.startsWith('使用世界树')) return item.snapshot.kind==='特殊物品'&&item.snapshot.special===(op==='使用世界树之泪'?'tear':'heart');
      if(op==='卸下') return M.equippedIds(p).includes(item.id);
      if(op==='装配'||op==='拆下') return ['武器','防具'].includes(item.snapshot.kind);
      return ['武器','防具','饰品','卡牌'].includes(item.snapshot.kind);
    }).map(item=>({value:item.id,label:item.snapshot.name,description:item.snapshot.kind+' · 数量 '+M.available(s,uid,item.id,offerId)+' · '+item.id}));
  }
  function list(s, uid, op, page=0, target='') {
    const values=op==='发放' ? Object.values(s.catalog).filter(t=>t.published).map(t=>({value:t.id,label:t.name,description:t.kind+' · v'+t.version+' · '+t.id})) : entries(s,uid,op);
    const v=pickView('下拉选择 · '+op, values, 'choose:'+op+':'+target, Number(page)||0);
    v.components.push(U.row(U.button('choose:home','返回操作菜单'))); return v;
  }
  function home() { return U.payload('背包操作','选择操作，再下拉选择物品。', [U.row(U.select('choose:operation','选择操作', ['使用','丢弃',...operations].map(value=>({value,label:value}))))]); }
  function quote(s, uid, id, page=0) {
    const offer=s.offers[id];ok(offer?.type==='trade'&&M.activeOffer(offer)&&offer.sides[uid],'不能修改此报价。');
    const side=offer.sides[uid],p=M.player(s,uid),v=pickView('选择自己的报价物品',entries(s,uid,'报价',id),'quoteitems:'+id+':'+offer.revision,Number(page)||0);
    v.embeds[0].setDescription('当前游戏币 '+side.coins+'\n'+(side.items.map(e=>(p.inventory[e.id]?.snapshot.name||'已不存在')+' ×'+e.quantity).join('\n')||'未选择物品')+'\n每次保存会更新报价并清除双方旧确认；数量填0移除。\n'+v.embeds[0].data.description);
    v.components.push(U.row(U.button('quotecoins:'+id+':'+offer.revision,'填写游戏币'),U.button('quotefinish:'+id+':'+offer.revision,'保存并返回交易',U.D.ButtonStyle.Success),U.button('offer:'+id,'返回交易')));return v;
  }
  async function openModal(i,s) {
    if(i.isModalSubmit?.())return false;
    const [action,id,revision,ref]=i.customId.split(':').slice(1);
    if(action==='chooseamount') {
      const f=F.owned(s,id,i.user.id);ok(!f.done&&f.expiresAt>Date.now(),'操作已过期。');
      if(f.operation==='发放') needGM(s,i.member);
      await i.showModal(U.modal('choosesubmit:'+id,'填写数量',[{key:'quantity',label:'数量',value:1}]));return true;
    }
    if(!['quoteitems','quotecoins'].includes(action)||(action==='quoteitems'&&ref!=='select'))return false;
    const offer=offerAccess(s,id,i.member,i.user.id);ok(M.activeOffer(offer)&&offer.type==='trade'&&offer.sides[i.user.id]&&offer.revision===Number(revision),'报价已变化，请重新打开。');
    const itemId=action==='quoteitems' ? i.values[0] : null;
    if(itemId) M.transferable(s,i.user.id,itemId,1,id);
    await i.showModal(U.modal('quotesave:'+id+':'+revision+':'+(itemId||'coins'), itemId ? '报价物品数量' : '游戏币报价', [{key:'value',label:itemId ? '数量（0移除）' : '游戏币（0表示不提供）',value:itemId ? offer.sides[i.user.id].items.find(e=>e.id===itemId)?.quantity||1 : offer.sides[i.user.id].coins}])); return true;
  }
  async function execute(i,member,f) {
    const uid=i.user.id;
    if(f.operation==='使用'||f.operation==='使用道具') {
      const result=await use(i,f.ref,f.part,f.id);return U.payload('已使用 · '+result.name,result.repaired!=null?result.target+'耐久变化 '+(result.repaired>=0?'+':'')+result.repaired+' · '+result.durability+'/'+result.maximum+(result.maximumLost?' · 上限 -'+result.maximumLost:''):'恢复 '+result.healed+' HP · 当前 '+result.hp,[U.row(U.button('choose:使用::0','继续选择物品'))]);
    }
    const result=await tx(i,s=>{
      const live=F.owned(s,f.id,uid);ok(!live.done&&live.expiresAt>Date.now(),'操作已完成或过期。');
      if(live.operation==='发放') {needGM(s,member);ok(s.catalog[live.ref]?.version===live.templateVersion,'模板已更新，请重新选择。');ok(M.player(s,live.target).id===live.characterId,'目标角色已变化。');M.issue(s,live.target,live.ref,live.quantity);}
      else {ok(M.player(s,uid).id===live.characterId,'角色已变化。');
        if(live.operation==='丢弃') M.drop(s,uid,live.ref,live.quantity);
        else if(['装配','拆下'].includes(live.operation)) M.attach(s,uid,live.ref,live.part,live.operation==='拆下');
        else if(live.operation.startsWith('使用世界树')) M.useSpecial(s,uid,live.ref,{'使用世界树之心-头部':'head','使用世界树之心-身体':'body','使用世界树之心-戒指':'ring'}[live.operation]);
        else {const b=M.battleFor(s,uid);if(b?.status==='active'){const a=b.actors.find(a=>a.userId===uid);ok(b.current?.actorId===a?.id&&live.operation==='装备','战斗中请在自己的当前行动面板切换武器。');B.switchWeapon(s,b,b.current.id,live.ref,live.hand || 'auto');B.nextOpportunity(s,b);}else M.equip(s,uid,live.ref,live.operation==='卸下',live.hand || 'auto');}
      }
      live.done=true;return live.name+' · '+live.operation+'已完成';
    },'下拉物品操作');
    const b=M.battleFor(snapshot(i.guildId),uid);if(b)await publishBattle(i.guildId,b.id);
    return U.payload('已保存',result,[U.row(U.button('choose:home','返回操作菜单'))]);
  }
  function preview(f) {return U.payload('确认 · '+f.operation,f.name+' ×'+f.quantity+(f.partName?' → '+f.partName:'')+'\n'+(f.operation==='丢弃'?'丢弃不可恢复。':f.weapon&&f.operation==='装备'?(f.hands===2?'双手武器占用两手，原有武器回到背包。':'单手武器放入所选手位；被替换的武器回到背包。'):'请确认本次操作。'),[
    ...(f.weapon&&f.operation==='装备'&&f.hands===1?[U.row(U.select('choosehand:'+f.id,'选择主手或副手',[{value:'main',label:'主手',default:(f.hand||'main')==='main'},{value:'off',label:'副手',default:f.hand==='off'}]))]:[]),
    U.row(U.button('choosedo:'+f.id,'确认'+f.operation,f.operation==='丢弃'?U.D.ButtonStyle.Danger:U.D.ButtonStyle.Success),U.button('choose:home','取消'))]);}
  async function component(i,member) {
    const [action,arg,target,step]=i.customId.split(':').slice(1),s=snapshot(i.guildId),uid=i.user.id;
    if(action==='quote') {context.owner(i,target);offerAccess(s,arg,member,uid);return quote(s,uid,arg);}
    if(['quoteitems','quotesave','quotefinish'].includes(action)) {
      const offer=offerAccess(s,arg,member,uid);ok(offer.revision===Number(target)&&M.activeOffer(offer),'报价已变化，请重新打开交易。');
      if(action==='quoteitems')return quote(s,uid,arg,step);
      await tx(i,st=>{const o=st.offers[arg];ok(o?.revision===Number(target),'报价已变化。');const side=o.sides[uid];ok(side,'你不是交易方。');let items=C.clone(side.items),coins=side.coins;
        if(action==='quotesave'){const n=C.number(i.fields.getTextInputValue('value'),step==='coins'?'游戏币':'数量',0,step==='coins'?C.MAX_MONEY:100000);if(step==='coins')coins=n;else {items=items.filter(e=>e.id!==step);if(n)items.push({id:step,quantity:n});}}
        return M.updateOffer(st,arg,uid,items,coins);
      },'下拉保存交易报价');
      const next=snapshot(i.guildId);return action==='quotefinish'?U.offerView(next,next.offers[arg],uid):quote(next,uid,arg);
    }
    if(action==='choose') {
      if(arg==='home')return home();
      if(arg==='operation')return list(s,uid,i.values[0]);
      ok(['使用','丢弃','发放',...operations].includes(arg),'操作无效。');if(arg==='发放'){needGM(s,member);M.player(s,target);}
      if(step!=='select')return list(s,uid,arg,step,target);
      const ref=i.values[0],options=arg==='发放'?Object.values(s.catalog).filter(t=>t.published).map(t=>({value:t.id})):entries(s,uid,arg);ok(options.some(o=>o.value===ref),'物品已不可用，请重新选择。');
      const f=await tx(i,st=>{const t=arg==='发放'?st.catalog[ref]:M.player(st,uid).inventory[ref].snapshot;const f={id:C.id('f'),owner:uid,kind:'selection',operation:arg,ref,target,name:t.name,templateVersion:t.version,characterId:M.player(st,arg==='发放'?target:uid).id,weapon:t.kind==='武器',hands:t.kind==='武器'?W.hands(t):null,hand:'main',quantity:1,expiresAt:Date.now()+300000};st.forms[f.id]=f;return f;});
      if(['发放','丢弃'].includes(arg))return U.payload('数量 · '+f.name,'选择物品完成，请填写数量。',[U.row(U.button('chooseamount:'+f.id,'填写数量'),U.button('choose:'+arg+':'+target+':0','返回物品列表'))]);
      if(['装配','拆下'].includes(arg))return parts(s,uid,f);
      if(M.player(s,uid).inventory[f.ref]?.snapshot.kind==='修复道具')return repairTargets(s,uid,f);
      return preview(f);
    }
    const f=F.owned(s,arg,uid);ok(f.kind==='selection'&&!f.done&&f.expiresAt>Date.now(),'操作已过期或完成。');
    if(f.operation==='发放')needGM(s,member);
    if(action==='choosehand'){ok(f.weapon&&f.operation==='装备'&&f.hands===1&&['main','off'].includes(i.values[0]),'手位选择无效。');await tx(i,st=>{const live=F.owned(st,arg,uid);ok(!live.done&&live.characterId===M.player(st,uid).id,'角色或步骤已变化。');live.hand=i.values[0];});return preview(F.owned(snapshot(i.guildId),arg,uid));}
    if(action==='chooserepair'){if(target!=='select')return repairTargets(s,uid,f,target);const item=M.player(s,uid).inventory[i.values[0]],tool=M.player(s,uid).inventory[f.ref];ok(item&&tool?.snapshot.repairKinds.includes(item.snapshot.kind),'修复目标已变化。');await tx(i,st=>{const live=F.owned(st,arg,uid);live.part=i.values[0];live.partName=M.player(st,uid).inventory[live.part]?.snapshot.name;});return preview(F.owned(snapshot(i.guildId),arg,uid));}
    if(action==='choosepart') {
      if(target!=='select')return parts(s,uid,f,target);
      await tx(i,st=>{const live=F.owned(st,arg,uid);live.part=i.values[0];live.partName=M.player(st,uid).inventory[live.part]?.snapshot.name;});return preview(F.owned(snapshot(i.guildId),arg,uid));
    }
    if(action==='choosesubmit'){await tx(i,st=>{const live=F.owned(st,arg,uid);live.quantity=C.number(i.fields.getTextInputValue('quantity'),'数量',1,live.operation==='发放'?100:100000);if(live.operation==='丢弃')M.transferable(st,uid,live.ref,live.quantity);});return preview(F.owned(snapshot(i.guildId),arg,uid));}
    ok(action==='choosedo','操作已失效。');return execute(i,member,f);
  }
  function parts(s,uid,f,page=0) {
    const p=M.player(s,uid),root=p.inventory[f.ref];ok(root,'装备已不存在。');
    const options=Object.values(p.inventory).filter(item=>f.operation==='拆下'?(root.attachments||[]).includes(item.id):item.snapshot.kind==='配件'&&M.available(s,uid,item.id)>0).map(item=>({value:item.id,label:item.snapshot.name,description:item.id}));
    const v=pickView('选择配件 · '+f.name,options,'choosepart:'+f.id,Number(page)||0);v.components.push(U.row(U.button('choose:home','取消')));return v;
  }
  function repairTargets(s,uid,f,page=0){const Dur=require('./durability'),p=M.player(s,uid),tool=p.inventory[f.ref];ok(tool?.snapshot.kind==='修复道具','修复道具已不存在。');return pickView('选择要修复的装备',Object.values(p.inventory).filter(item=>tool.snapshot.repairKinds.includes(item.snapshot.kind)&&Dur.current(item)<Dur.maximum(item)&&M.available(s,uid,item.id)>0).map(item=>({value:item.id,label:item.snapshot.name,description:'耐久 '+Dur.current(item)+'/'+Dur.maximum(item)+' · '+item.id})),'chooserepair:'+f.id,Number(page)||0);}
  async function repairStart(i,ref){const f=await tx(i,s=>{const item=M.player(s,i.user.id).inventory[ref];ok(item?.snapshot.kind==='修复道具'&&M.available(s,i.user.id,ref)>0,'修复道具已不可用。');const f={id:C.id('f'),owner:i.user.id,kind:'selection',operation:'使用',ref,name:item.snapshot.name,quantity:1,characterId:M.player(s,i.user.id).id,expiresAt:Date.now()+300000};s.forms[f.id]=f;return f;});return repairTargets(snapshot(i.guildId),i.user.id,f);}
  return {list,home,quote,openModal,component,repairStart};
}
module.exports={createSelections};
