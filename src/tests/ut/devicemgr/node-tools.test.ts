import { jest } from '@jest/globals';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { DeviceMgrApplication } from '../../../main/applications/devicemgr/app.js';
import { createNodeExecutionToolset } from '../../../main/applications/devicemgr/node-tools.js';

function createFakeApp(
    options: {
        online?: boolean;
        running?: boolean;
        invokeResult?: unknown;
        invokeOk?: boolean;
    } = {}
) {
    const invoke = jest.fn(async () => ({
        ok: options.invokeOk !== false,
        payloadJSON: JSON.stringify(options.invokeResult ?? 'node-ok'),
        error: options.invokeOk === false ? { code: 'NODE_FAILED', message: 'node failed' } : null
    }));
    const registry = {
        get: jest.fn((nodeId: string) => (options.online === false ? undefined : { nodeId })),
        invoke
    };
    const gateway = {
        isRunning: jest.fn(() => options.running !== false),
        getNodeRegistry: jest.fn(() => registry)
    };
    const app = {
        getGateway: () => gateway
    } as unknown as DeviceMgrApplication;
    return { app, gateway, registry, invoke };
}

function createTask(commands: string[], shells: string[] = ['bash']): TaskState {
    const task = new TaskState(new TaskManagerState());
    task.workspace = '/local/workspace';
    task.harnessContext.workspace = '/local/workspace';
    task.harnessContext.executionHost = {
        type: 'node',
        nodeId: 'node-a',
        nodeLabel: 'Node A',
        capabilities: {
            nodeId: 'node-a',
            displayName: 'Node A',
            platform: 'linux',
            workspace: '/node/workspace',
            commands,
            shells,
            defaultShell: shells[0]
        }
    };
    return task;
}

function createTaskWithToolsets(toolsets: BaseToolset[]): TaskState {
    const manager = new TaskManagerState();
    manager.toolsetProvider = {
        listAvailableToolsets: async () => toolsets
    };
    return new TaskState(manager);
}

function createLocalToolset(name: string, ...toolNames: string[]): BaseToolset {
    const toolset = new BaseToolset(name);
    for (const toolName of toolNames) {
        toolset.addTool(new BaseTool(toolName, `${toolName} local tool`, z.object({})));
    }
    return toolset;
}

function namesIn(toolsets: BaseToolset[], name: string): string[] {
    return Array.from(toolsets.find((toolset) => toolset.name === name)?.tools.keys() ?? []);
}

describe('devicemgr node tools', () => {
    test('hides node tools when the task has no selected node', async () => {
        const { app } = createFakeApp();
        const localToolset = createLocalToolset('terminal', 'executeBash');
        const task = createTaskWithToolsets([localToolset, createNodeExecutionToolset(app)]);

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        expect(toolsets.some((toolset) => toolset.name === 'devicemgr-node')).toBe(false);
    });

    test('keeps local tools and exposes only node tools supported by current node commands', async () => {
        const { app } = createFakeApp();
        const terminal = createLocalToolset('terminal', 'executeBash');
        const filemgr = createLocalToolset('filemgr', 'readFile');
        const task = createTaskWithToolsets([terminal, filemgr, createNodeExecutionToolset(app)]);
        task.harnessContext.executionHost = createTask([
            'system.run',
            'fs.readText',
            'fs.writeText'
        ]).harnessContext.executionHost;

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        expect(namesIn(toolsets, 'filemgr')).toContain('readFile');
        expect(namesIn(toolsets, 'devicemgr-node')).toEqual(['executeNodeShell', 'readNodeFile', 'writeNodeFile']);
    });

    test('hides node tools when the selected node is no longer online', async () => {
        const { app } = createFakeApp({ online: false });
        const localToolset = createLocalToolset('terminal', 'executeBash');
        const task = createTaskWithToolsets([localToolset, createNodeExecutionToolset(app)]);
        task.harnessContext.executionHost = createTask(['system.run']).harnessContext.executionHost;

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        expect(toolsets.some((toolset) => toolset.name === 'devicemgr-node')).toBe(false);
    });

    test('executes shell commands through gateway node.invoke and formats shell output', async () => {
        const { app, invoke } = createFakeApp({
            invokeResult: { success: true, stdout: 'hello from node\n', stderr: '', error: null }
        });
        const task = createTask(['system.run'], ['bash', 'sh']);
        const tool = createNodeExecutionToolset(app).getTool('executeNodeShell')!;

        const result = await tool.execute(
            {
                command: 'echo hello',
                shell: 'bash',
                workingDirectory: 'src',
                timeout: 5000
            },
            undefined,
            task
        );

        expect(result.status).toBe('success');
        expect(result.result).toBe('hello from node');
        expect(invoke).toHaveBeenCalledWith({
            nodeId: 'node-a',
            command: 'system.run',
            params: {
                command: 'echo hello',
                shell: 'bash',
                cwd: 'src',
                timeoutMs: 5000
            },
            timeoutMs: 5000
        });
    });

    test('rejects shell choices not declared by the selected node', async () => {
        const { app } = createFakeApp();
        const task = createTask(['system.run'], ['powershell']);
        const tool = createNodeExecutionToolset(app).getTool('executeNodeShell')!;

        const result = await tool.execute(
            {
                command: 'echo hello',
                shell: 'bash'
            },
            undefined,
            task
        );

        expect(result.status).toBe('error');
        expect(result.result).toContain('不支持 bash shell');
    });

    test('invokes node file commands without using local filemgr tools', async () => {
        const { app, invoke } = createFakeApp({ invokeResult: '文件内容写入成功' });
        const task = createTask(['fs.writeText']);
        const tool = createNodeExecutionToolset(app).getTool('writeNodeFile')!;

        const result = await tool.execute(
            {
                path: 'notes/todo.txt',
                content: 'alpha',
                mode: 'append'
            },
            undefined,
            task
        );

        expect(result.status).toBe('success');
        expect(result.result).toBe('文件内容写入成功');
        expect(invoke).toHaveBeenCalledWith({
            nodeId: 'node-a',
            command: 'fs.writeText',
            params: {
                path: 'notes/todo.txt',
                content: 'alpha',
                mode: 'append'
            },
            timeoutMs: undefined
        });
    });
});
