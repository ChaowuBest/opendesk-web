import { jest } from '@jest/globals';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { PermissionUserResponse } from '../../../main/aikernel/security/permission.js';

const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-dynabox-config-'));
const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-dynabox-logs-'));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getOpendeskDirectory: () => configDirectory,
    getLogDirectory: () => logDirectory,
    Setting: class {
        static getInstance() {
            return { data: { locale: 'zh-CN' }, getEffectiveWorkspace: () => 'D:/workspace' };
        }
    }
}));
// 沙箱回环授权依赖原生沙箱可执行文件，测试中直接跳过
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/loopback.js', () => ({
    ensureSandboxLoopback: async () => {}
}));
// 命名管道放通同样依赖原生沙箱可执行文件，测试中直接跳过；
// 以 spy 形式断言 prepareDynamicSandbox 确实接入了该流程
const ensureSandboxPipes = jest.fn(async () => false);
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/pipes.js', () => ({
    ensureSandboxPipes
}));
// 权限批准后的持久化规则写入依赖完整任务状态，本测试不触发 rememberScope
jest.unstable_mockModule('../../../main/aikernel/task/permission.js', () => ({
    applyPersistentPermissionAllowForTask: jest.fn()
}));

const { prepareDynamicSandbox } = await import('../../../main/applications/terminal/sandboxes/dynabox.js');

const realExistsSync = fs.existsSync.bind(fs);
const sandboxExecutable = 'sandbox/sandbox.exe';

interface DeferredResponse {
    resolve: (response: PermissionUserResponse) => void;
}

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`condition not met: ${message}`);
};

