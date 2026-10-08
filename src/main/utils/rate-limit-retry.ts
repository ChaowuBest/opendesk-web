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

import { APIError, RateLimitError } from 'openai';
import { logger } from './logger.js';
import { getModelRequestRetryAfterMs, isNonRetryableModelRequestError } from './model-request-error.js';

/**
 * 限流错误检测器——通过可扩展的规则匹配各服务商的限流/配额错误。
 *
 * 目前支持的检测维度：
 * 1. OpenAI SDK 原生 RateLimitError（HTTP 429）
 * 2. HTTP 状态码（429 及部分服务商使用 503 表示限流）
 * 3. 错误消息文本中的关键词模式匹配
 *
 * 新增服务商的限流模式时，只需在 MESSAGE_PATTERNS 中添加新的正则即可。
 */
class RateLimitDetector {
    /**
     * 限流相关的错误消息模式（不区分大小写）。
     * 每个正则对应一种已知的服务商限流错误表述。
     */
    private static readonly MESSAGE_PATTERNS: RegExp[] = [
        /rate.?limit/i,
        /too\s+many\s+requests/i,
        /quota\s*(exceeded|limit|exhausted)/i,
        /throttl/i,
        /server\s+is\s+busy/i,
        /capacity/i,
        /overloaded/i,
        /concurrency/i,
        /request\s+limit/i,
        /token(s)?\s*(per|\/)\s*(minute|second|hour|day)/i,
        /rpm\s*(limit|exceeded)/i,
        /tpm\s*(limit|exceeded)/i,
        /please\s+(try|retry|slow)\s*(again|down)?.*later/i,
        /resource\s+exhausted/i,
        /请求(过于)?频繁/,
        /触发.*限流/,
        /限流/,
        /频率限制/
    ];

    /** 被视为限流的 HTTP 状态码集合 */
    private static readonly RATE_LIMIT_STATUS_CODES = new Set([429]);

    static isRateLimitError(err: unknown): boolean {
        if (isNonRetryableModelRequestError(err)) {
            return false;
        }

        if (err instanceof RateLimitError) {
            return true;
        }

        if (err instanceof APIError) {
            if (this.RATE_LIMIT_STATUS_CODES.has(err.status as number)) {
                return true;
            }
        }

        const message = err instanceof Error ? err.message : String(err);
        return this.MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
    }

    /**
     * 尝试从 HTTP 响应头中提取 Retry-After 秒数。
     * 支持整数秒和 HTTP-date 两种格式。
     * 找不到或解析失败时返回 undefined。
     */
    static extractRetryAfterSeconds(err: unknown): number | undefined {
        const retryAfterMs = getModelRequestRetryAfterMs(err);
        if (retryAfterMs !== undefined) {
            return retryAfterMs / 1000;
        }

        if (!(err instanceof APIError) || !err.headers) {
            return undefined;
        }

        const retryAfter = err.headers.get?.('retry-after') ?? undefined;
        if (retryAfter === undefined) {
            return undefined;
        }

        const asNumber = Number(retryAfter);
        if (!isNaN(asNumber) && asNumber > 0) {
            return asNumber;
        }

        const asDate = Date.parse(retryAfter);
        if (!isNaN(asDate)) {
            const diffMs = asDate - Date.now();
            return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
        }

        return undefined;
    }
}

interface RetryOptions {
    /** 初始等待时间（毫秒），默认 2000 */
    initialDelayMs?: number;
    /** 最大等待时间（毫秒），默认 120000（2 分钟） */
    maxDelayMs?: number;
    /** 退避倍数，默认 2 */
    backoffMultiplier?: number;
    /** 最大重试次数，undefined 表示无限重试（限流可以一直等），默认 undefined */
    maxRetries?: number;
    /** 每次重试前的回调，可用于日志或通知用户 */
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'maxRetries'>> = {
    initialDelayMs: 2000,
    maxDelayMs: 120_000,
    backoffMultiplier: 2
};

/**
 * 带指数退避 + 抖动的重试执行器。
 *
 * 限流（429）在本质上不同于网络错误或授权错误——它只是临时的流量管控，
 * 因此默认允许无限次重试。使用 Retry-After 头（如果存在）来决定等待时间，
 * 否则使用指数退避 + 随机抖动（full jitter）策略。
 *
 * @param fn     要执行的异步函数
 * @param opts   重试选项
 * @returns      fn 的返回值
 * @throws       当错误不是限流时直接抛出，或超过 maxRetries 时抛出最后一次错误
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const {
        initialDelayMs = DEFAULT_RETRY_OPTIONS.initialDelayMs,
        maxDelayMs = DEFAULT_RETRY_OPTIONS.maxDelayMs,
        backoffMultiplier = DEFAULT_RETRY_OPTIONS.backoffMultiplier,
        maxRetries,
        onRetry
    } = opts;

    let attempt = 0;
    let currentDelayMs = initialDelayMs;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            if (!RateLimitDetector.isRateLimitError(err)) {
                throw err;
            }

            attempt++;
            if (maxRetries !== undefined && attempt > maxRetries) {
                throw err;
            }

            const retryAfterSec = RateLimitDetector.extractRetryAfterSeconds(err);
            let delayMs: number;

            if (retryAfterSec !== undefined) {
                delayMs = Math.min(retryAfterSec * 1000, maxDelayMs);
            } else {
                const jitter = Math.random();
                delayMs = Math.min(currentDelayMs * jitter + currentDelayMs * (1 - jitter) * Math.random(), maxDelayMs);
                currentDelayMs = Math.min(currentDelayMs * backoffMultiplier, maxDelayMs);
            }

            delayMs = Math.max(delayMs, 500);

            logger.warn(
                `Rate limited (attempt ${attempt}${maxRetries !== undefined ? `/${maxRetries}` : ''}), ` +
                    `waiting ${(delayMs / 1000).toFixed(1)}s before retry...`,
                err instanceof Error ? err.message : String(err)
            );

            if (onRetry) {
                onRetry(attempt, delayMs, err);
            }

            await sleep(delayMs);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export { RateLimitDetector, withRateLimitRetry, type RetryOptions };
