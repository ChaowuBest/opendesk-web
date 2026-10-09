/**
 * boxdylib.c 内部函数 C harness 测试运行器：
 * 1. /usr/bin/clang 把 boxdylib-matching.test.c 编译为一次性可执行文件（tmpdir）；
 * 2. 运行并转发退出码；产物即用即删。
 *
 * C harness 源码在 native/darwin/sandbox/src/tests/（被测源码同仓），本文件
 * 放在 src/tests/ut/node/ 经 `npm run test:node` 收集（node:test 协议）。
 * 仅 darwin 运行：被测源码 include 了 Mach-O/POSIX 头。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const harnessSource = path.join(repoRoot, 'native/darwin/sandbox/src/tests/boxdylib-matching.test.c');

test('boxdylib clt_toolchain_basename 版本后缀匹配（C harness）', () => {
    if (process.platform !== 'darwin') {
        test.skip(`darwin-only, skip on ${process.platform}`);
        return;
    }
    if (!fs.existsSync(harnessSource)) {
        test.skip(`harness source missing: ${harnessSource}`);
        return;
    }
    const out = path.join(os.tmpdir(), `boxdylib-matching-${process.pid}-${Date.now()}`);
    try {
        // boxdylib.c 与共享 core 分离编译的头部路径由 -I 提供（与 dylib 构建一致）；
        // harness 以 #include "boxdylib.c" 引入被测源码，共享 core 符号（ask/policy
        // 等）与 dylib 构建相同，须一并编译链接
        const coreSources = [
            'policy.c',
            'pathmap.c',
            'ask.c',
            'cfgio.c',
            'util.c',
            'log.c',
            'mini_toml.c',
            'rawio_darwin.c'
        ].map((f) => path.join(repoRoot, 'native/openharmony/sandbox/src', f));
        execFileSync(
            '/usr/bin/clang',
            [
                '-O1',
                '-Wall',
                '-Wextra',
                '-I',
                path.join(repoRoot, 'native/darwin/sandbox/src'),
                '-I',
                path.join(repoRoot, 'native/openharmony/sandbox/src'),
                '-o',
                out,
                harnessSource,
                ...coreSources
            ],
            { stdio: 'pipe' }
        );
        execFileSync(out, { stdio: 'pipe' });
    } finally {
        fs.rmSync(out, { force: true });
    }
});
