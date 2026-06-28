import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { DeviceMgrApplication } from '../../../main/applications/devicemgr/app.js';
import { createNodeExecutionTools } from '../../../main/applications/devicemgr/node-tools.js';

function createFakeApp(
    options: {
        online?: boolean;
        running?: boolean;
        invokeResult?: unknown;
        invokeOk?: boolean;
        newNodeCommands?: string[];
        /** 多节点模式：提供完整节点属性（用于显式 nodeId 测试） */
        multiNodes?: Array<{
            nodeId: string;
            displayName?: string;
            platform?: string;
            workspace?: string;
            commands: string[];
            shells?: string[];
            defaultShell?: string;
        }>;
    } = {}
) {
    const invoke = jest.fn(async () => ({
        ok: options.invokeOk !== false,
        payloadJSON: JSON.stringify(options.invokeResult ?? 'node-ok'),
        error: options.invokeOk === false ? { code: 'NODE_FAILED', message: 'node failed' } : null
    }));
    const defaultCommands = options.newNodeCommands ?? [
        'system.run',
        'fs.readText',
        'fs.writeText',
        'file.fetch',
        'file.write',
        'fs.editText',
        'fs.searchReplace',
        'fs.glob',
        'fs.grep'
    ];
    const connectedNodes =
        options.online === false
            ? []
            : (options.multiNodes ?? [
                  {
                      nodeId: 'node-a',
                      commands: defaultCommands,
                      displayName: 'Node A',
                      platform: 'linux',
                      workspace: '/node/workspace',
                      shells: ['bash'],
                      defaultShell: 'bash'
                  }
              ]);
    const registry = {
        get: jest.fn((nodeId: string) => {
            if (options.online === false) return undefined;
            if (options.multiNodes) {
                return options.multiNodes.find((n) => n.nodeId === nodeId);
            }
            return nodeId === 'node-a' ? connectedNodes[0] : undefined;
        }),
        invoke,
        listConnected: jest.fn(() => connectedNodes)
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

function createNodeToolset(app: DeviceMgrApplication): BaseToolset {
    const toolset = new BaseToolset('devicemgr');
    toolset.addTools(...createNodeExecutionTools(app));
    return toolset;
}

function namesIn(toolsets: BaseToolset[], name: string): string[] {
    return Array.from(toolsets.find((toolset) => toolset.name === name)?.tools.keys() ?? []);
}

function createToolCall(toolName: string, args: Record<string, unknown>, result: string = 'ok'): ToolCall {
    const toolCall = new ToolCall(0, `${toolName}-call`, toolName, JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.status = 'success';
    toolCall.result = result;
    return toolCall;
}

describe('devicemgr node tools', () => {
    test('exposes node tools when connected nodes exist (even without selected node)', async () => {
        const { app } = createFakeApp();
        const localToolset = createLocalToolset('terminal', 'executeBash');
        const task = createTaskWithToolsets([localToolset, createNodeToolset(app)]);

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        // 新行为：有已连接节点时即暴露 node 工具，不依赖 executionHost 选中状态
        expect(toolsets.some((toolset) => toolset.name === 'devicemgr')).toBe(true);
    });

    test('keeps local tools and exposes only node tools supported by current node commands', async () => {
        const { app } = createFakeApp();
        const terminal = createLocalToolset('terminal', 'executeBash');
        const filemgr = createLocalToolset('filemgr', 'readFile');
        const task = createTaskWithToolsets([terminal, filemgr, createNodeToolset(app)]);
        task.harnessContext.executionHost = createTask([
            'system.run',
            'fs.readText',
            'fs.writeText'
        ]).harnessContext.executionHost;

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        expect(namesIn(toolsets, 'filemgr')).toContain('readFile');
        expect(namesIn(toolsets, 'devicemgr')).toEqual([
            'executeNodeShell',
            'readNodeFile',
            'writeNodeFile',
            'sendNodeFile',
            'fetchNodeFile',
            'editNodeFile',
            'searchReplaceNodeFile',
            'globNodeFiles',
            'grepNodeFiles'
        ]);
    });

    test('hides node tools when the selected node is no longer online', async () => {
        const { app } = createFakeApp({ online: false });
        const localToolset = createLocalToolset('terminal', 'executeBash');
        const task = createTaskWithToolsets([localToolset, createNodeToolset(app)]);
        task.harnessContext.executionHost = createTask(['system.run']).harnessContext.executionHost;

        const toolsets = await task.buildToolsets();

        expect(namesIn(toolsets, 'terminal')).toContain('executeBash');
        expect(toolsets.some((toolset) => toolset.name === 'devicemgr')).toBe(false);
    });

    test('executes shell commands through gateway node.invoke and formats shell output', async () => {
        const { app, invoke } = createFakeApp({
            invokeResult: { success: true, stdout: 'hello from node\n', stderr: '', error: null }
        });
        const task = createTask(['system.run'], ['bash', 'sh']);
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;

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
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;

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
        const tool = createNodeToolset(app).getTool('writeNodeFile')!;

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

    test('sends a local gateway file to node with file.write payload and sha256', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-node-send-'));
        try {
            const sourcePath = path.join(tempDir, 'script.py');
            const source = Buffer.from('print("hello node")\n', 'utf8');
            fs.writeFileSync(sourcePath, source);
            const sha256 = crypto.createHash('sha256').update(source).digest('hex');
            const { app, invoke } = createFakeApp({
                invokeResult: {
                    ok: true,
                    path: '/tmp/script.py',
                    size: source.byteLength,
                    sha256,
                    overwritten: false
                }
            });
            const task = createTask(['file.write']);
            const tool = createNodeToolset(app).getTool('sendNodeFile')!;

            const result = await tool.execute(
                {
                    localPath: sourcePath,
                    path: '/tmp/script.py',
                    createParents: true,
                    overwrite: true
                },
                undefined,
                task
            );

            expect(result.status).toBe('success');
            const parsed = JSON.parse(result.result);
            expect(parsed).toEqual(
                expect.objectContaining({
                    ok: true,
                    nodeId: 'node-a',
                    path: '/tmp/script.py',
                    size: source.byteLength,
                    sha256,
                    source: 'localPath',
                    sourcePath: sourcePath.replace(/\\/g, '/')
                })
            );
            expect(invoke).toHaveBeenCalledWith({
                nodeId: 'node-a',
                command: 'file.write',
                params: {
                    path: '/tmp/script.py',
                    contentBase64: source.toString('base64'),
                    overwrite: true,
                    createParents: true,
                    expectedSha256: sha256
                },
                timeoutMs: undefined
            });
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('fetches a node file to local gateway path and records mediaId', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-node-fetch-'));
        try {
            const localPath = path.join(tempDir, 'fetched.bin');
            const remote = Buffer.from([0, 1, 2, 3, 4]);
            const sha256 = crypto.createHash('sha256').update(remote).digest('hex');
            const { app, invoke } = createFakeApp({
                invokeResult: {
                    ok: true,
                    path: '/remote/fetched.bin',
                    size: remote.byteLength,
                    mimeType: 'application/octet-stream',
                    base64: remote.toString('base64'),
                    sha256
                }
            });
            const task = createTask(['file.fetch']);
            const tool = createNodeToolset(app).getTool('fetchNodeFile')!;

            const result = await tool.execute(
                {
                    path: '/remote/fetched.bin',
                    localPath
                },
                undefined,
                task
            );

            expect(result.status).toBe('success');
            const parsed = JSON.parse(result.result);
            expect(parsed).toEqual(
                expect.objectContaining({
                    ok: true,
                    nodeId: 'node-a',
                    path: '/remote/fetched.bin',
                    size: remote.byteLength,
                    mimeType: 'application/octet-stream',
                    sha256,
                    localPath: localPath.replace(/\\/g, '/')
                })
            );
            expect(parsed.mediaId).toMatch(/^node-file-/);
            expect(fs.readFileSync(localPath)).toEqual(remote);
            expect(invoke).toHaveBeenCalledWith({
                nodeId: 'node-a',
                command: 'file.fetch',
                params: {
                    path: '/remote/fetched.bin',
                    maxBytes: 8 * 1024 * 1024
                },
                timeoutMs: undefined
            });

            fs.writeFileSync(localPath, Buffer.from('mutated local export', 'utf8'));
            const sendApp = createFakeApp({
                invokeResult: {
                    ok: true,
                    path: '/remote/copy.bin',
                    size: remote.byteLength,
                    sha256,
                    overwritten: false
                }
            });
            const sendTool = createNodeToolset(sendApp.app).getTool('sendNodeFile')!;
            const sendResult = await sendTool.execute(
                {
                    sourceMediaId: parsed.mediaId,
                    path: '/remote/copy.bin'
                },
                undefined,
                createTask(['file.write'])
            );
            expect(sendResult.status).toBe('success');
            expect(sendApp.invoke).toHaveBeenCalledWith({
                nodeId: 'node-a',
                command: 'file.write',
                params: {
                    path: '/remote/copy.bin',
                    contentBase64: remote.toString('base64'),
                    overwrite: false,
                    createParents: false,
                    expectedSha256: sha256
                },
                timeoutMs: undefined
            });
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('does not mutate tool args or result object with render-only node metadata', async () => {
        const { app } = createFakeApp({
            invokeResult: { success: true, stdout: 'hello\n', stderr: '', error: null }
        });
        const task = createTask(['system.run']);
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;
        const args = {
            command: 'echo hello',
            shell: 'bash'
        };

        const result = await tool.execute(args, undefined, task);

        expect(result.status).toBe('success');
        expect(result.result_object).toBeUndefined();
        expect(args).toEqual({
            command: 'echo hello',
            shell: 'bash'
        });
    });

    test('renders executeNodeShell in cli and gui as a node shell tool', async () => {
        const { app } = createFakeApp();
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;
        const toolCall = createToolCall(
            'executeNodeShell',
            {
                command: 'echo hello',
                shell: 'bash',
                workingDirectory: '/remote/workspace'
            },
            'hello'
        );

        const html = await tool.renderToolCall(toolCall);
        const cli = tool.renderToolCallCli(toolCall, 100)?.join('\n') ?? '';

        expect(html).toContain('>node</span>');
        expect(html).toContain('<rect x="3" y="3" width="18" height="18" rx="2"/>');
        expect(html).not.toContain('fa-terminal');
        expect(html).not.toContain('(node)');
        expect(html).toContain('echo hello');
        expect(cli).toContain('Bash node');
        expect(cli).not.toContain('(node)');
        expect(cli).toContain('echo hello');
    });

    test('renders node read and write file tools without local editor affordances', async () => {
        const { app } = createFakeApp();
        const toolset = createNodeToolset(app);
        const readTool = toolset.getTool('readNodeFile')!;
        const writeTool = toolset.getTool('writeNodeFile')!;
        const readCall = createToolCall(
            'readNodeFile',
            {
                path: 'src/index.ts',
                offset: 2,
                limit: 3
            },
            JSON.stringify({
                type: 'text',
                file: {
                    totalLines: 10,
                    numLines: 3,
                    startLine: 2
                }
            })
        );
        const writeCall = createToolCall(
            'writeNodeFile',
            {
                path: 'notes/todo.txt',
                content: 'alpha\nbeta',
                mode: 'append'
            },
            '文件内容追加成功'
        );

        const readHtml = await readTool.renderToolCall(readCall);
        const writeHtml = await writeTool.renderToolCall(writeCall);
        const readCli = readTool.renderToolCallCli(readCall, 100)?.join('\n') ?? '';
        const writeCli = writeTool.renderToolCallCli(writeCall, 100)?.join('\n') ?? '';

        expect(readHtml).toContain('>node</span>');
        expect(readHtml).toContain('src/index.ts');
        expect(readHtml).not.toContain('data-open-editor');
        expect(readHtml).not.toContain('(node)');
        expect(writeHtml).toContain('>node</span>');
        expect(writeHtml).toContain('notes/todo.txt');
        expect(writeHtml).not.toContain('data-open-editor');
        expect(writeHtml).not.toContain('(node)');
        expect(readCli).toContain('node');
        expect(writeCli).toContain('node');
        expect(readCli).not.toContain('(node)');
        expect(writeCli).not.toContain('(node)');
    });

    test('renders node edit and search-replace tools with diff cards', async () => {
        const { app } = createFakeApp();
        const toolset = createNodeToolset(app);
        const editTool = toolset.getTool('editNodeFile')!;
        const replaceTool = toolset.getTool('searchReplaceNodeFile')!;
        const editCall = createToolCall('editNodeFile', {
            filePath: 'src/app.ts',
            oldString: 'const a = 1;',
            newString: 'const a = 2;'
        });
        const replaceCall = createToolCall('searchReplaceNodeFile', {
            filePath: 'src/app.ts',
            oldString: 'hello',
            newString: 'world'
        });

        const editHtml = await editTool.renderToolCall(editCall);
        const replaceHtml = await replaceTool.renderToolCall(replaceCall);
        const editCli = editTool.renderToolCallCli(editCall, 100)?.join('\n') ?? '';
        const replaceCli = replaceTool.renderToolCallCli(replaceCall, 100)?.join('\n') ?? '';

        expect(editHtml).toContain('>node</span>');
        expect(editHtml).toContain('src/app.ts');
        expect(editHtml).toContain('+');
        expect(editHtml).not.toContain('(node)');
        expect(replaceHtml).toContain('>node</span>');
        expect(replaceHtml).toContain('src/app.ts');
        expect(replaceHtml).not.toContain('(node)');
        expect(editCli).toContain('node');
        expect(replaceCli).toContain('node');
        expect(editCli).not.toContain('(node)');
        expect(replaceCli).not.toContain('(node)');
    });

    test('renders node glob and grep tools with search summaries', async () => {
        const { app } = createFakeApp();
        const toolset = createNodeToolset(app);
        const globTool = toolset.getTool('globNodeFiles')!;
        const grepTool = toolset.getTool('grepNodeFiles')!;
        const globCall = createToolCall(
            'globNodeFiles',
            {
                pattern: '**/*.ts',
                path: 'src'
            },
            '找到 2 个文件:\nsrc/a.ts\nsrc/b.ts'
        );
        const grepCall = createToolCall(
            'grepNodeFiles',
            {
                pattern: 'TODO',
                path: 'src',
                filePattern: '**/*.ts'
            },
            '在 1 个文件中找到 2 处匹配:\n> src/a.ts:1:1: TODO one\n> src/a.ts:2:1: TODO two'
        );

        const globHtml = await globTool.renderToolCall(globCall);
        const grepHtml = await grepTool.renderToolCall(grepCall);
        const globCli = globTool.renderToolCallCli(globCall, 100)?.join('\n') ?? '';
        const grepCli = grepTool.renderToolCallCli(grepCall, 100)?.join('\n') ?? '';

        expect(globHtml).toContain('>node</span>');
        expect(globHtml).toContain('2 个文件');
        expect(globHtml).not.toContain('(node)');
        expect(grepHtml).toContain('>node</span>');
        expect(grepHtml).toContain('1 文件 / 2 处匹配');
        expect(grepHtml).not.toContain('(node)');
        expect(globCli).toContain('node');
        expect(grepCli).toContain('node');
        expect(globCli).not.toContain('(node)');
        expect(grepCli).not.toContain('(node)');
    });

    test('routes to explicit nodeId when specified, bypassing selected node', async () => {
        const { app, invoke } = createFakeApp({
            invokeResult: 'node-b-ok',
            multiNodes: [
                { nodeId: 'node-a', commands: ['system.run'], displayName: 'Node A' },
                { nodeId: 'node-b', commands: ['system.run'], displayName: 'Node B' }
            ]
        });
        const task = createTask(['system.run']);
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;

        const result = await tool.execute({ command: 'echo hello', nodeId: 'node-b' }, undefined, task);

        expect(result.status).toBe('success');
        expect(result.result).toBe('node-b-ok');
        expect(invoke).toHaveBeenCalledWith({
            nodeId: 'node-b',
            command: 'system.run',
            params: { command: 'echo hello', shell: 'auto', cwd: undefined, timeoutMs: 30000 },
            timeoutMs: 30000
        });
    });

    test('throws when explicit nodeId is not connected', async () => {
        const { app } = createFakeApp({
            multiNodes: [{ nodeId: 'node-a', commands: ['system.run'], displayName: 'Node A' }]
        });
        const task = createTask(['system.run']);
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;

        const result = await tool.execute({ command: 'echo hello', nodeId: 'node-unknown' }, undefined, task);

        expect(result.status).toBe('error');
        expect(result.result).toContain('未连接');
    });

    test('throws when explicit nodeId does not support the command', async () => {
        const { app } = createFakeApp({
            multiNodes: [
                { nodeId: 'node-a', commands: ['system.run'], displayName: 'Node A' },
                { nodeId: 'node-b', commands: ['fs.readText'], displayName: 'Node B' }
            ]
        });
        const task = createTask(['system.run']);
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;

        const result = await tool.execute({ command: 'echo hello', nodeId: 'node-b' }, undefined, task);

        expect(result.status).toBe('error');
        expect(result.result).toContain('不支持');
    });

    test('renders nodeId in tool call display when specified', async () => {
        const { app } = createFakeApp();
        const tool = createNodeToolset(app).getTool('executeNodeShell')!;
        const toolCall = createToolCall(
            'executeNodeShell',
            { command: 'echo hello', shell: 'bash', nodeId: 'node-b' },
            'hello from node-b'
        );

        const html = await tool.renderToolCall(toolCall);
        const cli = tool.renderToolCallCli(toolCall, 100)?.join('\n') ?? '';

        expect(html).toContain('>node-b</span>');
        expect(cli).toContain('Bash [node-b]');
    });
});
