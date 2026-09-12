import path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { KnowledgeAgentDecl } from '../../../main/aikernel/agents/knowledge/agent.js';
import { KNOWLEDGE_AGENT_DEFAULT_MODE } from '../../../main/aikernel/agents/knowledge/modes/default.js';
import type { TaskContext } from '../../../main/aikernel/agents/common.js';
import { Setting } from '../../../main/utils/setting.js';
import { createCriticalPathRules } from '../../../main/utils/permissionRules.js';
import { normalizePath } from '../../../utils/path.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { CreateSubTaskTool } from '../../../main/aikernel/planning/tools.js';
import { SemanticSearchTool, createFileManagerToolset } from '../../../main/applications/filemgr/tools.js';

const SOURCE_ROOT = path.join(process.cwd(), 'knowledge-source');

function makeContext(): TaskContext {
    return {
        task_id: 'knowledge-test',
        task_name: 'Knowledge test',
        getWorkspace: () => '/workspace'
    };
}

function mockRawFileMgrConfig(config: unknown, embeddingModel: unknown = {}): void {
    const realSetting = Setting.getInstance();
    jest.spyOn(realSetting, 'getApplicationConfig').mockImplementation(
        (applicationName: string) => (applicationName === 'filemgr' ? config : undefined) as never
    );
    jest.spyOn(realSetting, 'getDefaultEmbeddingModelInstance').mockImplementation(() => embeddingModel as never);
}

function mockFileMgrConfig(enabled: boolean, roots: string[], embeddingModel: unknown = {}): void {
    mockRawFileMgrConfig(
        {
            enabled,
            entries: roots.map((root) => ({ root }))
        },
        embeddingModel
    );
}

const KNOWLEDGE_REPORT = `## 检索结论
结论 A

## 证据边界
本报告仅依据 semanticSearch 返回的索引片段，未读取或核实完整原文。`;

function createFileMgrToolsetWithSemanticSearch() {
    const filemgr = createFileManagerToolset();
    filemgr.addTool(
        new SemanticSearchTool(async (query) => ({
            query,
            results: [],
            totalHits: 0
        }))
    );
    return filemgr;
}

