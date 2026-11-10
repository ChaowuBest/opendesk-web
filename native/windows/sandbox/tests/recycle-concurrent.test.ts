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

// 探针（在沙箱子进程内执行）：
// 1) 创建含 N 个文件的 big 目录（SHFileOperation 回收它需要一定时间）；
// 2) 创建无关 small 文件；
// 3) 主线程调 SHFileOperation 把 big 目录送回收站（触发 hook 回收站重入路径，
//    进程级 RecycleGuard 置位）；
// 4) worker 线程在回收进行中删除 small 文件；
// 5) 断言 small 真的被删除。
// 输出：LFREE（small 已删，正确）/ LSTUCK（small 没删但被"静默成功"，bug）
//       / SMALL-DELETE-FAILED <err>（删除被拒绝）。
const ConcurrentRecycleProbeScript = String.raw`
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RecycleConc {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct SHFILEOPSTRUCT {
        public IntPtr hwnd;
        public int wFunc;
        public string pFrom;
        public string pTo;
        public ushort fFlags;
        public int fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string lpszProgressTitle;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool DeleteFileW(string name);

    public static void Build(string bigDir, int count) {
        if (System.IO.Directory.Exists(bigDir)) System.IO.Directory.Delete(bigDir, true);
        System.IO.Directory.CreateDirectory(bigDir);
        for (int i = 0; i < count; i++)
            System.IO.File.WriteAllText(System.IO.Path.Combine(bigDir, "f" + i + ".txt"), "B");
    }

    public static string Work(string bigDir, string small) {
        string result = "UNKNOWN";
        var worker = new Thread(() => {
            // 极短延迟：保证在主线程 SHFileOperation 回收流程活跃时尝试删除
            Thread.Sleep(20);
            bool ok = false;
            int lastErr = 0;
            for (int t = 0; t < 10; t++) {
                ok = DeleteFileW(small);
                lastErr = Marshal.GetLastWin32Error();
                if (ok) break;
                Thread.Sleep(10);
            }
            if (!ok) { result = "SMALL-DELETE-FAILED " + lastErr; return; }
            Thread.Sleep(200);
            result = System.IO.File.Exists(small) ? "LSTUCK" : "LFREE";
        });
        worker.IsBackground = true;
        worker.Start();
        var op = new SHFILEOPSTRUCT();
        op.wFunc = 3; // FO_DELETE
        op.pFrom = bigDir + "\0\0";
        op.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0008; // ALLOWUNDO|NOCONFIRMATION|NOERRORUI|SILENT
        op.hwnd = IntPtr.Zero;
        int r = SHFileOperation(ref op);
        worker.Join(5000);
        return result + " (shoper=" + r + ")";
    }
}
"@
Add-Type -TypeDefinition $src
$bigDir = $args[0]
$small = $args[1]
[RecycleConc]::Build($bigDir, 600)
[RecycleConc]::Work($bigDir, $small)
`;

test('concurrent delete of an unrelated file is not swallowed by an in-progress recycle-bin operation', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-recycleconc-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const probe = path.join(directory, 'recycle_conc.ps1');
        fs.writeFileSync(probe, ConcurrentRecycleProbeScript, 'ascii');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const bigDir = path.join(directory, 'big');
        const small = path.join(directory, 'small.txt');
        // small 由宿主在沙箱会话开始前创建（会话外文件）：回收站守卫窗口内
        // 删除它必须真实执行，不得因"回收站流程中"被静默 no-op（LSTUCK）。
        // big 目录由探针在沙箱内创建（其文件是会话内创建，SHFileOperation 回收
        // 时长足够覆盖 worker 的删除时机）。
        fs.writeFileSync(small, 'S');
        const result = await run(executable, [
            'run', '--del-to-trash', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -File "${probe}" "${bigDir}" "${small}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /LFREE/, `unrelated concurrent delete must actually delete the file, got: ${result.stdout}`);
        assert.doesNotMatch(result.stdout, /LSTUCK/, 'unrelated delete must not be silently swallowed');
        assert.doesNotMatch(result.stdout, /SMALL-DELETE-FAILED/, 'unrelated delete must not fail');
        assert.equal(fs.existsSync(small), false, 'small file must be gone on host after sandbox delete');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});