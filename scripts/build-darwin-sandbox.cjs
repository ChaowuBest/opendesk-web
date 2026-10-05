/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the software at http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

'use strict';

/**
 * darwin 动态沙箱（DYLD_INSERT_LIBRARIES interposing dylib）构建。
 *
 * 产物：native/darwin/sandbox/runtime/dynobox-darwin.dylib（universal：
 * arm64 + arm64e + x86_64 单文件）。arm64e slice 必需——macOS 系统 dylib
 * 只加载与平台二进制同 ABI 的插入库，arm64e 平台二进制（/bin/zsh 等）
 * 无法注入纯 arm64 dylib。
 *
 * 架构策略（与 Linux 沙箱一致）：
 * - 本机构建：默认产出当前宿主架构 + 必备 slice（arm64 机器补 arm64e、x86_64 补 x86_64）；
 * - 双架构全量（打包前建议）：OPENDESK_SANDBOX_ARCH=all 显式产出三 slice；
 * - 单 slice 调试：OPENDESK_SANDBOX_ARCH=arm64|arm64e|x86_64。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// OPENDESK_TARGET_PLATFORM 环境变量声明目标平台，由构建工程按进程注入。
if (process.platform !== 'darwin' || process.env.OPENDESK_TARGET_PLATFORM === 'ohos') {
    process.stdout.write('[sandbox-darwin] darwin-only native build skipped on this platform.\n');
    process.exit(0);
}

const sandboxRoot = path.join(root, 'native', 'darwin', 'sandbox');
const source = path.join(sandboxRoot, 'src', 'boxdylib.c');
const runtimeDir = path.join(sandboxRoot, 'runtime');
const output = path.join(runtimeDir, 'dynobox-darwin.dylib');

if (!fs.existsSync(source)) {
    process.stderr.write(`[sandbox-darwin] source missing: ${source}\n`);
    process.exit(1);
}

// 共享 core（与 Linux/OpenHarmony 同一份 C 源码）：策略 TOML 解析、glob 匹配、
// 小工具 + rawio_darwin（libc 版自身 I/O，配合 boxdylib 的 is_internal 豁免）。
const sharedSrcDir = path.join(root, 'native', 'openharmony', 'sandbox', 'src');
const coreSources = [
    'policy.c',
    'pathmap.c',
    'ask.c',
    'cfgio.c',
    'util.c',
    'log.c',
    'mini_toml.c',
    'rawio_darwin.c'
].map((f) => path.join(sharedSrcDir, f));
for (const f of coreSources) {
    if (!fs.existsSync(f)) {
        process.stderr.write(`[sandbox-darwin] shared core source missing: ${f}\n`);
        process.exit(1);
    }
}

const archChoice = process.env.OPENDESK_SANDBOX_ARCH || 'host';
/** Node 架构名 → clang -arch。arm64 机器必须附带 arm64e slice（系统二进制 ABI）。 */
function slicesFor(choice) {
    if (choice === 'all') return ['arm64', 'arm64e', 'x86_64'];
    if (choice === 'arm64' || choice === 'arm64e' || choice === 'x86_64') return [choice];
    return process.arch === 'arm64' ? ['arm64', 'arm64e'] : ['x86_64'];
}

const slices = slicesFor(archChoice);
fs.mkdirSync(runtimeDir, { recursive: true });

const args = ['-dynamiclib', '-O2', '-Wall', '-Wextra', '-fvisibility=hidden'];
for (const arch of slices) args.push('-arch', arch);
args.push('-I', sharedSrcDir);
args.push('-o', output, source, ...coreSources);

process.stdout.write(`[sandbox-darwin] building ${slices.join(' + ')} → ${path.relative(root, output)}\n`);
execFileSync('/usr/bin/clang', args, { cwd: root, stdio: 'inherit' });

// 校验产物包含全部目标 slice，防止后续打包错架构
const lipo = execFileSync('/usr/bin/lipo', ['-archs', output], { encoding: 'utf8' });
const built = lipo.trim().split(/\s+/).sort();
for (const arch of slices) {
    if (!built.includes(arch)) {
        process.stderr.write(`[sandbox-darwin] slice ${arch} missing in output (got: ${built.join(' ')})\n`);
        process.exit(1);
    }
}
process.stdout.write(`[sandbox-darwin] ok: ${built.join(' + ')}\n`);
