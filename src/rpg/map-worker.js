'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {Resvg}=require('@resvg/resvg-js'),sharp=require('sharp');
const font={fontFiles:[workerData.font],loadSystemFonts:false,defaultFontFamily:'Noto Sans CJK SC'};
const png=svg=>new Resvg(svg,{font}).render().asPng();
parentPort.on('message',async({id,svg,options={}})=>{let first;try{if(options.format!=='gif'){parentPort.postMessage({id,png:png(svg)});return;}const frames=svg.map(png);first=frames[0];
 let result;for(const count of [12,8,6]){const width=count===6?(options.width===960?640:480):options.width;const selected=await Promise.all(Array.from({length:count},(_,n)=>sharp(frames[Math.round(n*(frames.length-1)/(count-1))]).resize({width}).png().toBuffer()));result=await sharp(selected,{join:{animated:true}}).gif({effort:1,colours:128,dither:.25,interPaletteMaxError:8,loop:1,delay:Array.from({length:count},(_,n)=>n===count-1?700:Math.round(1100/(count-1)/10)*10)}).toBuffer();if(result.length<=2*1024*1024)break;}
 parentPort.postMessage({id,png:result.length<=2*1024*1024?result:first});
 }catch{try{parentPort.postMessage({id,png:first||png(Array.isArray(svg)?svg[0]:svg)});}catch{parentPort.postMessage({id,error:'地图渲染失败'});}}});
