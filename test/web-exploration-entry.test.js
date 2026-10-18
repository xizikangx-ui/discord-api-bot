'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('exploration opens the current journey for the actual participating character, with explicit navigation taking priority',async()=>{
 const {initialExploreView:entry}=await import('../web/src/exploration-entry.js');
 const game={player:{id:'role-new',userId:'user'},maps:[{status:'active',participants:{user:{characterId:'role-new'}}}]};
 assert.equal(entry(game),'current');assert.equal(entry(game,{type:'world'}),'world');assert.equal(entry({maps:[]},{type:'map'}),'current');
 game.maps[0].status='paused';assert.equal(entry(game),'current');
 game.maps[0].status='ended';assert.equal(entry(game),'world');
 game.maps[0].status='active';game.maps[0].participants.user.characterId='old-role';assert.equal(entry(game),'world');
 assert.equal(entry({maps:[]}),'world');
});
