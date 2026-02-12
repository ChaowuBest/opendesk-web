# 1. 定义基本信息
$subject = "CN=OSKernelLab"
$path = "C:\OSKernelLab.pfx" # 导出路径
$password = "123456" # 导出密码

# 2. 生成证书并存入变量
$myCert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -HashAlgorithm SHA256 -KeyLength 2048 -CertStoreLocation "Cert:\CurrentUser\My"

# 3. 转换为安全字符串密码
$securePassword = ConvertTo-SecureString -String $password -Force -AsPlainText

# 4. 导出为 PFX
Export-PfxCertificate -Cert $myCert -FilePath $path -Password $securePassword

Write-Host "Certificate exported to: $path" -ForegroundColor Green
