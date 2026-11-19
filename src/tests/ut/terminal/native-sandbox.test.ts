import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import { NaiveSandboxKit, type NativeSandboxRequest, type SandboxKit } from '../../../platforms/bridges/common.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-native-sandbox-'));
const spawn = jest.fn();
jest.unstable_mockModule('node:child_process', () => ({ spawn, execFileSync: jest.fn(), spawnSync: jest.fn() }));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getOpendeskDirectory: () => directory,
    getLogDirectory: () => directory,
    getTaskToolResultDirectory: () => directory,
    getTaskTrashDirectory: () => path.join(directory, 'trash'),
    Setting: { getInstance: () => ({ data: { locale: 'en-US' }, getData: () => ({ locale: 'en-US' }) }) }
}));
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    buildChildProcessEnv: () => ({ TASK_ENV: 'preserved' }),
    trackDetachedProcess: jest.fn(),
    createShellOutputDecoder: () => ({ push: (value: Buffer) => value.toString(), flush: () => '' }),
    filterShellEnvironmentWarnings: (value: string) => value,
    buildInterpretersEnv: () => ({}),
    hasUserPythonEnvironment: () => false,
    shouldUseIsolatedPython: () => false,
    stripUserPythonEnvironment: (value: unknown) => value,
    findExecutableInPath: jest.fn(),
    hasZsh: jest.fn(),
    getTaskWorkspace: jest.fn(),
    parseCdAndCommand: jest.fn()
}));
jest.unstable_mockModule('../../../main/applications/pluginmgr/runtime/hooks.js', () => ({
    runPluginShellEnv: async (_task: unknown, _input: unknown, environment: object) => environment
}));
jest.unstable_mockModule('../../../main/aikernel/task/permission.js', () => ({
    applyPersistentPermissionAllowForTask: jest.fn()
}));
const { executeShellCommand } = await import('../../../main/applications/terminal/shells/common.js');
const { prepareNativeSandbox } = await import('../../../main/applications/terminal/sandboxes/native-sandbox.js');

class Host extends AbstractPlatform {
    getName() {
        return 'opaque-sandbox-host';
    }
    getEffectiveWorkspace() {
        return directory;
    }
    async initPlatformHarness() {}
    async fetch(): Promise<Response> {
        throw new Error('unexpected network');
    }
}

