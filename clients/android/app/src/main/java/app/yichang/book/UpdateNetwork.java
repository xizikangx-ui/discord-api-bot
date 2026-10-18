package app.yichang.book;

import android.content.Context;
import java.io.*;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

final class UpdateNetwork {
    interface Progress {void changed(int value);}
    final AtomicBoolean cancelled=new AtomicBoolean(false);
    volatile HttpsURLConnection connection;
    void cancel(){cancelled.set(true);HttpsURLConnection c=connection;if(c!=null)c.disconnect();}
    private HttpsURLConnection connect(String value) throws Exception {HttpsURLConnection c=(HttpsURLConnection)new URL(value).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setRequestProperty("Accept-Encoding","identity");connection=c;return c;}
    UpdateManifest check(Context context) throws Exception {
        HttpsURLConnection c=connect(UpdateManifest.ENDPOINT);
        try{int status=c.getResponseCode();if(status==204||status==404)return null;UpdateManifest.require(status==200,"更新服务暂时不可用，请稍后重试。");
            ByteArrayOutputStream output=new ByteArrayOutputStream();try(InputStream input=c.getInputStream()){byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))!=-1){if(cancelled.get())throw new IOException("已取消检查。");UpdateManifest.require(output.size()+n<=384*1024,"更新清单超过限制。");output.write(buffer,0,n);}}
            String key;try(InputStream input=context.getAssets().open("update-public-key.pem")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int n;while((n=input.read(buffer))!=-1){UpdateManifest.require(out.size()+n<8192,"更新公钥无效。");out.write(buffer,0,n);}key=new String(out.toByteArray(),StandardCharsets.UTF_8);}
            return UpdateManifest.verify(new String(output.toByteArray(),StandardCharsets.UTF_8),key);
        }finally{c.disconnect();connection=null;}
    }
    static void verifyFile(File file,UpdateManifest release) throws Exception {
        UpdateManifest.require(file.isFile()&&file.length()==release.size,"更新文件不完整，未进行安装。");MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] b=new byte[64*1024];int n;while((n=input.read(b))!=-1)digest.update(b,0,n);}UpdateManifest.require(UpdateManifest.hex(digest.digest()).equals(release.sha256),"更新文件校验失败，未进行安装。");
    }
    File download(Context context,UpdateManifest release,Progress progress) throws Exception {
        File dir=new File(context.getFilesDir(),"client-updates");UpdateManifest.require(dir.isDirectory()||dir.mkdirs(),"无法创建更新目录。");File file=new File(dir,release.sha256+".apk"),partial=new File(dir,release.sha256+".part");
        if(file.exists()){try{verifyFile(file,release);return file;}catch(Exception e){UpdateManifest.require(file.delete(),"无法清理未完成更新。");}}
        File[] old=dir.listFiles();if(old!=null)for(File item:old)if(item.getName().matches("[a-f0-9]{64}\\.(apk|part)")&&!item.equals(file)&&!item.equals(partial)&&item.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile()))item.delete();
        String location=release.url;HttpsURLConnection c=null;
        try{
            for(int redirects=0;redirects<6;redirects++){UpdateManifest.require(release.downloadUrl(location),"更新下载重定向无效。");c=connect(location);int status=c.getResponseCode();if(status>=300&&status<400){String next=c.getHeaderField("Location");UpdateManifest.require(next!=null,"更新文件重定向无效。");location=new URL(new URL(location),next).toString();c.disconnect();c=null;continue;}UpdateManifest.require(status==200,"更新文件暂时无法下载。");break;}
            UpdateManifest.require(c!=null&&c.getResponseCode()==200,"更新文件重定向次数过多。");long length=c.getContentLengthLong();UpdateManifest.require(length<0||length==release.size,"更新文件大小发生变化。");
            try(InputStream input=c.getInputStream();OutputStream output=new FileOutputStream(partial)){byte[] buffer=new byte[64*1024];long total=0,last=0;int n;while((n=input.read(buffer))!=-1){if(cancelled.get())throw new IOException("下载已取消，当前版本仍可使用。");total+=n;UpdateManifest.require(total<=release.size,"更新文件超过已签名大小。");output.write(buffer,0,n);long now=System.nanoTime();if(now-last>200000000L){progress.changed((int)(100*total/release.size));last=now;}}}
            verifyFile(partial,release);UpdateManifest.require(partial.renameTo(file),"无法保存已下载更新。");progress.changed(100);return file;
        }catch(Exception e){if(partial.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile()))partial.delete();throw e;}finally{if(c!=null)c.disconnect();connection=null;}
    }
}
