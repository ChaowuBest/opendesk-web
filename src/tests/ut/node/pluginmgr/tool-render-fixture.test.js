import assert from 'node:assert/strict';
import test from 'node:test';

import plugin from '../../../../../plugin-test/tool-render-plugin/index.mjs';

function registerFixtureTool() {
    let definition;
    plugin.setup({
        tools: {
            register(value) {
                definition = value;
                return { async dispose() {} };
            }
        }
    });
    assert.ok(definition);
    return definition;
}

function createResultWriter() {
    return {
        output: '',
        resultObject: undefined,
        attachResult(chunk) {
            this.output += chunk;
        },
        updateResult(output) {
            this.output = output;
        },
        updateResultObject(resultObject) {
            this.resultObject = resultObject;
        }
    };
}

test('tool renderer fixture exercises the shared OpenDesk tool contract', async () => {
    const definition = registerFixtureTool();
    const abortController = new AbortController();
    const context = {
        taskId: 'task-fixture',
        workspace: 'D:/workspace',
        abort: abortController.signal
    };

    assert.deepEqual(definition.agentIds, ['main']);
    assert.equal(definition.serialExecution, true);
    assert.deepEqual(definition.getDeclaredPermissions({ requirePermission: false }, context), []);
    assert.deepEqual(
        definition.getDeclaredPermissions({ requirePermission: true, permissionPath: 'permission-demo' }, context),
        [{ resourceType: 'plugin', action: 'execute', resourcePath: 'tool-render/permission-demo' }]
    );

    const result = createResultWriter();
    await definition.execute(
        {
            mode: 'keyValue',
            title: 'Contract test',
            value: 'fixture value',
            language: 'text',
            delayMs: 0,
            requirePermission: false,
            permissionPath: 'permission-demo'
        },
        context,
        result
    );

    assert.match(result.output, /phase 1\/3/);
    assert.match(result.output, /phase 2\/3/);
    assert.match(result.output, /phase 3\/3/);
    assert.deepEqual(result.resultObject, {
        executionId: 1,
        phase: 'completed',
        mode: 'keyValue',
        title: 'Contract test',
        value: 'fixture value',
        taskId: 'task-fixture',
        workspace: 'D:/workspace',
        activeExecutions: 1,
        serialExecution: true,
        agentIds: ['main']
    });
});

test('tool renderer fixture stops an active execution', async () => {
    const definition = registerFixtureTool();
    const result = createResultWriter();
    const execution = definition.execute(
        {
            mode: 'text',
            title: 'Stop test',
            value: 'waiting',
            language: 'text',
            delayMs: 5_000,
            requirePermission: false,
            permissionPath: 'permission-demo'
        },
        {
            taskId: 'task-stop',
            workspace: 'D:/workspace',
            abort: new AbortController().signal
        },
        result
    );

    await new Promise((resolve) => setImmediate(resolve));
    await definition.stop();

    await assert.rejects(execution, { name: 'AbortError' });
});
