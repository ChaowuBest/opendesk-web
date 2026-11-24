import { jest } from '@jest/globals';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionRequest
} from '../../../main/aikernel/security/permission';

type IpcHandler = (_event: unknown, requestId: string, response: Record<string, unknown>) => void;

const ipcHandlers = new Map<string, Set<IpcHandler>>();
const sentMessages: Array<{ channel: string; args: unknown[] }> = [];
const secondarySentMessages: Array<{ channel: string; args: unknown[] }> = [];

const focusedWindow = {
    isDestroyed: () => false,
    show: jest.fn(),
    focus: jest.fn(),
    webContents: {
        send: jest.fn((channel: string, ...args: unknown[]) => {
            sentMessages.push({ channel, args });
        })
    }
};

const secondaryWindow = {
    isDestroyed: () => false,
    show: jest.fn(),
    focus: jest.fn(),
    webContents: {
        send: jest.fn((channel: string, ...args: unknown[]) => {
            secondarySentMessages.push({ channel, args });
        })
    }
};

let browserWindows = [focusedWindow];

const ipcMain = {
    on: jest.fn((channel: string, handler: IpcHandler) => {
        if (!ipcHandlers.has(channel)) {
            ipcHandlers.set(channel, new Set());
        }
        ipcHandlers.get(channel)!.add(handler);
    }),
    removeListener: jest.fn((channel: string, handler: IpcHandler) => {
        ipcHandlers.get(channel)?.delete(handler);
    })
};

class MockNotification {
    static isSupported(): boolean {
        return false;
    }

    show(): void {}
    on(): void {}
}

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: () => ({
        BrowserWindow: {
            getAllWindows: () => browserWindows
        },
        ipcMain,
        Notification: MockNotification
    })
}));

// 系统通知的点击跳转行为由 system-notification 单独覆盖，这里只断言权限弹窗推送了
// 正确的任务标识，保证点击系统通知能回到发起请求的任务
const systemNotifications: Array<{ title: string; body: string; taskId?: string | null }> = [];
// 请求结算后必须作废该任务的待打开记录，否则用户之后聚焦窗口会被误跳回已处理完的任务
const clearedPendingTaskIds: Array<string | null | undefined> = [];

jest.unstable_mockModule('../../../main/utils/system-notification.js', () => ({
    registerNotificationMainWindowResolver: jest.fn(),
    showTaskNotification: (options: { title: string; body: string; taskId?: string | null }) => {
        systemNotifications.push(options);
    },
    clearPendingOpenTasks: (taskId?: string | null) => {
        clearedPendingTaskIds.push(taskId);
    }
}));

// 测试链路（replaceTaskHarnessForMode → buildSystemPrompt → SkillRegistry →
// SoulRegistry）会连带真实加载 logger 并触发文件 transport 懒激活，依赖
// Node 全局定时器；按项目惯例整体 mock logger，避免测试触碰真实日志落盘
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    // ESM loader 对命名导入严格校验：import 链会连带 aikernel/messages.ts
    // （import { logger, getDebugMode }）等模块，mock 必须覆盖全部被引用导出
    getDebugMode: jest.fn().mockReturnValue(false),
    setDebugMode: jest.fn(),
    LogStream: class {}
}));

const { ElectronPermissionPromptProvider } = await import('../../../main/aikernel/security/electronPrompt');
const { MAIN_AGENT_STANDARD_MODE } = await import('../../../main/aikernel/agents/main/modes/standard.js');
const { MAIN_AGENT_SOLO_MODE } = await import('../../../main/aikernel/agents/main/modes/solo.js');
const { MAIN_AGENT_UNLIMITED_MODE } = await import('../../../main/aikernel/agents/main/modes/unlimited.js');
const { GlobPermissionEnforcer } = await import('../../../main/aikernel/security/enforcer');
const { HarnessContext } = await import('../../../main/aikernel/security/harness.js');
const { TaskManagerState, TaskState } = await import('../../../main/aikernel/states/tasks.js');
const { replaceTaskHarnessForMode } = await import('../../../main/aikernel/task/mode.js');
const { logger } = await import('../../../main/utils/logger.js');
const { InteractionDeliveryChannel } = await import('../../../main/aikernel/interaction/delivery.js');
const { MobileInteractionDeliveryEndpoint } = await import('../../../main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.js');
const { MAX_INTERACTION_BYTES } = await import('../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js');

