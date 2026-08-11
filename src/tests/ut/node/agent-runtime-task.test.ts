import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    AgentDecl,
    type AgentTaskRuntime,
    type AgentTaskRuntimeTurnRequest,
    type AgentType,
    type ModeDecl,
    type TaskContext
} from '../../../main/aikernel/agents/common.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import { startSubTask } from '../../../main/aikernel/planning/tools.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { deserializeTask, serializeTask } from '../../../main/aikernel/task/serializer.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';

const mode: ModeDecl = {
    id: 'default',
    name: 'Default',
    description: 'Default runtime test mode',
    icon: '',
    color: '',
    permissionFactory: () => []
};

class FakeRuntime implements AgentTaskRuntime {
    readonly kind = 'test-runtime';
    readonly requests: AgentTaskRuntimeTurnRequest[] = [];
    cancelled = false;

    async runTurn(request: AgentTaskRuntimeTurnRequest) {
        this.requests.push(request);
        await request.checkpoint({ sessionId: 'session-1', phase: 'running' });
        await request.onUpdate({ type: 'message_delta', text: 'Remote answer' });
        return {
            stopReason: 'completed' as const,
            state: { sessionId: 'session-1', phase: 'idle' }
        };
    }

    cancel(): void {
        this.cancelled = true;
    }
}

class RuntimeAgent extends AgentDecl {
    readonly agentName = 'remote';
    readonly dispatchable = true;
    readonly agentType: AgentType = 'custom';
    readonly whenToUse = 'Runtime integration tests';

    constructor(readonly runtime: FakeRuntime) {
        super();
    }

    supportedModes(): ModeDecl[] {
        return [mode];
    }

    protected defaultModeId(): string {
        return mode.id;
    }

    async createSystemPrompt(_activeMode: ModeDecl | undefined, _taskCtx: TaskContext): Promise<string> {
        return '';
    }

    createTaskRuntime(): AgentTaskRuntime {
        return this.runtime;
    }
}

test('TaskState delegates external agents while persisting a local canonical task', async (context) => {
    const runtime = new FakeRuntime();
    const agent = new RuntimeAgent(runtime);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'runtime.test', agents: [agent] }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());
    const manager = new TaskManagerState();
    (manager as any).save = () => undefined;
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task.agentId = agent.agentId;
    task.task_name = 'Remote task';
    task.workspace = '/workspace';

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
    assert.deepEqual((serializeTask(task) as any).agent_runtime, {
        kind: 'test-runtime',
        state: { sessionId: 'session-1', phase: 'idle' },
        lastTurnStopReason: 'completed'
    });
});

test('startSubTask returns the final output from an external agent runtime', async (context) => {
    const runtime = new FakeRuntime();
    const agent = new RuntimeAgent(runtime);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'runtime.test', agents: [agent] }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());
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

test('TaskState stop cancels an active external runtime turn', async (context) => {
    const runtime = new FakeRuntime();
    runtime.runTurn = async (request) => {
        runtime.requests.push(request);
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { stopReason: 'cancelled' as const };
    };
    const agent = new RuntimeAgent(runtime);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'runtime.test', agents: [agent] }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());
    const manager = new TaskManagerState();
    (manager as any).save = () => undefined;
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task.agentId = agent.agentId;
    task.task_name = 'Remote task';

    await task.submitUserMessage('Keep running');
    while (runtime.requests.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    task.stop('user');
    await task.waitUntilFinished(undefined, true);

    assert.equal(runtime.cancelled, true);
    assert.equal(runtime.requests[0].signal.aborted, true);
    assert.equal(task.stop_requested_by_user, true);
});

test('TaskState restores persisted runtime checkpoints after restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-agent-runtime-'));
    const filePath = path.join(directory, 'runtime.json');
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            task_id: 'runtime',
            task_name: 'Remote task',
            task_status: 'stopped',
            agentId: 'runtime.test:remote',
            agent_runtime: {
                kind: 'test-runtime',
                state: { sessionId: 'session-1', phase: 'idle' },
                lastTurnStopReason: 'completed'
            },
            chat_context: { messages: [] },
            created_at: new Date().toISOString()
        })
    );

    try {
        const task = deserializeTask(filePath, new TaskManagerState());
        assert.deepEqual(task.agent_runtime, {
            kind: 'test-runtime',
            state: { sessionId: 'session-1', phase: 'idle' },
            lastTurnStopReason: 'completed'
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
