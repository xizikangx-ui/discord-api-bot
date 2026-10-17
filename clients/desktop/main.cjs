'use strict';
const {app,BrowserWindow,Menu,shell}=require('electron'),path=require('node:path'),{HOME,internal,external}=require('./navigation.cjs');
let main;
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{if(main){if(main.isMinimized())main.restore();main.focus();}});
 app.whenReady().then(()=>{
  const smoke=process.argv.includes('--smoke-test');
  main=new BrowserWindow({title:'异常之书',width:1380,height:900,minWidth:390,minHeight:620,backgroundColor:'#111327',show:!smoke,icon:path.join(__dirname,'book.png'),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,partition:'persist:yichang-book'}});
  main.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(false));
  main.webContents.session.setPermissionCheckHandler(()=>false);
  main.webContents.setWindowOpenHandler(({url})=>{if(external(url))void shell.openExternal(url);return{action:'deny'};});
  main.webContents.on('will-navigate',(event,url)=>{if(!internal(url)){event.preventDefault();if(external(url))void shell.openExternal(url);}});
  main.webContents.on('will-redirect',(event,url)=>{if(!internal(url))event.preventDefault();});
  main.webContents.on('will-attach-webview',event=>event.preventDefault());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'异常之书',submenu:[{label:'重新载入',role:'reload'},{label:'在浏览器打开',click:()=>shell.openExternal(HOME)},{type:'separator'},{label:'退出',role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
  if(smoke){const timer=setTimeout(()=>app.exit(2),45000);main.webContents.once('did-finish-load',()=>{console.log(JSON.stringify({loaded:internal(main.webContents.getURL()),title:main.getTitle(),nodeIntegration:main.webContents.getLastWebPreferences().nodeIntegration,sandbox:main.webContents.getLastWebPreferences().sandbox}));clearTimeout(timer);app.exit(internal(main.webContents.getURL())?0:3);});main.webContents.once('did-fail-load',()=>app.exit(4));}
  void main.loadURL(HOME);
 });
 app.on('window-all-closed',()=>app.quit());
}
