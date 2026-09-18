import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

/**
 * 带 npm 依赖的注册表插件安装 E2E：
 * 插件 package.json 声明运行时依赖（以及一个宿主映射包），installPlugin 经
 * installPluginDependencies 把「name@range」交给 runNpm（此处用 stub 模拟 npm
 * 成功安装并落盘真实模块），验证：宿主映射包不进安装清单、依赖模块随插件目录
 * 迁移、插件激活后其注册表能使用依赖完成搜索。
 */

const PLUGIN_MANIFEST = {
    schemaVersion: 1,
    id: 'acme-dep-plugin',
    displayName: { en: 'Acme Dep Registry', zh: 'Acme 依赖注册表' },
    entry: './index.mjs',
    apiVersion: 1,
    capabilities: ['registry']
};

const PLUGIN_PACKAGE_JSON = {
    name: 'acme-dep-plugin',
    private: true,
    dependencies: {
        'acme-helper': '^1.0.0',
        // 宿主映射包：不应出现在 npm 安装清单中（package-mapping 运行时兜底）
        '@bitclub.ai/opendesk-plugin-sdk': '^0.1.0'
    }
};

const PLUGIN_ENTRY = `
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { acmeGreet } from 'acme-helper';

export default definePlugin({
    id: 'acme-dep-plugin',
    async setup(context) {
        context.registry.registerSkillRegistry({
            id: 'acme-dep',
            label: 'Acme Dep',
            async search() {
                return {
                    skills: [{
                        id: acmeGreet(),
                        name: acmeGreet(),
                        description: 'skill built with acme-helper',
                        source: 'acme-dep',
                        installUrl: 'acme-dep:' + acmeGreet(),
                        canInstall: true
                    }],
                    total: 1,
                    hasMore: false
                };
            }
        });
    }
});

`;

async function writePluginSource(): Promise<string> {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-dep-source-'));
    fs.writeFileSync(path.join(sourceDir, 'opendesk.plugin.json'), JSON.stringify(PLUGIN_MANIFEST));
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify(PLUGIN_PACKAGE_JSON));
    fs.writeFileSync(path.join(sourceDir, 'index.mjs'), PLUGIN_ENTRY);
    return sourceDir;
}

describe('带 npm 依赖的注册表插件安装', () => {
    test('依赖经 runNpm 安装、宿主映射包被排除、激活后注册表使用依赖工作', async () => {
        const sourceDir = await writePluginSource();
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-dep-config-'));
        const globalHostModule = await import('../../../main/applications/pluginmgr/runtime/host.js');
        const manager = await import('../../../main/applications/pluginmgr/management/manager.js');
        const { getPluginRecord } = await import('../../../main/applications/pluginmgr/management/registry.js');
        const { discoverPlugins } = await import('../../../main/applications/pluginmgr/discovery/discovery.js');
        const { loadPlugin } = await import('../../../main/applications/pluginmgr/discovery/loader.js');
        const registryProviders = await import('../../../main/applications/pluginmgr/runtime/registry-providers.js');
        const skillRegistryIndex = await import('../../../main/applications/skillmgr/registry/index.js');

        registryProviders.initializePluginRegistryProvider();
        const globalHost = globalHostModule.getPluginHost();
        const originalSkillRegistries = [...skillRegistryIndex.allRegistries];

        try {
            // runNpm stub：断言安装清单只含非宿主映射依赖，并把真实模块落盘到
            // 传入的 cwd（staging 插件目录的 node_modules），随后随目录一起迁移
            const runNpm = jest.fn(async (args: string[], cwd: string) => {
                expect(args[0]).toBe('install');
                expect(args).toContain('acme-helper@^1.0.0');
                expect(args.join(' ')).not.toContain('@bitclub.ai/opendesk-plugin-sdk');
                expect(args).toContain('--no-save');

                const helperRoot = path.join(cwd, 'node_modules', 'acme-helper');
                fs.mkdirSync(helperRoot, { recursive: true });
                fs.writeFileSync(
                    path.join(helperRoot, 'package.json'),
                    JSON.stringify({ name: 'acme-helper', version: '1.0.0', main: 'index.mjs' })
                );
                fs.writeFileSync(
                    path.join(helperRoot, 'index.mjs'),
                    'export function acmeGreet() { return "acme-dep-skill"; }\n'
                );
            });

            const installed = await manager.installPlugin(sourceDir, { configDirectory: configDir, runNpm });
            expect(installed).toMatchObject({ success: true, id: 'acme-dep-plugin' });
            expect(runNpm).toHaveBeenCalledTimes(1);
            expect(getPluginRecord('acme-dep-plugin', configDir)).toBeDefined();

            // 安装后的插件目录带着 node_modules 一起迁移，依赖可被入口解析
            const discovery = discoverPlugins({ configDirectory: configDir });
            const candidate = discovery.candidates.find((item) => item.id === 'acme-dep-plugin');
            expect(candidate).toBeDefined();
            const loaded = await loadPlugin(candidate!, configDir, { requireDeclaration: true });
            const entry = await globalHost.activate(loaded.plugin, {
                origin: candidate!.origin,
                pluginDir: loaded.rootDir,
                configDir
            });
            expect(entry.status).toBe('active');

            await skillRegistryIndex.ensureSkillRegistriesSynced();
            const result = await skillRegistryIndex.searchRegistry('acme-dep', {});
            expect(result.skills[0]).toMatchObject({ id: 'acme-dep-skill', source: 'acme-dep' });
        } finally {
            registryProviders.disposePluginRegistryProvider();
            await globalHost.dispose().catch(() => undefined);
            skillRegistryIndex.allRegistries.splice(
                0,
                skillRegistryIndex.allRegistries.length,
                ...originalSkillRegistries
            );
            fs.rmSync(sourceDir, { recursive: true, force: true });
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });
});
