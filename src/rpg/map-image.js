'use strict';
// Small dependency-free PNG renderer. Game state remains the source of truth.
const zlib=require('node:zlib');
const FONT={A:['010','101','111','101','101'],B:['110','101','110','101','110'],C:['011','100','100','100','011'],D:['110','101','101','101','110'],E:['111','100','110','100','111'],F:['111','100','110','100','100'],G:['011','100','101','101','011'],H:['101','101','111','101','101'],I:['111','010','010','010','111'],L:['100','100','100','100','111'],M:['101','111','111','101','101'],N:['101','111','111','111','101'],O:['010','101','101','101','010'],P:['110','101','110','100','100'],R:['110','101','110','101','101'],S:['011','100','010','001','110'],T:['111','010','010','010','010'],U:['101','101','101','101','111'],V:['101','101','101','101','010'],W:['101','101','111','111','101'],X:['101','101','010','101','101'],Y:['101','101','010','010','010'],Z:['111','001','010','100','111'],0:['111','101','101','101','111'],1:['010','110','010','010','111'],2:['110','001','010','100','111'],3:['110','001','010','001','110'],4:['101','101','111','001','001'],5:['111','100','110','001','110'],6:['011','100','111','101','111'],7:['111','001','010','010','010'],8:['111','101','111','101','111'],9:['111','101','111','001','110'],'-':['000','000','111','000','000']};
const PALETTE={bg:[14,20,33],panel:[23,33,49],grid:[40,55,75],normal:[29,43,61],difficult:[109,76,34],blocked:[57,61,71],room:[46,99,105],corridor:[42,62,86],stairs:[119,85,168],entrance:[39,128,105],wall:[64,66,77],fog:[25,29,42],white:[228,237,248],ally:[69,163,238],enemy:[236,93,101],current:[255,215,90],hp:[63,196,134]};
function canvas(width,height){const data=Buffer.alloc(width*height*3);const put=(x,y,c)=>{x=Math.floor(x);y=Math.floor(y);if(x<0||y<0||x>=width||y>=height)return;const n=(y*width+x)*3;data[n]=c[0];data[n+1]=c[1];data[n+2]=c[2];};
  const rect=(x,y,w,h,c)=>{for(let j=Math.floor(y);j<y+h;j++)for(let i=Math.floor(x);i<x+w;i++)put(i,j,c);};
  const circle=(x,y,r,c)=>{for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(i*i+j*j<=r*r)put(x+i,y+j,c);};
  const text=(s,x,y,c=PALETTE.white,scale=2)=>{for(const char of String(s).toUpperCase()){const glyph=FONT[char];if(glyph)glyph.forEach((row,j)=>[...row].forEach((bit,i)=>{if(bit==='1')rect(x+i*scale,y+j*scale,scale,scale,c);}));x+=4*scale;}};
  rect(0,0,width,height,PALETTE.bg);return {width,height,data,put,rect,circle,text};
}
const TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc(b){let c=0xffffffff;for(const v of b)c=TABLE[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(name,data){const t=Buffer.from(name),body=Buffer.concat([t,data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(body));return Buffer.concat([head,body,tail]);}
function png(c){const header=Buffer.alloc(13);header.writeUInt32BE(c.width);header.writeUInt32BE(c.height,4);header[8]=8;header[9]=2;const scan=Buffer.alloc((c.width*3+1)*c.height);for(let y=0;y<c.height;y++)c.data.copy(scan,y*(c.width*3+1)+1,y*c.width*3,(y+1)*c.width*3);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);}
function battle(state,b){const size=Math.max(24,Math.min(48,Math.floor(720/Math.max(b.width,b.height)))),left=38,top=62,c=canvas(b.width*size+62,b.height*size+107);
  c.text('BATTLE MAP',22,19,PALETTE.white,3);c.rect(22,43,c.width-44,2,PALETTE.current);
  for(let y=0;y<b.height;y++){c.text(y+1,9,top+y*size+size/2-5,PALETTE.white,1);for(let x=0;x<b.width;x++){if(!y)c.text(x+1,left+x*size+size/2-5,top-12,PALETTE.white,1);c.rect(left+x*size,top+y*size,size-2,size-2,PALETTE[b.terrain[x+','+y]||'normal']);}}
  const taken={};b.actors.forEach((a,n)=>{if(a.retreated||a.deathId)return;const p=require('./combat').actorCharacter(state,a),cell=Math.floor(a.x/50)+','+Math.floor(a.y/50),index=taken[cell]||0;taken[cell]=index+1;
    const cx=left+a.x/50*size+(index%3-1)*3,cy=top+a.y/50*size+Math.floor(index/3)*4,r=Math.max(7,Math.floor(size*.23));
    c.circle(cx,cy,r+2,a.id===b.current?.actorId?PALETTE.current:PALETTE.grid);c.circle(cx,cy,r,PALETTE[a.team==='ally'?'ally':'enemy']);c.text(n+1,cx-(n>=9?4:2),cy-3,PALETTE.white,1);
    const ratio=Math.max(0,Math.min(1,p.hp/require('./model').stats(p).maxHP));c.rect(cx-r,cy+r+4,r*2,3,PALETTE.blocked);c.rect(cx-r,cy+r+4,r*2*ratio,3,PALETTE.hp);
  });c.text('BLUE ALLY   RED ENEMY   GOLD CURRENT',22,c.height-23,PALETTE.white,1);return png(c);
}
function exploration(m,full=false,floor=null){const size=Math.max(25,Math.min(46,Math.floor(720/m.width))),levels=floor===null?Array.from({length:m.floors},(_,n)=>m.floors-1-n):[Math.max(0,Math.min(Number(floor)||0,m.floors-1))],left=48,top=65,c=canvas(m.width*size+72,levels.length*size+112);
  c.text('EXPLORATION',22,19,PALETTE.white,3);c.rect(22,43,c.width-44,2,PALETTE.ally);
  levels.forEach((y,row)=>{c.text((y+1)+'F',8,top+row*size+size/2-5,PALETTE.white,2);for(let x=0;x<m.width;x++){const ref=x+','+y,cell=m.cells[ref],seen=full||m.revealed[ref],px=left+x*size,py=top+row*size;
    c.rect(px,py,size-3,size-3,seen&&cell?PALETTE[cell.type]:PALETTE.fog);if(!row)c.text(x+1,px+size/2-3,top-12,PALETTE.white,1);
    if(!seen){c.text('-',px+size/2-3,py+size/2,PALETTE.grid,2);continue;}
    if(cell?.type==='stairs')c.text('UP',px+size/2-7,py+size/2-5,PALETTE.white,1);
    if(cell?.type==='entrance')c.text('IN',px+size/2-7,py+size/2-5,PALETTE.white,1);
    if(cell?.room?.encounter!=='resolved'&&cell?.room)c.circle(px+size-9,py+8,3,PALETTE.enemy);
    const members=Object.values(m.participants).filter(p=>p.cell===ref);if(members.length){c.circle(px+size/2,py+size/2,Math.max(8,size*.22),PALETTE.ally);c.text(members.length,px+size/2-3,py+size/2-4,PALETTE.white,1);}
  }});c.text('TEAM BLUE   ROOM TEAL   STAIRS PURPLE',22,c.height-24,PALETTE.white,1);return png(c);
}
function attach(v,buffer,name){v.files=[...(v.files||[]),{attachment:buffer,name}];v.attachments=[];v.embeds[0].setImage('attachment://'+name);return v;}
module.exports={battle,exploration,attach};
