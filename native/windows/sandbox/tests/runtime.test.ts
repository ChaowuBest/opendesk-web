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
    // --automount 已恢复：run 子进程默认把所有盘符挂进卷根（/C -> C:\ …）。
    // 显式 roots 优先于 automount（declared 跳过），--src 单目录与 automount 冲突，
    // 这两类场景不注入。
    if (file === executable && args[0] === 'run' && !args.includes('--src') && !args.includes('--automount'))
        args = ['run', '--automount', ...args.slice(1)];
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

/** 写一个全放行的策略（无 [[roots]]）：盘符由 --automount 枚举挂载进卷根
 * （/C -> C:\、/D -> D:\ …），子进程可访问 PATH 中的系统工具（node/pip 等）。 */
function writeDriveAllowPolicy(policyPath: string): void {
    fs.writeFileSync(policyPath, 'version = 1\ndefault = "allow"\n');
}

/** 写一个最简单的全放行策略（无 [[roots]]）：配合 --src 单目录挂载到卷根 /。 */
function writeSimplePolicy(policyPath: string): void {
    fs.writeFileSync(policyPath, 'version = 1\ndefault = "allow"\n');
}

/** 在自定义策略内容前保留 version 头（盘符由 --automount 枚举挂载，
 * 让子进程能访问 PATH 中的系统工具与探针所在的主机路径）。 */
function withDriveRoots(content: string): string {
    return content;
}

