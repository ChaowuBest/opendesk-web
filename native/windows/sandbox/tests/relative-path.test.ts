/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */
// 裸相对路径回归：CreateFileW("Makefile") 这类不含点分量的相对形式必须按
// 进程 CWD 展开后再判定。修复前 normalizeHostPath 只在含 `.`/`..` 分量时
// 展开，裸相对文本直接参与绝对 root 前缀匹配而失败，真实存在的文件被误判
// not-found（cmd type/nmake 等报"找不到文件"，实测 nmake U1052）。
//
// 注意：PowerShell 的 Set-Location 不改进程级 CWD，探针必须由沙箱以目标
// 目录为继承 CWD 启动（spawn cwd 选项），才能复现 cmd/nmake 的相对路径语义。
// 错误码区分：not-found(3) = hook 判定层误判（bug）；access-denied(5) = 策略
// 正确拦截。
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

async function run(file: string, args: string[], cwd: string, timeoutMs = 60000) {
    const proc = spawn(file, args, { windowsHide: true, env: process.env, cwd });
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
    proc.stdin.end();
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

// 直调 kernel32!CreateFileW 的 P/Invoke 探针（不经 MSVCRT/libuv 的 GetFullPathName
// 预归一化，裸相对路径原样到达 hook）。$args[0] = 相对目标。
// 输出 READ-OK 或 BLOCKED <err>。
const CreateFileProbeScript = String.raw`
$src = @"
using System;
using System.Runtime.InteropServices;
public static class RawOpen {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadFile(IntPtr h, byte[] buf, uint n, out uint read, IntPtr ov);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
}
"@
Add-Type -TypeDefinition $src
$GENERIC_READ = [uint32]2147483648
$OPEN_EXISTING = [uint32]3
Write-Output ("CWD=" + (Get-Location).Path)
$h = [RawOpen]::CreateFileW($args[0], $GENERIC_READ, [uint32]1, [IntPtr]::Zero, $OPEN_EXISTING, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1) -or $h -eq [IntPtr]::Zero) { Write-Output ("BLOCKED " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 0 }
$buf = New-Object byte[] 16
$read = [uint32]0
$ok = [RawOpen]::ReadFile($h, $buf, 16, [ref]$read, [IntPtr]::Zero)
if ($ok -and $read -gt 0) { Write-Output ("READ-OK " + [Text.Encoding]::UTF8.GetString($buf, 0, [int]$read)) }
else { Write-Output "READ-EMPTY" }
[RawOpen]::CloseHandle($h) | Out-Null
`;

function writeAllowAllPolicy(directory: string): string {
    const policy = path.join(directory, 'policy.toml');
    fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
    return policy;
}

function writeDenySubdirPolicy(directory: string): string {
    const policy = path.join(directory, 'policy.toml');
    const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
    fs.writeFileSync(
        policy,
        'version = 1\ndefault = "allow"\n' +
            `[[rules]]\npath = "${dirVirtual}/secret/**"\naccess = "all"\nperm = "deny"\n` +
            '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
    );
    return policy;
}

async function runProbe(policy: string, cwd: string, probePath: string, target: string) {
    return run(
        executable,
        ['run', '--automount', '--policy', policy, '--', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probePath, target],
        cwd,
        60000
    );
}

test('CreateFileW with bare relative path resolves against cwd (nmake regression)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rel-'));
    try {
        const policy = writeAllowAllPolicy(directory);
        fs.writeFileSync(path.join(directory, 'Makefile'), 'RELATIVE-OK');
        const probe = path.join(directory, 'rel_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript);
        const result = await runProbe(policy, directory, probe, 'Makefile');
        assert.match(result.stdout, /READ-OK/, `stdout: ${result.stdout} stderr: ${result.stderr}`);
        assert.ok(!result.stdout.includes('BLOCKED 3'), 'bare relative path must not be misjudged as not-found');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('CreateFileW with .\\ prefixed relative path still resolves', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rel-dot-'));
    try {
        const policy = writeAllowAllPolicy(directory);
        fs.writeFileSync(path.join(directory, 'Makefile'), 'DOTSLASH-OK');
        const probe = path.join(directory, 'rel_dot_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript);
        const result = await runProbe(policy, directory, probe, '.\\Makefile');
        assert.match(result.stdout, /READ-OK/, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('bare relative path into a denied subdirectory is denied (not not-found)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rel-deny-'));
    try {
        const policy = writeDenySubdirPolicy(directory);
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(path.join(directory, 'secret', 'key.txt'), 'TOP-SECRET');
        const probe = path.join(directory, 'rel_deny_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript);
        // 相对路径形式的 deny 目标必须以 ACCESS_DENIED(5) 拦截；NOT_FOUND(3)
        // 说明相对路径未按 CWD 展开（判定层把已挂载路径当成了沙箱外）
        const result = await runProbe(policy, directory, probe, 'secret\\key.txt');
        assert.match(result.stdout, /BLOCKED 5/, `expect access-denied, stdout: ${result.stdout}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('drive-relative path (D:file) resolves against that drive current directory', { skip: !windows }, async () => {
    // 同缺陷类的盘符相对形式：C:foo 语义 = 该盘当前目录下的 foo（而非绝对）。
    // GetFullPathNameW 按盘符当前目录展开，与 Win32/内核语义一致。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rel-drive-'));
    try {
        const policy = writeAllowAllPolicy(directory);
        fs.writeFileSync(path.join(directory, 'drivefile.txt'), 'DRIVE-REL-OK');
        const probe = path.join(directory, 'rel_drive_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript);
        const driveLetter = directory.slice(0, 2); // "C:"
        const result = await runProbe(policy, directory, probe, `${driveLetter}drivefile.txt`);
        assert.match(result.stdout, /READ-OK/, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
