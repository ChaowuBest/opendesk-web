import { jest } from '@jest/globals';
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
const { MAIN_AGENT_UNLIMITED_MODE } = await import('../../../main/aikernel/agents/main/modes/unlimited.js');
const { GlobPermissionEnforcer } = await import('../../../main/aikernel/security/enforcer');
const { HarnessContext } = await import('../../../main/aikernel/security/harness.js');
const { TaskManagerState, TaskState } = await import('../../../main/aikernel/states/tasks.js');
const { replaceTaskHarnessForMode } = await import('../../../main/aikernel/task/mode.js');
const { logger } = await import('../../../main/utils/logger.js');

const providers: InstanceType<typeof ElectronPermissionPromptProvider>[] = [];

function createProvider(): InstanceType<typeof ElectronPermissionPromptProvider> {
    const provider = new ElectronPermissionPromptProvider();
    providers.push(provider);
    return provider;
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
    browserWindows = [focusedWindow];
    jest.clearAllMocks();
});

describe('ElectronPermissionPromptProvider queue', () => {
    afterEach(() => {
        for (const provider of providers.splice(0)) {
            provider.dispose();
        }
        jest.useRealTimers();
    });

    test('logger is mocked so the import chain never activates a real file transport', () => {
        expect(jest.isMockFunction(logger.info)).toBe(true);
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
});