describe('shared native sandbox preparation and shell execution', () => {
    let kit: SandboxKit, cleanup: ReturnType<typeof jest.fn>, request: NativeSandboxRequest | undefined;
    const originalPlatform = process.platform;
    beforeEach(() => {
        spawn.mockReset();
        request = undefined;
        cleanup = jest.fn(async () => undefined);
        kit = {
            getState: async () => ({ supported: true, ready: true }),
            prepare: jest.fn(async (input: NativeSandboxRequest) => {
                request = input;
                return {
                    file: '/opaque/native/launcher',
                    args: ['run', '--policy', input.policyPath, '--', input.shellPath, ...input.shellArgs],
                    env: { NATIVE_TEMP: '/opaque/runtime/tmp' },
                    cleanup,
                    runtimePaths: { readExecute: ['/opaque/runtime/bin'], writable: ['/opaque/runtime/tmp'] }
                };
            })
        };
        const host = new Host();
        jest.spyOn(host, 'getNativeBridge').mockReturnValue({ getSandboxKit: async () => kit } as any);
        setPlatform(host);
        Object.defineProperty(process, 'platform', { value: 'opaque-test-os', configurable: true });
    });
    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        jest.restoreAllMocks();
    });
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

    const options = (patch: Record<string, unknown> = {}) => ({
        shellPath: '/opaque/runtime/bin/bash',
        shellType: 'bash' as const,
        shellArgs: ['-c', 'printf safe'],
        command: 'printf safe',
        cwd: directory,
        timeout: 500,
        result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
        runningProcesses: new Set<any>(),
        stopPromises: new Map<any, Promise<void>>(),
        isKilledByStop: () => false,
        useDynamicSandbox: true,
        toolName: 'executeBash',
        ...patch
    });
    function child() {
        const process = new EventEmitter() as any;
        process.stdout = new PassThrough();
        process.stderr = new PassThrough();
        process.stdin = { end: jest.fn() };
        process.pid = 43210;
        process.exitCode = null;
        process.signalCode = null;
        spawn.mockImplementation(() => {
            setImmediate(() => {
                process.exitCode = 0;
                process.emit('exit', 0, null);
                process.emit('close', 0, null);
            });
            return process;
        });
        return process;
    }

    test('an opaque host launches through the kit with shared policy, original argv, permissions and idempotent cleanup', async () => {
        child();
        const run = options();
        await executeShellCommand(run);
        expect(kit.prepare).toHaveBeenCalledWith(
            expect.objectContaining({
                shellPath: run.shellPath,
                shellArgs: run.shellArgs,
                cwd: directory,
                readOnly: false
            })
        );
        expect(spawn).toHaveBeenCalledWith(
            '/opaque/native/launcher',
            expect.arrayContaining(['--', run.shellPath, '-c', 'printf safe']),
            expect.objectContaining({ env: { TASK_ENV: 'preserved', NATIVE_TEMP: '/opaque/runtime/tmp' } })
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(request!.policyPath)).toBe(false);
        expect(run.runningProcesses.size).toBe(0);
    });

    test.each(['initializing', 'unavailable'])(
        'a supported but %s host cannot fall back to an ordinary shell',
        async (reason) => {
            kit.getState = async () => ({
                supported: true,
                ready: false,
                reason: reason as 'initializing' | 'unavailable'
            });
            await expect(executeShellCommand(options())).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
            expect(spawn).not.toHaveBeenCalled();
            expect(kit.prepare).not.toHaveBeenCalled();
        }
    );

    test('native preparation failure remains explicit and never spawns the requested ordinary shell', async () => {
        (kit.prepare as jest.Mock).mockRejectedValueOnce(new Error('native launcher unavailable'));
        await expect(executeShellCommand(options())).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.readdirSync(directory).filter((file) => file.endsWith('.toml'))).toEqual([]);
    });

    test('unsupported kit on an unknown OS refuses an enabled sandbox rather than ordinary execution', async () => {
        kit = new NaiveSandboxKit();
        await expect(executeShellCommand(options())).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
        expect(spawn).not.toHaveBeenCalled();
    });

    test('a desktop platform without sandbox components degrades to the ordinary shell', async () => {
        // 桌面端沙箱二进制缺失（未随包/被删除）：宿主未声明 SandboxKit 支持，
        // 平台内置实现也拿不到启动计划，此时降级为宿主 shell 而不是中断任务。
        const host = new Host();
        jest.spyOn(host, 'getNativeBridge').mockReturnValue({
            getSandboxKit: async () => new NaiveSandboxKit()
        } as any);
        setPlatform(host);
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        child();
        await executeShellCommand(options({ cwd: directory }));
        expect(kit.prepare).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledWith('/opaque/runtime/bin/bash', ['-c', 'printf safe'], expect.anything());
    });

    test('spawn failure disposes native and shared resources exactly once', async () => {
        spawn.mockImplementation(() => {
            throw new Error('spawn failed');
        });
        await expect(executeShellCommand(options())).rejects.toThrow('spawn failed');
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(request!.policyPath)).toBe(false);
    });

    test('unlimited mode bypasses the kit and directly launches the selected shell', async () => {
        child();
        await executeShellCommand(options({ taskState: { activeModeId: 'unlimited', harnessContext: {} } }));
        expect(kit.prepare).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledWith('/opaque/runtime/bin/bash', ['-c', 'printf safe'], expect.anything());
    });

    test('native preparation writes shared policy only after runtime paths arrive and readonly disallows runtime writes', async () => {
        const launch = await prepareNativeSandbox(kit, {
            ...options(),
            taskState: {
                activeModeId: 'readonly',
                harnessContext: {
                    permission: {
                        getRules: () => [
                            { resourceType: 'file', action: 'read', pathPattern: `${directory}/**`, effect: 'allow' },
                            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
                        ]
                    }
                }
            }
        } as any);
        try {
            const text = fs.readFileSync(request!.policyPath, 'utf8');
            expect(request!.readOnly).toBe(true);
            // Windows 的 libuv 不支持 POSIX 权限位：chmod 只能切换只读属性，
            // stat 恒返回 0o666（可写）或 0o444（只读），0o600 断言只在 POSIX 上有意义。
            // 本测试 beforeEach 会伪造 process.platform，这里必须用真实平台 originalPlatform 判断
            if (originalPlatform !== 'win32') {
                expect(fs.statSync(request!.policyPath).mode & 0o777).toBe(0o600);
            }
            expect(text).toContain('path = "/opaque/runtime/bin/**"\naccess = "read"\nperm = "allow"');
            expect(text).not.toContain('path = "/opaque/runtime/tmp/**"\naccess = "write"\nperm = "allow"');
            expect(text).not.toContain(`path = "${directory}/**"\naccess = "write"\nperm = "allow"`);
        } finally {
            await launch.cleanup();
            await launch.cleanup();
        }
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test('host runtime declarations cannot replace an explicit broader user deny or grant the root filesystem', async () => {
        const launch = await prepareNativeSandbox(kit, {
            ...options(),
            taskState: {
                activeModeId: 'standard',
                harnessContext: {
                    permission: {
                        getRules: () => [
                            { resourceType: 'file', action: 'read', pathPattern: '/opaque/**', effect: 'deny' },
                            { resourceType: 'file', action: 'execute', pathPattern: '/opaque/**', effect: 'deny' }
                        ]
                    }
                }
            }
        } as any);
        try {
            const text = fs.readFileSync(request!.policyPath, 'utf8');
            expect(text).not.toContain('path = "/opaque/runtime/bin/**"\naccess = "read"\nperm = "allow"');
            expect(text).not.toContain('path = "/opaque/runtime/bin/**"\naccess = "execute"\nperm = "allow"');
            expect(text).toContain('path = "/opaque/**"\naccess = "execute"\nperm = "deny"');
        } finally {
            await launch.cleanup();
        }
        const prepare = kit.prepare;
        kit.prepare = async (input) => ({
            ...(await prepare(input)),
            runtimePaths: { readExecute: ['/'], writable: [] }
        });
        // 策略校验失败不是"组件缺失"，因此不携带可降级错误码：调用方必须原样上抛，
        // 不能把策略故障降级成以宿主权限执行。
        await expect(prepareNativeSandbox(kit, options())).rejects.toThrow('cannot grant the filesystem root');
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    test('shared approval endpoint pauses/resumes, handles allow/deny, rejects stopped tasks and is closed by cleanup', async () => {
        const wait: boolean[] = [];
        let resolvePrompt!: (value: { decision: string }) => void;
        const prompt = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolvePrompt = resolve;
                })
        );
        const task = {
            task_id: 'native-permission-test',
            task_name: 'Sandbox approval',
            task_status: 'running',
            getWorkspace: () => directory,
            getActivePermissionPrompt: () => ({ prompt }),
            harnessContext: { permission: { getRules: () => [], check: async () => undefined } }
        };
        const launch = await prepareNativeSandbox(kit, {
            ...options(),
            taskState: task,
            onPermissionWaitChange: (value) => wait.push(value)
        } as any);
        const policy = fs.readFileSync(request!.policyPath, 'utf8');
        const token = /token = "([a-f0-9]+)"/.exec(policy)![1];
        const ask = (name: string) =>
            fetch(request!.endpoint, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ path: `/external/${name}`, access: 'write' })
            });
        try {
            for (const decision of ['allow', 'deny']) {
                const pending = ask(decision);
                for (let count = 0; count < 50 && prompt.mock.calls.length < (decision === 'allow' ? 1 : 2); count++)
                    await new Promise((resolve) => setTimeout(resolve, 5));
                expect(wait.at(-1)).toBe(true);
                resolvePrompt({ decision });
                expect(await (await pending).json()).toEqual({ decision });
                expect(wait.at(-1)).toBe(false);
            }
            expect(prompt).toHaveBeenCalledWith(
                expect.any(Array),
                'executeBash',
                expect.any(Array),
                expect.objectContaining({ taskId: task.task_id }),
                { input: { command: 'printf safe' } }
            );
            task.task_status = 'stopped';
            expect(await (await ask('after-stop')).json()).toEqual({ decision: 'deny' });
            expect(prompt).toHaveBeenCalledTimes(2);
        } finally {
            await launch.cleanup();
        }
        await expect(ask('after-cleanup')).rejects.toThrow();
        expect(fs.existsSync(request!.policyPath)).toBe(false);
    });

    test('readonly runtime allowances cannot ignore an additional explicit global read deny', async () => {
        const launch = await prepareNativeSandbox(kit, {
            ...options(),
            taskState: {
                activeModeId: 'readonly',
                harnessContext: {
                    permission: {
                        getRules: () => [
                            { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'deny' },
                            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
                        ]
                    }
                }
            }
        } as any);
        try {
            expect(fs.readFileSync(request!.policyPath, 'utf8')).not.toContain(
                'path = "/opaque/runtime/bin/**"\naccess = "read"\nperm = "allow"'
            );
        } finally {
            await launch.cleanup();
        }
    });

    test('a stop during asynchronous native preparation disposes the plan and never spawns', async () => {
        const task = { task_status: 'running', harnessContext: {} };
        const prepare = kit.prepare;
        kit.prepare = async (input) => {
            const launch = await prepare(input);
            task.task_status = 'stopped';
            return launch;
        };
        await expect(executeShellCommand(options({ taskState: task }))).rejects.toMatchObject({
            code: 'SANDBOX_STOPPED'
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(request!.policyPath)).toBe(false);
    });
});
