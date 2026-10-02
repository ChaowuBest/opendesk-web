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

export class FlowSerialQueue {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(flowId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(flowId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => current);
        this.tails.set(flowId, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.tails.get(flowId) === tail) this.tails.delete(flowId);
        }
    }
}
