'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/rpg/constants'),M=require('../src/rpg/model'),B=require('../src/rpg/combat'),Z=require('../src/rpg/conditions'),H=require('../src/rpg/health'),{state,fight,minRng}=require('./helpers/rpg-harness');
function apply(s,p,key,severity){const ref='core_condition_'+key;const result=B.applyCondition(s,p,{id:ref,severity},minRng);assert.equal(result.save.success,false);return result;}
test('condition pack installs nine stable templates, nineteen validated levels and never replaces local edits',()=>{
 const s=state();assert.equal(Z.templates().length,9);assert.equal(Z.templates().reduce((n,t)=>n+Object.keys(t.levels).length,0),19);
 for(const t of Z.templates())assert.deepEqual(B.validateCondition(t),t);
 s.conditionTemplates.core_condition_stun.name='自定义眩晕';delete s.conditionPackVersion;assert.deepEqual(Z.install(s),{conditionsAdded:0});assert.equal(s.conditionTemplates.core_condition_stun.name,'自定义眩晕');assert.equal(Z.install(s),null);
});
for(const key of ['bleeding','poison','burning','disease'])for(const [n,severity]of C.SEVERITIES.entries())test(`${key} ${severity}: one saved damage roll, no armor, duration and player downing`,()=>{
 const s=state(),p=s.players['1'];apply(s,p,key,severity);p.hp=M.stats(p).maxHP;const before=p.hp;const b=B.createBattle(s,'channel','GM','持续伤害'),a={id:'actor',userId:'1',name:p.name};b.actors=[a];let rolls=0;B.beginConditions(p,b,a,(lo,hi)=>{rolls++;return hi-1;},s);
 assert.equal(rolls,1);assert.equal(p.hp,before-[4,6,10][n]);assert.equal(b.history.at(-1).details.roll.total,[4,6,10][n]);B.endConditions(p,b,a,minRng);assert.equal(p.conditions[0].remaining,2);
 p.hp=1;B.beginConditions(p,b,a,minRng,s);assert.equal(H.snapshot(p).downed,true);assert.equal(p.life.reserveHP,M.stats(p).maxHP);assert.equal(a.deathId,undefined);
});
test('control rules reject real operations and NPC candidates; free defense and finish remain usable',()=>{
 for(const [key,severity,blocked]of [['stun','一般',['attack']],['stun','严重',['attack','move','switch','heal']],['arms','致命',['attack','switch']],['legs','致命',['move','flee']]]){
  const {s,b}=fight(),a=B.actorById(b,b.current.actorId),p=B.actorCharacter(s,a),turn=b.current.id;apply(s,p,key,severity);
  const ability=B.abilities(p).find(a=>a.attack.kind==='武器');
  for(const op of blocked){if(op==='attack')assert.throws(()=>B.attack(s,b,turn,ability.key,b.actors.find(x=>x.id!==a.id).id,'formal',minRng),/异常限制|不能主动/);else if(op==='move')assert.throws(()=>B.move(s,b,turn,a.x,a.y),/异常限制|不能主动/);else if(op==='switch')assert.throws(()=>B.switchWeapon(s,b,turn,ability.key),/异常限制|不能主动/);else if(op==='flee')assert.throws(()=>B.flee(s,b,turn,minRng),/异常限制/);else assert.throws(()=>B.validateOperation(s,b,{type:op,item:'missing'}),/不能主动/);}
  assert.equal(Z.reason(p,'defend'), '');assert.equal(Z.reason(p,'finish'),'');
  const options=require('../src/rpg/npc-auto').options(s,b,a);if(key==='stun'&&severity==='严重')assert.ok(options.every(op=>['pass','finish'].includes(op.type)));
  const panel=require('../src/web/game-service').playerView(s,a.userId).battles.find(x=>x.id===b.id);
  if(key==='stun'&&severity==='严重')assert.ok(panel.restrictions.attack);
  if(key==='arms')assert.ok(panel.restrictions.reload);
  if(key==='legs')assert.ok(panel.restrictions.flee);
  B.finish(s,b,turn,minRng);assert.ok(!b.pending);
 }
});
test('silence covers mixed damage and interruption; upper limb interrupts weapon-dependent casting',()=>{
 for(const [key,t]of [['silence',{primary:'physical',damage:{physical:'1d6',mental:'1'}}],['arms',{primary:'physical',requiresWeapon:true}]]){
  const {s,b}=fight(),a=B.actorById(b,b.current.actorId),p=B.actorCharacter(s,a);const skill=require('../src/rpg/skills').publish(s,{...require('../src/rpg/forms').defaults('skill'),name:'混合吟唱',hit:10,casting:2,...t});const learned=require('../src/rpg/skills').grant(p,skill);a.casting={key:learned.id,name:skill.name,count:1,required:2};apply(s,p,key,key==='arms'?'致命':'严重');assert.equal(a.casting,undefined);assert.ok(Z.reason(p,'attack',skill,'formal'));
 }
});
test('movement restrictions take the strictest multiplier and removal never refunds distance',()=>{
 const {s,b}=fight(),a=B.actorById(b,b.current.actorId),p=B.actorCharacter(s,a),base=M.stats(p).move;b.current.moveSpent=2;apply(s,p,'slow','一般');assert.equal(B.current(s,b,b.current.id).turn.move,base/2-2);
 apply(s,p,'legs','致命');assert.equal(B.current(s,b,b.current.id).turn.move,0);p.conditions=p.conditions.filter(c=>c.templateId!=='core_condition_legs');assert.equal(B.current(s,b,b.current.id).turn.move,base/2-2);p.conditions=[];assert.equal(B.current(s,b,b.current.id).turn.move,base-2);
});
test('same condition refreshes higher frozen severity without stacking or rewriting snapshot',()=>{
 const s=state(),p=s.players['1'];apply(s,p,'bleeding','致命');const frozen=C.clone(p.conditions[0].template);p.conditions[0].remaining=1;s.conditionTemplates.core_condition_bleeding.levels['致命'].effects[0].amount='100';apply(s,p,'bleeding','一般');assert.equal(p.conditions.length,1);assert.equal(p.conditions[0].severity,'致命');assert.equal(p.conditions[0].remaining,3);assert.deepEqual(p.conditions[0].template,frozen);
});
