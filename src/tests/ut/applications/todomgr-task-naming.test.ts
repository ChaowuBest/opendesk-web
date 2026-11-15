import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Participant } from '../../../main/aikernel/types/index.js';
import type { TodoTrigger } from '../../../main/applications/todomgr/common.js';

const mainAgent = { name: 'main' };
// 指定的工作区路径会被 resolve 成平台绝对路径（Windows 上带盘符），断言须用同一形态
const scheduledWorkspace = path.resolve('/scheduled-workspace');
const getModelInstance = jest.fn((alias: string) => {
    if (alias === 'reasoning-pro') return { model_name: 'gpt-5' };
    if (alias === 'unsupported-reasoning') return { model_name: 'gpt-5' };
    return undefined;
});
const getDefaultModelInstance = jest.fn(() => ({ model_name: 'gpt-5' }));
const registerTaskForParticipant = jest.fn();
const markSkipUserEcho = jest.fn();
const channelManager = {
    markSkipUserEcho,
    getRouter: () => ({ registerTaskForParticipant })
};
const dispatchPromptToAgent = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../../main/utils/model-network.js', () => ({ fetchModelUrl: jest.fn() }));
jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: { getInstance: () => ({ taskManagerState: { dispatchPromptToAgent } }) }
}));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => mainAgent }
}));
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({
    ApplicationRegistry: { getApplication: () => channelManager }
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getModelInstance,
            getDefaultModelInstance,
            getEffectiveWorkspace: () => '/default-workspace'
        })
    },
    getOpendeskDirectory: () => os.tmpdir()
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../../locale/index.js', () => {
    // 包装层 t 经 translateWithDomain 走统一查找链；这里按 zh-CN 内联等价实现，保持用例断言稳定
    const translateWithDomain = (
        key: string,
        domain: Record<string, Record<string, string>>,
        params?: Record<string, string | number>
    ): string => {
        let text = domain['zh-CN']?.[key] ?? key;
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), String(value));
            }
        }
        return text;
    };
    return { getLocale: () => 'zh-CN', translateWithDomain };
});
jest.unstable_mockModule('../../../main/tui/theme.js', () => ({ getAdaptiveGreen: () => '#00ff00' }));
jest.unstable_mockModule('../../../main/aikernel/tool.js', () => ({ BaseToolset: class {} }));
jest.unstable_mockModule('../../../main/aikernel/skill.js', () => ({ Skill: class {} }));
jest.unstable_mockModule('../../../main/applications/todomgr/tools.js', () => ({
    TodoWriteTool: class {},
    AddGlobalTodoTool: class {},
    UpdateGlobalTodoTool: class {},
    ListGlobalTodoDeliverTargetsTool: class {},
    ListGlobalTodosTool: class {},
    DeleteGlobalTodoTool: class {},
    GetCurrentTimeTool: class {},
    GetSupportedEventsTool: class {}
}));

let TodoMgrApplication: typeof import('../../../main/applications/todomgr/app.js').TodoMgrApplication;
let TodoMgrWorker: typeof import('../../../main/applications/todomgr/worker.js').default;

