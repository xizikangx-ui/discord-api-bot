const panes=['console','character','bag','skills','explore','battle','activities','more','settings','library','home'];
export const consoleKey=(user,group,mobile)=>'book-console-v2:'+user+':'+group+':'+(mobile?'mobile':'desktop');
export function readConsole(storage,key,mobile){
  const fallback={open:false,pane:'console'};
  try{const p=JSON.parse(storage.getItem(key)||'null');if(p&&typeof p.open==='boolean'&&panes.includes(p.pane))return {open:p.open,pane:p.pane};const old=JSON.parse(storage.getItem(key.replace('book-console-v2:','book-console-v1:'))||'null');return old&&panes.includes(old.pane)?{...fallback,pane:old.pane}:fallback;}catch{return fallback;}
}
export function saveConsole(storage,key,value){try{storage.setItem(key,JSON.stringify(value));}catch{/* UI preferences never block play. */}}
