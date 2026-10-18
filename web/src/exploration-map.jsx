import React from 'react';
import {boardCells,tileView,shortPosition} from './exploration-state';

function Trees(){return <g fill="#718c80" stroke="#adc2a8" strokeWidth="1.4"><path d="M46 28L25 68H67ZM46 52L18 91H74Z"/><path d="M104 44L85 78H123ZM104 66L80 104H128Z"/><path d="M46 91V112M104 104V119" fill="none" stroke="#536d69" strokeWidth="5"/></g>;}
function Building({ruin=false}){return <g stroke="#adbed0" strokeWidth="2" fill="#52627e"><path d={ruin?'M33 111V45H66L73 62H96V37H126V111Z':'M30 111V52L80 27L130 52V111Z'}/>{!ruin&&<path d="M24 53L80 23L136 53" fill="none" stroke="#c2c0de" strokeWidth="4"/>}<path d="M50 66H66V81H50ZM95 66H111V81H95Z" fill="#9bbdc7"/><path d="M72 111V87H89V111" fill="#283951"/>{ruin&&<path d="M39 112L53 95L58 111M113 51L99 69L108 81L96 97" fill="none" stroke="#283a53" strokeWidth="4"/>}</g>;}
function Furniture({name=''}){
 if(/医|药|病|急救/.test(name))return <g stroke="#91a6bc" strokeWidth="2"><rect x="30" y="44" width="28" height="52" rx="3" fill="#617388"/><path d="M31 58H57M39 44V39M50 44V39"/><rect x="91" y="45" width="35" height="49" rx="3" fill="#33475f"/><path d="M100 68H117M108 60V76" stroke="#a7d1cb" strokeWidth="5"/></g>;
 if(/机|实验|控制|设备/.test(name))return <g stroke="#8c9cb5" strokeWidth="2">{[35,68,101].map(x=><g key={x}><rect x={x} y="43" width="24" height="51" rx="2" fill="#34465c"/><path d={'M'+(x+5)+' 55h14m-14 9h14m-14 9h14m-14 9h14'}/><circle cx={x+17} cy="89" r="2" fill="#98c6c0"/></g>)}</g>;
 return <g stroke="#9cabc0" strokeWidth="2"><rect x="35" y="42" width="28" height="58" rx="2" fill="#45566d"/><path d="M36 56H62M36 71H62M36 85H62"/><rect x="88" y="53" width="37" height="30" rx="3" fill="#60708a"/><path d="M94 89V98M118 89V98M94 46V39M118 46V39" strokeWidth="5"/><path d="M95 58h22m-22 7h15" stroke="#b3bdcb" strokeWidth="1"/></g>;
}
export function TerrainGlyph({tile,region=false}){
 const type=tile.type;
 if(tile.hidden||type==='fog')return <svg className="explore-terrain" viewBox="0 0 160 140" aria-hidden="true"><path d="M5 17Q45 1 80 15Q119 0 155 17V124Q118 111 80 127Q39 112 5 124Z" fill="#1a2844" stroke="#465673"/><path d="M20 93Q44 43 79 74T143 47M20 107Q66 65 100 97T153 66" fill="none" stroke="#7582a3" strokeWidth="15" opacity=".08"/><path d="M80 38L87 60L109 68L87 76L80 99L73 76L51 68L73 60Z" fill="none" stroke="#8992b6" opacity=".55"/><circle cx="80" cy="68" r="7" fill="#919cc2" opacity=".4"/><path d="M30 37h4m-2-2v4M122 104h4m-2-2v4" stroke="#98acd0"/></svg>;
 const regional=region&&type!=='entrance',floor=type==='wall'?'#28354a':regional?'#2b4650':'#3b4960',roadPath=(tile.connections||[]).map(d=>({north:'M80 70L80 5',south:'M80 70L80 135',west:'M80 70L5 70',east:'M80 70L155 70'})[d]).filter(Boolean).join(' ')||'M80 45V95';
 return <svg className="explore-terrain" viewBox="0 0 160 140" aria-hidden="true">
  <path d="M5 17L80 5L155 17V124L80 136L5 124Z" fill={floor} stroke={regional?'#58716f':'#8291aa'} strokeWidth="1.5"/>
  {regional?<g opacity=".22" stroke="#acbfae" strokeWidth="1"><path d="M10 112L61 25M36 128L93 12M81 132L135 23M9 45L143 102M7 79L115 128"/></g>:<g fill="none" stroke="#9ca9bc" strokeWidth=".8" opacity=".2"><path d="M14 42H146M14 68H146M14 94H146M39 23V118M66 23V125M94 23V125M121 23V118"/></g>}
  {type==='wall'?<g stroke="#75829c" strokeWidth="2" fill="#46516a"><path d="M13 31H70V56H13ZM75 31H146V56H75ZM13 61H45V87H13ZM50 61H113V87H50ZM118 61H146V87H118ZM13 92H82V117H13ZM87 92H146V117H87Z"/><path d="M37 31L56 56M82 61L100 87M116 92L129 117" stroke="#2c384d"/></g>:
   type==='forest'?<Trees/>:
   type==='water'?<g fill="none" stroke="#8fb9cf" strokeWidth="3" opacity=".85"><path d="M21 51q15-12 30 0t30 0t30 0t28 0M15 75q15-12 30 0t30 0t30 0t30 0M26 99q15-12 30 0t30 0t30 0"/></g>:
   type==='mountain'?<g stroke="#bdc8d7" strokeWidth="2"><path d="M19 111L65 32L91 77L109 48L144 111Z" fill="#66768b"/><path d="M48 61L65 32L83 63L66 55ZM95 72L109 48L125 76L109 68Z" fill="#ccd5dd"/><path d="M65 60L54 111M109 72L118 111" fill="none" opacity=".5"/></g>:
   type==='building'?<Building/>:
   type==='ruins'?<Building ruin/>:
   type==='landmark'?<g fill="none" stroke="#d2c397" strokeWidth="2"><ellipse cx="80" cy="107" rx="42" ry="13"/><path d="M65 103V54L80 25L95 54V103ZM65 54H95M80 25V103" fill="#827f8b"/><path d="M37 91L47 69M119 93L111 75"/></g>:
   type==='road'?<g fill="none"><path d={roadPath} stroke="#596878" strokeWidth="22"/><path d={roadPath} stroke="#b3baad" strokeWidth="1.5" strokeDasharray="6 8"/><circle cx="80" cy="70" r="17" fill="#596878" stroke="#b3baad" strokeWidth="1"/></g>:
   type==='wild'?<g fill="none" stroke="#a1b39a" strokeWidth="2"><path d="M19 103q25-24 47-5t74-8M30 67l-5-9m5 9l4-13M107 52l-5-9m5 9l4-13M116 111l-5-9m5 9l4-13M66 82l-5-9m5 9l4-13"/><ellipse cx="60" cy="45" rx="11" ry="6" fill="#657974"/></g>:
   type==='stairs'?<g fill="none" stroke="#c9c4dd" strokeWidth="3"><path d="M40 105H55V92H70V79H85V66H100V53H116V39M39 117H128M35 31H121"/><path d="M102 29H124V51M124 29L95 58" stroke="#aca0d3"/></g>:
   type==='entrance'?<g stroke="#c4cbd9" strokeWidth="3" fill="none"><path d="M45 116V47Q80 12 115 47V116M55 116V51Q80 26 105 51V116"/><path d="M61 99L91 69M72 68H92V88" stroke="#c7c69e"/><path d="M37 120H123"/></g>:
   type==='corridor'?<g stroke="#8f9fb8" fill="none" opacity=".8"><path d="M19 50H141M19 93H141" strokeWidth="3"/><path d="M33 69h15m13 0h15m13 0h15m13 0h11" strokeDasharray="2 3" strokeWidth="2"/></g>:<Furniture name={tile.name}/>
  }
  {!regional&&type!=='wall'&&<g fill="#29394f" stroke="#a4b1c4" strokeWidth="1.4">{tile.connections?.includes('west')&&<path d="M3 58H17V83H3Z"/>}{tile.connections?.includes('east')&&<path d="M143 58H157V83H143Z"/>}</g>}
  {tile.locked&&<g transform="translate(126 27)" stroke="#dbc69b" fill="#33435b" strokeWidth="2"><rect x="-9" y="0" width="18" height="16" rx="3"/><path d="M-5 0V-6a5 5 0 0 1 10 0V0"/></g>}
 </svg>;
}
export function ExplorationBoard({map,userId,roster=[],floor=0,selected,onSelect,zoom=1,fit=false,viewportRef}){
 const cells=boardCells(map,floor),columns=Number(map.width)||1;
 return <div className={'explore-chart '+(fit?'is-overview':'')} ref={viewportRef} tabIndex="0" aria-label={map.mapType==='region'?'区域地图，可滚动查看':'第'+(floor+1)+'层地图，可横向滚动查看'}>
  <div className="explore-grid" style={{gridTemplateColumns:'repeat('+columns+',minmax(0,1fr))',width:fit?'100%':columns*Math.round((map.mapType==='region'?124:156)*zoom)+'px'}}>
   {cells.map(({ref,cell})=>{if(!cell)return <div className="explore-void" key={ref} aria-hidden="true"/>;const tile=tileView(map,ref,userId,roster),reachable=map.neighbors?.includes(ref),selectedHere=selected===ref;
    return <button type="button" key={ref} data-map-cell={ref} data-current={tile.here||undefined} data-hidden={tile.hidden||undefined} className={'explore-tile terrain-'+tile.type+(selectedHere?' is-selected':'')+(tile.here?' is-current':'')+(reachable?' is-reachable':'')+(tile.blocked?' is-blocked':'')} aria-label={tile.name+(tile.here?'，当前位置':'')+(reachable?'，相邻可达':'')+(tile.blocked?'，不可通行':'')} aria-pressed={selectedHere} onClick={()=>onSelect(ref)}>
     <TerrainGlyph tile={tile} region={map.mapType==='region'}/>
     <span className="explore-tile-label"><b>{tile.name}</b>{!fit&&<small>{tile.here?'当前位置':reachable?'相邻可达':tile.hidden?'等待探索':tile.blocked?'不可通行':tile.merchant?'行商驻地':tile.typeName}</small>}</span>
     {tile.here&&<span className="explore-here-mark" aria-hidden="true">◆</span>}
     {!tile.hidden&&tile.party.length>0&&<span className="explore-party" aria-label={'在此处：'+tile.party.map(p=>p.name).join('、')}>{tile.party.slice(0,3).map(p=><i key={p.userId} className={p.self?'self':''} title={p.name}>{p.name.slice(0,1)}</i>)}{tile.party.length>3&&<i>+{tile.party.length-3}</i>}</span>}
     <span className="explore-cell-position">{!tile.hidden&&shortPosition(map,ref)}</span>
    </button>;
   })}
  </div>
 </div>;
}
