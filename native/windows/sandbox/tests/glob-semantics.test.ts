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

async function run(file: string, args: string[], stdin = '', env = process.env, timeoutMs = 30000) {
    const proc = spawn(file, args, { windowsHide: true, env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
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

test('glob matching with many * patterns and long paths completes quickly (no exponential blowup)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-globperf-'));
    try {
        // 多个 `*a` 段是合法策略写法（如 `/*a*a*a*...b/**`）
        const rulePath = '/' + '*a'.repeat(12) + 'b/**';
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${rulePath}"\naccess = "all"\nperm = "deny"\n`
        );
        // 与模式结构类似但不带结尾 b 的长路径（最坏回溯路径）
        const probePath = '/' + 'a'.repeat(30) + 'zz/inner/file.txt';
        const began = Date.now();
        // 超时阈值：修复后（O(n*m) 迭代）应在百毫秒级；递归回溯会卡死到超时
        const result = await run(executable, ['debug-rules', '--policy', policy, '--path', probePath, '--access', 'read'], '', process.env, 10000);
        const elapsed = Date.now() - began;
        assert.ok(elapsed < 3000, `glob must finish quickly, took ${elapsed}ms (exponential blowup)`);
        assert.equal(result.code, 0, `debug-rules should exit 0, got code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('glob semantics: * does not cross /, ** crosses /, ? matches one non-slash char', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-globsem-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            [
                'version = 1',
                'default = "allow"',
                '[[rules]]',
                'path = "/d/x/*/e.txt"',
                'access = "read"',
                'perm = "deny"',
                '[[rules]]',
                'path = "/d/y/**/f.txt"',
                'access = "read"',
                'perm = "deny"',
                '[[rules]]',
                'path = "/d/z/?/g.txt"',
                'access = "read"',
                'perm = "deny"',
            ].join('\n')
        );
        // `*` 单层：/d/x/a/e.txt 命中 deny，/d/x/a/b/e.txt 不命中
        let r = await run(executable, ['debug-rules', '--policy', policy, '--path', '/d/x/a/e.txt', '--access', 'read']);
        assert.match(r.stdout, /deny/, `* across one level must match: ${r.stdout}`);
        r = await run(executable, ['debug-rules', '--policy', policy, '--path', '/d/x/a/b/e.txt', '--access', 'read']);
        assert.match(r.stdout, /allow/, `* must not cross /: ${r.stdout}`);

        // `**` 跨层：/d/y/a/b/c/f.txt 命中 deny
        r = await run(executable, ['debug-rules', '--policy', policy, '--path', '/d/y/a/b/c/f.txt', '--access', 'read']);
        assert.match(r.stdout, /deny/, `** must cross levels: ${r.stdout}`);

        // `?` 单字符：/d/z/A/g.txt 命中 deny，/d/z/AA/g.txt 不命中
        r = await run(executable, ['debug-rules', '--policy', policy, '--path', '/d/z/A/g.txt', '--access', 'read']);
        assert.match(r.stdout, /deny/, `? matches one char: ${r.stdout}`);
        r = await run(executable, ['debug-rules', '--policy', policy, '--path', '/d/z/AA/g.txt', '--access', 'read']);
        assert.match(r.stdout, /allow/, `? must match exactly one char: ${r.stdout}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});