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
        const assistant = new AssistantMessage();
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
});
