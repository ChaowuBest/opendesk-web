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
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { OpenTelemetryConfig } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import type { TelemetryProtocol } from '../protocol.js';
import { OpenTelemetryAgentExecutionInstrumentation } from './agent-execution.js';
import { OpenTelemetryOperationInstrumentation } from './operation.js';

type SpanPredicate = (span: ReadableSpan) => boolean;

export interface OpenTelemetryProtocolIntegration extends TelemetryProtocol {
    readonly spanProcessors: readonly SpanProcessor[];
    acceptsSpan(span: ReadableSpan): boolean;
    bindTracerProvider(provider: NodeTracerProvider | null): void;
}

class FilteredSpanProcessor implements SpanProcessor {
    constructor(
        private readonly delegate: SpanProcessor,
        private readonly shouldProcess: SpanPredicate
    ) {}

    onStart(span: Span, parentContext: Context): void {
        if (this.shouldProcess(span)) {
            this.delegate.onStart(span, parentContext);
        }
    }

    onEnding(span: Span): void {
        if (this.shouldProcess(span)) {
            this.delegate.onEnding?.(span);
        }
    }

    onEnd(span: ReadableSpan): void {
        if (this.shouldProcess(span)) {
            this.delegate.onEnd(span);
        }
    }

    forceFlush(): Promise<void> {
        return this.delegate.forceFlush();
    }

    shutdown(): Promise<void> {
        return this.delegate.shutdown();
    }
}

export function filterSpanProcessor(processor: SpanProcessor, predicate: SpanPredicate): SpanProcessor {
    return new FilteredSpanProcessor(processor, predicate);
}

function createOtlpSpanProcessors(endpoints: readonly string[]): SpanProcessor[] {
    return endpoints.map((url, index) => {
        const exporter = new OTLPTraceExporter({ url });
        logger.info(`[OTel] Exporter #${index + 1} → ${url}`);
        return new BatchSpanProcessor(exporter, {
            maxQueueSize: 8192,
            maxExportBatchSize: 1024
        });
    });
}

export async function initOpenTelemetry(
    config: OpenTelemetryConfig,
    integrations: readonly OpenTelemetryProtocolIntegration[] = []
): Promise<TelemetryProtocol | undefined> {
    const endpoints = config.endpoints
        .filter((endpoint) => endpoint.enabled && endpoint.url)
        .map((endpoint) => endpoint.url);
    const acceptsIntegratedSpan = (span: ReadableSpan) =>
        integrations.some((integration) => integration.acceptsSpan(span));
    const spanProcessors = [
        ...createOtlpSpanProcessors(endpoints).map((processor) =>
            filterSpanProcessor(processor, (span) => !acceptsIntegratedSpan(span))
        ),
        ...integrations.flatMap((integration) =>
            integration.spanProcessors.map((processor) =>
                filterSpanProcessor(processor, (span) => integration.acceptsSpan(span))
            )
        )
    ];

    if (spanProcessors.length === 0) {
        logger.info('[Telemetry] OpenTelemetry disabled (no enabled protocols)');
        return undefined;
    }

    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: 'opendesk'
        }),
        spanProcessors
    });
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    try {
        provider.register();
        for (const integration of integrations) {
            integration.bindTracerProvider(provider);
        }
        logger.info(`[OTel] OpenTelemetry runtime initialized with ${spanProcessors.length} processor(s)`);
    } catch (err) {
        for (const integration of integrations) {
            integration.bindTracerProvider(null);
        }
        contextManager.disable();
        context.disable();
        trace.disable();
        await provider.shutdown();
        logger.warn(`[OTel] Failed to initialize runtime: ${err}`);
        return undefined;
    }

    return {
        name: 'opentelemetry',
        agentExecutionInstrumentations: [new OpenTelemetryAgentExecutionInstrumentation()],
        operationInstrumentations: [new OpenTelemetryOperationInstrumentation()],
        async shutdown(): Promise<void> {
            try {
                await provider.shutdown();
                logger.info('[OTel] OpenTelemetry runtime shut down');
            } catch (err) {
                logger.warn(`[OTel] Failed to shut down runtime: ${err}`);
            }
            for (const integration of integrations) {
                integration.bindTracerProvider(null);
            }
            contextManager.disable();
            context.disable();
            trace.disable();
        }
    };
}
