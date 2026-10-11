'use strict';
const {monitorEventLoopDelay}=require('node:perf_hooks');
function createMetrics(){const samples=new Map(),gauges=new Map();let timer,loop;
  const observe=(name,value)=>{const list=samples.get(name)||[];if(list.length<2000)list.push(Math.round(value));samples.set(name,list);};
  return {observe,gauge:(name,value)=>gauges.set(name,value),start:name=>{const time=performance.now();return()=>observe(name,performance.now()-time);},
    startReporting(pool){loop=monitorEventLoopDelay({resolution:20});loop.enable();timer=setInterval(()=>{const timings={};for(const [name,list] of samples){list.sort((a,b)=>a-b);timings[name]={n:list.length,p95:list[Math.max(0,Math.ceil(list.length*.95)-1)]};}console.log(JSON.stringify({type:'web-performance',rss:process.memoryUsage().rss,poolWaiting:pool?.waitingCount||0,eventLoopP95ms:Math.round(loop.percentile(95)/1e6),timings,gauges:Object.fromEntries(gauges)}));samples.clear();loop.reset();},60000);timer.unref();},
    stop(){clearInterval(timer);loop?.disable();}
  };
}
module.exports={createMetrics};
