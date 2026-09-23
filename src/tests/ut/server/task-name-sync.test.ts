import { jest } from '@jest/globals';
import {
    disposeTaskNameSyncSubscriber,
    registerTaskNameSyncSubscriber
} from '../../../main/server/opencode/routes/session.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { EventBus } from '../../../main/server/opencode/event-bus.js';

jest.mock('../../../main/server/opencode/mcp.js', () => ({
    ensureMcpWorkspace: jest.fn(async () => undefined)
}));

const workspace = '/tmp/opendesk-task-name-sync-test';

interface PublishedEvent {
    type: string;
    directory?: string;
    properties?: Record<string, unknown>;
}

function makeTask(taskId: string, taskName: string) {
    return {
        task_id: taskId,
        parent_id: null,
        task_name: taskName,
        task_status: 'waiting',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        started_at: undefined,
        finished_at: undefined,
        updated_at: undefined,
        workspace,
        workspaceID: undefined,
        chat_context: {
            system_prompt: { content: 'system' },
            messages: []
        }
    };
}

function mockGlobalTaskManager() {
    const taskManagerState = {
        tasks: [] as unknown[],
        addSubscriber: jest.fn(() => 'sub-name-sync'),
        removeSubscriber: jest.fn(),
        getTask: jest.fn()
    };
    jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState } as any);
    return taskManagerState;
}

describe('TaskNameSyncSubscriber', () => {
    const events: PublishedEvent[] = [];
    let taskManagerState: ReturnType<typeof mockGlobalTaskManager>;
    let subscriber: { send: (taskList: object[]) => void };

    beforeEach(() => {
        events.length = 0;
        taskManagerState = mockGlobalTaskManager();
        registerTaskNameSyncSubscriber();
        subscriber = taskManagerState.addSubscriber.mock.calls[0][0] as {
            send: (taskList: object[]) => void;
        };
        jest.spyOn(EventBus, 'publish').mockImplementation((event: PublishedEvent) => {
            events.push(event);
        });
    });

    afterEach(() => {
        disposeTaskNameSyncSubscriber();
        jest.restoreAllMocks();
    });

    test('首次观察到的任务只记录基线，不发布 session.updated', () => {
        subscriber.send([{ task_id: 'task_name', task_name: '未命名任务' }]);

        expect(events).toHaveLength(0);
    });

    test('名称变化时发布携带新 title 的 session.updated', () => {
        taskManagerState.getTask.mockImplementation((taskId: string) =>
            taskId === 'task_name' ? makeTask(taskId, '修复登录bug') : undefined
        );

        subscriber.send([{ task_id: 'task_name', task_name: '未命名任务' }]);
        subscriber.send([{ task_id: 'task_name', task_name: '修复登录bug' }]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: 'session.updated',
            directory: workspace,
            properties: {
                sessionID: 'ses_name',
                info: expect.objectContaining({ id: 'ses_name', title: '修复登录bug' })
            }
        });
    });

    test('名称未变化时不发布事件', () => {
        subscriber.send([{ task_id: 'task_name', task_name: '修复登录bug' }]);
        subscriber.send([{ task_id: 'task_name', task_name: '修复登录bug' }]);

        expect(events).toHaveLength(0);
    });

    test('任务删除后重新出现按 baseline 处理，不误报名称变化', () => {
        subscriber.send([{ task_id: 'task_name', task_name: '修复登录bug' }]);
        subscriber.send([]);
        subscriber.send([{ task_id: 'task_name', task_name: '修复登录bug' }]);

        expect(events).toHaveLength(0);
    });

    test('注册幂等，dispose 后移除订阅', () => {
        registerTaskNameSyncSubscriber();
        expect(taskManagerState.addSubscriber).toHaveBeenCalledTimes(1);

        disposeTaskNameSyncSubscriber();
        expect(taskManagerState.removeSubscriber).toHaveBeenCalledWith('sub-name-sync');

        disposeTaskNameSyncSubscriber();
        expect(taskManagerState.removeSubscriber).toHaveBeenCalledTimes(1);
    });
});
