/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// 构建 sandbox.exe + sandbox_hook.dll（Detours 实现，MSVC + nmake）。
// 用法: node build-native.cjs [x64|x86]
// 成功时只输出一行简短结论；失败时输出完整构建日志（nmake/cl 详情）。
const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const arch = process.argv[2] || 'x64';
const nativeDir = __dirname;

function findVsInstall() {
    const candidates = [
        process.env.VSINSTALLDIR,
        'C:\\Program Files\\Microsoft Visual Studio\\18\\Community',
        'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\Community'
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) return c;
    }
    try {
        const out = execFileSync(            'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
            ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
            { encoding: 'utf8' }
        ).trim();
        if (out && fs.existsSync(path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) return out;
    } catch { /* ignore */ }
    return null;
}

const vs = findVsInstall();
if (!vs) {
    console.error('[native] Visual Studio (MSVC) 未找到，无法构建 sandbox native');
    process.exit(1);
}
const vcvars = arch === 'x86'
    ? path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars32.bat')
    : arch === 'arm64'
    ? path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvarsamd64_arm64.bat')
    : path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

// 生成临时 cmd 脚本再执行：绕开 cmd /c 与引号/&& 的转义问题
const tmpScript = path.join(os.tmpdir(), `build-native-${arch}-${process.pid}.cmd`);
fs.writeFileSync(tmpScript, [
    '@echo off',
    `call "${vcvars}" >nul 2>&1`,
    `cd /d "${nativeDir}"`,
    `nmake /nologo /f Makefile ARCH=${arch}`,
    `exit /b %ERRORLEVEL%`
].join('\r\n'));

try {
    // 用 buffer 捕获并原样透出：cl 在中文系统按 GBK 输出，utf8 解码会乱码
    const out = spawnSync('cmd.exe', ['/d', '/c', tmpScript], { encoding: 'buffer', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (out.error || out.status !== 0) {
        // 失败：完整输出（nmake/cl 的 stdout+stderr）
        if (out.stdout && out.stdout.length) process.stdout.write(out.stdout);
        if (out.stderr && out.stderr.length) process.stderr.write(out.stderr);
        if (out.error) console.error(out.error.message);
        process.exit(out.status ?? 1);
    }
    // 成功：仅输出简短结论（完整构建日志被丢弃）
    console.log(`[native] sandbox ${arch} 构建成功`);
} finally {
    fs.rmSync(tmpScript, { force: true });
}
