import { jest } from '@jest/globals';
import { createMcpToolset } from '../../../main/applications/mcpmgr/mcp-lazy-tools.js';
import { ChatContext } from '../../../main/aikernel/messages.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { MCPTool } from '../../../main/applications/mcpmgr/mcp-tool.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import { demoTools } from './fixtures/inventory.js';

function task(): TaskState {
    return {
        chat_context: new ChatContext(),
        agentId: undefined,
        allowedTools: [],
        disabledTools: [],
        getTurnGeneration: () => 1
    } as unknown as TaskState;
}

function setup(owner = task()) {
    let tools = demoTools();
    const callTool = jest.fn(async () => 'reserved');
    const options = { task: owner, callTool, loadTools: async () => structuredClone(tools) };
    const build = () => createMcpToolset(tools, options);
    owner.chat_context.attachToolsets(build());
    return {
        owner,
        callTool,
        build,
        replace: (next: typeof tools) => {
            tools = next;
        }
    };
}

const selection = { tools: [{ serverId: 'demo-inventory', toolName: 'reserve_stock' }] };

test('a non-English intent can select the visible English capability and activate its native schema', async () => {
    const { owner, callTool } = setup();
    const activate = owner.chat_context.getTool('mcpActivateTools')!;
    expect(activate.description).toContain('reserve_stock');
    expect(activate.description).toContain('Reserve inventory');
    expect(owner.chat_context.getTool('inventory__reserve_stock')).toBeUndefined();
    // 模拟模型阅读目录后选择稳定标识，不把用户语言交给字符串搜索。
    const result = await activate.execute({ ...selection, description: '为这批货预留库存' }, undefined, owner);
    expect(result.status).toBe('success');
    expect(callTool).not.toHaveBeenCalled();
    expect(result.result).not.toContain('Internal specification');
    const native = owner.chat_context.getTool('inventory__reserve_stock')!;
    expect(native).toBeInstanceOf(MCPTool);
    const definitions = JSON.stringify(OpenAIAdapter.buildToolOptions(owner.chat_context));
    expect(definitions).toContain(JSON.parse(result.result).activated[0]);
    expect(native.getJsonSchema().properties.shipment.type).toBe('string');
    const executed = await native.execute({ shipment: 'DEMO-42', description: '预留库存' }, undefined, owner);
    expect(executed.result).toBe('reserved');
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'reserve_stock' }), { shipment: 'DEMO-42' });
});

test('activation survives toolset reconstruction, refreshes definitions, and is isolated by task', async () => {
    const state = setup();
    await state.owner.chat_context.getTool('mcpActivateTools')!.execute(selection, undefined, state.owner);
    const changed = demoTools();
    changed[0].description = 'Updated reservation contract';
    state.replace(changed);
    expect(state.build().getTool('inventory__reserve_stock')?.description).toContain('Updated reservation contract');
    expect(setup().owner.chat_context.getTool('inventory__reserve_stock')).toBeUndefined();
});

test('catalog and activation respect agent scope and native tool allow/deny lists', async () => {
    const owner = task();
    owner.disabledTools = ['inventory__reserve_stock'];
    const state = setup(owner);
    expect(owner.chat_context.getTool('mcpActivateTools')!.description).not.toContain('reserve_stock');
    expect((await owner.chat_context.getTool('mcpActivateTools')!.execute(selection, undefined, owner)).status).toBe(
        'error'
    );
    const scoped = demoTools();
    scoped[0].agentIds = ['agent-private'];
    state.replace(scoped);
    expect(state.build().getTool('mcpActivateTools')!.description).not.toContain('reserve_stock');
    owner.disabledTools = [];
    owner.allowedTools = ['inventory__inspect_bin_1'];
    expect([...state.build().tools.keys()]).toEqual(['inventory__inspect_bin_1']);
});

test('unknown selections are atomic and disconnected tools cannot be activated', async () => {
    const state = setup();
    const activate = state.owner.chat_context.getTool('mcpActivateTools')!;
    const result = await activate.execute(
        { tools: [...selection.tools, { serverId: 'missing', toolName: 'missing' }] },
        undefined,
        state.owner
    );
    expect(result.status).toBe('error');
    expect(state.owner.chat_context.getTool('inventory__reserve_stock')).toBeUndefined();
    state.replace([]);
    expect((await activate.execute(selection, undefined, state.owner)).status).toBe('error');
});

