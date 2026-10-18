# 异常之书客户端

连接正式网站 https://yichang.up.railway.app/ ，使用原网站账号。角色、聊天和规则由服务器保存；断网时不执行游戏修改。网页功能随网站更新，无需重新安装客户端；1.1.0 起也可在应用内更新客户端本身。

## Windows x64

推荐使用 1.1.0 安装包，运行环境已包含，无需安装 Node。已有 1.0.0 用户只需手动覆盖安装这一次桥接版本，沿用原安装位置，勿先清除应用数据；以后打开应用会检查新版，也可点菜单“异常之书 → 检查客户端更新”。新版在后台下载，完成后可选择“重启安装”或“稍后”；普通关闭应用不会偷偷安装。客户端保持同一应用标识和本地会话目录，更新不清除登录与草稿。旧便携版建议改用安装版。

远程页面关闭 Node 权限、启用沙箱和上下文隔离，没有本机脚本桥；仅在本站内导航，外站 HTTPS 链接交给默认浏览器。不在安装包内保存账号、密码、令牌或管理员权限。

开发：在 `desktop/` 执行 `npm ci`、`npm test`、`npm start`；`npm run installer` 使用统一 electron-builder 配置生成 `desktop/installers/` 内的 NSIS 安装程序及更新元数据，不需要先运行 package。`npm run package` 仅生成解包目录。基于 Electron 44.9.0、electron-updater 6.8.9、electron-builder 26.15.3；分发保留 Electron/Chromium 许可证。`--smoke-test` 为维护用隐藏启动检查。安装程序尚无商业 Windows 代码签名，系统可能显示来源提示；发布清单的 RSA 签名是独立校验，不能替代 Windows 代码签名或消除系统提示。

## Android 安装与项目

在 Android 8.0 或更新的手机安装 1.1.0 APK，使用原网站账号登录。1.0.0 需要先手动覆盖安装此桥接版本一次，不卸载旧版；包名 `app.yichang.book` 和发布签名保持不变，版本号 1.1.0、版本码 2。后续从屏幕右侧的“⋮ → 客户端更新”检查、下载并安装；启动时也会检查并提示新版本。下载可取消，失败或取消仍可使用当前版本。

Android 需要用户允许“安装此来源的应用”，并在系统安装器再次确认，不支持静默安装。应用只接受固定发布仓库的完整 APK，安装前核对清单签名、文件长度、SHA-256、包名、版本和已安装应用的签名证书。应用更新页是原生本地界面，网站不能借此打开任意文件或执行系统命令。

用 Android Studio 打开 `android/`。要求 JDK 17+、Android SDK 35；最低 Android 8.0。可用 Android Studio 的 Build APK，或在 Windows 执行 `android/构建调试包.ps1`。脚本下载并校验官方 Gradle 8.11.1；SDK 路径在本机 `local.properties` 中填写，不能提交该文件。

项目提供登录、网页跑团、音乐、图片选择器及应用内升级。除联网和由用户明确操作的安装更新权限外，不申请相机、录音或整个相册读取权限；选择文件使用系统选择器。音乐需用户点一次收听。外站音乐账号功能本版未接入。

发布构建通过环境变量 `YICHANG_ANDROID_STORE_PATH`、`YICHANG_ANDROID_STORE_PASSWORD` 读取签名，密钥别名为 `yichangbook`；私钥与口令不能提交仓库。构建要求 Gradle 8.11.1、Android Gradle Plugin 8.9.2 及 Build Tools 35。维护机发布密钥存于当前 Windows 用户的本地受限目录，口令由 DPAPI 保护。编译与静态检查不代替手机测试；原生后台推送、锁屏持续播放和离线跑团不在本版范围。

## 更新发布与验收

两端随安装包固定携带 `update-public-key.pem`，用 RSA-3072/SHA-256 验证服务器返回的原始清单字节。清单从 `/api/web/v1/client-release?platform=windows-x64|android` 读取；204 表示尚无发布更新。Windows 的 generic feed 由服务端从同一已验证清单派生，安装前另外核对 SHA-256 与 SHA-512。二进制文件直接由固定 GitHub Releases 仓库下载，不经网站代理，不增加跑团存档或图片渲染负担。

正式发布使用 `client-v版本号` 标签，先完成 Windows 安装包、Android 同签名 APK 及对应哈希，维护者再用 `sign-release.ps1` 签清单。发布私钥仅存维护机受保护目录，不能打包或提交；客户端和网站只保存公钥。改变公钥需要先发布能信任新公钥的桥接版本，不能直接替换在线清单的密钥。

Windows 控制器测试使用隔离的内存签名清单和假安装执行端，覆盖离线、签名错误、元数据不符、文件损坏、未保存操作与非可信 IPC；不会发布虚假未来版本。Android 的 `testDebugUnitTest assembleDebug lintDebug` 验证清单及版本/证书规则和构建；手机上的系统确认、取消后重试与真实覆盖安装仍须真机验收，不能用编译成功代替。
