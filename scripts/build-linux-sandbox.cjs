/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// Linux 动态沙箱（dynobox-linux）构建：cargo build --release，产物按目标 triple
// 就位 native/linux/sandbox/runtime/<triple>/dynobox-linux。开发运行（dev/CLI 环境）
// 直接使用 target/<triple>/release 产物（resolveLinuxSandboxExecutable 兜底路径）；
// 打包阶段由 forge stageLinuxSandboxResource 从 runtime/<triple>/ 取。
//
// 架构策略（解决 x86/arm64 打包）：
// - 本机构建：默认按宿主架构（cargo 天然构建 host），产物落 runtime/<host-triple>/；
// - 交叉构建：设置 OPENDESK_SANDBOX_TARGET=<rustc target triple>（如
//   aarch64-unknown-linux-gnu），产物落 runtime/<triple>/。需要
//   `rustup target add <triple>` 与交叉链接器（如 gcc-aarch64-linux-gnu）。
// - forge stageLinuxSandboxResource 按打包目标架构取对应 triple 产物并校验
//   ELF e_machine：缺失或架构不符直接报错，绝不静默打入错架构二进制。

const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
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
if (!fs.existsSync(path.join(sandboxRoot, 'Cargo.toml'))) {
    process.stderr.write(`[sandbox-linux] Cargo project missing at ${sandboxRoot}\n`);
    process.exit(1);
}

// fuser 依赖的源码准备：仓库不跟踪第三方源码树（vendor/ 被 .gitignore 排除，仅作本地
// 构建缓存）。构建时若 vendor/fuser 缺失或仓库 patch 文件已更新，则从 crates.io 下载
// 指定版本 .crate、解压，并应用 native/linux/sandbox/patches/ 下的补丁。
const FUSER_VERSION = '0.15.1';
const FUSER_CRATE_NAME = `fuser-${FUSER_VERSION}.crate`;
// 默认官方源；网络受限时可经 OPENDESK_FUSER_CRATE_URL 覆盖为镜像地址
// （如 rsproxy.cn: https://rsproxy.cn/api/v1/crates/fuser/0.15.1/download）
const FUSER_CRATE_URL =
    process.env.OPENDESK_FUSER_CRATE_URL || `https://static.crates.io/crates/fuser/${FUSER_CRATE_NAME}`;

function downloadSync(dest, url) {
    try {
        execSync(`curl -fsSL --retry 3 --connect-timeout 15 -o "${dest}" "${url}"`, {
            stdio: ['ignore', 'ignore', 'inherit']
        });
    } catch {
        fs.rmSync(dest, { force: true });
        process.stderr.write(
            `[sandbox-linux] 下载 fuser crate 失败：${url}\n` +
                `  请检查网络，或设置 OPENDESK_FUSER_CRATE_URL 指向可用镜像下载地址\n`
        );
        process.exit(1);
    }
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
        process.stderr.write(`[sandbox-linux] 下载结果为空文件：${url}\n`);
        process.exit(1);
    }
}

