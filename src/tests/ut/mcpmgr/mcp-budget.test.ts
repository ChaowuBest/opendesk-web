import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    MCP_EAGER_DEFINITION_CHAR_BUDGET,
    scaleEagerDefinitionBudget
} from '../../../main/applications/mcpmgr/mcp-catalog.js';
import { createMcpToolset } from '../../../main/applications/mcpmgr/mcp-lazy-tools.js';
import { McpMgrApplication, resolveLocalContextWindow } from '../../../main/applications/mcpmgr/app.js';
import { ModelInstance, Setting } from '../../../main/utils/setting.js';
import { ModelContextBudgets } from '../../../main/aikernel/compaction/model-context-budget.js';
import { ChatContext } from '../../../main/aikernel/messages.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import { demoTools } from './fixtures/inventory.js';

function task(model?: string): TaskState {
    return {
        chat_context: new ChatContext(),
        agentId: undefined,
        allowedTools: [],
        disabledTools: [],
        model,
        getTurnGeneration: () => 1
    } as unknown as TaskState;
}

function mockSetting(contextLength?: number) {
    const build = () =>
        contextLength === undefined
            ? new ModelInstance('test-model', 'https://example.com', 'test-key', false)
            : new ModelInstance('test-model', 'https://example.com', 'test-key', false, false, '', contextLength);
    jest.spyOn(ModelContextBudgets, 'getLearnedWindow').mockReturnValue(undefined);
    return jest.spyOn(Setting, 'getInstance').mockReturnValue({
        data: { locale: 'zh-CN' },
        getModelInstance: () => build(),
        getDefaultModelInstance: () => build()
    } as unknown as Setting);
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('scaleEagerDefinitionBudget', () => {
    test('unknown or invalid windows fall back to the baseline budget', () => {
        expect(scaleEagerDefinitionBudget(undefined)).toBe(MCP_EAGER_DEFINITION_CHAR_BUDGET);
        expect(scaleEagerDefinitionBudget(0)).toBe(MCP_EAGER_DEFINITION_CHAR_BUDGET);
        expect(scaleEagerDefinitionBudget(-70_000)).toBe(MCP_EAGER_DEFINITION_CHAR_BUDGET);
        expect(scaleEagerDefinitionBudget(Number.NaN)).toBe(MCP_EAGER_DEFINITION_CHAR_BUDGET);
    });

    test('small windows sized for the original design stay close to the baseline budget', () => {
        // 70k token 窗口是懒加载机制的原始设计目标，0.25 比例下预算仅略高于 16k 基线。
        expect(scaleEagerDefinitionBudget(70_000)).toBe(17_500);
    });

    test('large windows scale the budget linearly', () => {
        expect(scaleEagerDefinitionBudget(128_000)).toBe(32_000);
        expect(scaleEagerDefinitionBudget(200_000)).toBe(50_000);
    });

    test('huge windows are capped at 128k characters', () => {
        expect(scaleEagerDefinitionBudget(1_000_000)).toBe(128_000);
        expect(scaleEagerDefinitionBudget(10_000_000)).toBe(128_000);
    });
});

describe('createMcpToolset eagerBudget', () => {
    test('a scaled budget directly installs collections larger than the baseline', () => {
        const toolset = createMcpToolset(demoTools(), {
            task: task(),
            callTool: async () => 'ok',
            eagerBudget: 128_000
        });
        expect(toolset.getTool('mcpListTools')).toBeUndefined();
        expect(toolset.getTool('mcpActivateTools')).toBeUndefined();
        expect(toolset.tools.size).toBe(demoTools().length);
        const size = [...toolset.tools.values()].reduce((sum, tool) => sum + JSON.stringify(tool.toJSON()).length, 0);
        expect(size).toBeGreaterThan(MCP_EAGER_DEFINITION_CHAR_BUDGET);
    });

    test('the default budget still defers oversized collections', () => {
        const toolset = createMcpToolset(demoTools(), { task: task(), callTool: async () => 'ok' });
        expect(toolset.getTool('mcpListTools')).toBeDefined();
        expect(toolset.getTool('mcpActivateTools')).toBeDefined();
    });
});

describe('resolveLocalContextWindow', () => {
    test('prefers the user-configured context length', () => {
        mockSetting(200_000);
        expect(resolveLocalContextWindow('test-model')).toBe(200_000);
        expect(resolveLocalContextWindow()).toBe(200_000);
    });

    test('returns 0 when no local evidence exists instead of querying the network', () => {
        // 未配置窗口、无学习记录、模型不在内置表 → 0；getToolsets 每 turn 同步构建，绝不允许走 API。
        mockSetting(undefined);
        expect(resolveLocalContextWindow('test-model-unknown')).toBe(0);
        expect(resolveLocalContextWindow()).toBe(0);
    });

    test('returns 0 when the model instance is missing', () => {
        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getModelInstance: () => null,
            getDefaultModelInstance: () => null
        } as unknown as Setting);
        expect(resolveLocalContextWindow('test-model-unknown')).toBe(0);
        expect(resolveLocalContextWindow()).toBe(0);
    });
});

test('getToolsets scales the eager budget with the task model window', async () => {
    mockSetting(1_000_000);
    const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
    (app as any).callWorker = async (method: string) =>
        method === 'getDiscoveredTools' ? { status: 'ok', data: demoTools() } : { status: 'ok', data: '' };
    const [toolset] = await app.getToolsets(task('test-model'));
    // 1M 窗口 → 128k 预算，约 55k 的 demoTools 集合直接全量安装，不再下沉为目录。
    expect(toolset.getTool('mcpListTools')).toBeUndefined();
    expect(toolset.tools.size).toBe(demoTools().length);
});
