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

import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { getTracer, withSpan } from './tracing.js';
import type { OperationInstrumentation, TelemetryOperation } from '../operation.js';

function attachOperation(operation: TelemetryOperation, span: Span): () => void {
    return operation.attach({
        setAttribute(name, value) {
            span.setAttribute(name, value);
        },
        markError(message) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message
            });
        }
    });
}

export class OpenTelemetryOperationInstrumentation implements OperationInstrumentation {
    aroundOperation<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T> {
        return withSpan(operation.name, async (span) => {
            const detach = attachOperation(operation, span);
            try {
                return await next();
            } finally {
                detach();
            }
        });
    }

    traceStream<T>(operation: TelemetryOperation, source: AsyncIterable<T>): AsyncIterable<T> {
        return {
            async *[Symbol.asyncIterator]() {
                const span = getTracer().startSpan(operation.name);
                const detach = attachOperation(operation, span);
                const ctx = trace.setSpan(context.active(), span);
                const boundNext = context.bind(ctx, (innerIterator: AsyncIterator<T>) => innerIterator.next());
                const innerIterator = source[Symbol.asyncIterator]();

                try {
                    try {
                        let result = await boundNext(innerIterator);
                        while (!result.done) {
                            yield result.value;
                            result = await boundNext(innerIterator);
                        }
                    } finally {
                        if (innerIterator.return) {
                            await innerIterator.return();
                        }
                    }
                } catch (err) {
                    span.recordException(err as Error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: err instanceof Error ? err.message : String(err)
                    });
                    throw err;
                } finally {
                    detach();
                    span.end();
                }
            }
        };
    }
}
