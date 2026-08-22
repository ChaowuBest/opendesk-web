import { jest } from '@jest/globals';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import {
    GetPluginDetailsTool,
    InstallPluginTool,
    ListPluginsTool,
    ReloadPluginsTool,
    SetPluginEnabledTool,
    UninstallPluginTool
} from '../../../main/applications/pluginmgr/tools.js';

function createPluginApp(overrides: Record<string, unknown> = {}) {
    return {
        list: jest.fn(async () => [
            {
                id: 'review-helper',
                source: 'local',
                removable: true,
                enabled: true,
                manifest: {
                    displayName: 'Review Helper',
                    version: '1.0.0',
                    apiVersion: 1,
                    capabilities: ['tools']
                },
                runtime: { status: 'active' },
                skills: [{ name: 'review-code' }],
                mcpServers: []
            },
            {
                id: 'external-helper',
                source: 'external',
                removable: false,
                enabled: false,
                runtime: { status: 'disabled' },
                skills: [],
                mcpServers: []
            }
        ]),
        install: jest.fn(async (spec: string) => ({ success: true, id: 'installed-plugin', spec })),
        uninstall: jest.fn(async (id: string) => ({ success: true, id })),
        setEnabled: jest.fn(async () => []),
        reload: jest.fn(async () => []),
        ...overrides
    };
}

describe('PluginMgr management tools', () => {
    test('plugin manager exposes one plugin management and development skill with the complete plugin toolset', async () => {
        const app = Object.create(PluginMgrApplication.prototype) as PluginMgrApplication;

        const skills = await app.getSkills();
        const toolNames = Array.from(skills[0].toolsets?.[0].tools.keys() ?? []);

        expect(skills).toHaveLength(1);
        expect(skills[0].frontmatter.name).toBe('manage-plugins');
        expect(toolNames).toEqual([
            'listPlugins',
            'getPluginDetails',
            'installPlugin',
            'uninstallPlugin',
            'setPluginEnabled',
            'reloadPlugins'
        ]);
        const instructions = skills[0].getFullContent();
        expect(instructions).toMatch(/uninstallPlugin/);
        expect(instructions).toContain('https://opendesk.matrix.openharmony.cn/docs/plugins/development/');
        expect(instructions).toMatch(/协助用户设计、编写或修改插件源码/);
        expect(instructions).not.toMatch(/definePlugin|ctx\.hooks|ctx\.tools|opendesk\.plugin\.json/);
        expect(instructions).not.toMatch(/从零开发流程|开发需求门禁|工具渲染/);
    });

    test('listPlugins supports source and enabled filters', async () => {
        const app = createPluginApp();
        const tool = new ListPluginsTool(app as any);

        const result = await tool.execute({ source: 'local', enabled: true });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            plugins: [
                expect.objectContaining({
                    id: 'review-helper',
                    source: 'local',
                    enabled: true,
                    version: '1.0.0',
                    status: 'active'
                })
            ]
        });
    });

    test('getPluginDetails returns manifest, contributions, capabilities and verification', async () => {
        const plugin = {
            id: 'review-helper',
            source: 'local',
            removable: true,
            enabled: true,
            manifest: {
                displayName: 'Review Helper',
                version: '1.0.0',
                apiVersion: 1,
                capabilities: ['tools', 'skills']
            },
            verification: { integrityStatus: 'verified', allowed: true },
            runtime: { status: 'active', diagnostics: [] },
            skills: [{ name: 'review-code' }],
            mcpServers: [{ name: 'review-mcp', transport: 'stdio' }]
        };
        const app = createPluginApp({ list: jest.fn(async () => [plugin]) });
        const tool = new GetPluginDetailsTool(app as any);

        const result = await tool.execute({ id: 'review-helper' });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({ plugin });
    });

    test('getPluginDetails reports a missing plugin as an error', async () => {
        const app = createPluginApp({ list: jest.fn(async () => []) });
        const tool = new GetPluginDetailsTool(app as any);

        const result = await tool.execute({ id: 'missing-plugin' });

        expect(result.status).toBe('error');
        expect(result.result).toContain('missing-plugin');
    });

    test('installPlugin delegates every supported spec form to the application', async () => {
        const app = createPluginApp();
        const tool = new InstallPluginTool(app as any);

        const result = await tool.execute({ spec: '@example/opendesk-plugin@1.0.0' });

        expect(app.install).toHaveBeenCalledWith('@example/opendesk-plugin@1.0.0');
        expect(JSON.parse(result.result)).toMatchObject({ success: true, id: 'installed-plugin' });
        expect(tool.getDeclaredPermissions({ spec: '@example/opendesk-plugin@1.0.0' })).toEqual([
            {
                resourceType: 'plugin',
                action: 'write',
                resourcePath: '@example/opendesk-plugin@1.0.0'
            },
            {
                resourceType: 'plugin',
                action: 'execute',
                resourcePath: '@example/opendesk-plugin@1.0.0'
            }
        ]);
    });

    test('uninstallPlugin delegates enforcement to the application', async () => {
        const app = createPluginApp();
        const tool = new UninstallPluginTool(app as any);

        const result = await tool.execute({ id: 'review-helper' });

        expect(app.uninstall).toHaveBeenCalledWith('review-helper');
        expect(JSON.parse(result.result)).toEqual({ success: true, id: 'review-helper' });
        expect(tool.getDeclaredPermissions({ id: 'review-helper' })).toEqual([
            { resourceType: 'plugin', action: 'write', resourcePath: 'review-helper' }
        ]);
    });

    test('setPluginEnabled refreshes plugin state and requires execute permission only when enabling', async () => {
        const app = createPluginApp();
        const tool = new SetPluginEnabledTool(app as any);

        const result = await tool.execute({ id: 'review-helper', enabled: false });

        expect(app.setEnabled).toHaveBeenCalledWith('review-helper', false);
        expect(JSON.parse(result.result)).toEqual({ success: true, id: 'review-helper', enabled: false });
        expect(tool.getDeclaredPermissions({ id: 'review-helper', enabled: false })).toEqual([
            { resourceType: 'plugin', action: 'write', resourcePath: 'review-helper' }
        ]);
        expect(tool.getDeclaredPermissions({ id: 'review-helper', enabled: true })).toEqual([
            { resourceType: 'plugin', action: 'write', resourcePath: 'review-helper' },
            { resourceType: 'plugin', action: 'execute', resourcePath: 'review-helper' }
        ]);
    });

    test('reloadPlugins reloads discovery and runtime registrations', async () => {
        const app = createPluginApp();
        const tool = new ReloadPluginsTool(app as any);

        const result = await tool.execute({});

        expect(app.reload).toHaveBeenCalledWith();
        expect(JSON.parse(result.result)).toEqual({ success: true, plugins: [] });
        expect(tool.getDeclaredPermissions({})).toEqual([
            { resourceType: 'plugin', action: 'execute', resourcePath: '**' }
        ]);
    });
});
