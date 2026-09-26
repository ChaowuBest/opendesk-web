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
 * electron-forge 打包瘦身辅助：
 *  - PACKAGING_IGNORE_PATTERNS：复制阶段（packagerConfig.ignore）直接排除的整目录/文件；
 *  - prunePackagedNativeArtifacts：afterPrune 阶段清理原生包的编译产物与跨平台 prebuilds
 *    （需要按 (platform, arch) 参数化，无法用静态 ignore 表达）；
 *  - prunePackagedShellArtifacts：afterPrune 阶段清理 Electron 本体的多语言 .pak 与
 *    Chromium 许可证清单（win32/linux 平铺布局；darwin 的同类资源位于签名过的
 *    Framework 内，不在本模块处理范围）。
 *
 * 剪裁原则：只删除可证明与运行时无关的产物。
 *  - node-pty 的 utils.js 依次尝试 build/Release → build/Debug → prebuilds/<plat>-<arch>，
 *    Electron 重编译出的 build/Release/*.node 必须保留，只清 .pdb/.lib/obj 等构建垃圾；
 *  - classic-level 经 node-gyp-build 加载，保留 build/Release/*.node 与目标平台 prebuilds；
 *  - better-sqlite3 只清 C++ 源码 amalgamation（deps/），保留编译好的 .node。
 */

const fs = require('fs');
const path = require('path');

/**
 * 复制阶段即可安全排除的路径（相对应用根目录，兼容 / 与 \ 分隔符）。
 * 必须同时出现在 forge.config.cjs 的 packagerConfig.ignore 中（测试有守卫）。
 */
const PACKAGING_IGNORE_PATTERNS = [
    // CLI 独立产物（build-cli 生成），GUI 运行时只走 resourcesPath，不读 asar 内的 dist/cli
    /^[/\\]dist[/\\]cli(?:-release)?(?:[/\\]|$)/,
    // TypeScript 源码不进包（dist/main 才是运行入口）
    /^[/\\]src(?:[/\\]|$)/,
    // Windows 沙箱由 afterCopyExtraResources 按目标架构单独放入 resources/sandbox；
    // native/windows/sandbox 下还包含另一架构、开发 runtime、Dokan 缓存和 .NET 构建目录，
    // 这些都不能随应用源码进入 app.asar。
    /^[/\\]native[/\\]windows[/\\]sandbox(?:[/\\]|$)/,
    // workspace SDK 的嵌套 node_modules 是本地开发安装的开发依赖，运行时只读其 dist
    /^[/\\]packages[/\\](?:app-sdk|plugin-sdk)[/\\]node_modules(?:[/\\]|$)/,
    // Linux 沙箱同理：整树（源码/vendor/target/tests）不进 asar；发布态二进制由
    // stageLinuxSandboxResource 按目标架构放入 resources/sandbox/dynobox-linux。
    // （追加在末尾：packaged-artifacts.test.ts 按位置解构前四个模式）
    /^[/\\]native[/\\]linux[/\\]sandbox(?:[/\\]|$)/
];

// node-gyp 构建垃圾：调试符号、静态库、链接中间产物与 MSVC 工程文件
const NATIVE_JUNK_FILE_PATTERN = /\.(pdb|lib|exp|iobj|ipdb)$|\.vcxproj(\.filters)?$|\.sln$|(^|[\\/])config\.gypi$/;
const NATIVE_JUNK_DIRECTORY_NAMES = new Set(['obj', 'deps']);

// 打包版保留的 Electron 多语言资源；应用自身仅提供 zh-CN 与 en-US 文案
const PRUNE_LOCALE_ALLOWLIST = new Set(['en-US.pak', 'zh-CN.pak']);

// 编译输入型原生包：清 deps/src 与构建垃圾（保留编译产物 .node）
const NATIVE_PACKAGES_WITH_BUILD_OUTPUT = ['better-sqlite3', 'classic-level', 'node-pty'];

function pathSize(targetPath) {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        total += pathSize(path.join(targetPath, entry.name));
    }
    return total;
}

