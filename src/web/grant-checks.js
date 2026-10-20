'use strict';
const G=require('../rpg/gm-service'),S=require('./security');
async function checks(s,group,rows,expected,accounts){
 S.ok(rows.length>0&&rows.length<=625,'发放清单须为1—625项。');
 const grouped=new Map();for(const row of rows){S.ok(typeof row.uid==='string'&&row.uid.length<=150,'请选择有效收件角色。');const list=grouped.get(row.uid)||[];list.push(row);grouped.set(row.uid,list);}S.ok(grouped.size<=25,'一次最多25名角色。');
 const rejected=Object.create(null);await Promise.all([...grouped].map(async([uid,list])=>{try{
  await accounts.member(group,uid);
  const guards=G.guards(s,'grant',{rows:list});
  const conflicts=guards.filter(g=>expected[g.source+':'+(g.id||'')]!==g.hash);
  if(conflicts.length)rejected[uid]='角色、发放项目或配置已变化，本角色未发放；已保留清单，请刷新后再提交。';
 }catch(e){rejected[uid]=e.code==='FORBIDDEN'||e.code==='NOT_FOUND'?'该成员已不属于本团，本角色未发放。':e.message;}}));
 return rejected;
}
module.exports={checks};
