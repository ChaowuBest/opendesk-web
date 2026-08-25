import fs from 'fs';
import os from 'os';
import path from 'path';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    applyPluginManifest,
    loadPluginResources,
    parsePluginManifest
} from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { definePlugin, type AgentDefinition } from '../../../../packages/plugin-sdk/src/index.js';

function writeAgentDirectory(rootDir: string, name: string, files: { agentsMd?: string; agentJson?: object }): string {
    const directory = path.join(rootDir, name);
    fs.mkdirSync(directory, { recursive: true });
    if (files.agentsMd !== undefined) {
        fs.writeFileSync(path.join(directory, 'agents.md'), files.agentsMd);
    }
    if (files.agentJson !== undefined) {
        fs.writeFileSync(path.join(directory, 'agent.json'), JSON.stringify(files.agentJson));
    }
    return directory;
}

describe('pluginmgr agents', () => {
    let rootDir: string;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-agents-'));
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    describe('manifest 解析', () => {
        test('resources.agents 声明要求声明 agent capability', () => {
            expect(() =>
                parsePluginManifest({
                    schemaVersion: 1,
                    capabilities: ['skill'],
                    resources: { agents: ['./agents'] }
                })
            ).toThrow('plugin.manifest_resource_capability_missing:agent');
        });

        test('agents 路径必须是字符串数组', () => {
            expect(() =>
                parsePluginManifest({
                    schemaVersion: 1,
                    capabilities: ['agent'],
                    resources: { agents: ['./agents', 42] }
                })
            ).toThrow('plugin.manifest_invalid_agents');
        });

        test('displayName 字符串形式保持不变并去除首尾空白', () => {
            const manifest = parsePluginManifest({ schemaVersion: 1, displayName: ' Review Helper ' });
            expect(manifest.displayName).toBe('Review Helper');
        });

        test('displayName 支持对象形式并将语言键归一化为主语言标签', () => {
            const manifest = parsePluginManifest({
                schemaVersion: 1,
                displayName: { en: 'Hello Plugin', 'zh-CN': '你好插件' }
            });
            expect(manifest.displayName).toEqual({ en: 'Hello Plugin', zh: '你好插件' });
        });

        test('displayName 对象中的值必须是非空字符串', () => {
            expect(() => parsePluginManifest({ schemaVersion: 1, displayName: {} })).toThrow(
                'plugin.manifest_invalid_display_name'
            );
            expect(() => parsePluginManifest({ schemaVersion: 1, displayName: { en: '' } })).toThrow(
                'plugin.manifest_invalid_display_name'
            );
            expect(() => parsePluginManifest({ schemaVersion: 1, displayName: { en: 'ok', zh: 42 } })).toThrow(
                'plugin.manifest_invalid_display_name'
            );
            expect(() => parsePluginManifest({ schemaVersion: 1, displayName: 42 })).toThrow(
                'plugin.manifest_invalid_display_name'
            );
        });

        test('applyPluginManifest 将 manifest 中的本地化 displayName 合并进入口对象', () => {
            const plugin = definePlugin({ id: 'localized-plugin', setup: () => undefined });
            const merged = applyPluginManifest(
                plugin,
                parsePluginManifest({
                    schemaVersion: 1,
                    capabilities: [],
                    displayName: { en: 'Hello Plugin', zh: '你好插件' }
                })
            );
            expect(merged.displayName).toEqual({ en: 'Hello Plugin', zh: '你好插件' });
        });
    });

    describe('目录加载', () => {
        test('从单个 agent 目录加载并读取 agent.json 元数据', () => {
            writeAgentDirectory(rootDir, 'reviewer', {
                agentsMd: '# Reviewer\n\nYou review code.',
                agentJson: { name: 'code-reviewer', when_to_use: 'Reviewing pull requests.', dispatchable: false }
            });

            const resources = loadPluginResources(
                parsePluginManifest({
                    schemaVersion: 1,
                    capabilities: ['agent'],
                    resources: { agents: ['./reviewer'] }
                }),
                rootDir
            );

            expect(resources.agents).toHaveLength(1);
            const definition = resources.agents![0];
            expect(definition.name).toBe('code-reviewer');
            expect(definition.whenToUse).toBe('Reviewing pull requests.');
            expect(definition.dispatchable).toBe(false);
            expect(definition.body).toBe('# Reviewer\n\nYou review code.');
        });

        test('从父目录扫描多个 agent 子目录，缺失字段按约定推断', () => {
            writeAgentDirectory(rootDir, 'agents/alpha', {
                agentsMd: '# Alpha Agent\n\nFirst line describes usage.'
            });
            writeAgentDirectory(rootDir, 'agents/beta', {
                agentsMd: '# Beta\n\nBody.',
                agentJson: { name: 'beta-agent', when_to_use: 'Beta usage.' }
            });
            // 无 agents.md 的目录应被跳过
            fs.mkdirSync(path.join(rootDir, 'agents/empty'), { recursive: true });

            const resources = loadPluginResources(
                parsePluginManifest({
                    schemaVersion: 1,
                    capabilities: ['agent'],
                    resources: { agents: ['./agents'] }
                }),
                rootDir
            );

            expect(resources.agents).toHaveLength(2);
            const alpha = resources.agents!.find((agent) => agent.name === 'alpha');
            const beta = resources.agents!.find((agent) => agent.name === 'beta-agent');
            expect(alpha?.whenToUse).toBe('Alpha Agent');
            expect(alpha?.dispatchable).toBe(true);
            expect(beta?.whenToUse).toBe('Beta usage.');
            expect(beta?.dispatchable).toBe(true);
        });

        test('声明的路径不存在时加载失败', () => {
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['./missing'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_path_invalid');
        });

        test('父目录中没有任何 agent 时加载失败', () => {
            fs.mkdirSync(path.join(rootDir, 'nothing-here'), { recursive: true });
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['./nothing-here'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_not_found');
        });

        test('拒绝插件根目录之外的路径', () => {
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['../outside'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_path_invalid');
        });

        test('agents.md 为空文件时加载失败', () => {
            writeAgentDirectory(rootDir, 'hollow', { agentsMd: '   ' });
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['./hollow'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_body_empty:hollow');
        });

        test('agent.json 类型非法时报错而非静默忽略', () => {
            writeAgentDirectory(rootDir, 'strict', {
                agentsMd: '# Strict\n\nBody.',
                agentJson: { dispatchable: 'false' }
            });
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['./strict'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_meta_invalid');
        });

        test('agent.json 内容不是 JSON 对象时报错', () => {
            const directory = path.join(rootDir, 'broken-meta');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'agents.md'), '# Broken\n\nBody.');
            fs.writeFileSync(path.join(directory, 'agent.json'), '[1, 2, 3]');
            expect(() =>
                loadPluginResources(
                    parsePluginManifest({
                        schemaVersion: 1,
                        capabilities: ['agent'],
                        resources: { agents: ['./broken-meta'] }
                    }),
                    rootDir
                )
            ).toThrow('plugin.manifest_agent_meta_invalid');
        });
    });

    describe('PluginHost 注册', () => {
        test('静态贡献的 agent 在 setup 前注册并记录 capability', async () => {
            const host = new PluginHost();
            let setupSawAgent = false;
            const entry = await host.activate(
                definePlugin({
                    id: 'agent-plugin',
                    capabilities: ['agent'],
                    setup(ctx) {
                        setupSawAgent = host.listAgents().some((item) => item.definition.name === 'helper');
                    }
                }),
                {
                    origin: 'test:agent-plugin',
                    resources: {
                        agents: [
                            {
                                name: 'helper',
                                whenToUse: 'When help is needed.',
                                body: 'You are a helper.'
                            }
                        ]
                    }
                }
            );

            expect(entry.status).toBe('active');
            expect(entry.capabilities).toContain('agent');
            expect(setupSawAgent).toBe(true);
            expect(host.listAgents()).toEqual([
                {
                    id: 'agent-plugin:helper',
                    pluginId: 'agent-plugin',
                    definition: expect.objectContaining({ name: 'helper' })
                }
            ]);
        });

        test('运行时 ctx.agents.register 注册 agent', async () => {
            const host = new PluginHost();
            await host.activate(
                definePlugin({
                    id: 'runtime-agents',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.register({
                            name: 'dynamic',
                            whenToUse: 'Dynamic registration.',
                            body: 'You are dynamic.'
                        });
                    }
                }),
                { origin: 'test:runtime-agents' }
            );

            expect(host.listAgents()[0]?.definition.name).toBe('dynamic');
        });

        test('同一插件不允许定义同名 agent', async () => {
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'duplicate-agents',
                    capabilities: ['agent'],
                    setup(ctx) {
                        const definition = { name: 'twin', whenToUse: 'Twin.', body: 'Twin body.' };
                        ctx.agents.register({ ...definition });
                        ctx.agents.register({ ...definition });
                    }
                }),
                { origin: 'test:duplicate-agents' }
            );

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]).toMatchObject({ code: 'plugin.setup_failed' });
            expect(host.listAgents()).toEqual([]);
        });

        test('不同插件允许定义同名 agent，通过作用域 id 区分', async () => {
            const host = new PluginHost();
            for (const pluginId of ['first-plugin', 'second-plugin']) {
                await host.activate(
                    definePlugin({
                        id: pluginId,
                        capabilities: ['agent'],
                        setup(ctx) {
                            ctx.agents.register({
                                name: 'shared-name',
                                whenToUse: 'Shared across plugins.',
                                body: 'Shared body.'
                            });
                        }
                    }),
                    { origin: `test:${pluginId}` }
                );
            }

            const ids = host
                .listAgents()
                .map((item) => item.id)
                .sort();
            expect(ids).toEqual(['first-plugin:shared-name', 'second-plugin:shared-name']);
        });

        test('setup 失败时回滚已注册的 agent', async () => {
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'broken-agent-plugin',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.register({
                            name: 'doomed',
                            whenToUse: 'Doomed.',
                            body: 'Doomed body.'
                        });
                        throw new Error('setup failed');
                    }
                }),
                { origin: 'test:broken-agent-plugin' }
            );

            expect(entry.status).toBe('error');
            expect(host.listAgents()).toEqual([]);
        });

        test('deactivate 释放该插件的全部 agent', async () => {
            const host = new PluginHost();
            await host.activate(
                definePlugin({
                    id: 'release-agents',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.register({
                            name: 'one',
                            whenToUse: 'One.',
                            body: 'One body.'
                        });
                        ctx.agents.register({
                            name: 'two',
                            whenToUse: 'Two.',
                            body: 'Two body.'
                        });
                    }
                }),
                { origin: 'test:release-agents' }
            );
            expect(host.listAgents()).toHaveLength(2);

            await host.deactivate('release-agents');

            expect(host.listAgents()).toEqual([]);
        });

        test.each([
            ['名称非法', { name: 'bad name!', whenToUse: 'Usage.', body: 'Body.' }, 'Plugin agent name is invalid'],
            [
                'whenToUse 缺失',
                { name: 'no-usage', whenToUse: '', body: 'Body.' },
                'Plugin agent description is required'
            ],
            ['body 非法', { name: 'no-body', whenToUse: 'Usage.', body: '' }, 'plugin.agent_body_invalid:no-body']
        ])('拒绝无效的 agent 定义：%s', async (_caseName, definition, expectedError) => {
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'invalid-agent',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.register(definition as AgentDefinition);
                    }
                }),
                { origin: 'test:invalid-agent' }
            );

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]).toMatchObject({
                code: 'plugin.setup_failed',
                detail: expect.stringContaining(expectedError)
            });
            expect(host.listAgents()).toEqual([]);
        });
    });

    describe('ctx.agents.registerDirectory', () => {
        async function activateWithDirectory(relativePath: string, pluginId = 'dir-agents') {
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: pluginId,
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.registerDirectory(relativePath);
                    }
                }),
                { origin: `test:${pluginId}`, pluginDir: rootDir }
            );
            return { host, entry };
        }

        test('扫描父目录并注册其中所有 agent，路径相对插件根目录', async () => {
            writeAgentDirectory(rootDir, 'agents/alpha', { agentsMd: '# Alpha\n\nAlpha body.' });
            writeAgentDirectory(rootDir, 'agents/beta', {
                agentsMd: '# Beta\n\nBeta body.',
                agentJson: { name: 'beta-agent', when_to_use: 'Beta usage.', dispatchable: false }
            });

            const { host, entry } = await activateWithDirectory('./agents');

            expect(entry.status).toBe('active');
            expect(entry.capabilities).toContain('agent');
            const agents = host.listAgents();
            expect(agents).toHaveLength(2);
            expect(agents.map((item) => item.definition.name).sort()).toEqual(['alpha', 'beta-agent']);
            const beta = agents.find((item) => item.definition.name === 'beta-agent');
            expect(beta?.definition.whenToUse).toBe('Beta usage.');
            expect(beta?.definition.dispatchable).toBe(false);
            const alpha = agents.find((item) => item.definition.name === 'alpha');
            expect(alpha?.definition.whenToUse).toBe('Alpha');
            expect(alpha?.definition.dispatchable).toBe(true);
        });

        test('路径直接指向单个 agent 目录时只注册该 agent', async () => {
            writeAgentDirectory(rootDir, 'solo', {
                agentsMd: '# Solo\n\nSolo body.',
                agentJson: { name: 'solo-agent', when_to_use: 'Solo usage.' }
            });

            const { host } = await activateWithDirectory('./solo');

            expect(host.listAgents().map((item) => item.definition.name)).toEqual(['solo-agent']);
        });

        test('不写路径或写空路径时报错', async () => {
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'empty-path',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.registerDirectory('   ');
                    }
                }),
                { origin: 'test:empty-path', pluginDir: rootDir }
            );

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toContain('plugin.agent_directory_invalid:empty');
        });

        test('拒绝插件根目录之外的路径', async () => {
            const { host, entry } = await activateWithDirectory('../outside');

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toContain('plugin.agent_directory_invalid');
            expect(host.listAgents()).toEqual([]);
        });

        test('目录中没有任何 agent 时报错', async () => {
            fs.mkdirSync(path.join(rootDir, 'blank'), { recursive: true });

            const { entry } = await activateWithDirectory('./blank');

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toContain('plugin.agent_directory_empty');
        });

        test('目录内 agents.md 为空时报错并不注册任何 agent', async () => {
            writeAgentDirectory(rootDir, 'agents/good', { agentsMd: '# Good\n\nGood body.' });
            writeAgentDirectory(rootDir, 'agents/hollow', { agentsMd: '   ' });

            const { host, entry } = await activateWithDirectory('./agents');

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toContain('plugin.agent_body_empty:hollow');
            expect(host.listAgents()).toEqual([]);
        });

        test('目录内出现同名 agent 时整体回滚', async () => {
            writeAgentDirectory(rootDir, 'agents/first', {
                agentsMd: '# First\n\nBody.',
                agentJson: { name: 'twin', when_to_use: 'Twin one.' }
            });
            writeAgentDirectory(rootDir, 'agents/second', {
                agentsMd: '# Second\n\nBody.',
                agentJson: { name: 'twin', when_to_use: 'Twin two.' }
            });

            const { host, entry } = await activateWithDirectory('./agents');

            expect(entry.status).toBe('error');
            expect(host.listAgents()).toEqual([]);
        });

        test('deactivate 释放目录批量注册的全部 agent', async () => {
            writeAgentDirectory(rootDir, 'agents/one', { agentsMd: '# One\n\nBody.' });
            writeAgentDirectory(rootDir, 'agents/two', { agentsMd: '# Two\n\nBody.' });

            const { host } = await activateWithDirectory('./agents', 'release-dir');
            expect(host.listAgents()).toHaveLength(2);

            await host.deactivate('release-dir');

            expect(host.listAgents()).toEqual([]);
        });

        test('未声明 agent capability 时拒绝目录注册', async () => {
            writeAgentDirectory(rootDir, 'agents/one', { agentsMd: '# One\n\nBody.' });
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'no-capability',
                    capabilities: ['skill'],
                    setup(ctx) {
                        ctx.agents.registerDirectory('./agents');
                    }
                }),
                { origin: 'test:no-capability', pluginDir: rootDir }
            );

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:agent');
            expect(host.listAgents()).toEqual([]);
        });

        test('registerDirectory 与 register 混用时同名 agent 仍受插件内唯一约束', async () => {
            writeAgentDirectory(rootDir, 'agents/mixed', {
                agentsMd: '# Mixed\n\nBody.',
                agentJson: { name: 'mixed', when_to_use: 'From directory.' }
            });
            const host = new PluginHost();
            const entry = await host.activate(
                definePlugin({
                    id: 'mixed-plugin',
                    capabilities: ['agent'],
                    setup(ctx) {
                        ctx.agents.registerDirectory('./agents');
                        ctx.agents.register({
                            name: 'mixed',
                            whenToUse: 'From code.',
                            body: 'Body.'
                        });
                    }
                }),
                { origin: 'test:mixed-plugin', pluginDir: rootDir }
            );

            expect(entry.status).toBe('error');
            expect(host.listAgents()).toEqual([]);
        });
    });
});
