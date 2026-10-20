'use strict';
const Sections=require('./game-sections');
function forCommand(command,requested,changed){
 const asked=Sections.parse(requested||'dashboard,core,battle,explore,bag');
 const mandatory=command==='grant'?['core','dashboard']:command.startsWith('battle.')?['core','dashboard','battle']:['core'];
 const relevant=(
  command==='grant'?['core','dashboard','bag']:
  command.startsWith('market.')?['core','dashboard','market']:
  command.startsWith('templates.')?['core','activities','management','market']:
  command.startsWith('battle.')?['core','dashboard','battle','bag','explore']:
  command.startsWith('map.')?['core','dashboard','explore','battle','bag']:
  command.startsWith('world.')?['core','dashboard','world','bag']:
  command.startsWith('character.')?['core','dashboard','bag','battle']:asked);
 const affected=changed||relevant;
 return [...new Set([...mandatory.filter(s=>asked.includes(s)),...asked.filter(s=>affected.includes(s)&&relevant.includes(s))])];
}
module.exports={forCommand};
