'use strict';

/**
 * OpenHarmony 精简打包脚本
 *
 * 用法：
 *   node scripts/package-ohos.cjs --target <鸿蒙工程 resources/app 目录>
 *
 * 示例：
 *   node scripts/package-ohos.cjs --target /d/Projects/OpenDesk-ohos/ohos_hap/web_engine/src/main/resources/resfile/resources/app
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// 参数
// ============================================================================
const args = process.argv.slice(2);
let targetDir = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && i + 1 < args.length) {
        targetDir = path.resolve(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
        printHelp();
        process.exit(0);
    }
}

if (!targetDir) {
    printHelp();
    process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const appDir = targetDir;

// 鸿蒙 = linux arm64 musl
const targetArch = 'arm64';
const targetOsPatterns = ['linux', 'aarch64.*linux'];

console.log(`=== OpenHarmony 精简打包 ===`);
console.log(`输出: ${appDir}\n`);

// ============================================================================
// 帮助
// ============================================================================
function printHelp() {
    console.log(`OpenHarmony 精简打包脚本

用法:
  node scripts/package-ohos.cjs --target <鸿蒙工程 resources/app 目录>

说明:
  从源代码分析主进程依赖 → 裁剪 node_modules → 注入 OHOS 运行时兼容 → 输出到目标目录。
  目标目录会被清空后写入。

示例:
  node scripts/package-ohos.cjs --target /d/Projects/OpenDesk-ohos/ohos_hap/web_engine/src/main/resources/resfile/resources/app
`);
}

// ============================================================================
// 强制排除的包（鸿蒙不需要或有替代方案）
// ============================================================================
const FORCE_EXCLUDE = new Set([
    'better-sqlite3', // 鸿蒙用 arkdata
    'jieba-wasm', // 鸿蒙当前无法使用wasm
    '@node-rs/jieba' // 鸿蒙无法使用预购建的 jieba
]);

// ============================================================================
// 工具函数
// ============================================================================
function removePath(p) {
    try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
}
function dirSize(dir) {
    if (!fs.existsSync(dir)) return 0;
    let s = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let e;
        try {
            e = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const en of e) {
            const fp = path.join(d, en.name);
            if (en.isSymbolicLink()) continue;
            try {
                if (en.isDirectory()) stack.push(fp);
                else s += fs.statSync(fp).size;
            } catch {}
        }
    }
    return s;
}

function copyDir(src, dst) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const s = path.join(src, e.name),
            d = path.join(dst, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function copyNmFiltered(src, dst) {
    // 跳过已知 dev 大包，加速复制
    const skip = new Set([
        'electron',
        '@electron-forge',
        '@electron',
        'electron-rebuild',
        'electron-vite',
        'vite',
        'typescript',
        'typescript-eslint',
        'eslint',
        '@eslint',
        'jest',
        '@jest',
        'ts-jest',
        'ts-node',
        'tsx',
        'prettier',
        'husky',
        'lint-staged',
        'run-script-os',
        'node-gyp',
        'react-devtools-core',
        '.vite',
        '.cache'
    ]);
    copyDirFiltered(src, dst, skip);
}

function copyDirFiltered(src, dst, skip) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        if (e.isSymbolicLink()) continue;
        const s = path.join(src, e.name),
            d = path.join(dst, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function npmExec(args, cwd) {
    return execFileSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

// ============================================================================
// 步骤 1: 分析主进程依赖闭包
// ============================================================================

/**
 * 扫描目录下所有 .ts/.js 文件的 import/require 语句，提取 npm 包名。
 */
function extractImports(dir) {
    const pkgs = new Set();
    const files = collectFiles(dir, ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

    for (const f of files) {
        let content;
        try {
            content = fs.readFileSync(f, 'utf8');
        } catch {
            continue;
        }

        // 静态 import: import ... from 'pkg' / import 'pkg'
        // 匹配普通包名和 scoped 包名（@scope/name）
        for (const m of content.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?['"])([^'"]+)['"]/g)) {
            const spec = m[1];
            // 跳过相对路径、Node.js 内置前缀（但保留 scoped 包）
            if (spec.startsWith('.') || spec.startsWith('node:')) continue;
            pkgs.add(normalizePkg(spec));
        }
        // 动态 import: import('pkg')
        for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('node:')) continue;
            pkgs.add(normalizePkg(spec));
        }
        // require: require('pkg')
        for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('node:')) continue;
            pkgs.add(normalizePkg(spec));
        }
    }

    return pkgs;
}

