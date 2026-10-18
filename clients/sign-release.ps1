param([Parameter(Mandatory=$true)][string]$PayloadPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$rsa=[Security.Cryptography.RSA]::Create()
try{
  $vault=Join-Path $env:LOCALAPPDATA 'YichangBookBuild/update-signing/release-rsa3072.dpapi'
  $raw=[IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $PayloadPath))
  $data=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
  if($data.schema -ne 1 -or $data.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid release payload'}
  $plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vault),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $read=0;$rsa.ImportPkcs8PrivateKey($plain,[ref]$read);[Array]::Clear($plain,0,$plain.Length)
  $signature=$rsa.SignData($raw,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $envelope=@{payload=[Convert]::ToBase64String($raw);signature=[Convert]::ToBase64String($signature)}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),$envelope,[Text.UTF8Encoding]::new($false))
  Write-Output 'Signed client release manifest created.'
}finally{$rsa.Dispose()}
