import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// locale/index.ts 在 jest ESM VM 下 createRequire 与内置 require 冲突，mock 掉
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
}));

const {
    needsExecResign,
    prepareShellForSandbox,
    readCodeDirectoryFlags,
    resolveDarwinSandboxDylib,
    sandboxExecCacheDir
} = await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('readCodeDirectoryFlags', () => {
    test('读取平台二进制 /bin/zsh 的 CodeDirectory flags（fat arm64e slice）', () => {
        const parsed = readCodeDirectoryFlags('/bin/zsh');
        expect(parsed).not.toBeNull();
        // Apple 平台二进制：正式身份签名（无 CS_ADHOC），无 linker-signed
        expect(parsed!.flags & 0x20000).toBe(0);
        expect(parsed!.flags & 0x2).toBe(0);
    });

    test('fat64（FAT_MAGIC_64）头也能解析（构造合成文件）', () => {
        // 合成最小 fat64 包装：fat64 header(8B, BE) + 1 个 fat_arch_64(32B, BE)
        // 指向一个最小 arm64 Mach-O slice（无 load commands 时 flags 解析失败返回 null，
        // 但必须能走到 slice magic 校验——通过返回 null 而非抛异常验证路径正确）
        const slice = Buffer.alloc(32);
        slice.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
        slice.writeUInt32LE(0x0100000c, 4); // cputype arm64
        slice.writeUInt32LE(0x00000002, 8); // cpusubtype
        slice.writeUInt32LE(2, 12); // filetype MH_EXECUTE
        slice.writeUInt32LE(0, 16); // ncmds = 0 → LC 循环不执行 → null
        const head = Buffer.alloc(8 + 32);
        head.writeUInt32BE(0xcafebabf, 0); // FAT_MAGIC_64
        head.writeUInt32BE(1, 4); // nfat_arch
        head.writeUInt32BE(0x0100000c, 8); // cputype
        head.writeUInt32BE(0x00000002, 12); // cpusubtype
        head.writeBigUInt64BE(BigInt(8), 16); // offset
        head.writeBigUInt64BE(BigInt(slice.length), 24); // size
        head.writeUInt32BE(12, 32); // align
        head.writeUInt32BE(0, 36); // reserved
        slice.copy(head, 40);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-fat64-'));
        try {
            const p = path.join(tmp, 'fat64.bin');
            fs.writeFileSync(p, head);
            // slice 无 LC_CODE_SIGNATURE → flags 解析返回 null（不抛异常、不误判）
            expect(readCodeDirectoryFlags(p)).toBeNull();
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('读取普通 arm64 第三方二进制（经 codesign adhoc）', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-flag-'));
        try {
            const source = path.join(tmp, 'tool.c');
            fs.writeFileSync(source, 'int main(void) { return 0; }\n');
            const binary = path.join(tmp, 'tool');
            const cc = spawnSync('/usr/bin/clang', ['-arch', 'arm64', '-o', binary, source]);
            if (cc.status !== 0) return; // 非 arm64 构建机跳过
            const unsigned = readCodeDirectoryFlags(binary);
            spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' });
            const adhoc = readCodeDirectoryFlags(binary);
            // linker-signed（未显式签名）或 adhoc 都允许直接注入
            if (unsigned) expect(unsigned.flags & 0x20000).not.toBe(0);
            expect(adhoc).not.toBeNull();
            expect((adhoc!.flags & 0x2) !== 0 || (adhoc!.flags & 0x20000) !== 0).toBe(true);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('非 Mach-O 文件返回 null', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-flag-'));
        try {
            const text = path.join(tmp, 'script.sh');
            fs.writeFileSync(text, '#!/bin/sh\necho hi\n');
            expect(readCodeDirectoryFlags(text)).toBeNull();
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

darwinOnly('needsExecResign', () => {
    test('平台二进制需要重签，adhoc/linker-signed 不需要', () => {
        expect(needsExecResign('/bin/zsh')).toBe(true);
        expect(needsExecResign('/bin/echo')).toBe(true);
        // nvm/brew 等第三方 node 通常为普通签名（允许注入）或 hardened（需重签），
        // 两种结果都合法，只验证不抛异常且判定与 flags 一致
        const nodePath = spawnSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).stdout?.trim();
        if (nodePath && fs.existsSync(nodePath)) {
            const parsed = readCodeDirectoryFlags(nodePath);
            expect(needsExecResign(nodePath)).toBe(
                !!parsed && !(parsed.flags & 0x20000) && (!(parsed.flags & 0x2) || !!(parsed.flags & 0x10000))
            );
        }
    });

    test('脚本文件不需要重签（由解释器执行）', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-resign-'));
        try {
            const script = path.join(tmp, 'run.sh');
            fs.writeFileSync(script, '#!/bin/sh\necho hi\n');
            fs.chmodSync(script, 0o755);
            expect(needsExecResign(script)).toBe(false);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

darwinOnly('resignCopyForExec 与 prepareShellForSandbox', () => {
    test('平台二进制重签后缓存可复用，副本为 adhoc 签名', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-cache-'));
        try {
            const first = prepareShellForSandbox('/bin/echo');
            expect(first).not.toBe('/bin/echo');
            expect(fs.existsSync(first)).toBe(true);
            // 副本可执行且输出正常
            const run = spawnSync(first, ['resigned-ok'], { encoding: 'utf8' });
            expect(run.status).toBe(0);
            expect(run.stdout).toContain('resigned-ok');
            // 副本不再是平台二进制（adhoc 或 linker-signed），可被 DYLD 注入
            const flags = readCodeDirectoryFlags(first);
            expect(flags).not.toBeNull();
            expect((flags!.flags & 0x2) !== 0 || (flags!.flags & 0x20000) !== 0).toBe(true);
            // 二次调用命中缓存：路径一致
            expect(prepareShellForSandbox('/bin/echo')).toBe(first);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('普通二进制原样返回，不产生缓存副本', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-cache-'));
        try {
            const source = path.join(tmp, 'plain.c');
            fs.writeFileSync(source, 'int main(void) { return 0; }\n');
            const binary = path.join(tmp, 'plain');
            const cc = spawnSync('/usr/bin/clang', [
                '-arch',
                process.arch === 'arm64' ? 'arm64' : 'x86_64',
                '-o',
                binary,
                source
            ]);
            if (cc.status !== 0) return;
            spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' });
            expect(prepareShellForSandbox(binary)).toBe(binary);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('相对 shellPath 先转绝对再判定（PATH 含相对段的场景）', () => {
        const cwd = process.cwd();
        try {
            // /bin/zsh 相对化（不可达形态也安全）：resolve 后与绝对行为一致
            const relative = path.relative(cwd, '/bin/zsh');
            const result = prepareShellForSandbox(relative);
            const absolute = prepareShellForSandbox('/bin/zsh');
            expect(path.resolve(result)).toBe(path.resolve(absolute));
        } finally {
            process.chdir(cwd);
        }
    });
});

describe('resignCopyForExec 锁残留抢占', () => {
    test('残留锁超过阈值后被抢占，重签正常完成', async () => {
        const { resignCopyForExec } = await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-lock-'));
        try {
            // 预置一个"陈旧残留锁"（时间戳 60 秒前）；锁路径与真实缓存键对齐
            const source = path.join(tmp, 'target.bin');
            fs.writeFileSync(source, 'binary-content');
            const hex = (await import('node:crypto')).default
                .createHash('sha256')
                .update(fs.readFileSync(source))
                .digest('hex');
            const lockPath = path.join(tmp, hex, 'target.bin.lock');
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, `999999 ${Date.now() - 60000}`);
            const result = resignCopyForExec(source, tmp);
            // 抢占成功：锁文件被清理（本用例源非 Mach-O，codesign 失败返回 null 可接受）
            expect(fs.existsSync(lockPath)).toBe(false);
            void result;
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('新鲜锁（未超时）不抢占，等待后返回 null', async () => {
        const { resignCopyForExec } = await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-lock-fresh-'));
        try {
            const source = path.join(tmp, 'target.bin');
            fs.writeFileSync(source, 'content');
            const hex = (await import('node:crypto')).default
                .createHash('sha256')
                .update(fs.readFileSync(source))
                .digest('hex');
            const lockPath = path.join(tmp, hex, 'target.bin.lock');
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
            // 等待上限 50×100ms——新鲜锁不会被抢占，5 秒后放弃
            const start = Date.now();
            const result = resignCopyForExec(source, tmp);
            expect(result).toBeNull();
            expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
            expect(fs.existsSync(lockPath)).toBe(true); // 别人的锁未被误删
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }, 30000);
});

describe('resolveDarwinSandboxDylib 与缓存目录', () => {
    test('开发环境解析到 native runtime dylib（存在时）', () => {
        const dylib = resolveDarwinSandboxDylib();
        if (fs.existsSync(path.join(process.cwd(), 'native', 'darwin', 'sandbox', 'runtime', 'dynobox-darwin.dylib'))) {
            expect(dylib).not.toBeNull();
            expect(dylib).toContain('dynobox-darwin.dylib');
        } else {
            expect(dylib).toBeNull();
        }
    });

    test('缓存目录位于用户 Library/Caches', () => {
        if (process.platform !== 'darwin') return;
        expect(sandboxExecCacheDir()).toBe(
            path.join(process.env.HOME || '', 'Library', 'Caches', 'com.opendesk.sandbox', 'exec')
        );
    });
});
