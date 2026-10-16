"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundTasks}=require('../src/web/background-tasks');
test('shutdown drains delayed notifications before closing storage and rejects later work',async()=>{
  let release,finished=false,drained=false,late=false;
  const delay=new Promise(resolve=>{release=resolve;}),tasks=createBackgroundTasks();
  tasks.run(async()=>{await delay;finished=true;});
  tasks.seal();tasks.run(()=>{late=true;});
  const shutdown=tasks.drain().then(()=>{drained=true;assert.equal(finished,true);});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
  release();await shutdown;assert.equal(late,false);
});
test('failed broadcasts are contained while shutdown still drains successful work',async()=>{
  let errors=0,finished=false;const tasks=createBackgroundTasks(()=>{errors++;});
  tasks.run(()=>{throw Error('isolated notification failure');});
  tasks.run(()=>{finished=true;});tasks.seal();await tasks.drain();
  assert.equal(errors,1);assert.equal(finished,true);await tasks.drain();
});
