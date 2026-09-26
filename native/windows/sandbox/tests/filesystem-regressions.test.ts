import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';

async function run(file: string, args: string[], stdin = '', env = process.env, timeoutMs = 60000) {
    const proc = spawn(file, args, { windowsHide: true, env });
    let stdout = '',
        stderr = '';
    proc.stdout.on('data', (data) => {
        stdout += data;
    });
    proc.stderr.on('data', (data) => {
        stderr += data;
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(stdin);
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [code] = await once(proc, 'close');
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

/** 把宿主路径映射为卷内路径（SBX_ROOT 由沙箱注入）。 */
function volumePathJsHelper(): string {
    return [
        'function volumePath(p) {',
        '    const full = require("node:path").resolve(p);',
        '    const root = process.env.SBX_ROOT.toUpperCase();',
        '    if (full.toUpperCase().startsWith(root)) return full;',
        '    const drive = full.slice(0, 1);',
        '    const rest = full.slice(3);',
        '    return require("node:path").join(process.env.SBX_ROOT, drive, rest);',
        '}',
    ].join('\n');
}

/** 写一个全放行的多根策略：挂载 /C -> C:\、/D -> D:\。
 * 原 --automount 移除后，测试要访问 PATH 中的系统工具必须显式声明盘符映射。 */
function writeDriveAllowPolicy(policyPath: string): void {
    fs.writeFileSync(
        policyPath,
        [
            'version = 1',
            'default = "allow"',
            '',
            '[[roots]]',
            'virtual = "/C"',
            'real    = "C:\\\\"',
            '',
            '[[roots]]',
            'virtual = "/D"',
            'real    = "D:\\\\"',
            '',
            '[[rules]]',
            'path    = "/C/**"',
            'access  = "all"',
            'perm    = "allow"',
            '',
            '[[rules]]',
            'path    = "/D/**"',
            'access  = "all"',
            'perm    = "allow"',
            '',
        ].join('\n')
    );
}

/**
 * 这批回归测试覆盖 2026-09-27 沙箱全量测试对齐时修复的文件系统语义。
 * 每个用例都通过多根策略（/C、/D）挂载盘符，在卷内跑 Node probe 脚本，
 * 断言此前修复的 Dokan/MirrorFs 行为不再回归。所有用例仅依赖 Windows。
 */

test('FindFilesWithPattern serves readdirSync withFileTypes on fresh directories', { skip: !windows }, async () => {
    // 回归：Node readdirSync(dir, { withFileTypes: true }) 走 Dokan 的
    // FindFilesWithPattern 回调；此前返回 NotImplemented 被映射为 ENOENT，
    // 导致 appmgr/skillmgr 安装流程对刚创建目录的枚举失败。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-findfiles-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'findfiles_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'const src = path.join(root, "created.app-1790");',
                'fs.mkdirSync(path.join(src, "renderer"), { recursive: true });',
                'fs.writeFileSync(path.join(src, "icon.png"), "x");',
                'const items = fs.readdirSync(src, { withFileTypes: true });',
                'const names = items.map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();',
                'console.log("READDIR=" + names.join(","));',
                "console.log('PROBE-DONE');",
                'process.exit(names.length === 2 && names.includes("renderer/") && names.includes("icon.png") ? 0 : 1);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /READDIR=icon\.png,renderer\//, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('existence probe then mkdir child does not leave ancestor negative cache', { skip: !windows }, async () => {
    // 回归：existsSync(不存在) 写入 300ms 负缓存后，mkdirSync(recursive) 只
    // 触发最深子路径的 CreateFile，中间祖先的负缓存残留导致随后的
    // readdirSync(父目录) 误报目录不存在（appmgr createApp 安装流程）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-negcache-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'negcache_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'const src = path.join(root, "created.app-" + Date.now());',
                'const seen = fs.existsSync(src);', // 写入 src 的负缓存（不存在）
                'fs.mkdirSync(path.join(src, "renderer"), { recursive: true });',
                'fs.writeFileSync(path.join(src, "icon.png"), "x");',
                'const items = fs.readdirSync(src, { withFileTypes: true });',
                'const names = items.map((e) => e.name).sort();',
                'console.log("EXISTS_BEFORE=" + seen + " READDIR=" + names.join(","));',
                "console.log('PROBE-DONE');",
                'process.exit(!seen && names.length === 2 ? 0 : 1);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
                        '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /EXISTS_BEFORE=false READDIR=icon\.png,renderer/, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('case-only rename (skill.md -> SKILL.md) succeeds like NTFS', { skip: !windows }, async () => {
    // 回归：仅大小写改名在宿主 NTFS 允许，.NET File.Move 的"目标已存在"
    // 预检查会误判共享冲突；MirrorFs 用 MoveFileExW 特判（skillmgr 安装）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-caserename-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'case_rename_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'const dir = path.join(root, "pkg");',
                'fs.mkdirSync(dir, { recursive: true });',
                'fs.writeFileSync(path.join(dir, "skill.md"), "x");',
                'try {',
                '    fs.renameSync(path.join(dir, "skill.md"), path.join(dir, "SKILL.md"));',
                // Windows 文件系统大小写不敏感：existsSync 无法区分 skill.md 与
                // SKILL.md（命中同一文件）。必须枚举目录条目名判断实际大小写。
                '    const entries = fs.readdirSync(dir);',
                '    const ok = entries.includes("SKILL.md") && !entries.includes("skill.md");',
                '    console.log("CASE_RENAME=" + (ok ? "OK" : "GHOST") + " entries=" + entries.join(","));',
                '    process.exit(ok ? 0 : 1);',
                '} catch (e) {',
                '    console.log("CASE_RENAME=FAIL " + e.code);',
                '    process.exit(1);',
                '}',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
                        '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /CASE_RENAME=OK/, result.stdout);
        // 宿主 Windows 大小写不敏感：existsSync 无法区分大小写，必须枚举条目名
        const hostEntries = fs.readdirSync(path.join(directory, 'probe-work', 'pkg'));
        assert.ok(hostEntries.includes('SKILL.md'));
        assert.ok(!hostEntries.includes('skill.md'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('large buffered write followed by ftruncate yields the exact final length', { skip: !windows }, async () => {
    // 回归：Dokan 驱动对部分页写入做 read-modify-write（ReadFile 整页 +
    // WriteFile 整页回写，未初始化部分补 NUL）。tar 解压 write(30)+ftruncate(30)
    // 被拆成 SetEndOfFile 先到、WriteFile(4096) 后到覆盖，解压文件残留 4KB
    // NUL pad（pluginmgr/skillmgr 读 package.json 解析失败）。MirrorFs 在
    // Cleanup 按 SetEndOfFile 提示兜底截断，文件长度必须精确等于目标。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-eofhint-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'eofhint_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'fs.mkdirSync(root, { recursive: true });',
                'const f = path.join(root, "package.json");',
                'const body = JSON.stringify({ name: "x", version: "1.0.0" });', // 30 字节
                // 模拟 tar 解压：先写 4KB 对齐缓冲（内容 + NUL pad），再 ftruncate 到真实长度
                'const fd = fs.openSync(f, "w");',
                'const padded = Buffer.alloc(4096);',
                'padded.write(body, 0, "utf-8");',
                'fs.writeSync(fd, padded, 0, padded.length, 0);',
                'fs.ftruncateSync(fd, Buffer.byteLength(body));',
                'fs.closeSync(fd);',
                'const st = fs.statSync(f);',
                'const read = fs.readFileSync(f);',
                'const exact = st.size === Buffer.byteLength(body) && read.length === Buffer.byteLength(body) && !read.includes(0);',
                'console.log("LEN=" + st.size + " READ=" + read.length + " EXACT=" + exact);',
                "console.log('PROBE-DONE');",
                'process.exit(exact ? 0 : 1);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
                        '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /LEN=30 READ=30 EXACT=true/, result.stdout);
        const hostRead = fs.readFileSync(path.join(directory, 'probe-work', 'package.json'));
        assert.equal(hostRead.length, 30, 'host file must not carry NUL padding');
        assert.equal(hostRead.includes(0), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('deep recursive rmSync does not report ENOTEMPTY on the volume', { skip: !windows }, async () => {
    // 回归：Dokan 递归删除（rmSync recursive）时子目录经 Cleanup 异步完成
    // 删除，父目录立即判空会短暂"非空"（go RemoveAll/Node rmSync 收尾形态）。
    // MirrorFs 加大判空退避后，复杂目录树一次性删除不得报 ENOTEMPTY。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-rmtree-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'rmtree_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'const base = path.join(root, "tree");',
                // 多层目录 + 文件，模拟 appmgr 的 appmgr/apps/created.app/renderer 形态
                'const mk = (p) => { fs.mkdirSync(p, { recursive: true }); };',
                'for (let i = 0; i < 4; i++) {',
                '    const dir = path.join(base, "apps", "created.app-" + i, "renderer");',
                '    mk(dir);',
                '    fs.writeFileSync(path.join(dir, "index.html"), "x");',
                '    fs.writeFileSync(path.join(path.dirname(dir), "icon.png"), "x");',
                '}',
                'try {',
                '    fs.rmSync(base, { recursive: true, force: true });',
                '    const gone = !fs.existsSync(base);',
                '    console.log("RM_TREE=" + (gone ? "OK" : "GHOST"));',
                '    process.exit(gone ? 0 : 1);',
                '} catch (e) {',
                '    console.log("RM_TREE=FAIL " + e.code);',
                '    process.exit(1);',
                '}',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
                        '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RM_TREE=OK/, result.stdout);
        assert.equal(fs.existsSync(path.join(directory, 'probe-work', 'tree')), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('concurrent readers of the same file do not hit EBUSY', { skip: !windows }, async () => {
    // 回归：jest 多 worker 并发读同一 transform 缓存文件时，Dokan 卷上偶发
    // ERROR_BUSY（另一 worker 句柄未完全释放）。MirrorFs 的急切开流与
    // EnsureStream 增加瞬态重试后，并发读同文件必须全部成功。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-ebusy-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'ebusy_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                'const { spawn } = require("node:child_process");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'fs.mkdirSync(root, { recursive: true });',
                'const shared = path.join(root, "cache.bin");',
                'fs.writeFileSync(shared, Buffer.alloc(64 * 1024, 0x41));',
                // 多进程并发读同一文件（jest 多 worker 形态）：每个进程反复
                // readFileSync，任一进程读失败（EBUSY/内容损坏）即整体失败。
                // 不引入 worker_threads——沙箱卷上 worker 的 __filename 解析受限。
                'const COUNT = 4, ROUNDS = 40;',
                'const readerCode = ',
                '  "const fs=require(\\"node:fs\\");const f=process.argv[1];" +',
                '  "for(let i=0;i<" + ROUNDS + ";i++){" +',
                '  "  const b=fs.readFileSync(f);" +',
                '  "  if(b.length!==64*1024||b[0]!==0x41)throw new Error(\\"corrupt\\");" +',
                '  "}console.log(\\"OK\\");";',
                'const readers = [];',
                'for (let i = 0; i < COUNT; i++) {',
                '    readers.push(new Promise((res) => {',
                '        const p = spawn(process.execPath, ["-e", readerCode, shared], { windowsHide: true });',
                '        p.stdout.on("data", () => {});',
                '        p.stderr.on("data", () => {});',
                '        p.on("close", (code) => res(code === 0));',
                '    }));',
                '}',
                'Promise.all(readers).then((oks) => {',
                '    const all = oks.every(Boolean);',
                '    console.log("CONCURRENT=" + (all ? "OK" : "FAIL"));',
                '    process.exit(all ? 0 : 1);',
                '});',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
                        '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /CONCURRENT=OK/, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
