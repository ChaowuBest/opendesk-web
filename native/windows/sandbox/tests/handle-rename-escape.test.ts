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
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';

async function run(file: string, args: string[], stdin = '', env = process.env, timeoutMs = 60000) {
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

// 用 PowerShell P/Invoke 直调 kernel32!SetFileInformationByHandle(FileRenameInfo)，
// 复刻 .NET/Cygwin 等句柄级 rename 路径（不经 MoveFileExW 双路径检查）。
// 探针输出 RENAME-OK（重命名被执行）或 RENAME-BLOCKED <err>（被拒绝）。
const PInvokeRenameScript = String.raw`
$src = @"
using System;
using System.Runtime.InteropServices;
public static class RenEscape {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetFileInformationByHandle(IntPtr h, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")]
    public static extern void ZeroMemory(IntPtr p, UIntPtr len);
}
"@
Add-Type -TypeDefinition $src
$h = [RenEscape]::CreateFileW($args[0], [uint32]0x10000, [uint32]0, [IntPtr]::Zero, [uint32]3, [uint32]0x80, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1) -or $h -eq [IntPtr]::Zero) { Write-Output ("OPEN-FAIL " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
$nb = [System.Text.Encoding]::Unicode.GetBytes($args[1] + [char]0)   # FileName 需 null 结尾
$total = 20 + $nb.Length
$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($total)
[RenEscape]::ZeroMemory($mem, [UIntPtr]::new([uint64]$total))
[Runtime.InteropServices.Marshal]::WriteByte($mem, 0, 1)             # ReplaceIfExists
[Runtime.InteropServices.Marshal]::WriteByte($mem, 16, ($nb.Length -band 0xFF))
[Runtime.InteropServices.Marshal]::WriteByte($mem, 17, (($nb.Length -shr 8) -band 0xFF))
[Runtime.InteropServices.Marshal]::WriteByte($mem, 18, (($nb.Length -shr 16) -band 0xFF))
[Runtime.InteropServices.Marshal]::WriteByte($mem, 19, (($nb.Length -shr 24) -band 0xFF))
for ($i = 0; $i -lt $nb.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($mem, 20 + $i, $nb[$i]) }
$ok = [RenEscape]::SetFileInformationByHandle($h, 3, $mem, [uint32]$total)   # FileRenameInfo = 3
if ($ok) { Write-Output "RENAME-OK" } else { Write-Output ("RENAME-BLOCKED " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
[Runtime.InteropServices.Marshal]::FreeHGlobal($mem) | Out-Null
[RenEscape]::CloseHandle($h) | Out-Null
`;

function writeRenameProbe(directory: string): string {
    const probe = path.join(directory, 'rename_probe.ps1');
    fs.writeFileSync(probe, PInvokeRenameScript, 'ascii');
    return probe;
}

function writeDenySecretPolicy(directory: string): string {
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

test('handle-level rename (SetFileInformationByHandle FileRenameInfo) cannot move a file into a denied directory', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rename-escape-'));
    try {
        const policy = writeDenySecretPolicy(directory);
        const probe = writeRenameProbe(directory);
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const src = path.join(directory, 'pub', 'movable.txt');
        const dst = path.join(directory, 'secret', 'stolen.txt');
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(src, 'MOVE-ME');
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${src}" "${dst}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 目标在 deny 目录：句柄级 rename 必须被拒绝，且源文件不得消失
        assert.match(result.stdout, /RENAME-BLOCKED/, `rename into denied dir must be blocked, got: ${result.stdout}`);
        assert.equal(fs.existsSync(src), true, 'source file must survive when rename target is denied');
        assert.equal(fs.existsSync(dst), false, 'denied rename target must not materialize');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('handle-level rename (FileRenameInfo) into an allowed directory still works', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rename-ok-'));
    try {
        const policy = writeDenySecretPolicy(directory);
        const probe = writeRenameProbe(directory);
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const src = path.join(directory, 'pub', 'movable.txt');
        const dst = path.join(directory, 'pub', 'moved.txt');
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(src, 'MOVE-ME');
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${src}" "${dst}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RENAME-OK/, `rename within allowed dir must work, got: ${result.stdout}`);
        assert.equal(fs.existsSync(dst), true, 'allowed rename target must materialize');
        assert.equal(fs.existsSync(src), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