(process.platform === 'win32' ? describe : describe.skip)('dynamic sandbox permission wait notifications', () => {
    let existsSpy: jest.SpiedFunction<typeof fs.existsSync>;
    let deferreds: DeferredResponse[];
    let promptCalls: number;
    let waitEvents: boolean[];
    let cleanups: Array<() => Promise<void>>;

    const makeTaskState = () => ({
        task_id: 'task-permission-wait',
        task_name: 'permission-wait-test',
        getWorkspace: () => 'D:/workspace',
        harnessContext: {
            permission: {
                check: async () => undefined,
                getRules: () => []
            },
            permissionPrompt: {
                prompt: async () =>
                    new Promise<PermissionUserResponse>((resolve) => {
                        promptCalls += 1;
                        deferreds.push({ resolve });
                    })
            }
        }
    });

    beforeEach(() => {
        existsSpy = jest
            .spyOn(fs, 'existsSync')
            .mockImplementation((target) =>
                typeof target === 'string' && target.replace(/\\/g, '/').endsWith(sandboxExecutable)
                    ? true
                    : realExistsSync(target as fs.PathLike)
            );
        deferreds = [];
        promptCalls = 0;
        waitEvents = [];
        cleanups = [];
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) {
            await cleanup();
        }
        existsSpy.mockRestore();
    });

    const launchSandbox = async (onPermissionWaitChange?: (waiting: boolean) => void) => {
        const filesBefore = new Set(fs.readdirSync(configDirectory));
        const launch = await prepareDynamicSandbox({
            shellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
            shellArgs: ['-NoProfile', '-Command', 'Set-Content ./new.txt hi'],
            command: 'Set-Content ./new.txt hi',
            cwd: 'D:/workspace',
            taskState: makeTaskState() as any,
            deleteToTrash: false,
            onPermissionWaitChange: onPermissionWaitChange ?? ((waiting: boolean) => waitEvents.push(waiting))
        });
        expect(launch).not.toBeNull();
        cleanups.push(launch!.cleanup);
        // 按目录差集定位本次启动写入的策略文件，兼容多个实例并存的场景
        const policyFile = fs
            .readdirSync(configDirectory)
            .find((name) => !filesBefore.has(name) && name.endsWith('.toml'));
        expect(policyFile).toBeDefined();
        const policy = fs.readFileSync(path.join(configDirectory, policyFile!), 'utf8');
        const endpoint = /endpoint = "(http:\/\/127\.0\.0\.1:\d+\/decide)"/.exec(policy)![1];
        const token = /token = "([0-9a-f]{64})"/.exec(policy)![1];
        return { endpoint, token };
    };

    const postDecision = (endpoint: string, token: string, body: Record<string, unknown>) => {
        const pending = new Promise<{ status: number; body: string }>((resolve, reject) => {
            const url = new URL(endpoint);
            const data = JSON.stringify(body);
            const request = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(data)
                    }
                },
                (response) => {
                    let chunks = '';
                    response.on('data', (chunk) => (chunks += chunk));
                    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: chunks }));
                }
            );
            request.on('error', reject);
            request.end(data);
        });
        // 断言失败后 afterEach 会 closeAllConnections，滞留请求的 rejection 不能击穿进程
        pending.catch(() => undefined);
        return pending;
    };

    test('pauses while the prompt waits and resumes once the permission is approved', async () => {
        const { endpoint, token } = await launchSandbox();

        const pending = postDecision(endpoint, token, {
            token,
            path: '/D/workspace/new.txt',
            access: 'write'
        });
        await waitFor(() => promptCalls === 1, 'permission prompt to open');
        // 弹窗等待用户决策：通知宿主暂停计时
        expect(waitEvents).toEqual([true]);

        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        const response = await pending;
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ decision: 'allow' });
        // 决策已返回（批准）：通知宿主恢复计时
        await waitFor(() => waitEvents.length === 2, 'resume notification');
        expect(waitEvents).toEqual([true, false]);
    });

    test('resumes once the permission is denied', async () => {
        const { endpoint, token } = await launchSandbox();

        const pending = postDecision(endpoint, token, {
            token,
            path: '/D/workspace/secret.txt',
            access: 'write'
        });
        await waitFor(() => promptCalls === 1, 'permission prompt to open');
        expect(waitEvents).toEqual([true]);

        deferreds[0].resolve({ decision: 'deny', rememberScope: 'none' });
        const response = await pending;
        expect(JSON.parse(response.body)).toEqual({ decision: 'deny' });
        await waitFor(() => waitEvents.length === 2, 'resume notification');
        expect(waitEvents).toEqual([true, false]);
    });

    test('concurrent prompts pause the clock once and resume after all decisions settle', async () => {
        const { endpoint, token } = await launchSandbox();

        const first = postDecision(endpoint, token, { token, path: '/D/workspace/a.txt', access: 'write' });
        const second = postDecision(endpoint, token, { token, path: '/D/workspace/b.txt', access: 'write' });
        await waitFor(() => promptCalls === 2, 'both permission prompts to open');
        // 两个等待中的弹窗只跨过一次 0↔N 边界：仅通知一次暂停
        expect(waitEvents).toEqual([true]);

        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        deferreds[1].resolve({ decision: 'deny', rememberScope: 'none' });
        const [firstResponse, secondResponse] = await Promise.all([first, second]);
        expect(JSON.parse(firstResponse.body)).toEqual({ decision: 'allow' });
        expect(JSON.parse(secondResponse.body)).toEqual({ decision: 'deny' });
        await waitFor(() => waitEvents.length === 2, 'resume notification');
        expect(waitEvents).toEqual([true, false]);
    });

    test('identical concurrent asks share one prompt and one pause notification', async () => {
        const { endpoint, token } = await launchSandbox();

        const first = postDecision(endpoint, token, { token, path: '/D/workspace/same.txt', access: 'write' });
        const second = postDecision(endpoint, token, { token, path: '/D/workspace/same.txt', access: 'write' });
        await waitFor(() => promptCalls === 1, 'the single shared prompt to open');
        expect(waitEvents).toEqual([true]);

        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => JSON.parse(response.body))).toEqual([
            { decision: 'allow' },
            { decision: 'allow' }
        ]);
        await waitFor(() => waitEvents.length === 2, 'resume notification');
        expect(waitEvents).toEqual([true, false]);
    });

    test('an observer that throws cannot wedge later pause notifications', async () => {
        const calls: boolean[] = [];
        const { endpoint, token } = await launchSandbox((waiting) => {
            calls.push(waiting);
            if (calls.length === 1) throw new Error('observer failure');
        });

        // 第一次 ask：观察者在 +1 通知时抛错，本次按 deny 兜底，
        // finally 仍归还计数并通知恢复（[true, false]），不会卡死在等待态
        const first = postDecision(endpoint, token, { token, path: '/D/workspace/a.txt', access: 'write' });
        const firstResponse = await first;
        expect(JSON.parse(firstResponse.body)).toEqual({ decision: 'deny' });
        expect(promptCalls).toBe(0);
        expect(calls).toEqual([true, false]);

        // 第二次 ask：计数已配平，暂停/恢复通知恢复正常工作
        const second = postDecision(endpoint, token, { token, path: '/D/workspace/b.txt', access: 'write' });
        await waitFor(() => promptCalls === 1, 'the second prompt to open');
        expect(calls).toEqual([true, false, true]);
        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        const secondResponse = await second;
        expect(JSON.parse(secondResponse.body)).toEqual({ decision: 'allow' });
        await waitFor(() => calls.length === 4, 'resume notification');
        expect(calls).toEqual([true, false, true, false]);
    });

    test('sandbox launches wire the named-pipe enablement attempt once per launch', async () => {
        const before = ensureSandboxPipes.mock.calls.length;
        await launchSandbox();
        expect(ensureSandboxPipes).toHaveBeenCalledTimes(before + 1);
        expect(ensureSandboxPipes).toHaveBeenLastCalledWith(expect.stringMatching(/sandbox\.exe$/));
    });
});
