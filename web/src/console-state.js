const panes=['console','character','bag','skills','explore','battle','activities','more','settings','library','home'];
export const consoleKey=(user,group,mobile)=>'book-console-v1:'+user+':'+group+':'+(mobile?'mobile':'desktop');
export function readConsole(storage,key,mobile){
  const fallback={open:!mobile,pane:'console'};
  try{const p=JSON.parse(storage.getItem(key));return p&&typeof p.open==='boolean'&&panes.includes(p.pane)?{open:p.open,pane:p.pane}:fallback;}catch{return fallback;}
}
export function saveConsole(storage,key,value){try{storage.setItem(key,JSON.stringify(value));}catch{/* UI preferences never block play. */}}