function removePath(targetPath) {
    const removed = pathSize(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    return removed;
}

function isJunkDirectory(entry) {
    return entry.isDirectory() && NATIVE_JUNK_DIRECTORY_NAMES.has(entry.name);
}

function pruneNativeBuildJunkWithin(directory) {
    let removed = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (isJunkDirectory(entry)) {
            removed += removePath(fullPath);
        } else if (entry.isDirectory()) {
            removed += pruneNativeBuildJunkWithin(fullPath);
        } else if (NATIVE_JUNK_FILE_PATTERN.test(entry.name)) {
            removed += removePath(fullPath);
        }
    }
    return removed;
}

/**
 * prebuilds 目录名是否属于当前打包目标。
 * classic-level 等包在 darwin 使用合并目录名（darwin-x64+arm64），需一并保留。
 */
function keepNativePrebuildDirectory(name, platform, arch) {
    if (name === `${platform}-${arch}`) return true;
    return platform === 'darwin' && name === 'darwin-x64+arm64';
}

function pruneForeignPrebuilds(packageDirectory, platform, arch) {
    const prebuildsDirectory = path.join(packageDirectory, 'prebuilds');
    if (!fs.existsSync(prebuildsDirectory)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(prebuildsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!keepNativePrebuildDirectory(entry.name, platform, arch)) {
            removed += removePath(path.join(prebuildsDirectory, entry.name));
        }
    }
    return removed;
}

/**
 * 清理原生依赖的编译产物与跨平台 prebuilds。before asar 打包执行（幂等）。
 *
 * @param {string} rootPath 打包暂存的应用根目录（含 node_modules）
 * @param {string} platform 'win32' | 'darwin' | 'linux'
 * @param {string} arch 'x64' | 'arm64' | ...
 * @returns {number} 删除的字节数
 */
function prunePackagedNativeArtifacts(rootPath, platform, arch) {
    let removed = 0;
    for (const packageName of NATIVE_PACKAGES_WITH_BUILD_OUTPUT) {
        const packageDirectory = path.join(rootPath, 'node_modules', packageName);
        if (!fs.existsSync(packageDirectory)) continue;
        // deps/ 是 leveldb/winpty 等的 C++ 源码 amalgamation，仅编译期需要
        for (const sourceDirectory of ['deps', 'src']) {
            const target = path.join(packageDirectory, sourceDirectory);
            if (fs.existsSync(target)) {
                removed += removePath(target);
            }
        }
        const buildDirectory = path.join(packageDirectory, 'build');
        if (fs.existsSync(buildDirectory)) {
            removed += pruneNativeBuildJunkWithin(buildDirectory);
        }
        if (packageName !== 'better-sqlite3') {
            removed += pruneForeignPrebuilds(packageDirectory, platform, arch);
        }
    }
    return removed;
}

function pruneLocalesDirectory(rootPath) {
    const localesDirectory = path.join(rootPath, 'locales');
    if (!fs.existsSync(localesDirectory)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(localesDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() || !entry.name.endsWith('.pak')) continue;
        if (PRUNE_LOCALE_ALLOWLIST.has(entry.name)) continue;
        removed += removePath(path.join(localesDirectory, entry.name));
    }
    return removed;
}

/**
 * 清理 Electron 本体附带的非必要资源（仅 win32/linux 平铺布局，darwin 不调用）。
 * 删除 LICENSES.chromium.html 属发行版常见做法：Chromium 第三方许可已在
 * 仓库 NOTICE 与上游网站披露，随包携带的 15MB 清单仅服务合规审计场景。
 *
 * @param {string} rootPath 打包暂存的应用根目录
 * @returns {number} 删除的字节数
 */
function prunePackagedShellArtifacts(rootPath) {
    let removed = pruneLocalesDirectory(rootPath);
    const licensesPath = path.join(rootPath, 'LICENSES.chromium.html');
    if (fs.existsSync(licensesPath)) {
        removed += removePath(licensesPath);
    }
    return removed;
}

module.exports = {
    PACKAGING_IGNORE_PATTERNS,
    PRUNE_LOCALE_ALLOWLIST,
    keepNativePrebuildDirectory,
    prunePackagedNativeArtifacts,
    prunePackagedShellArtifacts,
    pruneLocalesDirectory
};
