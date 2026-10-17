$ErrorActionPreference='Stop'
$projectPath=$PSScriptRoot
if(-not $env:JAVA_HOME){$studioRuntime='C:/Program Files/Android/Android Studio/jbr';if(Test-Path -LiteralPath $studioRuntime){$env:JAVA_HOME=$studioRuntime}else{throw '请先安装 Android Studio，并配置 JDK 17 或更新版本。'}}
$gradleVersion='8.11.1'
$runtimePath=Join-Path $projectPath '.runtime'
$gradlePath=Join-Path $runtimePath "gradle-$gradleVersion/bin/gradle.bat"
if(-not(Test-Path -LiteralPath $gradlePath)){
 New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
 $zipPath=Join-Path $runtimePath 'gradle.zip'
 Invoke-WebRequest "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $zipPath
 $expected=(Invoke-RestMethod "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip.sha256").Trim()
 if((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()){throw 'Gradle 下载校验失败。'}
 Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimePath -Force
}
& $gradlePath -p $projectPath assembleDebug
if($LASTEXITCODE -ne 0){throw '构建失败；请检查 Android Studio 的 SDK 35、JDK 及网络。'}
Write-Host "调试 APK：$projectPath/app/build/outputs/apk/debug/app-debug.apk"
