'use strict';
const damageTypes=damage=>Object.keys(damage||{}).filter(k=>Number(damage[k])!==0&&String(damage[k]).trim()!=='');
function maxRoll(roll){if(!roll?.rolls?.length)return {dice:0,max:true};const faces=Number(String(roll.expression).match(/d(\d+)/)?.[1]);return {dice:roll.rolls.length,max:Number.isFinite(faces)&&roll.rolls.every(r=>r.chosen===faces)};}
function shotMax(shot){let dice=0,max=true;for(const roll of Object.values(shot.rolls||{}))for(const part of [roll,roll.ammunition]){const v=maxRoll(part);dice+=v.dice;max&&=v.max;}return dice>0&&max;}
function feedback(e,section={}){const d=e.details||{},child=section.child,result=child?.result||(!d.children?d.results?.[0]:null)||((['result','death'].includes(e.type))?d:null),shots=child?.shots||d.shots||[];
 const start=(section.shotPage||0)*4,killed=!!result?.killed&&!!result?.deathId,full=!result?.dodge?.success&&!!result&&shots.slice(start,start+4).some((s,n)=>result.perShot?.[start+n]?.maxRoll??false);
 return {killed,full,result,shots,kind:d.presentation?.kind||e.type,damageTypes:d.presentation?.damageTypes||Object.keys(d.breakdown||d.damage||{}),rp:e.rpEntries||[]};}
function message(e,f=feedback(e)) {if(e.type==='attack'&&f.result)return (e.actorName||'攻击者')+'使用'+(e.details.ability||'攻击')+' → '+(f.result.target||'目标')+'，'+(f.result.dodge?.success?'闪避成功。':'已结算 '+f.result.total+' 伤害。');return e.message;}
module.exports={damageTypes,maxRoll,shotMax,feedback,message};
