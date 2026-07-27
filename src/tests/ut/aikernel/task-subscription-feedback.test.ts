import { jest } from '@jest/globals';
import { AssistantMessage, ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk
} from '../../../main/aikernel/states/tasks.js';
import { logger } from '../../../main/utils/logger.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

class TestPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

class CollectingSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk): void {
        this.chunks.push(chunkUpdate);
    }
}

class ThrowingSendSubscriber extends BaseTaskUpdateSubscriber {
    send(_chunkUpdate: TaskUpdateChunk): void {
        throw new Error('send exploded');
    }
}

class ThrowingAvailabilitySubscriber extends BaseTaskUpdateSubscriber {
    isAvailable(): boolean {
        throw new Error('availability exploded');
    }
}

function createTaskWithUserMessage(): TaskState {
    const task = new TaskState(new TaskManagerState());
    task.task_status = 'running';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('hello'));
    return task;
}

describe('task subscription feedback', () => {
    beforeEach(() => {
        setPlatform(new TestPlatform());
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('skips user chunks with an out-of-bounds part index', async () => {
        const task = createTaskWithUserMessage();
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new CollectingSubscriber(chunks));

        await task.sendSubscriptionFeedback(1);

        expect(chunks).toHaveLength(0);

        await task.sendSubscriptionFeedback(0);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].type).toBe('user');
    });

    test('catches async waitUntilFinished callback failures', async () => {
        const task = createTaskWithUserMessage();
        const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
        const wait = task.waitUntilFinished(async () => {
            throw new Error('subscriber exploded');
        });

        task.task_status = 'stopped';
        await task.sendSubscriptionFeedback(0);
        await wait;
        await Promise.resolve();

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('task update subscriber callback failed: subscriber exploded')
        );
    });

    test('does not finish a subscription for non-terminal goal evaluation updates', async () => {
        const task = createTaskWithUserMessage();
        let finished = false;
        const wait = task.waitUntilFinished().then(() => {
            finished = true;
        });

        task.publishTaskUpdate(
            {
                type: 'goal_eval',
                task_id: task.task_id,
                phase: 'start'
            } as TaskUpdateChunk,
            'legacy goal evaluation test'
        );
        await Promise.resolve();

        expect(finished).toBe(false);

        task.publishTaskUpdate(
            {
                type: 'goal_eval',
                task_id: task.task_id,
                task_status: 'running',
                phase: 'end',
                status: 'met'
            },
            'goal evaluation test'
        );
        await Promise.resolve();

        expect(finished).toBe(false);

        task.publishTaskUpdate(
            {
                type: 'goal_eval',
                task_id: task.task_id,
                task_status: 'waiting',
                phase: 'start'
            },
            'waiting goal evaluation test'
        );
        await Promise.resolve();

        expect(finished).toBe(false);

        task.task_status = 'stopped';
        await task.sendSubscriptionFeedback(0);
        await wait;

        expect(finished).toBe(true);
    });

    test('isolates subscriber send and availability failures', async () => {
        const task = createTaskWithUserMessage();
        const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new ThrowingAvailabilitySubscriber());
        task.addSubscriber(new ThrowingSendSubscriber());
        task.addSubscriber(new CollectingSubscriber(chunks));

        await task.sendSubscriptionFeedback(0);

        expect(chunks).toHaveLength(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('availability exploded'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('send exploded'));
    });

    test('marks leading assistant text as an implicit think close candidate', async () => {
        const task = new TaskState(new TaskManagerState());
        task.task_status = 'running';
        task.chat_context = new ChatContext();
        const assistant = new AssistantMessage([], { allowThinkTagParsing: true });
        assistant.appendText('maybe hidden reasoning');
        task.chat_context.appendMessage(assistant);

        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new CollectingSubscriber(chunks));

        await task.sendSubscriptionFeedback(0);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].type).toBe('assistant');
        if (chunks[0].type !== 'assistant') return;
        expect(chunks[0].provisional).toBe('implicit_think_close_candidate');
    });

    test('does not throw when retry feedback subscribers fail', async () => {
        const task = createTaskWithUserMessage();
        const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
        task.addSubscriber(new ThrowingSendSubscriber());

        await expect(
            task.sendRetryFeedback({
                attempt: 1,
                delay_ms: 1000,
                next_retry_at: Date.now() + 1000,
                error_message: 'retry',
                status: 'scheduled'
            })
        ).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('send exploded'));
    });

    test('stop() settles waitUntilFinished(resolveOnStop=true) even when processTaskTurn is still running', async () => {
        // Issue #197: /stop while a task is running leaves stale subscribers.
        // stop() skips sendSubscriptionFeedback() when _turnRunning === true,
        // so subscribers with resolveOnStop=false never settle. communicate()
        // now passes resolveOnStop=true so stop() can settle them via _stopResolvers.
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        task.task_status = 'running';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('hello'));

        let finished = false;
        const wait = task.waitUntilFinished(undefined, true).then(() => {
            finished = true;
        });

        // Simulate processTaskTurn being stuck on an await (e.g., waiting for LLM response)
        (task as any)._turnRunning = true;

        task.stop('user');
        await wait;

        expect(finished).toBe(true);
        expect(task.subscribers).toHaveLength(0);
    });

    test('stop() does NOT settle waitUntilFinished(resolveOnStop=false) when processTaskTurn is still running', async () => {
        // Verify the root cause: without resolveOnStop=true, stop() with _turnRunning=true
        // does not notify subscribers, leaving them stale.
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        task.task_status = 'running';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('hello'));

        let finished = false;
        task.waitUntilFinished(undefined, false).then(() => {
            finished = true;
        });

        (task as any)._turnRunning = true;
        task.stop('user');
        await Promise.resolve();

        // Subscriber should NOT be settled (this is the bug that resolveOnStop=true fixes)
        expect(finished).toBe(false);
        expect(task.subscribers).toHaveLength(1);

        // Cleanup: settle the subscriber to avoid hanging
        task.task_status = 'stopped';
        await task.sendSubscriptionFeedback(0);
    });

    test('settled subscriber from stop() does not receive new message chunks', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        task.task_status = 'running';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('hello'));

        const receivedChunks: TaskUpdateChunk[] = [];
        const wait = task.waitUntilFinished(async (chunk) => {
            receivedChunks.push(chunk);
        }, true);

        (task as any)._turnRunning = true;
        task.stop('user');
        await wait;

        expect(task.subscribers).toHaveLength(0);

        // Simulate user sending a new message after /stop
        const chunksBefore = receivedChunks.length;
        task.task_status = 'running';
        task.chat_context.appendMessage(new UserMessage('继续'));
        await task.sendSubscriptionFeedback(0);

        // Settled subscriber should not receive any new chunks
        expect(receivedChunks).toHaveLength(chunksBefore);
    });
});
