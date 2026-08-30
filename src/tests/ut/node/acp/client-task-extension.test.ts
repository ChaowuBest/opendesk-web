import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRegistry } from '../../../../main/aikernel/agents/registry.js';
import { AssistantMessage, UserMessage } from '../../../../main/aikernel/messages.js';
import { startSubTask } from '../../../../main/aikernel/planning/tools.js';
import { TaskManagerState } from '../../../../main/aikernel/task/manager.js';
import { deserializeTask, serializeTask } from '../../../../main/aikernel/task/serializer.js';
import { TaskState } from '../../../../main/aikernel/states/tasks.js';
import { AcpAgentDecl } from '../../../../main/applications/acpmgr/agent.js';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';
import type { AcpTaskRuntime } from '../../../../main/applications/acpmgr/runtime/session.js';
import '../../../../main/applications/acpmgr/runtime/task-extension.js';
import type {
    AcpTaskRuntimeTurnRequest,
    AcpTaskRuntimeTurnResult
} from '../../../../main/applications/acpmgr/runtime/types.js';

const profile = AcpAgentProfileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Remote Agent',
    enabled: true,
    dispatchable: true,
    transport: { type: 'stdio', command: 'fake-agent' }
});

class FakeAcpRuntime {
    readonly requests: AcpTaskRuntimeTurnRequest[] = [];
    cancelled = false;
    disposed = false;

    async runTurn(request: AcpTaskRuntimeTurnRequest): Promise<AcpTaskRuntimeTurnResult> {
        this.requests.push(request);
        await request.checkpoint({ profileId: profile.id, sessionId: 'session-1', phase: 'running' });
        await request.onUpdate({ type: 'message_delta', text: 'Remote answer' });
        return {
            stopReason: 'completed',
            state: { profileId: profile.id, sessionId: 'session-1', phase: 'idle' }
        };
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
    }
}

function createAgent(runtime: FakeAcpRuntime): AcpAgentDecl {
    const agent = new AcpAgentDecl(
        profile,
        async () => [],
        async () => {
            throw new Error('connection factory should not be used by the fake runtime');
        }
    );
    agent.createAcpTaskRuntime = () => runtime as unknown as AcpTaskRuntime;
    return agent;
}

async function registerAgent(context: TestContext, runtime: FakeAcpRuntime): Promise<AcpAgentDecl> {
    const agent = createAgent(runtime);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'acpmgr', agents: [agent] }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());
    return agent;
}

function createTask(agent: AcpAgentDecl): TaskState {
    const manager = new TaskManagerState();
    (manager as any).save = () => undefined;
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task.agentId = agent.agentId;
    task.task_name = 'Remote task';
    task.workspace = '/workspace';
    return task;
}

test('ACP task extension projects output and persists its checkpoint through task extensions', async (context) => {
    const runtime = new FakeAcpRuntime();
    const agent = await registerAgent(context, runtime);
    const task = createTask(agent);

    const submitted = await task.submitUserMessage('Do remote work');
    await task.waitUntilFinished(undefined, true);

    assert.deepEqual(submitted, { status: 'ok' });
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0].workspace, '/workspace');
    assert.equal(task.task_status, 'stopped');
    assert.equal(task.chat_context.messages.length, 2);
    assert.equal((task.chat_context.messages[0] as UserMessage).getPlainText(), 'Do remote work');
    assert.equal((task.chat_context.messages[1] as AssistantMessage).content[0].type, 'text');
    assert.equal(((task.chat_context.messages[1] as AssistantMessage).content[0] as any).text, 'Remote answer');
    assert.deepEqual((serializeTask(task) as any).acp_runtime, {
        schemaVersion: 1,
        state: { profileId: profile.id, sessionId: 'session-1', phase: 'idle' },
        lastTurnStopReason: 'completed'
    });
    assert.equal('agent_runtime' in (serializeTask(task) as any), false);
});

