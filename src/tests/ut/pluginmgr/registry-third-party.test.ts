import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

/**
 * 第三方注册表插件 E2E：非内置的外部插件（临时目录 + manifest 声明 registry
 * capability）经 discoverPlugins → loadPlugin → PluginHost 激活后，能够向
 * skillmgr / mcpmgr 扩充注册表，并完成搜索、安装路由与停用回收的完整流程。
 * 这是「有效扩充新的 registry」对第三方插件作者可见的完整路径。
 */

const PLUGIN_MANIFEST = {
    schemaVersion: 1,
    id: 'acme-registry-plugin',
    displayName: { en: 'Acme Registry', zh: 'Acme 注册表' },
    entry: './index.mjs',
    apiVersion: 1,
    capabilities: ['registry']
};

// 第三方插件入口：同时贡献一个技能注册表（含 resolveInstall 与 filters）和一个 MCP 注册表
const PLUGIN_ENTRY = `
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'acme-registry-plugin',
    async setup(context) {
        context.registry.registerSkillRegistry({
            id: 'acme-registry',
            label: 'Acme Registry',
            icon: '🧪',
            slogan: 'Acme skills for everyone',
            filters: [{ id: 'acme_filter', labelOn: 'Acme only', labelOff: 'All', categoryValue: 'acme' }],
            async search(options = {}) {
                return {
                    skills: [{
                        id: 'acme-skill',
                        name: 'acme-skill',
                        description: 'A skill from the acme registry',
                        source: 'acme-registry',
                        installUrl: 'acme-registry:acme-skill',
                        canInstall: true
                    }],
                    total: 1,
                    hasMore: false
                };
            },
            async resolveInstall(installUrl, parsed) {
                return { downloadUrl: 'https://dl.acme.example/' + parsed.slug + '.zip' };
            }
        });
        context.registry.registerMcpRegistry({
            id: 'acme-mcp',
            label: 'Acme MCPs',
            icon: '🛠️',
            async search() {
                return {
                    mcps: [{
                        id: 'acme-server',
                        name: 'acme-server',
                        description: 'An MCP from acme',
                        source: 'acme-mcp',
                        installUrl: 'acme-mcp:acme-server',
                        configuration: JSON.stringify({ mcpServers: { acme: { command: 'acme-cmd' } } }),
                        canInstall: true
                    }],
                    total: 1,
                    hasMore: false
                };
            },
            async getDetail(id) {
                if (id !== 'acme-server') return null;
                return {
                    id: 'acme-server',
                    name: 'acme-server',
                    description: 'An MCP from acme',
                    source: 'acme-mcp',
                    installUrl: 'acme-mcp:acme-server',
                    configuration: JSON.stringify({ mcpServers: { acme: { command: 'acme-cmd' } } }),
                    canInstall: true
                };
            }
        });
    }
});
`;

async function writeAcmePlugin(): Promise<string> {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-registry-plugin-'));
    fs.writeFileSync(path.join(pluginDir, 'opendesk.plugin.json'), JSON.stringify(PLUGIN_MANIFEST));
    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), PLUGIN_ENTRY);
    return pluginDir;
}

