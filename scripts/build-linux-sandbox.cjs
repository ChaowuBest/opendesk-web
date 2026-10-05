/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// Linux 动态沙箱（dynobox）构建：make（LD_PRELOAD 版，源码与 OpenHarmony 共用
// native/openharmony/sandbox/src 的同一份 C 源码），产物按目标 triple 就位
// native/linux/sandbox/runtime/<triple>/{dynobox,libdynobox.so}。开发运行
// （dev/CLI 环境）直接使用 runtime/<triple>/ 产物（resolveLinuxSandboxExecutable
// 的开发路径）；打包阶段由 forge stageLinuxSandboxResource 从 runtime/<triple>/ 取。
//
// 架构策略（解决 x86/arm64 打包）：
// - 本机构建：默认按宿主架构（make 天然构建 host），产物落 runtime/<host-triple>/；
// - 交叉构建：设置 OPENDESK_SANDBOX_TARGET=<rust target triple>（如
//   aarch64-unknown-linux-gnu），自动推导交叉 gcc（aarch64-linux-gnu-gcc，可用
//   OPENDESK_SANDBOX_CC 显式覆盖）。需要对应交叉工具链（如 Debian/Ubuntu 的
//   gcc-aarch64-linux-gnu）。
// - forge stageLinuxSandboxResource 按打包目标架构取对应 triple 产物并校验
//   ELF e_machine：缺失或架构不符直接报错，绝不静默打入错架构二进制。

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ARCH_TO_TRIPLE, assertLinuxElfMachine } = require('./packaging/linux-sandbox-arch.cjs');

const root = path.resolve(__dirname, '..');
// OPENDESK_TARGET_PLATFORM 环境变量声明目标平台，由构建工程按进程注入。
if (process.platform !== 'linux' || process.env.OPENDESK_TARGET_PLATFORM === 'ohos') {
    process.stdout.write('[sandbox-linux] Linux-only native build skipped on this platform.\n');
    process.exit(0);
}

const sandboxRoot = path.join(root, 'native', 'linux', 'sandbox');
if (!fs.existsSync(path.join(sandboxRoot, 'Makefile'))) {
    process.stderr.write(`[sandbox-linux] Makefile missing at ${sandboxRoot}\n`);
    process.exit(1);
}

// 宿主 make runtime 落盘目录的 triple（与 native/linux/sandbox/Makefile 的
// RUNTIME_TARGET ?= $(shell uname -m)-unknown-linux-gnu 约定一致）。
function hostTriple() {
    let arch = null;
    try {
        arch = execSync('uname -m', { encoding: 'utf8' }).trim();
    } catch {
        // uname 不可用（理论上 Linux 必有）：交给 process.arch 映射兜底
    }
    if (arch) {
        for (const triple of Object.values(ARCH_TO_TRIPLE)) {
            if (triple.startsWith(`${arch}-`)) return triple;
        }
    }
    return ARCH_TO_TRIPLE[process.arch] || null;
}

// rust 风格 triple → 交叉 gcc（如 aarch64-unknown-linux-gnu →
// aarch64-linux-gnu-gcc）。仅交叉构建使用；本机构建走 Makefile 默认 CC ?= gcc。
function ccForCrossTriple(triple) {
    return `${triple.split('-')[0]}-linux-gnu-gcc`;
}

const targetTriple = process.env.OPENDESK_SANDBOX_TARGET || null;
const hostT = hostTriple();
const buildTriple = targetTriple || hostT;
if (!buildTriple) {
    process.stderr.write(
        `[sandbox-linux] 无法确定构建 triple（uname 不可用且 ARCH_TO_TRIPLE 无 ${process.arch} 映射）\n`
    );
    process.exit(1);
}

// 先 make 产出 build/{dynobox,libdynobox.so}，再 make runtime 落盘
// runtime/<triple>/（runtime 目标依赖 build/ 产物，自动触发全量编译）。
// make 缺失时 execSync 直接抛错（fail-fast）。
execSync('make', { cwd: sandboxRoot, stdio: 'inherit' });

const isCross = targetTriple !== null && targetTriple !== hostT;
if (isCross) {
    // 交叉构建：显式传 RUNTIME_TARGET 与交叉 CC；预检工具链存在，给出可操作的修复提示。
    const cc = process.env.OPENDESK_SANDBOX_CC || ccForCrossTriple(targetTriple);
    try {
        execSync(`command -v "${cc}"`, { stdio: 'ignore' });
    } catch {
        process.stderr.write(
            `[sandbox-linux] 交叉编译器 ${cc} 未找到，请先安装，例如:\n` +
                `  Debian/Ubuntu: apt install gcc-${targetTriple.split('-')[0]}-linux-gnu\n` +
                `  或设置 OPENDESK_SANDBOX_CC 指向可用的交叉 gcc\n`
        );
        process.exit(1);
    }
    execSync(`make runtime RUNTIME_TARGET=${targetTriple} CC="${cc}"`, { cwd: sandboxRoot, stdio: 'inherit' });
} else {
    // 本机构建（含 OPENDESK_SANDBOX_TARGET 恰为宿主 triple 的情形）：用默认 CC。
    execSync(`make runtime RUNTIME_TARGET=${buildTriple}`, { cwd: sandboxRoot, stdio: 'inherit' });
}

// 构建后立即自检 ELF 架构（与构建目标架构一致；host 构建时亦校验一次，防工具链
// 异常产出）。dynobox 与 libdynobox.so 同为 ELF，逐个校验。
const runtimeDir = path.join(sandboxRoot, 'runtime', buildTriple);
const expectedArch =
    Object.keys(ARCH_TO_TRIPLE).find((arch) => ARCH_TO_TRIPLE[arch] === buildTriple) ||
    (process.arch in ARCH_TO_TRIPLE ? process.arch : null);
if (expectedArch) {
    for (const name of ['dynobox', 'libdynobox.so']) {
        const stagedPath = path.join(runtimeDir, name);
        try {
            assertLinuxElfMachine(stagedPath, expectedArch);
        } catch (error) {
            process.stderr.write(`[sandbox-linux] ${error.message}\n`);
            process.exit(1);
        }
    }
}

process.stdout.write(
    `[sandbox-linux] built: ${path.join(runtimeDir, 'dynobox')} + ${path.join(runtimeDir, 'libdynobox.so')} (triple=${buildTriple})\n`
);
