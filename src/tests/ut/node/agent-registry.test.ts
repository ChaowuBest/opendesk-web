import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../../../main/aikernel/agents/common.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { replaceTaskHarnessForMode, resolveTaskMode } from '../../../main/aikernel/task/mode.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';

const TEST_MODE: ModeDecl = {
    id: 'default',
    name: 'Default',
    description: 'Default test mode',
    icon: '',
    color: '',
    permissionFactory: () => []
};

const ALTERNATE_MODE: ModeDecl = {
    ...TEST_MODE,
    id: 'alternate',
    name: 'Alternate'
};

class ApplicationAgent extends AgentDecl {
    readonly agentName: string;
    readonly agentType: AgentType = 'custom';
    readonly whenToUse = 'Registry unit tests';
    readonly dispatchable: boolean;

    constructor(agentName: string, dispatchable: boolean) {
        super();
        this.agentName = agentName;
        this.dispatchable = dispatchable;
    }

    supportedModes(): ModeDecl[] {
        return [TEST_MODE, ALTERNATE_MODE];
    }

    protected defaultModeId(): string {
        return TEST_MODE.id;
    }

    async createSystemPrompt(activeMode: ModeDecl | undefined, _taskCtx: TaskContext): Promise<string> {
        return `${this.agentId}:${activeMode?.id}`;
    }
}

function createTask(): TaskState {
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    task._dirty = false;
    return task;
}

test.afterEach(async () => {
    await AgentRegistry.unloadApplicationAgents();
});

test('AgentRegistry registers every builtin agent with unscoped ids and dispatchability', () => {
    AgentRegistry.initBuiltinAgents();
    const mainAgent = AgentRegistry.getMainAgent();

    assert.equal((mainAgent as unknown as { agentScope?: string }).agentScope, undefined);
    assert.equal(mainAgent.agentId, 'main');
    assert.equal(mainAgent.dispatchable, false);
    assert.equal(AgentRegistry.getMainAgent(), mainAgent);
    assert.equal(AgentRegistry.getBuiltinAgent('explore')?.agentId, 'explore');
    assert.equal(AgentRegistry.getBuiltinAgent('explore')?.dispatchable, true);
    assert.equal(AgentRegistry.getBuiltinAgent('plan')?.agentId, 'plan');
    assert.equal(AgentRegistry.getBuiltinAgent('plan')?.dispatchable, true);
});

test('AgentRegistry scopes application agents and only advertises dispatchable agents', async () => {
    const worker = new ApplicationAgent('worker', true);
    const staff = new ApplicationAgent('staff:123', false);

    await AgentRegistry.replaceApplicationAgents([
        {
            bundleName: 'example.app',
            agents: [worker, staff]
        }
    ]);

    assert.equal(worker.agentId, 'example.app:worker');
    assert.equal(worker.getDefaultMode(), TEST_MODE);
    assert.equal(staff.agentId, 'example.app:staff:123');
    assert.equal(AgentRegistry.getApplicationAgent('example.app', 'worker'), worker);
    assert.equal(AgentRegistry.getAgent('example.app:staff:123'), staff);
    assert.equal(AgentRegistry.resolveAgentReference('/legacy/agents/worker'), undefined);

    const frontmatter = AgentRegistry.getAgentFrontmatterXml();
    assert.match(frontmatter, /name="example\.app:worker"/);
    assert.doesNotMatch(frontmatter, /staff:123/);
    assert.doesNotMatch(frontmatter, /name="main"/);
});

test('TaskState falls missing agent bindings back to main after application agent registration', async () => {
    AgentRegistry.initBuiltinAgents();
    await AgentRegistry.replaceApplicationAgents([]);
    const task = createTask();
    task.agentId = 'missing:agent';
    task._dirty = false;

    const agent = task.getAgent();

    assert.equal(agent.agentId, 'main');
    assert.equal(task.agentId, 'main');
    assert.equal(task._dirty, true);
});

test('TaskState immediately falls back when an agent binding is unresolved', async () => {
    const task = createTask();
    task.agentId = 'example.app:worker';
    task._dirty = false;

    assert.equal(task.getAgent(), AgentRegistry.getMainAgent());
    assert.equal(task.agentId, 'main');
    assert.equal(task._dirty, true);
});

