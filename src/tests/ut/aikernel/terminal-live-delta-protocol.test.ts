import { jest } from '@jest/globals';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { BaseTaskUpdateSubscriber, TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { serializeTaskUpdateForRender } from '../../../main/aikernel/task/update-render.js';
import type { TaskUpdateChunk } from '../../../main/aikernel/task/types.js';

/**
 * 终端 live 增量的送达协议。
 *
 * 契约：ToolCall 上的 outputDelta 表示「尚未送达渲染端的增量」。
 * - 推送合并器会跳过中间帧，因此多帧增量必须累积而不是覆盖，否则被跳过那帧
 *   的文本不会再出现在任何快照里，渲染端「只追加」会永久缺一段；
 * - 增量随快照发布一次后必须清空，否则后续快照会重复携带同一段文本，
 *   渲染端就会把同一段输出追加两次。
 */
function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    return task;
}

class RecordingSubscriber extends BaseTaskUpdateSubscriber {
    /** 与 ElectronTaskUpdateSubscriber 一致：send 内同步把 chunk 落成渲染载荷 */
    payloads: any[] = [];
    override send(chunk: TaskUpdateChunk): void {
        this.payloads.push(serializeTaskUpdateForRender(chunk));
    }
}

function setupRunningTerminal(): { task: TaskState; call: ToolCall; subscriber: RecordingSubscriber } {
    const task = createTask();
    task.task_status = 'running';
    const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
    call.status = 'running';
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    part.rendered = '<div class="terminal-tool">card</div>';
    task.chat_context.messages.push(new AssistantMessage([part]));
    const subscriber = new RecordingSubscriber();
    task.addSubscriber(subscriber);
    return { task, call, subscriber };
}

describe('ToolCall live 增量累积', () => {
    test('多帧增量累积，不因覆盖丢失被合并的帧', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.queueOutputDelta('first\n', undefined);
        call.queueOutputDelta('second\n', undefined);

        expect(call.outputDelta).toBe('first\nsecond\n');
        expect(call.outputReset).toBeUndefined();
    });

    test('reset 帧（缓冲截断）替换累积值并保留整体重写标记', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.queueOutputDelta('head that is now gone', undefined);
        call.queueOutputDelta('full snapshot', true);
        // reset 之后继续追加：标记必须保留，渲染端才会整体重写而不是把全量当增量追加
        call.queueOutputDelta('tail\n', undefined);

        expect(call.outputDelta).toBe('full snapshottail\n');
        expect(call.outputReset).toBe(true);
    });

    test('累积超过上限时丢弃增量，并标记下一帧需整体重写', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.queueOutputDelta('a'.repeat(200 * 1024), undefined);
        expect(call.outputDelta).toHaveLength(200 * 1024);

        call.queueOutputDelta('b'.repeat(100 * 1024), undefined);
        expect(call.outputDelta).toBeUndefined();
        // 丢弃了中间段：必须让下一帧整体重写，避免渲染端 append-only 造成错位
        expect(call.outputReset).toBe(true);

        call.queueOutputDelta('tail\n', undefined);
        expect(call.outputDelta).toBe('tail\n');
        expect(call.outputReset).toBe(true);
    });
});

describe('live 增量随快照发布一次后清空', () => {
    test('同一段增量不会被两次快照重复携带', async () => {
        const { task, call, subscriber } = setupRunningTerminal();

        call.queueOutputDelta('line1\n', undefined);
        await task.sendSubscriptionFeedback();

        const firstPayload = subscriber.payloads.at(-1);
        expect(firstPayload.last_part.toolcalls[0].outputDelta).toBe('line1\n');
        // 已随快照送达 → 立即清空
        expect(call.outputDelta).toBeUndefined();
        expect(firstPayload.last_part.toolcalls[0]).not.toHaveProperty('outputReset');

        await task.sendSubscriptionFeedback();
        const secondPayload = subscriber.payloads.at(-1);
        expect(secondPayload.last_part.toolcalls[0]).not.toHaveProperty('outputDelta');

        // 新的一帧增量仍然照常送达
        call.queueOutputDelta('line2\n', undefined);
        await task.sendSubscriptionFeedback();
        const thirdPayload = subscriber.payloads.at(-1);
        expect(thirdPayload.last_part.toolcalls[0].outputDelta).toBe('line2\n');
    });

    test('没有订阅者时快照未发布，增量不会被清空（下次发布仍能送达）', async () => {
        const { task, call, subscriber } = setupRunningTerminal();
        call.queueOutputDelta('line1\n', undefined);

        task.subscribers = [];
        await task.sendSubscriptionFeedback();
        expect(call.outputDelta).toBe('line1\n');

        task.addSubscriber(subscriber);
        await task.sendSubscriptionFeedback();
        const payload = subscriber.payloads.at(-1);
        expect(payload.last_part.toolcalls[0].outputDelta).toBe('line1\n');
        expect(call.outputDelta).toBeUndefined();
    });

    test('clearOutputDelta 同时清掉增量与 reset 标记', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.queueOutputDelta('full snapshot', true);
        call.clearOutputDelta();

        expect(call.outputDelta).toBeUndefined();
        expect(call.outputReset).toBeUndefined();
    });
});

