"use strict";
// Broadcasts are outside business transactions, but must finish before the pool closes.
function createBackgroundTasks(onError = () => {}) {
  const pending = new Set();
  let closed = false;
  return {
    run(task) {
      if (closed) return;
      const work = Promise.resolve().then(task).catch(onError);
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
    },
    seal() { closed = true; },
    async drain() { await Promise.allSettled([...pending]); },
  };
}
module.exports = { createBackgroundTasks };
