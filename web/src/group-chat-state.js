// Pure helpers shared by navigation and subscription contract tests.
export function canonicalChat(group,rooms=[]) {return rooms.find(r=>r.id===group?.chatRoomId)||rooms.find(r=>r.canonical)||rooms.find(r=>r.kind==='chat'&&!r.archived)||null;}
export function groupUnread(groups,event={}) {return groups.map(g=>{
 if(g.id!==event.groupId)return g;
 if(event.unreadVersion!==undefined){if(event.unreadVersion<(g.unreadVersion||0))return g;}
 else if(g.unreadVersion||event.chatVersion!==undefined&&event.chatVersion<(g.chatVersion||0))return g;
 return {...g,unread:Math.max(0,event.unread??((g.unread||0)+(event.delta||0))),unreadVersion:event.unreadVersion??g.unreadVersion,gmUnread:event.gmUnread??g.gmUnread,chatVersion:event.chatVersion??g.chatVersion};
});}
export function mergeGroupList(prior,incoming=[]) {return incoming.map(g=>{const old=prior.find(p=>p.id===g.id);if(!old)return g;const older=(g.unreadVersion??0)<(old.unreadVersion||0),oldMembership=(g.membershipVersion??0)<(old.membershipVersion||0);return {...g,...(g.hasUpdates===undefined?{hasUpdates:old.hasUpdates}:{}),...(older?{unread:old.unread,unreadVersion:old.unreadVersion,gmUnread:old.gmUnread}:{}),...(oldMembership?{role:old.role,membershipVersion:old.membershipVersion}:{} )};});}
export function subscribePayload(current,requestId) {const belongs=current.roomIds?.includes(current.roomId);return {type:'subscribe',requestId,...(current.groupId&&belongs?{groupId:current.groupId,roomId:current.roomId}:{}),watchGroups:[...new Set(current.watchGroups||[])]};}

// Revoke local drafts with the membership; other groups and account preferences remain.
export function purgeGroupDrafts(storage,session,userId,groupId,{gmOnly=false}={}) {
  try {const marker=':'+userId+':'+groupId;const keys=Array.from({length:storage.length},(_,i)=>storage.key(i));for(const key of keys){if(!key)continue;const match=key.includes(marker)&&(key.endsWith(marker)||key.includes(marker+':'));if(match&&(!gmOnly||key.startsWith('yichang-restart-draft:gm-editor:')))storage.removeItem(key);}
    const oldKey='yichang-restart-draft:gm-editor:'+userId,old=JSON.parse(storage.getItem(oldKey)||'null');if(old?.[groupId+':'+userId]){delete old[groupId+':'+userId];storage.setItem(oldKey,JSON.stringify(old));}
    const editor=JSON.parse(session.getItem('wasteland-editor-drafts')||'{}'),scope=groupId+':'+userId;if(editor[scope]){const pending=editor[scope].pendingOperation;if(gmOnly&&pending&&!pending.isGM)editor[scope]={pendingOperation:pending};else delete editor[scope];session.setItem('wasteland-editor-drafts',JSON.stringify(editor));}
    const navigation='yichang-restart-draft:navigation:'+userId;if(!gmOnly&&JSON.parse(storage.getItem(navigation)||'null')?.groupId===groupId)storage.removeItem(navigation);
  } catch {/* Authorization is enforced remotely even if browser storage is unavailable. */}
}
