import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../../../main/aikernel/agents/common.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';
import { deserializeTask, serializeTask } from '../../../main/aikernel/task/serializer.js';

const mode: ModeDecl = {
    id: 'default',
    name: 'Default',
    description: 'Default mode',
    icon: '',
    color: '',
    permissionFactory: () => []
};

class PromptAgent extends AgentDecl {
    readonly agentName = 'prompt-agent';
    readonly dispatchable = true;
    readonly agentType: AgentType = 'custom';
    readonly whenToUse = 'Prompt composition tests';

    supportedModes(): ModeDecl[] {
        return [mode];
    }

    protected defaultModeId(): string {
        return mode.id;
    }

    async createSystemPrompt(_activeMode: ModeDecl | undefined, _taskCtx: TaskContext): Promise<string> {
        return 'agent prompt';
    }
}

test('TaskState defaults to main and persists agentId changes', () => {
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task._dirty = false;

    assert.equal(task.agentId, 'main');
    task.agentId = 'agentoffice:reviewer';
    assert.equal(task._dirty, true);
});

test('serializeTask retains the effective and custom system prompts for compatibility and debugging', () => {
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task.agentId = undefined;
    task._dirty = false;
    task.setSystemPrompt('custom prompt');

    const json = serializeTask(task) as {
        agentId: string | null;
        custom_system_prompt?: string;
        chat_context: { system_prompt?: unknown };
    };

    assert.equal(json.agentId, null);
    assert.equal(json.custom_system_prompt, 'custom prompt');
    assert.equal((json.chat_context.system_prompt as { role?: string; content?: string }).role, 'system');
    assert.equal((json.chat_context.system_prompt as { role?: string; content?: string }).content, 'custom prompt');
    assert.equal(task._dirty, true);
});

test('TaskState combines an Agent prompt with a persisted custom prompt without dirtying on rebuild', async (context) => {
    const agent = new PromptAgent();
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'test.prompts', agents: [agent] }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task.agentId = agent.agentId;
    task.setSystemPrompt('custom prompt');
    task._dirty = false;

    await task.rebuildSystemPrompt();

    assert.equal(task.agent_system_prompt, 'agent prompt');
    assert.equal(task.custom_system_prompt, 'custom prompt');
    assert.equal(task.chat_context.system_prompt?.content, 'agent prompt\n\ncustom prompt');
    assert.equal(task._dirty, false);
});

test('deserializeTask restores an explicit agentless custom prompt', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-custom-prompt-'));
    const filePath = path.join(directory, 'custom.json');
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            task_id: 'custom',
            task_name: 'Custom task',
            task_status: 'waiting',
            agentId: null,
            custom_system_prompt: 'custom prompt',
            chat_context: {
                system_prompt: { role: 'system', content: 'custom prompt' },
                messages: []
            },
            created_at: new Date().toISOString()
        })
    );

    try {
        const task = deserializeTask(filePath, new TaskManagerState());
        assert.equal(task.agentId, undefined);
        assert.equal(task.custom_system_prompt, 'custom prompt');
        assert.equal(task.chat_context.system_prompt?.content, 'custom prompt');
        assert.equal(task._dirty, false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('deserializeTask uses main when persisted agentId is absent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-agent-'));
    const filePath = path.join(directory, 'legacy.json');
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            task_id: 'legacy',
            task_name: 'Legacy task',
            task_status: 'waiting',
            chat_context: { messages: [] },
            created_at: new Date().toISOString()
        })
    );

    try {
        const task = deserializeTask(filePath, new TaskManagerState());
        assert.equal(task.agentId, 'main');
        assert.equal(task._dirty, false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
