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

import { context, trace, type Tracer, type Span, SpanStatusCode } from '@opentelemetry/api';

const TRACER_NAME = 'opendesk';

/**
 * 获取全局 tracer。如果遥测尚未初始化，OpenTelemetry API 会返回 no-op tracer。
 */
export function getTracer(): Tracer {
    return trace.getTracer(TRACER_NAME);
}

/**
 * 创建 span 并设为活跃上下文，自动管理异常状态与生命周期。
 */
export async function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>
): Promise<T> {
    const span = getTracer().startSpan(name, attributes ? { attributes } : undefined);
    const activeContext = trace.setSpan(context.active(), span);
    return context.with(activeContext, async () => {
        try {
            return await fn(span);
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
