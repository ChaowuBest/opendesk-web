import { DeferredTaskUpdateQueue } from '../../../renderer/utils/deferred-task-updates';

function streamingSnapshot(partIndex: number, textLength: number, messageId = 'm1') {
    return {
        type: 'assistant',
        task_status: 'running',
        message_id: messageId,
        last_part_index: partIndex,
        last_part: { type: 'text', text: 'x'.repeat(textLength) }
    };
}

function controlEvent(type: string) {
    return { type, task_status: 'running' };
}

describe('DeferredTaskUpdateQueue', () => {
    test('按入队顺序 drain 全部更新', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        const a = controlEvent('user');
        const b = streamingSnapshot(0, 10);
        const c = controlEvent('retry');
        queue.push(a);
        queue.push(b);
        queue.push(c);
        expect(queue.drain()).toEqual([a, b, c]);
        expect(queue.length).toBe(0);
    });

    test('同一 (message_id, part_index) 的流式快照只保留最新一条', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        queue.push(streamingSnapshot(0, 100));
        queue.push(streamingSnapshot(0, 5000));
        queue.push(streamingSnapshot(0, 90000));
        const drained = queue.drain();
        expect(drained).toHaveLength(1);
        expect((drained[0] as any).last_part.text).toHaveLength(90000);
    });

    test('不同 message_id / part_index 的快照不去重', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        queue.push(streamingSnapshot(0, 10));
        queue.push(streamingSnapshot(1, 10));
        queue.push(streamingSnapshot(0, 10, 'm2'));
        expect(queue.drain()).toHaveLength(3);
    });

    test('原地替换保持与其他事件的重放顺序', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        const first = controlEvent('user');
        queue.push(first);
        queue.push(streamingSnapshot(0, 100));
        const latestSnapshot = streamingSnapshot(0, 800);
        queue.push(latestSnapshot);
        const replace = controlEvent('assistant_replace');
        queue.push(replace);
        const drained = queue.drain();
        expect(drained).toEqual([first, latestSnapshot, replace]);
    });

    test('非流式最终快照（状态非 running）不参与去重', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        queue.push(streamingSnapshot(0, 100));
        const finalSnapshot = {
            type: 'assistant',
            task_status: 'stopped',
            message_id: 'm1',
            last_part_index: 0,
            last_part: { type: 'text', text: 'final' }
        };
        queue.push(finalSnapshot);
        const drained = queue.drain();
        expect(drained).toHaveLength(2);
        expect(drained[1]).toBe(finalSnapshot);
    });

    test('reasoning 快照同样按 key 去重', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        queue.push({
            type: 'assistant',
            task_status: 'running',
            message_id: 'm1',
            last_part_index: 0,
            last_part: { type: 'reasoning' }
        });
        queue.push({
            type: 'assistant',
            task_status: 'running',
            message_id: 'm1',
            last_part_index: 0,
            last_part: { type: 'reasoning' }
        });
        expect(queue.drain()).toHaveLength(1);
    });

    test('clear 清空队列与去重索引', () => {
        const queue = new DeferredTaskUpdateQueue<object>();
        queue.push(streamingSnapshot(0, 10));
        queue.clear();
        expect(queue.length).toBe(0);
        queue.push(streamingSnapshot(0, 20));
        expect(queue.drain()).toHaveLength(1);
    });
});
