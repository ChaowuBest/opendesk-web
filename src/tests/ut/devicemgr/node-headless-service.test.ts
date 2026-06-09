import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pythonExecutable(): string {
    const result = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`failed to resolve python3: ${result.stderr}`);
    }
    return fs.realpathSync(result.stdout.trim());
}

function readCommandLog(logFile: string): string[][] {
    if (!fs.existsSync(logFile)) return [];
    return fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
}

function parseExecStart(unitText: string): string[] {
    const execLine = unitText
        .split('\n')
        .find((line) => line.startsWith('ExecStart='))
        ?.slice('ExecStart='.length);
    if (!execLine) throw new Error(`missing ExecStart in unit:\n${unitText}`);
    const result = spawnSync(
        'python3',
        ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.stdin.read())))'],
        {
            input: execLine,
            encoding: 'utf8'
        }
    );
    if (result.status !== 0) {
        throw new Error(`failed to parse ExecStart: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as string[];
}

function systemdEscapedPath(filePath: string): string {
    const allowed = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-:@'.split(''));
    return Array.from(filePath)
        .map((char) => {
            if (char === '%') return '%%';
            if (allowed.has(char)) return char;
            return Buffer.from(char, 'utf8')
                .toString('hex')
                .match(/.{2}/g)!
                .map((byte) => `\\x${byte}`)
                .join('');
        })
        .join('');
}

function runServiceHarness(script: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
    return spawnSync('python3', ['-c', script], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8'
    });
}

function serviceHarness(system: 'Linux' | 'Darwin', args: string[]): string {
    const scriptPath = JSON.stringify(path.join(process.cwd(), 'docs/examples/node/node_headless.py'));
    const argv = JSON.stringify(args);
    const uid = process.getuid?.() ?? 0;
    return [
        'import importlib.util',
        'import json',
        'import os',
        'import subprocess',
        'import sys',
        `spec = importlib.util.spec_from_file_location("node_headless", ${scriptPath})`,
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        `module.platform.system = lambda: ${JSON.stringify(system)}`,
        `module.os.getuid = lambda: ${uid}`,
        'module.shutil.which = lambda name: name',
        'def fake_run_checked(command, check=True):',
        '    with open(os.environ["OPENDESK_FAKE_SERVICE_LOG"], "a", encoding="utf-8") as f:',
        '        f.write(json.dumps(command[1:]) + "\\n")',
        '    return subprocess.CompletedProcess(command, 0, "", "")',
        'module.run_checked = fake_run_checked',
        `args = module.parse_args(${argv})`,
        'try:',
        '    if args.command == "install":',
        '        module.install_service(args)',
        '    elif args.command == "uninstall":',
        '        module.uninstall_service(args)',
        '    else:',
        '        raise SystemExit(f"unexpected command: {args.command}")',
        'except Exception as exc:',
        '    print(f"error: {exc}", file=sys.stderr)',
        '    raise SystemExit(1)',
        ''
    ].join('\n');
}

function readPlist(plistPath: string): Record<string, unknown> {
    const result = spawnSync(
        'python3',
        ['-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', plistPath],
        { encoding: 'utf8' }
    );
    if (result.status !== 0) {
        throw new Error(`failed to read plist: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('node_headless.py service installation', () => {
    let tempDir: string;
    let homeDir: string;
    let logFile: string;
    let workspaceDir: string;
    let env: NodeJS.ProcessEnv;
    let pythonPath: string;

    beforeEach(() => {
        tempDir = makeTempDir('opendesk-node-service-');
        homeDir = path.join(tempDir, 'home');
        logFile = path.join(tempDir, 'service.log');
        workspaceDir = path.join(tempDir, 'workspace with spaces');
        fs.mkdirSync(homeDir, { recursive: true });
        fs.mkdirSync(workspaceDir, { recursive: true });
        pythonPath = pythonExecutable();
        env = {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            OPENDESK_FAKE_SERVICE_LOG: logFile
        };
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('installs and uninstalls a Linux user systemd service with the requested node arguments', () => {
        const install = runServiceHarness(
            serviceHarness('Linux', [
                'install',
                '--user-service',
                '--service-name',
                'opendesk-headless-test.service',
                '--host',
                '10.1.2.3',
                '--port',
                '19055',
                '--node-id',
                'node-service',
                '--name',
                'Headless Service Test',
                '--cwd',
                workspaceDir,
                '--retry-interval',
                '1.5',
                '--max-retry-interval',
                '8',
                '--python',
                pythonPath
            ]),
            env
        );
        expect(install.status).toBe(0);

        const unitPath = path.join(homeDir, '.config/systemd/user/opendesk-headless-test.service');
        const unitText = fs.readFileSync(unitPath, 'utf8');
        expect(unitText).toContain('Description=OpenDesk Headless Node (Headless Service Test)');
        expect(unitText).toContain('Restart=always');
        expect(unitText).toContain('RestartSec=5');
        expect(unitText).toContain(`WorkingDirectory=${systemdEscapedPath(workspaceDir)}`);
        expect(unitText).toContain('Environment=PYTHONUNBUFFERED=1');
        expect(unitText).toContain('WantedBy=default.target');
        expect(parseExecStart(unitText)).toEqual([
            pythonPath,
            path.join(process.cwd(), 'docs/examples/node/node_headless.py'),
            'start',
            '--host',
            '10.1.2.3',
            '--port',
            '19055',
            '--node-id',
            'node-service',
            '--name',
            'Headless Service Test',
            '--cwd',
            workspaceDir,
            '--retry-interval',
            '1.5',
            '--max-retry-interval',
            '8'
        ]);
        expect(readCommandLog(logFile)).toEqual([
            ['--user', 'daemon-reload'],
            ['--user', 'enable', 'opendesk-headless-test.service'],
            ['--user', 'restart', 'opendesk-headless-test.service']
        ]);

        const uninstall = runServiceHarness(
            serviceHarness('Linux', [
                'uninstall',
                '--user-service',
                '--service-name',
                'opendesk-headless-test.service'
            ]),
            env
        );
        expect(uninstall.status).toBe(0);
        expect(fs.existsSync(unitPath)).toBe(false);
        expect(readCommandLog(logFile).slice(3)).toEqual([
            ['--user', 'disable', '--now', 'opendesk-headless-test.service'],
            ['--user', 'daemon-reload'],
            ['--user', 'reset-failed', 'opendesk-headless-test.service']
        ]);
    });

    test('installs and uninstalls a macOS user launchd service with the requested node arguments', () => {
        const label = 'org.opendesk.headless.test';
        const install = runServiceHarness(
            serviceHarness('Darwin', [
                'install',
                '--user-service',
                '--service-name',
                label,
                '--url',
                'ws://10.1.2.3:19055/openclaw',
                '--node-id',
                'node-service',
                '--name',
                'Headless Service Test',
                '--cwd',
                workspaceDir,
                '--retry-interval',
                '2',
                '--max-retry-interval',
                '9',
                '--python',
                pythonPath
            ]),
            env
        );
        expect(install.status).toBe(0);

        const plistPath = path.join(homeDir, 'Library/LaunchAgents/org.opendesk.headless.test.plist');
        const plist = readPlist(plistPath);
        expect(plist.Label).toBe(label);
        expect(plist.RunAtLoad).toBe(true);
        expect(plist.KeepAlive).toBe(true);
        expect(plist.WorkingDirectory).toBe(workspaceDir);
        expect(plist.EnvironmentVariables).toEqual({ PYTHONUNBUFFERED: '1' });
        expect(plist.ProgramArguments).toEqual([
            pythonPath,
            path.join(process.cwd(), 'docs/examples/node/node_headless.py'),
            'start',
            '--url',
            'ws://10.1.2.3:19055/openclaw',
            '--node-id',
            'node-service',
            '--name',
            'Headless Service Test',
            '--cwd',
            workspaceDir,
            '--retry-interval',
            '2',
            '--max-retry-interval',
            '9'
        ]);

        const domain = `gui/${process.getuid?.() ?? 0}`;
        expect(readCommandLog(logFile)).toEqual([
            ['bootout', domain, plistPath],
            ['bootstrap', domain, plistPath],
            ['enable', `${domain}/${label}`],
            ['kickstart', '-k', `${domain}/${label}`]
        ]);

        const uninstall = runServiceHarness(
            serviceHarness('Darwin', ['uninstall', '--user-service', '--service-name', label]),
            env
        );
        expect(uninstall.status).toBe(0);
        expect(fs.existsSync(plistPath)).toBe(false);
        expect(readCommandLog(logFile).slice(4)).toEqual([
            ['bootout', domain, plistPath],
            ['disable', `${domain}/${label}`]
        ]);
    });

    test('rejects service names that cannot be stable system service identifiers', () => {
        const install = runServiceHarness(
            serviceHarness('Linux', ['install', '--user-service', '--service-name', 'bad/service']),
            env
        );
        expect(install.status).toBe(1);
        expect(install.stderr).toContain('service name must start with an alphanumeric character');
    });
});