test('small collections remain directly callable without discovery controls', () => {
    const toolset = createMcpToolset(demoTools(1), { task: task(), callTool: async () => 'ok' });
    expect([...toolset.tools.keys()]).toEqual(['inventory__reserve_stock']);
});

test('large catalogs have deterministic server browsing independent of user keywords', async () => {
    const owner = task();
    const toolset = createMcpToolset(demoTools(150), { task: owner, callTool: async () => 'ok' });
    const list = toolset.getTool('mcpListTools')!;
    const response = await list.execute({ serverId: 'demo-inventory', offset: 0, kind: 'tools' }, undefined, owner);
    const page = JSON.parse(response.result);
    expect(page.total).toBe(150);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.items[0].name).toBe('reserve_stock');
});

test('ordinary activation keeps the whole toolset within its definition budget', async () => {
    const state = setup();
    await state.owner.chat_context.getTool('mcpActivateTools')!.execute(selection, undefined, state.owner);
    const toolset = state.owner.chat_context.toolsets.get('mcpmgr')!;
    const size = [...toolset.tools.values()].reduce((sum, tool) => sum + JSON.stringify(tool.toJSON()).length, 0);
    expect(size).toBeLessThanOrEqual(16_000);
});

test('revoking activation while discovery is pending does not modify the task', async () => {
    const owner = task();
    const tools = demoTools();
    const initial = createMcpToolset(tools, {
        task: owner,
        callTool: async () => 'ok',
        loadTools: async () => {
            owner.disabledTools = ['mcpActivateTools'];
            return tools;
        }
    });
    owner.chat_context.attachToolsets(initial);
    const result = await initial.getTool('mcpActivateTools')!.execute(selection, undefined, owner);
    expect(result.status).toBe('error');
    expect(owner.chat_context.toolsets.get('mcpmgr')).toBe(initial);
});

test('a newer turn cannot receive an older pending activation', async () => {
    const owner = task();
    let generation = 1;
    owner.getTurnGeneration = () => generation;
    const tools = demoTools();
    const initial = createMcpToolset(tools, {
        task: owner,
        callTool: async () => 'ok',
        loadTools: async () => {
            generation++;
            return tools;
        }
    });
    owner.chat_context.attachToolsets(initial);
    expect((await initial.getTool('mcpActivateTools')!.execute(selection, undefined, owner)).status).toBe('error');
    expect(owner.chat_context.toolsets.get('mcpmgr')).toBe(initial);
});

test('single oversized definitions stay intact and oversized batches fail atomically', async () => {
    const state = setup();
    const tools = demoTools();
    tools[0].description = 'Complete contract. '.repeat(1500);
    tools[1].description = 'Another complete contract. '.repeat(1500);
    state.replace(tools);
    const initial = state.owner.chat_context.toolsets.get('mcpmgr');
    const activate = state.owner.chat_context.getTool('mcpActivateTools')!;
    const batch = await activate.execute(
        { tools: [...selection.tools, { serverId: 'demo-inventory', toolName: 'inspect_bin_1' }] },
        undefined,
        state.owner
    );
    expect(batch.status).toBe('error');
    expect(state.owner.chat_context.toolsets.get('mcpmgr')).toBe(initial);
    expect((await activate.execute(selection, undefined, state.owner)).status).toBe('success');
    expect(state.owner.chat_context.getTool('inventory__reserve_stock')!.description).toContain(tools[0].description);
    const next = state.owner.chat_context.getTool('mcpActivateTools')!;
    await next.execute({ tools: [{ serverId: 'demo-inventory', toolName: 'inspect_bin_1' }] }, undefined, state.owner);
    expect(state.owner.chat_context.getTool('inventory__reserve_stock')).toBeUndefined();
    expect(state.owner.chat_context.getTool('inventory__inspect_bin_1')).toBeDefined();
});

test('fresh directory reads remove disconnected entries without stale fallback', async () => {
    const state = setup();
    const list = state.owner.chat_context.getTool('mcpListTools')!;
    state.replace([]);
    const result = await list.execute({ kind: 'tools', offset: 0 }, undefined, state.owner);
    expect(JSON.parse(result.result).items).toEqual([]);
});
