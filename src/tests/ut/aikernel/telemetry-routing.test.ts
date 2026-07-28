import { isLangfuseSpan } from '@langfuse/otel';
import { startObservation, setLangfuseTracerProvider } from '@langfuse/tracing';
import { context, trace, SpanStatusCode, type Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, NoopSpanProcessor, SimpleSpanProcessor, type Span } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { filterSpanProcessor } from '../../../main/telemetry/opentelemetry/init.js';
import { TelemetryOperation, TelemetryOperationRegistry } from '../../../main/telemetry/operation.js';
import { OpenTelemetryOperationInstrumentation } from '../../../main/telemetry/opentelemetry/operation.js';
import {
    AgentExecutionInstrumentationRegistry,
    type TaskTurnInstrumentationContext
} from '../../../main/telemetry/agent-execution.js';
import { OpenTelemetryAgentExecutionInstrumentation } from '../../../main/telemetry/opentelemetry/agent-execution.js';

class LangfuseStartMutationProcessor extends NoopSpanProcessor {
    onStart(span: Span, _parentContext: Context): void {
        span.setAttribute('test.langfuse_on_start', true);
    }
}

describe('Shared telemetry runtime routing', () => {
    test('keeps explicit Langfuse observations separate from ordinary OTel spans', async () => {
        trace.disable();
        const otlpExporter = new InMemorySpanExporter();
        const langfuseExporter = new InMemorySpanExporter();
        const secondLangfuseExporter = new InMemorySpanExporter();
        const provider = new NodeTracerProvider({
            spanProcessors: [
                filterSpanProcessor(new SimpleSpanProcessor(otlpExporter), (span) => !isLangfuseSpan(span)),
                filterSpanProcessor(new SimpleSpanProcessor(langfuseExporter), isLangfuseSpan),
                filterSpanProcessor(new SimpleSpanProcessor(secondLangfuseExporter), isLangfuseSpan),
                filterSpanProcessor(new LangfuseStartMutationProcessor(), isLangfuseSpan)
            ]
        });

        try {
            expect(trace.setGlobalTracerProvider(provider)).toBe(true);
            setLangfuseTracerProvider(provider);

            const ordinarySpan = trace.getTracer('opendesk').startSpan('ordinary.otel');
            ordinarySpan.end();

            const langfuseObservation = startObservation('explicit.langfuse');
            langfuseObservation.end();

            await provider.forceFlush();

            expect(otlpExporter.getFinishedSpans().map((span) => span.name)).toEqual(['ordinary.otel']);
            expect(langfuseExporter.getFinishedSpans().map((span) => span.name)).toEqual(['explicit.langfuse']);
            expect(secondLangfuseExporter.getFinishedSpans().map((span) => span.name)).toEqual(['explicit.langfuse']);
            expect(secondLangfuseExporter.getFinishedSpans()[0].spanContext().traceId).toBe(
                langfuseExporter.getFinishedSpans()[0].spanContext().traceId
            );
            expect(otlpExporter.getFinishedSpans()[0].attributes).not.toHaveProperty('test.langfuse_on_start');
            expect(langfuseExporter.getFinishedSpans()[0].attributes).toMatchObject({
                'test.langfuse_on_start': true
            });
        } finally {
            setLangfuseTracerProvider(null);
            trace.disable();
            await provider.shutdown();
        }
    });

    test('preserves operation attributes, error status, and stream child context', async () => {
        trace.disable();
        context.disable();
        const contextManager = new AsyncLocalStorageContextManager();
        contextManager.enable();
        context.setGlobalContextManager(contextManager);
        const exporter = new InMemorySpanExporter();
        const provider = new NodeTracerProvider({
            spanProcessors: [filterSpanProcessor(new SimpleSpanProcessor(exporter), (span) => !isLangfuseSpan(span))]
        });
        TelemetryOperationRegistry.install([new OpenTelemetryOperationInstrumentation()]);
        AgentExecutionInstrumentationRegistry.install([new OpenTelemetryAgentExecutionInstrumentation()]);

        try {
            expect(trace.setGlobalTracerProvider(provider)).toBe(true);

            await AgentExecutionInstrumentationRegistry.aroundTaskTurn(
                {
                    taskId: 'task-1',
                    turnId: 'turn-1',
                    taskName: 'Test task',
                    parentTaskId: 'parent-1',
                    userPrompt: 'hello',
                    recordGenerations: true,
                    getOutcome: () => ({})
                } as TaskTurnInstrumentationContext,
                async () => undefined
            );

            const request = new TelemetryOperation('llm.http_request', {
                'http.request.method': 'POST'
            });
            await TelemetryOperationRegistry.aroundOperation(request, async () => {
                request.setAttribute('http.response.status_code', 429);
                request.markError('HTTP 429');
            });

            const stream = new TelemetryOperation('llm.streamComplete');
            async function* source() {
                const child = trace.getTracer('opendesk').startSpan('llm.http_request.child');
                child.end();
                yield 'chunk';
            }
            for await (const _chunk of TelemetryOperationRegistry.traceStream(stream, source())) {
                // Consume the entire stream so the operation closes normally.
            }

            await provider.forceFlush();
            const spans = exporter.getFinishedSpans();
            const requestSpan = spans.find((span) => span.name === 'llm.http_request');
            const taskSpan = spans.find((span) => span.name === 'task.turn');
            const streamSpan = spans.find((span) => span.name === 'llm.streamComplete');
            const childSpan = spans.find((span) => span.name === 'llm.http_request.child');

            expect(requestSpan?.attributes).toMatchObject({
                'http.request.method': 'POST',
                'http.response.status_code': 429
            });
            expect(requestSpan?.status).toEqual({
                code: SpanStatusCode.ERROR,
                message: 'HTTP 429'
            });
            expect(taskSpan?.attributes).toMatchObject({
                'task.id': 'task-1',
                'task.name': 'Test task',
                'task.parent_id': 'parent-1',
                'task.user_prompt': 'hello'
            });
            expect(childSpan?.parentSpanContext?.spanId).toBe(streamSpan?.spanContext().spanId);
        } finally {
            AgentExecutionInstrumentationRegistry.reset();
            TelemetryOperationRegistry.reset();
            contextManager.disable();
            context.disable();
            trace.disable();
            await provider.shutdown();
        }
    });
});
