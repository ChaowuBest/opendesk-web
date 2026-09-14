import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    const pythonCandidates = [
        process.env.OPENDESK_SANDBOX_PYTHON,
        'C:\\Python314\\python.exe',
        'C:\\Users\\liyif\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'
    ].filter((value): value is string => Boolean(value));
    const python = pythonCandidates.find((value) => fs.existsSync(value));
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