const providers: InstanceType<typeof ElectronPermissionPromptProvider>[] = [];

function createProvider(channel?: any): InstanceType<typeof ElectronPermissionPromptProvider> {
    const provider = new ElectronPermissionPromptProvider(channel);
    providers.push(provider);
    return provider;
}

function sizeBoundDeliveryChannel() {
    const channel = new InteractionDeliveryChannel((sourceTaskId) => (sourceTaskId === 'child' ? 'root' : undefined));
    const requestPermission = jest.fn(() => new Promise<never>(() => undefined));
    channel.registerEndpoint(
        new MobileInteractionDeliveryEndpoint(
            'root',
            {
                requestPermission,
                extNotification: async () => undefined
            } as unknown as AgentSideConnection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            () => undefined
        )
    );
    return { channel, requestPermission };
}

function readRequest(path: string): PermissionRequest {
    return { resourceType: 'file', action: 'read', resourcePath: path };
}

function writeRequest(path: string): PermissionRequest {
    return { resourceType: 'file', action: 'write', resourcePath: path };
}

function permissionRequests(): Array<{ requestId: string; data: any }> {
    return sentMessages
        .filter((msg) => msg.channel === 'permission:request')
        .map((msg) => ({ requestId: msg.args[0] as string, data: msg.args[1] }));
}

function respond(requestId: string, response: Record<string, unknown>): void {
    for (const handler of ipcHandlers.get('permission:response') ?? []) {
        handler({}, requestId, response);
    }
}

beforeEach(() => {
    ipcHandlers.clear();
    sentMessages.length = 0;
    secondarySentMessages.length = 0;
    systemNotifications.length = 0;
    clearedPendingTaskIds.length = 0;
    browserWindows = [focusedWindow];
    jest.clearAllMocks();
});

