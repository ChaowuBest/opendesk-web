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
 * 流式订阅反馈限流器。
 *
 * 流式过程中每个 LLM chunk 都会触发一次 sendSubscriptionFeedback，而快照携带的是
 * 整个已累积的 part 文本（O(n²) 线流量）。renderer 消费不及时时，这些全量快照会在
 * 渲染进程的 IPC 队列中堆积成多 GB 常驻内存（见 2026-10 主窗口 OOM 事故）。
 *
 * 策略：对同一 (message_id, part_index) 的流式文本快照按最小间隔限频；文本增量超过
 * forceGrowthChars 时立即放行，保证长输出仍有可见进度。非流式更新（part 完成、
 * 状态切换）不经过本限流器，始终即时发送，最终内容不受影响。
 */
export class StreamFeedbackThrottle {
    private entries = new Map<string, { lastSentAt: number; lastSentLength: number }>();

    constructor(
        private readonly minIntervalMs: number = StreamFeedbackThrottle.DEFAULT_MIN_INTERVAL_MS,
        private readonly forceGrowthChars: number = StreamFeedbackThrottle.DEFAULT_FORCE_GROWTH_CHARS,
        private readonly now: () => number = Date.now
    ) {}

    /** 是否允许发送该 key 的下一个流式快照。允许时记录本次发送。 */
    shouldSend(key: string, textLength: number): boolean {
        const timestamp = this.now();
        const previous = this.entries.get(key);
        if (
            previous === undefined ||
            timestamp - previous.lastSentAt >= this.minIntervalMs ||
            textLength - previous.lastSentLength >= this.forceGrowthChars
        ) {
            this.entries.set(key, { lastSentAt: timestamp, lastSentLength: textLength });
            this.prune();
            return true;
        }
        return false;
    }

    private prune(): void {
        if (this.entries.size <= StreamFeedbackThrottle.MAX_ENTRIES) return;
        const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastSentAt - b[1].lastSentAt);
        const dropCount = this.entries.size - StreamFeedbackThrottle.KEEP_ENTRIES;
        for (let i = 0; i < dropCount; i++) {
            this.entries.delete(ordered[i][0]);
        }
    }

    /**
     * 默认最小间隔 120ms（≈8Hz）：文本 part 通常仅几十 KB、单次快照渲染成本为
     * 毫秒级，8Hz 相比逐 token（20-100Hz）已将 IPC 量削减 3-12 倍，足以防止
     * 慢 renderer 的快照积压；同时与渲染侧 50ms 合并缓冲的视觉节奏（原 20Hz）
     * 接近，流式文本推进不产生可感知的步进感。大文本由 forceGrowthChars 兜底。
     */
    private static readonly DEFAULT_MIN_INTERVAL_MS = 120;
    private static readonly DEFAULT_FORCE_GROWTH_CHARS = 64 * 1024;
    private static readonly MAX_ENTRIES = 512;
    private static readonly KEEP_ENTRIES = 256;
}
