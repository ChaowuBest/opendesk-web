import test from 'node:test';
import assert from 'node:assert/strict';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';
import { buildToolsetsForTask } from '../../../main/aikernel/task/tool-resolver.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { demoTools } from '../mcpmgr/fixtures/inventory.js';

test('native MCP activation survives the real task rebuild and reaches the adapter', async () => {
    const catalog = demoTools();
    const calls: unknown[][] = [];
    const application = new McpMgrApplication();
    application.setRegistry({
        callWorker: async (_bundle: string, method: string, ...args: unknown[]) => {
            if (method === 'getDiscoveredTools') return { status: 'ok', data: structuredClone(catalog) };
            calls.push(args);
            return { status: 'ok', data: 'demo reservation recorded' };
        }
    });
    const manager = new TaskManagerState();
    manager.toolsetProvider = { listAvailableToolsets: (task) => application.getToolsets(task) };
    const task = new TaskState(manager, 'demo-parent');
    task.chat_context.attachToolsets(...(await buildToolsetsForTask(task)));
    const activate = task.chat_context.getTool('mcpActivateTools');
    assert.ok(activate);
    const result = await activate.execute(
        { tools: [{ serverId: 'demo-inventory', toolName: 'reserve_stock' }] },
        undefined,
        task
    );
    assert.equal(result.status, 'success');
    assert.deepEqual(calls, []);
    task.chat_context.attachToolsets(...(await buildToolsetsForTask(task)));
    const request = OpenAIAdapter.buildToolOptions(task.chat_context) as {
        tools: { function: { name: string; parameters: object } }[];
    };
    const activatedName = JSON.parse(result.result).activated[0];
    assert.ok(request.tools.some((tool) => tool.function.name === activatedName));
    const native = task.chat_context.getTool(activatedName);
    assert.ok(native);
    assert.equal((await native.execute({ shipment: 'DEMO-17' }, undefined, task)).status, 'success');
    assert.deepEqual(calls, [['demo-inventory', 'reserve_stock', { shipment: 'DEMO-17' }]]);
    task.disabledTools = ['inventory__reserve_stock'];
    task.chat_context.attachToolsets(...(await buildToolsetsForTask(task)));
    assert.equal(task.chat_context.getTool('inventory__reserve_stock'), undefined);
    assert.ok(!task.chat_context.getTool('mcpActivateTools')!.description.includes('reserve_stock'));
});
