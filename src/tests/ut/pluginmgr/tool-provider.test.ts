import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { ChatContext, ToolCall } from '../../../main/aikernel/messages.js';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import {
    applyPluginToolDefinitions,
    PluginToolsetProvider
} from '../../../main/applications/pluginmgr/runtime/tool-provider.js';

describe('PluginToolsetProvider', () => {
    test('preserves shared tool execution capabilities when adapting a plugin tool', async () => {
        const host = new PluginHost();
        const abortController = new AbortController();
        const progress: string[] = [];
        let stopped = false;
        let permissionContext: { taskId?: string; workspace?: string; abort: AbortSignal } | undefined;
        await host.activate(
            definePlugin({
                id: 'capability-demo',
                setup(ctx) {
                    ctx.hooks.on('tool.definition', (input, output) => {
                        if (input.tool === 'capability-demo-write-report') {
                            output.description = 'adapted report writer';
                        }
                    });
                    ctx.tools.register({
                        name: 'write-report',
                        description: 'write a report',
                        parameters: z.object({ path: z.string() }),
                        agentIds: ['main'],
                        serialExecution: true,
                        getDeclaredPermissions(args, context) {
                            permissionContext = context;
                            return [{ resourceType: 'file', action: 'write', resourcePath: args.path }];
                        },
                        async execute(args, _context, result) {
                            result.attachResult(`writing ${args.path}`);
                            result.updateResultObject({ path: args.path });
                        },
                        async stop() {
                            stopped = true;
                        }
                    });
                }
            }),
            { origin: 'test:capability-demo' }
        );
        const taskState = {
            task_id: 'task-1',
            getWorkspace: () => '/workspace',
            getAbortSignal: () => abortController.signal
        } as TaskState;

        const toolsets = await new PluginToolsetProvider(host).listAvailableToolsets(taskState);
        await applyPluginToolDefinitions(toolsets, taskState, host);
        const [toolset] = toolsets;
        const tool = toolset.getTool('write-report');
        const permissions = tool?.getDeclaredPermissions({ path: '/workspace/report.md' }, taskState);
        const execution = await tool?.execute(
            { path: '/workspace/report.md' },
            (result) => progress.push(result.result),
            taskState
        );
        await tool?.stop();

        expect(tool?.agentIds).toEqual(['main']);
        expect(tool?.serialExecution).toBe(true);
        expect(tool?.description).toBe('adapted report writer');
        expect(permissions).toEqual([{ resourceType: 'file', action: 'write', resourcePath: '/workspace/report.md' }]);
        expect(permissionContext).toEqual({
            taskId: 'task-1',
            workspace: '/workspace',
            abort: abortController.signal
        });
        expect(execution).toMatchObject({
            status: 'success',
            result: 'writing /workspace/report.md',
            result_object: { path: '/workspace/report.md' }
        });
        expect(progress).toEqual(['writing /workspace/report.md', 'writing /workspace/report.md']);
        expect(stopped).toBe(true);
    });
    test('把插件工具适配成 BaseToolset', async () => {
        const host = new PluginHost();
        const abortController = new AbortController();
        let receivedAbort: AbortSignal | undefined;
        await host.activate(
            definePlugin({
                id: 'demo',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'hello tool',
                        parameters: z.object({ name: z.string() }),
                        async execute(args, context) {
                            receivedAbort = context.abort;
                            return {
                                output: `hello ${args.name}`,
                                resultObject: { greeted: args.name }
                            };
                        }
                    });
                }
            }),
            { origin: 'test:demo' }
        );

        const toolsets = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolsets[0]?.getTool('hello');
        const result = await tool?.execute({ name: 'OpenDesk' }, undefined, {
            task_id: 'task-1',
            getWorkspace: () => '/workspace',
            getAbortSignal: () => abortController.signal
        } as TaskState);

        expect(toolsets[0]?.name).toBe('plugin-demo');
        expect(`${toolsets[0]?.name}-${tool?.name}`).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(result?.result).toBe('hello OpenDesk');
        expect(result?.result_object).toEqual({ greeted: 'OpenDesk' });
        expect(receivedAbort).toBe(abortController.signal);
        const call = new ToolCall(0, 'call-1', 'plugin-demo-hello', '{"name":"OpenDesk"}');
        await expect(tool?.renderToolCall(call)).resolves.toBeUndefined();
        expect(tool?.renderToolCallCli(call, 80)).toBeUndefined();
        abortController.abort();
        expect(receivedAbort?.aborted).toBe(true);
    });

    test('tool.definition 可以改写插件工具描述', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'transformer',
                setup(ctx) {
                    ctx.hooks.on('tool.definition', (_input, output) => {
                        output.description = `transformed: ${output.description}`;
                    });
                }
            }),
            { origin: 'test:transformer' }
        );
        await host.activate(
            definePlugin({
                id: 'demo',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'hello tool',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        }
                    });
                }
            }),
            { origin: 'test:demo' }
        );

        const toolsets = await new PluginToolsetProvider(host).listAvailableToolsets();
        await applyPluginToolDefinitions(
            toolsets,
            { task_id: 'task-1', getWorkspace: () => '/workspace' } as TaskState,
            host
        );

        expect(toolsets[0]?.getTool('hello')?.description).toBe('transformed: hello tool');
    });

    test.each([
        [
            'description',
            (_input: unknown, output: any) => {
                output.description = '';
            }
        ],
        [
            'parameters',
            (_input: unknown, output: any) => {
                output.parameters = { type: 'object' };
            }
        ],
        [
            'parameters root type',
            (_input: unknown, output: any) => {
                output.parameters = z.string();
            }
        ]
    ])('tool.definition 非法 %s 输出会回滚', async (_caseName, mutate) => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'invalid-transformer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('tool.definition', mutate);
                }
            }),
            { origin: 'test:invalid-transformer' }
        );
        const originalParameters = z.object({ value: z.string() });
        const builtin = new BaseTool('builtin', 'original description', originalParameters);
        const toolset = new BaseToolset('builtin');
        toolset.addTool(builtin);

        await applyPluginToolDefinitions([toolset], undefined, host);

        expect(toolset.getTool('builtin')).toBe(builtin);
        expect(builtin.description).toBe('original description');
        expect(builtin.params).toBe(originalParameters);
        expect(host.get('invalid-transformer')?.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.hook_failed', stage: 'hook' })
        );
    });

    test('插件 ID 和工具名中的协议非法字符不会进入模型工具名称', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'demo.plugin',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello/world',
                        description: 'safe tool name',
                        parameters: z.object({}),
                        async execute() {
                            return 'safe';
                        }
                    });
                }
            }),
            { origin: 'test:safe-tool-name' }
        );

        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const [toolName] = toolset.getTools().keys();

        expect(toolset.name).toBe('plugin-demo-plugin');
        expect(toolName).toBe('hello-world');
        expect(`${toolset.name}-${toolName}`).toMatch(/^[a-zA-Z0-9_-]+$/);
        await expect(toolset.getTool(toolName)?.execute({})).resolves.toMatchObject({ result: 'safe' });
    });

    test('模型工具名只包含一次插件 ID', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'demo-plugin',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello-world',
                        description: 'hello tool',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        }
                    });
                }
            }),
            { origin: 'test:model-tool-name' }
        );

        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const chatContext = new ChatContext();
        chatContext.attachToolsets(toolset);

        expect(toolset.name).toBe('plugin-demo-plugin');
        expect([...chatContext.getTools().keys()]).toEqual(['plugin-demo-plugin-hello-world']);
        expect(chatContext.getTool('plugin-demo-plugin-hello-world')).toBe(toolset.getTool('hello-world'));
    });

    test('每个插件使用独立工具集并允许不同插件注册同名工具', async () => {
        const host = new PluginHost();
        const definitionInputs: Array<{ tool: string; pluginId?: string }> = [];
        await host.activate(
            definePlugin({
                id: 'definition-observer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('tool.definition', (input) => {
                        if (input.pluginId) definitionInputs.push({ tool: input.tool, pluginId: input.pluginId });
                    });
                }
            }),
            { origin: 'test:definition-observer' }
        );
        for (const pluginId of ['alpha-plugin', 'beta-plugin']) {
            await host.activate(
                definePlugin({
                    id: pluginId,
                    setup(ctx) {
                        ctx.tools.register({
                            name: 'inspect',
                            description: `inspect from ${pluginId}`,
                            parameters: z.object({}),
                            async execute() {
                                return pluginId;
                            }
                        });
                    }
                }),
                { origin: `test:${pluginId}` }
            );
        }

        const toolsets = await new PluginToolsetProvider(host).listAvailableToolsets();
        await applyPluginToolDefinitions(toolsets, undefined, host);
        const chatContext = new ChatContext();
        chatContext.attachToolsets(...toolsets);

        expect(toolsets.map(({ name }) => name)).toEqual(['plugin-alpha-plugin', 'plugin-beta-plugin']);
        expect(toolsets.every((toolset) => toolset.getTool('inspect'))).toBe(true);
        expect([...chatContext.getTools().keys()]).toEqual([
            'plugin-alpha-plugin-inspect',
            'plugin-beta-plugin-inspect'
        ]);
        expect(definitionInputs).toEqual([
            { tool: 'alpha-plugin-inspect', pluginId: 'alpha-plugin' },
            { tool: 'beta-plugin-inspect', pluginId: 'beta-plugin' }
        ]);
    });

    test('tool.definition 也能改写 OpenDesk 内置工具定义', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'builtin-transformer',
                setup(ctx) {
                    ctx.hooks.on('tool.definition', (input, output) => {
                        if (input.tool === 'builtin') output.description = 'changed';
                    });
                }
            }),
            { origin: 'test:builtin-transformer' }
        );
        const builtin = new BaseTool('builtin', 'original', z.object({}));
        const toolset = new BaseToolset('builtin');
        toolset.addTool(builtin);

        await applyPluginToolDefinitions(
            [toolset],
            { task_id: 'task-1', getWorkspace: () => '/workspace' } as TaskState,
            host
        );

        expect(toolset.getTool('builtin')?.description).toBe('changed');
        expect(builtin.description).toBe('original');
    });

    test('插件工具集对所有任务可用并保留执行时 workspace 上下文', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'workspace-demo',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'workspace hello',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        }
                    });
                }
            }),
            { origin: 'test:workspace-demo' }
        );
        const provider = new PluginToolsetProvider(host);

        const matching = await provider.listAvailableToolsets({
            getWorkspace: () => '/workspace/one'
        } as TaskState);
        const other = await provider.listAvailableToolsets({
            getWorkspace: () => '/workspace/two'
        } as TaskState);

        expect(matching[0]?.name).toBe('plugin-workspace-demo');
        expect(matching[0]?.getTool('hello')).toBeDefined();
        expect(other[0]?.getTool('hello')).toBeDefined();
    });

    test('使用结构化 DTO 安全渲染插件工具', async () => {
        const host = new PluginHost();
        let guiContext: unknown;
        let cliWidth: number | undefined;
        await host.activate(
            definePlugin({
                id: 'render-demo',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'inspect',
                        description: 'rendered tool',
                        parameters: z.object({ value: z.string() }),
                        async execute() {
                            return 'done';
                        },
                        render: {
                            gui(context) {
                                guiContext = context;
                                return {
                                    type: 'keyValue',
                                    items: [{ label: '<script>', value: '<img src=x onerror=alert(1)>' }]
                                };
                            },
                            cli(context) {
                                cliWidth = context.width;
                                return [`${context.status}: ${context.result}`];
                            }
                        }
                    });
                }
            }),
            { origin: 'test:render-demo' }
        );

        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolset.getTool('inspect');
        const call = new ToolCall(0, 'call-1', 'plugin-render-demo-inspect', '{"value":"demo"}');
        call.args_object = { value: 'demo' };
        call.status = 'success';
        call.result = 'done';
        call.result_object = { count: 1 };

        const html = await tool?.renderToolCall(call);
        const lines = tool?.renderToolCallCli(call, 72);

        expect(guiContext).toEqual({
            tool: 'plugin-render-demo-inspect',
            callId: 'call-1',
            status: 'success',
            args: { value: 'demo' },
            result: 'done',
            resultObject: { count: 1 }
        });
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(lines).toEqual(['success: done']);
        expect(cliWidth).toBe(72);
    });

    test('插件工具可以按运行状态声明需要用户即时关注', async () => {
        const host = new PluginHost();
        let attentionContext: unknown;
        await host.activate(
            definePlugin({
                id: 'attention-demo',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'authorize',
                        description: 'authorize an external service',
                        parameters: z.object({}),
                        async execute() {
                            return 'waiting';
                        },
                        render: {
                            requiresUserAttention(context) {
                                attentionContext = context;
                                return context.status === 'running' && context.resultObject?.phase === 'qr_code';
                            }
                        }
                    });
                }
            }),
            { origin: 'test:attention-demo' }
        );
        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolset.getTool('attention-demo-authorize');
        const call = new ToolCall(0, 'call-1', 'attention-demo-authorize', '{}');
        call.args_object = {};
        call.status = 'running';
        call.result = 'scan the code';
        call.result_object = { phase: 'qr_code' };

        expect(tool?.requiresUserAttention(call)).toBe(true);
        expect(attentionContext).toEqual({
            tool: 'attention-demo-authorize',
            callId: 'call-1',
            status: 'running',
            args: {},
            result: 'scan the code',
            resultObject: { phase: 'qr_code' }
        });

        call.status = 'success';
        expect(tool?.requiresUserAttention(call)).toBe(false);
    });

    test('未声明关注回调的插件工具会保留 fallback 推断', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'legacy-attention',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'authorize',
                        description: 'legacy authorization tool',
                        parameters: z.object({}),
                        async execute() {
                            return 'waiting';
                        }
                    });
                }
            }),
            { origin: 'test:legacy-attention' }
        );
        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolset.getTool('legacy-attention-authorize');
        const call = new ToolCall(0, 'call-legacy', 'legacy-attention-authorize', '{}');
        call.status = 'running';
        call.result_object = { ui: { requiresUserAttention: true } };
        if (tool) call.setTool(tool);

        expect(tool?.requiresUserAttention(call)).toBeUndefined();
        expect(call.requiresUserAttention()).toBe(true);
    });

    test('tool.definition 包装后保留插件 renderer', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'renderer',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'original',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        },
                        render: {
                            gui: () => ({ type: 'text', text: 'custom GUI' }),
                            cli: () => ['custom CLI']
                        }
                    });
                    ctx.hooks.on('tool.definition', (input, output) => {
                        if (input.tool === 'renderer-hello') output.description = 'changed';
                    });
                }
            }),
            { origin: 'test:renderer' }
        );
        const toolsets = await new PluginToolsetProvider(host).listAvailableToolsets();
        await applyPluginToolDefinitions(
            toolsets,
            { task_id: 'task-1', getWorkspace: () => '/workspace' } as TaskState,
            host
        );
        const tool = toolsets[0]?.getTool('hello');
        const call = new ToolCall(0, 'call-1', 'plugin-renderer-hello', '{}');

        await expect(tool?.renderToolCall(call)).resolves.toContain('custom GUI');
        expect(tool?.renderToolCallCli(call, 80)).toEqual(['custom CLI']);
    });

    test('tool.definition 包装后保留用户关注判断', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'attention-transformer',
                setup(ctx) {
                    ctx.hooks.on('tool.definition', (input, output) => {
                        if (input.tool === 'builtin') output.description = 'changed';
                    });
                }
            }),
            { origin: 'test:attention-transformer' }
        );
        const builtin = new BaseTool('builtin', 'original', z.object({}));
        builtin.requiresUserAttention = (toolCall) => toolCall.status === 'running';
        const toolset = new BaseToolset('builtin');
        toolset.addTool(builtin);

        await applyPluginToolDefinitions([toolset], undefined, host);
        const wrapped = toolset.getTool('builtin');
        const call = new ToolCall(0, 'call-1', 'builtin', '{}');
        call.status = 'running';

        expect(wrapped).not.toBe(builtin);
        expect(wrapped?.requiresUserAttention(call)).toBe(true);
    });

    test('插件 renderer 异常时回退到默认渲染', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'broken-renderer',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'broken renderer',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        },
                        render: {
                            gui() {
                                throw new Error('GUI render failed');
                            },
                            cli() {
                                throw new Error('CLI render failed');
                            }
                        }
                    });
                }
            }),
            { origin: 'test:broken-renderer' }
        );
        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolset.getTool('hello');
        const call = new ToolCall(0, 'call-1', 'plugin-broken-renderer-hello', '{}');

        await expect(tool?.renderToolCall(call)).resolves.toBeUndefined();
        expect(tool?.renderToolCallCli(call, 80)).toBeUndefined();
    });

    test('插件 CLI renderer 返回非法值时回退到默认渲染', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'invalid-renderer',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hello',
                        description: 'invalid renderer',
                        parameters: z.object({}),
                        async execute() {
                            return 'hello';
                        },
                        render: {
                            cli: (() => 'invalid') as never
                        }
                    });
                }
            }),
            { origin: 'test:invalid-renderer' }
        );
        const [toolset] = await new PluginToolsetProvider(host).listAvailableToolsets();
        const tool = toolset.getTool('hello');
        const call = new ToolCall(0, 'call-1', 'plugin-invalid-renderer-hello', '{}');

        expect(tool?.renderToolCallCli(call, 80)).toBeUndefined();
    });
});
