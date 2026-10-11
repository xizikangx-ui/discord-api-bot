'use strict';
const G=require('../rpg/gm-service'),S=require('./security');
const definitions={
  core:{fields:['player','draft','roster','skills','historicalDeathIds'],sources:['players','characterDrafts','skillTemplates','deaths']},
  bag:{fields:['offers','coupons'],sources:['offers','couponPools','catalog']},
  battle:{fields:['battles','corpses'],sources:['battles','corpses','players']},
  explore:{fields:['maps'],sources:['explorations','players','battles']},
  activities:{fields:['checks','sessions','glossary','texts'],sources:['checks','sessions','glossaryTerms','config']},
  history:{fields:['actionDrafts','actionHistory'],sources:['forms']},
  management:{fields:[],sources:[...new Set(Object.values(G.KINDS)), 'config','players','battles','explorations']},
};
function parse(value){if(value==null)return null;const names=[...new Set(String(value).split(','))];S.ok(names.length&&names.every(k=>definitions[k]),'数据分区无效。');return names;}
function changed(before,next){const sources=new Set(Object.values(definitions).flatMap(d=>d.sources));const dirty=new Set([...sources].filter(k=>G.fingerprint(before[k])!==G.fingerprint(next[k])));return Object.keys(definitions).filter(k=>definitions[k].sources.some(s=>dirty.has(s)));}
function fields(names){return [...new Set(['revision',...names.flatMap(k=>definitions[k].fields)])];}
function sources(names){return [...new Set(['players','characterDrafts',...names.flatMap(k=>definitions[k].sources)])];}
module.exports={definitions,parse,changed,fields,sources};