describe('TodoMgr execution conversation names', () => {
    let application: InstanceType<typeof TodoMgrApplication>;
    const createdTasks: any[] = [];
    let tempDir: string | undefined;

    beforeAll(async () => {
        ({ TodoMgrApplication } = await import('../../../main/applications/todomgr/app.js'));
        ({ default: TodoMgrWorker } = await import('../../../main/applications/todomgr/worker.js'));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        createdTasks.length = 0;
        application = new TodoMgrApplication();
        dispatchPromptToAgent.mockImplementation(async (_agent, _sourceTaskId, _prompt, options) => {
            const task = {
                task_id: `execution-${createdTasks.length + 1}`,
                task_name: options.taskName,
                origin: options.origin,
                waitUntilFinished: jest.fn(async () => {}),
                chat_context: { messages: [{ role: 'assistant', content: [{ type: 'text', text: '执行完成' }] }] }
            };
            createdTasks.push(task);
            return task;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            tempDir = undefined;
        }
    });

    test.each<{ label: string; trigger: TodoTrigger }>([
        { label: 'cron', trigger: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai' } },
        {
            label: 'scheduled',
            trigger: { type: 'scheduled', triggerAt: '2026-10-22T01:00:00.000Z', timezone: 'Asia/Shanghai' }
        },
        { label: 'event', trigger: { type: 'event', bundleName: 'test-app', eventName: 'updated' } }
    ])('$label executions use the complete plan title and retain model settings', async ({ trigger }) => {
        const title = '每日人工智能行业新闻与开源项目进展汇总（完整标题，不添加日期或序号）';

        await application.triggerTodoTask(
            'todo-1',
            title,
            '检查新闻并生成报告',
            trigger,
            undefined,
            { type: 'path', path: scheduledWorkspace },
            'reasoning-pro',
            'high'
        );

        expect(dispatchPromptToAgent).toHaveBeenCalledWith(
            mainAgent,
            undefined,
            expect.stringContaining('检查新闻并生成报告'),
            {
                taskName: title,
                workspace: scheduledWorkspace,
                origin: { type: 'automation' },
                model: 'reasoning-pro',
                reasoningEffort: 'high'
            }
        );
        expect(dispatchPromptToAgent.mock.calls[0][2]).toContain(title);
    });

    test('channel delivery retains the plan title and registers the created conversation', async () => {
        const deliver: Participant = {
            type: 'channel',
            channel: 'feishu',
            accountId: 'default',
            recipientId: 'recipient-1'
        };

        await application.triggerTodoTask('todo-1', '每日 AI 新闻', '汇总新闻', undefined, deliver);

        expect(dispatchPromptToAgent.mock.calls[0][3]).toMatchObject({
            taskName: '每日 AI 新闻',
            origin: deliver,
            workspace: '/default-workspace'
        });
        expect(markSkipUserEcho).toHaveBeenCalledWith(createdTasks[0]);
        expect(createdTasks[0].waitUntilFinished).toHaveBeenCalledTimes(1);
        expect(registerTaskForParticipant).toHaveBeenCalledWith('execution-1', deliver, '每日 AI 新闻');
    });

    test('immediate execution passes the stored plan title through the worker', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-task-naming-'));
        const worker = new TodoMgrWorker('todomgr', tempDir);
        const todo = {
            id: 'todo-manual',
            title: '手动执行也使用计划名称',
            content: '立即生成日报',
            enabled: true,
            trigger: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai' }
        };
        (worker as any).globalTodos = [todo];
        (worker as any).globalTodosPath = path.join(tempDir, 'global_todos.json');
        const executions: Promise<void>[] = [];
        jest.spyOn(worker as any, 'callApp').mockImplementation((method: string, ...args: any[]) => {
            expect(method).toBe('triggerTodoTask');
            executions.push((application.triggerTodoTask as (...args: any[]) => Promise<void>)(...args));
        });
        jest.spyOn(application, 'callWorker').mockImplementation(async (method, ...args) => {
            expect(method).toBe('triggerGlobalTodoNow');
            return worker.triggerGlobalTodoNow(args[0]);
        });

        await application.triggerGlobalTodoNowFromUI(todo.id);
        await Promise.all(executions);

        expect(dispatchPromptToAgent).toHaveBeenCalledTimes(1);
        expect(dispatchPromptToAgent.mock.calls[0][3].taskName).toBe(todo.title);
    });

    test('repeated executions always request new conversations with the same title', async () => {
        await application.triggerTodoTask('todo-repeat', '每日 AI 新闻', '汇总新闻', undefined);
        await application.triggerTodoTask('todo-repeat', '每日 AI 新闻', '汇总新闻', undefined);

        expect(dispatchPromptToAgent).toHaveBeenCalledTimes(2);
        for (const call of dispatchPromptToAgent.mock.calls) {
            expect(call[1]).toBeUndefined();
            expect(call[3].taskName).toBe('每日 AI 新闻');
        }
    });

    test('later executions receive the latest plan title without changing prior names', async () => {
        await application.triggerTodoTask('todo-renamed', '原计划名称', '检查新闻', undefined);
        await application.triggerTodoTask('todo-renamed', '新的计划名称', '检查新闻', undefined);

        expect(createdTasks.map((task) => task.task_name)).toEqual(['原计划名称', '新的计划名称']);
    });

    test.each(['', ' \t\n '])('blank legacy titles fall back to normal naming: %j', async (title) => {
        await application.triggerTodoTask('todo-blank', title, '检查新闻', undefined);

        expect(dispatchPromptToAgent).toHaveBeenCalledTimes(1);
        expect(dispatchPromptToAgent.mock.calls[0][3].taskName).toBeUndefined();
    });

    test('an unavailable model still inherits the plan title while using the default model', async () => {
        await application.triggerTodoTask(
            'todo-invalid-model',
            '日报',
            '生成报告',
            undefined,
            undefined,
            undefined,
            'removed-model',
            'high'
        );

        expect(dispatchPromptToAgent.mock.calls[0][3]).toMatchObject({
            taskName: '日报',
            model: undefined,
            reasoningEffort: undefined
        });
    });

    test('passes a reasoning override through for execution-time capability validation', async () => {
        await application.triggerTodoTask(
            'todo-unsupported-reasoning',
            '日报',
            '生成报告',
            undefined,
            undefined,
            undefined,
            'unsupported-reasoning',
            'max'
        );

        expect(dispatchPromptToAgent.mock.calls[0][3]).toMatchObject({
            model: 'unsupported-reasoning',
            reasoningEffort: 'max'
        });
    });
});