/** 收集指定后缀的文件 */
function collectFiles(dir, exts) {
    const result = [];
    const extSet = new Set(exts);
    function walk(d) {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const fp = path.join(d, e.name);
            if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
                walk(fp);
            } else if (e.isFile() && extSet.has(path.extname(e.name).toLowerCase())) {
                result.push(fp);
            }
        }
    }
    walk(dir);
    return result;
}

/** 处理 scoped 包名：提取 @scope/name */
function normalizePkg(spec) {
    // 'fs' → 'fs', '@scope/name' → '@scope/name', '@scope/name/sub' → '@scope/name'
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.slice(0, 2).join('/');
    }
    return spec.split('/')[0];
}

/**
 * 递归构建依赖闭包。
 * 从 node_modules 中读取每个包的 package.json，递归收集 dependencies。
 * 比 npm ls 更可靠，不受本地 file: 依赖干扰。
 */
function getDepClosure(pkgNames, nodeModulesDir) {
    const closure = new Set();
    const queue = [...pkgNames];

    while (queue.length > 0) {
        const name = queue.shift();
        if (closure.has(name)) continue;
        closure.add(name);

        const pkgJsonPath = path.join(nodeModulesDir, name, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) continue;

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        } catch {
            continue;
        }

        const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
        for (const depName of Object.keys(deps || {})) {
            if (!closure.has(depName)) {
                queue.push(depName);
            }
        }
    }

    return closure;
}

// ============================================================================
// prebuild 裁剪
// ============================================================================
const PLATFORM_DIR_RE = /^[a-z0-9]+[_-](x64|ia32|arm64|armhf|arm|riscv64d?|loong64|ppc64|s390x|universal)/i;
const TRIPLE_RE = /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+/i;

function looksLikePlatformDir(name) {
    return PLATFORM_DIR_RE.test(name) || TRIPLE_RE.test(name);
}

function isTargetPlatformDir(name) {
    const lower = name.toLowerCase();
    if (!lower.includes(targetArch)) return false;
    return targetOsPatterns.some((p) => new RegExp(p, 'i').test(lower));
}

function containsNativeFiles(dir) {
    try {
        return fs.readdirSync(dir).some((f) => {
            const ext = path.extname(f).toLowerCase();
            return ext === '.node' || ext === '.so' || ext === '.dylib' || ext === '.dll';
        });
    } catch {
        return false;
    }
}

function findPrebuildHubs(currentDir, pkgName, hubs) {
    let entries;
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return;
    }
    const platformDirs = [],
        otherDirs = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (looksLikePlatformDir(e.name) && containsNativeFiles(path.join(currentDir, e.name))) {
            platformDirs.push(e.name);
        } else {
            otherDirs.push(e);
        }
    }
    if (platformDirs.length >= 2) {
        hubs.push({ pkgName, hubPath: currentDir });
        return;
    }
    for (const e of otherDirs) findPrebuildHubs(path.join(currentDir, e.name), pkgName, hubs);
}

function discoverPrebuildHubs(nm) {
    const hubs = [];
    if (!fs.existsSync(nm)) return hubs;
    for (const p of fs.readdirSync(nm, { withFileTypes: true })) {
        if (!p.isDirectory() || p.name.startsWith('.')) continue;
        if (p.name.startsWith('@')) {
            let scoped;
            try {
                scoped = fs.readdirSync(path.join(nm, p.name), { withFileTypes: true });
            } catch {
                continue;
            }
            for (const sp of scoped) {
                if (!sp.isDirectory()) continue;
                for (const c of ['prebuilds', 'build', 'vendor']) {
                    const cp = path.join(nm, p.name, sp.name, c);
                    if (fs.existsSync(cp)) findPrebuildHubs(cp, `${p.name}/${sp.name}`, hubs);
                }
            }
        } else {
            for (const c of ['prebuilds', 'build', 'vendor']) {
                const cp = path.join(nm, p.name, c);
                if (fs.existsSync(cp)) findPrebuildHubs(cp, p.name, hubs);
            }
        }
    }
    return hubs;
}

