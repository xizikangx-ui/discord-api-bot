'use strict';
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
function createMetrics({ enabled = false, emit = line => console.log(line) } = {}) {
  const samples = new Map(), gauges = new Map();
  const delay = enabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
  delay?.enable();
  function observe(stage, milliseconds) {
    if (!enabled || !Number.isFinite(milliseconds)) return;
    const bucket = samples.get(stage) || [];
    bucket.push(milliseconds); if (bucket.length > 2000) bucket.shift(); samples.set(stage, bucket);
  }
  function start(stage) { const at = performance.now(); return () => observe(stage, performance.now() - at); }
  function gauge(stage, value) { if (enabled) gauges.set(stage, value); }
  function report() {
    if (!enabled) return;
    const stages = {};
    for (const [stage, values] of samples) {
      const sorted = [...values].sort((a, b) => a - b);
      stages[stage] = { count: sorted.length, p50: Math.round(sorted[Math.floor((sorted.length - 1) * .5)]), p95: Math.round(sorted[Math.floor((sorted.length - 1) * .95)]) };
    }
    emit(JSON.stringify({ type: 'rpg-performance', stages, gauges: Object.fromEntries(gauges), eventLoopP95: Math.round((delay?.percentile(95) || 0) / 1e6) }));
    samples.clear(); delay?.reset();
  }
  const timer = enabled ? setInterval(report, 60000) : null; timer?.unref();
  return { observe, start, gauge, report, close() { clearInterval(timer); delay?.disable(); } };
}
module.exports = { createMetrics };
