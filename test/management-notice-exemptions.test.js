'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('discord.js'),N=require('../src/management-notice-exemptions');
function fixture(){
  let saved=0,allowed=true,auditAllowed=true,fail=false;
  const setting={},guild={id:'guild',members:{fetch:async({user})=>({id:user,user:{bot:false},permissions:new D.PermissionsBitField(user!=='admin'||allowed?D.PermissionFlagsBits.ManageGuild:0n)}),fetchMe:async()=>({permissions:new D.PermissionsBitField(auditAllowed?D.PermissionFlagsBits.ViewAuditLog:0n)})}};
  const api=N.createExemptions({client:{user:{id:'BOT'}},settingsFor:()=>setting,save:async()=>{if(fail)throw Error('保存失败');saved++;},logFailure:()=>{}});
  const interaction=(action,version=setting.managementAnnouncementExemptionVersion||0,values=[])=>({customId:'notice-exempt:'+action+':guild:'+version,guildId:'guild',guild,user:{id:'admin'},message:{author:{id:'BOT'}},memberPermissions:new D.PermissionsBitField(D.PermissionFlagsBits.ManageGuild),values,inGuild:()=>true,isButton:()=>action!=='users',isUserSelectMenu:()=>action==='users',async reply(p){this.result=p;this.replied=true;},async update(p){this.result=p;this.replied=true;},async deferUpdate(){this.deferred=true;},async editReply(p){this.result=p;},async followUp(p){this.result=p;}});
  return {api,setting,guild,interaction,saves:()=>saved,permission:v=>allowed=v,auditPermission:v=>auditAllowed=v,failure:v=>fail=v};
}
test('operator exemptions survive serialization, remove/clear and reject stale administrator versions',async()=>{
  const h=fixture(),i=h.interaction('users',0,['operator-a','operator-b']);await h.api.handle(i);
  assert.equal(h.saves(),1);assert.equal(N.isExempt(JSON.parse(JSON.stringify(h.setting)),'operator-a'),true);assert.equal(N.isExempt(h.setting,'unlisted'),false);assert.equal(N.isExempt({},'operator-a'),false);
  assert.ok(i.result.components.length<=5);assert.deepEqual(i.result.allowedMentions,{parse:[]});assert.equal(i.result.components[0].toJSON().components[0].type,D.ComponentType.UserSelect);
  const stale=h.interaction('users',0,['operator-b']);await h.api.handle(stale);assert.match(stale.result.content,/其他管理员修改/);assert.equal(h.saves(),1);
  await h.api.handle(h.interaction('users',1,['operator-b']));assert.equal(N.isExempt(h.setting,'operator-a'),false);
  await h.api.handle(h.interaction('clear'));assert.deepEqual(h.setting.managementAnnouncementExemptUserIds,[]);assert.equal(h.saves(),3);
});
test('current authority, audit permission, guild and message ownership are required; persistence failures retain prior settings',async()=>{
  const h=fixture();for(const change of [i=>i.guildId='other',i=>i.message.author.id='other',i=>i.memberPermissions=new D.PermissionsBitField()]){const i=h.interaction('users',0,['operator']);change(i);await h.api.handle(i);assert.equal(i.result.flags,64);assert.equal(h.saves(),0);}
  h.permission(false);const denied=h.interaction('users',0,['operator']);await h.api.handle(denied);assert.match(denied.result.content,/已失去/);assert.equal(h.saves(),0);
  h.permission(true);h.auditPermission(false);const missing=h.interaction('users',0,['operator']);await h.api.handle(missing);assert.match(missing.result.content,/查看审计日志/);assert.equal(h.saves(),0);
  h.auditPermission(true);await h.api.handle(h.interaction('users',0,['operator']));h.failure(true);const failed=h.interaction('clear');await h.api.handle(failed);assert.match(failed.result.content,/保存失败/);assert.equal(N.isExempt(h.setting,'operator'),true);assert.equal(h.setting.managementAnnouncementExemptionVersion,1);
});
test('concurrent edits cannot overwrite each other; repeated clicks leave the saving panel intact',async()=>{
  const h=fixture();let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r),fetch=h.guild.members.fetch;h.guild.members.fetch=async p=>{entered();await wait;return fetch(p);};
  const a=h.interaction('users',0,['operator']),p=h.api.handle(a);await ready;const duplicate=h.interaction('clear',0);await h.api.handle(duplicate);assert.match(duplicate.result.content,/正在保存/);assert.equal(duplicate.deferred,undefined);release();await p;assert.equal(h.saves(),1);
});
function publisher(){
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../src/bot.js'),'utf8');
  const begin=source.indexOf('async function announceManagementChange('),end=source.indexOf('\nasync function editManagementPanelSource',begin);
  const setting={managementAnnouncementExemptUserIds:['operator-a']},sent=[];let channels=0,rosters=0;
  const context={noticeExemptions:N,settingsFor:()=>setting,managementTrack:(s,t,id)=>({roleId:id||'senior',label:t,channelId:'channel'}),scheduleManagementRoster:()=>rosters++,ensureManagementAnnouncementThread:async()=>{channels++;return {isTextBased:()=>true,isThread:()=>false,send:async p=>sent.push(p)};},logFailure:()=>{},EmbedBuilder:D.EmbedBuilder};
  return {publish:vm.runInNewContext('('+source.slice(begin,end)+')',context),setting,sent,channels:()=>channels,rosters:()=>rosters};
}
test('actual publisher suppresses the operator across roles, not the affected member or role; unknown events wait for audit',async()=>{
  const h=publisher(),guild={id:'guild'};
  for(const roleId of ['senior','middle'])for(const action of ['登记','任命','卸任'])await h.publish(guild,{action,roleId,records:[{member:{id:'member'},tenure:'1天'}],moderator:{id:'operator-a'},startedAt:Date.now(),endedAt:Date.now()});
  await h.publish(guild,{action:'任命',unknownOperator:true,records:[{member:{id:'member'}}],moderator:{id:'BOT'},startedAt:Date.now()});
  assert.equal(h.channels(),0);assert.equal(h.sent.length,0);assert.equal(h.rosters(),7);
  await h.publish(guild,{action:'任命',records:[{member:{id:'operator-a'}}],moderator:{id:'other-operator'},startedAt:Date.now()});assert.equal(h.sent.length,1);
  h.setting.managementAnnouncementExemptUserIds=[];
  await h.publish(guild,{action:'登记',unknownOperator:true,records:[{member:{id:'member'}}],moderator:{id:'BOT'},startedAt:Date.now()});assert.equal(h.sent.length,2);
});
test('audit-based member role notices use exact executor/role deltas regardless of event order or member cache',async()=>{
  const h=publisher(),guild={id:'guild',members:{fetch:async()=>({id:'target',user:{bot:false}})}},tracks=()=>[['senior',null,{roleId:'senior',terms:[]}],['middle','middle',{roleId:'middle',terms:[]}]];
  const audit=N.createAuditPublisher({client:{user:{id:'BOT'}},settingsFor:()=>h.setting,tracks,announce:h.publish,formatTenure:()=>'',logFailure:()=>{}});
  const entry=(executorId,roles=['senior'])=>({action:D.AuditLogEvent.MemberRoleUpdate,executorId,targetId:'target',changes:[{key:'$add',new:roles.map(id=>({id}))}],createdTimestamp:Date.now()});
  await audit.handle(entry('operator-a',['senior','middle']),guild);assert.equal(h.sent.length,0);
  await audit.handle(entry('other-operator',['senior','middle']),guild);assert.equal(h.sent.length,2);
  const remove={...entry('other-operator'),changes:[{key:'$remove',new:[{id:'senior'}]}]};guild.members.fetch=async()=>{throw Object.assign(Error(),{code:10007});};await audit.handle(remove,guild);assert.equal(h.sent.length,3);
  await audit.handle({...entry('BOT'),reason:'管理组任命：理由'},guild);assert.equal(h.sent.length,3);
  await audit.handle(entry('BOT'),guild);assert.equal(h.sent.length,4);
  await audit.handle(entry(undefined),guild);assert.equal(h.sent.length,4);
  await audit.handle(entry('other-operator',['unrelated']),guild);assert.equal(h.sent.length,4);
});
test('actual permission audit route preserves restoration while muting exempt operator announcements and deduplicates entries',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../src/bot.js'),'utf8'),begin=source.indexOf("client.on('guildAuditLogEntryCreate'"),end=source.indexOf("client.on('channelCreate'",begin);
  let route,restores=0,alerts=0,warnings=0;const setting={permissionRollbackWhitelistUserIds:[],permissionRollbackEnabled:true,managementAnnouncementExemptUserIds:['operator-a']},bits=D.PermissionFlagsBits.ManageRoles;
  const context={handledPermissionAuditEntries:new Set(),client:{user:{id:'BOT'},on:(event,fn)=>route=fn},managementNoticeAudit:{handle:async()=>false},settingsFor:()=>setting,noticeExemptions:N,AuditLogEvent:D.AuditLogEvent,monitoredPermissionBits:x=>x,changedPermissionBits:(a,b)=>BigInt(a)^BigInt(b),restoreRolePermissionChanges:async()=>{restores++;return {changed:bits,restored:bits};},guardedPermissionKeys:['ManageRoles'],escalationPermissionKeys:new Set(),permissionNamesForBits:()=>['ManageRoles'],permissionLabel:x=>x,applyPermissionViolationPolicy:async()=>null,EmbedBuilder:D.EmbedBuilder,sendPermissionAlert:async()=>alerts++,console:{warn:()=>warnings++},logFailure:(label,e)=>{throw e;}};
  vm.runInNewContext(source.slice(begin,end),context);const guild={id:'guild',roles:{cache:new Map()}},entry={id:'1',action:D.AuditLogEvent.RoleUpdate,executorId:'operator-a',targetId:'any-role',changes:[{key:'permissions',old:'0',new:String(bits)}],createdAt:new Date()};
  await route(entry,guild);await route(entry,guild);assert.equal(restores,1);assert.equal(alerts,0);assert.equal(warnings,0);
  await route({...entry,id:'2',executorId:'other-operator'},guild);assert.equal(restores,2);assert.equal(alerts,1);assert.equal(warnings,1);
});
