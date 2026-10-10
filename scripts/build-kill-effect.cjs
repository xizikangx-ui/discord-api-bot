'use strict';
// Offline asset build only. Runtime serves this GIF without invoking render workers.
const sharp=require('sharp'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const width=400,height=240,frames=[];
 for(let n=0;n<12;n++){
  const progress=n/11,fade=Math.sin(Math.PI*progress),radius=25+progress*95;
  const rays=Array.from({length:16},(_,k)=>{const a=k*Math.PI/8,inner=radius*.7,outer=radius+28*fade;return `<path d="M${200+Math.cos(a)*inner} ${120+Math.sin(a)*inner}L${200+Math.cos(a)*outer} ${120+Math.sin(a)*outer}"/>`;}).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><g opacity="${fade}" fill="none" stroke="#ffcc65" stroke-width="3"><circle cx="200" cy="120" r="${radius}"/><circle cx="200" cy="120" r="${radius*.7}" stroke="#ff4969"/><g>${rays}</g><path d="M172 93L228 149M228 93L172 149" stroke="#ff607b" stroke-width="7"/><path d="M200 67L248 120L200 173L152 120Z"/></g></svg>`;
  frames.push(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
 }
 const result=await sharp(Buffer.concat(frames),{raw:{width,height:height*frames.length,channels:4,pageHeight:height}}).gif({loop:1,delay:Array(12).fill(165),colours:64,dither:0}).toBuffer();
 if(result.length>512*1024)throw Error('GIF exceeds asset budget');
 const target=path.resolve(__dirname,'../web/public/effects/kill-v1.gif');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,result);
 console.log(JSON.stringify({bytes:result.length,frames:12,durationMs:1980,loop:1}));
})();
