'use strict';
// Pure visual motion. Saved dice, coordinates and outcomes are never modified.
function motion(kind,x,y,color,p){const pulse=Math.sin(p*Math.PI),a=8*p;
 const path=(d,width=4)=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
 const box=(bx,by,w,h)=>`<rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="4" fill="#26393c" stroke="${color}" stroke-width="3"/>`;
 if(kind==='reload')return box(x-13,y-42,26,35)+box(x-11,y+9-a,22,32)+path(`M${x} ${y+8-a}v-14m-6 5l6-6 6 6`);
 if(kind==='switch')return `<g transform="rotate(${pulse*12},${x},${y})">`+path(`M${x-31} ${y+30}L${x+28} ${y-29}m-40 3l15 15M${x+31} ${y+30}L${x-28} ${y-29}m40 3l-15 15`)+`</g>`;
 if(kind==='item')return box(x-27,y-29,54,58)+path(`M${x-15} ${y}h30M${x} ${y-15}v30`,7)+`<circle cx="${x}" cy="${y}" r="${36+pulse*8}" fill="none" stroke="${color}" opacity=".3"/>`;
 if(kind==='result')return path(`M${x} ${y-37}l29 12v22q0 20-29 36q-29-16-29-36v-22Z`)+path(`M${x-12} ${y}l9 10 18-24`);
 if(kind==='pass')return `<circle cx="${x}" cy="${y}" r="31" fill="none" stroke="${color}" stroke-width="4"/>`+path(`M${x-22} ${y+22}l44-44`);
 if(kind==='finish')return path(`M${x-27} ${y}l18 19 40-41`,7)+path(`M${x-34} ${y+36}h68`,2);
 if(kind==='flee')return box(x-35,y-34,30,68)+path(`M${x-10+a} ${y}h45m-13-13l13 13-13 13`,5);
 if(kind==='death')return `<circle cx="${x}" cy="${y-6}" r="27" fill="#26393c" stroke="${color}" stroke-width="3"/><circle cx="${x-10}" cy="${y-7}" r="7" fill="${color}"/><circle cx="${x+10}" cy="${y-7}" r="7" fill="${color}"/>`+path(`M${x-12} ${y+21}v12h24v-12M${x-32} ${y+37}l64-10m-64 0l64 10`,3);
 if(kind==='attack')return path(`M${x-43} ${y+28}l${70+10*p} -${45+10*p}`,5)+path(`M${x+5} ${y-31}l15-14m-2 31h25m-33-3l11 15`,3);
 return '';
}
module.exports={motion};
