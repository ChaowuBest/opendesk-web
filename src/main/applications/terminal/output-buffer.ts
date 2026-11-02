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

import fs from 'fs';
import path from 'path';

export const TERMINAL_OUTPUT_MAX_CHARS = 256 * 1024;
export const TERMINAL_OUTPUT_HEAD_CHARS = 64 * 1024;
export const TERMINAL_OUTPUT_TAIL_CHARS = TERMINAL_OUTPUT_MAX_CHARS - TERMINAL_OUTPUT_HEAD_CHARS;

/**
 * 截断态 tail 的合并松弛量。
 *
 * tail 用「分片数组 + 超限合并」维护，而不是每个 chunk 都 `tail + chunk` 复制整个
 * 192KiB 尾部：子进程分片很小时（沙箱中继转发、逐行 flush）每次复制 192KiB 会把
 * 主进程内存带宽吃满。允许超出上限一个松弛量再合并，把复制摊销到每 ~64KiB 输入。
 */
const TERMINAL_OUTPUT_TAIL_COMPACT_SLACK_CHARS = 64 * 1024;

export interface BoundedOutputBufferOptions {
    /**
     * artifact 写入积压通知。
     *
     * 写入走异步流后不会阻塞主进程，但磁盘跟不上时数据会在流缓冲里堆积
     * （命令输出总量无上限）。回调为 true 时调用方应暂停子进程 stdout/stderr，
     * 为 false 时恢复，把背压传回子进程而不是让内存无限增长。
     */
    onBackpressure?: (paused: boolean) => void;
}

function takeHead(text: string, maxChars: number): string {
    const result = text.slice(0, maxChars);
    return result.length > 0 && /[\uD800-\uDBFF]/.test(result[result.length - 1]) ? result.slice(0, -1) : result;
}

function takeTail(text: string, maxChars: number): string {
    const result = text.slice(-maxChars);
    return result.length > 0 && /[\uDC00-\uDFFF]/.test(result[0]) ? result.slice(1) : result;
}

/**
 * Keeps terminal output bounded while preserving the beginning and end of a command's output.
 * Streams are still consumed after the limit is reached, so a noisy child process cannot block
 * on a full pipe merely because its output is no longer retained in memory.
 *
 * 截断后完整输出会额外落盘为 artifact。写入走异步流（而非 fs.writeSync）：
 * 海量输出时同步写会把主进程事件循环切碎（窗口消息、IPC、权限弹窗全部排队），
 * 而磁盘跟不上时通过 onBackpressure 把背压传回子进程。
 */
export class BoundedOutputBuffer {
    private head = '';
    /** 未截断时保存全部输出；截断后只保存 tail 的分片。 */
    private segments: string[] = [];
    private segmentsChars = 0;
    private totalBytes = 0;
    private truncated = false;
    private readonly truncationMessage: string;
    private readonly artifactPath?: string;
    private readonly artifactMessage: string;
    private readonly options: BoundedOutputBufferOptions;
    private artifactStream?: fs.WriteStream;
    private artifactClosePromise?: Promise<void>;
    private artifactClosed = false;
    private artifactWriteFailed = false;
    private artifactBackpressured = false;

    constructor(
        initialOutput = '',
        truncationMessage = 'Output too large; display truncated',
        artifactPath?: string,
        artifactMessage = 'Complete output saved to',
        options: BoundedOutputBufferOptions = {}
    ) {
        this.truncationMessage = truncationMessage;
        this.artifactPath = artifactPath;
        this.artifactMessage = artifactMessage;
        this.options = options;
        this.append(initialOutput);
    }

    append(chunk: string): void {
        if (!chunk) return;

        this.totalBytes += Buffer.byteLength(chunk, 'utf8');
        if (!this.truncated) {
            this.segments.push(chunk);
            this.segmentsChars += chunk.length;
            if (this.segmentsChars <= TERMINAL_OUTPUT_MAX_CHARS) return;

            // 首次越过上限：一次性 join（每个缓冲区只发生一次），切出 head + tail
            const combined = this.segments.join('');
            this.head = takeHead(combined, TERMINAL_OUTPUT_HEAD_CHARS);
            const tail = takeTail(combined, TERMINAL_OUTPUT_TAIL_CHARS);
            this.segments = [tail];
            this.segmentsChars = tail.length;
            this.truncated = true;
            this.writeArtifact(combined);
            return;
        }

        this.writeArtifact(chunk);
        this.segments.push(chunk);
        this.segmentsChars += chunk.length;
        this.compactTailIfNeeded();
    }

    getText(): string {
        if (!this.truncated) return this.segments.join('');

        const artifactNotice =
            this.artifactPath && !this.artifactWriteFailed ? `\n${this.artifactMessage}: ${this.artifactPath}` : '';
        const marker = `\n\n--- ${this.truncationMessage}${artifactNotice} ---\n\n`;
        return this.head + marker + this.getTailText();
    }

