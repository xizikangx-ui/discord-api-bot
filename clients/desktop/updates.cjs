'use strict';
const {app,BrowserWindow,ipcMain,dialog,Notification,net}=require('electron'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{NsisUpdater}=require('electron-updater');
const V=require('./update-manifest.cjs'),{internal}=require('./navigation.cjs');
function createUpdates(getMain){
 let win=null,busy=false,approved=null,release=null,lastCheck=0,quitting=false;
 let state={status:'idle',current:app.getVersion(),message:'打开应用后会自动检查；网页功能更新无需重装。',progress:0};
 const updater=new NsisUpdater({provider:'generic',url:V.FEED});
 updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.autoRunAppAfterInstall=true;updater.allowDowngrade=false;updater.allowPrerelease=false;updater.disableDifferentialDownload=true;updater.logger=null;
 updater.netSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!V.downloadUrl(details.url,release)}));
 function update(patch){state={...state,...patch};if(win&&!win.isDestroyed())win.webContents.send('book:update-state',state);const main=getMain();if(main&&!main.isDestroyed())main.setProgressBar(state.status==='downloading'?state.progress/100:-1);}
 updater.on('error',()=>{if(quitting){quitting=false;update({status:'ready',message:'安装程序未能启动。当前版本仍可使用，可稍后重试。'});}});
 updater.on('download-progress',p=>update({status:'downloading',message:'正在下载新版，仍可继续跑团。',progress:Math.min(100,Math.max(0,p.percent||0))}));
 function authorized(event){return win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===pathToFileURL(path.join(__dirname,'updates.html')).href;}
 ipcMain.handle('book:update-status',event=>{if(!authorized(event))throw Error('无效的更新窗口。');return state;});
 ipcMain.handle('book:update-check',event=>{if(!authorized(event))throw Error('无效的更新窗口。');void check(true);return state;});
 ipcMain.handle('book:update-install',event=>{if(!authorized(event))throw Error('无效的更新窗口。');void install();return state;});
 function open(){if(win&&!win.isDestroyed()){win.show();win.focus();return;}win=new BrowserWindow({title:'异常之书 · 客户端更新',width:500,height:550,minWidth:390,minHeight:420,backgroundColor:'#131b30',parent:getMain()||undefined,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:path.join(__dirname,'updates-preload.cjs')}});win.setMenu(null);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.session.setPermissionRequestHandler((a,b,cb)=>cb(false));void win.loadFile(path.join(__dirname,'updates.html'));win.on('closed',()=>{win=null;});}
 async function check(manual=false){
  if(manual)open();if(busy)return;if(approved){update({status:'ready',message:'新版已下载并校验，可以选择重启安装。'});return;}if(!manual&&Date.now()-lastCheck<6*3600000)return;
  busy=true;lastCheck=Date.now();approved=null;update({status:'checking',message:'正在核对已签名的版本信息…',progress:0});
  try{
   if(!app.isPackaged){update({status:'current',message:'开发环境不执行安装；请使用正式安装版测试更新。'});return;}
   const pem=await fs.promises.readFile(path.join(process.resourcesPath,'update-public-key.pem'),'utf8');
   const response=await net.fetch(V.ENDPOINT,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
   if(response.status===204||response.status===404){update({status:'current',message:'当前没有发布更新，继续使用现有版本。'});return;}
   if(!response.ok)throw Error('更新服务暂时不可用，请稍后重试。');
   const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.byteLength;if(total>384*1024)throw Error('更新清单超过限制。');chunks.push(Buffer.from(chunk));}const text=Buffer.concat(chunks).toString('utf8');
   release=V.verifyEnvelope(JSON.parse(text),pem);
   if(V.compareVersion(release.version,app.getVersion())<=0){update({status:'current',message:'当前已是最新版本。',latest:release.version});return;}
   update({latest:release.version,notes:release.notes,bytes:release.artifacts['windows-x64'].size});
   const result=await updater.checkForUpdates();if(!result)throw Error('无法取得新版信息。');V.verifyUpdateInfo(result.updateInfo,release);
   update({status:'downloading',message:'正在下载新版，仍可继续跑团。',progress:0});
   const expected=release,files=await updater.downloadUpdate();if(files.length!==1)throw Error('更新文件数量无效。');
   await V.verifyFile(files[0],expected.artifacts['windows-x64']);approved={file:files[0],manifest:expected};
   update({status:'ready',message:'新版已下载并校验。完成当前操作后，点击重启安装。',progress:100});
   if(!win){const notification=new Notification({title:'异常之书更新已就绪',body:'完成当前操作后，从应用菜单“检查客户端更新”重启安装。'});notification.on('click',open);notification.show();}
  }catch(e){approved=null;release=null;update({status:'error',message:e.message||'更新失败；当前版本仍可使用。'});}finally{busy=false;}
 }
 async function install(){
  if(busy||!approved||quitting)return;busy=true;
  try{await V.verifyFile(approved.file,approved.manifest.artifacts['windows-x64']);const main=getMain();if(main&&!main.isDestroyed()&&internal(main.webContents.getURL())){const saved=await Promise.race([main.webContents.executeJavaScript("window.dispatchEvent(new Event('book:before-restart',{cancelable:true}))"),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('页面暂时无法保存，请返回跑团后重试。')),5000);timer.unref();})]);if(saved===false)throw Error('当前仍有操作待保存或核对，请处理后再更新。');}quitting=true;win?.close();updater.quitAndInstall(true,true);}
  catch(e){quitting=false;approved=null;update({status:'error',message:e.message||'未能安装；当前版本仍可使用。'});}finally{busy=false;}
 }
 return {open:()=>{open();void check(true);},check,stop:()=>{updater.autoInstallOnAppQuit=false;}};
}
module.exports={createUpdates};
