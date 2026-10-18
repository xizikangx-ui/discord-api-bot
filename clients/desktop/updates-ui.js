'use strict';
const el=id=>document.getElementById(id);
function show(s){el('current').textContent=s.current;el('latest').textContent=s.latest||'—';el('message').textContent=s.message;el('progress').hidden=s.status!=='downloading';el('progress').value=s.progress||0;el('size').textContent=s.bytes?((s.bytes/1048576).toFixed(1)+' MiB · 安装包由 GitHub 直接提供'):'';el('notes').hidden=!s.notes;el('notes').textContent=s.notes||'';el('check').disabled=['checking','downloading'].includes(s.status);el('install').hidden=s.status!=='ready';}
window.bookUpdates.onChange(show);void window.bookUpdates.status().then(show);el('check').onclick=()=>window.bookUpdates.check().then(show);el('install').onclick=()=>window.bookUpdates.install();el('later').onclick=()=>window.close();