describe('第三方注册表插件 E2E', () => {
    test('外部插件经 discovery → loadPlugin → 激活后扩充两侧注册表，停用后回收', async () => {
        const pluginDir = await writeAcmePlugin();
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-config-'));
        // 附加插件目录经 Setting 读取 externalPaths，必须指向隔离目录，否则会带上开发机的真实配置
        const { Setting, setCustomOpendeskDirectory } = await import('../../../main/utils/setting.js');
        setCustomOpendeskDirectory(configDir);
        Setting.clearCache();
        const globalHostModule = await import('../../../main/applications/pluginmgr/runtime/host.js');
        const { initializePluginRegistryProvider, disposePluginRegistryProvider } =
            await import('../../../main/applications/pluginmgr/runtime/registry-providers.js');
        const { discoverPlugins } = await import('../../../main/applications/pluginmgr/discovery/discovery.js');
        const { loadPlugin } = await import('../../../main/applications/pluginmgr/discovery/loader.js');
        const mcpRegistry = await import('../../../main/applications/mcpmgr/registry/index.js');
        const skillRegistryIndex = await import('../../../main/applications/skillmgr/registry/index.js');
        const { SkillInstallManager } = await import('../../../main/applications/skillmgr/utils/skill-installer.js');

        initializePluginRegistryProvider();
        const globalHost = globalHostModule.getPluginHost();
        const originalRegistries = {
            mcp: [...mcpRegistry.allRegistries],
            skill: [...skillRegistryIndex.allRegistries]
        };

        try {
            // 1. 发现：附加插件目录里的插件以内置插件身份进入候选
            const discovery = discoverPlugins({ configDirectory: configDir, builtinDirectories: [pluginDir] });
            const candidate = discovery.candidates.find((item) => item.id === 'acme-registry-plugin');
            expect(candidate).toBeDefined();
            expect(candidate?.source).toBe('builtin');

            // 2. 加载 + 激活：manifest 声明的 registry capability 被授予
            const loaded = await loadPlugin(candidate!, configDir, { requireDeclaration: true });
            expect(loaded.plugin.capabilities).toEqual(['registry']);
            const entry = await globalHost.activate(loaded.plugin, {
                origin: candidate!.origin,
                pluginDir: loaded.rootDir,
                configDir
            });
            expect(entry.status).toBe('active');
            expect(entry.capabilities).toContain('registry');

            // 3. 扩充：两侧 allRegistries 均出现第三方注册表
            await mcpRegistry.ensureMcpRegistriesSynced();
            await skillRegistryIndex.ensureSkillRegistriesSynced();

            expect(mcpRegistry.getRegistry('acme-mcp')).toBeDefined();
            expect(skillRegistryIndex.getRegistry('acme-registry')).toBeDefined();
            expect(mcpRegistry.parseInstallUrl('acme-mcp:acme-server')).toEqual({
                registryId: 'acme-mcp',
                id: 'acme-server'
            });
            expect(skillRegistryIndex.getInstallMethod('acme-registry:acme-skill')).toBe('acme-registry');

            // 4. 搜索与安装路由走第三方定义
            const skillResult = await skillRegistryIndex.searchRegistry('acme-registry', { query: 'acme' });
            expect(skillResult.skills[0]).toMatchObject({ id: 'acme-skill', source: 'acme-registry' });

            const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
            const installFromUrlSpy = jest.fn(async (url: string) => ({ success: true, name: url }));
            (manager as unknown as { installFromUrl: unknown }).installFromUrl = installFromUrlSpy;
            const installResult = await manager.installFromRegistryInstallUrl('acme-registry:acme-skill');
            expect(installResult.success).toBe(true);
            expect(installFromUrlSpy).toHaveBeenCalledWith('https://dl.acme.example/acme-skill.zip', expect.anything());

            const mcpDetail = await mcpRegistry.getRegistry('acme-mcp')!.getDetail('acme-server');
            expect(mcpDetail).toMatchObject({ id: 'acme-server', canInstall: true });

            // 5. 停用回收：deactivate 后同步，第三方注册表从两侧移除
            await globalHost.deactivate('acme-registry-plugin');
            await mcpRegistry.ensureMcpRegistriesSynced();
            await skillRegistryIndex.ensureSkillRegistriesSynced();

            expect(mcpRegistry.getRegistry('acme-mcp')).toBeUndefined();
            expect(skillRegistryIndex.getRegistry('acme-registry')).toBeUndefined();
        } finally {
            disposePluginRegistryProvider();
            await globalHost.dispose().catch(() => undefined);
            mcpRegistry.allRegistries.splice(0, mcpRegistry.allRegistries.length, ...originalRegistries.mcp);
            skillRegistryIndex.allRegistries.splice(
                0,
                skillRegistryIndex.allRegistries.length,
                ...originalRegistries.skill
            );
            fs.rmSync(pluginDir, { recursive: true, force: true });
            Setting.clearCache();
            setCustomOpendeskDirectory(undefined);
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });
});
