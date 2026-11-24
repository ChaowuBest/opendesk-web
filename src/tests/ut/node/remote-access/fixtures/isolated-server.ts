import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const serverEnvironment = {
    root: process.env.REMOTE_NETWORK_CONTRACT_SERVER_ROOT,
    mobile: process.env.REMOTE_NETWORK_CONTRACT_MOBILE_ROOT,
    python: process.env.REMOTE_NETWORK_CONTRACT_PYTHON
};
export async function until(check: () => boolean | Promise<boolean>, milliseconds = 10000): Promise<void> {
    const end = performance.now() + milliseconds;
    while (!(await check())) {
        if (performance.now() > end) throw Error('isolated condition timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
export async function isolatedServer(tls?: { cert: string; key: string }, backendRoot = serverEnvironment.root) {
    const root = await mkdtemp(join(tmpdir(), 'opendesk-dual-host-'));
    const child = spawn(serverEnvironment.python!, [join(backendRoot!, 'test/remote_network_contract_server.py')], {
        cwd: backendRoot,
        env: { ...process.env, PYTHONPATH: backendRoot, DATABASE_URL: `sqlite:///${root}/isolated.db`,
            OPENDESK_CONFIG: `${root}/empty.yaml`, OPENDESK_SECRET_KEY: randomUUID(),
            ...(tls ? { CONTRACT_TLS_CERT: tls.cert, CONTRACT_TLS_KEY: tls.key } : {}) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.resume();
    const close = async () => {
        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        await rm(root, { recursive: true, force: true });
    };
    try {
        const boot = await new Promise<{ port: number; token: string; userId: string; secondAccount: { token: string; userId: string } }>((resolve, reject) => {
            let text = '';
            const timer = setTimeout(() => reject(Error('isolated bootstrap timeout')), 8000);
            child.once('error', () => { clearTimeout(timer); reject(Error('isolated start failed')); });
            child.once('exit', () => { clearTimeout(timer); reject(Error('isolated service exited')); });
            child.stdout.on('data', (data) => {
                text += data.toString();
                if (text.length > 16384) { clearTimeout(timer); reject(Error('isolated bootstrap overflow')); return; }
                if (!text.includes('\n')) return;
                clearTimeout(timer);
                try { resolve(JSON.parse(text.split('\n')[0])); } catch { reject(Error('invalid bootstrap')); }
                text = '';
            });
        });
        const baseUrl = `${tls ? 'https' : 'http'}://127.0.0.1:${boot.port}/api/v1`;
        await until(async () => { try { return (await fetch(`${baseUrl}/devices`)).status === 401; } catch { return false; } });
        return { ...boot, baseUrl, root, close };
    } catch (error) { await close(); throw error; }
}
