import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ChatContext } from '../../../main/aikernel/messages.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import { disposePluginHost, initializePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { setRuntimePluginDirectories } from '../../../main/applications/pluginmgr/management/config.js';
import { PLUGIN_SKILL_BUNDLE } from '../../../main/applications/pluginmgr/runtime/contributions.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { installPlugin } from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { ModelInstance, Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

describe('OpenDesk plugin bootstrap', () => {
    let configDirectory: string;
    let previousBuiltinPluginsDirectory: string | undefined;

    /** 调度 beforeChatModelRequest 钩子并返回钩子改写后的 extraHeaders */
    async function applyChatModelRequest(): Promise<Record<string, string> | undefined> {
        const ctx = {
            chat: new ChatContext(),
            model: new ModelInstance('mock-model', 'https://example.test/v1', 'key', true),
            options: {}
        };
        await GlobalHooks.applyBeforeChatModelRequest(ctx);
        return ctx.options.extraHeaders;
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
                contributions: {
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
        expect(activeSkills.get(PLUGIN_SKILL_BUNDLE)).toEqual([
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
            expect((await SkillRegistry.getInstance().getAllSkillsRaw()).get(PLUGIN_SKILL_BUNDLE)).toEqual([]);
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
                    source: 'managed',
                    managed: true
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
                contributions: {
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

        expect(getPluginHost().listSkills()[0]?.definition).toMatchObject({
            name: 'review-code',
            directory: fs.realpathSync(skillDirectory)
        });
        expect(getPluginHost().listMcpServers()[0]?.definition).toMatchObject({
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
});