    /** 合并 tail 分片，返回不超过 tail 上限的尾部文本。 */
    private getTailText(): string {
        if (this.segments.length === 0) return '';
        if (this.segments.length === 1) {
            const only = this.segments[0];
            if (only.length <= TERMINAL_OUTPUT_TAIL_CHARS) return only;
            const tail = takeTail(only, TERMINAL_OUTPUT_TAIL_CHARS);
            this.segments = [tail];
            this.segmentsChars = tail.length;
            return tail;
        }
        const combined = this.segments.join('');
        const tail =
            combined.length > TERMINAL_OUTPUT_TAIL_CHARS ? takeTail(combined, TERMINAL_OUTPUT_TAIL_CHARS) : combined;
        this.segments = [tail];
        this.segmentsChars = tail.length;
        return tail;
    }

    /**
     * 把 tail 分片裁剪到上限附近。
     *
     * 分段维护的目的就是避免每个 chunk 都复制整个尾部；这里的裁剪按「从尾部向前
     * 累加整段」进行（O(保留段数)），不做超大字符串 join。单个超大分片单独按字符
     * 上限裁剪。
     */
    private compactTailIfNeeded(): void {
        if (this.segmentsChars <= TERMINAL_OUTPUT_TAIL_CHARS + TERMINAL_OUTPUT_TAIL_COMPACT_SLACK_CHARS) return;

        const last = this.segments[this.segments.length - 1];
        if (last.length >= TERMINAL_OUTPUT_TAIL_CHARS) {
            const tail = takeTail(last, TERMINAL_OUTPUT_TAIL_CHARS);
            this.segments = [tail];
            this.segmentsChars = tail.length;
            return;
        }

        let keepChars = 0;
        let start = this.segments.length;
        while (start > 0) {
            const length = this.segments[start - 1].length;
            if (keepChars + length > TERMINAL_OUTPUT_TAIL_CHARS) break;
            keepChars += length;
            start -= 1;
        }
        if (start > 0) {
            this.segments = this.segments.slice(start);
            this.segmentsChars = keepChars;
        }
    }

    /**
     * 结束 artifact 写入并等待落盘完成。异步：调用方可用 void 忽略。
     *
     * 幂等：重复调用返回同一个 Promise，便于「业务侧不等待 + 测试/收尾侧等待」
     * 共享同一次关闭过程，不会出现「第二次调用发现 stream 已置空 → 立即 resolve
     * 但数据还没写完」的竞态。
     */
    closeArtifact(): Promise<void> {
        if (this.artifactClosePromise) return this.artifactClosePromise;
        this.artifactClosed = true;
        const stream = this.artifactStream;
        this.artifactStream = undefined;
        this.artifactClosePromise = (async () => {
            if (!stream) {
                this.releaseArtifactBackpressure();
                return;
            }
            await new Promise<void>((resolve) => {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                stream.once('close', done);
                stream.once('error', done);
                try {
                    stream.end();
                } catch {
                    done();
                }
            });
            this.releaseArtifactBackpressure();
        })();
        return this.artifactClosePromise;
    }

    getTotalBytes(): number {
        return this.totalBytes;
    }

    isTruncated(): boolean {
        return this.truncated;
    }

    /**
     * 快照文本的近似字符数（O(1)），供推送节流做「大快照降频」分层。
     *
     * 不用 getText().length：那会在每次节流判断前 join 出整份文本，正好抵消
     * 「先过节流再取快照」的收益。截断态按 head + tail 上限估算即可。
     */
    getSnapshotLength(): number {
        return this.truncated ? this.head.length + TERMINAL_OUTPUT_TAIL_CHARS : this.segmentsChars;
    }

    private writeArtifact(text: string): void {
        if (!this.artifactPath || !text || this.artifactWriteFailed || this.artifactClosed) return;
        try {
            if (this.artifactStream === undefined) {
                fs.mkdirSync(path.dirname(this.artifactPath), { recursive: true });
                const stream = fs.createWriteStream(this.artifactPath);
                stream.on('error', () => {
                    this.artifactWriteFailed = true;
                    this.releaseArtifactBackpressure();
                });
                stream.on('drain', () => this.releaseArtifactBackpressure());
                stream.on('close', () => this.releaseArtifactBackpressure());
                this.artifactStream = stream;
            }
            if (!this.artifactStream.write(text)) {
                this.setArtifactBackpressure(true);
            }
        } catch {
            this.artifactWriteFailed = true;
            this.releaseArtifactBackpressure();
        }
    }

    private setArtifactBackpressure(paused: boolean): void {
        if (this.artifactBackpressured === paused) return;
        this.artifactBackpressured = paused;
        try {
            this.options.onBackpressure?.(paused);
        } catch {
            /* 背压回调是尽力而为，不能反过来影响输出采集 */
        }
    }

    private releaseArtifactBackpressure(): void {
        this.setArtifactBackpressure(false);
    }
}
