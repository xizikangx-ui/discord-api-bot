'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),M=require('../src/rpg/model');
test('direct GM grant isolates stale recipients, recovers one receipt, and never waits for supplemental reads to succeed',async t=>{
 const h=await require('./helpers/chat-website.cjs').launch();t.after(()=>h.app.stop());const group=h.group.id,prefix='/groups/'+group;
 await h.app.games.store.transact(group,'grant-fixture',h.user.id,s=>{const p=M.newCharacter('发放测试 GM',{strength:5,constitution:5,mind:5,appearance:5,intelligence:5,agility:5,knowledge:5});p.userId=h.user.id;s.players[p.userId]=p;return true;});
 const view=await h.request(h.admin,prefix+'/game?sections=management,core'),s=h.app.games.store.snapshot(group),rows=[h.user.id,h.player.user.id].map(uid=>({uid,characterId:s.players[uid].id,type:'points',quantity:3}));
 await h.app.games.store.transact(group,'grant-version-change',h.user.id,s=>{s.players[h.player.user.id].points++;return true;});
 const op=crypto.randomUUID(),body={operationId:op,command:'grant',params:{rows},versions:view.data.versions,includePatch:true,sections:'dashboard,core,battle,explore,bag'};
 const first=await h.request(h.admin,prefix+'/gm/execute',body);assert.equal(first.status,200,JSON.stringify(first.error));assert.equal(first.data.result[0].success,true);assert.equal(first.data.result[1].success,false);assert.match(first.data.result[1].reason,/变化/);assert.ok(first.data.gamePatch.sections.includes('core'));assert.ok(!first.data.gamePatch.sections.includes('explore'));
 const before=h.app.games.store.snapshot(group).players;assert.equal(before[h.user.id].points,s.players[h.user.id].points+3);assert.equal(before[h.player.user.id].points,s.players[h.player.user.id].points+1);
 const duplicate=await h.request(h.admin,prefix+'/gm/execute',body),receipt=await h.request(h.admin,prefix+'/game/operations/'+op);assert.deepEqual(duplicate.data.result,first.data.result);assert.deepEqual(receipt.data.result,first.data.result);assert.deepEqual(h.app.games.store.snapshot(group).players,before);
 const latest=await h.request(h.admin,prefix+'/game?sections=core'),original=h.app.games.view;h.app.games.view=async()=>{throw Error('isolated read failure');};
 const saved=await h.request(h.admin,prefix+'/gm/execute',{...body,operationId:crypto.randomUUID(),params:{rows:[rows[1]]},versions:latest.data.versions});h.app.games.view=original;
 assert.equal(saved.status,200,JSON.stringify(saved.error));assert.equal(saved.data.status,'committed');assert.equal(saved.data.result[0].success,true);assert.equal(saved.data.gamePatch,undefined);assert.equal(h.app.games.store.snapshot(group).players[h.player.user.id].points,before[h.player.user.id].points+3);
});
