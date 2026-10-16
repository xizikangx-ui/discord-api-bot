"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {memoryRepository}=require('./helpers/web-demo.cjs'),S=require('../src/web/security');
async function fixture(){const repo=memoryRepository(),accounts=require('../src/web/accounts').createAccounts(repo),admin={id:'admin',name:'admin',displayName:'管理员',admin:true};await repo.put('user',admin);const group=await accounts.createGroup(admin,{name:'邀请测试'},crypto.randomUUID()),a=await accounts.member(group.id,admin.id);return {repo,accounts,admin,group,a};}
async function user(f,id){const u={id,name:id,displayName:id};await f.repo.put('user',u);return u;}
test('legacy single invites keep seven days, one winner and digest-only storage',async()=>{
 const f=await fixture(),before=Date.now(),i=await f.accounts.invite(f.a);assert.equal(i.mode,'single');assert.ok(i.expiresAt>=before+7*86400000);const saved=await f.repo.get('invite',S.hash(i.code));assert.equal(saved.code,undefined);delete saved.mode;delete saved.usedCount;await f.repo.put('invite',saved,{scope:f.group.id});
 const users=await Promise.all(['a','b'].map(id=>user(f,id))),results=await Promise.allSettled(users.map(u=>f.accounts.join(u,i.code)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.accounts.invites(f.a)).items[0].usedCount,1);
});
test('24-hour unlimited invites admit 20 and 50 distinct users without duplicate membership or roles',async()=>{
 for(const size of [20,50]){const f=await fixture(),before=Date.now(),i=await f.accounts.invite(f.a,{mode:'multi24h'});assert.ok(i.expiresAt>=before+86400000&&i.expiresAt<=Date.now()+86400000);const users=await Promise.all(Array.from({length:size},(_,n)=>user(f,'player'+n)));await Promise.all(users.map(u=>f.accounts.join(u,i.code)));await Promise.all(Array.from({length:20},()=>f.accounts.join(users[0],i.code)));const record=await f.repo.get('invite',i.id);assert.equal(record.usedBy,undefined);assert.equal(record.usedCount,size);assert.equal((await f.repo.list('member',f.group.id)).length,size+1);await f.accounts.join(f.admin,i.code);assert.equal((await f.repo.get('member',f.group.id+':admin')).role,'gm');assert.equal((await f.repo.get('invite',i.id)).usedCount,size);}
});
test('multi registration atomically counts successful accounts and rolls back duplicate usernames',async()=>{
 const f=await fixture(),i=await f.accounts.invite(f.a,{mode:'multi24h'}),p={name:'new_player',password:'isolated long password',invite:i.code};const first=await f.accounts.register(p);assert.equal(first.user.preferences.artStyle,'magic');await assert.rejects(f.accounts.register(p),/用户名已被使用/);assert.equal((await f.repo.get('invite',i.id)).usedCount,1);assert.equal((await f.accounts.member(f.group.id,first.user.id)).role,'player');
});
test('expiry, revocation, removed members and current issuer authority are enforced',async()=>{
 const f=await fixture(),u=await user(f,'player'),i=await f.accounts.invite(f.a,{mode:'multi24h'});await f.accounts.join(u,i.code);const m=await f.repo.get('member',f.group.id+':'+u.id);m.active=false;await f.repo.put('member',m,{scope:f.group.id});await assert.rejects(f.accounts.join(u,i.code),/移出/);const single=await f.accounts.invite(f.a);await f.accounts.join(u,single.code);assert.equal((await f.accounts.member(f.group.id,u.id)).role,'player');assert.equal((await f.repo.get('invite',i.id)).usedCount,1);
 const op=crypto.randomUUID();await f.accounts.revokeInvite(f.a,i.id,op);await f.accounts.revokeInvite(f.a,i.id,op);await assert.rejects(f.accounts.join(u,i.code),/失效/);
 const exp=await f.accounts.invite(f.a,{mode:'multi24h'}),record=await f.repo.get('invite',exp.id);record.expiresAt=Date.now();await f.repo.put('invite',record,{scope:f.group.id});await assert.rejects(f.accounts.join(u,exp.code),/失效/);
 const gm=await user(f,'issuer');await f.repo.put('member',{id:f.group.id+':'+gm.id,groupId:f.group.id,userId:gm.id,role:'gm',active:true},{scope:f.group.id});const issued=await f.accounts.invite(await f.accounts.member(f.group.id,gm.id),{mode:'multi24h'});await f.repo.put('member',{id:f.group.id+':'+gm.id,groupId:f.group.id,userId:gm.id,role:'player',active:true},{scope:f.group.id});await assert.rejects(f.accounts.join(await user(f,'next'),issued.code),/GM/);
});
test('invitation management rejects players, other groups and deleted groups; preferences preserve explicit styles',async()=>{
 const f=await fixture(),u=await user(f,'member'),i=await f.accounts.invite(f.a);await f.accounts.join(u,i.code);await assert.rejects(f.accounts.invites(await f.accounts.member(f.group.id,u.id)),/GM/);const other=await f.accounts.createGroup(f.admin,{name:'另一团'},crypto.randomUUID());await assert.rejects(f.accounts.revokeInvite(await f.accounts.member(other.id,f.admin.id),i.id,crypto.randomUUID()),/不存在/);await assert.rejects(f.accounts.invite(f.a,{mode:'unknown'}),/选择/);
 const g=await f.repo.get('group',f.group.id);g.deleting=true;await f.repo.put('group',g);await assert.rejects(f.accounts.join(u,i.code),/不存在/);assert.equal(f.accounts.publicUser({...u,preferences:{artStyle:'tactical',killEffects:false}}).preferences.artStyle,'tactical');
});
test('whole console preferences are isolated by account, group and responsive layout',async()=>{
 const {consoleKey,readConsole,saveConsole}=await import('../web/src/console-state.js'),storage=new Map(),mock={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
 const key=consoleKey('a','one',false);assert.deepEqual(readConsole(mock,key,false),{open:true,pane:'console'});assert.equal(readConsole(mock,consoleKey('a','one',true),true).open,false);saveConsole(mock,key,{open:false,pane:'skills'});assert.deepEqual(readConsole(mock,key,false),{open:false,pane:'skills'});assert.equal(readConsole(mock,consoleKey('a','two',false),false).open,true);assert.equal(readConsole(mock,consoleKey('b','one',false),false).pane,'console');mock.setItem(key,'invalid');assert.equal(readConsole(mock,key,false).open,true);
 const {visibleSections}=await import('../web/src/refresh-state.js');assert.deepEqual(visibleSections('skills',{},false),['dashboard']);assert.ok(visibleSections('gm',{},false).includes('management'));
});
test('collapsed console uses current dashboard tasks instead of stale loaded panels',async()=>{
 const {chatTasks}=await import('../web/src/chat-tasks.js'),stale={id:'old',status:'active',name:'旧战斗',pending:[{id:'old-hit'}],actors:[{id:'a',userId:'u'}],current:{actorId:'a'}};
 const current={key:'new-hit',text:'待防守 · 当前战斗',system:{battleId:'new',hitId:'new-hit',kind:'webDefense'}};
 assert.deepEqual(chatTasks({dashboard:{tasks:[current],offers:[],lootCount:0},battles:[stale]},'u'),[current]);assert.deepEqual(chatTasks({dashboard:{tasks:[],offers:[],lootCount:0},battles:[stale]},'u'),[]);
});