describe('端到端：跳帧合并后渲染端文本不重不漏', () => {
    /**
     * 模拟渲染端 patchToolCallCards 的增量分支：
     * 运行中且带增量的卡片才参与，reset 整体重写、否则追加纯文本。
     */
    function applyIncremental(state: Map<string, string>, payload: any): void {
        for (const tc of payload.last_part.toolcalls) {
            if (tc.status !== 'running' || typeof tc.outputDelta !== 'string' || tc.outputDelta === '') continue;
            state.set(tc.id, tc.outputReset === true ? tc.outputDelta : (state.get(tc.id) ?? '') + tc.outputDelta);
        }
    }

    test('两帧增量被合并成一帧时，渲染端拼出的文本仍等于完整输出', async () => {
        const { task, call, subscriber } = setupRunningTerminal();
        const rendered = new Map<string, string>();

        // tick1 送达后立即发布
        call.queueOutputDelta('a\n', undefined);
        await task.sendSubscriptionFeedback();
        applyIncremental(rendered, subscriber.payloads.at(-1));
        expect(rendered.get('call-live')).toBe('a\n');

        // 推送合并器跳过中间帧：tick2 未发布就被 tick3 覆盖前先累积
        call.queueOutputDelta('b\n', undefined);
        call.queueOutputDelta('c\n', undefined);
        await task.sendSubscriptionFeedback();
        applyIncremental(rendered, subscriber.payloads.at(-1));

        expect(rendered.get('call-live')).toBe('a\nb\nc\n');
    });

    test('渲染期间落下的 tick 会触发一次重渲染，保证 rendered 与增量同源', async () => {
        const { task, call, subscriber } = setupRunningTerminal();
        jest.spyOn(task, 'needsHtmlRender', 'get').mockReturnValue(true);
        const part = task.chat_context.lastMessage()!.content[0] as ToolCallMessagePart;

        let renderCalls = 0;
        const originalRender = part.render.bind(part);
        part.render = async () => {
            renderCalls += 1;
            const html = await originalRender();
            // 模拟「渲染耗时期间又落下一帧 tick」：结果文本与待送达增量都前进了
            if (renderCalls === 1) {
                call.result = 'line1\nlate\n';
                call.queueOutputDelta('late\n', undefined);
            }
            return html;
        };

        call.queueOutputDelta('line1\n', undefined);
        await task.sendSubscriptionFeedback();

        // 检测到渲染期间变化 → 再渲染一次，rendered 与随快照发出的增量终点一致
        expect(renderCalls).toBe(2);
        const payload = subscriber.payloads.at(-1);
        expect(payload.last_part.toolcalls[0].outputDelta).toBe('line1\nlate\n');
    });

    test('reset 帧后继续追加：渲染端整体重写一次后仍与完整输出一致', async () => {
        const { task, call, subscriber } = setupRunningTerminal();
        const rendered = new Map<string, string>();

        call.queueOutputDelta('前 256KiB 全部输出', true);
        await task.sendSubscriptionFeedback();
        applyIncremental(rendered, subscriber.payloads.at(-1));

        // 截断后 tail 滑动，本帧是尾部增量；它与尚未送达的 reset 帧一起被合并
        call.queueOutputDelta('tail\n', undefined);
        await task.sendSubscriptionFeedback();
        applyIncremental(rendered, subscriber.payloads.at(-1));

        expect(rendered.get('call-live')).toBe('前 256KiB 全部输出tail\n');
    });
});

describe('live 增量不进入持久化与中断态', () => {
    test('toJSON 落盘时排除一次性的增量字段', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.status = 'running';
        call.result = 'line1\n';
        call.queueOutputDelta('line1\n', true);

        const persisted = call.toJSON() as Record<string, unknown>;

        expect(persisted).not.toHaveProperty('outputDelta');
        expect(persisted).not.toHaveProperty('outputReset');
        // 其余持久化字段照旧
        expect(persisted.status).toBe('running');
        expect(persisted.result).toBe('line1\n');
    });

    test('任务中断时清掉残留增量（不会再有 live tick 来覆盖它）', () => {
        const task = createTask();
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{}');
        call.status = 'running';
        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        task.chat_context.messages.push(new AssistantMessage([part]));
        call.queueOutputDelta('pending tail', undefined);

        expect(task.markInterruptedToolCalls('任务已停止')).toBe(1);

        expect(call.status).toBe('error');
        expect(call.outputDelta).toBeUndefined();
        expect(call.outputReset).toBeUndefined();
    });
});
