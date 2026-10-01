/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

interface DeferrableProgress {
    type?: string;
    task_status?: string;
    message_id?: string;
    last_part_index?: number;
    last_part?: { type?: string };
}

/**
 * reload 期间到达的任务更新积压队列。
 *
 * 任务 reload（打开视图/切回后台任务）是异步全量刷新，期间持续到达的流式更新会被
 * 缓存后重放。快照携带全量累积文本，长会话 + 高频流式下不设限的队列会积累数百 MB。
 *
 * 策略：同一条 (message_id, part_index) 的流式文本/思考快照在队列中只保留最新一条
 * （原地替换，保持与其他事件的重放顺序）。全量快照具有幂等性，旧快照被新快照完全
 * 覆盖，丢弃不会丢失信息；控制类事件（replace/retry/goal 等）不参与去重，顺序不変。
 */
export class DeferredTaskUpdateQueue<T extends DeferrableProgress> {
    private items: T[] = [];
    private keyToIndex = new Map<string, number>();

    push(progress: T): void {
        const key = streamingSnapshotKey(progress);
        if (key !== undefined) {
            const existingIndex = this.keyToIndex.get(key);
            if (existingIndex !== undefined && existingIndex < this.items.length) {
                this.items[existingIndex] = progress;
                return;
            }
            this.keyToIndex.set(key, this.items.length);
        }
        this.items.push(progress);
    }

    /** 取出全部积压更新并清空队列。 */
    drain(): T[] {
        const drained = this.items;
        this.items = [];
        this.keyToIndex.clear();
        return drained;
    }

    clear(): void {
        this.items = [];
        this.keyToIndex.clear();
    }

    get length(): number {
        return this.items.length;
    }
}

/**
 * 流式文本/思考快照可按 key 去重：任务运行中、仅更新 text/reasoning part 时成立。
 * 最终内容（streaming 结束、状态切换）不满足 running 条件，不会被去重丢弃。
 */
function streamingSnapshotKey(progress: DeferrableProgress): string | undefined {
    if (
        progress.type !== 'assistant' ||
        progress.task_status !== 'running' ||
        typeof progress.message_id !== 'string' ||
        typeof progress.last_part_index !== 'number' ||
        (progress.last_part?.type !== 'text' && progress.last_part?.type !== 'reasoning')
    ) {
        return undefined;
    }
    return `${progress.message_id}:${progress.last_part_index}`;
}
