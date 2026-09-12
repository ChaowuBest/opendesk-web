import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ChatContext } from '../../../main/aikernel/messages.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import {
    disposePluginHost,
    initializePluginHost,
    reloadPluginHost
} from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { setRuntimePluginDirectories } from '../../../main/applications/pluginmgr/management/config.js';
import { PLUGIN_SKILL_BUNDLE } from '../../../main/applications/pluginmgr/runtime/contributions.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { logger } from '../../../main/utils/logger.js';
import { installPlugin } from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { ModelInstance, Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';

describe('OpenDesk plugin bootstrap', () => {
    let configDirectory: string;
    let previousBuiltinPluginsDirectory: string | undefined;

    /** 调度 beforeChatModelRequest 钩子并返回钩子改写后的请求选项 */
    async function applyChatModelRequestOptions(): Promise<{
        extraHeaders?: Record<string, string>;
        reasoningEffort?: string;
        maxCompletionTokens?: number;
    }> {
        const ctx = {
            chat: new ChatContext(),
            model: new ModelInstance('mock-model', 'https://example.test/v1', 'key', true),
            options: {}
        };
        await GlobalHooks.applyBeforeChatModelRequest(ctx);
        return ctx.options;
    }

    /** 调度 beforeChatModelRequest 钩子并返回钩子改写后的 extraHeaders */
    async function applyChatModelRequest(): Promise<Record<string, string> | undefined> {
        return (await applyChatModelRequestOptions()).extraHeaders;
    }

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-bootstrap-'));
        previousBuiltinPluginsDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        setCustomOpendeskDirectory(configDirectory);
        setRuntimePluginDirectories([]);
        Setting.clearCache();
    });

    afterEach(async () => {
        await disposePluginHost();
        setRuntimePluginDirectories([]);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        if (previousBuiltinPluginsDirectory === undefined) {
            delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        } else {
            process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinPluginsDirectory;
        }
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('插件管理应用可以序列化应用列表元数据', () => {
        const application = new PluginMgrApplication();

        expect(application.toJSON()).toMatchObject({
            bundleName: 'pluginmgr',
            name: expect.any(String),
            showIcon: true,
            source: 'system',
            removable: false,
            active: true
        });
    });

    test('插件管理列表展示 Tool 本地名，同时保留 Host 限定名', async () => {
        await initializePluginHost();
        await getPluginHost().activate(
            {
                id: 'tool-display',
                capabilities: ['tool'],
                setup(ctx) {
                    ctx.tools.register({
                        name: 'inspect',
                        description: 'Inspect a value',
                        parameters: z.object({}),
                        async execute() {
                            return 'inspected';
                        }
                    });
                }
            },
            { origin: 'test:tool-display' }
        );

        const application = new PluginMgrApplication();
        const entry = (await application.list()).find((candidate) => candidate.id === 'tool-display');

        expect(
            getPluginHost()
                .listTools()
                .find(({ pluginId }) => pluginId === 'tool-display')?.definition.name
        ).toBe('tool-display-inspect');
        expect(entry?.tools).toEqual([{ name: 'inspect', description: 'Inspect a value' }]);
    });

    test('分别桥接 chat.headers 与 chat.params 到同一模型请求', async () => {
        await initializePluginHost();
        await getPluginHost().activate(
            {
                id: 'separate-chat-hooks',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers['x-plugin'] = 'enabled';
                    });
                    ctx.hooks.on('chat.params', (_input, output) => {
                        output.reasoningEffort = 'high';
                        output.maxCompletionTokens = 4096;
                    });
                }
            },
            { origin: 'test:separate-chat-hooks' }
        );

        await expect(applyChatModelRequestOptions()).resolves.toEqual({
            extraHeaders: { 'x-plugin': 'enabled' },
            reasoningEffort: 'high',
            maxCompletionTokens: 4096
        });
    });

    test('chat.params 只回写约定的模型参数字段', async () => {
        await initializePluginHost();
        await getPluginHost().activate(
            {
                id: 'chat-params-output-boundary',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('chat.params', (_input, output) => {
                        output.reasoningEffort = 'high';
                        output.maxCompletionTokens = 4096;
                        (output as unknown as Record<string, unknown>).extraHeaders = {
                            'x-unexpected': 'ignored'
                        };
                    });
                }
            },
            { origin: 'test:chat-params-output-boundary' }
        );

        await expect(applyChatModelRequestOptions()).resolves.toEqual({
            extraHeaders: {},
            reasoningEffort: 'high',
            maxCompletionTokens: 4096
        });
    });

    test('本地插件禁用后仍从 manifest 返回 Skill 和 MCP 详情', async () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'local-details');
        const skillDirectory = path.join(pluginDirectory, 'skills', 'review-notes');
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'local-details',
                displayName: 'Local details',
                version: '2.0.0',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['skill', 'mcp'],
                resources: {
                    skills: ['./skills/review-notes'],
                    mcpServers: [
                        {
                            name: 'local-echo',
                            transport: 'stdio',
                            command: 'node',
                            args: ['./echo.mjs'],
                            cwd: '.'
                        }
                    ]
                }
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default { id: 'local-details', setup() {} };`
        );
        fs.writeFileSync(
            path.join(skillDirectory, 'SKILL.md'),
            `---
