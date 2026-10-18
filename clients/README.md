# 异常之书客户端

连接正式网站 https://yichang.up.railway.app/ ，使用原网站账号。客户端是在线应用，角色、聊天和规则由服务器保存；断网时不执行游戏修改。客户端更新网页界面，无需重新下载整个客户端。

## Windows x64

推荐双击 `异常之书-Windows安装包-1.0.0.exe`，选择安装位置后从桌面或开始菜单打开。运行环境已包含，无需 Node。旧便携包仍可解压整个文件夹后运行 `YichangBook.exe`，不要只取其中一个 exe。关闭窗口即退出；菜单提供重新载入、缩放及在浏览器打开。客户端使用独立登录会话，与普通浏览器分别管理。

远程页面关闭 Node 权限、启用沙箱和上下文隔离，没有本机脚本桥；仅在本站内导航，外站 HTTPS 链接交给默认浏览器。不在安装包内保存账号、密码、令牌或管理员权限。

开发：在 `desktop/` 执行 `npm ci`、`npm start`；先执行 `npm run package`，再执行 `npm run installer` 生成 `desktop/installers/` 内的 NSIS 安装程序。基于 Electron 44.9.0；分发保留 Electron/Chromium 许可证。`--smoke-test` 为维护用隐藏启动检查。安装程序尚无商业 Windows 代码签名。

## Android 安装与项目

将 `异常之书-Android-1.0.0.apk` 下载到 Android 8.0 或更新的手机，点击文件安装并打开；使用原网站账号登录。系统会按手机设置要求允许从当前下载来源安装应用。APK 使用独立发布签名，后续版本需要沿用同一密钥才能覆盖安装。

用 Android Studio 打开 `android/`。要求 JDK 17+、Android SDK 35；最低 Android 8.0。可用 Android Studio 的 Build APK，或在 Windows 执行 `android/构建调试包.ps1`。脚本下载并校验官方 Gradle 8.11.1；SDK 路径在本机 `local.properties` 中填写，不能提交该文件。

项目提供登录、网页跑团、音乐和图片选择器。只申请联网权限，通过系统文件选择器读取本人选择的文件；不申请相机、录音或整个相册读取权限。音乐需用户点一次收听。外站音乐账号功能本版未接入。

发布构建通过环境变量 `YICHANG_ANDROID_STORE_PATH`、`YICHANG_ANDROID_STORE_PASSWORD` 读取签名，密钥别名为 `yichangbook`；私钥与口令不能提交仓库。构建要求 Gradle 8.11.1、Android Gradle Plugin 8.9.2 及 Build Tools 35。维护机发布密钥存于当前 Windows 用户的本地受限目录，口令由 DPAPI 保护。编译与静态检查不代替手机测试；原生后台推送、锁屏持续播放和离线跑团不在本版范围。
