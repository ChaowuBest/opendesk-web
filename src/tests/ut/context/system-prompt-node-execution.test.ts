import { ExploreAgentDecl } from '../../../main/aikernel/agents/explore/agent.js';
import { MainAgentDecl } from '../../../main/aikernel/agents/main/agent.js';
import { PlanAgentDecl } from '../../../main/aikernel/agents/plan/agent.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

function createNodeTask(): TaskState {
    const task = new TaskState(new TaskManagerState());
    const localWorkspace = '/local/opendesk-workspace';
    task.workspace = localWorkspace;
    task.harnessContext.workspace = localWorkspace;
    task.harnessContext.executionHost = {
        type: 'node',
        nodeId: 'node-a',
        nodeLabel: 'Node A',
        capabilities: {
            nodeId: 'node-a',
            displayName: 'Node A',
            platform: 'win32',
            workspace: 'C:/node/workspace',
            commands: ['system.run', 'fs.readText'],
            shells: ['powershell'],
            defaultShell: 'powershell'
        }
    };
    return task;
}

describe('system prompt node execution environment', () => {
    test('describes node workspace separately from the local task workspace', async () => {
        const localWorkspace = '/local/opendesk-workspace';
        const task = createNodeTask();

        const prompt = await new MainAgentDecl().createSystemPrompt(undefined, task);

        expect(prompt).toContain(`OpenDesk 本地工作空间：${localWorkspace}`);
        expect(prompt).toContain('当前执行宿主：Node Node A (node-a)');
        expect(prompt).toContain('Node 默认工作目录：C:/node/workspace');
        expect(prompt).toContain('Node 操作系统平台：win32');
        expect(prompt).toContain('本机 shell/file 工具仍在 OpenDesk 本机运行');
        expect(prompt).toContain('使用 devicemgr 的 node 工具');
        expect(prompt).not.toContain('shell/file 工具会在当前执行宿主上运行');
        expect(prompt).not.toContain(` - 工作目录：${localWorkspace}`);
    });

    test('uses the same node environment wording for planning subagents', async () => {
        const task = createNodeTask();
        const agents = [new ExploreAgentDecl(), new PlanAgentDecl()];

        for (const agent of agents) {
            const prompt = await agent.createSystemPrompt(undefined, task);
            expect(prompt).toContain('OpenDesk 本地工作空间：/local/opendesk-workspace');
            expect(prompt).toContain('当前执行宿主：Node Node A (node-a)');
            expect(prompt).toContain('Node 默认工作目录：C:/node/workspace');
        }
    });

    test('keeps the original workspace wording for local execution', async () => {
        const task = new TaskState(new TaskManagerState());
        const localWorkspace = '/local/opendesk-workspace';
        task.workspace = localWorkspace;
        task.harnessContext.workspace = localWorkspace;
        task.harnessContext.executionHost = { type: 'local' };

        const prompt = await new MainAgentDecl().createSystemPrompt(undefined, task);

        expect(prompt).toContain(`工作目录：${localWorkspace}`);
        expect(prompt).toContain('当前执行宿主：Local');
        expect(prompt).toContain('本机 shell/file 工具会在 OpenDesk 本地工作目录下运行');
        expect(prompt).not.toContain('Node 默认工作目录');
    });
});
