package app.yichang.book;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.*;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class UpdateActivity extends Activity {
    private static WeakReference<UpdateActivity> live=new WeakReference<>(null);
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private UpdateNetwork network;
    private UpdateManifest release;
    private File downloaded;
    private TextView message,version,notes;
    private ProgressBar progress;
    private Button check,download,install,cancel;
    private boolean busy,installing,resumed,pendingPermission;
    private volatile boolean alive=true;
    private long currentCode;
    private String currentVersion="";
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);live=new WeakReference<>(this);
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setPadding(28,30,28,24);page.setBackgroundColor(Color.rgb(19,27,48));
        page.setOnApplyWindowInsetsListener((v,i)->{v.setPadding(28+i.getSystemWindowInsetLeft(),30+i.getSystemWindowInsetTop(),28+i.getSystemWindowInsetRight(),24+i.getSystemWindowInsetBottom());return i;});
        TextView title=text("客户端更新",26);page.addView(title);
        String current="";try{PackageInfo info=getPackageManager().getPackageInfo(getPackageName(),0);current=info.versionName;currentCode=code(info);}catch(Exception ignored){}
        currentVersion=current;version=text("当前版本 "+current,16);page.addView(version);
        page.addView(text("网页跑团内容随网站更新。本页更新应用本身，不会删除账号、角色或聊天。",13));
        message=text("正在核对已签名的发布信息…",16);message.setPadding(0,24,0,16);page.addView(message);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);progress.setVisibility(android.view.View.GONE);page.addView(progress,new LinearLayout.LayoutParams(-1,12));
        notes=text("",14);ScrollView notesScroll=new ScrollView(this);notesScroll.addView(notes,new ScrollView.LayoutParams(-1,-2));page.addView(notesScroll,new LinearLayout.LayoutParams(-1,0,1));
        check=button("检查更新",()->check());page.addView(check);
        download=button("下载新版",()->download());download.setVisibility(android.view.View.GONE);page.addView(download);
        install=button("安装已下载更新",()->install());install.setVisibility(android.view.View.GONE);page.addView(install);
        cancel=button("取消下载",()->{if(network!=null)network.cancel();});cancel.setVisibility(android.view.View.GONE);page.addView(cancel);
        page.addView(button("返回跑团",this::finish));
        setContentView(page);check();
    }
    private TextView text(String value,int size){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(Color.rgb(219,229,246));view.setPadding(0,8,0,8);return view;}
    private Button button(String label,Runnable action){Button b=new Button(this);b.setText(label);b.setOnClickListener(v->action.run());return b;}
    private void ui(Runnable action){runOnUiThread(()->{if(alive&&!isFinishing())action.run();});}
    private void controls(){check.setEnabled(!busy&&!installing);download.setEnabled(!busy&&!installing);install.setEnabled(!busy&&!installing);cancel.setVisibility(busy?android.view.View.VISIBLE:android.view.View.GONE);}
    private static long code(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}
    private void check(){
        if(busy||installing)return;busy=true;release=null;downloaded=null;download.setVisibility(android.view.View.GONE);install.setVisibility(android.view.View.GONE);controls();message.setText("正在检查更新…");network=new UpdateNetwork();
        progress.setVisibility(android.view.View.GONE);version.setText("当前版本 "+currentVersion);
        worker.execute(()->{try{UpdateManifest found=network.check(getApplicationContext());ui(()->{release=found;if(found==null||found.versionCode<=currentCode){message.setText("当前没有更新，继续使用现有版本。");notes.setText("");}else{version.setText("当前版本 "+currentVersion+"  →  "+found.version);message.setText("发现新版 · "+String.format(java.util.Locale.ROOT,"%.1f",found.size/1048576d)+" MiB");notes.setText(found.notes);download.setVisibility(android.view.View.VISIBLE);}});}catch(Exception e){ui(()->message.setText("检查失败："+safe(e)+" 当前版本仍可使用。"));}finally{ui(()->{busy=false;controls();});}});
    }
    private void download(){
        if(busy||release==null)return;busy=true;network=new UpdateNetwork();controls();progress.setVisibility(android.view.View.VISIBLE);progress.setProgress(0);message.setText("正在从 GitHub 下载，可随时取消。");UpdateManifest target=release;
        worker.execute(()->{try{File file=network.download(getApplicationContext(),target,p->ui(()->progress.setProgress(p)));verifyApk(file,target);ui(()->{downloaded=file;message.setText("下载与签名校验完成。安装时需要系统确认。");download.setVisibility(android.view.View.GONE);install.setVisibility(android.view.View.VISIBLE);progress.setProgress(100);});}catch(Exception e){ui(()->message.setText(safe(e)+" 当前版本仍可使用。"));}finally{ui(()->{busy=false;controls();});}});
    }
    @SuppressWarnings("deprecation") private void verifyApk(File file,UpdateManifest target) throws Exception {
        UpdateNetwork.verifyFile(file,target);int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo archive=getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),flags),current=getPackageManager().getPackageInfo(getPackageName(),flags);
        UpdateManifest.require(archive!=null&&getPackageName().equals(archive.packageName)&&target.packageName.equals(archive.packageName)&&target.version.equals(archive.versionName)&&code(archive)==target.versionCode&&code(archive)>code(current),"此更新不适用于当前应用版本。");
        android.content.pm.Signature[] old=Build.VERSION.SDK_INT>=28?current.signingInfo.getApkContentsSigners():current.signatures,newer=Build.VERSION.SDK_INT>=28?archive.signingInfo.getApkContentsSigners():archive.signatures;
        UpdateManifest.require(old!=null&&newer!=null&&old.length==1&&newer.length==1,"无法核对应用签名。");
        String existing=UpdateManifest.digest(old[0].toByteArray()),next=UpdateManifest.digest(newer[0].toByteArray());target.validateInstalled(archive.packageName,archive.versionName,code(archive),code(current),existing,next);
    }
    private void install(){
        if(busy||installing||downloaded==null||release==null)return;
        if(!getPackageManager().canRequestPackageInstalls()){pendingPermission=true;message.setText("请允许异常之书安装更新；返回后会继续核对。");try{startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())));}catch(Exception e){pendingPermission=false;message.setText("无法打开安装来源设置，请在系统设置中允许此来源。");}return;}
        busy=true;controls();message.setText("正在保存页面并再次核对更新…");
        MainActivity.flushForUpdate(saved->{if(!saved){ui(()->{busy=false;message.setText("页面暂时无法保存，请返回跑团后重试。");controls();});return;}worker.execute(()->commitInstall());});
    }
    private void commitInstall(){
        int sessionId=-1;boolean committed=false;
        try{
            verifyApk(downloaded,release);PackageInstaller installer=getPackageManager().getPackageInstaller();PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);params.setAppPackageName(getPackageName());params.setSize(downloaded.length());if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            sessionId=installer.createSession(params);try(PackageInstaller.Session session=installer.openSession(sessionId)){
                try(InputStream input=new FileInputStream(downloaded);OutputStream output=session.openWrite("base.apk",0,downloaded.length())){byte[] b=new byte[64*1024];int n;while((n=input.read(b))!=-1)output.write(b,0,n);session.fsync(output);}
                Intent result=new Intent(this,UpdateInstallReceiver.class).setAction("app.yichang.book.UPDATE_RESULT");int flags=PendingIntent.FLAG_UPDATE_CURRENT;if(Build.VERSION.SDK_INT>=31)flags|=PendingIntent.FLAG_MUTABLE;
                PendingIntent callback=PendingIntent.getBroadcast(this,sessionId,result,flags);UpdateManifest.require(alive&&!Thread.currentThread().isInterrupted(),"已取消安装，当前版本仍可使用。");ui(()->{busy=false;installing=true;message.setText("等待系统安装确认。取消后仍可使用当前版本。");controls();});session.commit(callback.getIntentSender());committed=true;
            }
        }catch(Exception e){if(sessionId>=0&&!committed)try{getPackageManager().getPackageInstaller().abandonSession(sessionId);}catch(Exception ignored){}ui(()->{busy=false;installing=false;message.setText("未能安装："+safe(e)+" 当前版本仍可使用。");controls();});}
    }
    private static String safe(Exception e){String s=e.getMessage();return s==null?"连接或校验未完成。":s.length()>200?s.substring(0,200):s;}
    static void showConfirmation(Intent confirmation){UpdateActivity a=live.get();if(a!=null&&a.resumed)a.ui(()->{try{a.startActivity(confirmation);UpdateInstallReceiver.pendingConfirmation=null;}catch(Exception e){a.message.setText("请稍后重新尝试系统安装确认。");a.installing=false;a.controls();}});}
    static void installMessage(String message,int status){UpdateActivity a=live.get();if(a!=null)a.ui(()->{a.message.setText(message);if(status!=PackageInstaller.STATUS_PENDING_USER_ACTION)a.installing=false;a.busy=false;a.controls();});}
    @Override protected void onResume(){super.onResume();resumed=true;if(UpdateInstallReceiver.pendingConfirmation!=null)showConfirmation(UpdateInstallReceiver.pendingConfirmation);if(pendingPermission){pendingPermission=false;if(getPackageManager().canRequestPackageInstalls())install();else message.setText("未授予安装来源权限，当前版本仍可使用。");}}
    @Override protected void onPause(){resumed=false;super.onPause();}
    @Override protected void onDestroy(){alive=false;if(network!=null)network.cancel();worker.shutdownNow();if(live.get()==this)live.clear();super.onDestroy();}
}
