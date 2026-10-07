'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {Resvg}=require('@resvg/resvg-js');
const png=new Resvg(workerData.svg,{font:{fontFiles:[workerData.font],loadSystemFonts:false,defaultFontFamily:'Noto Sans CJK SC'}}).render().asPng();
parentPort.postMessage(png);
