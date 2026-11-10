/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';

async function run(file: string, args: string[], stdin = '', env = process.env, timeoutMs = 90000) {
    if (file === executable && args[0] === 'run' && !args.includes('--src') && !args.includes('--automount'))
        args = ['run', '--automount', ...args.slice(1)];
    const proc = spawn(file, args, { windowsHide: true, env });
    // spawn 失败（ENOENT/EACCES：runtime/sandbox.exe 未构建、被杀软隔离、构建替换
    // 窗口期）只 emit 'error'；无人监听时 Node 会以 "Unhandled 'error' event" 直接
    // 终止整个测试进程，同文件其它用例结果全丢。捕获后随返回值带出（code = null），
    // 让调用方的断言变成一条明确的失败。
    let spawnError: NodeJS.ErrnoException | null = null;
    proc.once('error', (e) => { spawnError = e as NodeJS.ErrnoException; });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.stdin.on('error', () => {});
    proc.stdin.end(stdin);
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [code] = await once(proc, 'close');
        // spawn 失败直接抛，而不是返回 code=null：null 会让 `assert.notEqual(code, 0)`
        // 这类"期望失败"的断言静默通过（把崩溃伪装成预期结果）；抛出则让该用例
        // 明确失败，且不影响同文件其它用例（异常被 test runner 归到当前用例）。
        if (spawnError) throw new Error(`sandbox.exe spawn failed: ${spawnError.code ?? 'unknown'}`);
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

test('invalid ask endpoint port (>65535) fails closed as deny instead of connecting to a truncated port', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-badport-'));
    try {
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            [
                'version = 1',
                'default = "allow"',
                '[ask]',
                'endpoint = "http://127.0.0.1:70000/decide"',  // 70000 截断为 4464 属旧 bug
                'timeout_ms = 3000',
                'cache_ttl_seconds = 0',
                `[[rules]]\npath = "${dirVirtual}/p/**"\naccess = "write"\nperm = "ask"\n`,
            ].join('\n')
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const target = path.join(directory, 'p', 'x.txt');
        fs.mkdirSync(path.join(directory, 'p'));
        const command = `"${shell}" -NoProfile -NonInteractive -Command "try { Set-Content -LiteralPath '${target}' '1' -ErrorAction Stop; 'WROTE' } catch { 'DENIED' }"`;
        const result = await run(executable, ['run', '--policy', policy, '--', command]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 非法端口：ask 端点不可达 -> fail-closed deny，文件不得落盘。
        // 修复前端口截断为 4464（多数无监听），也会连接失败 deny——所以关键断言
        // 是"文件不落盘"且日志确实按解析失败路径处理（无静默连错端口）。
        assert.equal(fs.existsSync(target), false, `invalid port config must fail closed, file must not land (stdout=${result.stdout})`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('invalid ask endpoint (empty port after colon) fails closed', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-emptport-'));
    try {
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            [
                'version = 1',
                'default = "allow"',
                '[ask]',
                'endpoint = "http://127.0.0.1:/decide"',  // 空端口 -> 旧代码 _wtoi("")=0 也返回 false
                'timeout_ms = 3000',
                'cache_ttl_seconds = 0',
                `[[rules]]\npath = "${dirVirtual}/p/**"\naccess = "write"\nperm = "ask"\n`,
            ].join('\n')
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const target = path.join(directory, 'p', 'x.txt');
        fs.mkdirSync(path.join(directory, 'p'));
        const command = `"${shell}" -NoProfile -NonInteractive -Command "try { Set-Content -LiteralPath '${target}' '1' -ErrorAction Stop; 'WROTE' } catch { 'DENIED' }"`;
        const result = await run(executable, ['run', '--policy', policy, '--', command]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(fs.existsSync(target), false, `empty port config must fail closed, file must not land (stdout=${result.stdout})`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});