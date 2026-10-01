/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// 构建 Windows 沙箱（Detours 实现：sandbox.exe + sandbox_hook.dll，MSVC + nmake）。
// 仅在 Windows 构建机 + Windows 目标平台时构建；OHOS 交叉构建通过
// OPENDESK_TARGET_PLATFORM 环境变量声明目标平台，由构建工程按进程注入。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32' || process.env.OPENDESK_TARGET_PLATFORM === 'ohos') {
    process.stdout.write('[sandbox] Windows-only native build skipped on this platform.\n');
    process.exit(0);
}

const root = path.resolve(__dirname, '..');
const sandboxRoot = path.join(root, 'native', 'windows', 'sandbox');
const nativeDir = path.join(sandboxRoot, 'src');

// RID -> MSVC ARCH（hook DLL 与管理进程按目标进程架构选择）
const ridArch = { 'win-x64': 'x64', 'win-x86': 'x86', 'win-arm64': 'arm64' };
const hookDllName = { x64: 'sandbox_hook.dll', x86: 'sandbox_hook32.dll', arm64: 'sandbox_hook.dll' };

const ridList = (process.env.OPENDESK_SANDBOX_RIDS || 'win-x64')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

for (const rid of ridList) {
    const arch = ridArch[rid];
    if (!arch) throw new Error(`Unsupported Windows sandbox RID: ${rid}`);

    // MSVC + nmake 构建（src/build-native.cjs 定位 vcvars 并驱动 nmake）
    const result = spawnSync(process.execPath, [path.join(nativeDir, 'build-native.cjs'), arch], {
        cwd: nativeDir,
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);

    // hook DLL 按架构命名（管理进程按目标进程位数选择：sandbox_hook.dll=64 位、
    // sandbox_hook32.dll=32 位），不做重命名。
    const binDir = path.join(sandboxRoot, 'dist', rid, 'bin');
    const expectedHook = hookDllName[arch];
    for (const file of ['sandbox.exe', expectedHook]) {
        const source = path.join(binDir, file);
        if (!fs.existsSync(source)) {
            throw new Error(`sandbox build output is missing: ${source}`);
        }
    }
    process.stdout.write(`[sandbox] ${rid}: ${path.join(binDir, 'sandbox.exe')}\n`);
}

// 开发态也使用固定路径，避免 Electron 的当前工作目录变化导致找不到二进制。
// 管理进程与 hook DLL 必须同目录（子进程经 PATH 前置解析 hook DLL）。
const runtimeRid =
    process.env.OPENDESK_SANDBOX_RUNTIME_RID ||
    (process.arch === 'arm64' ? 'win-arm64' : process.arch === 'ia32' ? 'win-x86' : 'win-x64');
const runtimeSourceDir = path.join(sandboxRoot, 'dist', runtimeRid, 'bin');
const runtimeDirectory = path.join(sandboxRoot, 'runtime');
fs.mkdirSync(runtimeDirectory, { recursive: true });
const runtimeTarget = path.join(runtimeDirectory, 'sandbox.exe');

try {
    fs.copyFileSync(path.join(runtimeSourceDir, 'sandbox.exe'), runtimeTarget);
    fs.copyFileSync(
        path.join(runtimeSourceDir, hookDllName[ridArch[runtimeRid]]),
        path.join(runtimeDirectory, hookDllName[ridArch[runtimeRid]])
    );
} catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
        throw new Error(
            `Cannot update the development sandbox because ${runtimeTarget} is in use. ` +
                'Stop the running sandbox process and retry the build.'
        );
    }
    throw error;
}
process.stdout.write(`[sandbox] development runtime: ${runtimeTarget}\n`);
