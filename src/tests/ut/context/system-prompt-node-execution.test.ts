import { ExploreAgentDecl } from '../../../main/aikernel/agents/explore/agent.js';
import { MainAgentDecl } from '../../../main/aikernel/agents/main/agent.js';
import { PlanAgentDecl } from '../../../main/aikernel/agents/plan/agent.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { Setting } from '../../../main/utils/setting.js';

function configurePromptModels(hasEmbeddingModel: boolean): void {
    Setting.updateInstanceData({
        default_model: 'mock-chat',
        default_embedding_model: hasEmbeddingModel ? 'mock-embed' : '',
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: [
            {
                alias: 'mock-chat',
                provider_name: 'mock-provider',
                model_name: 'mock/chat',
                model_type: 'chat'
            },
            ...(hasEmbeddingModel
                ? [
                      {
                          alias: 'mock-embed',
                          provider_name: 'mock-provider',
                          model_name: 'mock/embed',
                          model_type: 'embedding'
                      }
                  ]
                : [])
        ]
    });
}

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
    beforeEach(() => {
        configurePromptModels(false);
    });

    afterEach(() => {
        Setting.clearCache();
    });

    test('describes node workspace separately from the local task workspace', async () => {
        const localWorkspace = '/local/opendesk-workspace';
        const task = createNodeTask();

        const prompt = await new MainAgentDecl().createSystemPrompt(undefined, task);

        expect(prompt).toContain(`工作目录：${localWorkspace}`);
        expect(prompt).toContain('默认执行节点：Node A (node-a)');
        expect(prompt).toContain(`操作系统平台：${process.platform}`);
        expect(prompt).not.toContain('shell/file 工具会在当前执行宿主上运行');
        // 无连接节点但默认节点为 node 时，仍给出 node 工具说明
        expect(prompt).toContain('本机工具（executeBash/readFile/editFile 等）始终在 Local 上运行');
        expect(prompt).toContain('如需在默认节点上执行，使用对应的 node 工具');
    });

    test('uses the same node environment wording for planning subagents', async () => {
        const task = createNodeTask();
        const agents = [new ExploreAgentDecl(), new PlanAgentDecl()];

        for (const agent of agents) {
            const prompt = await agent.createSystemPrompt(undefined, task);
            expect(prompt).toContain('工作目录：/local/opendesk-workspace');
            expect(prompt).toContain('默认执行节点：Node A (node-a)');
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
        expect(prompt).toContain('默认执行节点：Local（本机）');
        expect(prompt).not.toContain('Node 默认工作目录');
    });

    test('adds local filesystem guidance without semantic search when embedding model is unavailable', async () => {
        const task = new TaskState(new TaskManagerState());

        const prompt = await new MainAgentDecl().createSystemPrompt(undefined, task);

        expect(prompt).toContain('# 本地文件系统');
        expect(prompt).toContain('OpenDesk 的 filemgr 提供本地知识库能力');
        expect(prompt).toContain('knowledgebase 应用提供云端/服务商知识库能力');
        expect(prompt).toContain('未配置向量嵌入模型时，本地语义搜索不可用');
        expect(prompt).not.toContain('语义搜索本地文件标题或内容时使用 semanticSearch');
    });

    test('adds semantic local filesystem guidance when embedding model is configured', async () => {
        configurePromptModels(true);
        const task = new TaskState(new TaskManagerState());

        const prompt = await new MainAgentDecl().createSystemPrompt(undefined, task);

        expect(prompt).toContain('语义搜索本地文件标题或内容时使用 semanticSearch');
        expect(prompt).toContain('# 本地文件系统');
        expect(prompt).toContain('已配置向量嵌入模型时，filemgr 可通过 semanticSearch 进行本地语义搜索');
        expect(prompt).toContain('当同时使用本地知识库和云端/服务商知识库时，回答必须明确区分信息来源');
    });
});
