import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

test(
    'CLI entry isolates noninteractive routes and handles interactive shutdown',
    { timeout: 120000 },
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-entry-routes-'));
        const source = path.resolve('src/main/cli.ts');
        const preload = path.join(root, 'observe.mjs');
        const recordEvent = `
import fs from 'node:fs';
const record = (event) => fs.appendFileSync(process.env.ENTRY_COUNTS + '.exit', event + '\\n');
`;
        const exitModules = {
            './applications/mobileaccess/tui.js': recordEvent + `
export function startTuiMobileAccess(app) {
    record('started');
    app.beforeExit = async () => {
        record('close');
        await new Promise(resolve => setTimeout(resolve, 20));
        record('closed');
    };
    setImmediate(() => {
        const mode = process.env.ENTRY_EXIT_MODE;
        if (mode.startsWith('SIG')) process.kill(process.pid, mode);
        else if (mode === 'uncaughtException') throw Error('synthetic fatal');
        else Promise.reject(Error('synthetic fatal'));
    });
}
`,
            './telemetry/index.js': recordEvent + `
export async function initTelemetry() {}
export async function shutdownTelemetry() { record('telemetry'); }
`
        };
        fs.writeFileSync(
            preload,
            `
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { isMainThread } from 'node:worker_threads';
const counts={assembly:0,bridge:0};
if(isMainThread) fs.writeFileSync(process.env.ENTRY_COUNTS,JSON.stringify(counts));
if(isMainThread) registerHooks({resolve(specifier,context,next){
 let changed=false;
 if(specifier.endsWith('/tui-network.js')) {counts.assembly++;changed=true;}
 if(specifier.includes('node-network-bridge.')) {counts.bridge++;changed=true;}
 if(changed){fs.writeFileSync(process.env.ENTRY_COUNTS+'.tmp',JSON.stringify(counts));
 fs.renameSync(process.env.ENTRY_COUNTS+'.tmp',process.env.ENTRY_COUNTS);}
 if(process.env.ENTRY_DENY_BRIDGE && specifier.includes('node-network-bridge.')) throw Error('synthetic missing runtime');
 return next(specifier,context);
}});
// Observe the real CLI handlers through the mobile lifecycle and telemetry boundaries.
const exitModules = ${JSON.stringify(exitModules)};
if (isMainThread && process.env.ENTRY_EXIT_MODE) registerHooks({
    resolve(specifier, context, next) {
        const body = context.parentURL?.endsWith('/src/main/cli.ts') && exitModules[specifier];
        return body ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(body) }
                    : next(specifier, context);
    }
});
globalThis.fetch=async()=>{throw Error('isolated external request blocked');};
`
        );
        const routes: Array<{
            args: string[]; code: number; pty?: boolean; denyBridge?: boolean; exitMode?: string;
        }> = [
            { args: ['--help'], code: 0 },
            { args: ['tools', '--help'], code: 0 },
            { args: ['account', '--help'], code: 0 },
            { args: ['serve', '--help'], code: 0 },
            { args: ['--headless'], code: 1 },
            { args: ['--resume', 'synthetic-missing', '-c', 'synthetic'], code: 1, pty: true },
            { args: [], code: 0, pty: true, denyBridge: true },
            ...['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((exitMode) => ({
                args: [], code: exitMode.startsWith('SIG') ? 0 : 1, pty: true, denyBridge: false, exitMode
            }))
        ];
        try {
            for (const [index, route] of routes.entries()) {
                const profile = path.join(root, String(index));
                fs.mkdirSync(profile);
                fs.writeFileSync(
                    path.join(profile, 'setting.json'),
                    JSON.stringify({
                        providers: [{ name: 'synthetic', base_url: 'http://127.0.0.1:1', api_key: 'synthetic' }],
                        models: [{ alias: 'B', provider_name: 'synthetic', model_name: 'B' }],
                        default_model: 'B'
                    })
                );
                const counts = path.join(profile, 'counts.json');
                const args = ['--import', preload, '--import', 'tsx', source, '--workspace', profile, ...route.args];
                const exitMode = route.exitMode ?? '';
                const env = {
                    ...process.env,
                    OPENDESK_CONFIG_DIRECTORY: profile,
                    OPENDDESK_CONFIG_DIRECTORY: '',
                    ENTRY_COUNTS: counts,
                    ENTRY_EXIT_MODE: exitMode,
                    ENTRY_DENY_BRIDGE: route.denyBridge ? '1' : ''
                };
                if (route.pty) {
                    const pty = createRequire(import.meta.url)('node-pty');
                    const child = pty.spawn(process.execPath, args, {
                        cwd: process.cwd(),
                        env,
                        cols: 100,
                        rows: 30,
                        name: 'xterm-256color'
                    });
                    let text = '';
                    child.onData((data: string) => {
                        text = (text + data).slice(-32768);
                    });
                    try {
                        if (route.denyBridge) {
                            const end = performance.now() + 10000;
                            while (!fs.existsSync(counts) || JSON.parse(fs.readFileSync(counts, 'utf8')).bridge === 0) {
                                assert.ok(performance.now() < end, 'actual remote preparation reached');
                                await new Promise((resolve) => setTimeout(resolve, 50));
                            }
                            child.write('/help\r');
                            const helpEnd = performance.now() + 3000;
                            while (!text.includes('Commands') && !text.includes('快捷键') && !text.includes('命令')) {
                                assert.ok(performance.now() < helpEnd, 'local help remains interactive');
                                await new Promise((resolve) => setTimeout(resolve, 50));
                            }
                            child.kill('SIGTERM');
                        }
                        const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
                            const timer = setTimeout(
                                () => reject(Error(`isolated PTY route timeout: ${exitMode || route.args.join(' ') || 'missing bridge'}`)),
                                exitMode ? 20000 : 10000
                            );
                            child.onExit((result: { exitCode: number }) => {
                                clearTimeout(timer);
                                resolve(result);
                            });
                        });
                        assert.equal(result.exitCode, route.code, exitMode);
                        if (exitMode) {
                            const events = fs.readFileSync(counts + '.exit', 'utf8').trim().split('\n');
                            if (exitMode.startsWith('SIG')) {
                                assert.deepEqual(events, ['started', 'close', 'closed', 'telemetry']);
                            } else {
                                assert.deepEqual(events, ['started']);
                                assert.ok(text.includes('[OpenDesk FATAL] ' + exitMode) && text.includes('synthetic fatal'));
                            }
                        }
                    } finally {
                        child.kill();
                    }
                } else {
                    const child = spawn(process.execPath, args, { env, stdio: 'ignore' });
                    const result = await new Promise<number | null>((resolve, reject) => {
                        const timer = setTimeout(() => {
                            child.kill();
                            reject(Error('isolated parse timeout'));
                        }, 10000);
                        child.once('error', reject);
                        child.once('exit', (code) => {
                            clearTimeout(timer);
                            resolve(code);
                        });
                    });
                    assert.equal(result, route.code);
                }
                if (route.denyBridge) assert.ok(JSON.parse(fs.readFileSync(counts, 'utf8')).bridge > 0);
                else assert.deepEqual(JSON.parse(fs.readFileSync(counts, 'utf8')), { assembly: 0, bridge: 0 });
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
);
