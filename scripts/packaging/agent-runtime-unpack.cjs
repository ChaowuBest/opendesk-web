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
 * 计算 AgentGate / AgentMoss 子进程所需的「依赖闭包解包规则」。
 *
 * 背景：@kenhkl/agent-gate 与 @kenhkl/agent-moss 由 OpenDesk 以子进程方式启动
 * （spawn 系统 node 跑它们的 cli.js），而系统 node 与 libuv 都读不了 asar 虚拟路径
 * ——app.asar 在真实文件系统上只是个普通文件。因此这两个包的运行入口及其全部
 * 运行时依赖都必须落在 app.asar.unpacked 里。
 *
 * 只解包 @kenhkl 子树是不够的：npm 会把部分传递依赖 hoist 到顶层 node_modules
 * （实测有 bindings、hono、node-fetch、whatwg-url 等），子进程从
 * app.asar.unpacked 逐级向上找 node_modules 时找不到它们，表现为启动即
 * Cannot find module——且只在打包产物上复现，开发模式因应用根是真实目录而完全正常。
 *
 * ── 为什么用 unpackDir 而不是 unpack ──
 *
 * asar 的 unpack 选项是把【绝对路径】交给 minimatch（见 @electron/asar 的
 * lib/asar.js 中 shouldUnpackPath），因此模式必须写成「任意深度前缀 + node_modules
 * + 包名 + 任意深度后缀」的形式。那个任意深度前缀会连【任何层级】的同名目录一起
 * 命中——实测会把 @jimp 各 plugin-* 子包自带的 node_modules/zod、vectra 自带的
 * openai 等冗余副本也解包出来，凭空多出 1.5 万个散文件。
 *
 * unpackDir 则是对【相对目录路径】做前缀匹配，可以精确锚定到「node 运行时真正会去
 * 找的那个目录」。所以下面 BFS 时记录的是解析出的目录本身，而不是包名。
 *
 * 实测（OpenDesk 0.3.8 依赖树 / Linux x64）：
 *   - 解包文件数 23,848 → 8,410；
 *   - deb 安装包体积基本不变（+0.12%）——asar 不压缩，解包只是把字节从 app.asar
 *     挪到 app.asar.unpacked，总量不变；
 *   - deb 解包后的磁盘占用增量由 60MB 降到约 25MB（散文件按 4KB 块取整的开销）。
 */

const fs = require('fs');
const path = require('path');

/** 需要以子进程方式运行的入口包。其依赖闭包必须可从真实文件系统解析。 */
const AGENT_RUNTIME_ROOTS = ['@kenhkl/agent-gate', '@kenhkl/agent-moss'];

/**
 * 与 node 的解析规则一致：从 fromDir 起逐级向上查找 node_modules 下的目标包目录。
 * 返回包目录，找不到返回 null（与 node 一致，不抛错）。
 */
function resolvePackageDir(name, fromDir) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, 'node_modules', name, 'package.json');
        if (fs.existsSync(candidate)) {
            return path.dirname(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/**
 * 收集闭包内的包名（去重 + 排序）。
 *
 * node_modules 不存在或入口包未安装时返回空数组——由调用方回退到基础规则，
 * 不因依赖树缺失而中断打包。
 */
function collectAgentRuntimePackages(nodeModulesDir) {
    return [...iterateAgentRuntimeClosure(nodeModulesDir).keys()].sort();
}

/**
 * 收集闭包内每个包【实际解析到的目录】，相对于 nodeModulesDir 的父目录，
 * 即形如 node_modules/zod、node_modules/@kenhkl/agent-gate/node_modules/zod。
 *
 * 这是本模块的关键：只有这些目录是 node 在运行时真正会去找的位置，其余同名目录
 * （别的包自带的私有副本）不必解包，解了纯属浪费磁盘与 inode。
 */
function collectAgentRuntimeDirectories(nodeModulesDir) {
    const root = path.resolve(nodeModulesDir);
    const parentOfRoot = path.dirname(root);
    const dirs = new Set();
    for (const dir of iterateAgentRuntimeClosure(root).values()) {
        dirs.add(path.relative(parentOfRoot, dir).split(path.sep).join('/'));
    }
    return [...dirs].sort();
}

/**
 * 遍历依赖闭包，返回 Map<包名, 解析出的包目录>。
 *
 * 只跟随 dependencies + optionalDependencies（devDependencies 不进安装包）。
 * 同一个包可能被多个父包依赖，按目录去重。
 */
function iterateAgentRuntimeClosure(nodeModulesDir) {
    const root = path.resolve(nodeModulesDir);
    const visitedDirs = new Set();
    const byName = new Map();
    const queue = AGENT_RUNTIME_ROOTS.map((name) => ({ name, fromDir: root }));

    while (queue.length > 0) {
        const { name, fromDir } = queue.shift();
        const dir = resolvePackageDir(name, fromDir);
        if (!dir || visitedDirs.has(dir)) {
            continue;
        }
        visitedDirs.add(dir);
        if (!byName.has(name)) {
            byName.set(name, dir);
        }

        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        } catch {
            continue; // 个别包 package.json 损坏不应中断打包
        }
        const deps = { ...(manifest.dependencies || {}), ...(manifest.optionalDependencies || {}) };
        for (const dep of Object.keys(deps)) {
            queue.push({ name: dep, fromDir: dir });
        }
    }

    return byName;
}

/**
 * 去掉被其他条目覆盖的目录：若父目录已列出，其子目录就是冗余的
 * （unpackDir 对子路径走 startsWith，父目录命中即覆盖整棵子树）。
 * 压缩后条目数显著减少，也避免生成超长模式串。
 */
function compactDirectories(directories) {
    const sorted = [...directories].sort();
    const kept = [];
    for (const dir of sorted) {
        if (kept.some((parent) => dir === parent || dir.startsWith(`${parent}/`))) {
            continue;
        }
        kept.push(dir);
    }
    return kept;
}

/**
 * 生成 packagerConfig.asar.unpackDir 用的模式串。
 *
 * unpackDir 只接受【单个字符串】（内部先 startsWith 再 minimatch），故用花括号展开。
 * 注意这里不要加「任意深度」前缀——unpackDir 匹配的是相对目录路径，加前缀会退化成
 * 「任意深度同名目录」的老问题。
 *
 * 闭包为空（node_modules 缺失 / 入口包未安装）时回退到 @kenhkl 前缀，保持
 * 「至少把子进程入口解包出来」的既有行为。
 */
function buildAgentUnpackDirPattern(nodeModulesDir) {
    const directories = compactDirectories(collectAgentRuntimeDirectories(nodeModulesDir));
    if (directories.length === 0) {
        return 'node_modules/@kenhkl';
    }
    return `{${directories.join(',')}}`;
}

module.exports = {
    AGENT_RUNTIME_ROOTS,
    collectAgentRuntimePackages,
    collectAgentRuntimeDirectories,
    buildAgentUnpackDirPattern
};
