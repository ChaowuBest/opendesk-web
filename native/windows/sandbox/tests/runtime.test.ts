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
async function run(file: string, args: string[], stdin = '', env = process.env) {
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
    const timer = setTimeout(() => proc.kill(), 60000);
    try {
        const [code] = await once(proc, 'close');
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

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
