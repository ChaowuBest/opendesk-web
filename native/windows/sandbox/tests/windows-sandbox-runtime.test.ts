import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const enabled = process.platform === 'win32' && process.env.OPENDESK_SANDBOX_INTEGRATION === '1';
// 相对测试文件自身定位运行时产物，从仓库任意工作目录运行都成立
const executable = path.resolve(import.meta.dirname, '..', 'runtime', 'sandbox.exe');

async function runSandbox(directory: string, command: string, rules = '', extraArgs: string[] = []) {
    const policy = path.join(directory, 'policy.toml');
    const log = path.join(directory, 'sandbox.log');
    fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n' + rules);
    const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    const child = [shell, '-NoProfile', '-NonInteractive', '-Command', command].map(quote).join(' ');
    const proc = spawn(
        executable,
        ['run', '--automount', ...extraArgs, '--policy', policy, '--log-file', log, '--', child],
        {
            windowsHide: true
        }
    );
    const completion = once(proc, 'close');
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 30000);
    try {
        const [code] = await completion;
        assert.equal(code, 0, stdout + stderr + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
        return { stdout, stderr, log: fs.readFileSync(log, 'utf8') };
    } finally {
        clearTimeout(timer);
    }
}

test('the shipped sandbox starts PowerShell repeatedly and forwards its output', { skip: !enabled }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-startup-'));
    try {
        let previousSid: string | undefined;
        for (let i = 0; i < 3; i++) {
            const result = await runSandbox(directory, `Write-Output 'sandbox-alive-${i}'; Get-Date -Format yyyy`);
            assert.match(result.stdout, new RegExp(`sandbox-alive-${i}[\\r\\n]+\\d{4}`));
            assert.equal(result.stderr, '');
            const sid = /SID=(S-[0-9-]+)/.exec(result.log)?.[1];
            assert.ok(sid);
            if (previousSid) assert.equal(sid, previousSid, 'loopback initialization must survive a fresh run');
            previousSid = sid;
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('--del-to-trash sends removed files to the recycle bin and plain runs delete them', { skip: !enabled }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-trash-'));
    const stem = `del-to-trash-${process.pid}-${Date.now()}`;
    const victim = path.join(directory, `${stem}.txt`);
    fs.writeFileSync(victim, 'recoverable');
    const virtualVictim = '/' + victim.replace(/\\/g, '/').replace(':', '');
    const listRecycleBin = async (name: string) => {
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const { stdout } = await promisify(execFile)(
            shell,
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                // 回收站条目的显示名不含扩展名
                `$items = (New-Object -ComObject Shell.Application).Namespace(0xA).Items(); ` +
                    `$found = @($items | Where-Object { $_.Name -eq '${name}' }); ` +
                    `if ($found.Count -gt 0) { 'in-recycle-bin' } else { 'missing-from-recycle-bin' }`
            ],
            { windowsHide: true }
        );
        return stdout.trim();
    };
    try {
        const recycled = await runSandbox(
            directory,
            `$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath '${virtualVictim}'; Write-Output 'removed'`,
            '',
            ['--del-to-trash']
        );
        assert.match(recycled.stdout, /removed/);
        assert.equal(fs.existsSync(victim), false);
        assert.match(recycled.log, /已送回收站/);
        assert.equal(await listRecycleBin(stem), 'in-recycle-bin');

        // 对照组：不带 --del-to-trash 的删除保持永久删除语义
        const control = path.join(directory, `${stem}-plain.txt`);
        fs.writeFileSync(control, 'permanent');
        const virtualControl = '/' + control.replace(/\\/g, '/').replace(':', '');
        const permanent = await runSandbox(
            directory,
            `$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath '${virtualControl}'; Write-Output 'removed'`
        );
        assert.match(permanent.stdout, /removed/);
        assert.equal(fs.existsSync(control), false);
        assert.equal(await listRecycleBin(`${stem}-plain`), 'missing-from-recycle-bin');

        // 回归（BUG-2）：原始请求名携带 /dynobox/../ 段时，删除必须仍走回收站，
        // 不得因内部区域前缀误判而永久删除用户文件。\\?\ 前缀阻止 Win32
        // 归一化 ..，原始段才能原样到达 MirrorFs。
        const tricky = path.join(directory, `${stem}-tricky.txt`);
        fs.writeFileSync(tricky, 'recoverable-too');
        const virtualTricky = '/' + tricky.replace(/\\/g, '/').replace(':', '');
        const trickyRest = `${tricky[0]}${virtualTricky.slice(virtualTricky.indexOf('/', 1))}`;
        const trickCommand =
            `$ErrorActionPreference = 'Stop'; ` +
            `$trick = '\\\\?\\' + $env:SBX_ROOT.TrimEnd('\\\\') + '\\dynobox\\..\\${trickyRest.replace(/\//g, '\\')}'; ` +
            `Remove-Item -LiteralPath $trick; Write-Output 'removed'`;
        const trickyRun = await runSandbox(directory, trickCommand, '', ['--del-to-trash']);
        assert.match(trickyRun.stdout, /removed/);
        assert.equal(fs.existsSync(tricky), false);
        assert.equal(await listRecycleBin(`${stem}-tricky`), 'in-recycle-bin');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        // 送入回收站的副本保留不动：由用户自行清空，测试绝不永久删除数据
    }
});

test('network capabilities reach the child without disabling file isolation', { skip: !enabled }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-token-'));
    const secret = path.join(directory, 'private.txt');
    fs.writeFileSync(secret, 'must stay private');
    const virtualSecret = '/' + secret.replace(/\\/g, '/').replace(':', '');
    try {
        const probe = path.join(directory, 'probe.exe');
        const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
        await promisify(execFile)(
            compiler,
            [
                '/nologo',
                '/target:exe',
                `/out:${probe}`,
                path.resolve(import.meta.dirname, 'fixtures/SandboxTokenProbe.cs')
            ],
            { windowsHide: true }
        );
        const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
        const command = `& ${quote(probe)} ${quote(secret)}; exit $LASTEXITCODE`;
        const rules = `[[rules]]\npath = ${JSON.stringify(virtualSecret)}\naccess = "all"\nperm = "deny"\n`;
        const result = await runSandbox(directory, command, rules);
        assert.match(result.stdout, /capabilities-and-isolation-ok/);
        assert.equal(result.stderr, '');
        assert.equal(fs.readFileSync(secret, 'utf8'), 'must stay private');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('PowerShell runs Python and pip launchers without sandbox path errors', { skip: !enabled }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-python-launchers-'));
    const command = [
        "$ErrorActionPreference = 'Stop'",
        'python --version',
        "Write-Output 'python-m-pip-start'; python -m pip --version",
        "Write-Output 'pip-start'; pip --version",
        'python -c "import pptx; print(\'python-pptx\', pptx.__version__)"',
        "Write-Output 'python-pip-ok'"
    ].join('; ');
    try {
        const result = await runSandbox(directory, command);
        assert.match(result.stdout, /Python 3\.\d+/);
        assert.match(result.stdout, /python-m-pip-start[\r\n]+pip \d+/);
        assert.match(result.stdout, /pip-start[\r\n]+pip \d+/);
        assert.match(result.stdout, /python-pptx \d+\.\d+/);
        assert.match(result.stdout, /python-pip-ok/);
        assert.doesNotMatch(result.stdout, /Traceback/);
        assert.equal(result.stderr, '');

        const failure = await runSandbox(
            directory,
            [
                'python -c "import sys; print(\'real-python-error\', file=sys.stderr); sys.exit(7)"',
                "if ($LASTEXITCODE -ne 7) { throw 'Python exit code was not preserved' }",
                "Write-Output 'python-error-preserved'"
            ].join('; ')
        );
        assert.match(failure.stdout, /python-error-preserved/);
        assert.match(failure.stderr, /real-python-error/);
        assert.doesNotMatch(failure.stderr, /Failed to find real location/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// Direct native launches exercise overlapping background/cross-task processes.
// OpenDesk serializes sandboxed shell tools even though the native boundary also
// protects against overlap from separate tasks or background processes.
test(
    'overlapping native sandboxes use different identities and fresh runs clear private profile data',
    { skip: !enabled },
    async () => {
        const directories = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-identities-')));
        const command =
            "$p = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'opendesk-profile-marker.txt'; " +
            "if (Test-Path -LiteralPath $p) { throw 'stale profile data' }; " +
            "[IO.File]::WriteAllText($p, 'private'); Start-Sleep -Seconds 2; Write-Output 'fresh-profile'";
        try {
            const results = await Promise.all(directories.map((directory) => runSandbox(directory, command)));
            for (const result of results) assert.match(result.stdout, /fresh-profile/);
            const sids = results.map((result) => /SID=(S-[0-9-]+)/.exec(result.log)?.[1]);
            assert.ok(sids[0]);
            assert.ok(sids[1]);
            assert.notEqual(sids[0], sids[1], 'concurrent tasks must not share an AppContainer SID');
            const fresh = await runSandbox(directories[0], command);
            assert.match(fresh.stdout, /fresh-profile/);
        } finally {
            for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);

test(
    'initialized sandboxes reuse a host loopback HTTP proxy across fresh runs',
    {
        skip: !enabled || process.env.OPENDESK_SANDBOX_LOOPBACK_TEST !== '1'
    },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-loopback-'));
        const requests: string[] = [];
        const proxy = createServer((request, response) => {
            requests.push(request.url!);
            response.end('sandbox-proxy-ok');
        });
        proxy.listen(0, '127.0.0.1');
        await once(proxy, 'listening');
        const address = proxy.address();
        assert.ok(address && typeof address !== 'string');
        const command =
            "$ErrorActionPreference = 'Stop'; " +
            `$r = [Net.HttpWebRequest]::Create('http://sandbox.invalid/proxy-test'); ` +
            `$r.Proxy = [Net.WebProxy]::new('http://127.0.0.1:${address.port}'); $r.Timeout = 3000; ` +
            '$response = $r.GetResponse(); $reader = [IO.StreamReader]::new($response.GetResponseStream()); ' +
            'try { $reader.ReadToEnd() } finally { $reader.Dispose(); $response.Dispose() }';
        try {
            for (let i = 0; i < 2; i++) {
                const result = await runSandbox(directory, command);
                assert.match(result.stdout, /sandbox-proxy-ok/);
            }
            assert.deepEqual(requests, Array(2).fill('http://sandbox.invalid/proxy-test'));
        } finally {
            proxy.closeAllConnections();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);
