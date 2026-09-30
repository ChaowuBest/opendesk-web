# =====================================================================
# dynobox 构建脚本（Detours 实现）
# 在一台带 MSVC 的 Windows 机器上产出 sandbox.exe + sandbox_hook.dll。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build.ps1                 # x64 + 打包
#   powershell ... -Rids win-x64,win-x86                                # 指定架构
#   powershell ... -Smoke                                               # 构建后跑一次烟雾测试（仅宿主架构）
# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# =====================================================================
param(
    [string[]]$Rids = @("win-x64"),
    [switch]$Smoke
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Native = Join-Path $Root "src"
$Dist = Join-Path $Root "dist"

Write-Host "=== [1/2] MSVC 构建： $($Rids -join ', ') ==="
foreach ($rid in $Rids) {
    $arch = switch ($rid) {
        "win-x64" { "x64" }
        "win-x86" { "x86" }
        "win-arm64" { "arm64" }
        default { throw "Unsupported RID: $rid" }
    }
    Write-Host "--- build $arch ---"
    & node (Join-Path $Native "build-native.cjs") $arch
    if ($LASTEXITCODE -ne 0) { throw "nmake $arch 失败" }
}

if ($Smoke) {
    Write-Host "=== [2/2] 烟雾测试（宿主架构） ==="
    $hostRid = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
    $binDir = Join-Path (Join-Path $Dist $hostRid) "bin"
    $policy = Join-Path $env:TEMP "dynobox-smoke-policy.toml"
    Set-Content -LiteralPath $policy -Value "version = 1`ndefault = `"allow`""
    & (Join-Path $binDir "sandbox.exe") run --automount --policy $policy -- cmd.exe /c "echo SMOKE-OK"
    if ($LASTEXITCODE -ne 0) { throw "烟雾测试失败" }
    Remove-Item -LiteralPath $policy -Force
}

Write-Host "构建完成：$((Get-ChildItem (Join-Path $Dist "*\bin\sandbox.exe")).FullName -join ', ')"
