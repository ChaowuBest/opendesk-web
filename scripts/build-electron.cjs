#!/usr/bin/env node

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
 * 并行驱动 electron-vite 构建。
 *
 * electron-vite 的 `build` 会按 main → preload → renderer 顺序串行构建三个环境。
 * 其中 renderer（~48s）与 main（~26s）互不依赖、输出目录也不同
 * （dist/main、dist/preload 与 dist/renderer），串行执行白等一半时间。
 * 这里用 electron.vite.config.ts 里的 OPENDESK_VITE_TARGET 开关把 main+preload
 * 与 renderer 拆成两个进程同时构建，实测 75s → ~52s。产物与串行构建逐文件一致
 * （同为 650 个文件，路径 / 文件名 / 体积相同），唯一例外是 dist/main 主进程 bundle
 * 内嵌的 __BUILD_TIME__ —— 它取构建时刻，任意两次构建的字节都不同（与是否并行
 * 无关），比对产物时要排除这一段。
 *
 * 回退：内存或核数吃紧的机器用 OPENDESK_BUILD_SEQUENTIAL=1，脚本会退回单进程
 * 顺序构建；核数少于 6 时自动串行，避免抢占导致反而更慢。
 *
 * 堆参数：rollup 打包会产生大量短命对象（AST、字符串），CPU profile 里 GC 约占
 * renderer 构建时长的 20%。放大新生代（--max-semi-space-size）后实测 renderer
 * 41.5s → 35.5s、main 22.4s → 21.2s。取值按物理内存量级选择，小内存机器不加。
 *
 * 注意：preload 与 main 共享构建环境，必须留在同一进程内（preload 只有 ~0.3s）。
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_VITE_BIN = path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const MIN_CORES_FOR_PARALLEL = 6;

const extraArgs = process.argv.slice(2);

/** 按物理内存决定新生代大小（MB），返回空数组表示沿用 Node 默认值 */
function resolveHeapArgs() {
    const totalGb = os.totalmem() / 1024 ** 3;
    const semiSpaceMb = totalGb >= 16 ? 128 : totalGb >= 8 ? 96 : totalGb >= 4 ? 64 : 0;
    return semiSpaceMb ? [`--max-semi-space-size=${semiSpaceMb}`] : [];
}

/** 启动一次 electron-vite build，target 为空表示按原顺序构建全部环境 */
function runBuild(target) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        if (target) env.OPENDESK_VITE_TARGET = target;
        const child = spawn(
            process.execPath,
            [...resolveHeapArgs(), ELECTRON_VITE_BIN, 'build', '--ignoreConfigWarning', ...extraArgs],
            {
                cwd: ROOT,
                stdio: 'inherit',
                env
            }
        );
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
}

async function main() {
    const cores = os.cpus().length;
    if (process.env.OPENDESK_BUILD_SEQUENTIAL === '1' || cores < MIN_CORES_FOR_PARALLEL) {
        if (cores < MIN_CORES_FOR_PARALLEL) {
            process.stdout.write(`[build] 检测到 ${cores} 个 CPU 核心，改为顺序构建\n`);
        }
        process.exit(await runBuild());
    }

    process.stdout.write('[build] 并行构建 main+preload 与 renderer（顺序构建：OPENDESK_BUILD_SEQUENTIAL=1）\n');
    const [mainCode, rendererCode] = await Promise.all([runBuild('main'), runBuild('renderer')]);
    if (mainCode !== 0 || rendererCode !== 0) {
        console.error(`[build] 构建失败：main+preload 退出码 ${mainCode}，renderer 退出码 ${rendererCode}`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`[build] 构建进程启动失败：${error?.message || error}`);
    process.exit(1);
});
