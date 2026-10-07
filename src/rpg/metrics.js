'use strict';
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
// Only fixed endpoint families are retained. Never log raw routes, webhook tokens,
// Discord IDs, request bodies or URLs from REST events.
function restFamily(route='') {
  if(route.startsWith('/interactions/'))return 'interaction.callback';
  if(route.startsWith('/webhooks/'))return 'interaction.reply';
  if(/^\/guilds\/[^/]+\/roles\/member-counts(?:$|\?)/.test(route))return 'guild.roleCounts';
  if(/^\/guilds\/[^/]+\/roles(?:\/|$|\?)/.test(route))return 'guild.roles';
  if(/^\/guilds\/[^/]+\/members(?:\/|$|\?)/.test(route))return 'guild.members';
  if(/^\/channels\/[^/]+\/messages(?:\/|$|\?)/.test(route))return 'channel.messages';
  if(route.startsWith('/channels/'))return 'channel';
  if(route.startsWith('/guilds/'))return 'guild';
  if(route.startsWith('/users/'))return 'user';
  return 'other';
}
function createMetrics({ enabled = false, emit = line => console.log(line) } = {}) {
  const samples = new Map(), gauges = new Map(),counters=new Map();
  const delay = enabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
  delay?.enable();
  function observe(stage, milliseconds) {
    if (!enabled || !Number.isFinite(milliseconds)) return;
    const bucket = samples.get(stage) || [];
    bucket.push(milliseconds); if (bucket.length > 2000) bucket.shift(); samples.set(stage, bucket);
  }
  function start(stage) { const at = performance.now(); return () => observe(stage, performance.now() - at); }
  function gauge(stage, value) { if (enabled) gauges.set(stage, value); }
  function count(stage){if(enabled)counters.set(stage,(counters.get(stage)||0)+1);}
  function rateLimited(data){
    const kind=data.global?'global':data.sublimitTimeout?'sublimit':'resource';
    const wait=Math.max(0,data.timeToReset||0,data.retryAfter||0,data.sublimitTimeout||0);
    observe('discord.rateLimitWait',wait);
    observe('discord.rateLimitWait.'+restFamily(data.route)+'.'+kind,wait);
  }
  function restResponse(data,response){
    const method=['GET','POST','PATCH','PUT','DELETE'].includes(String(data.method).toUpperCase())?String(data.method).toUpperCase():'OTHER';
    count('discord.rest.'+method+'.'+restFamily(data.route));
    if(response.status>=400)count('discord.rest.status.'+response.status);
  }
  function report() {
    if (!enabled) return;
    const stages = {};
    for (const [stage, values] of samples) {
      const sorted = [...values].sort((a, b) => a - b);
      stages[stage] = { count: sorted.length, p50: Math.round(sorted[Math.max(0,Math.ceil(sorted.length*.5)-1)]), p95: Math.round(sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]) };
    }
    emit(JSON.stringify({ type: 'rpg-performance', stages,counters:Object.fromEntries(counters), gauges: Object.fromEntries(gauges), eventLoopP95: Math.round((delay?.percentile(95) || 0) / 1e6) }));
    samples.clear();counters.clear(); delay?.reset();
  }
  const timer = enabled ? setInterval(report, 60000) : null; timer?.unref();
  return { observe, start, gauge,count,rateLimited,restResponse, report, close() { clearInterval(timer); delay?.disable(); } };
}
module.exports = { createMetrics,restFamily };