function prunePrebuildHub(hub) {
    let kept = 0,
        pruned = 0;
    for (const e of fs.readdirSync(hub.hubPath, { withFileTypes: true })) {
        if (!e.isDirectory() || !looksLikePlatformDir(e.name)) continue;
        if (!containsNativeFiles(path.join(hub.hubPath, e.name))) continue;
        if (isTargetPlatformDir(e.name)) {
            console.log(`  [keep]  ${hub.pkgName}/${e.name}`);
            kept++;
        } else {
            console.log(`  [prune] ${hub.pkgName}/${e.name}`);
            removePath(path.join(hub.hubPath, e.name));
            pruned++;
        }
    }
    return { kept, pruned };
}

function deepPrunePrebuilds(nm) {
    const dirs = findAllPrebuildDirs(nm);
    let pruned = 0;
    for (const d of dirs) {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory() || !looksLikePlatformDir(e.name)) continue;
            if (isTargetPlatformDir(e.name)) continue;
            if (containsNativeFiles(path.join(d, e.name))) {
                removePath(path.join(d, e.name));
                pruned++;
            }
        }
    }
    if (pruned > 0) console.log(`  兜底删除 ${pruned} 个非目标平台 prebuild`);
}

function findAllPrebuildDirs(nm) {
    const result = [];
    function scan(dir, depth) {
        if (depth > 5 || !fs.existsSync(dir)) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('.')) continue;
            const fp = path.join(dir, e.name);
            if (e.name === 'prebuilds') result.push(fp);
            else if (depth < 4) scan(fp, depth + 1);
        }
    }
    scan(nm, 0);
    return result;
}

// ============================================================================
// 平台特定包 + 垃圾文件清理
// ============================================================================
const PLATFORM_TAG_RE =
    /(win32|windows|darwin|macos|linux|freebsd|openbsd|android)[_-](x64|ia32|arm64|armhf|arm|riscv64d?|loong64|ppc64|s390x)(?:[_-](msvc|musl|gnu|unknown))?/i;

