import { z } from 'zod';
import { PluginHookError, PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

describe('PluginHost', () => {
    test('JavaScript 插件注册未知 hook 名时激活失败', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'unknown-hook',
                capabilities: ['hook'],
                setup(ctx) {
                    const on = ctx.hooks.on as unknown as (name: string, callback: () => void) => void;
                    on('chat.message', () => {});
                }
            }),
            { origin: 'test:unknown-hook' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'plugin.setup_failed',
                    detail: 'plugin.hook_unknown:chat.message'
                })
            ])
        );
    });

    test.each([
        [
            'Hook callback',
            ['hook'],
            (ctx: any) => ctx.hooks.on('chat.headers', 'not-a-function'),
            'plugin.hook_callback_invalid:chat.headers'
        ],
        [
            'Command execute',
            ['command'],
            (ctx: any) =>
                ctx.commands.register({ name: 'broken-command', description: 'Broken command', execute: 'invalid' }),
            'plugin.command_execute_invalid:broken-command'
        ],
        [
            'Event callback',
            ['event'],
            (ctx: any) => ctx.events.onApplication({}, 'not-a-function'),
            'plugin.event_callback_invalid'
        ],
        [
            'Skill body',
            ['skill'],
            (ctx: any) => ctx.skills.register({ name: 'broken-skill', description: 'Broken skill', body: 42 }),
            'plugin.skill_body_invalid:broken-skill'
        ]
    ])('启用阶段拒绝无效注册回调或必要字段：%s', async (_caseName, capabilities, register, expectedError) => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'invalid-registration',
                capabilities: capabilities as any,
                setup(ctx) {
                    register(ctx);
                }
            }),
            { origin: 'test:invalid-registration' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.setup_failed', detail: expectedError })
        );
        expect(host.listSkills()).toEqual([]);
        expect(host.listCommands()).toEqual([]);
        expect(await host.trigger('chat.headers', {}, { headers: {} })).toEqual({ headers: {} });
    });

    test('按插件激活顺序执行 hook，并共享 output 修改', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'first',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.order = 'first';
                    });
                }
            }),
            { origin: 'test:first' }
        );
        await host.activate(
            definePlugin({
                id: 'second',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.order += ',second';
                    });
                }
            }),
            { origin: 'test:second' }
        );

        const output = await host.trigger('chat.headers', {}, { headers: {} });

        expect(output.headers.order).toBe('first,second');
    });

    test('默认隔离 hook 异常、回滚失败修改并继续后续插件', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'broken-hook',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.broken = 'must-rollback';
                        throw new Error('hook failed');
                    });
                }
            }),
            { origin: 'test:broken-hook' }
        );
        await host.activate(
            definePlugin({
                id: 'next-hook',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.next = 'executed';
                    });
                }
            }),
            { origin: 'test:next-hook' }
        );

        await expect(host.trigger('chat.headers', {}, { headers: { original: 'yes' } })).resolves.toEqual({
            headers: { original: 'yes', next: 'executed' }
        });
        expect(host.get('broken-hook')?.diagnostics[0]?.code).toBe('plugin.hook_failed');
    });

    test('failureMode closed 会传播 hook 异常并停止后续插件', async () => {
        const host = new PluginHost();
        let nextCalls = 0;
        await host.activate(
            definePlugin({
                id: 'closed-hook',
                failureMode: 'closed',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', () => {
                        throw new Error('closed failure');
                    });
                }
            }),
            { origin: 'test:closed-hook' }
        );
        await host.activate(
            definePlugin({
                id: 'not-reached',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', () => {
                        nextCalls++;
                    });
                }
            }),
            { origin: 'test:not-reached' }
        );

        await expect(host.trigger('chat.headers', {}, { headers: {} })).rejects.toBeInstanceOf(PluginHookError);
        expect(nextCalls).toBe(0);
    });

    test('hook 注册级 failureMode 可以覆盖插件默认值', async () => {
        const openOverrideHost = new PluginHost();
        let nextCalls = 0;
        await openOverrideHost.activate(
            definePlugin({
                id: 'closed-plugin',
                failureMode: 'closed',
                setup(ctx) {
                    ctx.hooks.on(
                        'chat.headers',
                        (_input, output) => {
                            output.headers.partial = 'rollback';
                            throw new Error('optional hook failed');
                        },
                        { failureMode: 'open' }
                    );
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        nextCalls++;
                        output.headers.next = 'executed';
                    });
                }
            }),
            { origin: 'test:closed-plugin' }
        );

        await expect(openOverrideHost.trigger('chat.headers', {}, { headers: {} })).resolves.toEqual({
            headers: { next: 'executed' }
        });
        expect(nextCalls).toBe(1);

        const closedOverrideHost = new PluginHost();
        await closedOverrideHost.activate(
            definePlugin({
                id: 'open-plugin',
                setup(ctx) {
                    ctx.hooks.on(
                        'chat.headers',
                        () => {
                            throw new Error('required hook failed');
                        },
                        { failureMode: 'closed' }
                    );
                }
            }),
            { origin: 'test:open-plugin' }
        );

        await expect(closedOverrideHost.trigger('chat.headers', {}, { headers: {} })).rejects.toMatchObject({
            pluginId: 'open-plugin',
            hookName: 'chat.headers',
            failureMode: 'closed'
        });
    });

    test('setup 失败时回滚已经创建的 contribution', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'broken',
                setup(ctx) {
                    ctx.tools.register({
                        name: 'temporary',
                        description: 'temporary tool',
                        parameters: z.object({}),
                        async execute() {
                            return 'temporary';
                        }
                    });
                    throw new Error('setup failed');
                }
            }),
            { origin: 'test:broken' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.code).toBe('plugin.setup_failed');
        expect(host.listTools()).toEqual([]);
    });

    test.each([
        [
            '缺少 parameters',
            {
                name: 'echo',
                description: 'Echo text',
                args: { text: 'string' },
                async execute() {
                    return 'echo';
                }
            },
            'plugin.tool_parameters_invalid:echo'
        ],
        [
            'parameters 不是 Zod Schema',
            {
                name: 'echo',
                description: 'Echo text',
                parameters: { type: 'object' },
                async execute() {
                    return 'echo';
                }
            },
            'plugin.tool_parameters_invalid:echo'
        ],
        [
            'parameters 根类型不是对象',
            {
                name: 'echo',
                description: 'Echo text',
                parameters: z.string(),
                async execute() {
                    return 'echo';
                }
            },
            'plugin.tool_parameters_invalid:echo'
        ],
        [
            '缺少 execute',
            {
                name: 'echo',
                description: 'Echo text',
                parameters: z.object({ text: z.string() })
            },
            'plugin.tool_execute_invalid:echo'
        ]
    ])('启用阶段拒绝无效 Tool：%s', async (_caseName, definition, expectedError) => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'invalid-tool',
                capabilities: ['tool'],
                setup(ctx) {
                    const register = ctx.tools.register as unknown as (value: unknown) => void;
                    register(definition);
                }
            }),
            { origin: 'test:invalid-tool' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.setup_failed', detail: expectedError })
        );
        expect(host.listTools()).toEqual([]);
    });

    test('静态 contribution 在 setup 前注册并与 setup 失败一起回滚', async () => {
        const host = new PluginHost();
        const pluginDir = process.cwd();
        let setupSawSkill = false;
        let receivedPluginDir: string | undefined;
        const entry = await host.activate(
            definePlugin({
                id: 'static-contributor',
                capabilities: ['skill', 'mcp'],
                setup(ctx) {
                    receivedPluginDir = ctx.pluginDir;
                    setupSawSkill = host.listSkills().some(({ definition }) => definition.name === 'static-review');
                    throw new Error('setup failed');
                }
            }),
            {
                origin: 'test:static-contributor',
                pluginDir,
                resources: {
                    skills: [
                        {
                            name: 'static-review',
                            description: 'Review static contributions',
                            body: 'Review the changes.'
                        }
                    ],
                    mcpServers: [
                        {
                            name: 'static-mcp',
                            transport: 'streamableHttp',
                            url: 'https://example.test/mcp'
                        }
                    ]
                }
            }
        );

        expect(setupSawSkill).toBe(true);
        expect(receivedPluginDir).toBe(pluginDir);
        expect(entry.status).toBe('error');
        expect(host.listSkills()).toEqual([]);
        expect(host.listMcpServers()).toEqual([]);
    });

    test('deactivate 会释放该插件注册的 hook 和 tool', async () => {
        const host = new PluginHost();
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
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.demo = 'enabled';
                    });
                }
            }),
            { origin: 'test:demo' }
        );

        expect(host.listTools()[0]?.definition.name).toBe('demo-hello');
        expect(await host.deactivate('demo')).toBe(true);
        expect(host.listTools()).toEqual([]);
        expect(await host.trigger('chat.headers', {}, { headers: {} })).toEqual({ headers: {} });
    });

    test('deactivate 会调用 setup 返回的清理函数', async () => {
        const host = new PluginHost();
        let teardownCalls = 0;
        const teardown = () => {
            teardownCalls++;
        };
        await host.activate(
            definePlugin({
                id: 'resource-owner',
                setup() {
                    return teardown;
                }
            }),
            { origin: 'test:resource-owner' }
        );

        await host.deactivate('resource-owner');

        expect(teardownCalls).toBe(1);
    });

    test('记录加载错误时不会覆盖已激活的同名插件', async () => {
        const host = new PluginHost();
        await host.activate(definePlugin({ id: 'demo', setup() {} }), { origin: 'test:active' });

        const errorEntry = host.recordError({
            id: 'demo',
            origin: 'test:broken',
            code: 'plugin.load_failed',
            stage: 'load',
            detail: 'broken module'
        });

        expect(host.get('demo')?.status).toBe('active');
        expect(errorEntry.id).toBe('demo#2');
        expect(host.get('demo#2')?.diagnostics[0]).toMatchObject({
            code: 'plugin.load_failed',
            stage: 'load',
            detail: 'broken module'
        });
    });

    test('Skill 和 MCP contribution 全局注册并随插件释放', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'contributor',
                setup(ctx) {
                    ctx.skills.register({
                        name: 'review-code',
                        description: 'Review code changes',
                        body: 'Review the current changes.'
                    });
                    ctx.mcps.registerServer({
                        name: 'workspace-api',
                        transport: 'streamableHttp',
                        url: 'https://example.test/mcp'
                    });
                }
            }),
            { origin: 'test:contributor' }
        );

        expect(host.get('contributor')?.capabilities).toEqual(['skill', 'mcp']);
        expect(host.listSkills()[0]?.definition.name).toBe('review-code');
        expect(host.listMcpServers()[0]?.definition.name).toBe('workspace-api');

        await host.deactivate('contributor');

        expect(host.listSkills()).toEqual([]);
        expect(host.listMcpServers()).toEqual([]);
    });

    test('command contribution 全局注册、接收执行 workspace 并在停用后失效', async () => {
        const host = new PluginHost();
        const abort = new AbortController().signal;
        await host.activate(
            definePlugin({
                id: 'workspace-command',
                setup(ctx) {
                    ctx.commands.register({
                        name: 'status',
                        description: 'Show project status',
                        execute: (args, context) => `${context.workspace}:${args}:${context.abort === abort}`
                    });
                }
            }),
            { origin: 'test:command' }
        );

        const contribution = host.listCommands()[0];
        expect(contribution.definition.name).toBe('workspace-command.status');
        await expect(
            host.runCommand(contribution.id, 'verbose', {
                workspace: '/workspace/one',
                abort
            })
        ).resolves.toBe('/workspace/one:verbose:true');

        await host.deactivate('workspace-command');
        await expect(host.runCommand(contribution.id, '', { workspace: '/workspace/one', abort })).rejects.toThrow(
            'plugin.command_not_found'
        );
    });

    test('application event subscription 支持过滤、故障隔离和撤销', async () => {
        const host = new PluginHost();
        const received: unknown[][] = [];
        await host.activate(
            definePlugin({
                id: 'event-listener',
                setup(ctx) {
                    ctx.events.onApplication({ application: 'notes', event: 'changed' }, (event) => {
                        received.push(event.args);
                    });
                    ctx.events.onApplication({ application: 'notes' }, () => {
                        throw new Error('listener failed');
                    });
                }
            }),
            { origin: 'test:event' }
        );

        host.publishApplicationEvent({ application: 'mail', event: 'changed', args: ['ignored'] });
        host.publishApplicationEvent({ application: 'notes', event: 'changed', args: [{ id: 1 }] });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(received).toEqual([[{ id: 1 }]]);
        expect(host.get('event-listener')?.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.event_failed', stage: 'event' })
        );

        await host.deactivate('event-listener');
        host.publishApplicationEvent({ application: 'notes', event: 'changed', args: [{ id: 2 }] });
        expect(received).toHaveLength(1);
    });

    test('在 setup 前拒绝不兼容的插件 API 版本', async () => {
        const host = new PluginHost();
        let setupCalls = 0;
        const entry = await host.activate(
            definePlugin({
                id: 'future-plugin',
                apiVersion: 99,
                setup() {
                    setupCalls++;
                }
            }),
            { origin: 'test:future' }
        );

        expect(setupCalls).toBe(0);
        expect(entry).toMatchObject({
            status: 'error',
            apiVersion: 99,
            diagnostics: [expect.objectContaining({ code: 'plugin.api_version_unsupported' })]
        });
    });

    test('缺少声明能力或授权能力时不允许 contribution 生效', async () => {
        const host = new PluginHost();
        const undeclared = await host.activate(
            definePlugin({
                id: 'undeclared-tool',
                capabilities: ['command'],
                setup(ctx) {
                    ctx.tools.register({
                        name: 'hidden',
                        description: 'hidden',
                        parameters: z.object({}),
                        async execute() {
                            return 'hidden';
                        }
                    });
                }
            }),
            { origin: 'test:undeclared' }
        );
        expect(undeclared.status).toBe('error');
        expect(undeclared.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:tool');
        expect(host.listTools()).toEqual([]);

        let setupCalls = 0;
        const denied = await host.activate(
            definePlugin({
                id: 'denied-tool',
                capabilities: ['tool'],
                setup() {
                    setupCalls++;
                }
            }),
            { origin: 'test:denied', grantedCapabilities: [] }
        );
        expect(setupCalls).toBe(0);
        expect(denied.status).toBe('disabled');
        expect(denied.diagnostics[0]?.code).toBe('plugin.capability_not_granted');
    });

    test('使用 configSchema 校验并解析插件 options', async () => {
        const host = new PluginHost();
        let received: unknown;
        const active = await host.activate(
            definePlugin({
                id: 'configured',
                capabilities: [],
                configSchema: z.object({ prefix: z.string().default('hello') }),
                setup(ctx) {
                    received = ctx.options;
                }
            }),
            { origin: 'test:configured', options: {} }
        );
        expect(active.status).toBe('active');
        expect(received).toEqual({ prefix: 'hello' });

        const invalid = await host.activate(
            definePlugin({
                id: 'invalid-config',
                capabilities: [],
                configSchema: z.object({ count: z.number() }),
                setup() {}
            }),
            { origin: 'test:invalid-config', options: { count: 'nope' } }
        );
        expect(invalid.status).toBe('error');
        expect(invalid.diagnostics[0]?.code).toBe('plugin.config_invalid');
    });

    test('指定 platforms 包含当前平台时插件正常激活', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'platform-match',
                capabilities: [],
                platforms: [process.platform as any],
                setup() {}
            }),
            { origin: 'test:platform-match' }
        );

        expect(entry.status).toBe('active');
        expect(entry.diagnostics).toEqual([]);
    });

    test('指定 platforms 不包含当前平台时插件被禁用', async () => {
        const host = new PluginHost();
        const unsupportedPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
        const entry = await host.activate(
            definePlugin({
                id: 'platform-mismatch',
                capabilities: [],
                platforms: [unsupportedPlatform as any],
                setup() {}
            }),
            { origin: 'test:platform-mismatch' }
        );

        expect(entry.status).toBe('disabled');
        expect(entry.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin.platform_unsupported',
                stage: 'validate',
                detail: process.platform
            })
        ]);
    });

    test('未指定 platforms 时任意平台都可加载插件', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'no-platforms',
                capabilities: [],
                setup() {}
            }),
            { origin: 'test:no-platforms' }
        );

        expect(entry.status).toBe('active');
        expect(entry.diagnostics).toEqual([]);
    });
});
