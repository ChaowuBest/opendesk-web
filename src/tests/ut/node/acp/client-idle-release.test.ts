import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InitializeRequest, NewSessionRequest, PromptRequest } from '@agentclientprotocol/sdk';
import type { AcpTaskRuntimeTurnRequest } from '../../../../main/applications/acpmgr/runtime/types.js';
import type {
    AcpClientConnection,
    AcpClientHandlers,
    AcpConnectionHandle
} from '../../../../main/applications/acpmgr/runtime/connection.js';
import { AcpTaskRuntime } from '../../../../main/applications/acpmgr/runtime/session.js';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';

type AgentCapabilities = {
    sessionCapabilities?: { resume?: unknown };
    loadSession?: boolean;
};

const baseProfile = AcpAgentProfileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Agent',
    transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
    execution: {
        location: 'agent',
        workspace: { strategy: 'fixed', path: '/srv/workspaces/project', platform: 'posix' }
    }
});

function profileWithTimeouts(idleReleaseMs: number) {
    return AcpAgentProfileSchema.parse({
        ...baseProfile,
        timeouts: { ...baseProfile.timeouts, idleReleaseMs }
    });
}

class FakeConnection implements AcpClientConnection {
    calls: Array<{ method: string; params: unknown }> = [];
    handlers?: AcpClientHandlers;
    capabilities: AgentCapabilities = { sessionCapabilities: { resume: {} }, loadSession: true };
    authMethods: any[] = [];

    async initialize(params: InitializeRequest): Promise<any> {
        this.calls.push({ method: 'initialize', params });
        return {
            protocolVersion: 1,
            agentCapabilities: this.capabilities,
            authMethods: this.authMethods,
            agentInfo: { name: 'fake-agent', version: '1.0.0' }
        };
    }

    async authenticate(params: any): Promise<any> {
        this.calls.push({ method: 'authenticate', params });
        return {};
    }

    async newSession(params: NewSessionRequest): Promise<any> {
        this.calls.push({ method: 'session/new', params });
        return { sessionId: 'session-1' };
    }

    async loadSession(params: any): Promise<any> {
        this.calls.push({ method: 'session/load', params });
        return {};
    }

    async resumeSession(params: any): Promise<any> {
        this.calls.push({ method: 'session/resume', params });
        return {};
    }

    async setSessionMode(params: any): Promise<any> {
        this.calls.push({ method: 'session/set_mode', params });
        return {};
    }

    async setSessionConfigOption(params: any): Promise<any> {
        this.calls.push({ method: 'session/set_config_option', params });
        return { configOptions: [] };
    }

    async prompt(params: PromptRequest): Promise<any> {
        this.calls.push({ method: 'session/prompt', params });
        await this.handlers?.sessionUpdate({
            sessionId: params.sessionId,
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Remote answer' }
            }
        });
        return { stopReason: 'end_turn' };
    }

    async cancel(params: any): Promise<void> {
        this.calls.push({ method: 'session/cancel', params });
    }
}

/** 手动触发的空闲定时器，替代真实 setTimeout 以便确定性测试 */
class IdleTimerSpy {
    private pending: Array<{ milliseconds: number; callback: () => void }> = [];

    schedule = (milliseconds: number, callback: () => void): (() => void) => {
        const entry = { milliseconds, callback };
        this.pending.push(entry);
        return () => {
            this.pending = this.pending.filter((candidate) => candidate !== entry);
        };
    };

    get size(): number {
        return this.pending.length;
    }

    fire(): void {
        const entry = this.pending.shift();
        if (!entry) throw new Error('no pending idle timer');
        entry.callback();
    }
}

function makeRequest(
    overrides: Partial<AcpTaskRuntimeTurnRequest> = {}
): AcpTaskRuntimeTurnRequest & { updates: unknown[]; checkpoints: Record<string, unknown>[] } {
    const updates: unknown[] = [];
    const checkpoints: Record<string, unknown>[] = [];
    return {
        taskId: 'task-1',
        prompt: 'Do work',
        workspace: '/workspace',
        signal: new AbortController().signal,
        onUpdate: async (update) => {
            updates.push(update);
        },
        checkpoint: async (state) => {
            checkpoints.push(structuredClone(state));
        },
        requestPermission: async (request) => ({
            outcome: request.options[0]
                ? { outcome: 'selected', optionId: request.options[0].optionId }
                : { outcome: 'cancelled' }
        }),
        ...overrides,
        updates,
        checkpoints
    };
}

