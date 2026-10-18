package app.yichang.book;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.Button;
import android.widget.Toast;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.view.Gravity;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final String HOME = "https://yichang.up.railway.app/";
    private static final int PICK_FILE = 410;
    private WebView web;
    private ValueCallback<Uri[]> chooser;
    private static WeakReference<MainActivity> live=new WeakReference<>(null);
    private final ExecutorService updateWorker=Executors.newSingleThreadExecutor();
    private UpdateNetwork updateNetwork;
    private Button nativeMenu;
    interface Saved {void done(boolean saved);}
    private long ownCode(){try{android.content.pm.PackageInfo info=getPackageManager().getPackageInfo(getPackageName(),0);return android.os.Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}catch(Exception e){return 0;}}
    private String ownVersion(){try{return getPackageManager().getPackageInfo(getPackageName(),0).versionName;}catch(Exception e){return "1.1.0";}}
    static void flushForUpdate(Saved callback){MainActivity a=live.get();if(a==null||a.web==null||a.isFinishing()){callback.done(true);return;}a.runOnUiThread(()->{if(!a.internal(Uri.parse(a.web.getUrl()==null?HOME:a.web.getUrl()))){callback.done(false);return;}AtomicBoolean done=new AtomicBoolean();new Handler(Looper.getMainLooper()).postDelayed(()->{if(done.compareAndSet(false,true))callback.done(false);},5000);a.web.evaluateJavascript("window.dispatchEvent(new Event('book:before-restart',{cancelable:true}))",result->{if(done.compareAndSet(false,true)){CookieManager.getInstance().flush();callback.done("true".equals(result));}});});}
    private void checkClientUpdate(){
        android.content.SharedPreferences prefs=getSharedPreferences("client-update",MODE_PRIVATE);long previous=prefs.getLong("lastCheck",0);if(System.currentTimeMillis()-previous<6*3600000L)return;prefs.edit().putLong("lastCheck",System.currentTimeMillis()).apply();updateNetwork=new UpdateNetwork();
        updateWorker.execute(()->{try{UpdateManifest release=updateNetwork.check(getApplicationContext());if(release!=null&&release.versionCode>ownCode()){prefs.edit().putLong("availableCode",release.versionCode).apply();runOnUiThread(()->{if(!isFinishing()){nativeMenu.setText("⋮•");Toast.makeText(this,"发现客户端新版，可从屏幕边缘的应用菜单下载。",Toast.LENGTH_LONG).show();}});}else prefs.edit().remove("availableCode").apply();}catch(Exception ignored){/* Manual check remains available; no game operation is repeated. */}});
    }
    private boolean internal(Uri uri) {
        return "https".equals(uri.getScheme()) && "yichang.up.railway.app".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        live=new WeakReference<>(this);
        FrameLayout root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(17,19,39));
        root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        web = new WebView(this); web.setBackgroundColor(Color.rgb(17,19,39));
        root.addView(web,new FrameLayout.LayoutParams(-1,-1));
        nativeMenu=new Button(this);nativeMenu.setText(getSharedPreferences("client-update",MODE_PRIVATE).getLong("availableCode",0)>ownCode()?"⋮•":"⋮");nativeMenu.setTextSize(18);nativeMenu.setTextColor(Color.WHITE);nativeMenu.setBackgroundColor(0x99384465);nativeMenu.setPadding(0,0,0,0);nativeMenu.setMinWidth(0);nativeMenu.setMinimumWidth(0);nativeMenu.setContentDescription("应用菜单：客户端更新与重新载入");FrameLayout.LayoutParams edge=new FrameLayout.LayoutParams((int)(28*getResources().getDisplayMetrics().density),(int)(48*getResources().getDisplayMetrics().density),Gravity.END|Gravity.CENTER_VERTICAL);root.addView(nativeMenu,edge);
        nativeMenu.setOnClickListener(v->{PopupMenu menu=new PopupMenu(this,nativeMenu);menu.getMenu().add("客户端更新 · "+ownVersion()).setOnMenuItemClickListener(item->{startActivity(new Intent(this,UpdateActivity.class));return true;});menu.getMenu().add("重新载入网页").setOnMenuItemClickListener(item->{flushForUpdate(ok->{if(ok)web.reload();});return true;});menu.getMenu().add("在浏览器打开").setOnMenuItemClickListener(item->{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(HOME)));return true;});menu.show();});setContentView(root);
        WebSettings settings=web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()+" YichangBook/"+ownVersion());
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if("yichangbook://updates".equals(uri.toString())&&request.isForMainFrame()&&request.hasGesture()&&view.getUrl()!=null&&internal(Uri.parse(view.getUrl()))){startActivity(new Intent(MainActivity.this,UpdateActivity.class));return true;}
                if(internal(uri))return false;
                if(request.isForMainFrame() && "https".equals(uri.getScheme()) && uri.getUserInfo()==null)try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception e){Toast.makeText(MainActivity.this,"没有可用的浏览器",Toast.LENGTH_SHORT).show();}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(chooser!=null)chooser.onReceiveValue(null); chooser=callback;
                Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT); pick.addCategory(Intent.CATEGORY_OPENABLE); pick.setType("*/*");
                String[] accepts=params.getAcceptTypes(); if(accepts!=null && accepts.length>0)pick.putExtra(Intent.EXTRA_MIME_TYPES,accepts);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try{startActivityForResult(pick,PICK_FILE);}catch(Exception e){chooser.onReceiveValue(null);chooser=null;Toast.makeText(MainActivity.this,"无法打开文件选择器",Toast.LENGTH_SHORT).show();}
                return true;
            }
        });
        if(saved==null || web.restoreState(saved)==null)web.loadUrl(HOME);
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==PICK_FILE && chooser!=null){
            Uri[] files=null;
            if(result==RESULT_OK && data!=null){if(data.getClipData()!=null){int n=Math.min(3,data.getClipData().getItemCount());files=new Uri[n];for(int i=0;i<n;i++)files[i]=data.getClipData().getItemAt(i).getUri();}else if(data.getData()!=null)files=new Uri[]{data.getData()};}
            chooser.onReceiveValue(files);chooser=null;
        }
    }
    @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
    @Override protected void onSaveInstanceState(Bundle out){web.saveState(out);super.onSaveInstanceState(out);}
    @Override protected void onPause(){CookieManager.getInstance().flush();web.onPause();super.onPause();}
    @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();checkClientUpdate();}
    @Override protected void onDestroy(){if(chooser!=null)chooser.onReceiveValue(null);if(updateNetwork!=null)updateNetwork.cancel();updateWorker.shutdownNow();if(live.get()==this)live.clear();web.destroy();super.onDestroy();}
}
