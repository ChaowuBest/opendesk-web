import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asyncShellExec } from '../../../main/utils/shellExec.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { setPlatform, type AbstractPlatform } from '../../../platforms/base.js';

setPlatform({
    getInjectedEnviron: () => new Map()
} as AbstractPlatform);

interface ChildResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

function runModuleScript(source: string): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`child process timed out: ${stderr}`));
        }, 5000);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

test(
    'detached process cleanup does not interrupt an existing asynchronous SIGTERM handler',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { trackDetachedProcess } from './src/main/utils/shellExec.ts';

            process.on('SIGTERM', () => {
                setTimeout(() => {
                    process.stdout.write('graceful-handler-completed\\n');
                    process.exit(0);
                }, 100);
            });
            const command = spawn('/bin/sh', ['-c', 'sleep 30'], {
                detached: true,
                stdio: 'ignore'
            });
            trackDetachedProcess(command);
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);
        `);

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.match(result.stdout, /graceful-handler-completed/);
    }
);

test(
    'detached process cleanup preserves default SIGTERM exit semantics when no owner exists',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { trackDetachedProcess } from './src/main/utils/shellExec.ts';

            const command = spawn('/bin/sh', ['-c', 'sleep 30'], {
                detached: true,
                stdio: 'ignore'
            });
            trackDetachedProcess(command);
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);
        `);

        assert.equal(result.code, null, result.stderr);
        assert.equal(result.signal, 'SIGTERM');
    }
);

test(
    'SIGHUP removes the detached process group and preserves default signal semantics',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { trackDetachedProcess } from './src/main/utils/shellExec.ts';

            const command = spawn('/bin/sh', ['-c', 'sleep 30'], {
                detached: true,
                stdio: 'ignore'
            });
            trackDetachedProcess(command);
            process.stdout.write(String(command.pid) + '\\n');
            setTimeout(() => process.kill(process.pid, 'SIGHUP'), 20);
        `);
        const pid = Number.parseInt(result.stdout.trim(), 10);

        assert.equal(result.code, null, result.stderr);
        assert.equal(result.signal, 'SIGHUP');
        assert.ok(Number.isInteger(pid) && pid > 0, `invalid pid: ${result.stdout}`);
        try {
            assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
        } finally {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // The expected path has already removed the process group.
            }
        }
    }
);

test(
    'detached process signal handlers are removed after the last tracked process closes',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { trackDetachedProcess } from './src/main/utils/shellExec.ts';

            const initial = {
                exit: process.listenerCount('exit'),
                sigterm: process.listenerCount('SIGTERM'),
                sigint: process.listenerCount('SIGINT'),
                sighup: process.listenerCount('SIGHUP'),
                sigquit: process.listenerCount('SIGQUIT')
            };
            const command = spawn('/bin/sh', ['-c', 'true'], {
                detached: true,
                stdio: 'ignore'
            });
            trackDetachedProcess(command);
            command.on('close', () => {
                process.stdout.write(JSON.stringify({
                    exit: process.listenerCount('exit') - initial.exit,
                    sigterm: process.listenerCount('SIGTERM') - initial.sigterm,
                    sigint: process.listenerCount('SIGINT') - initial.sigint,
                    sighup: process.listenerCount('SIGHUP') - initial.sighup,
                    sigquit: process.listenerCount('SIGQUIT') - initial.sigquit
                }) + '\\n');
            });
        `);

        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { exit: 0, sigterm: 0, sigint: 0, sighup: 0, sigquit: 0 });
    }
);

test(
    'process exit forcibly removes a detached process group that ignores SIGTERM',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { trackDetachedProcess } from './src/main/utils/shellExec.ts';

            const command = spawn('/bin/sh', ['-c', "trap '' TERM; sleep 30"], {
                detached: true,
                stdio: 'ignore'
            });
            trackDetachedProcess(command);
            process.stdout.write(String(command.pid) + '\\n');
            setTimeout(() => process.exit(0), 100);
        `);
        const pid = Number.parseInt(result.stdout.trim(), 10);

        assert.equal(result.code, 0, result.stderr);
        assert.ok(Number.isInteger(pid) && pid > 0, `invalid pid: ${result.stdout}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
            assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
        } finally {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // The expected path has already removed the process group.
            }
        }
    }
);

test(
    'killProcessTree escalates when a detached process group ignores SIGTERM',
    { skip: process.platform === 'win32' },
    async () => {
        const result = await runModuleScript(`
            import { spawn } from 'node:child_process';
            import { killProcessTree } from './src/main/applications/terminal/background.ts';

            const command = spawn('/bin/sh', ['-c', "trap '' TERM; sleep 30"], {
                detached: true,
                stdio: 'ignore'
            });
            process.stdout.write(String(command.pid) + '\\n');
            setTimeout(() => killProcessTree(command), 100);
            setTimeout(() => process.exit(0), 1500);
        `);
        const pid = Number.parseInt(result.stdout.trim(), 10);

        assert.equal(result.code, 0, result.stderr);
        assert.ok(Number.isInteger(pid) && pid > 0, `invalid pid: ${result.stdout}`);
        try {
            assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
        } finally {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // The expected path has already removed the process group.
            }
        }
    }
);

test(
    'asyncShellExec enforces its timeout when the command ignores SIGTERM',
    { skip: process.platform === 'win32' },
    async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-shell-exec-test-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        const startTime = Date.now();

        try {
            await assert.rejects(
                asyncShellExec("trap '' TERM; sleep 3", { timeout: 50 }),
                /Command timed out after 50ms/
            );
            assert.ok(Date.now() - startTime < 2000, 'timeout waited for the command to finish naturally');
        } finally {
            Setting.clearCache();
            setCustomOpendeskDirectory(undefined);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }
);
