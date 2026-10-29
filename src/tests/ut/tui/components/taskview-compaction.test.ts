import { jest } from '@jest/globals';
import { ChatContext } from '../../../../main/aikernel/messages.js';
import type { PrepareContextOptions } from '../../../../main/aikernel/compaction/types.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import { Setting } from '../../../../main/utils/setting.js';

const prepareContext =
    jest.fn<(context: ChatContext, model: string | undefined, options: PrepareContextOptions) => Promise<unknown>>();
jest.unstable_mockModule('../../../../main/aikernel/compaction/pipeline.js', () => ({
    prepareContextForModel: prepareContext
}));

let TaskView: typeof import('../../../../main/tui/components/taskview.js').TaskView;

beforeAll(async () => {
    // Load after registering the ESM pipeline mock so the real TUI callback is exercised.
    ({ TaskView } = await import('../../../../main/tui/components/taskview.js'));
});

beforeEach(() => {
    Setting.clearCache();
    prepareContext.mockReset();
});

afterEach(() => {
    jest.restoreAllMocks();
    Setting.clearCache();
});

function createTask() {
    return {
        task_id: 'tui-compact-task',
        parent_id: null,
        chat_context: new ChatContext(),
        ensureValidModelOrFallback: jest.fn(() => 'local'),
        getMicrocompactState: jest.fn(),
        compactTaskContext: jest.fn<TaskState['compactTaskContext']>().mockResolvedValue({ compacted: true }),
        manualCompact: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
        markCompacted: jest.fn(),
        submitUserMessage: jest.fn<() => Promise<{ status: string }>>().mockResolvedValue({ status: 'success' }),
        waitUntilFinished: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    };
}

describe('TaskView compaction inputs', () => {
    test.each([false, true])('preparation forwards the same replacement map to execution (empty=%s)', async (empty) => {
        const overrides = new Map(
            empty ? [] : [['large-result', 'short preview\n完整输出已保存至: artifacts/result.txt']]
        );
        const task = createTask();
        const view = new TaskView({ requestRender: jest.fn() } as any);
        view.taskState = task as unknown as TaskState;
        prepareContext.mockImplementation(async (_context, _model, options) => {
            await options.executeCompact!(overrides);
            return { compacted: false };
        });

        try {
            await view.communicate('continue');

            expect(prepareContext).toHaveBeenCalledTimes(1);
            expect(task.compactTaskContext).toHaveBeenCalledWith({ trigger: 'auto', toolResultOverrides: overrides });
            const options = task.compactTaskContext.mock.calls[0]?.[0];
            expect(options?.toolResultOverrides).toBe(overrides);
            expect(task.manualCompact).not.toHaveBeenCalled();
            expect(task.markCompacted).toHaveBeenCalledTimes(1);
            expect(task.submitUserMessage).toHaveBeenCalledTimes(1);
        } finally {
            view.clearMessages();
        }
    });

    test('the manual command continues to use manual compaction', async () => {
        const task = createTask();
        const view = new TaskView({ requestRender: jest.fn() } as any);
        view.taskState = task as unknown as TaskState;

        try {
            await expect(view.performCompactWithAnimation()).resolves.toBe(true);
            expect(task.manualCompact).toHaveBeenCalledTimes(1);
            expect(task.compactTaskContext).not.toHaveBeenCalled();
        } finally {
            view.clearMessages();
        }
    });

    test('a failed automatic compact clears the animation and permits a retry', async () => {
        const task = createTask();
        const view = new TaskView({ requestRender: jest.fn() } as any);
        view.taskState = task as unknown as TaskState;
        task.compactTaskContext.mockRejectedValueOnce(new Error('summary request failed'));

        try {
            await expect(view.performCompactWithAnimation(view.taskState, 'auto')).resolves.toBe(false);
            expect(view.messages).toHaveLength(0);
            expect(view.lastCompactErrorMessage).toBe('summary request failed');
            await expect(view.performCompactWithAnimation(view.taskState, 'auto')).resolves.toBe(true);
            expect(view.lastCompactErrorMessage).toBeUndefined();
            expect(task.markCompacted).toHaveBeenCalledTimes(1);
        } finally {
            view.clearMessages();
        }
    });
});
