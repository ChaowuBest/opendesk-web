# =====================================================================
# dynobox 交叉构建脚本
# 在一台 x64 机器上产出可在 Windows 10/11 x86 / x64 / ARM64 上运行的
# 自包含单文件二进制（无需目标机安装 .NET）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build.ps1                  # 全部三个架构 + 打包
#   powershell ... -Rids win-x64,win-arm64                              # 指定架构
#   powershell ... -Smoke                                               # 构建后跑一次烟雾测试（仅宿主架构）
# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
# =====================================================================
param(
    [string[]]$Rids = @("win-x86", "win-x64", "win-arm64"),
    [switch]$Smoke
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Proj = Join-Path $Root "src\Dynobox\Dynobox.csproj"
$Dist = Join-Path $Root "dist"

# 优先使用带 SDK 的 dotnet：系统 PATH 里的可能是纯运行时；
# 用户态安装（dotnet-install.ps1，%LOCALAPPDATA%\Microsoft\dotnet）也认。
$userDotnet = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet"
function Test-DotnetSdk {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { return $false }
    $sdks = & dotnet --list-sdks 2>$null
    return [bool]$sdks
}
if (-not (Test-DotnetSdk)) {
    if (Test-Path (Join-Path $userDotnet "dotnet.exe")) {
        $env:PATH = "$userDotnet;$env:PATH"
    }
    if (-not (Test-DotnetSdk)) {
        throw "未找到 .NET 8 SDK（请安装 SDK 或用 dotnet-install.ps1 装到用户目录）"
    }
}

Write-Host "=== [1/3] 交叉发布： $($Rids -join ', ') ==="
foreach ($rid in $Rids) {
    Write-Host "--- publish $rid ---"
    & dotnet publish $proj `
        -c Release `
        -r $rid `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:DebugType=none `
        -p:PublishReadyToRun=false `
        --nologo `
        -o (Join-Path (Join-Path $Dist $rid) "bin")
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish $rid 失败" }
    $published = Join-Path (Join-Path (Join-Path $Dist $rid) "bin") "dynobox.exe"
    if (Test-Path $published) {
        Copy-Item $published (Join-Path (Split-Path $published) "sandbox.exe") -Force
    }
}

Write-Host "=== [1.5/3] 准备各架构 Dokan MSI（内置进发行包） ==="
$MsiMap = @{ "win-x86" = "Dokan_x86.msi"; "win-x64" = "Dokan_x64.msi"; "win-arm64" = "Dokan_ARM64.msi" }
$MsiDir = Join-Path $Root "_setup"
foreach ($rid in $Rids) {
    $msiName = $MsiMap[$rid]
    $msiPath = Join-Path $MsiDir $msiName
    if (-not (Test-Path $msiPath)) {
        Write-Host "  下载 $msiName ..."
        $url = "https://github.com/dokan-dev/dokany/releases/download/v2.3.1.1000/$msiName"
        for ($tryNo = 1; $tryNo -le 8; $tryNo++) {
            & curl.exe -sL --max-time 120 -C - -o $msiPath $url
            if ((Test-Path $msiPath) -and ((Get-Item $msiPath).Length -gt 4MB)) { break }
            Start-Sleep 1
        }
    }
    if (-not ((Test-Path $msiPath) -and ((Get-Item $msiPath).Length -gt 4MB))) {
        throw "$msiName 下载不完整，请手动放置到 $MsiDir"
    }
}

Write-Host "=== [2/3] 组装发行目录 ==="
foreach ($rid in $Rids) {
    $stage = Join-Path $Dist "dynobox-$rid"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage "examples") | Out-Null

    Copy-Item (Join-Path (Join-Path $Dist $rid) "bin\dynobox.exe") $stage
    Copy-Item (Join-Path $Root "examples\rules.toml") $stage
    # 内置对应架构的 Dokan 驱动 MSI，供 install.cmd 离线安装
    Copy-Item (Join-Path $MsiDir $MsiMap[$rid]) (Join-Path $stage "DokanSetup.msi")
    Copy-Item (Join-Path $Root "examples\src") (Join-Path $stage "examples\src") -Recurse

    # 便携版一键演示脚本（引用同目录 exe）
    $demo = @'
@echo off
rem dynobox 便携版演示：启动内置端点(独立进程) -> 挂载 -> 运行测试
setlocal
cd /d %~dp0
start "dynobox-endpoint" /min dynobox.exe endpoint --port 8080 --default deny
timeout /t 2 /nobreak >nul
dynobox.exe run --src examples\src --policy rules.toml --upstream http://127.0.0.1:8080/decide -- cmd /c tests\run_tests.bat
set RC=%errorlevel%
echo 完成，退出码 %RC%（0 = 全部通过）。minimized 端点窗口可关闭。
endlocal & exit /b %RC%
'@
    $demo = $demo -replace "`n", "`r`n"
    Set-Content -Path (Join-Path $stage "run_demo.bat") -Value $demo -Encoding ASCII

    # 一键安装脚本：检测/静默安装内置 Dokan 驱动（UAC 一次）→ 跑测试自检
    $installLines = @(
        '@echo off',
        'rem dynobox quick installer: detect/install bundled Dokan driver, then run self-check (MSI matches exe arch)',
        'setlocal',
        'cd /d %~dp0',
        'echo [1/2] Checking Dokan driver...',
        'if exist "%SystemRoot%\System32\dokan2.dll" (',
        '    echo       Dokan driver already installed, skipping.',
        ') else (',
        '    echo       Not found. Silently installing bundled DokanSetup.msi - UAC prompt expected...',
        '    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process msiexec -ArgumentList ''/i'',''%~dp0DokanSetup.msi'',''/qn'',''/norestart'' -Wait -Verb RunAs"',
        '    if exist "%SystemRoot%\System32\dokan2.dll" (',
        '        echo       Dokan driver installed.',
        '    ) else (',
        '        echo       Install failed. Please double-click DokanSetup.msi manually and rerun.',
        '        pause',
        '        exit /b 1',
        '    )',
        ')',
        'echo [2/2] Self-check: mounting sandbox volume and running access-control tests...',
        'start "dynobox-endpoint" /min dynobox.exe endpoint --port 8080 --default deny',
        'timeout /t 2 /nobreak >nul',
        'dynobox.exe run --src examples\src --policy rules.toml --upstream http://127.0.0.1:8080/decide -- cmd /c tests\run_tests.bat',
        'set RC=%errorlevel%',
        'echo Self-check exit code %RC% (0 = all tests passed). Volume auto-unmounted; endpoint window can be closed.',
        'endlocal & exit /b %RC%'
    )
    $install = ($installLines -join "`r`n") + "`r`n"
    Set-Content -Path (Join-Path $stage "install.cmd") -Value $install -Encoding ASCII

    $note = @"
dynobox (win arch: $rid)
============================
要求：目标机已安装对应架构的 Dokan Library v2.x（驱动安装需一次管理员）。
  x64  -> Dokan_x64.msi    x86 -> Dokan_x86.msi    ARM64 -> Dokan_ARM64.msi

运行演示：  run_demo.bat
手动运行：
  dynobox.exe run --src examples\src --policy rules.toml --upstream http://127.0.0.1:8080/decide -- cmd /c tests\run_tests.bat
  dynobox.exe mount --src examples\src --policy rules.toml     (仅挂载)
  dynobox.exe endpoint --port 8080                             (内置测试决策端点)

详见仓库 README.md（规则文件格式与 ask HTTP 协议）。
"@
    Set-Content -Path (Join-Path $stage "README-build.txt") -Value $note -Encoding UTF8

    $zip = Join-Path $Dist "dynobox-$rid.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $stage\* -DestinationPath $zip
    Write-Host ("  -> " + $zip)
}