test('manager exits after a child leaves an inherited output handle open', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-pipe-lifecycle-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
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
            ['run', '--automount', '--policy', policy, '--', command],
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

test(
    'parallel sandbox managers stay independent and keep the full language mode',
    { skip: !windows },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-parallel-'));
        try {
            const policy = path.join(directory, 'policy.toml');
            writeDriveAllowPolicy(policy);
            const shellRoot = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0');
            const results = await Promise.all(
                [0, 1, 2].map((index) => {
                    const target = path.join(directory, `${index}.txt`);
                    const command =
                        `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '${directory}'; ` +
                        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
                        `Set-Content -LiteralPath '${target}' -Value '${index}'; Start-Sleep -Milliseconds 700; ` +
                        `Get-Content -LiteralPath '${target}'; Get-Date -Format yyyy; ` +
                        `'mode=' + $ExecutionContext.SessionState.LanguageMode`;
                    return run(
                        executable,
                        [
                            'run',

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
            for (const [index, result] of results.entries()) {
                assert.equal(result.code, 0, JSON.stringify(result));
                assert.equal(result.stderr, '');
                assert.match(result.stdout, /mode=FullLanguage/);
                assert.equal(fs.readFileSync(path.join(directory, `${index}.txt`), 'utf8').trim(), String(index));
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);

test(
    'Windows PowerShell loads built-in modules with an inherited Windows PSModulePath',
    { skip: !windows },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-modules-'));
        try {
            const policy = path.join(directory, 'policy.toml');
            const log = path.join(directory, 'manager.log');
            writeDriveAllowPolicy(policy);
            const shellRoot = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0');
            const result = await run(
                executable,
                [
                    'run',

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
            writeDriveAllowPolicy(policy);
            const shellRoot = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0');
            const results = await Promise.all(
                [0, 1, 2].map((index) => {
                    const target = path.join(directory, `${index}.txt`);
                    const command =
                        `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '${directory}'; ` +
                        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
                        `Set-Content -LiteralPath '${target}' -Value '${index}'; Start-Sleep -Milliseconds 700; ` +
                        `Get-Content -LiteralPath '${target}'; Get-Date -Format yyyy; ` +
                        `'mode=' + $ExecutionContext.SessionState.LanguageMode`;
                    return run(
                        executable,
                        [
                            'run',

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
            for (const [index, result] of results.entries()) {
                assert.equal(result.code, 0, JSON.stringify(result));
                assert.equal(result.stderr, '');
                assert.match(result.stdout, /mode=FullLanguage/);
                assert.equal(fs.readFileSync(path.join(directory, `${index}.txt`), 'utf8').trim(), String(index));
            }
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
        writeDriveAllowPolicy(policy);
        const result = await run(executable, [
            'run',

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
            writeDriveAllowPolicy(policy);
            const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
            const result = await run(
                executable,
                [
                    'run',

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
    writeDriveAllowPolicy(policy);
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
            const result = await run(executable, ['run',  '--policy', policy, '--', command]);
            assert.equal(result.code, 0, `${command}\n${result.stdout}\n${result.stderr}`);
            assert.match(result.stdout, output);
        }
        assert.equal(fs.existsSync(pptxOutput), true, 'python-pptx did not create the PPTX artifact');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unmapped host paths fail as not-found, not access-denied', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-unmapped-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const log = path.join(directory, 'manager.log');
        writeSimplePolicy(policy);
        // --src 单根模式：只有 directory 被映射到沙箱根 /。探测工具（cmd.exe
        // 副本）放在映射内，对映射外的宿主路径（如 SystemRoot）做存在性探测，
        // 必须返回 not-found 语义（AccessDenied 会让工具的 PATH/资源探测表现为
        // 错误而非正常未命中）。
        const probe = path.join(directory, 'cmd.exe');
        fs.copyFileSync(path.join(process.env.SystemRoot!, 'System32', 'cmd.exe'), probe);
        const outer = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        // cmd 的 if exist 走 NtQueryAttributesFile（绕过 API hook）；改用 type
        // （CreateFileW 读）——未映射路径必须失败并落入 || 分支。
        const inner =
            `type "${outer}" > NUL && echo MAPPED_1 || echo NOT_FOUND_1 & ` +
            `type "${process.env.SystemRoot}\\System32\\definitely-missing-probe.dat" > NUL && echo MAPPED_2 || echo NOT_FOUND_2`;
        const command = `"${probe}" /d /c "${inner}"`;
        const result = await run(executable, [
            'run',

            '--src',
            directory,
            '--policy',
            policy,
            '--log-file',
            log,
            '--',
            command
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        // cmd type 对未映射路径失败时会在 stderr 报"系统找不到指定的路径"（本地化），
        // 关键断言是 stdout 落入 || 分支（not-found 而非 AccessDenied）
        assert.doesNotMatch(result.stderr, /Access is denied|拒绝访问/);
        assert.match(result.stdout, /NOT_FOUND_1/);
        assert.match(result.stdout, /NOT_FOUND_2/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('recursive copy via PowerShell Copy-Item works against the volume', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-copy-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const log = path.join(directory, 'manager.log');
        writeDriveAllowPolicy(policy);
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
        writeDriveAllowPolicy(policy);
        const target = path.join(directory, 'shared.txt');
        fs.writeFileSync(target, '');
        // 多句柄顺序追加：第二个句柄打开时必须看到第一个句柄已落盘的数据。
        const script = path.join(directory, 'append_handles.py');
        fs.writeFileSync(
            script,
            [
                'import os',
                `P = ${JSON.stringify(target)}`,
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
        writeDriveAllowPolicy(policy);
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

/** 生成沙箱内用的 Node 探针公共头：Detours 实现子进程直接使用宿主真实路径，
 * 探针无需做卷路径换算（volumePath 恒等展开绝对路径）。 */
function volumePathJsHelper(): string {
    return 'function volumePath(p) { return require("node:path").resolve(p); }';
}

test('directory deletion via Node rmdir/rmSync and PowerShell Remove-Item works against the volume', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmdir-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        // Node/PowerShell/.NET 的目录删除（RemoveDirectoryW）以文件句柄方式
        // （BACKUP_SEMANTICS，无 FILE_DIRECTORY_FILE）打开目录并请求 DELETE；
        // 打开阶段拒绝会让删除永远到不了策略与 DeleteDirectory 回调。
        fs.mkdirSync(path.join(directory, 'probe-work'), { recursive: true });
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
        writeDriveAllowPolicy(policy);
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

test('--del-to-trash moves deletions to the Windows recycle bin and never silently keeps files', { skip: !windows }, async () => {
    // 与 Linux/OHOS 沙箱语义对齐：--del-to-trash 下删除一律送回收站（Detours
    // 实现不区分"实例内新建"——无虚拟卷，不跟踪卷内创建状态）。探测
    // 脚本删除会话内新建的 session.txt 与宿主预置的 pre.txt，两者都应从源
    // 目录移除（进回收站），且回收站不可用时保留原文件、绝不静默永久删除。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-session-created-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
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
        // 两条路径都必须把文件从源目录移除（进回收站）
        assert.equal(fs.existsSync(path.join(target, 'pre.txt')), false);
        assert.equal(fs.existsSync(path.join(target, 'session.txt')), false);
        // 回收站失败时必须写诊断（绝不静默永久删除）
        assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /回收站删除失败/);
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
            withDriveRoots(
                'version = 1\ndefault = "deny"\n' +
                    '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                    '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
            )
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
    // 刚写完的文件，rename 收到 sharing violation。Detours 实现直接操作宿主
    // FS：冲突如实报错，探针在 holder 释放后轮询重试（与真实工具行为一致）。
    // holder 写 ready 表示句柄已建立；探针写 trigger 让 holder 释放。
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
        fs.writeFileSync(
            path.join(directory, 'policy.toml'),
            withDriveRoots(
                'version = 1\ndefault = "allow"\n' +
                    '[[rules]]\npath = "/**"\naccess = "all"\nperm = "allow"\n'
            )
        );
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
                // 通知 holder 释放；随后轮询重试（Detours 版直接操作宿主 FS，
                // 瞬时共享冲突如实暴露给调用方，由工具自行重试）
                'fs.writeFileSync(volumePath(process.argv[3]), "1");',
                'let ok = false;',
                'for (let i = 0; i < 100 && !ok; i++) {',
                '    try { fs.renameSync(src, dst); ok = fs.existsSync(dst); } catch (e) {',
                '        const wait = new Uint8Array(1); require("node:fs").writeSync(1, wait, 0, 0);',
                '        const start = Date.now(); while (Date.now() - start < 40) {}',
                '    }',
                '}',
                "console.log(ok ? 'RENAME-OK' : 'RENAME-FAIL');",
                "console.log('PROBE-DONE');",
                'process.exit(ok ? 0 : 1);',
                '',
                '',
            ].join('\n')
        );
        const result = await run(executable, [
            'run',

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
    writeDriveAllowPolicy(policy);
    fs.copyFileSync(pip, alias);
    try {
        const result = await run(executable, [
            'run',

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
    writeDriveAllowPolicy(policy);
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
    const target = path.join(directory, 'w.txt');
    // PS 启动还会写系统目录（catroot/CatRoot2 等），这些 ask 与缓存断言无关；
    // 统计目标路径 w.txt 的被问询次数——TTL 内同路径两次写应只问询一次。
    const callsByPath = new Map<string, number>();
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const asked = JSON.parse(body || '{}');
            const key = String(asked.path || '');
            callsByPath.set(key, (callsByPath.get(key) || 0) + 1);
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
            withDriveRoots(
                `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 3000\ncache_ttl_seconds = 30\n` +
                    `[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n` +
                    `[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n` +
                    `[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n`
            )
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command =
            `"${shell}" -NoProfile -NonInteractive -Command "try { Set-Content -LiteralPath '${directory}\\w.txt' '1' -ErrorAction Stop } catch {}; ` +
            `try { Set-Content -LiteralPath '${directory}\\w.txt' '2' -ErrorAction Stop } catch {}"`;
        const result = await run(executable, [
            'run',

            '--policy',
            policy,
            '--',
            command
        ]);
        // 关键断言：目标路径 w.txt 的 deny 决策在 TTL 内被缓存（同路径两次
        // 写只问询一次），且两次写都未落盘。
        const wCalls = [...callsByPath.entries()].filter(([p]) => p.toLowerCase().endsWith('/w.txt')).reduce((a, [, n]) => a + n, 0);
        assert.equal(wCalls, 1, `deny decision must be cached within TTL (w.txt calls=${wCalls}, all=${JSON.stringify([...callsByPath])})`);
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
        writeDriveAllowPolicy(policy);
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const result = await run(executable, [
            'run',

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

test('PowerShell can wait beyond the configured ask timeout for a real file authorization', { skip: !windows }, async () => {
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
            withDriveRoots(
                `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntoken = "test-token"\ntimeout_ms = 330000\ncache_ttl_seconds = 0\n[[rules]]\npath = "/**"\naccess = "all"\nperm = "ask"\n`
            )
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command = `"${shell}" -NoLogo -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine('child stdout'); [Console]::Error.WriteLine('child stderr'); Get-Content -LiteralPath '${target.replace(/'/g, "''")}'; exit 7"`;
        const result = await run(executable, [
            'run',

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
            withDriveRoots(
                `version = 1\ndefault = "deny"\n` +
                    `[[rules]]\npath = "${virtualRoot}/secret/**"\naccess = "all"\nperm = "deny"\n` +
                    `[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n` +
                    `[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n`
            )
        );

        // 8.3 短名仅当卷上真实生成时才参与断言（可按注册表/卷配置关闭）
        const probe = spawnSync('cmd.exe', [
            '/d', '/s', '/c', `for %I in ("${secretDir}") do @echo %~sI`
        ], { encoding: 'utf8', windowsHide: true });
        const shortDir = (probe.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
        const hasShort = /^[A-Z]:\\[^ ]*~\d/i.test(shortDir);

        const probeScript = path.join(directory, 'alias_probe.py');
        // Detours 实现按 API 层路径判定：别名（.. / 尾点 / 8.3 短名）经
        // 归一化后必须仍命中 deny 规则。direct syscall（NtCreateFile）绕过
        // 是 Detours 方案的已知限制（见 README"安全模型"），不在此断言。
        const realKey = path.join(secretDir, 'key.txt');
        const realDotDot = path.join(directory, 'pub', '..', 'secret', 'key.txt');
        const realShort = hasShort ? path.join(shortDir, 'key.txt') : null;
        const realTrailingDot = realKey + '.';
        fs.writeFileSync(
            probeScript,
            String.raw`import sys

for label, path in [("dotdot", sys.argv[1]), ("short", sys.argv[2]), ("trailingdot", sys.argv[3])]:
    if not path:
        continue
    try:
        with open(path, "rb") as f:
            print("WIN32 " + label + ": LEAKED " + f.read(64).decode())
    except OSError:
        print("WIN32 " + label + ": blocked")
print("PROBE-DONE")
`);
        const t0 = Date.now();
        const result = await run(executable, [
            'run',

            '--policy',
            policy,
            '--',
            `"${python}" "${probeScript}" "${realDotDot}" "${realShort ?? ''}" "${realTrailingDot}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(Date.now() - t0 < 45000, 'probe should finish quickly');
        assert.match(result.stdout, /WIN32 dotdot: blocked/);
        assert.match(result.stdout, /WIN32 trailingdot: blocked/);
        if (hasShort) assert.match(result.stdout, /WIN32 short: blocked/);
        assert.doesNotMatch(result.stdout, /LEAKED/);
        assert.doesNotMatch(result.stdout, /TOPSECRET-7f3a/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
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
        writeDriveAllowPolicy(policy);
        // AppContainer 无法完成 GetFinalPathNameByHandle 的盘符映射
        // （\GLOBAL??/MountPointManager 拒访），native realpath 一律 EPERM；
        // 沙箱必须注入预加载补丁让 jest 等依赖 native realpath 的工具可用。
        const command =
            `"${process.execPath}" -e "const fs = require('fs'); ` +
            `console.log(fs.realpathSync.native(process.argv[1]))" "${directory}"`;
        const result = await run(executable, [
            'run',

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
        writeDriveAllowPolicy(policy);
        const probe = path.join(directory, 'probe.txt');
        fs.writeFileSync(probe, 'separator-ok');
        // 路径内嵌于 JS 字符串字面量：若被改写成反斜杠形式，\D 会被字面量转义
        // 吞掉（实证：require('D:/x') 变成 require('Z:DProjects/x')）
        const command =
            `"${process.execPath}" -e "console.log(require('fs').readFileSync('${probe.replace(/\\/g, '/')}','utf8'))"`;
        const result = await run(executable, [
            'run',

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
        writeDriveAllowPolicy(policy);
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
        writeDriveAllowPolicy(policy);
        // csc 以 CREATE_NEW + 只读属性位创建资源临时文件（合法的 Win32 组合）；
        // 镜像层若把它原样交给 .NET FileStream 会抛 ArgumentException 并以
        // AccessDenied 收场，沙箱内所有 .NET 编译（Add-Type/CodeDom）随之失败。
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const command =
            `"${shell}" -NoProfile -NonInteractive -Command "try { Add-Type -TypeDefinition 'public class T { }'; exit 0 } catch { exit 3 }"`;
        const result = await run(executable, [
            'run',

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
        writeDriveAllowPolicy(policy);
        // jest-util 的 tryRealpath 走 graceful-fs.realpathSync.native；
        // graceful-fs 用 clone(fs) 复制导出，补丁必须沿这条引用链可见。
        // node -e 的 process.argv[1] 是第一个用户参数（没有脚本名占位）
        const command =
            `"${process.execPath}" -e "const g = require(process.argv[1]); ` +
            `console.log(g.realpathSync.native(process.argv[2]))" ` +
            `"${fixtureRequire.resolve('graceful-fs')}" "${directory}"`;
        const result = await run(executable, [
            'run',

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
        writeDriveAllowPolicy(policy);
        const probeValue = 'D:/tmp/opendesk-env-probe';
        const command = `"${process.execPath}" -e "console.log(process.env.OD_PROBE_PATH)"`;
        const result = await run(
            executable,
            [
                'run',

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
        // Detours 实现不改写环境变量：正斜杠路径保持原样
        assert.equal(result.stdout.trim(), probeValue);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('locked file deletion reports failure while the host keeps the file open', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-rmfile-'));
    let holder: ReturnType<typeof spawn> | undefined;
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
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

            '--policy',
            policy,
            '--log-file',
            path.join(directory, 'manager.log'),
            '--',
            `"${cmd}" /c del "${locked}"`
        ]);
        // cmd del 失败时退出码恒为 0：断言 stderr 有占用报错（本地化文本，
        // 只断言非空）且文件仍存在
        assert.notEqual(removeLocked.stderr.trim(), '', 'locked deletion must surface an error');
        assert.equal(fs.existsSync(locked), true, 'locked file must survive the failed deletion');

        const plain = path.join(directory, 'plain.txt');
        fs.writeFileSync(plain, 'plain');
        const removePlain = await run(executable, [
            'run',

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

test('the NUL device behaves as an empty discard target', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-vnul-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        // 用 python 探针访问 NUL 设备（写丢弃/读 EOF）。用 chr(92) 拼出
        // 设备路径，避开反斜杠转义；裸 'NUL' 相对路径会被实体化为普通文件。
        const python = resolvePython();
        if (!python) { fs.rmSync(directory, { recursive: true, force: true }); return; }
        const nullProbe = path.join(directory, 'nul_probe.py');
        fs.writeFileSync(
            nullProbe,
            [
                "DEV = chr(92) * 2 + '.' + chr(92) + 'NUL'",
                "with open(DEV, 'w') as f:",
                "    f.write('junk')",
                "with open(DEV, 'rb') as f:",
                "    print('BYTES=' + str(len(f.read(16))))",
            ].join('\n')
        );
        const command = `"${python}" "${nullProbe}"`;
        const result = await run(executable, [
            'run',

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
            'NUL device must not materialize a host file');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sandbox children create and connect named pipes without any platform setup', { skip: !windows }, async (t) => {
    // Detours 实现以普通用户令牌运行：命名管道创建天然可用（无 AppContainer
    // 的管道根 ACE 限制，无需 pipes-ensure）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-namedpipe-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
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


// Detours 实现子进程直接访问宿主 NUL 设备（无 AppContainer 的管道/NUL
// 限制）：cargo Stdio::、go os/exec 默认 stdin 的 NUL 打开必须可用。
test('sandbox children can open the NUL device for toolchains', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-nul-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeSimplePolicy(policy);
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const command = `"${cmd}" /d /c "echo x > NUL && echo NUL-OK"`;
        const result = await run(
            executable,
            ['run', '--automount', '--policy', policy, '--', command]
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /NUL-OK/);
        assert.doesNotMatch(result.stdout + result.stderr, /Access is denied|拒绝访问/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('NUL device opens inside the sandbox without any platform setup', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-nul-device-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeSimplePolicy(policy);
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const command = `"${cmd}" /d /c "echo x > NUL && echo DEVICE-OK"`;
        const result = await run(
            executable,
            ['run', '--automount', '--policy', policy, '--', command]
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /DEVICE-OK/);
        assert.doesNotMatch(result.stdout + result.stderr, /Access is denied|拒绝访问/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


test('sandbox self-terminates with its process tree when the parent exits (no orphan leak)', { skip: !windows }, async () => {
    // Windows 上父进程退出不会级联子进程：OpenDesk 退出/崩溃时若不清理，sandbox.exe
    // 及其 bash/cmd/node 后代会成为孤儿继续运行。sandbox 会监护其直接父进程（通过
    // WaitForMultipleObjects 同时等待子进程与父句柄），父先退出则终止子进程——
    // Job 的 KILL_ON_JOB_CLOSE 随之杀死整棵沙箱树。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-orphan-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        // 中间 node 进程作为 sandbox 的直接父：spawn 一个长时沙箱 bash 后立即退出，
        // 模拟 OpenDesk 主进程退出（不主动杀 sandbox）。
        const pidFile = path.join(directory, 'sandbox.pid');
        const bridge = path.join(directory, 'bridge.cjs');
        fs.writeFileSync(
            bridge,
            [
                `const { spawn } = require('node:child_process');`,
                `const fs = require('node:fs');`,
                `const exe = ${JSON.stringify(executable)};`,
                `const policy = ${JSON.stringify(policy)};`,
                `const pidFile = ${JSON.stringify(pidFile)};`,
                `const p = spawn(exe, ['run', '--automount', '--policy', policy, '--', 'bash.exe', '-c', 'sleep 120'], { windowsHide: true, stdio: 'ignore' });`,
                `fs.writeFileSync(pidFile, String(p.pid));`,
                `process.exit(0);`
            ].join('\n')
        );
        // bridge 进程（父）即退即走——父进程死亡不杀子，监护必须兜底
        const bridgeProc = spawn(process.execPath, [bridge], { windowsHide: true, stdio: 'ignore' });
        const [bridgeCode] = await once(bridgeProc, 'close');
        assert.equal(bridgeCode, 0);
        // 等 pid 文件就绪
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(pidFile) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(fs.existsSync(pidFile), 'sandbox pid file not produced');
        const sandboxPid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.ok(sandboxPid > 0);

        // bridge 已退出，sandbox 应随后终止整棵树（含 bash/sleep 后代）
        const gone = await (async () => {
            const end = Date.now() + 10000;
            while (Date.now() < end) {
                const out = spawnSync('powershell.exe', [
                    '-NoProfile', '-Command',
                    `(Get-Process -Id ${sandboxPid} -ErrorAction SilentlyContinue) -ne $null`
                ], { encoding: 'utf8', windowsHide: true });
                if ((out.stdout || '').trim() === 'False') return true;
                await new Promise((r) => setTimeout(r, 300));
            }
            return false;
        })();
        assert.ok(gone, `sandbox pid=${sandboxPid} leaked after its parent exited`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('handle-level delete paths (python os.remove / node rmSync) honor --del-to-trash', { skip: !windows }, async () => {
    // 句柄级删除（NtDeleteFile / NtSetInformationFile disposition /
    // SetFileInformationByHandle）同样接入回收站：--del-to-trash 下文件应从
    // 源目录移除（SHFileOperation 送回收站），且不出现"回收站删除失败"日志
    // （该日志出现 = 回收站不可用，此时应保留文件而非静默永久删除）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-handle-del-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeDriveAllowPolicy(policy);
        const logFile = path.join(directory, 'sandbox.log');
        const pyTarget = path.join(directory, 'py-del.txt');
        fs.writeFileSync(pyTarget, 'x');
        const script = path.join(directory, 'del.py');
        fs.writeFileSync(script, 'import os\nos.remove(' + JSON.stringify(pyTarget) + ')\n');
        const py = await run(executable, [
            'run', '--policy', policy, '--del-to-trash', '--log-file', logFile, '--', 'python.exe', script
        ]);
        assert.equal(py.code, 0, py.stdout + py.stderr);
        assert.equal(fs.existsSync(pyTarget), false, 'python os.remove must remove the file (to recycle bin)');
        assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /回收站删除失败/, 'recycle bin must be used, not silent permanent delete');

        const nodeTarget = path.join(directory, 'node-del.txt');
        fs.writeFileSync(nodeTarget, 'x');
        const nodeScript = path.join(directory, 'rm.cjs');
        fs.writeFileSync(nodeScript, "require('fs').rmSync(process.argv[2]);");
        const node = await run(executable, [
            'run', '--policy', policy, '--del-to-trash', '--log-file', logFile, '--',
            process.execPath, nodeScript, nodeTarget
        ]);
        assert.equal(node.code, 0, node.stdout + node.stderr);
        assert.equal(fs.existsSync(nodeTarget), false, 'node rmSync must remove the file (to recycle bin)');
        assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /回收站删除失败/, 'recycle bin must be used, not silent permanent delete');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('session-created files delete without recycle bin while host files still trash (Dokan instance-created semantics)', { skip: !windows }, async () => {
    // 沙箱会话内创建的文件删除 = 自发清理：不 ask、不进回收站（直接删）；
    // 宿主预置文件删除仍走回收站（--del-to-trash）。用回收站物理文件计数区分。
    const whoami = spawnSync('C:/Windows/System32/whoami.exe', ['/user'], { encoding: 'utf8', windowsHide: true });
    const sidMatch = /\bS-\d+(-\d+)+/.exec(whoami.stdout || '');
    if (!sidMatch) return; // 拿不到 SID 时跳过（回收站物理路径不可枚举）
    const recycleDir = `C:/$RECYCLE.BIN/${sidMatch[0]}`;
    const countRecycle = () => {
        try { return fs.readdirSync(recycleDir).length; } catch { return -1; }
    };
    if (countRecycle() < 0) return;

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-session-created-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        // write 全放通（避免创建时 ask），--del-to-trash 下区分回收站 vs 直接删
        fs.writeFileSync(policy, 'version = 1\ndefault = "deny"\n' +
            '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
            '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
            '[[rules]]\npath = "/**"\naccess = "write"\nperm = "allow"\n');

        // 1) 会话内创建 + 同一沙箱删除：直接删（回收站计数不变）
        const inTarget = path.join(directory, 'in-session.txt');
        const inScript = path.join(directory, 'in.cjs');
        fs.writeFileSync(inScript,
            "const fs = require('fs');\n" +
            'const T = ' + JSON.stringify(inTarget) + ';\n' +
            "fs.writeFileSync(T, 'x');\n" +
            'fs.rmSync(T);\n'
        );
        const before = countRecycle();
        const c1 = await run(executable, ['run', '--policy', policy, '--del-to-trash', '--', process.execPath, inScript]);
        assert.equal(c1.code, 0, c1.stdout + c1.stderr);
        assert.equal(fs.existsSync(inTarget), false);
        assert.equal(countRecycle(), before, 'session-created file must not go to the recycle bin');

        // 2) 宿主预置文件 + 沙箱内删除：进回收站（计数 +2：$R + $I）
        const preTarget = path.join(directory, 'host-pre.txt');
        fs.writeFileSync(preTarget, 'x');
        const delScript = path.join(directory, 'del.cjs');
        fs.writeFileSync(delScript, "const fs = require('fs');\nfs.rmSync(process.argv[2]);\n");
        const before2 = countRecycle();
        const c2 = await run(executable, ['run', '--policy', policy, '--del-to-trash', '--', process.execPath, delScript, preTarget]);
        assert.equal(c2.code, 0, c2.stdout + c2.stderr);
        assert.equal(fs.existsSync(preTarget), false);
        assert.ok(countRecycle() > before2, 'host file must go to the recycle bin');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
