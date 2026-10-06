import { jest } from '@jest/globals';
import http from 'http';

const applyPersistentAllow = jest.fn<() => Promise<void>>();
jest.unstable_mockModule('../../../main/aikernel/task/permission.js', () => ({
    applyPersistentPermissionAllowForTask: applyPersistentAllow
}));

const { createSandboxDecideEndpoint } = await import('../../../main/applications/terminal/sandboxes/sandbox-decide.js');

interface DeferredResponse {
    resolve: (response: any) => void;
}

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`condition not met: ${message}`);
};

/**
 * 会话级决策缓存（"允许读取"= 本次任务沙箱执行期间都允许）的行为验证。
 * createSandboxDecideEndpoint 平台无关，直接对端点发 ask 模拟原生层请求；
 * 两次创建端点即模拟同一任务先后两条命令拉起的两个沙箱实例。
 */
describe('sandbox decide session-scoped allow', () => {
    let deferreds: DeferredResponse[];
    let promptCalls: number;
    let checkOverride: ((path: string, action: string) => any) | null;
    let cleanups: Array<() => Promise<void>>;

    const makeTaskState = () => {
        const state = {
            task_id: 'task-session-test',
            task_name: 'session-test',
            getWorkspace: () => '/workspace',
            harnessContext: {
                permission: {
                    check: async (request: any) => {
                        if (checkOverride) return checkOverride(request.resourcePath, request.action);
                        return undefined;
                    },
                    getRules: () => []
                },
                permissionPrompt: {
                    prompt: async () =>
                        new Promise<any>((resolve) => {
                            promptCalls += 1;
                            deferreds.push({ resolve });
                        })
                }
            }
        };
        return state;
    };

    beforeEach(() => {
        deferreds = [];
        promptCalls = 0;
        checkOverride = null;
        applyPersistentAllow.mockClear();
        applyPersistentAllow.mockResolvedValue();
        cleanups = [];
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) {
            await cleanup();
        }
    });

    const launchEndpoint = async (taskState: any) => {
        const decide = await createSandboxDecideEndpoint({
            taskState,
            pathMapper: (sandboxPath) => sandboxPath
        });
        cleanups.push(decide.cleanup);
        return decide;
    };

    const postDecision = (decide: { endpoint: string; token: string }, path: string, access = 'read') => {
        const pending = new Promise<{ status: number; body: string }>((resolve, reject) => {
            const url = new URL(decide.endpoint);
            const data = JSON.stringify({ token: decide.token, path, access });
            const request = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${decide.token}`,
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
        pending.catch(() => undefined);
        return pending;
    };

    test('plain allow is replayed for later sandbox instances of the same task without re-prompting', async () => {
        const taskState = makeTaskState();

        // 第一条命令的沙箱实例：弹窗，用户点绿色"允许读取"（rememberScope none）
        const first = await launchEndpoint(taskState);
        const firstAsk = postDecision(first, '/home/liyi/.opendesk/logs/app.log');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        expect(JSON.parse((await firstAsk).body)).toEqual({ decision: 'allow' });
        expect(applyPersistentAllow).not.toHaveBeenCalled();

        // 同任务下一条命令的新沙箱实例：同路径同操作直接放行，不再弹窗
        const second = await launchEndpoint(taskState);
        const secondAsk = postDecision(second, '/home/liyi/.opendesk/logs/app.log');
        const secondResponse = await secondAsk;
        expect(promptCalls).toBe(1);
        expect(JSON.parse(secondResponse.body)).toEqual({ decision: 'allow' });
    });

    test('session allow is scoped per (action, path): other paths and actions still prompt', async () => {
        const taskState = makeTaskState();
        const first = await launchEndpoint(taskState);
        const firstAsk = postDecision(first, '/home/liyi/.opendesk/logs/app.log');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        await firstAsk;

        const second = await launchEndpoint(taskState);
        const otherFileAsk = postDecision(second, '/home/liyi/.opendesk/logs/other.log');
        await waitFor(() => promptCalls === 2, 'a different path to prompt again');
        deferreds[1].resolve({ decision: 'deny', rememberScope: 'none' });
        expect(JSON.parse((await otherFileAsk).body)).toEqual({ decision: 'deny' });

        const writeAsk = postDecision(second, '/home/liyi/.opendesk/logs/app.log', 'write');
        await waitFor(() => promptCalls === 3, 'a different action to prompt again');
        deferreds[2].resolve({ decision: 'allow', rememberScope: 'none' });
        expect(JSON.parse((await writeAsk).body)).toEqual({ decision: 'allow' });
    });

    test('session allow does not leak into a new harness context', async () => {
        const firstTaskState = makeTaskState();
        const first = await launchEndpoint(firstTaskState);
        const firstAsk = postDecision(first, '/home/liyi/secret.txt');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        await firstAsk;

        // 新 harnessContext（新会话/新任务）：同样的 ask 必须重新弹窗
        const second = await launchEndpoint(makeTaskState());
        const secondAsk = postDecision(second, '/home/liyi/secret.txt');
        await waitFor(() => promptCalls === 2, 'the new session to prompt again');
        deferreds[1].resolve({ decision: 'deny', rememberScope: 'none' });
        expect(JSON.parse((await secondAsk).body)).toEqual({ decision: 'deny' });
    });

    test('deny decisions are not remembered across sandbox instances', async () => {
        const taskState = makeTaskState();
        const first = await launchEndpoint(taskState);
        const firstAsk = postDecision(first, '/home/liyi/secret.txt');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({ decision: 'deny', rememberScope: 'none' });
        expect(JSON.parse((await firstAsk).body)).toEqual({ decision: 'deny' });

        // 拒绝只对当前沙箱实例生效：后续命令重新询问（用户可能改变主意），
        // 不做会话级静默拒绝
        const second = await launchEndpoint(taskState);
        const secondAsk = postDecision(second, '/home/liyi/secret.txt');
        await waitFor(() => promptCalls === 2, 'the next instance to prompt again');
        deferreds[1].resolve({ decision: 'allow', rememberScope: 'none' });
        expect(JSON.parse((await secondAsk).body)).toEqual({ decision: 'allow' });
    });

    test('engine deny rule takes precedence over a remembered session allow', async () => {
        const taskState = makeTaskState();
        const first = await launchEndpoint(taskState);
        const firstAsk = postDecision(first, '/home/liyi/secret.txt');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({ decision: 'allow', rememberScope: 'none' });
        await firstAsk;

        // 引擎随后出现显式 deny（用户规则/策略变更）：会话 allow 不得架空它
        checkOverride = () => ({ effect: 'deny', request: {} });
        const second = await launchEndpoint(taskState);
        const secondAsk = postDecision(second, '/home/liyi/secret.txt');
        const response = await secondAsk;
        expect(promptCalls).toBe(1);
        expect(JSON.parse(response.body)).toEqual({ decision: 'deny' });
    });

    test('remembered prefix allow still writes the persistent engine rule', async () => {
        const taskState = makeTaskState();
        const first = await launchEndpoint(taskState);
        const firstAsk = postDecision(first, '/home/liyi/.opendesk/logs/app.log');
        await waitFor(() => promptCalls === 1, 'the first prompt to open');
        deferreds[0].resolve({
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/home/liyi/.opendesk/logs/**'
        });
        await firstAsk;

        expect(applyPersistentAllow).toHaveBeenCalledWith(taskState, {
            resourceType: 'file',
            action: 'read',
            pathPattern: '/home/liyi/.opendesk/logs/**',
            effect: 'allow'
        });
    });
});
