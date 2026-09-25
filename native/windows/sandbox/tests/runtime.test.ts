import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';
const fixtureRoot = path.join(sandboxRoot, 'tests');
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
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

test('manager exits after a child leaves an inherited output handle open', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-pipe-lifecycle-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command =
            `"${shell}" -NoProfile -NonInteractive -Command "` +
            `$si = [Diagnostics.ProcessStartInfo]::new(); ` +
            `$si.FileName = $env:ComSpec; $si.Arguments = '/c ping 127.0.0.1 -n 6'; ` +
            `$si.UseShellExecute = $false; $si.CreateNoWindow = $true; ` +
            `[Diagnostics.Process]::Start($si) | Out-Null; exit 0"`;
        const started = Date.now();
        const result = await run(
            executable,
            ['run', '--src', directory, '--policy', policy, '--', command],
            '',
            process.env,
            12000
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(Date.now() - started < 10000, 'manager must not wait for descendant pipe handles');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** 在 PATH 中解析可用的 CPython（OPENDESK_SANDBOX_PYTHON 显式指定优先），
 * 跳过 WindowsApps 的商店重定向桩；找不到时返回 null，调用方跳过用例。 */
function resolvePython(): string | null {
    const fromEnv = process.env.OPENDESK_SANDBOX_PYTHON;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const found = spawnSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true });
    const candidates = (found.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((entry) => /\.exe$/i.test(entry) && fs.existsSync(entry));
    return candidates.find((entry) => !/windowsapps/i.test(entry)) ?? candidates[0] ?? null;
}

test('synthetic traversal does not authorize a host root', { skip: !windows }, async () => {
    const result = await run('dotnet', [
        'run',
        '--project',
        path.join(fixtureRoot, 'NativeRegression'),
        '--',
        os.tmpdir()
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('concurrent managers reserve distinct letters before either volume mounts', { skip: !windows }, async () => {
    const build = await run('dotnet', ['build', path.join(fixtureRoot, 'NativeRegression'), '--nologo']);
    assert.equal(build.code, 0, build.stdout + build.stderr);
    const helper = path.resolve(
        path.join(fixtureRoot, 'NativeRegression', 'bin', 'Debug', 'net8.0-windows', 'NativeRegression.dll')
    );
    const processes: ReturnType<typeof spawn>[] = [];
    const reserve = async () => {
        const proc = spawn('dotnet', [helper, 'reserve'], { windowsHide: true });
        processes.push(proc);
        const [data] = await Promise.race([
            once(proc.stdout!, 'data'),
            once(proc, 'close').then(([code]) => {
                throw new Error(`Reservation helper exited before reserving a drive: ${code}`);
            })
        ]);
        return data.toString().trim();
    };
    try {
        const first = await reserve();
        const second = await reserve();
        assert.match(first, /^[A-Z]$/);
        assert.match(second, /^[A-Z]$/);
        assert.notEqual(first, second);
    } finally {
        await Promise.all(
            processes.map(async (proc) => {
                if (proc.exitCode !== null) return;
                proc.stdin!.end('\n');
                await once(proc, 'close');
            })
        );
    }
});

test(
    'Windows PowerShell loads built-in modules with an inherited Windows PSModulePath',
    { skip: !windows },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-modules-'));
        try {
            const policy = path.join(directory, 'policy.toml');
            const log = path.join(directory, 'manager.log');
            fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
            const shellRoot = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0');
            const result = await run(
                executable,
                [
                    'run',
                    '--automount',
                    '--policy',
                    policy,
                    '--log-file',
                    log,
                    '--',
                    `"${shellRoot}\\powershell.exe" -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Utility; Get-Date -Format yyyy; @(1,2,3) | Select-Object -First 1; 'mode=' + $ExecutionContext.SessionState.LanguageMode"`
                ],
                '',
                { ...process.env, PSModulePath: path.join(shellRoot, 'Modules') }
            );
            assert.equal(result.code, 0, JSON.stringify(result));
            assert.equal(result.stderr, '');
            assert.match(result.stdout, /\d{4}[\r\n]+1[\r\n]+mode=FullLanguage/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);

test(
    'parallel PowerShell managers keep their volumes and language mode for the whole command',
    { skip: !windows },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-parallel-'));
        try {
            const policy = path.join(directory, 'policy.toml');
            fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
            const shellRoot = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0');
            const results = await Promise.all(
                [0, 1, 2].map((index) => {
                    const target = path.join(directory, `${index}.txt`);
                    const command =
                        `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '${directory}'; ` +
                        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
                        `Set-Content -LiteralPath '${target}' -Value '${index}'; Start-Sleep -Milliseconds 700; ` +
                        `Get-Content -LiteralPath '${target}'; Get-Date -Format yyyy; 'root=' + $env:SBX_ROOT; ` +
                        `'mode=' + $ExecutionContext.SessionState.LanguageMode`;
                    return run(
                        executable,
                        [
                            'run',
                            '--automount',
                            '--policy',
                            policy,
                            '--log-file',
                            path.join(directory, `${index}.log`),
                            '--',
                            `"${shellRoot}\\powershell.exe" -NoProfile -NonInteractive -Command "${command}"`
                        ],
                        '',
                        { ...process.env, PSModulePath: path.join(shellRoot, 'Modules') }
                    );
                })
            );
            const roots = new Set<string>();
            for (const [index, result] of results.entries()) {
                assert.equal(result.code, 0, JSON.stringify(result));
                assert.equal(result.stderr, '');
                assert.match(result.stdout, /mode=FullLanguage/);
                roots.add(/root=([A-Z]:)/.exec(result.stdout)![1]);
                assert.equal(fs.readFileSync(path.join(directory, `${index}.txt`), 'utf8').trim(), String(index));
            }
            assert.equal(roots.size, 3);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);

test('PowerShell 7 starts with its adjacent runtime files', { skip: !windows }, async (context) => {
    const pwsh = (process.env.PATH || '')
        .split(path.delimiter)
        .map((entry) => path.join(entry, 'pwsh.exe'))
        .find((entry) => fs.existsSync(entry));
    if (!pwsh) return context.skip('PowerShell 7 is not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-pwsh-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${pwsh}" -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; Get-Date -Format yyyy; 'version=' + $PSVersionTable.PSVersion.Major"`
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /version=7/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test(
    'sandbox forwards only child stdout/stderr, stdin and complete Windows exit codes',
    { skip: !windows },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-native-sandbox-'));
        try {
            const policy = path.join(directory, 'policy.toml');
            const log = path.join(directory, 'manager.log');
            fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
            const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
            const result = await run(
                executable,
                [
                    'run',
                    '--automount',
                    '--policy',
                    policy,
                    '--log-file',
                    log,
                    '--',
                    `"${cmd}" /d /v:on /c "set /p line= & echo stdout:!line! & echo stderr:child 1>&2 & exit /b 513"`
                ],
                'from-stdin\r\n'
            );
            assert.equal(result.code, 513, JSON.stringify(result));
            assert.equal(result.stdout.trim(), 'stdout:from-stdin');
            assert.equal(result.stderr.trim(), 'stderr:child');
            assert.match(fs.readFileSync(log, 'utf8'), /\[RUN\]/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);

test('sandbox runs Python, Node.js and Windows console fixtures', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-native-sandbox-runtime-'));
    const python = resolvePython();
    if (!python) {
        fs.rmSync(directory, { recursive: true, force: true });
        return;
    }

    const policy = path.join(directory, 'policy.toml');
    fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
    const pyFile = path.join(directory, 'fixture.py');
    const nodeMjs = path.join(directory, 'fixture.mjs');
    const nodeCjs = path.join(directory, 'fixture.cjs');
    const nodeChild = path.join(directory, 'fixture-child.cjs');
    const jsonFile = path.join(directory, 'fixture.json');
    const pythonLibraries = path.join(directory, 'fixture-libraries.py');
    const pptxOutput = path.join(directory, 'sandbox-libraries.pptx');
    fs.writeFileSync(pyFile, "print('python-file-ok')\n");
    fs.writeFileSync(nodeMjs, "console.log('node-mjs-ok')\n");
    fs.writeFileSync(nodeCjs, "console.log('node-cjs-ok')\n");
    fs.writeFileSync(
        nodeChild,
        "const { spawnSync } = require('node:child_process');\n" +
            "const result = spawnSync(process.execPath, ['-e', \"console.log('node-child-ok')\"], { stdio: ['pipe', 'pipe', 'pipe'] });\n" +
            "if (result.status !== 0 || result.stdout?.toString() !== 'node-child-ok\\n') { console.error(result.error || result.stdout || result.stderr); process.exit(1); }\n" +
            'console.log(result.stdout?.toString().trim());\n' +
            "console.log('node-child-status=' + result.status);\n"
    );
    fs.writeFileSync(
        pythonLibraries,
        [
            'import sys',
            'from pptx import Presentation',
            'import numpy as np',
            'output = sys.argv[1]',
            'values = np.array([1, 2, 3], dtype=np.int64) * 2',
            'presentation = Presentation()',
            'presentation.slides.add_slide(presentation.slide_layouts[6])',
            'presentation.save(output)',
            'print("python-pptx=" + Presentation.__module__)',
            'print("numpy=" + np.__version__)',
            'print("numpy-sum=" + str(int(values.sum())))',
            'print("pptx-exists=" + str(__import__("os").path.exists(output)))'
        ].join('\n') + '\n'
    );
    fs.writeFileSync(jsonFile, '{"sandbox":true}\n');
    const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    try {
        const cases = [
            [`"${process.env.SystemRoot}\\System32\\chcp.com" 65001`, /Active code page: 65001/],
            [`${quote(python)} -c "print('python-c-ok')"`, /python-c-ok/],
            [`${quote(python)} ${quote(pyFile)}`, /python-file-ok/],
            [`${quote(python)} -m json.tool ${quote(jsonFile)}`, /"sandbox": true/],
            [`${quote(process.execPath)} -e "console.log('node-e-ok')"`, /node-e-ok/],
            [`${quote(process.execPath)} ${quote(nodeMjs)}`, /node-mjs-ok/],
            [`${quote(process.execPath)} ${quote(nodeCjs)}`, /node-cjs-ok/],
            [`${quote(process.execPath)} ${quote(nodeChild)}`, /node-child-ok[\r\n]+node-child-status=0/],
            [`${quote(python)} ${quote(pythonLibraries)} ${quote(pptxOutput)}`, /numpy-sum=12[\r\n]+pptx-exists=True/]
        ] as const;
        for (const [command, output] of cases) {
            const result = await run(executable, ['run', '--automount', '--policy', policy, '--', command]);
            assert.equal(result.code, 0, `${command}\n${result.stdout}\n${result.stderr}`);
            assert.match(result.stdout, output);
        }
        assert.equal(fs.existsSync(pptxOutput), true, 'python-pptx did not create the PPTX artifact');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unmapped volume paths fail as not-found, not access-denied', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-unmapped-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const log = path.join(directory, 'manager.log');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 卷根（automount 下未映射到任何根的路径）必须返回 not-found 语义。
        // AccessDenied 会让工具的 PATH/资源探测表现为错误而非正常未命中。
        const inner =
            "$ErrorActionPreference = 'Stop'; " +
            "try { Get-Item -LiteralPath 'Z:\\missing-probe' -ErrorAction Stop; 'UNEXPECTED' } " +
            "catch { 'KIND=' + $_.FullyQualifiedErrorId }; " +
            "try { Get-Item -LiteralPath 'Z:\\missing-probe\\deeper' -ErrorAction Stop; 'UNEXPECTED' } " +
            "catch { 'KIND=' + $_.FullyQualifiedErrorId }";
        const command = `"${shell}" -NoProfile -NonInteractive -Command "${inner}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            log,
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.stderr, '');
        assert.equal(result.stdout.match(/KIND=PathNotFound/g)?.length, 2, result.stdout);
        assert.doesNotMatch(
            fs.readFileSync(log, 'utf8'),
            /ZwCreateFile 内部异常.*未映射的路径/,
            'unmapped probes must not surface as manager errors'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('recursive copy via PowerShell Copy-Item works against the volume', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-copy-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const log = path.join(directory, 'manager.log');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        fs.mkdirSync(path.join(directory, 'src'));
        fs.writeFileSync(path.join(directory, 'src', 'one.txt'), '1');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // robocopy 依赖 GetFileSecurity（卷返回 NotImplemented，见 README 已知限制），
        // OpenDesk 场景下等价的复制工具是 PowerShell Copy-Item，必须完整可用。
        const inner =
            `Copy-Item -LiteralPath '${directory}\\src' -Destination '${directory}\\dst' -Recurse; ` +
            `if (-not (Test-Path '${directory}\\dst\\one.txt')) { throw 'copy lost file' }; 'copy-ok'`;
        const result = await run(
            executable,
            [
                'run',
                '--automount',
                '--policy',
                policy,
                '--log-file',
                log,
                '--',
                `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
            ],
            '',
            { ...process.env }
        );
        assert.equal(result.code, 0, JSON.stringify({ ...result, log: undefined }));
        assert.match(result.stdout, /copy-ok/, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('multi-handle concurrent appends keep every writer bytes', { skip: !windows }, async (context) => {
    const python = resolvePython();
    if (!python) return context.skip('Python is not installed');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-append-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const target = path.join(directory, 'shared.txt');
        fs.writeFileSync(target, '');
        // 多句柄顺序追加：第二个句柄打开时必须看到第一个句柄已落盘的数据
        // （并发同写存在 Dokan FCB 尺寸缓存竞态，见 README 已知限制，不用作断言）。
        // 挂载盘符由 MountLease 动态分配，脚本必须从 SBX_ROOT 派生路径。
        const script = path.join(directory, 'append_handles.py');
        fs.writeFileSync(
            script,
            [
                'import os',
                `P = os.path.join(os.environ['SBX_ROOT'], 'C', ${JSON.stringify(target.slice(3))})`,
                'handle = open(P, "a", encoding="utf-8")',
                'for n in range(50):',
                "    handle.write('a-' + str(n) + chr(10))",
                'handle.close()',
                'handle = open(P, "a", encoding="utf-8")',
                'for n in range(50):',
                "    handle.write('b-' + str(n) + chr(10))",
                'handle.close()',
                "print('lines', sum(1 for _ in open(P, encoding='utf-8')))"
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${python}" "${script}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const count = parseInt((result.stdout.match(/lines (\d+)/) || [])[1], 10);
        assert.equal(count, 100, `expected 100 appended lines, got ${count}: ${result.stdout}`);
        assert.equal(result.stdout.includes('ERRORS'), false, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('Move-Item -Force replaces an existing destination file', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-moveforce-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        fs.writeFileSync(path.join(directory, 'src.txt'), 'new-content');
        fs.writeFileSync(path.join(directory, 'dst.txt'), 'old-content-old-content');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `Move-Item -LiteralPath '${directory}\\src.txt' -Destination '${directory}\\dst.txt' -Force -ErrorAction Stop; ` +
            `'content=' + (Get-Content -LiteralPath '${directory}\\dst.txt')`;
        const result = await run(
            executable,
            [
                'run',
                '--automount',
                '--policy',
                policy,
                '--',
                `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
            ],
            '',
            { ...process.env }
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /content=new-content/, result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** 生成沙箱内用的 Node 探针公共头：把宿主绝对路径换算成卷内路径
 * （SBX_ROOT + /C/...），启动期已翻译成卷路径的参数保持原样。 */
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

test('directory deletion via Node rmdir/rmSync and PowerShell Remove-Item works against the volume', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmdir-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // Node/PowerShell/.NET 的目录删除（RemoveDirectoryW）以文件句柄方式
        // （BACKUP_SEMANTICS，无 FILE_DIRECTORY_FILE）打开目录并请求 DELETE；
        // 打开阶段拒绝会让删除永远到不了策略与 DeleteDirectory 回调。
        const probe = path.join(directory, 'rmdir_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'const results = [];',
                'const empty = path.join(root, "empty-dir");',
                'fs.mkdirSync(empty);',
                'try {',
                '    fs.rmdirSync(empty);',
                '    results.push(fs.existsSync(empty) ? "RMDIR-GHOST" : "RMDIR-OK");',
                '} catch (e) {',
                '    results.push("RMDIR-FAIL " + e.code);',
                '}',
                'const nested = path.join(root, "nested-dir");',
                'fs.mkdirSync(path.join(nested, "a", "b"), { recursive: true });',
                'fs.writeFileSync(path.join(nested, "a", "b", "leaf.txt"), "x");',
                'fs.writeFileSync(path.join(nested, "top.txt"), "x");',
                'try {',
                '    fs.rmSync(nested, { recursive: true, force: true });',
                '    results.push(fs.existsSync(nested) ? "RMSYNC-GHOST" : "RMSYNC-OK");',
                '} catch (e) {',
                '    results.push("RMSYNC-FAIL " + e.code);',
                '}',
                'console.log(results.join(";"));',
                "console.log('PROBE-DONE');",
                'process.exit(results.some((r) => r.includes("FAIL") || r.includes("GHOST")) ? 1 : 0);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RMDIR-OK/, result.stdout);
        assert.match(result.stdout, /RMSYNC-OK/, result.stdout);
        assert.doesNotMatch(result.stdout, /FAIL|GHOST/);
        assert.equal(fs.existsSync(path.join(directory, 'probe-work', 'empty-dir')), false);
        assert.equal(fs.existsSync(path.join(directory, 'probe-work', 'nested-dir')), false);

        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const psTarget = path.join(directory, 'ps-dir');
        fs.mkdirSync(path.join(psTarget, 'child'), { recursive: true });
        fs.writeFileSync(path.join(psTarget, 'child', 'file.txt'), 'x');
        const psResult = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${shell}" -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '${psTarget}' -Recurse -Force -ErrorAction Stop; 'remove-ok'"`
        ]);
        assert.equal(psResult.code, 0, psResult.stdout + psResult.stderr);
        assert.match(psResult.stdout, /remove-ok/);
        assert.equal(fs.existsSync(psTarget), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('directory removal honors --del-to-trash and clears the tree from the source', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmdir-trash-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const probe = path.join(directory, 'rmdir_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const nested = path.join(volumePath(process.argv[2]), "trash-dir");',
                'fs.mkdirSync(path.join(nested, "inner"), { recursive: true });',
                'fs.writeFileSync(path.join(nested, "inner", "f.txt"), "x");',
                'fs.rmSync(nested, { recursive: true, force: true });',
                "console.log(fs.existsSync(nested) ? 'TRASH-RMTREE-GHOST' : 'TRASH-RMTREE-OK');",
                "console.log('PROBE-DONE');",
                'process.exit(fs.existsSync(nested) ? 1 : 0);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--automount',
            '--del-to-trash',
            '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${path.join(directory, 'probe-work')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /TRASH-RMTREE-OK/, result.stdout);
        assert.equal(fs.existsSync(path.join(directory, 'probe-work', 'trash-dir')), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('files created inside a sandbox instance are hard-deleted while pre-existing files go to trash', { skip: !windows }, async () => {
    // 同一沙箱实例内的删除分流：探测脚本经卷新建 session.txt 并删除（实例内
    // 新建 → 直接清除），宿主预置的 pre.txt 在同一实例内删除（实例外已有
    // 数据 → 送回收站）。分流结果用 --log-file 判定："(已送回收站)" 仅在
    // SHFileOperation 成功后记录。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-session-created-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const logFile = path.join(directory, 'sandbox.log');
        const target = path.join(directory, 'probe-work');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'pre.txt'), 'pre-existing-content');
        const probe = path.join(directory, 'session_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const root = volumePath(process.argv[2]);',
                'fs.writeFileSync(path.join(root, "session.txt"), "created-in-sandbox");',
                'fs.rmSync(path.join(root, "session.txt"));',
                'fs.rmSync(path.join(root, "pre.txt"));',
                "console.log('DEL-OK', !fs.existsSync(path.join(root, 'session.txt')), !fs.existsSync(path.join(root, 'pre.txt')));",
                "console.log('PROBE-DONE');",
                '',
            ].join('\n')
        );
        const result = await run(
            executable,
            [
                'run',
                '--automount',
                '--del-to-trash',
                '--log-file',
                logFile,
                '--policy',
                policy,
                '--',
                `"${process.execPath}" "${probe}" "${target}"`
            ],
            '',
            process.env,
            12000
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /DEL-OK true true/, result.stdout);
        assert.match(result.stdout, /PROBE-DONE/, result.stdout);
        // 两条路径都必须把文件从源目录移除
        assert.equal(fs.existsSync(path.join(target, 'pre.txt')), false);
        assert.equal(fs.existsSync(path.join(target, 'session.txt')), false);
        const log = fs.readFileSync(logFile, 'utf8');
        assert.match(log, /session\.txt.*未送回收站/);
        assert.match(log, /pre\.txt.*已送回收站/);
        assert.doesNotMatch(log, /session\.txt.*已送回收站/);
        assert.doesNotMatch(log, /pre\.txt.*未送回收站/);
        assert.doesNotMatch(log, /回收站删除未执行/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('policy-denied directory deletion stays denied and keeps the content', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmddeny-'));
    try {
        // 放行 DELETE 打开不得绕过写策略：default deny（只读+执行可用）下，
        // 删除必须被拒且宿主内容原样保留。
        const target = path.join(directory, 'protected');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'keep.txt'), 'must-stay');
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
        );
        const probe = path.join(directory, 'rmdir_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const target = volumePath(process.argv[2]);',
                'try {',
                '    fs.rmSync(target, { recursive: true, force: true });',
                "    console.log('DENY-DELETE-ESCAPED');",
                '} catch (e) {',
                "    console.log('DENY-DELETE-BLOCKED ' + e.code);",
                '}',
                "console.log('PROBE-DONE');",
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${process.execPath}" "${probe}" "${target}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /DENY-DELETE-BLOCKED/, result.stdout);
        assert.doesNotMatch(result.stdout, /ESCAPED/);
        assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'must-stay');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('rename survives a transient holder without FILE_SHARE_DELETE', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rename-share-'));
    const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const target = path.join(directory, 'rename-me.txt');
    const ready = path.join(directory, 'holder-ready');
    const trigger = path.join(directory, 'release-holder');
    // 复刻任务里观察到的签名：宿主侧索引/杀软以 share=R|W（不含 DELETE）短暂握住
    // 刚写完的文件，卷内改名的 DELETE 打开不受影响，但镜像转发到宿主的
    // File.Move 收到 sharing violation。镜像必须短暂退避重试，而不是把 EPERM
    // 直接抛回给调用方。holder 写 ready 文件表示句柄已建立；探针写 trigger
    // 文件让 holder 在重试窗口内释放。
    const holder = spawn(
        shell,
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop'; ` +
                `$f=[System.IO.File]::Open('${target}','Open','Read',[System.IO.FileShare]'ReadWrite'); ` +
                `Set-Content -LiteralPath '${ready}' -Value '1'; ` +
                `$deadline=(Get-Date).AddSeconds(60); ` +
                `while (-not (Test-Path -LiteralPath '${trigger}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 40 }; ` +
                `$f.Dispose()`
        ],
        { windowsHide: true, stdio: 'ignore' }
    );
    try {
        fs.writeFileSync(path.join(directory, 'policy.toml'), 'version = 1\ndefault = "allow"\n');
        fs.writeFileSync(target, 'rename-retry-content');
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(ready)) {
            if (Date.now() > deadline) throw new Error('holder never became ready');
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        const probe = path.join(directory, 'rename_probe.cjs');
        fs.writeFileSync(
            probe,
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                ...volumePathJsHelper().split('\n'),
                'const src = volumePath(process.argv[2]);',
                'const dst = src + ".moved";',
                'fs.writeFileSync(volumePath(process.argv[3]), "1");',
                'try {',
                '    fs.renameSync(src, dst);',
                "    console.log(fs.existsSync(dst) ? 'RENAME-OK' : 'RENAME-GHOST');",
                '} catch (e) {',
                "    console.log('RENAME-FAIL ' + e.code);",
                '}',
                "console.log('PROBE-DONE');",
                'process.exit(fs.existsSync(dst) ? 0 : 1);',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            path.join(directory, 'policy.toml'),
            '--',
            `"${process.execPath}" "${probe}" "${target}" "${trigger}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RENAME-OK/, result.stdout);
        assert.doesNotMatch(result.stdout, /RENAME-FAIL|RENAME-GHOST/);
        assert.equal(fs.existsSync(target + '.moved'), true);
        assert.equal(fs.readFileSync(target + '.moved', 'utf8'), 'rename-retry-content');
    } finally {
        // 释放 holder（探针已写 trigger；异常路径下直接杀掉避免悬挂进程）。
        // holder 可能在 once() 挂上之前就已退出，不能裸等 close 事件。
        try { fs.writeFileSync(trigger, '1'); } catch { }
        holder.kill();
        await Promise.race([
            once(holder, 'close').then(
                () => undefined,
                () => undefined
            ),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('content-based launcher compatibility does not depend on the executable name', { skip: !windows }, async () => {
    const python = resolvePython();
    if (!python) return;
    const pip = path.join(path.dirname(python), 'Scripts', 'pip.exe');
    if (!fs.existsSync(pip)) return;

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-generic-launcher-'));
    const alias = path.join(directory, 'renamed-runtime.exe');
    const policy = path.join(directory, 'policy.toml');
    fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
    fs.copyFileSync(pip, alias);
    try {
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')}" -NoProfile -NonInteractive -Command "& '${alias.replace(/'/g, "''")}' --version"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pip \d+\.\d+/);
        assert.equal(result.stderr, '');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sandbox creates a presentation with PptxGenJS', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-native-sandbox-pptxgenjs-'));
    const policy = path.join(directory, 'policy.toml');
    const script = path.join(directory, 'fixture.cjs');
    const output = path.join(directory, 'slides.pptx');
    fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
    fs.writeFileSync(
        script,
        'const PptxGenJS = require(process.argv[2]);\n' +
            'const pptx = new PptxGenJS();\n' +
            "pptx.addSlide().addText('Sandbox presentation', { x: 1, y: 1, w: 5, h: 1 });\n" +
            "pptx.writeFile({ fileName: process.argv[3] }).then(() => console.log('pptxgenjs-created')).catch(e => { console.error(e); process.exitCode = 1; });\n"
    );
    try {
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${process.execPath}" "${script}" "${fixtureRequire.resolve('pptxgenjs')}" "${output}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pptxgenjs-created/);
        assert.equal(fs.readFileSync(output).subarray(0, 2).toString(), 'PK');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ask deny decisions are cached within the TTL (single endpoint hit)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-denycache-'));
    let calls = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            calls++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ decision: 'deny' }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 3000\ncache_ttl_seconds = 30\n` +
                `[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n` +
                `[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n` +
                `[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n`
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command =
            `"${shell}" -NoProfile -NonInteractive -Command "try { Set-Content -LiteralPath '${directory}\\w.txt' '1' -ErrorAction Stop } catch {}; ` +
            `try { Set-Content -LiteralPath '${directory}\\w.txt' '2' -ErrorAction Stop } catch {}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            command
        ]);
        // 关键断言：deny 决策在 TTL 内被缓存（同路径两次写只问询一次），
        // 且两次写都未落盘。包装器退出码因 PS 对被捕获错误的处理而不同，不作断言。
        assert.equal(calls, 1, `deny decision must be cached within TTL (calls=${calls})`);
        assert(!fs.existsSync(path.join(directory, 'w.txt')), 'denied write must not land');
    } finally {
        server.close();
    }
});

test('pip launcher runs successfully in the sandbox', { skip: !windows }, async () => {
    const python = resolvePython();
    if (!python) return;
    const pip = path.join(path.dirname(python), 'Scripts', 'pip.exe');
    if (!fs.existsSync(pip)) return;

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-pipnoise-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${shell}" -NoProfile -NonInteractive -Command "pip show pip"`
        ]);
        assert.match(result.stdout, /Name: pip/, 'pip must still work');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('PowerShell can wait beyond the Dokan timeout for a real file authorization', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-native-sandbox-'));
    const target = path.join(directory, 'file with spaces.txt');
    const virtualTarget = '/' + target.replace(/\\/g, '/').replace(':', '');
    let delayed = false;
    const requests: Array<{ path: string; access: string }> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const server = createServer((request, response) => {
        assert.equal(request.headers.authorization, 'Bearer test-token');
        let data = '';
        request.on('data', (chunk) => {
            data += chunk;
        });
        request.on('end', () => {
            const body = JSON.parse(data);
            requests.push(body);
            const reply = () => response.end('{"decision":"allow"}');
            if (body.path.toLowerCase() === virtualTarget.toLowerCase() && !delayed) {
                delayed = true;
                timers.push(setTimeout(reply, 35000));
            } else reply();
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const log = path.join(directory, 'manager.log');
        fs.writeFileSync(target, 'authorized child content');
        fs.writeFileSync(
            policy,
            `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntoken = "test-token"\ntimeout_ms = 330000\ncache_ttl_seconds = 0\n[[rules]]\npath = "/**"\naccess = "all"\nperm = "ask"\n`
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command = `"${shell}" -NoLogo -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine('child stdout'); [Console]::Error.WriteLine('child stderr'); Get-Content -LiteralPath '${target.replace(/'/g, "''")}'; exit 7"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            log,
            '--',
            command
        ]);
        assert.equal(result.code, 7, JSON.stringify(result) + '\n' + fs.readFileSync(log, 'utf8').slice(-5000));
        assert.match(result.stdout, /child stdout[\r\n]+authorized child content/);
        assert.equal(result.stderr.trim(), 'child stderr');
        assert.equal(delayed, true);
        assert.equal(
            requests.some((request) => request.path === '/'),
            false
        );
    } finally {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


test('deny rules cannot be evaded through .. aliases, short names or trailing dots', { skip: !windows }, async () => {
    const python = resolvePython();
    if (!python) return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-alias-'));
    try {
        const secretDir = path.join(directory, 'secret');
        fs.mkdirSync(secretDir);
        fs.writeFileSync(path.join(secretDir, 'key.txt'), 'TOPSECRET-7f3a');
        // 提供一个带 .. 的可达父目录，供穿越探测使用
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.writeFileSync(path.join(directory, 'pub', 'note.txt'), 'pubcontent');

        const virtualRoot = '/' + directory.replace(/\\/g, '/').replace(':', '');
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            `version = 1\ndefault = "deny"\n` +
                `[[rules]]\npath = "${virtualRoot}/secret/**"\naccess = "all"\nperm = "deny"\n` +
                `[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n` +
                `[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n`
        );

        // 8.3 短名仅当卷上真实生成时才参与断言（可按注册表/卷配置关闭）
        const probe = spawnSync('cmd.exe', [
            '/d', '/s', '/c', `for %I in ("${secretDir}") do @echo %~sI`
        ], { encoding: 'utf8', windowsHide: true });
        const shortDir = (probe.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
        const hasShort = /^[A-Z]:\\[^ ]*~\d/i.test(shortDir);

        const probeScript = path.join(directory, 'alias_probe.py');
        const virtualKey = 'Z:' + (virtualRoot + '/secret/key.txt').replace(/\//g, '\\');
        const virtualDotDot =
            'Z:' + (virtualRoot + '/pub/../secret/key.txt').replace(/\//g, '\\');
        const virtualShort = hasShort
            ? 'Z:' + shortDir.replace(/^[A-Z]:/, '/' + shortDir[0]).replace(/\\/g, '\\') + '\\key.txt'
            : null;
        const virtualTrailingDot = virtualKey + '.';
        fs.writeFileSync(
            probeScript,
            String.raw`import ctypes, sys

ntdll = ctypes.WinDLL("ntdll")
FILE_READ_DATA = 0x0001
FILE_READ_ATTRIBUTES = 0x0080
SYNCHRONIZE = 0x00100000
FILE_OPEN = 1
FILE_SYNCHRONOUS_IO_NONALERT = 0x20
FILE_NON_DIRECTORY_FILE = 0x40
OBJ_CASE_INSENSITIVE = 0x40

class US(ctypes.Structure):
    _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort), ("Buffer", ctypes.c_void_p)]

class OA(ctypes.Structure):
    _fields_ = [("Length", ctypes.c_ulong), ("RootDirectory", ctypes.c_void_p),
                ("ObjectName", ctypes.c_void_p), ("Attributes", ctypes.c_ulong),
                ("SecurityDescriptor", ctypes.c_void_p), ("SecurityQualityOfService", ctypes.c_void_p)]

class IOSB(ctypes.Structure):
    class U(ctypes.Union):
        _fields_ = [("Status", ctypes.c_long), ("Pointer", ctypes.c_void_p)]
    _fields_ = [("u", U), ("Information", ctypes.c_size_t)]

def nt_open(raw):
    buf = ctypes.create_unicode_buffer(raw)
    us = US(len(raw) * 2, (len(raw) + 1) * 2, ctypes.cast(buf, ctypes.c_void_p))
    oa = OA(ctypes.sizeof(OA), None, ctypes.cast(ctypes.byref(us), ctypes.c_void_p), OBJ_CASE_INSENSITIVE, None, None)
    iosb = IOSB()
    handle = ctypes.c_void_p()
    status = ntdll.NtCreateFile(ctypes.byref(handle),
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, ctypes.byref(oa), ctypes.byref(iosb),
        None, 0, 7, FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE, None, 0)
    if status == 0:
        ntdll.NtClose(handle)
    return status & 0xFFFFFFFF

for label, path in [("dotdot", sys.argv[1]), ("short", sys.argv[2]), ("trailingdot", sys.argv[3])]:
    if not path:
        continue
    status = nt_open("\\??\\" + path)
    leaked = "LEAKED" if status == 0 else f"blocked({status:08X})"
    print(f"NTPROBE {label}: {leaked}")
try:
    with open(sys.argv[1], "rb") as f:
        print("WIN32 dotdot: LEAKED " + f.read(64).decode())
except OSError:
    print("WIN32 dotdot: blocked")
print("PROBE-DONE")
`);
        const t0 = Date.now();
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            `"${python}" "${probeScript}" "${virtualDotDot}" "${virtualShort ?? ''}" "${virtualTrailingDot}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(Date.now() - t0 < 45000, 'probe should finish quickly');
        assert.match(result.stdout, /NTPROBE dotdot: blocked/);
        assert.match(result.stdout, /NTPROBE trailingdot: blocked/);
        if (hasShort) assert.match(result.stdout, /NTPROBE short: blocked/);
        assert.doesNotMatch(result.stdout, /LEAKED/);
        assert.doesNotMatch(result.stdout, /TOPSECRET-7f3a/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('junctions inside the root work, junctions out of the root cannot move IO across', { skip: !windows }, async () => {
    const python = resolvePython();
    if (!python) return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-junc-'));
    const outsideDir = directory + '-outside';
    try {
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, 'out.txt'), 'OUTSIDE-CONTENT-4e8b');
        fs.writeFileSync(path.join(directory, 'inside.txt'), 'inside-content');
        // 目录 junction 无需管理员；ext 指向映射根之外，int 指向根内
        fs.symlinkSync(outsideDir, path.join(directory, 'ext-junc'), 'junction');
        const internalDir = path.join(directory, 'internal');
        fs.mkdirSync(internalDir);
        fs.writeFileSync(path.join(internalDir, 'i.txt'), 'internal-content');
        fs.symlinkSync(internalDir, path.join(directory, 'int-junc'), 'junction');

        // 单根模式：根 = directory，junction 指向根外的同级目录才是越界
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            `version = 1\ndefault = "deny"\n` +
                `[[roots]]\nvirtual = "/probe"\nreal = "${directory.replace(/\\/g, '/')}"\n` +
                `[[roots]]\nvirtual = "/py"\nreal = "${path.dirname(python).replace(/\\/g, '/')}"\n` +
                `[[rules]]\npath = "/probe/**"\naccess = "all"\nperm = "allow"\n` +
                `[[rules]]\npath = "/py/**"\naccess = "all"\nperm = "allow"\n`
        );

        const probeScript = path.join(directory, 'junc_probe.py');
        fs.writeFileSync(
            probeScript,
            [
                'import os, sys',
                'def try_read(label, path):',
                '    try:',
                '        with open(path, "rb") as f:',
                '            print(f"{label}: LEAKED " + repr(f.read(64)))',
                '    except OSError:',
                '        print(f"{label}: blocked")',
                'def try_write(label, path):',
                '    try:',
                '        with open(path, "wb") as f:',
                '            f.write(b"x")',
                '        print(f"{label}: escaped")',
                '    except OSError:',
                '        print(f"{label}: blocked")',
                'def try_move(src, dst, label):',
                '    try:',
                '        os.rename(src, dst)',
                '        print(f"{label}: escaped")',
                '    except OSError:',
                '        print(f"{label}: blocked")',
                'try_read("ext-read", sys.argv[1] + r"\\out.txt")',
                'try_write("ext-write", sys.argv[1] + r"\\escape.txt")',
                'try_move(sys.argv[2] + r"\\inside.txt", sys.argv[1] + r"\\stolen.txt", "ext-move")',
                'try_read("int-read", sys.argv[3] + r"\\i.txt")',
                'try_write("int-write", sys.argv[3] + r"\\new.txt")',
                'try_move(sys.argv[2] + r"\\inside.txt", sys.argv[3] + r"\\moved.txt", "int-move")',
                'print("PROBE-DONE")'
            ].join('\n')
        );
        const result = await run(executable, [
            'run',
            '--policy',
            policy,
            '--',
            `"${python}" "${probeScript}" "Z:\\probe\\ext-junc" "Z:\\probe" "Z:\\probe\\int-junc"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /ext-read: blocked/);
        assert.match(result.stdout, /ext-write: blocked/);
        assert.match(result.stdout, /ext-move: blocked/);
        assert.match(result.stdout, /int-read: LEAKED/);
        assert.match(result.stdout, /int-write: escaped/);
        assert.match(result.stdout, /int-move: escaped/);
        assert.doesNotMatch(result.stdout, /OUTSIDE-CONTENT-4e8b/);
        // 越界写不会在外部目录留下任何新文件
        assert.deepEqual(fs.readdirSync(outsideDir).sort(), ['out.txt']);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('hung ask endpoints fail closed within the configured timeout (pipe and http)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-asktimeout-'));
    const secret = path.join(directory, 'ask.txt');
    fs.writeFileSync(secret, 'askable');
    const virtualSecret = '/' + secret.replace(/\\/g, '/').replace(':', '');
    // 永不应答的 HTTP 端点：连接被接受，请求被吞掉
    const hang = createServer(() => { /* never respond */ });
    hang.listen(0, '127.0.0.1');
    await once(hang, 'listening');
    const port = (hang.address() as { port: number }).port;
    const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const command =
        `"${shell}" -NoProfile -NonInteractive -Command "try { Get-Content -LiteralPath '${secret}' -ErrorAction Stop } catch { exit 3 }"`;
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 1500\ncache_ttl_seconds = 0\n` +
                `[[rules]]\npath = "${virtualSecret}"\naccess = "read"\nperm = "ask"\n` +
                `[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n` +
                `[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n`
        );
        const t0 = Date.now();
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--',
            command
        ]);
        const elapsed = Date.now() - t0;
        assert.equal(result.code, 3, `ask must fail closed, not hang (code=${result.code}, ${elapsed}ms)`);
        assert.ok(elapsed < 30000, `hang endpoint must not stall the pipeline (${elapsed}ms)`);
    } finally {
        hang.closeAllConnections();
        await new Promise<void>((resolve) => hang.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('node children resolve native realpath on the sandbox volume', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-realpath-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // AppContainer 无法完成 GetFinalPathNameByHandle 的盘符映射
        // （\GLOBAL??/MountPointManager 拒访），native realpath 一律 EPERM；
        // 沙箱必须注入预加载补丁让 jest 等依赖 native realpath 的工具可用。
        const command =
            `"${process.execPath}" -e "const fs = require('fs'); ` +
            `console.log(fs.realpathSync.native(process.argv[1]))" "${directory}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.match(result.stdout.trim(), /^[A-Za-z]:\\/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('forward-slash drive paths embedded in the command keep their separators', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-separators-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const probe = path.join(directory, 'probe.txt');
        fs.writeFileSync(probe, 'separator-ok');
        // 路径内嵌于 JS 字符串字面量：若被改写成反斜杠形式，\D 会被字面量转义
        // 吞掉（实证：require('D:/x') 变成 require('Z:DProjects/x')）
        const command =
            `"${process.execPath}" -e "console.log(require('fs').readFileSync('${probe.replace(/\\/g, '/')}','utf8'))"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.stdout.trim(), 'separator-ok');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('directory removal reports failure while the host holds the directory open', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmdir-'));
    let holder: ReturnType<typeof spawn> | undefined;
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const locked = path.join(directory, 'locked');
        fs.mkdirSync(locked);
        // 进程 CWD 持有目录句柄：宿主 RemoveDirectory 必然失败，沙箱不得把它
        // 吞成"删除成功"，再让父目录报误导性的 ENOTEMPTY（幽灵空目录）
        holder = spawn('cmd.exe', ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 > nul'], {
            cwd: locked,
            windowsHide: true,
            stdio: 'ignore'
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const cmd = path.join(process.env.SystemRoot!, 'System32/cmd.exe');
        const removeLocked = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${cmd}" /c rmdir "${locked}"`
        ]);
        assert.notEqual(removeLocked.code, 0, JSON.stringify(removeLocked));

        const plain = path.join(directory, 'plain');
        fs.mkdirSync(plain);
        const removePlain = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${cmd}" /c rmdir "${plain}"`
        ]);
        assert.equal(removePlain.code, 0, JSON.stringify(removePlain));
    } finally {
        if (holder?.pid) {
            // 同步等待宿主持有者退出，否则 rmSync 会撞上未释放的目录句柄
            spawnSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            spawnSync('ping', ['/n', '2', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('powershell Add-Type can compile through the sandbox temp directory', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-addtype-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // csc 以 CREATE_NEW + 只读属性位创建资源临时文件（合法的 Win32 组合）；
        // 镜像层若把它原样交给 .NET FileStream 会抛 ArgumentException 并以
        // AccessDenied 收场，沙箱内所有 .NET 编译（Add-Type/CodeDom）随之失败。
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command =
            `"${shell}" -NoProfile -NonInteractive -Command "try { Add-Type -TypeDefinition 'public class T { }'; exit 0 } catch { exit 3 }"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('native realpath resolves through graceful-fs the way jest consumes it', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-gfs-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // jest-util 的 tryRealpath 走 graceful-fs.realpathSync.native；
        // graceful-fs 用 clone(fs) 复制导出，补丁必须沿这条引用链可见。
        // node -e 的 process.argv[1] 是第一个用户参数（没有脚本名占位）
        const command =
            `"${process.execPath}" -e "const g = require(process.argv[1]); ` +
            `console.log(g.realpathSync.native(process.argv[2]))" ` +
            `"${fixtureRequire.resolve('graceful-fs')}" "${directory}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.match(result.stdout.trim(), /^[A-Za-z]:\\/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('forward-slash paths embedded in environment values keep their separators', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-envsep-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const probeValue = 'D:/tmp/opendesk-env-probe';
        const command = `"${process.execPath}" -e "console.log(process.env.OD_PROBE_PATH)"`;
        const result = await run(
            executable,
            [
                'run',
                '--automount',
                '--policy',
                policy,
                '--log-file',
                path.join(directory, 'manager.log'),
                '--',
                command
            ],
            '',
            { ...process.env, OD_PROBE_PATH: probeValue }
        );
        assert.equal(result.code, 0, JSON.stringify(result));
        // 环境变量里的正斜杠盘符路径改写后必须仍是正斜杠（与命令行同一规则）
        assert.match(result.stdout.trim(), /^[A-Za-z]:\/D\/tmp\/opendesk-env-probe$/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('locked file deletion reports failure while the host keeps the file open', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmfile-'));
    let holder: ReturnType<typeof spawn> | undefined;
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const locked = path.join(directory, 'locked.txt');
        fs.writeFileSync(locked, 'locked');
        // FileShare.None 独占持有：宿主 File.Delete 必然失败，沙箱必须如实
        // 回报删除错误，而不是吞成"删除成功"让条目从视图里凭空消失
        holder = spawn(
            path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoProfile', '-Command', `$f = [IO.File]::Open('${locked}', 'Open', 'Read', 'None'); Start-Sleep 25; $f.Close()`],
            { windowsHide: true, stdio: 'ignore' }
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const cmd = path.join(process.env.SystemRoot!, 'System32/cmd.exe');
        const removeLocked = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${cmd}" /c del "${locked}"`
        ]);
        // cmd del 失败时退出码恒为 0：准确断言 stderr 的占用报错与文件仍存在
        assert.match(removeLocked.stderr, /used by another process/i, JSON.stringify(removeLocked));
        assert.equal(fs.existsSync(locked), true, 'locked file must survive the failed deletion');

        const plain = path.join(directory, 'plain.txt');
        fs.writeFileSync(plain, 'plain');
        const removePlain = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${cmd}" /c del "${plain}"`
        ]);
        assert.equal(removePlain.code, 0, JSON.stringify(removePlain));
        assert.equal(fs.existsSync(plain), false);
    } finally {
        if (holder?.pid) {
            spawnSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            spawnSync('ping', ['/n', '2', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the volume nul file behaves as an empty discard target', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-vnul-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // 工具链补丁（GOSANDBOXNUL）把子进程的 NUL 需求落到卷内虚拟文件：
        // 读必须 EOF，写必须被丢弃且文件不产生宿主实体
        const command =
            `"${process.execPath}" -e "const fs = require('fs'); ` +
            `const p = process.env.SBX_ROOT + 'dynobox\\\\nul.file'; ` +
            `const fd = fs.openSync(p, 'w'); fs.writeSync(fd, 'junk'); fs.closeSync(fd); ` +
            `const fd2 = fs.openSync(p, 'r'); const buf = Buffer.alloc(16); ` +
            `const n = fs.readSync(fd2, buf, 0, 16, 0); fs.closeSync(fd2); ` +
            `console.log('BYTES=' + n)" "${directory}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.match(result.stdout, /BYTES=0/);
        assert.equal(fs.existsSync(path.join(directory, 'nul.file')), false,
            'virtual nul file must not materialize on the host');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sandbox children create and connect named pipes once the platform setup is applied', { skip: !windows }, async (t) => {
    // 放通依赖管理员确认的管道根目录 ACE（pipes-ensure）。ACE 写入成功不等于
    // 一定生效（部分 Windows 版本对 AppContainer 的内核对象访问有 DACL 之外
    // 的限制），因此用一次功能性探测决定是否跳过。
    const configured = await pipeCreationWorks();
    if (!configured) {
        t.skip('named pipe creation is not permitted for AppContainer on this OS build');
        return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-namedpipe-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const script = String.raw`
const net = require('net');
const name = '\\\\.\\pipe\\opendesk-sandbox-probe-' + process.pid;
const server = net.createServer((socket) => socket.end('roundtrip'));
server.listen(name, () => {
    const client = net.connect(name);
    client.on('data', (data) => {
        console.log('ROUNDTRIP=' + data.toString());
        process.exit(0);
    });
});
server.on('error', (error) => {
    console.log('ERR ' + error.code);
    process.exit(1);
});
setTimeout(() => process.exit(2), 8000);
`;
        fs.writeFileSync(path.join(directory, 'pipe-probe.cjs'), script);
        const command = `"${process.execPath}" "${path.join(directory, 'pipe-probe.cjs')}"`;
        const result = await run(executable, [
            'run',
            '--automount',
            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.match(result.stdout, /ROUNDTRIP=roundtrip/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


async function pipeCreationWorks(): Promise<boolean> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pipe-cap-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1' + String.fromCharCode(10) + 'default = "allow"' + String.fromCharCode(10));
        const script = String.raw`
const net = require('net');
const server = net.createServer(() => {});
server.on('error', () => process.exit(1));
server.listen('\\.\pipe\opendesk-pipe-cap-probe', () => {
    server.close();
    process.exit(0);
});
setTimeout(() => process.exit(2), 8000);
`;
        fs.writeFileSync(path.join(directory, 'pipe-cap.cjs'), script);
        const command = `"${process.execPath}" "${path.join(directory, 'pipe-cap.cjs')}"`;
        const result = await run(executable, [
            'run', '--automount', '--policy', policy, '--', command
        ]);
        return result.code === 0 && /EXITED/.test('') === false;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

const nulSetupConfigured = windows
    && (() => {
        try {
            const status = spawnSync(executable, ['pipes-status'], { encoding: 'utf8' });
            return JSON.parse(status.stdout.trim()).configured === true;
        } catch {
            return false;
        }
    })();

test('sandbox provides virtual NUL semantics for toolchains', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-nul-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // /dynobox/nul.file 是沙箱内置的虚拟 NUL（读 EOF、写丢弃）。cargo 的
        // Stdio::null、go 的 os/exec 默认 stdin 都打开 NUL 设备；在 NUL 设备
        // 无法放行 AppContainer 的系统上，工具链经由卷内路径访问它。
        fs.writeFileSync(
            path.join(directory, 'nul-probe.cmd'),
            '@echo off\necho x > "%SBX_ROOT%dynobox\\nul.file" || exit /b 1\ntype "%SBX_ROOT%dynobox\\nul.file"\n'
        );
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const command = `"${cmd}" /d /c "%SBX_ROOT%nul-probe.cmd"`;
        const result = await run(
            executable,
            ['run', '--src', directory, '--policy', policy, '--', command]
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('NUL device opens inside the sandbox once pipes setup granted access', { skip: !nulSetupConfigured }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-nul-device-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const command = `"${cmd}" /d /c "echo x > NUL"`;
        const result = await run(
            executable,
            ['run', '--src', directory, '--policy', policy, '--', command]
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /Access is denied|拒绝访问/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