function appendSyntheticKnowledgeCompletion(task: TaskState): void {
    const args = {
        type: 'success' as const,
        message: KNOWLEDGE_REPORT
    };
    const toolCall = new ToolCall(0, 'knowledge-completion', 'planning-attemptCompletion', JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.status = 'success';

    const part = new ToolCallMessagePart();
    part.toolcalls.push(toolCall);
    task.chat_context.appendMessage(new AssistantMessage([part]));
    task.task_status = 'stopped';
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('KnowledgeAgent default mode', () => {
    test('exposes exactly semanticSearch and attemptCompletion', () => {
        expect(KNOWLEDGE_AGENT_DEFAULT_MODE.allowedTools).toEqual(['semanticSearch', 'attemptCompletion']);
        expect(KNOWLEDGE_AGENT_DEFAULT_MODE.disabledTools).toBeUndefined();
    });

    test('permissionFactory returns only the existing ask-only critical path rules', () => {
        const rules = KNOWLEDGE_AGENT_DEFAULT_MODE.permissionFactory('/workspace');

        expect(rules).toEqual(createCriticalPathRules());
    });
});

describe('KnowledgeAgent declaration and prompt', () => {
    test('declares Knowledge metadata and a single default mode', () => {
        const agent = new KnowledgeAgentDecl();

        expect(agent.agentName).toBe('knowledge');
        expect(agent.dispatchable).toBe(true);
        expect(agent.agentType).toBe('builtin');
        expect(agent.supportedModes()).toEqual([KNOWLEDGE_AGENT_DEFAULT_MODE]);
        expect(agent.defaultModeId()).toBe('default');
        expect(agent.whenToUse).toContain('本地知识库');
        expect(agent.whenToUse).toContain('不适用于');
    });

    test('uses direct, natural instructions instead of framework-oriented prompt language', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('你负责帮 Main 从本地知识库找资料');
        expect(prompt).toContain('先判断这件事是否真的需要本地资料');
        expect(prompt).toContain('等这次搜索结果回来后，再决定是否查下一个主题');
        expect(prompt).not.toContain('AssistantMessage');
        expect(prompt).not.toContain('ToolResult');
        expect(prompt).not.toContain('第一阶段');
        expect(prompt).not.toContain('第二阶段');
        expect(prompt).not.toContain('第三阶段');
        expect(prompt).not.toContain('初始报告结构（v0，可实践校准）');
        expect(prompt).not.toContain('本设计假定');
        expect(prompt).not.toContain('clean 返回候选');
        expect(prompt).not.toContain('fatal 状态');
    });

    test('contains the stable retrieval and evidence boundaries for configured sources', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain(normalizePath(SOURCE_ROOT));
        expect(prompt).toContain('filemgr-semanticSearch');
        expect(prompt).toContain('planning-attemptCompletion');
        expect(prompt).toContain('semanticSearch 返回的片段');
        expect(prompt).toContain('不能直接读取或核对完整文件');
        expect(prompt).toContain('不要让 Main 替你读取全文');
        expect(prompt).toContain('每个主题只搜索一次');
        expect(prompt).toContain('不要为同一个主题改写 query');
        expect(prompt).toContain('来源');
        expect(prompt).toContain('证据片段');
        expect(prompt).toContain('证据边界');
    });

    test('contains the non-query and unavailable-source branches when sources are disabled', async () => {
        mockFileMgrConfig(false, []);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('目前没有可用的 filemgr 数据源');
        expect(prompt).toContain('先判断这件事是否真的需要本地资料');
        expect(prompt).toContain('无需知识库检索，请 Main Agent 处理');
        expect(prompt).toContain("type='fail'");
    });

    test('instructs fail-fast when semanticSearch is not mounted without an embedding model', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT], null);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('没有配置向量嵌入模型');
        expect(prompt).toContain('semanticSearch 工具当前没有挂载');
        expect(prompt).toContain('你只有一个工具');
        expect(prompt).not.toContain('filemgr-semanticSearch');
    });

    test.each([
        ['non-array entries', { enabled: true, entries: 'invalid' }],
        ['invalid entry roots', { enabled: true, entries: [null, { root: '   ' }, { root: 123 }] }]
    ])('treats %s as no available sources', async (_caseName, config) => {
        mockRawFileMgrConfig(config);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('目前没有可用的 filemgr 数据源');
        expect(prompt).not.toContain(normalizePath(SOURCE_ROOT));
    });

    test('treats enabled=false with a valid non-empty root as no available sources (enabled gate)', async () => {
        mockFileMgrConfig(false, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('目前没有可用的 filemgr 数据源');
        expect(prompt).not.toContain(normalizePath(SOURCE_ROOT));
    });

    test('states the per-message serial semanticSearch ordering contract', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('一次只调用一个 semanticSearch');
        expect(prompt).toContain('搜索和 attemptCompletion 不要放在同一条消息里');
        expect(prompt).toContain('等这次搜索结果回来后，再决定是否查下一个主题');
        expect(prompt).toContain('需要马上停止，不再搜索剩余主题');
        expect(prompt).toContain('单独调用一次 planning-attemptCompletion');
    });

    test('separates the evidence and no-evidence report branches without fabricating sources', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('每个真正支持、限制或反驳结论的来源都要保留');
        expect(prompt).toContain('没有内容的部分写“无”，但不要编造来源或证据');
        expect(prompt).toContain('所有搜索都正常完成但没有候选时');
        expect(prompt).toContain('不要推断知识库里不存在答案');
    });

    test('keeps already-obtained evidence when a later topic hits fatal or warning', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain("type='fail' 只表示本次检索没有完整完成，不代表前面找到的证据要丢掉");
        expect(prompt).toContain('前面已经找到的候选、证据和来源仍然要保留');
        expect(prompt).toContain('这次出错的搜索如果也带回了候选，同样要保留');
        expect(prompt).toContain('不要声称“未获得任何候选”');
        expect(prompt).toContain('一个结论有多个来源时，不要只挑一个代表');
        expect(prompt).toContain('有候选但片段不够，只能说证据不足');
    });

    test('states the fatal-stop, non-fatal-continue, no-scope and single-completion contracts', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const prompt = await new KnowledgeAgentDecl().createSystemPrompt(KNOWLEDGE_AGENT_DEFAULT_MODE, makeContext());

        expect(prompt).toContain('需要马上停止，不再搜索剩余主题');
        expect(prompt).toContain('只要出现上面列出的停止错误');
        expect(prompt).toContain('INITIAL_SCAN');
        expect(prompt).toContain('SEARCH_PARTIAL');
        expect(prompt).toContain('SEMANTIC_PARTIAL');
        expect(prompt).toContain('不要重试当前主题');
        expect(prompt).toContain('继续处理之前已经列出的其他主题');
        expect(prompt).toContain('不传 scope');
        expect(prompt).toContain('单独调用一次 planning-attemptCompletion');
    });
});

