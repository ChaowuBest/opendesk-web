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

/**
 * 「最新值优先」的推送合并器。
 *
 * 终端 live 输出每 200ms 触发一次 ToolResult.updateResult，其回调链是
 * fire-and-forget（safeInvokeCallback 不 await 回调返回的 Promise），于是
 * `await sendSubscriptionFeedback()` 会并发堆积：单次快照渲染 + IPC 一旦超过
 * 200ms（超长输出下很常见），排队任务只会越来越多，内存与 CPU 随之增长，
 * 最终表现为界面卡死。
 *
 * 合并语义：
 * - 同一时刻最多一个 run 在执行（消除堆积）；
 * - 执行期间到来的 push 只记一次「还有新数据」，当前这次结束后补发一次；
 * - 补发读到的是最新状态，因此不会丢最后一次更新。
 */
export class LiveFeedbackCoalescer {
    private inFlight = false;
    private queued = false;
    private idleWaiters: Array<() => void> = [];

    constructor(private readonly run: () => Promise<void>) {}

    /** 请求一次推送；正在推送时只登记待补发，不并发执行。 */
    push(): void {
        if (this.inFlight) {
            this.queued = true;
            return;
        }
        void this.drain();
    }

    /** 等待当前及待补发的推送全部完成（收尾/测试用）。 */
    idle(): Promise<void> {
        if (!this.inFlight && !this.queued) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    private async drain(): Promise<void> {
        this.inFlight = true;
        try {
            do {
                this.queued = false;
                try {
                    await this.run();
                } catch (err) {
                    // 与 ToolResult.safeInvokeCallback 一致：推送失败只记录，
                    // 不能打断工具执行或后续推送
                    console.warn(
                        `[LiveFeedbackCoalescer] push failed: ${err instanceof Error ? err.stack || err.message : String(err)}`
                    );
                }
            } while (this.queued);
        } finally {
            this.inFlight = false;
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
        }
    }
}
