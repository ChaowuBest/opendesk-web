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

interface AssistantProgress {
    type?: string;
    task_id?: string;
    task_status?: string;
    message_id?: string;
    last_part_index?: number;
    provisional?: unknown;
    last_part?: { type?: string; rendered?: string };
}

/**
 * Coalesce complete text snapshots within a fixed 50ms window (not a debounce).
 * Keep only one pending snapshot. Part changes and non-text updates flush it
 * synchronously, preserving ordering and final content without buffering tools.
 */
export class AssistantProgressBuffer<T extends AssistantProgress> {
    private pending: { key: string; progress: T } | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly render: (progress: T) => void) {}

    push(progress: T): void {
        const key = this.textKey(progress);
        if (key === undefined) {
            this.flush();
            this.render(progress);
            return;
        }
        if (this.pending && this.pending.key !== key) this.flush();
        this.pending = { key, progress };
        if (this.timer === undefined) {
            this.timer = setTimeout(() => this.flush(), 50);
        }
    }

    flush(): void {
        const pending = this.pending;
        this.clear();
        if (pending) this.render(pending.progress);
    }

    clear(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending = undefined;
    }

    private textKey(progress: T): string | undefined {
        if (
            progress.type !== 'assistant' ||
            progress.task_status !== 'running' ||
            progress.provisional ||
            progress.last_part?.type !== 'text' ||
            typeof progress.last_part.rendered !== 'string' ||
            typeof progress.task_id !== 'string' ||
            typeof progress.message_id !== 'string' ||
            typeof progress.last_part_index !== 'number' ||
            !Number.isInteger(progress.last_part_index) ||
            progress.last_part_index < 0
        )
            return undefined;
        return JSON.stringify([progress.task_id, progress.message_id, progress.last_part_index]);
    }
}