describe('ElectronPermissionPromptProvider queue', () => {
    test.each(['local', 'mobile'] as const)('%s answer wins once and cannot settle the next prompt', async (source) => {
        const deliveries: Array<{ answer: (response: any) => boolean; close: ReturnType<typeof jest.fn> }> = [];
        const provider = createProvider({
            subscribeEndpointReady: () => () => undefined,
            publishPermission(_request: unknown, answer: (response: any) => boolean) {
                const delivery = { answer, close: jest.fn() };
                deliveries.push(delivery);
                return { delivered: true, close: delivery.close };
            }
        });
        const info = { taskId: 'root', sourceTaskId: 'child' };
        const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
        const second = provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
        const firstId = permissionRequests()[0].requestId;
        const allow = { decision: 'allow', rememberScope: 'none' };
        if (source === 'local') respond(firstId, allow);
        else expect(deliveries[0].answer(allow)).toBe(true);
        await expect(first).resolves.toEqual(allow);
        expect(permissionRequests()).toHaveLength(2);
        expect(deliveries[0].answer({ decision: 'deny', rememberScope: 'none' })).toBe(false);
        respond(firstId, { decision: 'deny', rememberScope: 'none' });
        expect(deliveries[1].close).not.toHaveBeenCalled();
        expect(deliveries[1].answer(allow)).toBe(true);
        await expect(second).resolves.toEqual(allow);
        if (source === 'local') expect(deliveries[0].close).toHaveBeenCalledWith('superseded');
    });

    test.each(['allow', 'ask', 'deny'] as const)(
        'mobile persistent grant respects the updated %s rule',
        async (effect) => {
            jest.useFakeTimers();
            const deliveries: Array<(response: any) => boolean> = [];
            const provider = createProvider({
                subscribeEndpointReady: () => () => undefined,
                publishPermission(_request: unknown, answer: (response: any) => boolean) {
                    deliveries.push(answer);
                    return { delivered: true, close: jest.fn() };
                }
            });
            const info = { taskId: 'root', sourceTaskId: 'child' };
            const first = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], info);
            const second = provider.prompt([readRequest('/tmp/.env')], 'readFile', [], info);
            expect(
                deliveries[0]({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: '/tmp/**' })
            ).toBe(true);
            await first;
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**/.env', effect },
                { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
            ]);
            await provider.notifyPermissionRulesChanged(enforcer);
            jest.advanceTimersByTime(0);
            if (effect === 'allow') {
                await expect(second).resolves.toMatchObject({ decision: 'allow' });
                expect(deliveries).toHaveLength(1);
            } else {
                expect(deliveries).toHaveLength(2);
                expect(deliveries[1]({ decision: 'deny', rememberScope: 'none' })).toBe(true);
                await expect(second).resolves.toMatchObject({ decision: 'deny' });
            }
        }
    );

    afterEach(() => {
        for (const provider of providers.splice(0)) {
            provider.dispose();
        }
        jest.useRealTimers();
    });

    test('logger is mocked so the import chain never activates a real file transport', () => {
        expect(jest.isMockFunction(logger.info)).toBe(true);
    });

    test('publishes all actual permission choices without internal prompt context', async () => {
        const closes: string[] = [];
        const channel: any = {
            permission: undefined,
            subscribeEndpointReady: () => () => undefined,
            publishPermission(request: unknown, answer: (response: unknown) => boolean) {
                channel.permission = { request, answer };
                return { delivered: true, close: (status: string) => closes.push(status) };
            }
        };
        const provider = createProvider(channel);
        const result = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'shell',
            [
                { label: '/tmp/a.txt', pattern: '/tmp/a.txt' },
                { label: '/tmp/', pattern: '/tmp/**' }
            ],
            { taskId: 'root', taskName: 'Root', sourceTaskId: 'child' },
            {
                toolCallId: 'internal-tool-call',
                messageId: 'internal-message',
                input: { token: 'secret' }
            }
        );
        expect(channel.permission.request.options.map((option: any) => option.kind)).toEqual([
            'allowOnce',
            'allowAlwaysPrefix',
            'allowAlwaysPrefix',
            'allowAlwaysType',
            'rejectOnce'
        ]);
        expect(JSON.stringify(channel.permission.request)).not.toContain('internal-tool-call');
        expect(JSON.stringify(channel.permission.request)).not.toContain('internal-message');
        expect(JSON.stringify(channel.permission.request)).not.toContain('secret');
        expect(channel.permission.answer(channel.permission.request.options[1].response)).toBe(true);
        await expect(result).resolves.toEqual(channel.permission.request.options[1].response);
        expect(closes).toEqual([]);
    });

    test('waits for Mobile when no Electron window is available', async () => {
        browserWindows = [];
        const channel: any = {
            permission: undefined,
            subscribeEndpointReady: () => () => undefined,
            publishPermission(request: unknown, answer: (response: unknown) => boolean) {
                channel.permission = { request, answer };
                return { delivered: true, close: jest.fn() };
            }
        };
        const provider = createProvider(channel);
        const result = provider.prompt([readRequest('/tmp/a.txt')], 'shell', [], {
            taskId: 'root',
            taskName: 'Root',
            sourceTaskId: 'child'
        });
        expect(channel.permission.answer({ decision: 'allow', rememberScope: 'none' })).toBe(true);
        await expect(result).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
    });

    test('keeps Permission on its ACP/runtime size boundary and still shows the local Electron prompt', async () => {
        const remote = sizeBoundDeliveryChannel();
        const provider = createProvider(remote.channel);
        const result = provider.prompt([readRequest(`/tmp/${'x'.repeat(MAX_INTERACTION_BYTES + 1)}`)], 'shell', [], {
            taskId: 'root',
            taskName: 'Root',
            sourceTaskId: 'child'
        });
        expect(permissionRequests()).toHaveLength(1);
        expect(remote.requestPermission).toHaveBeenCalledTimes(1);
        respond(permissionRequests()[0].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(result).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('shows one prompt at a time and advances after one-time allow', async () => {
        const provider = createProvider();
        const first = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-1',
            sourceTaskName: 'Child 1',
            parentTaskId: 'parent'
        });
        const second = provider.prompt([readRequest('/tmp/b.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-2',
            sourceTaskName: 'Child 2',
            parentTaskId: 'parent'
        });

        expect(permissionRequests()).toHaveLength(1);
        expect(permissionRequests()[0].data.taskId).toBe('parent');
        expect(permissionRequests()[0].data.sourceTaskId).toBe('child-1');

        respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });

        expect(permissionRequests()).toHaveLength(2);
        expect(permissionRequests()[1].data.sourceTaskId).toBe('child-2');

        respond(permissionRequests()[1].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(second).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('rebroadcasts current prompt until it receives a response', async () => {
        jest.useFakeTimers();
        const provider = createProvider();
        const prompt = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-1',
            parentTaskId: 'parent'
        });

        expect(permissionRequests()).toHaveLength(1);
        jest.advanceTimersByTime(2000);
        expect(permissionRequests()).toHaveLength(2);

        respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });

        jest.advanceTimersByTime(4000);
        expect(permissionRequests()).toHaveLength(2);
    });

    test('persistent allow immediately auto-resolves matching queued requests', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                sourceTaskName: 'Child 1',
                parentTaskId: 'parent'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/b.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-2',
                sourceTaskName: 'Child 2',
                parentTaskId: 'parent'
            }
        );

        expect(permissionRequests()).toHaveLength(1);
        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await expect(first).resolves.toMatchObject({
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await expect(second).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(permissionRequests()).toHaveLength(1);

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        expect(permissionRequests()).toHaveLength(1);
    });

    test('persistent allow does not block an unrelated write permission prompt', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'terminal-executeBash',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            { taskId: 'task-1', taskName: 'Task 1' }
        );
        expect(permissionRequests()).toHaveLength(1);

        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await expect(first).resolves.toMatchObject({ decision: 'allow', rememberScope: 'prefix' });

        const write = provider.prompt([writeRequest('/tmp/output.txt')], 'filemgr-writeFile', [], {
            taskId: 'task-1',
            taskName: 'Task 1'
        });

        expect(permissionRequests()).toHaveLength(2);
        const writeRequestId = permissionRequests()[1].requestId;
        respond(writeRequestId, { decision: 'deny', rememberScope: 'none' });
        await expect(write).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('persistent allow rule changes can resolve the current prompt', async () => {
        const provider = createProvider();
        const prompt = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                sourceTaskName: 'Child 1',
                parentTaskId: 'parent'
            }
        );

        expect(permissionRequests()).toHaveLength(1);

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(
            sentMessages.some(
                (msg) => msg.channel === 'permission:dismiss' && msg.args[0] === permissionRequests()[0].requestId
            )
        ).toBe(true);
    });

    test('switching an Electron task to unlimited dismisses its current permission prompt', async () => {
        const provider = createProvider();
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'task-1';
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        const prompt = provider.prompt([readRequest('/outside-workspace/secret.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });

        await replaceTaskHarnessForMode(task, '/workspace', MAIN_AGENT_UNLIMITED_MODE, () => provider);

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(task.activeModeId).toBe(MAIN_AGENT_UNLIMITED_MODE.id);
        expect(
            sentMessages.some(
                (msg) => msg.channel === 'permission:dismiss' && msg.args[0] === permissionRequests()[0].requestId
            )
        ).toBe(true);
    });

    test('switching an Electron task from standard to solo dismisses its current permission prompt', async () => {
        const provider = createProvider();
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'task-1';
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        const prompt = provider.prompt([readRequest('/outside-workspace/secret.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });

        await replaceTaskHarnessForMode(task, '/workspace', MAIN_AGENT_SOLO_MODE, () => provider);

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(task.activeModeId).toBe(MAIN_AGENT_SOLO_MODE.id);
        expect(
            sentMessages.some(
                (msg) => msg.channel === 'permission:dismiss' && msg.args[0] === permissionRequests()[0].requestId
            )
        ).toBe(true);
    });

    test('Electron mode replacement keeps the task-specific workspace', async () => {
        const provider = createProvider();
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'workspace-task';
        task.workspace = '/task-workspace';
        task.harnessContext = await HarnessContext.createForMode('/task-workspace', MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;

        await replaceTaskHarnessForMode(task, '/global-workspace', MAIN_AGENT_UNLIMITED_MODE, () => provider);

        expect(task.harnessContext.workspace).toBe('/task-workspace');
    });

    test('mode replacement leaves the task unchanged when system prompt preparation fails', async () => {
        const provider = createProvider();
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'atomic-mode-task';
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        task.allowedTools = MAIN_AGENT_STANDARD_MODE.allowedTools;
        task.disabledTools = MAIN_AGENT_STANDARD_MODE.disabledTools;
        task.setSystemPrompt('system:standard');
        const previousContext = task.harnessContext;
        jest.spyOn(task, 'buildSystemPrompt').mockRejectedValueOnce(new Error('prompt generation failed'));

        await expect(
            replaceTaskHarnessForMode(task, '/workspace', MAIN_AGENT_UNLIMITED_MODE, () => provider)
        ).rejects.toThrow('prompt generation failed');

        expect(task.harnessContext).toBe(previousContext);
        expect(task.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(task.allowedTools).toBe(MAIN_AGENT_STANDARD_MODE.allowedTools);
        expect(task.disabledTools).toBe(MAIN_AGENT_STANDARD_MODE.disabledTools);
        expect(task.chat_context.system_prompt?.content).toBe('system:standard');
    });

    test('an async current re-check cannot approve the next Electron permission prompt', async () => {
        const provider = createProvider();
        const first = provider.prompt([readRequest('/tmp/a.txt')], 'firstTool', [], {
            taskId: 'task-1',
            taskName: 'First'
        });
        const second = provider.prompt([readRequest('/tmp/b.txt')], 'secondTool', [], {
            taskId: 'task-2',
            taskName: 'Second'
        });
        let resolveCheck!: (results: PermissionCheckResult[]) => void;
        const delayedEnforcer: PermissionEnforcer = {
            check: async (request) => ({ effect: 'allow', request }),
            checkAll: async () => null,
            checkAllDetailed: () =>
                new Promise<PermissionCheckResult[]>((resolve) => {
                    resolveCheck = resolve;
                }),
            addRule: async () => {},
            removeRule: async () => {}
        };

        const notifying = provider.notifyPermissionRulesChanged(delayedEnforcer, ['task-1']);
        const firstRequestId = permissionRequests()[0].requestId;
        respond(firstRequestId, { decision: 'allow', rememberScope: 'none' });
        resolveCheck([]);
        await notifying;

        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(permissionRequests()).toHaveLength(2);

        provider.cancelTaskPrompts(['task-2']);
        await expect(second).resolves.toEqual({
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'task_stopped'
        });
    });

    test('an older async re-check cannot approve a newly displayed prompt', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'firstTool',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'task-1',
                taskName: 'First'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/b.txt')],
            'secondTool',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'task-1',
                taskName: 'Second'
            }
        );
        let resolveCheck!: (results: PermissionCheckResult[]) => void;
        let detailedCheckCount = 0;
        const delayedEnforcer: PermissionEnforcer = {
            check: async (request) => ({ effect: 'ask', request }),
            checkAll: async () => ({
                effect: 'ask',
                request: readRequest('/tmp/a.txt')
            }),
            checkAllDetailed: () => {
                detailedCheckCount++;
                if (detailedCheckCount > 1) {
                    return Promise.resolve([
                        {
                            effect: 'ask',
                            request: readRequest('/tmp/b.txt')
                        }
                    ]);
                }
                return new Promise<PermissionCheckResult[]>((resolve) => {
                    resolveCheck = resolve;
                });
            },
            addRule: async () => {},
            removeRule: async () => {}
        };

        const staleNotification = provider.notifyPermissionRulesChanged(delayedEnforcer, ['task-1']);
        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        resolveCheck([
            {
                effect: 'ask',
                request: readRequest('/tmp/a.txt')
            }
        ]);
        await staleNotification;

        await expect(first).resolves.toMatchObject({
            decision: 'allow',
            rememberScope: 'prefix'
        });
        expect(permissionRequests()).toHaveLength(2);

        const allowingEnforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(allowingEnforcer, ['task-1']);
        await expect(second).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(permissionRequests()).toHaveLength(2);
    });

    test('auto-resolving a prompt dismisses it from every Electron window', async () => {
        browserWindows = [focusedWindow, secondaryWindow];
        const provider = createProvider();
        const prompt = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], {
            taskId: 'task-1',
            taskName: 'Task 1'
        });
        const requestId = permissionRequests()[0].requestId;
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);

        await provider.notifyPermissionRulesChanged(enforcer, ['task-1']);

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(
            sentMessages.some((message) => message.channel === 'permission:dismiss' && message.args[0] === requestId)
        ).toBe(true);
        expect(
            secondarySentMessages.some(
                (message) => message.channel === 'permission:dismiss' && message.args[0] === requestId
            )
        ).toBe(true);
    });

    test('persistent allow filter preserves protected ask priority', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                parentTaskId: 'parent'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/.env')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-2',
                parentTaskId: 'parent'
            }
        );

        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await first;

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '**/.env', effect: 'ask' },
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        expect(permissionRequests()).toHaveLength(2);
        expect(permissionRequests()[1].data.requests[0].resourcePath).toBe('/tmp/.env');

        respond(permissionRequests()[1].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(second).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('pushes a system notification carrying the task id for click-through', async () => {
        const provider = createProvider();
        const prompt = provider.prompt([writeRequest('/tmp/a.txt')], 'writeFile', [], {
            taskId: 'task-77',
            taskName: 'Task 77'
        });

        expect(systemNotifications).toHaveLength(1);
        expect(systemNotifications[0].taskId).toBe('task-77');
        expect(systemNotifications[0].body).toContain('writeFile');

        respond(permissionRequests()[0].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(prompt).resolves.toMatchObject({ decision: 'deny' });
    });

    test('voids the pending open-task record once the prompt is answered', async () => {
        // 用户没点通知、直接在应用内应答时，待打开记录必须作废：
        // 否则之后任意一次主窗口聚焦都会把他强制跳回这个已经处理完的任务。
        const provider = createProvider();
        const prompt = provider.prompt([writeRequest('/tmp/a.txt')], 'writeFile', [], {
            taskId: 'task-77',
            taskName: 'Task 77'
        });

        respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
        await expect(prompt).resolves.toMatchObject({ decision: 'allow' });

        expect(clearedPendingTaskIds).toContain('task-77');
    });
});