function pruneWrongPlatformPackages(nm) {
    let pruned = 0;
    for (const p of fs.readdirSync(nm, { withFileTypes: true })) {
        if (!p.isDirectory()) continue;
        if (p.name.startsWith('@')) {
            const sp = path.join(nm, p.name);
            let scoped;
            try {
                scoped = fs.readdirSync(sp, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const s of scoped) {
                if (!s.isDirectory()) continue;
                const m = s.name.match(PLATFORM_TAG_RE);
                if (m && !isTargetPlatformDir(s.name)) {
                    const fp = path.join(sp, s.name);
                    console.log(`  [prune] ${p.name}/${s.name} (${(dirSize(fp) / (1024 * 1024)).toFixed(1)} MB)`);
                    removePath(fp);
                    pruned++;
                }
            }
        } else {
            const m = p.name.match(PLATFORM_TAG_RE);
            if (m && !isTargetPlatformDir(p.name)) {
                const fp = path.join(nm, p.name);
                console.log(`  [prune] ${p.name} (${(dirSize(fp) / (1024 * 1024)).toFixed(1)} MB)`);
                removePath(fp);
                pruned++;
            }
        }
    }
    if (pruned > 0) console.log(`  删除 ${pruned} 个非目标平台包`);
}

const JUNK_DIRS = new Set([
    'test',
    'tests',
    '__tests__',
    'spec',
    'specs',
    '.github',
    'coverage',
    '__pycache__',
    'fixtures',
    '__fixtures__',
    '__snapshots__',
    'mock',
    'mocks',
    '__mocks__',
    'deps', // C++ build 依赖源码（leveldb 等）
    'third_party' // 捆绑第三方 C/C++ 源码
]);

// 可能包含文档但也可能包含运行时代码的目录
// 不删除目录本身，只递归清理内部的垃圾文件
const DOC_LIKE_DIRS = new Set([
    'doc',
    'docs',
    'documentation',
    'example',
    'examples',
    'demo',
    'demos',
    'benchmark',
    'benchmarks',
    'perf'
]);

const JUNK_FILES = new Set([
    '.gitignore',
    '.npmignore',
    '.npmrc',
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.editorconfig',
    'tsconfig.json',
    'jsconfig.json',
    'jest.config.js',
    'jest.config.ts',
    'jest.config.json',
    'rollup.config.js',
    'rollup.config.ts',
    'webpack.config.js',
    'webpack.config.ts',
    '.travis.yml',
    'appveyor.yml',
    'codecov.yml',
    'Makefile',
    'CMakeLists.txt',
    'Dockerfile',
    'docker-compose.yml',
    'CHANGELOG.md',
    'CHANGES.md',
    'HISTORY.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'AUTHORS',
    'AUTHORS.md'
]);
const KEEP_MD = new Set(['readme.md', 'license.md', 'licence.md']);
const BUILD_EXTS = new Set(['.o', '.a', '.lib', '.exp', '.ilk', '.pdb', '.obj']);

function pruneJunkFiles(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
            if (JUNK_DIRS.has(e.name)) {
                removePath(fp);
                continue;
            }
            // src/ —— 只删包含 C/C++ 源码的（native addon），纯 JS 包的保留
            if (e.name === 'src' && containsCSourceFiles(fp)) {
                removePath(fp);
                continue;
            }
            if (e.name === 'build') {
                pruneBuildDir(fp);
                continue;
            }
            pruneJunkFiles(fp);
        } else {
            const lower = e.name.toLowerCase();
            const ext = path.extname(lower);
            if (ext === '.map') {
                removePath(fp);
                continue;
            }
            if (ext === '.ts' && !lower.endsWith('.d.ts')) {
                removePath(fp);
                continue;
            }
            if ((ext === '.md' || ext === '.markdown') && !KEEP_MD.has(lower)) {
                removePath(fp);
                continue;
            }
            if (JUNK_FILES.has(e.name) || JUNK_FILES.has(lower)) {
                removePath(fp);
                continue;
            }
        }
    }
}

function pruneBuildDir(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (['obj', 'obj.target', 'deps', 'tmp', '.deps'].includes(e.name)) removePath(fp);
            else if (e.name === 'Release' || e.name === 'Debug') cleanReleaseDir(fp);
            else pruneBuildDir(fp);
        } else {
            if (BUILD_EXTS.has(path.extname(e.name).toLowerCase())) removePath(fp);
        }
    }
}

function cleanReleaseDir(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.isFile() && path.extname(e.name).toLowerCase() !== '.node' && e.name !== 'config.gypi') {
            removePath(path.join(dir, e.name));
        }
    }
}

// ============================================================================
// OHOS WebAssembly + fetch 兼容（仅 openharmony 平台）
// ============================================================================

/**
 * 应用 OHOS 运行时兼容适配：
 *   1. 删除 cheerio / undici（vectra → WebFetcher → cheerio → undici → WebAssembly 链）
 *   2. 删除 vectra/lib/WebFetcher.js 并改写 vectra/lib/index.js
 *   3. 对 dist 中 .js 文件做 vectra deep-import 改写
 *   4. 注入 ohos-compat.js（WebAssembly shim + Electron net.fetch 代理）
 */