interface Fixture {
    runtime: AcpTaskRuntime;
    connection: FakeConnection;
    timers: IdleTimerSpy;
    closeCount(): number;
    logs: string[];
}

function createRuntime(
    directory: string,
    connection: FakeConnection,
    runtimeProfile = profileWithTimeouts(50),
    timers = new IdleTimerSpy()
): Fixture {
    const logs: string[] = [];
    let closes = 0;
    const runtime = new AcpTaskRuntime(runtimeProfile, {
        artifactDirectory: () => directory,
        createConnection: async (_profile, handlers): Promise<AcpConnectionHandle> => {
            connection.handlers = handlers;
            return {
                connection,
                closed: new Promise(() => undefined),
                close: async () => {
                    closes++;
                }
            };
        },
        resolveMcpServers: async () => [],
        scheduleIdleTimer: timers.schedule,
        log: {
            info: (message) => logs.push(String(message)),
            warn: (message) => logs.push(String(message))
        }
    });
    return { runtime, connection, timers, closeCount: () => closes, logs };
}

async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

function methodCounts(connection: FakeConnection): Record<string, number> {
    return connection.calls.reduce<Record<string, number>>((acc, call) => {
        acc[call.method] = (acc[call.method] ?? 0) + 1;
        return acc;
    }, {});
}

test('timeout schema defaults idleReleaseMs to 120 seconds', () => {
    const parsed = AcpAgentProfileSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Test Agent',
        transport: { type: 'stdio', command: 'test-agent' }
    });
    assert.equal(parsed.timeouts.idleReleaseMs, 120_000);
});

test('idle timeout releases the connection after a turn', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-release-'));
    try {
        const connection = new FakeConnection();
        const fixture = createRuntime(directory, connection);
        await fixture.runtime.runTurn(makeRequest());
        assert.equal(fixture.closeCount(), 0);

        fixture.timers.fire();
        await flushAsync();

        assert.equal(fixture.closeCount(), 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('next turn after idle release resumes the session instead of creating a new one', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-resume-'));
    try {
        const connection = new FakeConnection();
        const fixture = createRuntime(directory, connection);
        const first = makeRequest();
        await fixture.runtime.runTurn(first);

        fixture.timers.fire();
        await flushAsync();
        assert.equal(fixture.closeCount(), 1);

        const persistedState = first.checkpoints[first.checkpoints.length - 1];
        const second = makeRequest({ persistedState });
        const result = await fixture.runtime.runTurn(second);
        assert.equal(result.stopReason, 'completed');

        const counts = methodCounts(connection);
        assert.equal(counts['session/new'], 1);
        assert.equal(counts['session/resume'], 1);
        assert.equal(counts['initialize'], 2);

        fixture.timers.fire();
        await flushAsync();
        assert.equal(fixture.closeCount(), 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('agents without resume capability keep the connection on idle', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-noresume-'));
    try {
        const connection = new FakeConnection();
        connection.capabilities = { loadSession: false };
        const fixture = createRuntime(directory, connection);
        await fixture.runtime.runTurn(makeRequest());

        fixture.timers.fire();
        await flushAsync();

        assert.equal(fixture.closeCount(), 0);
        assert.ok(
            fixture.logs.some((entry) => entry.includes('idle release skipped')),
            'expected a warn log explaining the skipped release'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('idleReleaseMs of 0 disables idle release', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-disabled-'));
    try {
        const connection = new FakeConnection();
        const fixture = createRuntime(directory, connection, profileWithTimeouts(0));
        await fixture.runtime.runTurn(makeRequest());

        assert.equal(fixture.timers.size, 0);
        assert.equal(fixture.closeCount(), 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('dispose cancels the pending idle timer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-dispose-'));
    try {
        const connection = new FakeConnection();
        const fixture = createRuntime(directory, connection);
        await fixture.runtime.runTurn(makeRequest());
        assert.equal(fixture.timers.size, 1);

        await fixture.runtime.dispose();
        assert.equal(fixture.timers.size, 0);
        assert.equal(fixture.closeCount(), 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
