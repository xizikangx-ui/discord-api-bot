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

public class MainActivity extends Activity {
    private static final String HOME = "https://yichang.up.railway.app/";
    private static final int PICK_FILE = 410;
    private WebView web;
    private ValueCallback<Uri[]> chooser;
    private boolean internal(Uri uri) {
        return "https".equals(uri.getScheme()) && "yichang.up.railway.app".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(17,19,39));
        root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        web = new WebView(this); web.setBackgroundColor(Color.rgb(17,19,39));
        root.addView(web,new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);
        WebSettings settings=web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl(); if(internal(uri))return false;
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
    @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();}
    @Override protected void onDestroy(){if(chooser!=null)chooser.onReceiveValue(null);web.destroy();super.onDestroy();}
}