Write-Host "=== [2.5/3] 无 .NET 依赖验证（剥离 PATH/DOTNET_ROOT 后运行） ==="
foreach ($rid in $Rids) {
    if ($rid -eq "win-arm64") {
        Write-Host "  win-arm64：无法在 x64 宿主运行；自包含由发布配置与体积（67MB）保证"
        continue
    }
    if ($rid -eq "win-x64" -and -not [Environment]::Is64BitOperatingSystem) {
        Write-Host "  跳过 win-x64 运行验证（宿主非 x64）"
        continue
    }
    $exe = Join-Path (Join-Path (Join-Path $Dist $rid) "bin") "dynobox.exe"
    $out = & cmd /c "set PATH=C:\Windows\System32&& set DOTNET_ROOT=&& `"$exe`" 2>&1"
    if (($out -join " ") -match "dynobox") {
        Write-Host "  $rid ：剥离 .NET 环境后正常运行（自包含成立）"
    } else {
        throw "$rid 在剥离 .NET 环境后无法运行"
    }
}

Write-Host "=== [3/3] 完成 ==="
if ($Smoke) {
    $hostRid = if ([Environment]::Is64BitOperatingSystem) { "win-x64" } else { "win-x86" }
    if ($Rids -contains $hostRid) {
        Write-Host "--- 烟雾测试 ($hostRid)：运行测试套件 ---"
        $exe = Join-Path $Dist "dynobox-win-$hostRid\dynobox.exe"
        $ep = Start-Process -FilePath $exe -ArgumentList "endpoint", "--port", "8080" -PassThru -WindowStyle Hidden
        try {
            Start-Sleep -Seconds 2
            & $exe run --src (Join-Path $Root "examples\src") `
                --policy (Join-Path $Root "examples\rules.toml") `
                --upstream http://127.0.0.1:8080/decide `
                -- cmd /c tests\run_tests.bat
            if ($LASTEXITCODE -ne 0) { throw "烟雾测试失败（退出码 $LASTEXITCODE）" }
            Write-Host "烟雾测试通过。"
        } finally {
            if ($ep -and -not $ep.HasExited) { Stop-Process -Id $ep.Id -Force }
        }
    } else {
        Write-Host "宿主架构不在构建列表内，跳过烟雾测试。"
    }
}
