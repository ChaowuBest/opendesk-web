import { jest } from '@jest/globals';

class FakeObservation {
    readonly id: string;
    readonly traceId: string;
    readonly children: FakeObservation[] = [];
    readonly updates: Array<Record<string, unknown>> = [];
    ended = false;

    constructor(
        readonly name: string,
        readonly parent?: FakeObservation
    ) {
        this.id = `observation-${FakeObservation.nextId++}`;
        this.traceId = parent?.traceId ?? `trace-${this.id}`;
    }

    private static nextId = 1;

    startObservation(name: string): FakeObservation {
        const child = new FakeObservation(name, this);
        this.children.push(child);
        return child;
    }

    setTraceIO(_value: unknown): void {}

    update(value: Record<string, unknown>): void {
        this.updates.push(value);
    }

    end(): void {
        this.ended = true;
    }
}

const rootObservations: FakeObservation[] = [];

jest.unstable_mockModule('@langfuse/tracing', () => ({
    startObservation: jest.fn((name: string) => {
        const observation = new FakeObservation(name);
        rootObservations.push(observation);
        return observation;
    })
}));

jest.unstable_mockModule('../../../main/telemetry/langfuse/init.js', () => ({
    getActiveLangfuseConfig: () => ({
        enabled: true,
        endpoints: [],
        environment: 'test',
        maxPayloadChars: 10_000
    }),
    flushLangfuseTelemetry: async () => undefined
}));

const { finishLlmRequest, recordGeneration, recordTool, startLlmRequest, startTaskTurn } =
    await import('../../../main/telemetry/langfuse/observations.js');

test('finishes an interrupted turn LLM request through its own handle without mutating the replacement turn', () => {
    startTaskTurn({ taskId: 'task-1', turnId: 'turn-1' });
    const firstRequest = startLlmRequest('task-1', { input: 'first' });
    const firstTurn = rootObservations[0];
    const firstStream = firstTurn.children[0];
    const firstDoStream = firstStream.children[0];

    startTaskTurn({ taskId: 'task-1', turnId: 'turn-2' });
    const secondRequest = startLlmRequest('task-1', { input: 'second' });
    const secondTurn = rootObservations[1];
    const secondStream = secondTurn.children[0];
    const secondDoStream = secondStream.children[0];

    recordGeneration(firstRequest as any, { output: 'first output' });
    finishLlmRequest(firstRequest as any, { output: 'first output' });

    expect(firstDoStream.ended).toBe(true);
    expect(firstStream.ended).toBe(true);
    expect(firstDoStream.children).toHaveLength(1);
    expect(secondDoStream.ended).toBe(false);
    expect(secondStream.ended).toBe(false);
    expect(secondDoStream.children).toHaveLength(0);

    finishLlmRequest(secondRequest as any, { output: 'second output' });
    expect(secondDoStream.ended).toBe(true);
    expect(secondStream.ended).toBe(true);
});

test('does not attach a superseded turn tool result to the replacement turn', () => {
    startTaskTurn({ taskId: 'task-2', turnId: 'turn-old' });
    startTaskTurn({ taskId: 'task-2', turnId: 'turn-new' });
    const replacementTurn = rootObservations.at(-1)!;

    recordTool({ task_id: 'task-2', turn_id: 'turn-old' }, {
        id: 'old-tool',
        tool_name: 'oldTool',
        status: 'success',
        result: 'old result'
    } as any);

    expect(replacementTurn.children).toHaveLength(0);
});
