import { AssistantMessage, ChatContext, TextMessagePart } from '../../../main/aikernel/messages.js';
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk
} from '../../../main/aikernel/states/tasks.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import { jest } from '@jest/globals';

class ElectronTestPlatform extends AbstractPlatform {
    getName(): string {
        return 'electron';
    }
    getEffectiveWorkspace(): string {
        return process.cwd();
    }
    async initPlatformHarness(_task: TaskState): Promise<void> {}
    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

class PlainSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }
    send(chunkUpdate: TaskUpdateChunk): void {
        this.chunks.push(chunkUpdate);
    }
}

class DeltaSubscriber extends PlainSubscriber {
    override supportsReplaceDelta = true;
}

function createTaskWithAssistant(parts: TextMessagePart[]): TaskState {
    const task = new TaskState(new TaskManagerState());
    task.task_status = 'stopped';
    task.chat_context = new ChatContext();
    const assistant = new AssistantMessage();
    assistant.content.push(...parts);
    task.chat_context.appendMessage(assistant);
    return task;
}

function textParts(count: number, marker = 'v1'): TextMessagePart[] {
    return Array.from({ length: count }, (_, i) => new TextMessagePart(`part-${i}-${marker}`));
}

describe('incremental assistant_replace', () => {
    beforeEach(() => {
        setPlatform(new ElectronTestPlatform());
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('first replace to a delta subscriber is always a full snapshot', async () => {
        const task = createTaskWithAssistant(textParts(12));
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new DeltaSubscriber(chunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);

        expect(chunks).toHaveLength(1);
        const chunk = chunks[0] as any;
        expect(chunk.type).toBe('assistant_replace');
        expect(chunk.parts).toHaveLength(12);
        expect(chunk.unmodifiedTail).toBeUndefined();
    });

    test('growing message sends unmodifiedTail instead of all parts', async () => {
        const task = createTaskWithAssistant(textParts(12));
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new DeltaSubscriber(chunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);

        // 模拟下一轮 completion：前 12 个 part 不变，追加 8 个新 part（达到增量阈值）
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        assistant.content.push(...textParts(8, 'v2').map((p) => new TextMessagePart(p.text)));

        await task.sendAssistantMessageReplace(assistant);

        expect(chunks).toHaveLength(2);
        const delta = chunks[1] as any;
        expect(delta.type).toBe('assistant_replace');
        // 只携带尾部 8 个新 parts
        expect(delta.parts).toHaveLength(8);
        expect(delta.parts[0].text).toBe('part-0-v2');
        // unmodifiedTail 告知消费方前缀长度为 12
        expect(delta.unmodifiedTail).toBe(12);
    });

    test('shrink or equal-length replace falls back to a full snapshot', async () => {
        const task = createTaskWithAssistant(textParts(12));
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new DeltaSubscriber(chunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        // 回滚收缩：rollbackToRoundStart 等场景
        assistant.content.length = 8;
        await task.sendAssistantMessageReplace(assistant);
        expect((chunks[1] as any).parts).toHaveLength(8);
        expect((chunks[1] as any).unmodifiedTail).toBeUndefined();

        // 等长替换（内容可能已变，如 tool result 更新）必须全量
        await task.sendAssistantMessageReplace(assistant);
        expect((chunks[2] as any).parts).toHaveLength(8);
        expect((chunks[2] as any).unmodifiedTail).toBeUndefined();
    });

    test('small appends below the threshold send full snapshots', async () => {
        const task = createTaskWithAssistant(textParts(4));
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new DeltaSubscriber(chunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);
        expect((chunks[0] as any).parts).toHaveLength(4);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        assistant.content.push(new TextMessagePart('tiny tail'));
        await task.sendAssistantMessageReplace(assistant);

        // 4 → 5 增量收益太小（< 8 parts 阈值），保持全量语义
        expect((chunks[1] as any).parts).toHaveLength(5);
        expect((chunks[1] as any).unmodifiedTail).toBeUndefined();
    });

    test('plain subscribers always receive full snapshots', async () => {
        const task = createTaskWithAssistant(textParts(12));
        const chunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new PlainSubscriber(chunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        assistant.content.push(new TextMessagePart('extra'));
        await task.sendAssistantMessageReplace(assistant);

        expect(chunks).toHaveLength(2);
        expect((chunks[1] as any).parts).toHaveLength(13);
        expect((chunks[1] as any).unmodifiedTail).toBeUndefined();
    });

    test('delta tracking is per-subscriber and independent', async () => {
        const task = createTaskWithAssistant(textParts(12));
        const plainChunks: TaskUpdateChunk[] = [];
        const deltaChunks: TaskUpdateChunk[] = [];
        task.addSubscriber(new PlainSubscriber(plainChunks));
        task.addSubscriber(new DeltaSubscriber(deltaChunks));

        await task.sendAssistantMessageReplace(task.chat_context.lastMessage() as AssistantMessage);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        assistant.content.push(...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((m) => new TextMessagePart(m)));
        await task.sendAssistantMessageReplace(assistant);

        // 全量订阅方始终 20 个 parts
        expect((plainChunks[1] as any).parts).toHaveLength(20);
        // 增量订阅方只收尾部 8 个
        expect((deltaChunks[1] as any).parts).toHaveLength(8);
        expect((deltaChunks[1] as any).unmodifiedTail).toBe(12);
    });
});