test('startSubTask obtains the completion result from the ACP task extension', async (context) => {
    const runtime = new FakeAcpRuntime();
    const agent = await registerAgent(context, runtime);
    const manager = new TaskManagerState();
    (manager as any).save = () => undefined;
    const parent = new TaskState(manager);
    manager.tasks.push(parent);
    parent.task_name = 'Parent task';

    const result = await startSubTask({
        parentTask: parent,
        config: {
            title: 'Remote child',
            objective: 'Do remote work',
            criteria: 'Return the remote answer',
            isAsync: false,
            agentName: agent.agentId
        }
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'success');
    assert.equal(result.result, 'Remote answer');
});

test('task stop aborts and cancels an active ACP turn', async (context) => {
    const runtime = new FakeAcpRuntime();
    runtime.runTurn = async (request) => {
        runtime.requests.push(request);
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { stopReason: 'cancelled' };
    };
    const agent = await registerAgent(context, runtime);
    const task = createTask(agent);

    await task.submitUserMessage('Keep running');
    while (runtime.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    task.stop('user');
    await task.waitUntilFinished(undefined, true);

    assert.equal(runtime.cancelled, true);
    assert.equal(runtime.requests[0].signal.aborted, true);
    assert.equal(task.stop_requested_by_user, true);
});

test('ACP task extension maps protocol permission options through the task prompt provider', async (context) => {
    const runtime = new FakeAcpRuntime();
    let permissionResponse: unknown;
    runtime.runTurn = async (request) => {
        runtime.requests.push(request);
        permissionResponse = await request.requestPermission({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'call-1',
                title: 'Edit file',
                kind: 'edit',
                locations: [{ path: '/workspace/a.ts' }],
                rawInput: { path: '/workspace/a.ts' }
            },
            options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
            ]
        });
        await request.onUpdate({ type: 'message_delta', text: 'Permission handled' });
        return { stopReason: 'completed' };
    };
    const agent = await registerAgent(context, runtime);
    const task = createTask(agent);
    let permissionRequests: unknown;
    task.harnessContext.permissionPrompt = {
        prompt: async (requests: unknown) => {
            permissionRequests = requests;
            return { decision: 'allow', rememberScope: 'none' };
        }
    } as any;

    await task.submitUserMessage('Edit the file');
    await task.waitUntilFinished(undefined, true);

    assert.deepEqual(permissionResponse, { outcome: { outcome: 'selected', optionId: 'allow' } });
    assert.deepEqual(permissionRequests, [{ resourceType: 'file', action: 'write', resourcePath: '/workspace/a.ts' }]);
});

test('ACP task extension migrates legacy agent_runtime checkpoints without serializer changes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-extension-'));
    const filePath = path.join(directory, 'runtime.json');
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            task_id: 'runtime',
            task_name: 'Remote task',
            task_status: 'stopped',
            agentId: 'acpmgr:11111111-1111-4111-8111-111111111111',
            agent_runtime: {
                kind: 'acp',
                state: { profileId: profile.id, sessionId: 'session-1', phase: 'idle' },
                lastTurnStopReason: 'completed'
            },
            chat_context: { messages: [] },
            created_at: new Date().toISOString()
        })
    );

    try {
        const task = deserializeTask(filePath, new TaskManagerState());
        const serialized = serializeTask(task) as any;
        assert.deepEqual(serialized.acp_runtime, {
            schemaVersion: 1,
            state: { profileId: profile.id, sessionId: 'session-1', phase: 'idle' },
            lastTurnStopReason: 'completed'
        });
        assert.equal('agent_runtime' in serialized, false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP task extension rebuilds its runtime after the registered profile instance changes', async (context) => {
    const firstRuntime = new FakeAcpRuntime();
    const firstAgent = await registerAgent(context, firstRuntime);
    const task = createTask(firstAgent);
    await task.submitUserMessage('First turn');
    await task.waitUntilFinished(undefined, true);

    const secondRuntime = new FakeAcpRuntime();
    const secondAgent = createAgent(secondRuntime);
    await AgentRegistry.replaceApplicationAgent('acpmgr', secondAgent);
    await task.submitUserMessage('Second turn');
    await task.waitUntilFinished(undefined, true);

    assert.equal(firstRuntime.disposed, true);
    assert.equal(secondRuntime.requests.length, 1);
});

test('switching away from an active ACP agent stops the turn without restoring its stale checkpoint', async (context) => {
    const runtime = new FakeAcpRuntime();
    runtime.runTurn = async (request) => {
        runtime.requests.push(request);
        await request.checkpoint({ profileId: profile.id, sessionId: 'old-session', phase: 'running' });
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return {
            stopReason: 'cancelled',
            state: { profileId: profile.id, sessionId: 'old-session', phase: 'cancelled' }
        };
    };
    const agent = await registerAgent(context, runtime);
    const task = createTask(agent);

    await task.submitUserMessage('Keep running');
    while (runtime.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    task.agentId = 'main';
    await task.waitUntilFinished(undefined, true);

    assert.equal(task.task_status, 'stopped');
    assert.equal(runtime.requests[0].signal.aborted, true);
    assert.equal((serializeTask(task) as any).acp_runtime, undefined);
});