describe('KnowledgeAgent task plumbing', () => {
    test('filters a child TaskState to semanticSearch and attemptCompletion', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [createFileMgrToolsetWithSemanticSearch()]
        };
        jest.spyOn(manager, 'save').mockImplementation(() => {});

        const parent = new TaskState(manager);
        manager.tasks.push(parent);
        const child = manager.createSubTask(parent.task_id);
        child.allowedTools = [...(KNOWLEDGE_AGENT_DEFAULT_MODE.allowedTools ?? [])];

        const toolsets = await child.buildToolsets();
        const toolNames = toolsets
            .flatMap((toolset) => [...toolset.tools.keys()].map((toolName) => `${toolset.name}-${toolName}`))
            .sort();

        expect(toolNames).toEqual(['filemgr-semanticSearch', 'planning-attemptCompletion']);
    });

    test('buildToolsets gates semanticSearch on the configured embedding model', async () => {
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [createFileMgrToolsetWithSemanticSearch()]
        };
        jest.spyOn(manager, 'save').mockImplementation(() => {});
        const task = new TaskState(manager);
        manager.tasks.push(task);

        mockFileMgrConfig(true, [SOURCE_ROOT], null);
        expect((await task.buildToolsets()).flatMap((toolset) => [...toolset.tools.keys()])).not.toContain(
            'semanticSearch'
        );

        mockFileMgrConfig(true, [SOURCE_ROOT]);
        expect((await task.buildToolsets()).flatMap((toolset) => [...toolset.tools.keys()])).toContain(
            'semanticSearch'
        );
    });

    test('wires a looked-up Knowledge declaration into a child TaskState and propagates a synthetic completion report', async () => {
        mockFileMgrConfig(true, [SOURCE_ROOT]);
        const getAgentSpy = jest
            .spyOn(AgentRegistry, 'getAgent')
            .mockImplementation((name) => (name === 'knowledge' ? new KnowledgeAgentDecl() : undefined));

        const manager = new TaskManagerState();
        jest.spyOn(manager, 'save').mockImplementation(() => {});

        const parent = new TaskState(manager);
        parent.harnessContext.workspace = '/workspace';
        manager.tasks.push(parent);

        const submitSpy = jest.spyOn(TaskState.prototype, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
        jest.spyOn(TaskState.prototype, 'waitUntilFinished').mockImplementation(async function (this: TaskState) {
            appendSyntheticKnowledgeCompletion(this);
        });

        const result = await new CreateSubTaskTool().execute(
            {
                title: '查找项目政策',
                objective: '从本地知识库检索项目政策，并归纳证据',
                criteria: '返回结论、来源和 semanticSearch 证据片段',
                isAsync: false,
                agentName: 'knowledge'
            },
            undefined,
            parent
        );

        expect(result.status).toBe('success');
        const payload = JSON.parse(result.result);
        expect(payload.success).toBe(true);
        expect(payload.status).toBe('success');
        expect(payload.result).toContain('## 检索结论');
        expect(payload.result).toContain('semanticSearch 返回的索引片段');
        expect(getAgentSpy).toHaveBeenCalledWith('knowledge');
        expect(submitSpy).toHaveBeenCalledTimes(1);
        expect(submitSpy.mock.calls[0]?.[0]).toContain('从本地知识库检索项目政策，并归纳证据');

        const child = manager.tasks.find((task) => task.parent_id === parent.task_id);
        expect(child?.task_name).toBe('查找项目政策');
        expect(child?.allowedTools).toEqual(['semanticSearch', 'attemptCompletion']);
        expect(child?.chat_context.system_prompt?.content).toContain('帮 Main 从本地知识库找资料');
    });
});
