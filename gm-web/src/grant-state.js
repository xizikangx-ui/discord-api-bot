export const grantTypes={item:'物品',xp:'经验',points:'属性点',tickets:'抽取次数',skill:'战斗技能',checkskill:'鉴定技能',coupon:'兑换券'};
export const entryKey=e=>e.type+':'+(e.ref||'');
export function grantRows(targets,entries,overrides={}){return targets.flatMap(t=>entries.map(e=>({...e,quantity:overrides[t.uid]?.[entryKey(e)]??e.quantity})).filter(e=>e.quantity>0).map(e=>({uid:t.uid,characterId:t.characterId,type:e.type,ref:e.ref||'',quantity:Number(e.quantity)})));}
export function grantErrors(targets,entries,overrides={}){
 const errors=[];if(!targets.length)errors.push('先勾选收件角色');if(targets.length>25)errors.push('一次最多25名角色');if(!entries.length)errors.push('至少添加一个发放项目');
 const rows=grantRows(targets,entries,overrides);if(rows.length>625)errors.push('发放清单最多625项');
 for(const t of targets){const own=rows.filter(r=>r.uid===t.uid),items=own.filter(r=>r.type==='item');if(!own.length)errors.push(t.name+'没有要发放的项目');if(new Set(items.map(r=>r.ref)).size>25||items.reduce((n,r)=>n+r.quantity,0)>100)errors.push(t.name+'最多25种、100件物品');for(const r of own){const cap=r.type==='xp'?1e9:['points','tickets','coupon'].includes(r.type)?1e5:['skill','checkskill'].includes(r.type)?1:100;if(!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>cap)errors.push((t.name||'角色')+'的'+(grantTypes[r.type]||'项目')+'数量无效');}}
 return [...new Set(errors)];
}
export function grantPreset(name,entries){return {name:String(name).trim().slice(0,80),entries:entries.map(e=>({type:e.type,ref:e.ref||'',name:e.name,quantity:Number(e.quantity),rarity:e.rarity,kind:e.kind})).filter(e=>grantTypes[e.type])};}
export function grantOutcome(value,targets){const result=value?.status==='committed'?value.result:value;if(!Array.isArray(result)||!result.length||!result.every(r=>typeof r.success==='boolean'&&r.uid))return null;const ids=new Set(targets.map(t=>t.uid));return result.filter(r=>ids.has(r.uid)).map(r=>({...r,name:r.name||targets.find(t=>t.uid===r.uid)?.name||'角色'}));}
