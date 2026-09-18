/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 仅在 Windows 构建机 + Windows 目标平台时构建沙箱；OHOS 交叉构建通过
// OPENDESK_TARGET_PLATFORM 环境变量声明目标平台，由构建工程按进程注入。
if (process.platform !== 'win32' || process.env.OPENDESK_TARGET_PLATFORM === 'ohos') {
    process.stdout.write('[sandbox] Windows-only native build skipped on this platform.\n');
    process.exit(0);
}

const root = path.resolve(__dirname, '..');
const sandboxRoot = path.join(root, 'native', 'windows', 'sandbox');
const project = path.join(sandboxRoot, 'src', 'Dynobox', 'Dynobox.csproj');
const ridList = (process.env.OPENDESK_SANDBOX_RIDS || 'win-x64,win-arm64')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const dokanVersion = process.env.OPENDESK_DOKAN_VERSION || '2.3.1.1000';
const dokanNames = {
    'win-x86': 'Dokan_x86.msi',
    'win-x64': 'Dokan_x64.msi',
    'win-arm64': 'Dokan_ARM64.msi'
};

function ensureDokanMsi(rid) {
    const name = dokanNames[rid];
    if (!name) throw new Error(`Unsupported Windows sandbox RID: ${rid}`);
    const setupDirectory = path.join(sandboxRoot, '_setup');
    const target = path.join(setupDirectory, name);
    fs.mkdirSync(setupDirectory, { recursive: true });

    const ridEnv = `OPENDESK_DOKAN_MSI_${rid.toUpperCase().replaceAll('-', '_')}`;
    const supplied = process.env[ridEnv] || (rid === 'win-x64' ? process.env.OPENDESK_DOKAN_MSI : undefined);
    if (supplied && !fs.existsSync(target)) {
        fs.copyFileSync(path.resolve(supplied), target);
    }

    const isComplete = () => fs.existsSync(target) && fs.statSync(target).size > 4 * 1024 * 1024;
    if (!isComplete()) {
        const url = `https://github.com/dokan-dev/dokany/releases/download/v${dokanVersion}/${name}`;
        process.stdout.write(`[sandbox] downloading Dokany ${name}...\n`);
        const result = spawnSync(
            process.env.CURL_EXE || 'curl.exe',
            ['-fL', '--retry', '3', '--connect-timeout', '20', '--max-time', '180', '-o', target, url],
            { cwd: root, stdio: 'inherit' }
        );
        if (result.error) throw result.error;
        if (result.status !== 0 || !isComplete()) {
            throw new Error(
                `Dokan MSI is unavailable: ${target}. Set OPENDESK_DOKAN_MSI to a downloaded ${name} file.`
            );
        }
    }
    return target;
}

for (const rid of ridList) {
    const binDir = path.join(sandboxRoot, 'dist', rid, 'bin');
    const result = spawnSync(
        process.env.DOTNET_EXE || 'dotnet',
        [
            'publish',
            project,
            '-c',
            'Release',
            '-r',
            rid,
            '--self-contained',
            'true',
            '-p:PublishSingleFile=true',
            '-p:DebugType=none',
            '-p:PublishReadyToRun=false',
            '--nologo',
            '-o',
            binDir
        ],
        { cwd: sandboxRoot, stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    const source = path.join(binDir, 'dynobox.exe');
    const target = path.join(binDir, 'sandbox.exe');
    if (!fs.existsSync(source)) {
        throw new Error(`dynobox publish output is missing: ${source}`);
    }
    fs.copyFileSync(source, target);
    fs.rmSync(source);
    const dokanMsi = ensureDokanMsi(rid);
    fs.copyFileSync(dokanMsi, path.join(binDir, 'DokanSetup.msi'));
    process.stdout.write(`[sandbox] ${rid}: ${target}\n`);
}

// 开发态也使用固定路径，避免 Electron 的当前工作目录变化导致找不到二进制。
const runtimeRid =
    process.env.OPENDESK_SANDBOX_RUNTIME_RID ||
    (process.arch === 'arm64' ? 'win-arm64' : process.arch === 'ia32' ? 'win-x86' : 'win-x64');
const runtimeSource = path.join(sandboxRoot, 'dist', runtimeRid, 'bin', 'sandbox.exe');
if (!fs.existsSync(runtimeSource)) {
    throw new Error(`Runtime sandbox build is missing: ${runtimeSource}`);
}
const runtimeDirectory = path.join(sandboxRoot, 'runtime');
fs.mkdirSync(runtimeDirectory, { recursive: true });
const runtimeTarget = path.join(runtimeDirectory, 'sandbox.exe');

try {
    fs.copyFileSync(runtimeSource, runtimeTarget);
} catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
        throw new Error(
            `Cannot update the development sandbox because ${runtimeTarget} is in use. ` +
                'Stop the running Dynobox sandbox process and retry the build.'
        );
    }
    throw error;
}
const runtimeShim = path.join(path.dirname(runtimeSource), 'NodeChildProcessCompat.cjs');
if (fs.existsSync(runtimeShim)) fs.copyFileSync(runtimeShim, path.join(runtimeDirectory, 'NodeChildProcessCompat.cjs'));
process.stdout.write(`[sandbox] development runtime: ${runtimeTarget}\n`);