describe('mobile queue hand-off and re-offer', () => {
    interface WireRequest {
        requestId: string;
        optionIds: string[];
        answer(optionId: string): void;
        cancel(): void;
    }

    function mobileHarness(options: { holdTerminal?: boolean } = {}) {
        let releaseTerminal = (): void => undefined;
        // The close notification stays in flight until released, reproducing the finish window.
        const terminalGate = options.holdTerminal
            ? new Promise<void>((resolve) => {
                  releaseTerminal = resolve;
              })
            : undefined;
        const channel = new InteractionDeliveryChannel((sourceTaskId) =>
            sourceTaskId === 'child' ? 'root' : undefined
        );
        const wire: WireRequest[] = [];
        const closed: Array<{ requestId: string; status: string }> = [];
        const connection = {
            requestPermission: (params: any) =>
                new Promise((resolve) => {
                    wire.push({
                        requestId: params._meta.opendesk.requestId,
                        optionIds: params.options.map((option: any) => option.optionId),
                        answer: (optionId: string) => resolve({ outcome: { outcome: 'selected', optionId } }),
                        cancel: () => resolve({ outcome: { outcome: 'cancelled' } })
                    });
                }),
            extNotification: async (_method: string, payload: any) => {
                closed.push({ requestId: payload.requestId, status: payload.status });
                await terminalGate;
            }
        } as unknown as AgentSideConnection;
        const endpoints: MobileInteractionDeliveryEndpoint[] = [];
        const attach = (): (() => void) => {
            const endpoint = new MobileInteractionDeliveryEndpoint(
                'root',
                connection,
                new AbortController().signal,
                { authorizeInteractionAnswer() {} },
                {
                    async sendFailed(send) {
                        await send();
                    },
                    async invalidateLoadedSession() {},
                    failConnection() {}
                },
                () => undefined
            );
            endpoints.push(endpoint);
            const unregister = channel.registerEndpoint(endpoint);
            return () => {
                unregister();
                endpoint.dispose();
            };
        };
        const settle = async (): Promise<void> => {
            for (let round = 0; round < 3; round += 1) {
                for (let index = 0; index < 8; index += 1) await Promise.resolve();
                await new Promise((resolve) => setImmediate(resolve));
                // Persistent grants defer the queue by one macrotask so rules persist first.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        };
        return {
            channel,
            wire,
            closed,
            attach,
            settle,
            releaseTerminal: () => releaseTerminal(),
            dispose: () => endpoints.forEach((endpoint) => endpoint.dispose())
        };
    }

    const info = { taskId: 'root', sourceTaskId: 'child' };

    test('a request arriving while the previous one is still closing is delivered, not dropped', async () => {
        const harness = mobileHarness({ holdTerminal: true });
        harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            harness.wire[0].answer('allow-once');
            await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            await harness.settle();
            // The close notification is still in flight, so the remote exit is still occupied.
            expect(harness.closed).toHaveLength(1);

            // A brand new request must not activate into that window and lose its delivery.
            const second = provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            harness.releaseTerminal();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].requestId).not.toBe(harness.wire[0].requestId);
            harness.wire[1].answer('reject-once');
            await expect(second).resolves.toEqual({
                decision: 'deny',
                rememberScope: 'none',
                denyReason: 'user_denied'
            });
            expect(permissionRequests()).toHaveLength(2);
        } finally {
            harness.releaseTerminal();
            provider.dispose();
            harness.dispose();
        }
    });

    test('losing the endpoint during the closing window still lets the queue advance locally', async () => {
        const harness = mobileHarness({ holdTerminal: true });
        const detach = harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            await harness.settle();
            harness.wire[0].answer('allow-once');
            await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            await harness.settle();

            const second = provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            // The phone goes away while the close notification can no longer complete.
            detach();
            await harness.settle();
            // The queue must not stay held: the second item becomes current on the PC.
            expect(permissionRequests()).toHaveLength(2);
            respond(permissionRequests()[1].requestId, { decision: 'allow', rememberScope: 'none' });
            await expect(second).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        } finally {
            harness.releaseTerminal();
            provider.dispose();
            harness.dispose();
        }
    });

    test.each([
        ['allow-once', { decision: 'allow', rememberScope: 'none' }],
        ['reject-once', { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }],
        ['allow-type', { decision: 'allow', rememberScope: 'type' }]
    ] as const)('answering the first request on the phone delivers the next one (%s)', async (optionId, expected) => {
        const harness = mobileHarness();
        harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            const second = provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            harness.wire[0].answer(optionId);
            await expect(first).resolves.toEqual(expected);
            await harness.settle();

            // The first request must be closed on the phone before the second one is offered.
            expect(harness.closed).toEqual([{ requestId: harness.wire[0].requestId, status: 'accepted' }]);
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].requestId).not.toBe(harness.wire[0].requestId);

            harness.wire[1].answer('reject-once');
            await expect(second).resolves.toEqual({
                decision: 'deny',
                rememberScope: 'none',
                denyReason: 'user_denied'
            });
            await harness.settle();
            expect(harness.closed).toHaveLength(2);
            // Each request settles exactly once on each side.
            expect(permissionRequests()).toHaveLength(2);
        } finally {
            provider.dispose();
            harness.dispose();
        }
    });

    test('a local answer keeps delivering the next request and the phone queue stays untouched', async () => {
        const harness = mobileHarness();
        harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            const second = provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
            await harness.settle();
            respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
            await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            await harness.settle();
            expect(harness.closed[0]).toEqual({ requestId: harness.wire[0].requestId, status: 'superseded' });
            expect(harness.wire).toHaveLength(2);
            harness.wire[1].cancel();
            await expect(second).resolves.toEqual({
                decision: 'deny',
                rememberScope: 'none',
                denyReason: 'user_denied'
            });
        } finally {
            provider.dispose();
            harness.dispose();
        }
    });

    test('a pure PC queue without any delivery channel is unchanged', async () => {
        const provider = createProvider();
        try {
            const first = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            provider.prompt([writeRequest('/tmp/second.txt')], 'writeFile', [], info);
            respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
            await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            expect(permissionRequests()).toHaveLength(2);
        } finally {
            provider.dispose();
        }
    });

    test('a newly ready endpoint re-offers the unanswered request once and answers settle the original', async () => {
        const harness = mobileHarness();
        const detach = harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const pending = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
            const original = harness.wire[0];

            // The phone went to background: the old binding is gone but PC keeps waiting.
            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            // The same request identity, options and deadline are re-offered, never a new request.
            expect(harness.wire[1].requestId).toBe(original.requestId);
            expect(harness.wire[1].optionIds).toEqual(original.optionIds);

            // Repeated readiness on the same endpoint must not deliver again.
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);

            // A late answer through the replaced endpoint stays ineffective.
            original.answer('allow-once');
            await harness.settle();
            harness.wire[1].answer('reject-once');
            await expect(pending).resolves.toEqual({
                decision: 'deny',
                rememberScope: 'none',
                denyReason: 'user_denied'
            });
        } finally {
            provider.dispose();
            harness.dispose();
        }
    });

    test('a settled request is never revived and readiness without a pending request delivers nothing', async () => {
        const harness = mobileHarness();
        const detach = harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const pending = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            await harness.settle();
            // PC answered while the phone was away.
            respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
            await expect(pending).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });

            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
        } finally {
            provider.dispose();
            harness.dispose();
        }
    });

    test('readiness is only subscribed while a request is current, not per Provider instance', async () => {
        const harness = mobileHarness();
        harness.attach();
        // Providers are created per Task and dispose() has no production caller, so a constructor-long
        // subscription would retain one closure per Task.
        const idle = Array.from({ length: 5 }, () => createProvider(harness.channel));
        let reached = 0;
        harness.channel.subscribeEndpointReady(() => {
            reached += 1;
        });
        harness.channel.notifyEndpointReady();
        expect(reached).toBe(1);
        try {
            const pending = idle[0].prompt([readRequest('/tmp/first.txt')], 'readFile', [], info);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
            harness.wire[0].answer('allow-once');
            await expect(pending).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            await harness.settle();
            // The settled request released its subscription, so readiness delivers nothing more.
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
        } finally {
            idle.forEach((provider) => provider.dispose());
            harness.dispose();
        }
    });

    test('readiness does not reach a request whose Session scope does not match the endpoint', async () => {
        const harness = mobileHarness();
        harness.attach();
        const provider = createProvider(harness.channel);
        try {
            const pending = provider.prompt([readRequest('/tmp/first.txt')], 'readFile', [], {
                taskId: 'root',
                sourceTaskId: 'other'
            });
            await harness.settle();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(0);
            respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
            await expect(pending).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        } finally {
            provider.dispose();
            harness.dispose();
        }
    });
});
