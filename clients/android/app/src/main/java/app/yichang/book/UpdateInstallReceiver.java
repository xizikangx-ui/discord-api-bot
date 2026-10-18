package app.yichang.book;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public final class UpdateInstallReceiver extends BroadcastReceiver {
    static Intent pendingConfirmation;
    @Override public void onReceive(Context context,Intent intent){
        int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
        String message;
        if(status==PackageInstaller.STATUS_PENDING_USER_ACTION){
            @SuppressWarnings("deprecation") Intent confirmation=intent.getParcelableExtra(Intent.EXTRA_INTENT);
            pendingConfirmation=confirmation;message="请确认系统安装。取消后仍可使用当前版本。";
            if(confirmation!=null)UpdateActivity.showConfirmation(confirmation);
        }else if(status==PackageInstaller.STATUS_SUCCESS){pendingConfirmation=null;message="更新已安装，请重新打开异常之书。";}
        else{pendingConfirmation=null;message=status==PackageInstaller.STATUS_FAILURE_ABORTED?"已取消安装，当前版本仍可使用。":"安装未完成，当前版本仍可使用；可在更新页重新尝试。";}
        context.getSharedPreferences("client-update",Context.MODE_PRIVATE).edit().putString("installMessage",message).apply();
        UpdateActivity.installMessage(message,status);
    }
}
