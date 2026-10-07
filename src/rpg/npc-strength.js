'use strict';
const C=require('./constants'),LEVELS=['I','II','III','IV','V','VI','VII','VIII','IX','X'];
function validate(raw){const rank=raw.anomalyRank||'I',n=LEVELS.indexOf(rank);C.requireThat(n>=0,'异常等级须为I—X。');const low=n*10+1,high=(n+1)*10;const min=C.number(raw.levelMin??low,'最低等级',low,high),max=C.number(raw.levelMax??high,'最高等级',min,high);return {anomalyRank:rank,levelMin:min,levelMax:max,randomStrength:!!raw.randomStrength};}
function freeze(template,rng){if(template.spawnStrength)return C.clone(template);const t=C.clone(template),cfg=validate(t);Object.assign(t,cfg);if(!cfg.randomStrength)return t;const level=rng(cfg.levelMin,cfg.levelMax+1),scale=1+.05*(level-1);t.spawnStrength={level,scale,rank:cfg.anomalyRank,baseHP:t.hpMax};for(const [k,n]of Object.entries(t.attributes))if(n>0)t.attributes[k]=Math.ceil(n*scale);t.hpMax=Math.ceil(t.hpMax*scale);t.baseXP=Math.min(1000000000,(t.baseXP||0)*level);return t;}
function effects(template){const p=template.spawnStrength;if(!p)return [];return [{target:'hit',op:'add',value:Math.floor((p.level-1)/5)},...Object.keys(C.DAMAGE_TYPES).map(k=>({target:'attack:'+k,op:'percent',value:(p.scale-1)*100}))];}
function allowed(t,max=3){return LEVELS.indexOf(t.anomalyRank||'I')+1<=max;}
module.exports={LEVELS,validate,freeze,effects,allowed};