function ensureFuserSource() {
    const vendorDir = path.join(sandboxRoot, 'vendor');
    const fuserDir = path.join(vendorDir, 'fuser');
    const cratePath = path.join(vendorDir, 'cache', FUSER_CRATE_NAME);
    const patchFile = path.join(sandboxRoot, 'patches', `fuser-${FUSER_VERSION}.patch`);
    const patchDigest = fs.existsSync(patchFile)
        ? crypto.createHash('sha256').update(fs.readFileSync(patchFile)).digest('hex')
        : '';
    const marker = path.join(fuserDir, '.patched');

    // 已就绪：源码存在且其 patch 版本与仓库当前 patch 一致（patch 更新后自动重打）
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === patchDigest) {
        process.stdout.write(
            `[sandbox-linux] fuser ${FUSER_VERSION} source ready (patch ${patchDigest.slice(0, 8)})\n`
        );
        return;
    }
    if (fs.existsSync(fuserDir)) {
        fs.rmSync(fuserDir, { recursive: true, force: true });
    }
    // .crate 缓存可跨次构建复用；缺失或为空时重新下载
    if (!fs.existsSync(cratePath) || fs.statSync(cratePath).size === 0) {
        fs.mkdirSync(path.dirname(cratePath), { recursive: true });
        process.stdout.write(`[sandbox-linux] downloading ${FUSER_CRATE_URL}\n`);
        downloadSync(cratePath, FUSER_CRATE_URL);
    }
    fs.mkdirSync(fuserDir, { recursive: true });
    execSync(`tar xzf "${cratePath}" -C "${fuserDir}" --strip-components=1`, { stdio: 'inherit' });
    if (!fs.existsSync(path.join(fuserDir, 'Cargo.toml'))) {
        process.stderr.write(`[sandbox-linux] fuser crate 解压异常：缺少 Cargo.toml（${cratePath}）\n`);
        process.exit(1);
    }
    execSync(`patch -p1 < "${patchFile}"`, { cwd: fuserDir, stdio: 'inherit' });
    fs.writeFileSync(marker, patchDigest);
    process.stdout.write(
        `[sandbox-linux] fuser ${FUSER_VERSION} source prepared (downloaded + patched ${patchDigest.slice(0, 8)})\n`
    );
}
ensureFuserSource();

// 宿主 rustc host triple（cargo build 无 --target 时的产物目录 target/release）
function hostTriple() {
    try {
        const verbose = execSync('rustc -vV', { encoding: 'utf8' });
        const match = /^host:\s*(\S+)$/m.exec(verbose);
        if (match) return match[1];
    } catch {
        // rustc 不可用：后续 cargo build 会失败并给出明确错误
    }
    return ARCH_TO_TRIPLE[process.arch] || null;
}

const targetTriple = process.env.OPENDESK_SANDBOX_TARGET || null;
const buildTriple = targetTriple || hostTriple();
let builtPath;

if (targetTriple) {
    // 交叉构建预检：rustup 存在时确认 target 已安装，缺失给出可操作的修复提示
    // （cargo 原始报错只有 "target may not be installed"，不利于定位）
    try {
        const installed = execSync('rustup target list --installed', { encoding: 'utf8' });
        if (!installed.split(/\s+/).includes(targetTriple)) {
            process.stderr.write(
                `[sandbox-linux] rustc target ${targetTriple} 未安装，请先执行:\n` +
                    `  rustup target add ${targetTriple}\n` +
                    `（交叉链接器也需就绪，如 Debian/Ubuntu 的 gcc-aarch64-linux-gnu）\n`
            );
            process.exit(1);
        }
    } catch {
        // rustup 不存在（如直接用发行版 rustc）：跳过预检，交给 cargo 报错
    }
    builtPath = path.join(sandboxRoot, 'target', targetTriple, 'release', 'dynobox-linux');
    execSync(`cargo build --release --target ${targetTriple}`, { cwd: sandboxRoot, stdio: 'inherit' });
} else {
    builtPath = path.join(sandboxRoot, 'target', 'release', 'dynobox-linux');
    execSync('cargo build --release', { cwd: sandboxRoot, stdio: 'inherit' });
}

// 产物落盘 runtime/<triple>/dynobox-linux；构建后立即自检 ELF 架构
// （与构建目标架构一致；host 构建时亦校验一次，防工具链异常产出）
const runtimeDir = path.join(sandboxRoot, 'runtime', buildTriple);
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(builtPath, path.join(runtimeDir, 'dynobox-linux'));

const expectedArch =
    Object.keys(ARCH_TO_TRIPLE).find((arch) => ARCH_TO_TRIPLE[arch] === buildTriple) ||
    (process.arch in ARCH_TO_TRIPLE ? process.arch : null);
if (expectedArch) {
    const stagedPath = path.join(runtimeDir, 'dynobox-linux');
    try {
        assertLinuxElfMachine(stagedPath, expectedArch);
    } catch (error) {
        process.stderr.write(`[sandbox-linux] ${error.message}\n`);
        process.exit(1);
    }
}

process.stdout.write(`[sandbox-linux] built: ${path.join(runtimeDir, 'dynobox-linux')} (triple=${buildTriple})\n`);
