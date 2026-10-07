import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';

type IpcHandler = (_event: unknown, requestId: string, response: Record<string, unknown>) => void;

const ipcHandlers = new Map<string, Set<IpcHandler>>();
const sentMessages: Array<{ channel: string; args: unknown[] }> = [];

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
const { HarnessContext } = await import('../../../main/aikernel/security/harness.js');
const { MAIN_AGENT_STANDARD_MODE } = await import('../../../main/aikernel/agents/main/modes/standard.js');
const { MAIN_AGENT_SOLO_MODE } = await import('../../../main/aikernel/agents/main/modes/solo.js');
const { MAIN_AGENT_PLAN_MODE } = await import('../../../main/aikernel/agents/main/modes/plan.js');
const { TaskManagerState, TaskState } = await import('../../../main/aikernel/states/tasks.js');
const { replaceTaskHarnessForMode } = await import('../../../main/aikernel/task/mode.js');

const providers: InstanceType<typeof ElectronPermissionPromptProvider>[] = [];

function createProvider(): InstanceType<typeof ElectronPermissionPromptProvider> {
    const provider = new ElectronPermissionPromptProvider();
    providers.push(provider);
    return provider;
}

async function createTaskWithStandardHarness(
    taskId: string,
    workspace: string,
    provider: any
): Promise<InstanceType<typeof TaskState>> {
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = taskId;
    task.harnessContext = await HarnessContext.createForMode(workspace, MAIN_AGENT_STANDARD_MODE);
    task.harnessContext.permissionPrompt = provider;
    task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
    return task;
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
    browserWindows = [focusedWindow];
    jest.clearAllMocks();
});

describe('mode switch re-checks queued permission prompts', () => {
    afterEach(() => {
        for (const provider of providers.splice(0)) {
            provider.dispose();
        }
    });

    test('switching an Electron task to solo auto-resolves queued prompts outside the workspace', async () => {
        const provider = createProvider();
        const task = await createTaskWithStandardHarness('task-1', '/workspace', provider);

        // standard 模式下工作空间外路径为隐式 ask，两个请求依次入队
        const first = provider.prompt([readRequest('/outside-workspace/a.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });
        const second = provider.prompt([readRequest('/outside-workspace/b.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });

        // 第一个立即弹出，第二个在队列中等待
        expect(permissionRequests()).toHaveLength(1);

        await replaceTaskHarnessForMode(task, '/workspace', MAIN_AGENT_SOLO_MODE, () => provider);

        // solo 模式下两条路径都已 allow，当前弹窗和排队请求都应被自动放通
        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        await expect(second).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(task.activeModeId).toBe(MAIN_AGENT_SOLO_MODE.id);
        // 切换后不再有新的弹窗广播（原有的一条是切换前的当前弹窗）
        expect(permissionRequests()).toHaveLength(1);
        expect(
            sentMessages.some(
                (msg) => msg.channel === 'permission:dismiss' && msg.args[0] === permissionRequests()[0].requestId
            )
        ).toBe(true);
    });

    test('switching to solo auto-resolves ordinary prompts but keeps sensitive-path prompts', async () => {
        const provider = createProvider();
        const task = await createTaskWithStandardHarness('task-1', '/workspace', provider);
        const homeDir = os.homedir().replace(/\\/g, '/');

        const first = provider.prompt([readRequest('/outside-workspace/a.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });
        const second = provider.prompt([readRequest(`${homeDir}/.ssh/id_rsa`)], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });

        expect(permissionRequests()).toHaveLength(1);

        await replaceTaskHarnessForMode(task, '/workspace', MAIN_AGENT_SOLO_MODE, () => provider);

        // 工作空间外普通路径被 solo 放通；敏感路径（~/.ssh）在 solo 下为 deny，
        // 不满足"全部 allow"条件，排队请求保持等待而不是被误放通
        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(permissionRequests()).toHaveLength(2);
        expect(permissionRequests()[1].data.requests[0].resourcePath).toBe(`${homeDir}/.ssh/id_rsa`);

        provider.cancelTaskPrompts([task.task_id]);
        await expect(second).resolves.toMatchObject({ decision: 'deny', denyReason: 'task_stopped' });
    });

    test('switching to plan does not auto-resolve queued write prompts still blocked by the mode', async () => {
        const provider = createProvider();
        // plan 模式 onEnterMode 会真实创建 .plan 目录，使用临时目录避免污染工作区
        const workspace = path.join(os.tmpdir(), 'opendesk-test-plan-queue');
        const task = await createTaskWithStandardHarness('task-1', workspace, provider);

        const first = provider.prompt([readRequest('/outside-workspace/a.txt')], 'readFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });
        const second = provider.prompt([writeRequest(path.join(workspace, 'outside-plan.txt'))], 'writeFile', [], {
            taskId: task.task_id,
            taskName: 'Task 1'
        });

        expect(permissionRequests()).toHaveLength(1);

        await replaceTaskHarnessForMode(task, workspace, MAIN_AGENT_PLAN_MODE, () => provider);

        // plan 模式下该写请求仍为 ask，排队请求不应被自动放通
        expect(task.activeModeId).toBe(MAIN_AGENT_PLAN_MODE.id);
        expect(permissionRequests()).toHaveLength(1);

        respond(permissionRequests()[0].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(first).resolves.toMatchObject({ decision: 'deny' });

        provider.cancelTaskPrompts([task.task_id]);
        await expect(second).resolves.toMatchObject({ decision: 'deny', denyReason: 'task_stopped' });
    });
});
