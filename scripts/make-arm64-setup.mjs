/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 一条命令产出 Windows ARM64 原生安装包：npm run make:win32:arm64
 *
 * 链路：npm run build → electron-forge make（--arch=arm64，OPENDESK_WIX_ARCH=arm64）
 *       → build-wix-bootstrapper.mjs（指到 arm64 MSI / staged 应用 / Dokan ARM64 驱动）
 *
 * 环境前提（开发机需在系统/用户环境变量中配置，见团队构建文档）：
 * - PATH 含 WiX Toolset v3.14 bin（maker-wix 查找 candle.exe/light.exe）
 * - PATH 含 dotnet 或设置 DOTNET_EXE（build-sandbox:windows 编译沙箱）
 * - NODE_OPTIONS 由仓库 .npmrc 的 node-options 自动注入（Rollup 压缩大 chunk 需要 8GB 堆）
 *
 * 为什么必须走 arm64 专属链路：x64 Dokan 内核驱动在 ARM64 Windows 上无法加载
 * （ERROR_DRIVER_BLOCKED），bundle 里的 Dokan_x64.msi 会导致安装以 0x80070643 失败，
 * 因此 Dokan 驱动必须换成 win-arm64 的 DokanSetup.msi。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

if (process.platform !== 'win32') {
    throw new Error('make:win32:arm64 仅支持在 Windows 上运行');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const wixOutDir = path.join(projectRoot, 'out', 'make', 'wix', 'arm64');

function run(command, args, env) {
    // shell:true 下 spawnSync 不会给参数加引号，process.execPath 含空格
    // （C:\Program Files\...）会被 cmd 拆坏，必须对含空格的部分手动加引号
    const commandLine = [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
    const result = spawnSync(commandLine, {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...env }
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
    }
}

// 1. 构建应用（插件 + win-arm64/win-x64 沙箱 + electron-vite）
run('npm', ['run', 'build']);

// 2. 打包 arm64 应用并生成 arm64 MSI
//    --arch=arm64 决定 Electron 运行时与 staged 目录（out/opendesk-win32-arm64），
//    OPENDESK_WIX_ARCH=arm64 决定 MSI 的平台标记（forge.config.cjs maker-wix）
run('npx', ['electron-forge', 'make', '--platform=win32', '--arch=arm64'], {
    OPENDESK_WIX_ARCH: 'arm64'
});

// 3. 生成带 Dokan ARM64 驱动的 Setup.exe，四个路径全部指到 arm64 产物
const arm64Env = {
    OPENDESK_WIX_ARCH: 'arm64',
    OPENDESK_MSI_PATH: path.join(wixOutDir, 'opendesk.msi'),
    OPENDESK_STAGED_APP_DIR: path.join(projectRoot, 'out', 'opendesk-win32-arm64'),
    OPENDESK_DOKAN_MSI_PATH: path.join(
        projectRoot,
        'native',
        'windows',
        'sandbox',
        'dist',
        'win-arm64',
        'bin',
        'DokanSetup.msi'
    ),
    OPENDESK_SETUP_OUT_DIR: wixOutDir
};
run(process.execPath, [path.join('scripts', 'build-wix-bootstrapper.mjs')], arm64Env);

const setupPath = path.join(wixOutDir, `OpenDesk-${packageJson.version}-Setup.exe`);
if (!fs.existsSync(setupPath)) {
    throw new Error(`未找到安装包产物: ${setupPath}`);
}
console.log(`ARM64 安装包构建完成: ${setupPath}`);