function applyOhosCompat(appDir) {
    const nm = path.join(appDir, 'node_modules');

    // 1. 删除 cheerio / undici（避免触发 WebAssembly）
    for (const name of ['cheerio', 'undici']) {
        const p = path.join(nm, name);
        if (fs.existsSync(p)) {
            console.log(`  [ohos] 删除 ${name}`);
            removePath(p);
        }
    }

    // 2. 删除 vectra/lib/WebFetcher.js 并改写 index.js
    const webFetcher = path.join(nm, 'vectra', 'lib', 'WebFetcher.js');
    if (fs.existsSync(webFetcher)) {
        console.log('  [ohos] 删除 vectra/lib/WebFetcher.js');
        removePath(webFetcher);
    }
    const webFetcherDts = path.join(nm, 'vectra', 'lib', 'WebFetcher.d.ts');
    if (fs.existsSync(webFetcherDts)) removePath(webFetcherDts);

    const vectraIndex = path.join(nm, 'vectra', 'lib', 'index.js');
    if (fs.existsSync(vectraIndex)) {
        let txt = fs.readFileSync(vectraIndex, 'utf8');
        const old = '__exportStar(require("./WebFetcher"), exports);\n';
        if (txt.includes(old)) {
            txt = txt.replace(old, '// removed: __exportStar(require("./WebFetcher"), exports); // OHOS slim\n');
            fs.writeFileSync(vectraIndex, txt, 'utf8');
            console.log('  [ohos] 改写 vectra/lib/index.js 去掉 WebFetcher re-export');
        }
    }

    // 3. 对 dist 中 .js 做 vectra deep-import 改写
    const distDir = path.join(appDir, 'dist');
    const patches = [
        ["import { LocalIndex } from 'vectra';", "import { LocalIndex } from 'vectra/lib/LocalIndex.js';"],
        ['import { LocalIndex } from "vectra";', 'import { LocalIndex } from "vectra/lib/LocalIndex.js";']
    ];
    let patchedCount = 0;
    for (const jsFile of walkFiles(distDir, '.js')) {
        let src;
        try {
            src = fs.readFileSync(jsFile, 'utf8');
        } catch {
            continue;
        }
        let changed = false;
        for (const [old, newStr] of patches) {
            if (src.includes(old)) {
                src = src.replaceAll(old, newStr);
                changed = true;
            }
        }
        if (changed) {
            fs.writeFileSync(jsFile, src, 'utf8');
            patchedCount++;
        }
    }
    if (patchedCount > 0) {
        console.log(`  [ohos] 改写 ${patchedCount} 个 dist 文件的 vectra import`);
    }

    // 4. 注入 ohos-compat.js
    const ohosCompatSource = `// === OHOS WebAssembly + fetch 兼容 shim (package-app.cjs 注入) ===
import { createRequire } from 'node:module';
const __ohosRequire = createRequire(import.meta.url);

if (typeof globalThis.WebAssembly === 'undefined') {
    const noop = () => 0;
    const exportsTarget = { memory: { buffer: new ArrayBuffer(0) } };
    const stubExports = new Proxy(exportsTarget, {
        get(target, prop) { if (prop in target) return target[prop]; return noop; },
        has() { return true; }
    });
    class OhosWasmModule { constructor(_bytes) {} static exports() { return []; } static imports() { return []; } static customSections() { return []; } }
    class OhosWasmInstance { constructor(_mod, _imports) { this.exports = stubExports; } }
    class OhosWasmMemory { constructor(_descriptor) { this.buffer = new ArrayBuffer(0); } grow(_delta) { return 0; } }
    class OhosWasmTable { constructor(_descriptor) {} get length() { return 0; } get(_index) { return null; } set(_index, _value) {} grow(_delta) { return 0; } }
    class OhosWasmGlobal { constructor(_descriptor, value) { this.value = value; } valueOf() { return this.value; } }
    class OhosCompileError extends Error { constructor(msg) { super(msg); this.name = 'CompileError'; } }
    class OhosLinkError extends Error { constructor(msg) { super(msg); this.name = 'LinkError'; } }
    class OhosRuntimeError extends Error { constructor(msg) { super(msg); this.name = 'RuntimeError'; } }
    globalThis.WebAssembly = {
        Module: OhosWasmModule, Instance: OhosWasmInstance, Memory: OhosWasmMemory,
        Table: OhosWasmTable, Global: OhosWasmGlobal,
        CompileError: OhosCompileError, LinkError: OhosLinkError, RuntimeError: OhosRuntimeError,
        compile: async (bytes) => new OhosWasmModule(bytes),
        compileStreaming: async (_source) => new OhosWasmModule(),
        instantiate: async (m, imports) => {
            if (m instanceof OhosWasmModule) return new OhosWasmInstance(m, imports);
            const mod = new OhosWasmModule(m);
            return { module: mod, instance: new OhosWasmInstance(mod, imports) };
        },
        instantiateStreaming: async (_source, imports) => {
            const mod = new OhosWasmModule();
            return { module: mod, instance: new OhosWasmInstance(mod, imports) };
        },
        validate: () => false
    };
}

(function installFetchProxy() {
    if (globalThis.__ohos_fetch_installed) return;
    let electronModule = null;
    try { electronModule = __ohosRequire('electron'); } catch (_) { return; }
    const net = electronModule && electronModule.net;
    const electronApp = electronModule && electronModule.app;
    if (!net || typeof net.fetch !== 'function') return;
    const ohosFetch = async (input, init) => {
        if (electronApp && typeof electronApp.isReady === 'function' && !electronApp.isReady()) await electronApp.whenReady();
        const url = input instanceof URL ? input.href : input;
        return net.fetch(url, init);
    };
    try { Object.defineProperty(globalThis, 'fetch', { configurable: true, enumerable: true, writable: true, value: ohosFetch }); } catch (_) {
        try { globalThis.fetch = ohosFetch; } catch (_) {}
    }
    if (typeof global !== 'undefined' && global !== globalThis) { try { global.fetch = ohosFetch; } catch (_) {} }
    globalThis.__ohos_fetch_installed = true;
})();
`;

    const distMain = path.join(appDir, 'dist', 'main');
    const compatFile = path.join(distMain, 'ohos-compat.js');
    fs.writeFileSync(compatFile, ohosCompatSource, 'utf8');
    console.log('  [ohos] 写入 ohos-compat.js');

    const ohosImportLine = 'import "./ohos-compat.js";\n';
    for (const entry of ['main.js', 'worker.js']) {
        const entryPath = path.join(distMain, entry);
        if (!fs.existsSync(entryPath)) continue;
        const txt = fs.readFileSync(entryPath, 'utf8');
        if (txt.includes('ohos-compat.js')) {
            console.log(`  [ohos] ${entry} 已注入，跳过`);
            continue;
        }
        fs.writeFileSync(entryPath, ohosImportLine + txt, 'utf8');
        console.log(`  [ohos] ${entry} 注入 import "./ohos-compat.js"`);
    }
}

