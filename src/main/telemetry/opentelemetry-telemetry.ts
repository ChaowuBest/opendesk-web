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

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace, type Tracer, type Span, SpanStatusCode, type SpanOptions } from '@opentelemetry/api';
import { logger } from '../utils/logger.js';

const TRACER_NAME = 'opendesk';
const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces';

let provider: NodeTracerProvider | null = null;
let contextManager: AsyncLocalStorageContextManager | null = null;
let initialized = false;

/**
 * 初始化 OpenTelemetry trace provider，支持多端点上报。
 * 每个端点创建独立的 BatchSpanProcessor + OTLPTraceExporter。
 */
export function initOpenTelemetry(endpoints: string[]): void {
    if (initialized) return;
    initialized = true;

    if (endpoints.length === 0) {
        endpoints = [DEFAULT_ENDPOINT];
    }

    const spanProcessors = endpoints.map((url, i) => {
        const exporter = new OTLPTraceExporter({ url });
        logger.info(`[OTel] Exporter #${i + 1} → ${url}`);
        return new BatchSpanProcessor(exporter, {
            maxQueueSize: 8192,
            maxExportBatchSize: 1024
        });
    });

    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: 'opendesk'
        }),
        spanProcessors
    });

    // 注册 AsyncLocalStorageContextManager，使 context.active() 能通过 async/await 链正确传播
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    try {
        provider.register();
        logger.info(`[OTel] OpenTelemetry initialized with ${endpoints.length} endpoint(s)`);
    } catch (err) {
        logger.warn(`[OTel] Failed to register tracer provider: ${err}`);
        provider = null;
    }
}

/**
 * 获取全局 tracer。如果 OTel 未初始化，返回 OTel API 的 no-op tracer。
 */
export function getTracer(): Tracer {
    return trace.getTracer(TRACER_NAME);
}

/**
 * 关闭 OTel provider，刷新所有待发送 span。
 */
export async function shutdownOpenTelemetry(): Promise<void> {
    if (provider) {
        try {
            await provider.shutdown();
            logger.info('[OTel] OpenTelemetry shut down');
        } catch (err) {
            logger.warn(`[OTel] Failed to shut down: ${err}`);
        }
        provider = null;
    }
    if (contextManager) {
        contextManager.disable();
        contextManager = null;
        context.disable();
    }
    initialized = false;
}

/**
 * withSpan：创建 span 并设为活跃上下文，自动管理生命周期。
 *
 * 在 context.with() 回调中执行 fn，期间所有通过 getTracer().startSpan()
 * 创建的 span 都会成为此 span 的子 span，实现层级嵌套。
 * 成功时标记 OK，异常时记录异常并标记 ERROR，最终在 finally 中结束 span。
 */
export async function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>
): Promise<T> {
    const span = getTracer().startSpan(name, attributes ? { attributes } : undefined);
    const ctx = trace.setSpan(context.active(), span);
    return context.with(ctx, async () => {
        try {
            const result = await fn(span);
            // 不自动设 OK：UNSET 状态会被 collector 视为 OK，
            // 这样回调中已设的 ERROR 状态不会被覆盖
            return result;
        } catch (err: unknown) {
            span.recordException(err as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err)
            });
            throw err;
        } finally {
            span.end();
        }
    });
}

export { context, trace, SpanStatusCode, type Span, type SpanOptions };
