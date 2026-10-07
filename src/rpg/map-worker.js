'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {Resvg}=require('@resvg/resvg-js');
const font={fontFiles:[workerData.font],loadSystemFonts:false,defaultFontFamily:'Noto Sans CJK SC'};
parentPort.on('message',({id,svg})=>{try{const png=new Resvg(svg,{font}).render().asPng();parentPort.postMessage({id,png});}catch{parentPort.postMessage({id,error:'地图渲染失败'});}});
