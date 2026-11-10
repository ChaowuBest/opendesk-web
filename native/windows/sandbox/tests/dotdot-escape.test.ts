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

// 直调 kernel32!CreateFileW 的 P/Invoke 探针（不经 MSVCRT/libuv 的 GetFullPathName 预归一化，
// 因此路径中的 `..` 会原样到达 hook）。输出 READ-OK（内容被读到）或 BLOCKED <err>。
// CREATEFILE 直调：$args[0] = 路径。返回 RFD-OK <base64 首字节> 表示读到内容。
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
$h = [RawOpen]::CreateFileW($args[0], $GENERIC_READ, [uint32]1, [IntPtr]::Zero, $OPEN_EXISTING, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1) -or $h -eq [IntPtr]::Zero) { Write-Output ("BLOCKED " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 0 }
$buf = New-Object byte[] 8
$read = [uint32]0
$ok = [RawOpen]::ReadFile($h, $buf, 8, [ref]$read, [IntPtr]::Zero)
if ($ok -and $read -gt 0) { Write-Output ("READ-OK " + [Convert]::ToBase64String($buf, 0, [int]$read)) }
else { Write-Output "READ-EMPTY" }
[RawOpen]::CloseHandle($h) | Out-Null
`;

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

// 直调 kernel32!GetFileAttributesW 的 P/Invoke 探针（属性探测路径：内部走
// NtQueryAttributesFile，不经 NtCreateFile 二次判定兜底）。输出
// GFA-VISIBLE attrs=0xXXXX（属性可见）或 GFA-BLOCKED <err>（被 deny 拦截）。
const GetFileAttributesProbeScript = String.raw`
$src = @"
using System;
using System.Runtime.InteropServices;
public static class GFAProbe {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern uint GetFileAttributesW(string name);
}
"@
Add-Type -TypeDefinition $src
$r = [GFAProbe]::GetFileAttributesW($args[0])
if ($r -eq 4294967295) { Write-Output ("GFA-BLOCKED " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
else { Write-Output ("GFA-VISIBLE 0x" + $r.ToString("X8")) }
`;

test('GetFileAttributesW with .. alias cannot probe a denied directory (attributes leak)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-dotdot-gfa-'));
    try {
        const policy = writeDenySecretPolicy(directory);
        const probe = path.join(directory, 'gfa_probe.ps1');
        fs.writeFileSync(probe, GetFileAttributesProbeScript, 'ascii');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const secretKey = path.join(directory, 'secret', 'key.txt');
        // 注意：不能用 path.join 拼接 `..`（它会被规范化掉）——必须保留字面 `pub\..\secret`
        const dotDotKey = `${directory}\\pub\\..\\secret\\key.txt`;
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.writeFileSync(secretKey, 'TOPSECRET-DOTDOT');

        // 对照组：plain 路径必须被 deny 拦截
        const plain = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${secretKey}"`
        ]);
        assert.equal(plain.code, 0, plain.stdout + plain.stderr);
        assert.match(plain.stdout, /GFA-BLOCKED/, `plain denied path must be blocked, got: ${plain.stdout}`);

        // `pub\..\secret\key.txt` 归一化后等同 secret\key.txt：必须同样被拦截，
        // 不得泄露 deny 目录内文件的存在性。
        const alias = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${dotDotKey}"`
        ]);
        assert.equal(alias.code, 0, alias.stdout + alias.stderr);
        assert.match(alias.stdout, /GFA-BLOCKED/, `.. alias into denied dir must be blocked, got: ${alias.stdout}`);
        assert.doesNotMatch(alias.stdout, /GFA-VISIBLE/, 'must not reveal attributes of denied file via .. alias');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('middle path components with trailing dots/spaces cannot probe a denied directory', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-dotcomp-'));
    try {
        const policy = writeDenySecretPolicy(directory);
        const probe = path.join(directory, 'createfile_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript, 'ascii');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const secretKey = path.join(directory, 'secret', 'key.txt');
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(secretKey, 'TOPSECRET-DOTCOMP');

        // Windows 归一化：`dir. ` / `dir.` 分量等同 `dir`，实际访问的是 secret\key.txt。
        // 用字符串拼接保留字面尾点/空格（path.join 会清理它们）。
        const aliases = [
            `${directory}\\secret.\\key.txt`,      // 目录分量尾点
            `${directory}\\secret. \\key.txt`      // 目录分量尾点+空格
        ];
        for (const alias of aliases) {
            const result = await run(executable, [
                'run', '--policy', policy, '--',
                `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${alias}"`
            ]);
            assert.equal(result.code, 0, result.stdout + result.stderr);
            assert.match(result.stdout, /BLOCKED/, `trailing-dot alias ${JSON.stringify(alias)} must be blocked, got: ${result.stdout}`);
            assert.doesNotMatch(result.stdout, /READ-OK/, `must not read denied file via trailing-dot alias ${JSON.stringify(alias)}`);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('absolute paths with .. are expanded before policy evaluation (CreateFileW direct call)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-dotdot-'));
    try {
        const policy = writeDenySecretPolicy(directory);
        const probe = path.join(directory, 'createfile_probe.ps1');
        fs.writeFileSync(probe, CreateFileProbeScript, 'ascii');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const secretKey = path.join(directory, 'secret', 'key.txt');
        // 保留字面 `pub\..\secret`（path.join 会规范化掉 `..`）
        const dotDotKey = `${directory}\\pub\\..\\secret\\key.txt`;
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.writeFileSync(secretKey, 'TOPSECRET-DOTDOT');

        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${dotDotKey}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // `pub\..\secret\key.txt` 归一化后等同 secret\key.txt（deny），
        // 必须被拦在 CreateFileW 判定层（不经 MSVCRT 归一化，路径原样到达 hook）。
        assert.match(result.stdout, /BLOCKED/, `.. traversal into denied dir must be blocked, got: ${result.stdout}`);
        assert.doesNotMatch(result.stdout, /READ-OK/, 'must not read denied file via .. traversal');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
