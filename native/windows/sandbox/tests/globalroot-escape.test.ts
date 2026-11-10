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

// 探针：在沙箱子进程内自行解析当前卷号并构造 GLOBALROOT 设备路径
// `\\?\GLOBALROOT\Device\HarddiskVolumeN\<rel>\secret\key.txt` 直调 CreateFileW 访问。
// 输出 READ-OK <b64>（读到内容）或 BLOCKED <err>（被拦截）或 NO-VOLNUM（无法解析卷号）。
const GlobalRootProbeScript = String.raw`
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
$abs = $args[0]
$drive = [System.IO.Path]::GetPathRoot($abs).TrimEnd('\', '/').ToUpperInvariant()
$part = Get-CimInstance Win32_LogicalDiskToPartition | Where-Object { $_.Dependent.DeviceID -eq $drive + ':' } | Select-Object -First 1
$m = [regex]::Match($part.Antecedent.DeviceID, "HarddiskVolume(\d+)")
if (-not $m.Success) { Write-Output "NO-VOLNUM"; exit 0 }
$rel = $abs.Substring($drive.Length + 1)
$devPath = "\\?\GLOBALROOT\Device\HarddiskVolume" + $m.Groups[1].Value + "\" + $rel
$GENERIC_READ = [uint32]2147483648
$OPEN_EXISTING = [uint32]3
$h = [RawOpen]::CreateFileW($devPath, $GENERIC_READ, [uint32]1, [IntPtr]::Zero, $OPEN_EXISTING, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1) -or $h -eq [IntPtr]::Zero) { Write-Output ("BLOCKED " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 0 }
$buf = New-Object byte[] 8
$read = [uint32]0
$ok = [RawOpen]::ReadFile($h, $buf, 8, [ref]$read, [IntPtr]::Zero)
if ($ok -and $read -gt 0) { Write-Output ("READ-OK " + [Convert]::ToBase64String($buf, 0, [int]$read)) }
else { Write-Output "READ-EMPTY" }
[RawOpen]::CloseHandle($h) | Out-Null
`;

test('\\?\\GLOBALROOT device path cannot bypass a denied directory', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-globalroot-'));
    try {
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${dirVirtual}/secret/**"\naccess = "all"\nperm = "deny"\n` +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
        );
        const probe = path.join(directory, 'globalroot_probe.ps1');
        fs.writeFileSync(probe, GlobalRootProbeScript, 'ascii');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const secretKey = path.join(directory, 'secret', 'key.txt');
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(secretKey, 'TOPSECRET-GLOBALROOT');

        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${secretKey}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /NO-VOLNUM|BLOCKED/, `GLOBALROOT device path must be blocked, got: ${result.stdout}`);
        assert.doesNotMatch(result.stdout, /READ-OK/, 'must not read denied file via GLOBALROOT device path');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