name: review-notes
description: Review notes and extract actions.
---

# Review notes

Extract decisions and actions.
`
        );

        const application = new PluginMgrApplication();
        const skillEvents: string[] = [];
        const previousSkillApplication = ApplicationRegistry.applications.get('skillmgr');
        ApplicationRegistry.applications.set('skillmgr', {
            notifyExternalSkillsChanged(bundleName: string) {
                expect(bundleName).toBe(PLUGIN_SKILL_BUNDLE);
                skillEvents.push('skillsChanged');
            },
            sendEventToSubscribers(eventName: string) {
                skillEvents.push(eventName);
            }
        } as any);
        const active = (await application.list()).find((entry) => entry.id === 'local-details');
        expect(active).toMatchObject({
            enabled: true,
            manifest: {
                displayName: 'Local details',
                version: '2.0.0',
                apiVersion: 1,
                capabilities: ['skill', 'mcp']
            },
            skills: [expect.objectContaining({ name: 'review-notes' })],
            mcpServers: [expect.objectContaining({ name: 'local-echo', transport: 'stdio' })]
        });
        const activeSkills = await SkillRegistry.getInstance().getAllSkillsRaw();
        const localSkills = (activeSkills.get(PLUGIN_SKILL_BUNDLE) ?? []).filter(
            (skill) => skill.attribution?.sourceId === 'local-details'
        );
        expect(localSkills).toEqual([
            expect.objectContaining({
                frontmatter: expect.objectContaining({ name: 'review-notes' })
            })
        ]);

        try {
            const disabled = (await application.setEnabled('local-details', false)).find(
                (entry) => entry.id === 'local-details'
            );
            expect(disabled).toMatchObject({
                enabled: false,
                runtime: undefined,
                manifest: {
                    displayName: 'Local details',
                    version: '2.0.0',
                    apiVersion: 1,
                    capabilities: ['skill', 'mcp']
                },
                skills: [expect.objectContaining({ name: 'review-notes' })],
                mcpServers: [expect.objectContaining({ name: 'local-echo', transport: 'stdio' })]
            });
            const disabledSkills = (
                (await SkillRegistry.getInstance().getAllSkillsRaw()).get(PLUGIN_SKILL_BUNDLE) ?? []
            ).filter((skill) => skill.attribution?.sourceId === 'local-details');
            expect(disabledSkills).toHaveLength(0);
            expect(skillEvents).toContain('skillsChanged');
        } finally {
            if (previousSkillApplication) {
                ApplicationRegistry.applications.set('skillmgr', previousSkillApplication);
            } else {
                ApplicationRegistry.applications.delete('skillmgr');
            }
        }
    });

    test('自动发现构建产物目录中的内置插件', async () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const pluginDirectory = path.join(builtinDirectory, 'builtin-example');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'builtin-example',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['hook']
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default {
                id: 'builtin-example',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers['x-builtin-example'] = 'enabled';
                    });
                }
            };`
        );
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;

        await initializePluginHost();

        expect(getPluginHost().get('builtin-example')).toMatchObject({
            status: 'active',
            origin: builtinDirectory
        });
        await expect(applyChatModelRequest()).resolves.toEqual({
            'x-builtin-example': 'enabled'
        });
    });

    test('拒绝加载 TypeScript 插件入口', async () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const pluginDirectory = path.join(builtinDirectory, 'uncompiled-example');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'uncompiled-example',
                entry: './index.ts',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.ts'),
            `export default { id: 'uncompiled-example', setup() {} };`
        );
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;

        await initializePluginHost();

        expect(getPluginHost().get('uncompiled-example')).toMatchObject({
            status: 'error',
            diagnostics: [
                expect.objectContaining({
                    code: 'plugin.entry_typescript_unsupported',
                    stage: 'load'
                })
            ]
        });
        expect(fs.existsSync(path.join(pluginDirectory, '.opendesk-index.mjs'))).toBe(false);
    });

    test('自动发现 OpenDesk 配置目录 plugins 中的插件', async () => {
        const localDirectory = getPluginsDirectory(configDirectory);
        fs.mkdirSync(localDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(localDirectory, 'local-example.mjs'),
            `export default {
                id: 'local-example',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers['x-local-example'] = 'enabled';
                    });
                }
            };`
        );

        await initializePluginHost();

        expect(getPluginHost().get('local-example')?.status).toBe('active');
        await expect(applyChatModelRequest()).resolves.toEqual({
            'x-local-example': 'enabled'
        });
    });

    test('从目录安装插件时复制到托管目录并支持卸载', async () => {
        const sourceDirectory = path.join(configDirectory, 'external-source');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'external-source',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'index.mjs'),
            `export default { id: 'external-source', setup() {} };`
        );
        const application = new PluginMgrApplication();

        await expect(application.install(sourceDirectory)).resolves.toEqual({
            success: true,
            id: 'external-source'
        });

        expect(Setting.getInstance().data.applications.pluginmgr?.externalPaths).toBeUndefined();
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'external-source', 'index.mjs'))).toBe(
            true
        );
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'external-source', 'plugin'))).toBe(false);
        await expect(application.list()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'external-source',
                    source: 'local',
                    removable: true
                })
            ])
        );
        await expect(application.uninstall('external-source')).resolves.toEqual({ success: true });
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'external-source'))).toBe(false);
        expect(fs.existsSync(sourceDirectory)).toBe(true);
    });

    test('卸载托管插件前释放运行时占用的目录', async () => {
        const sourceDirectory = path.join(configDirectory, 'managed-source');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'managed-lock-test',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'index.mjs'),
            `export default { id: 'managed-lock-test', setup() {} };`
        );
        await installPlugin(sourceDirectory, { configDirectory });
        await initializePluginHost();
        expect(getPluginHost().get('managed-lock-test')?.status).toBe('active');

        const managedDirectory = path.join(getPluginsDirectory(configDirectory), 'managed-lock-test');
        const originalRenameSync = fs.renameSync.bind(fs);
        const originalRename = fs.promises.rename.bind(fs.promises);
        const lockedError = () => {
            const error = new Error('directory is in use') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            return error;
        };
        const renameSync = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(String(source)) === managedDirectory && getPluginHost().get('managed-lock-test')) {
                throw lockedError();
            }
            originalRenameSync(source, destination);
        });
        const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
            if (path.resolve(String(source)) === managedDirectory && getPluginHost().get('managed-lock-test')) {
                throw lockedError();
            }
            await originalRename(source, destination);
        });

        try {
            const application = new PluginMgrApplication();
            await expect(application.uninstall('managed-lock-test')).resolves.toEqual({ success: true });
        } finally {
            renameSync.mockRestore();
            rename.mockRestore();
        }

        expect(fs.existsSync(managedDirectory)).toBe(false);
    });

    test('自动注册启动参数指定目录中的插件', async () => {
        const pluginsDirectory = path.join(configDirectory, 'runtime-plugins');
        const pluginDirectory = path.join(pluginsDirectory, 'runtime-example');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'runtime-example',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['hook']
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default {
                id: 'runtime-example',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers['x-runtime-example'] = 'enabled';
                    });
                }
            };`
        );
        setRuntimePluginDirectories([pluginsDirectory]);

        await initializePluginHost();

        expect(getPluginHost().get('runtime-example')).toMatchObject({
            status: 'active',
            origin: pluginsDirectory
        });
        await expect(applyChatModelRequest()).resolves.toEqual({
            'x-runtime-example': 'enabled'
        });
    });

    test('加载目录插件 manifest 中声明的静态 Skill 和 MCP', async () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'manifest-contributor');
        const skillDirectory = path.join(pluginDirectory, 'skills', 'review-code');
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default {
                id: 'manifest-contributor',
                setup() {}
            };`
        );
        fs.writeFileSync(
            path.join(skillDirectory, 'SKILL.md'),
            `---
name: review-code
description: Review code changes
---
Review the current changes.`
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'manifest-contributor',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['skill', 'mcp'],
                resources: {
                    skills: ['./skills'],
                    mcpServers: [
                        {
                            name: 'remote-search',
                            transport: 'streamableHttp',
                            url: 'https://example.test/mcp'
                        }
                    ]
                }
            })
        );

        await initializePluginHost();

        const skills = getPluginHost()
            .listSkills()
            .filter((entry) => entry.pluginId === 'manifest-contributor');
        expect(skills).toHaveLength(1);
        expect(skills[0]?.definition).toMatchObject({
            name: 'review-code',
            directory: fs.realpathSync(skillDirectory)
        });
        const mcpServers = getPluginHost()
            .listMcpServers()
            .filter((entry) => entry.pluginId === 'manifest-contributor');
        expect(mcpServers).toHaveLength(1);
        expect(mcpServers[0]?.definition).toMatchObject({
            name: 'remote-search',
            transport: 'streamableHttp'
        });
    });

    test('插件模块加载失败时保留结构化诊断', async () => {
        const localDirectory = getPluginsDirectory(configDirectory);
        fs.mkdirSync(localDirectory, { recursive: true });
        fs.writeFileSync(path.join(localDirectory, 'broken-plugin.mjs'), 'export default {};');

        await initializePluginHost();

        expect(getPluginHost().get('broken-plugin')).toMatchObject({
            status: 'error',
            diagnostics: [
                {
                    code: 'plugin.invalid_module',
                    stage: 'load'
                }
            ]
        });
    });

    test('不发现 default workspace 中的 .opendesk/plugins', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-workspace-'));
        const pluginDirectory = path.join(workspace, '.opendesk', 'plugins');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'workspace-example.mjs'),
            `export default {
                id: 'workspace-example',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.workspace = 'loaded';
                    });
                }
            };`
        );
        const setting = Setting.getInstance();
        setting.setData({ ...setting.getData(), default_workspace: workspace });

        try {
            await initializePluginHost();

            expect(getPluginHost().get('workspace-example')).toBeUndefined();
            await expect(applyChatModelRequest()).resolves.toEqual({});
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    test('声明不支持平台的插件被跳过并仅记录警告', async () => {
        const unsupportedPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'unsupported-platform');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default { id: 'unsupported-platform', setup() {} };`
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'unsupported-platform',
                entry: './index.mjs',
                apiVersion: 1,
                platforms: [unsupportedPlatform]
            })
        );

        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
        try {
            await initializePluginHost();

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported-platform'));

            // 不产生 runtime entry，避免诊断信息出现在插件运行状态里
            expect(getPluginHost().get('unsupported-platform')).toBeUndefined();

            // 已安装插件列表不展示该插件
            const application = new PluginMgrApplication();
            const entries = await application.list();
            expect(entries.some((entry) => entry.id === 'unsupported-platform')).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('插件贡献的 agent 经初始化后以插件 id 为作用域注册到 AgentRegistry', async () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'team-agents');
        const agentDirectory = path.join(pluginDirectory, 'agents', 'reviewer');
        fs.mkdirSync(agentDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'team-agents',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['agent'],
                resources: {
                    agents: ['./agents']
                }
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), `export default { id: 'team-agents', setup() {} };`);
        fs.writeFileSync(path.join(agentDirectory, 'agents.md'), `# Reviewer\n\nReviews plugin contributions.`);
        fs.writeFileSync(
            path.join(agentDirectory, 'agent.json'),
            JSON.stringify({ name: 'code-reviewer', when_to_use: 'Reviewing plugin code.', dispatchable: false })
        );

        await initializePluginHost();

        const registered = AgentRegistry.getAgent('team-agents:code-reviewer');
        expect(registered).toBeDefined();
        expect(registered?.whenToUse).toBe('Reviewing plugin code.');
        // dispatchable: false → 不出现在可调度列表
        expect(registered?.dispatchable).toBe(false);
        expect(AgentRegistry.getAgentFrontmatterXml()).not.toContain('team-agents:code-reviewer');

        await disposePluginHost();
        expect(AgentRegistry.getAgent('team-agents:code-reviewer')).toBeUndefined();
    });

    test('reloadPluginHost 跳过懒加载任务（不触发 chat_context 防御性全量加载）', async () => {
        await initializePluginHost();

        // 模拟正在使用/运行中、已完全加载的任务
        const loadedTask = Object.assign(Object.create(TaskState.prototype), {
            task_id: 'task-reload-loaded',
            _fullyLoaded: true
        }) as TaskState;
        // 模拟仅从索引恢复、未在内存中运行的懒加载任务
        const lazyTask = Object.assign(Object.create(TaskState.prototype), {
            task_id: 'task-reload-lazy',
            _fullyLoaded: false
        }) as TaskState;

        const globalStateSpy = jest.spyOn(GlobalState, 'getCurrentInstance').mockReturnValue({
            taskManagerState: { tasks: [loadedTask, lazyTask] }
        } as unknown as GlobalState);
        const loadedRefresh = jest.spyOn(loadedTask, 'refreshToolsets').mockResolvedValue(undefined);
        const lazyRefresh = jest.spyOn(lazyTask, 'refreshToolsets').mockResolvedValue(undefined);

        // 确认 spy 生效（reloadPluginHost 依赖 getCurrentInstance 返回 mock 的 task manager）
        expect((globalStateSpy as jest.Mock).mock.calls).toHaveLength(0);

        await reloadPluginHost();

        // 只有已加载任务的工具集需要即时刷新；懒加载任务不得被强制 ensureLoaded
        expect(loadedRefresh).toHaveBeenCalledTimes(1);
        expect(lazyRefresh).not.toHaveBeenCalled();
        expect(lazyTask._fullyLoaded).toBe(false);

        globalStateSpy.mockRestore();
        loadedRefresh.mockRestore();
        lazyRefresh.mockRestore();
    });
});