/** 递归遍历目录下指定后缀的文件 */
function walkFiles(dir, ext) {
    const result = [];
    if (!fs.existsSync(dir)) return result;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const fp = path.join(d, e.name);
            if (e.isDirectory()) stack.push(fp);
            else if (e.isFile() && fp.endsWith(ext)) result.push(fp);
        }
    }
    return result;
}

/**
 * 检查目录是否包含 C/C++ 源码文件（.cc .cpp .c .h .hpp）。
 * 用于判断 src/ 是 native addon 源码还是 JS 包入口。
 */
function containsCSourceFiles(dir) {
    if (!fs.existsSync(dir)) return false;
    const stack = [dir];
    // 只浅层扫描（深度 3），避免大目录耗时
    let depth = 0;
    while (stack.length > 0 && depth < 3) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const fp = path.join(current, e.name);
            if (e.isDirectory()) {
                stack.push(fp);
                continue;
            }
            const ext = path.extname(e.name).toLowerCase();
            if (ext === '.cc' || ext === '.cpp' || ext === '.c' || ext === '.h' || ext === '.hpp') return true;
        }
        depth++;
    }
    return false;
}

// ============================================================================
// 主流程
// ============================================================================

function main() {
    // Step 1: 构建（确保 dist + node_modules 都是最新的）
    console.log('[1/6] npm run build...');
    npmExec(['run', 'build'], projectRoot);

    // Step 2: 分析主进程依赖闭包
    console.log('\n[2/6] 分析主进程依赖...');
    const mainImports = extractImports(path.join(projectRoot, 'src', 'main'));
    const preloadImports = extractImports(path.join(projectRoot, 'src', 'preload'));
    const allMainImports = new Set([...mainImports, ...preloadImports]);

    // 过滤掉 Node.js 内置模块
    const builtins = new Set([
        'fs',
        'path',
        'os',
        'crypto',
        'http',
        'https',
        'http2',
        'net',
        'tls',
        'dns',
        'stream',
        'events',
        'util',
        'url',
        'querystring',
        'buffer',
        'child_process',
        'cluster',
        'readline',
        'zlib',
        'assert',
        'timers',
        'string_decoder',
        'electron',
        'process',
        'module',
        'v8',
        'vm',
        'worker_threads',
        'perf_hooks'
    ]);
    const mainDeps = new Set();
    for (const name of allMainImports) {
        if (!builtins.has(name) && !name.startsWith('node:')) {
            mainDeps.add(name);
        }
    }

    console.log(`  主进程直接依赖 (${mainDeps.size} 个):`);
    for (const d of [...mainDeps].sort()) console.log(`    ${d}`);

    // Step 3: 准备 node_modules
    console.log('\n[3/6] 准备 node_modules...');
    console.log(`  清空目标目录: ${appDir}`);
    removePath(appDir);
    fs.mkdirSync(appDir, { recursive: true });

    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    fs.writeFileSync(
        path.join(appDir, 'package.json'),
        JSON.stringify(
            {
                name: pkg.name,
                version: pkg.version,
                description: pkg.description,
                license: pkg.license,
                author: pkg.author,
                type: pkg.type,
                main: pkg.main,
                private: pkg.private,
                dependencies: pkg.dependencies,
                optionalDependencies: pkg.optionalDependencies,
                scripts: {}
            },
            null,
            2
        )
    );

    const dstNm = path.join(appDir, 'node_modules');
    console.log('  复制 node_modules（跳过 dev 大包）...');
    copyNmFiltered(path.join(projectRoot, 'node_modules'), dstNm);

    console.log('  npm prune --omit=dev...');
    npmExec(['prune', '--omit=dev'], appDir);

    const nmAfterPrune = dirSize(dstNm);
    console.log(`  prune 后: ${(nmAfterPrune / (1024 * 1024)).toFixed(1)} MB`);

    // Step 4: 获取主进程依赖的传递闭包
    // 直接从项目 node_modules 递归读取 package.json 构建闭包
    console.log('\n[4/6] 计算主进程依赖闭包...');
    const keepClosure = getDepClosure(mainDeps, path.join(projectRoot, 'node_modules'));

    // 始终保留
    keepClosure.add('electron');
    keepClosure.add('@electron-toolkit/utils');

    console.log(`  依赖闭包: ${keepClosure.size} 个包`);

    // 删除不在闭包内的包（但 mainDeps 直接扫描到的包强制保留）
    // 先处理 FORCE_EXCLUDE：无论是否在闭包中，强制删除
    console.log('  强制排除包...');
    let forcePruned = 0;
    for (const name of FORCE_EXCLUDE) {
        const fp = path.join(dstNm, name);
        if (fs.existsSync(fp)) {
            const sz = dirSize(fp);
            console.log(`  [force] ${name} (${(sz / (1024 * 1024)).toFixed(1)} MB)`);
            removePath(fp);
            forcePruned++;
            // 从 keepClosure 中移除，防止后续逻辑误判
            keepClosure.delete(name);
        }
    }
    if (forcePruned > 0) console.log(`  强制排除 ${forcePruned} 个包`);

    console.log('  删除渲染进程专属包...');
    let rendererPruned = 0;
    const nmDir = dstNm;
    for (const p of fs.readdirSync(nmDir, { withFileTypes: true })) {
        if (!p.isDirectory() || p.name.startsWith('.')) continue;
        if (p.name.startsWith('@')) {
            for (const sp of fs.readdirSync(path.join(nmDir, p.name), { withFileTypes: true })) {
                if (!sp.isDirectory()) continue;
                const fullName = `${p.name}/${sp.name}`;
                // 直接依赖 或 在闭包中 → 保留
                if (mainDeps.has(fullName) || keepClosure.has(fullName)) continue;
                const fp = path.join(nmDir, p.name, sp.name);
                const sz = dirSize(fp);
                if (sz > 0) {
                    console.log(`  [renderer] ${fullName} (${(sz / (1024 * 1024)).toFixed(1)} MB)`);
                }
                removePath(fp);
                rendererPruned++;
            }
        } else {
            // 直接依赖 或 在闭包中 → 保留
            if (mainDeps.has(p.name) || keepClosure.has(p.name)) continue;
            const fp = path.join(nmDir, p.name);
            const sz = dirSize(fp);
            if (sz > 0) {
                console.log(`  [renderer] ${p.name} (${(sz / (1024 * 1024)).toFixed(1)} MB)`);
            }
            removePath(fp);
            rendererPruned++;
        }
    }
    console.log(`  删除 ${rendererPruned} 个渲染进程专属包`);

    // Step 5: 复制 dist（排除 CLI） + resources/main（tray icon 等运行时资源）
    // electron-vite 的 main.publicDir = resources/main，但 ?asset 导入的资源并未内联
    // 到 dist 中，而是保留了 ../../resources/main/... 的相对路径引用，
    // 因此需要将 resources/main 一并复制到输出目录
    console.log('\n[5/6] 复制 dist 与 resources/main...');
    copyDirFiltered(path.join(projectRoot, 'dist'), path.join(appDir, 'dist'), new Set(['cli', 'cli-release-nightly']));
    copyDir(path.join(projectRoot, 'resources', 'main'), path.join(appDir, 'resources', 'main'));

    // Step 6: 裁剪 prebuild + 平台包 + 垃圾文件
    console.log('\n[6/6] 裁剪与清理...');
    console.log('  多平台 prebuild...');
    const hubs = discoverPrebuildHubs(dstNm);
    if (hubs.length > 0) {
        let tk = 0,
            tp = 0;
        for (const h of hubs) {
            const { kept, pruned } = prunePrebuildHub(h);
            tk += kept;
            tp += pruned;
        }
        console.log(`  ${hubs.length} 个 hub，保留 ${tk}，删除 ${tp}`);
    }
    deepPrunePrebuilds(dstNm);
    console.log('  平台特定包...');
    pruneWrongPlatformPackages(dstNm);

    const nmBefore = dirSize(dstNm);
    pruneJunkFiles(dstNm);
    const nmAfter = dirSize(dstNm);
    console.log(`  清理垃圾: ${(nmBefore / (1024 * 1024)).toFixed(1)} MB → ${(nmAfter / (1024 * 1024)).toFixed(1)} MB`);

    // OHOS WebAssembly + fetch 兼容
    console.log('\n   OHOS WebAssembly + fetch 兼容...');
    applyOhosCompat(appDir);

    // ========================================================================
    console.log('\n' + '='.repeat(60));
    console.log('打包完成');
    console.log('='.repeat(60));
    const appSize = dirSize(appDir);
    console.log(`输出:          ${appDir}`);
    console.log(`dist:          ${(dirSize(path.join(appDir, 'dist')) / (1024 * 1024)).toFixed(1)} MB`);
    console.log(`node_modules:  ${(nmAfter / (1024 * 1024)).toFixed(1)} MB`);
    console.log(`总大小:        ${(appSize / (1024 * 1024)).toFixed(1)} MB`);

    // TOP 20
    console.log('\n--- node_modules TOP 20 ---');
    const pkgs = [];
    for (const e of fs.readdirSync(dstNm, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        if (e.name.startsWith('@')) {
            for (const sp of fs.readdirSync(path.join(dstNm, e.name), { withFileTypes: true })) {
                if (!sp.isDirectory()) continue;
                pkgs.push({ name: `${e.name}/${sp.name}`, size: dirSize(path.join(dstNm, e.name, sp.name)) });
            }
        } else {
            pkgs.push({ name: e.name, size: dirSize(path.join(dstNm, e.name)) });
        }
    }
    pkgs.sort((a, b) => b.size - a.size);
    for (const p of pkgs.slice(0, 20))
        console.log(`  ${(p.size / (1024 * 1024)).toFixed(1).padStart(6)} MB  ${p.name}`);
}

main();
