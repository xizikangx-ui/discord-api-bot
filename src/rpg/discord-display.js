'use strict';
const U=require('./ui');
function grid(d) {
  const battle=d.kind==='battle',m=battle?d.b:d.m;
  if(!m)return '';
  const width=battle?m.width:m.width,height=battle?m.height:m.floors;
  const at=new Map();
  if(battle)m.actors.forEach((a,n)=>{const k=Math.floor(a.x/50)+','+Math.floor(a.y/50);at.set(k,at.has(k)?'多人':String(n+1).padStart(2,'0'));});
  const lines=[];
  for(let y=0;y<height;y++) {
    const cells=[];
    for(let x=0;x<width;x++) {
      const ref=x+','+y,c=m.cells?.[ref];
      const hidden=!d.full&&(!m.revealed?.[ref]||(require('./rp').waiting(m)&&m.rps[m.rpPendingId].cell===ref));
      cells.push(battle?at.get(ref)||({blocked:'■■',difficult:'≈≈'}[m.terrain[ref]]||'··'):
        !c?'  ':hidden?'??':Object.values(m.participants).some(p=>p.cell===ref)?'队':({wall:'■',stairs:'↕',entrance:'入',room:'房',corridor:'·',road:'路',forest:'林',water:'水',building:'楼'}[c.type]||'地'));
    }
    const line=(y+1)+' '+cells.join(' ');
    if(lines.join('\n').length+line.length>850){lines.push('… 大图可查看完整布局');break;}
    lines.push(line);
  }
  return '```\n'+lines.join('\n')+'\n```\n每行从左至右为列；?? 未揭示；战场数字对应参战者编号。';
}
function textView(result) {
  const v={...result},d=v.rpgMap,portraits=v.rpgPortraits;
  delete v.rpgMap;delete v.rpgPortraits;delete v.rpgImageRequested;
  if(d||portraits) {
    v.embeds=(v.embeds||[]).map(e=>U.D.EmbedBuilder.from(e).setImage(null).setThumbnail(null));
    v.files=[];v.attachments=[];
  }
  if(d&&['battle','exploration'].includes(d.kind)&&v.embeds?.[0])v.embeds[0].addFields({name:'文字地图',value:grid(d)});
  let route;
  if(d?.kind==='battle'&&d.b.status!=='ended')route='picture:battle:'+d.b.id;
  if(d?.kind==='personal')route='picture:personal:'+d.b.id+':'+d.a.id;
  if(d?.kind==='exploration')route='map:mapview:'+d.m.id+':portrait'+(d.full?':gm':'');
  if(portraits&&!d&&v.rpgCharacter)route='picture:character:'+v.rpgCharacter.userId+':'+v.rpgCharacter.id;
  if(route) {
    v.components=[...(v.components||[])];
    const button=U.button(route,'查看图片');
    // Never exceed Discord's five rows or five buttons per row.
    const last=v.components.at(-1);
    if(last?.components?.length<5&&last.components.every(c=>(c.data?.type||c.type)===2))v.components[v.components.length-1]=U.D.ActionRowBuilder.from(last).addComponents(button);
    else if(v.components.length<5)v.components.push(U.row(button));
  }
  delete v.rpgCharacter;
  return v;
}
module.exports={textView,grid};
