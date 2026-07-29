import { jest } from '@jest/globals';
import {
    AgentExecutionInstrumentationRegistry,
    normalizeTurnContext,
    type AgentExecutionInstrumentation,
    type ModelRequestInstrumentationContext,
    type TaskTurnInstrumentationContext,
    type ToolCallInstrumentationContext
} from '../../../main/telemetry/agent-execution.js';
import {
    TelemetryOperation,
    TelemetryOperationRegistry,
    type OperationInstrumentation
} from '../../../main/telemetry/operation.js';
import { installProtocols, shutdownProtocols, type TelemetryProtocol } from '../../../main/telemetry/protocol.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';

describe('Task turn instrumentation context', () => {
    afterEach(() => {
        AgentExecutionInstrumentationRegistry.reset();
    });

    test('normalizes trace id and snapshots mutable metadata containers', () => {
        const metadata = { route: '/session/:id/message' };
        const output = { sessionID: 'session-1', cost: 0 };
        const input = { message: 'hello' };

        const normalized = normalizeTurnContext({
            traceId: '  trace-1  ',
            input,
            metadata,
            output
        });

        expect(normalized).toEqual({
            traceId: 'trace-1',
            input,
            metadata,
            output
        });
        expect(normalized?.metadata).not.toBe(metadata);
        expect(normalized?.output).not.toBe(output);
    });

    test('uses the task effective workspace, mode, and agent when an entry point does not override them', async () => {
        let capturedContext: TaskTurnInstrumentationContext | undefined;
        AgentExecutionInstrumentationRegistry.install([
            {
                async aroundTaskTurn<T>(context: TaskTurnInstrumentationContext, next: () => Promise<T>) {
                    capturedContext = context;
                    return await next();
                },
                async aroundModelRequest<T>(
                    _context: ModelRequestInstrumentationContext,
                    next: (headers?: Record<string, string>) => Promise<T>
                ) {
                    return await next();
                },
                recordToolCall() {}
            }
        ]);
        const manager = new TaskManagerState();
        jest.spyOn(manager, 'save').mockImplementation(() => undefined);
        jest.spyOn(manager, 'publishTaskListUpdate').mockImplementation(() => undefined);
        const task = new TaskState(manager);
        task.harnessContext.workspace = '/effective-workspace';
        task.activeModeId = 'standard';
        task.task_status = 'stopped';
        jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
        jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);

        await task.processTaskTurn();

        expect(capturedContext?.workspace).toBe('/effective-workspace');
        expect(capturedContext?.getOutcome()).toEqual(
            expect.objectContaining({
                workspace: '/effective-workspace',
                mode: 'standard',
                agent: 'main'
            })
        );
    });
});

class RecordingInstrumentation implements AgentExecutionInstrumentation {
    constructor(
        private readonly name: string,
        private readonly events: string[],
        private readonly headers?: Record<string, string>
    ) {}

