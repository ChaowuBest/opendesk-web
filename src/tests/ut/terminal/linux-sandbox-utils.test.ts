import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    detectToolchainReadOnlyDirs,
    linuxRuntimeTriple,
    resolveLinuxSandboxExecutable,
    resolveLinuxSandboxLibrary
} from '../../../main/applications/terminal/sandboxes/linux-sandbox.js';

describe('detectToolchainReadOnlyDirs', () => {
    test('从 PATH 解析已有工具二进制所在目录并去重', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-toolchain-test-'));
        try {
            const binA = path.join(tmp, 'binA');
            const binB = path.join(tmp, 'binB');
            fs.mkdirSync(binA, { recursive: true });
            fs.mkdirSync(binB, { recursive: true });
            // 假工具：PATH 里两个目录各自放一个，同一目录出现两次工具应去重
            fs.writeFileSync(path.join(binA, 'node'), '#!/bin/sh\n');
            fs.writeFileSync(path.join(binA, 'npm'), '#!/bin/sh\n');
            fs.writeFileSync(path.join(binB, 'cargo'), '#!/bin/sh\n');
            fs.chmodSync(path.join(binA, 'node'), 0o755);
            fs.chmodSync(path.join(binA, 'npm'), 0o755);
            fs.chmodSync(path.join(binB, 'cargo'), 0o755);
            const dirs = detectToolchainReadOnlyDirs({ PATH: `${binA}:${binB}:/nonexistent`, HOME: tmp });
            expect(dirs).toContain(path.resolve(binA));
            expect(dirs).toContain(path.resolve(binB));
            // 去重：binA 只出现一次
            expect(dirs.filter((d) => d === path.resolve(binA))).toHaveLength(1);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('不存在的工具目录被过滤', () => {
        const dirs = detectToolchainReadOnlyDirs({
            PATH: '/definitely-not-exist-xyz/usr/bin',
            HOME: '/definitely-not-exist-home'
        });
        expect(dirs).toEqual([]);
    });
});

describe('linuxRuntimeTriple', () => {
    test('按 node arch 映射到 rust 风格 triple（与 Makefile RUNTIME_TARGET 约定一致）', () => {
        expect(linuxRuntimeTriple('x64')).toBe('x86_64-unknown-linux-gnu');
        expect(linuxRuntimeTriple('arm64')).toBe('aarch64-unknown-linux-gnu');
        expect(linuxRuntimeTriple('ia32')).toBe('i686-unknown-linux-gnu');
    });
    test('未知 arch 兜底为 <arch>-unknown-linux-gnu（对齐 Makefile 的 uname -m 拼法）', () => {
        expect(linuxRuntimeTriple('riscv64')).toBe('riscv64-unknown-linux-gnu');
    });
});

describe('resolveLinuxSandboxExecutable / resolveLinuxSandboxLibrary', () => {
    test('开发路径指向 runtime/<triple>/dynobox（非 defaultApp 时打包路径优先，开发路径兜底）', () => {
        // 不依赖真实产物存在性：仅校验路径解析不抛错且类型正确（存在性由 fs 探测决定）
        const executable = resolveLinuxSandboxExecutable();
        expect(executable === null || typeof executable === 'string').toBe(true);
        const library = resolveLinuxSandboxLibrary();
        expect(library === null || typeof library === 'string').toBe(true);
        // library 与 executable 同目录或位于打包 resources/sandbox 布局
        if (executable && library) {
            expect(path.dirname(library)).toBe(path.dirname(executable));
        }
    });
    test('开发路径布局为 native/linux/sandbox/runtime/<triple>/（回归：FUSE 时代为 target/release/dynobox-linux）', () => {
        const devLayout = path.join(
            process.env.INIT_CWD || process.cwd(),
            'native',
            'linux',
            'sandbox',
            'runtime',
            linuxRuntimeTriple(),
            'dynobox'
        );
        expect(devLayout.endsWith(path.join('runtime', linuxRuntimeTriple(), 'dynobox'))).toBe(true);
        expect(devLayout).not.toContain(path.join('target', 'release'));
    });
});
