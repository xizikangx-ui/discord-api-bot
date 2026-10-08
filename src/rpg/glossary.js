'use strict';
const C=require('./constants');
function publish(s,raw,id,baseVersion=0) {
  const name=C.text(raw.name,'名词',80),description=C.text(raw.description,'解释',4000);
  s.glossaryTerms||={};C.requireThat((s.glossaryTerms[id]?.version||0)===baseVersion,'该名词已更新，请重新编辑。');
  C.requireThat(!Object.values(s.glossaryTerms).some(t=>t.id!==id&&t.name.normalize('NFKC').toLowerCase()===name.normalize('NFKC').toLowerCase()),'名词名称已存在，请编辑已有条目。');
  const t={id:id||C.id('g'),version:baseVersion+1,name,description,published:true};s.glossaryTerms[t.id]=t;return t;
}
function search(s,q='',gm=false) {q=String(q).normalize('NFKC').toLowerCase();return Object.values(s.glossaryTerms||{}).filter(t=>(gm||t.published)&&(t.name+' '+t.description).normalize('NFKC').toLowerCase().includes(q));}
module.exports={publish,search};