    async aroundTaskTurn<T>(_context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T> {
        this.events.push(`${this.name}:turn:start`);
        try {
            return await next();
        } finally {
            this.events.push(`${this.name}:turn:end`);
        }
    }

    async aroundModelRequest<T>(
        _context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T> {
        this.events.push(`${this.name}:model:start`);
        try {
            return await next(this.headers);
        } finally {
            this.events.push(`${this.name}:model:end`);
        }
    }

    recordToolCall(_context: ToolCallInstrumentationContext): void {
        this.events.push(`${this.name}:tool`);
    }
}

class RecordingOperationInstrumentation implements OperationInstrumentation {
    constructor(
        private readonly name: string,
        private readonly events: string[]
    ) {}

    async aroundOperation<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T> {
        this.events.push(`${this.name}:operation:start`);
        const detach = operation.attach({
            setAttribute: (attribute, value) => {
                this.events.push(`${this.name}:attribute:${attribute}=${value}`);
            },
            markError: (message) => {
                this.events.push(`${this.name}:error:${message}`);
            }
        });
        try {
            return await next();
        } finally {
            detach();
            this.events.push(`${this.name}:operation:end`);
        }
    }

    traceStream<T>(operation: TelemetryOperation, source: AsyncIterable<T>): AsyncIterable<T> {
        const name = this.name;
        const events = this.events;
        return {
            async *[Symbol.asyncIterator]() {
                events.push(`${name}:stream:start`);
                const detach = operation.attach({
                    setAttribute: (attribute, value) => {
                        events.push(`${name}:attribute:${attribute}=${value}`);
                    },
                    markError: (message) => {
                        events.push(`${name}:error:${message}`);
                    }
                });
                try {
                    yield* source;
                } finally {
                    detach();
                    events.push(`${name}:stream:end`);
                }
            }
        };
    }
}

describe('AgentExecutionInstrumentationRegistry', () => {
    afterEach(() => {
        AgentExecutionInstrumentationRegistry.reset();
    });

    test('runs without an installed telemetry implementation', async () => {
        const turnResult = await AgentExecutionInstrumentationRegistry.aroundTaskTurn(
            {} as TaskTurnInstrumentationContext,
            async () => 'turn'
        );
        const modelResult = await AgentExecutionInstrumentationRegistry.aroundModelRequest(
            {} as ModelRequestInstrumentationContext,
            async (headers) => headers
        );

        expect(turnResult).toBe('turn');
        expect(modelResult).toBeUndefined();
    });

    test('composes protocol implementations and merges request headers', async () => {
        const events: string[] = [];
        AgentExecutionInstrumentationRegistry.install([
            new RecordingInstrumentation('otel', events, { traceparent: 'trace' }),
            new RecordingInstrumentation('langfuse', events, { span_id: 'span' })
        ]);

        const headers = await AgentExecutionInstrumentationRegistry.aroundModelRequest(
            {} as ModelRequestInstrumentationContext,
            async (requestHeaders) => {
                events.push('request');
                return requestHeaders;
            }
        );

        expect(headers).toEqual({
            traceparent: 'trace',
            span_id: 'span'
        });
        expect(events).toEqual([
            'otel:model:start',
            'langfuse:model:start',
            'request',
            'langfuse:model:end',
            'otel:model:end'
        ]);
    });

    test('unwinds turn hooks on failure and broadcasts tool observations', async () => {
        const events: string[] = [];
        AgentExecutionInstrumentationRegistry.install([
            new RecordingInstrumentation('otel', events),
            new RecordingInstrumentation('langfuse', events)
        ]);
        const failure = new Error('failed');

        await expect(
            AgentExecutionInstrumentationRegistry.aroundTaskTurn({} as TaskTurnInstrumentationContext, async () => {
                events.push('turn');
                throw failure;
            })
        ).rejects.toBe(failure);
        await AgentExecutionInstrumentationRegistry.recordToolCall({} as ToolCallInstrumentationContext);

        expect(events).toEqual([
            'otel:turn:start',
            'langfuse:turn:start',
            'turn',
            'langfuse:turn:end',
            'otel:turn:end',
            'otel:tool',
            'langfuse:tool'
        ]);
    });
});

describe('TelemetryOperationRegistry', () => {
    afterEach(() => {
        TelemetryOperationRegistry.reset();
    });

    test('fans out dynamic attributes and non-throwing error status', async () => {
        const events: string[] = [];
        TelemetryOperationRegistry.install([
            new RecordingOperationInstrumentation('otel', events),
            new RecordingOperationInstrumentation('audit', events)
        ]);
        const operation = new TelemetryOperation('llm.http_request', {
            method: 'POST'
        });

        const result = await TelemetryOperationRegistry.aroundOperation(operation, async () => {
            events.push('request');
            operation.setAttribute('status', 429);
            operation.markError('HTTP 429');
            return 'response';
        });

        expect(result).toBe('response');
        expect(events).toEqual([
            'otel:operation:start',
            'otel:attribute:method=POST',
            'audit:operation:start',
            'audit:attribute:method=POST',
            'request',
            'otel:attribute:status=429',
            'audit:attribute:status=429',
            'otel:error:HTTP 429',
            'audit:error:HTTP 429',
            'audit:operation:end',
            'otel:operation:end'
        ]);
    });

    test('composes stream lifecycle once and closes wrappers on early return', async () => {
        const events: string[] = [];
        TelemetryOperationRegistry.install([
            new RecordingOperationInstrumentation('otel', events),
            new RecordingOperationInstrumentation('audit', events)
        ]);
        const operation = new TelemetryOperation('llm.streamComplete');
        async function* source() {
            try {
                events.push('source:start');
                yield 1;
                yield 2;
            } finally {
                events.push('source:end');
            }
        }

        for await (const value of TelemetryOperationRegistry.traceStream(operation, source())) {
            events.push(`value:${value}`);
            break;
        }

        expect(events).toEqual([
            'otel:stream:start',
            'audit:stream:start',
            'source:start',
            'value:1',
            'source:end',
            'audit:stream:end',
            'otel:stream:end'
        ]);
    });
});

describe('TelemetryProtocol lifecycle', () => {
    test('installs hooks in protocol order and shuts protocols down in reverse order', async () => {
        const events: string[] = [];
        const createProtocol = (name: string): TelemetryProtocol => ({
            name,
            agentExecutionInstrumentations: [new RecordingInstrumentation(name, events)],
            async shutdown() {
                events.push(`${name}:shutdown`);
            }
        });
        const protocols = [createProtocol('langfuse'), createProtocol('opentelemetry')];
        installProtocols(protocols);

        await AgentExecutionInstrumentationRegistry.aroundTaskTurn({} as TaskTurnInstrumentationContext, async () => {
            events.push('turn');
        });
        await shutdownProtocols(protocols);

        expect(events).toEqual([
            'langfuse:turn:start',
            'opentelemetry:turn:start',
            'turn',
            'opentelemetry:turn:end',
            'langfuse:turn:end',
            'opentelemetry:shutdown',
            'langfuse:shutdown'
        ]);
    });
});
