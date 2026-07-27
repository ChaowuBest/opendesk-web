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
 * 流式响应空闲超时（毫秒）。当模型 API 超过此时间未输出任何 token 时，
 * 抛出超时错误，进入正常的错误处理和重试流程。
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * 当流式响应在指定时间内未收到任何数据时抛出此错误。
 * 该错误会被 adapter 的 try-catch 捕获并转换为 AssistantResponse.richError，
 * 随后由任务级重试逻辑处理。
 */
export class StreamIdleTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`Stream idle timeout: no data received for ${timeoutMs}ms`);
        this.name = 'StreamIdleTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/**
 * 用空闲超时包装 async iterable。每次 yield 值后重置计时器；
 * 若在 timeoutMs 内未收到下一个值则抛出 StreamIdleTimeoutError。
 *
 * 超时、底层异常或调用方提前结束消费时，以 fire-and-forget 方式调用
 * iterator.return() 并触发可选的 cancel 回调，尝试清理底层资源。
 */
export async function* withStreamIdleTimeout<T>(
    iterable: AsyncIterable<T>,
    timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
    cancel?: () => void
): AsyncIterable<T> {
    const iterator = iterable[Symbol.asyncIterator]();
    let sourceFinished = false;
    let cleanupStarted = false;

    const closeIterator = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        try {
            cancel?.();
        } catch {
            // cancel() 失败时仍继续尝试关闭迭代器。
        }
        try {
            const result = iterator.return?.();
            if (result) {
                void Promise.resolve(result).catch(() => {});
            }
        } catch {
            // 清理失败不应覆盖原始流错误或调用方的提前退出。
        }
    };

    try {
        while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
            });

            let result: IteratorResult<T>;
            try {
                result = await Promise.race([iterator.next(), timeoutPromise]);
            } finally {
                if (timer) clearTimeout(timer);
            }

            if (result.done) {
                sourceFinished = true;
                return;
            }
            yield result.value;
        }
    } finally {
        if (!sourceFinished) {
            // 超时、底层异常或调用方提前结束消费时都尝试释放底层资源。
            closeIterator();
        }
    }
}

/**
 * 用空闲超时包装 ReadableStreamDefaultReader.read()。
 * 超时时主动调用 reader.cancel() 解除阻塞的 read()，然后抛出 StreamIdleTimeoutError。
 */
export async function readWithIdleTimeout<T>(
    reader: ReadableStreamDefaultReader<T>,
    timeoutMs: number = STREAM_IDLE_TIMEOUT_MS
): Promise<ReadableStreamReadResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
        return await Promise.race([reader.read(), timeoutPromise]);
    } catch (err) {
        // 读取异常或超时后取消 reader，解除可能阻塞的 read()。
        try {
            void Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
            // cancel() 失败不应覆盖原始读取错误。
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