test('TaskState resolves unscoped builtin agent ids directly', () => {
    const exploreTask = createTask();
    exploreTask.agentId = 'explore';
    const mainTask = createTask();
    mainTask.agentId = 'main';

    assert.equal(exploreTask.getAgent().agentId, 'explore');
    assert.equal(exploreTask.agentId, 'explore');
    assert.equal(mainTask.getAgent().agentId, 'main');
    assert.equal(mainTask.agentId, 'main');
});

test('AgentRegistry resolves bare builtin ids and requires scoped application ids', async () => {
    const worker = new ApplicationAgent('worker', true);
    const staff = new ApplicationAgent('staff', false);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'example.app', agents: [worker, staff] }]);

    assert.equal(AgentRegistry.resolveAgentReference('main'), AgentRegistry.getMainAgent());
    assert.equal(AgentRegistry.resolveAgentReference('explore'), AgentRegistry.getBuiltinAgent('explore'));
    assert.equal(AgentRegistry.resolveAgentReference('worker'), undefined);
    assert.equal(AgentRegistry.resolveDispatchableAgent('worker'), undefined);
    assert.equal(AgentRegistry.resolveDispatchableAgent('staff'), undefined);
    assert.equal(AgentRegistry.resolveAgentReference('example.app:worker'), worker);
    assert.equal(AgentRegistry.resolveDispatchableAgent('example.app:worker'), worker);
});

test('resolveTaskMode preserves an application agent mode when a main-agent mode is selected globally', async () => {
    const worker = new ApplicationAgent('worker', true);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'example.app', agents: [worker] }]);
    const task = createTask();
    task.agentId = worker.agentId;
    task.activeModeId = ALTERNATE_MODE.id;

    assert.equal(resolveTaskMode(task, AgentRegistry.getMainAgent().getDefaultMode()), ALTERNATE_MODE);

    const mainTask = createTask();
    const selectedMainMode = AgentRegistry.getMainAgent().supportedModes()[0];
    assert.equal(resolveTaskMode(mainTask, selectedMainMode), selectedMainMode);
});

test('main rebuilds the default-subtask prompt for child tasks', async () => {
    const task = createTask();
    task.task_id = 'child';
    task.task_name = 'Child task';
    task.parent_id = 'parent';

    const prompt = await task.buildSystemPrompt();

    assert.match(prompt, /通用子任务执行助手/);
    assert.match(prompt, /planning-attemptCompletion/);
    assert.doesNotMatch(prompt, /__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/);
});

test('TaskState builds its system prompt from its bound agent and active mode', async () => {
    const worker = new ApplicationAgent('worker', true);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'example.app', agents: [worker] }]);
    const task = createTask();
    task.agentId = worker.agentId;
    task.activeModeId = ALTERNATE_MODE.id;

    assert.equal(task.getAgentMode(), ALTERNATE_MODE);
    assert.equal(await task.buildSystemPrompt(), 'example.app:worker:alternate');
});

test('TaskState rebuilds and installs its system prompt without marking the task dirty', async () => {
    const worker = new ApplicationAgent('worker', true);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'example.app', agents: [worker] }]);
    const task = createTask();
    task.agentId = worker.agentId;
    task.activeModeId = ALTERNATE_MODE.id;
    task._dirty = false;

    await task.rebuildSystemPrompt();

    assert.equal(task.chat_context.system_prompt?.content, 'example.app:worker:alternate');
    assert.equal(task._dirty, false);
});

test('mode replacement rejects modes unsupported by the task-bound agent', async () => {
    const worker = new ApplicationAgent('worker', true);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'example.app', agents: [worker] }]);
    const manager = new TaskManagerState();
    const task = manager.createTask();
    task.agentId = worker.agentId;

    await assert.rejects(
        replaceTaskHarnessForMode(task, '/workspace', { ...TEST_MODE, id: 'unsupported' }, () => {
            throw new Error('permission prompt should not be created');
        }),
        /unsupported/
    );
    assert.equal(task.activeModeId, undefined);
});
