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

import { context, trace, type Context } from '@opentelemetry/api';
import { getTracer, SpanStatusCode, type Span } from './index.js';

/**
 * 启动追踪根 span：贯穿整个启动流程，所有 StartupPhase 作为其子 span，
 * 在 Jaeger 中呈现为一条包含多个阶段 span 的完整 trace。
 */
export class StartupTrace {
    private rootSpan: Span;
    private parentContext: Context;

    constructor(name: string, attributes?: Record<string, string | number | boolean>) {
        this.rootSpan = getTracer().startSpan(name, {
            attributes: {
                'startup.process': process.type ?? 'main',
                ...attributes
            }
        });
        this.parentContext = trace.setSpan(context.active(), this.rootSpan);
    }

    /**
     * 创建一个启动阶段子 span。该 span 自动成为 root span 的子 span。
     */
    createPhase(name: string, attributes?: Record<string, string | number | boolean>): StartupPhase {
        return new StartupPhase(name, this.parentContext, attributes);
    }

    /**
     * 结束 root span，完成整条 trace。
     */
    end(): void {
        this.rootSpan.setStatus({ code: SpanStatusCode.OK });
        this.rootSpan.end();
    }

    /**
     * 标记整个启动流程为失败。
     */
    fail(err: unknown): void {
        this.rootSpan.recordException(err as Error);
        this.rootSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err)
        });
        this.rootSpan.end();
    }
}

/**
 * 启动阶段计时器：作为 StartupTrace 的子 span，记录单个阶段的耗时。
 */
export class StartupPhase {
    private span: Span;
    private startTime: number;

    constructor(name: string, parentContext?: Context, attributes?: Record<string, string | number | boolean>) {
        this.startTime = performance.now();
        this.span = getTracer().startSpan(
            name,
            {
                attributes: {
                    'startup.phase': name,
                    'startup.process': process.type ?? 'main',
                    ...attributes
                }
            },
            parentContext
        );
    }

    end(): void {
        const duration = performance.now() - this.startTime;
        this.span.setAttribute('startup.duration_ms', Math.round(duration * 100) / 100);
        this.span.setStatus({ code: SpanStatusCode.OK });
        this.span.end();
    }

    fail(err: unknown): void {
        const duration = performance.now() - this.startTime;
        this.span.setAttribute('startup.duration_ms', Math.round(duration * 100) / 100);
        this.span.recordException(err as Error);
        this.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err)
        });
        this.span.end();
    }
}
