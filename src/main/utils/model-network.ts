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

import { getPlatform } from '../../platforms/base.js';
import { logger } from './logger.js';
import { isLogRawLlmRequestEnabled } from './setting.js';
import { isLoopbackUrl } from './proxy.js';
import { TelemetryOperation, TelemetryOperationRegistry } from '../telemetry/operation.js';
import { DEFAULT_MODEL_TIMEOUT_SECONDS } from '../../utils/model.js';

export interface ModelNetworkConfig {
    base_url: string;
    no_proxy?: boolean;
    no_ssl?: boolean;
    /** embedding 响应包含大量向量，不纳入原始 LLM 响应日志。 */
    model_type?: 'chat' | 'embedding';
    /** 模型整体超时（秒）；未配置时用 DEFAULT_MODEL_TIMEOUT_SECONDS。也用作等待响应头的上限。 */
    timeout?: number;
}

/**
 * 在时限内没有收到响应头。网关接受了连接却一直不回应时，没有这个上限请求会无限等待；
 * 错误消息包含 "response timeout"，按网络错误归类为可重试。
 */
export class ModelResponseTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number) {
        super(`Model response timeout: no response headers within ${timeoutMs}ms`);
        this.name = 'ModelResponseTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

function modelResponseTimeoutMs(model: ModelNetworkConfig): number {
    return (model.timeout && model.timeout > 0 ? model.timeout : DEFAULT_MODEL_TIMEOUT_SECONDS) * 1000;
}

type ModelFetchInput = string | URL | Request;

function isRequestInput(input: ModelFetchInput): input is Request {
    return typeof Request !== 'undefined' && input instanceof Request;
}

function normalizeFetchUrl(input: ModelFetchInput): string {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}

function normalizeFetchInit(input: ModelFetchInput, init?: RequestInit): RequestInit | undefined {
    if (init || !isRequestInput(input)) {
        return init;
    }

    const requestInit: RequestInit = {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        redirect: input.redirect
    };

    if (input.body === null) {
        return requestInit;
    }

    // Node.js undici fetch requires `duplex: 'half'` when the body is a
    // ReadableStream, but other body types (string, FormData, Blob, etc.)
    // must not carry this property.
    if (typeof ReadableStream !== 'undefined' && input.body instanceof ReadableStream) {
        return {
            ...requestInit,
            body: input.body,
            duplex: 'half'
        } as RequestInit;
    }

    return {
        ...requestInit,
        body: input.body
    };
}

export async function fetchModelUrl(
    model: ModelNetworkConfig,
    input: ModelFetchInput,
    init?: RequestInit
): Promise<Response> {
    const url = normalizeFetchUrl(input);
    const requestInit = normalizeFetchInit(input, init);
    const method = requestInit?.method || 'GET';

    const operation = new TelemetryOperation('llm.http_request', {
        'http.request.method': method,
        'http.url': url,
        'llm.base_url': model.base_url
    });
    return TelemetryOperationRegistry.aroundOperation(operation, async () => {
        logger.info(`[LLM Request] ${method} ${url}`);

        const logRaw = isLogRawLlmRequestEnabled() && model.model_type !== 'embedding';

        // 只限制等待响应头的时间；拿到响应头后清除计时器，响应体由各适配器的流空闲超时管理。
        // 调用方自己的 signal（停止任务等）在整个请求期间照常生效。
        const timeoutMs = modelResponseTimeoutMs(model);
        const controller = new AbortController();
        const upstreamSignal = requestInit?.signal;
        if (upstreamSignal) {
            if (upstreamSignal.aborted) controller.abort(upstreamSignal.reason);
            else
                upstreamSignal.addEventListener('abort', () => controller.abort(upstreamSignal.reason), { once: true });
        }
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new ModelResponseTimeoutError(timeoutMs));
        }, timeoutMs);
        let response: Response;
        try {
            response = await getPlatform().fetch(
                url,
                { ...requestInit, signal: controller.signal },
                {
                    forceEnvironmentProxy: true,
                    bypassProxy: !!model.no_proxy || isLoopbackUrl(url) || isLoopbackUrl(model.base_url),
                    skipTlsVerification: !!model.no_ssl
                }
            );
        } catch (err) {
            if (timedOut) throw new ModelResponseTimeoutError(timeoutMs);
            throw err;
        } finally {
            clearTimeout(timer);
        }

        operation.setAttribute('http.response.status_code', response.status);
        operation.setAttribute('http.status_text', response.statusText);
        if (response.status >= 400) {
            operation.markError(`HTTP ${response.status}`);
        }

        if (logRaw && response.body) {
            const decoder = new TextDecoder();
            const loggedBody = response.body.pipeThrough(
                new TransformStream({
                    transform(chunk, controller) {
                        try {
                            logger.info(`[LLM Raw Response] ${decoder.decode(chunk, { stream: true })}`);
                        } catch {
                            // Logging must never break the response stream
                        }
                        controller.enqueue(chunk);
                    }
                })
            );
            return new Response(loggedBody, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        return response;
    });
}
