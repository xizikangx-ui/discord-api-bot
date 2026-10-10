'use strict';
const MINUTE = 60000;
// A single deadline timer. Empty queues have no timer; callers re-arm after changes.
function deadlineTimer(callback, { now = Date.now, set = setTimeout, clear = clearTimeout } = {}) {
  let timer, stopped = false;
  return {
    at(deadline) {
      clear(timer); timer = undefined;
      if (stopped || !Number.isFinite(deadline)) return;
      timer = set(() => { timer = undefined; if (!stopped) callback(); }, Math.max(0, Math.min(2147483647, deadline - now())));
      timer?.unref?.();
    },
    stop() { stopped = true; clear(timer); timer = undefined; },
  };
}
function archiveReminders(state, now = Date.now()) {
  if (state.moderationEconomyVersion === 1 && !(state.reminders || []).length) return false;
  state.disabledReminderArchive ||= [];
  const known = new Set(state.disabledReminderArchive.map(r => r.id));
  for (const reminder of state.reminders || []) if (!known.has(reminder.id)) {
    state.disabledReminderArchive.push({ ...reminder, disabledAt: now, disabledReason: '管理定时提醒已停用' }); known.add(reminder.id);
  }
  state.reminders = []; state.moderationEconomyVersion = 1;
  return true;
}
function discordCacheOptions(Options, self) {
  return {
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings,
      MessageManager: 20,
      GuildMemberManager: { maxSize: 200, keepOverLimit: member => member.id === self() },
      UserManager: { maxSize: 1000, keepOverLimit: user => user.id === self() },
    }),
    sweepers: { messages: { interval: 300, lifetime: 600 } },
  };
}
async function renewLongTimeouts({ jobs, remove, fetchMember, renew, save, onError, now=Date.now(), refreshWindow, day }) {
  let changed=false;
  for(const job of [...jobs()]) {
    if(job.endAt<=now){remove(job);changed=true;continue;}
    if(job.nextRefreshAt>now)continue;
    try {
      const member=await fetchMember(job);
      if(!jobs().includes(job))continue; // A manual revocation won the race.
      const until=Math.min(job.endAt,Date.now()+refreshWindow);
      await renew(member,until-Date.now(),job);
      if(jobs().includes(job)){job.nextRefreshAt=until>=job.endAt?job.endAt:until-day;changed=true;}
    }catch(error){onError(error);}
  }
  if(changed)await save();
}
async function processWarnings({ state, fetchUser, fetchGuild, save, onError, now=Date.now() }) {
  let changed=false;
  for(const followup of [...state().warningFollowups]) {
    if(followup.dueAt>now)continue;
    try {
      const user=await fetchUser(followup.userId);
      if(!state().warningFollowups.includes(followup))continue;
      await user.send(`再次提醒：你在“${followup.guildName}”收到警告。原因：${followup.reason}`);
    }catch(error){onError('A warning follow-up could not be sent.',error);}
    state().warningFollowups=state().warningFollowups.filter(item=>item.id!==followup.id);changed=true;
  }
  for(const expiration of [...state().warningExpirations]) {
    if(expiration.expiresAt>now)continue;
    try {
      const guild=await fetchGuild(expiration.guildId);
      const member=await guild.members.fetch({user:expiration.userId,force:true,cache:false});
      const role=await guild.roles.fetch(expiration.roleId);
      if(!state().warningExpirations.includes(expiration))continue;
      if(member&&role&&member.roles.cache.has(role.id))await member.roles.remove(role,`警告期限结束（处罚 ${expiration.caseId}）`);
      state().warningExpirations=state().warningExpirations.filter(item=>item.id!==expiration.id);changed=true;
    }catch(error){
      if(!state().warningExpirations.includes(expiration))continue;
      if([10007,10011].includes(Number(error.code)))state().warningExpirations=state().warningExpirations.filter(item=>item.id!==expiration.id);
      else{onError('A warning role expiration failed.',error);expiration.expiresAt=now+5*MINUTE;}
      changed=true;
    }
  }
  if(changed)await save();
}
module.exports = { MINUTE, deadlineTimer, archiveReminders, discordCacheOptions, renewLongTimeouts, processWarnings };
