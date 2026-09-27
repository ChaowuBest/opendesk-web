import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

/**
 * 插件市场安装流 × registry capability E2E：
 * 用真实的 manager 安装 API（installPlugin）安装一个第三方注册表插件到隔离的
 * 配置目录，走「安装落盘 → registry 记录（integrity/grantedCapabilities）→
 * 完整性校验 → 授权变更 → 激活 → 注册表可用 → 停用/卸载回收」的完整生命周期。
 * policy（setPluginGrantedCapabilities）写的是全局 opendesk 目录，因此整个测试
 * 在 setCustomOpendeskDirectory 隔离环境下运行。
 */

const PLUGIN_MANIFEST = {
    schemaVersion: 1,
    id: 'acme-store-plugin',
    displayName: { en: 'Acme Store Registry', zh: 'Acme 商店注册表' },
    entry: './index.mjs',
    apiVersion: 1,
    capabilities: ['registry']
};

const PLUGIN_ENTRY = `
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'acme-store-plugin',
    async setup(context) {
        context.registry.registerSkillRegistry({
            id: 'acme-store',
            label: 'Acme Store',
            icon: '🛍️',
            async search() {
                return {
                    skills: [{
                        id: 'store-skill',
                        name: 'store-skill',
                        description: 'skill installed through the plugin market',
                        source: 'acme-store',
                        installUrl: 'acme-store:store-skill',
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

async function writeAcmePluginSource(): Promise<string> {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-store-source-'));
    fs.writeFileSync(path.join(sourceDir, 'opendesk.plugin.json'), JSON.stringify(PLUGIN_MANIFEST));
    fs.writeFileSync(path.join(sourceDir, 'index.mjs'), PLUGIN_ENTRY);
    return sourceDir;
}

describe('插件市场安装流 × registry capability', () => {
    // 沙箱化运行（dynobox 卷）下该端到端安装流（下载解压、完整性校验、注册、
    // 卸载回收）比宿主慢约 5x，jest 默认 5s 超时不够；显式放宽到 30s。
    test('installPlugin 安装的注册表插件经完整性校验与授权后生效，卸载后回收', async () => {
        const sourceDir = await writeAcmePluginSource();
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-store-config-'));
        const { setCustomOpendeskDirectory } = await import('../../../main/utils/setting.js');
        setCustomOpendeskDirectory(configDir);

        const globalHostModule = await import('../../../main/applications/pluginmgr/runtime/host.js');
        const manager = await import('../../../main/applications/pluginmgr/management/manager.js');
        const { getPluginRecord } = await import('../../../main/applications/pluginmgr/management/registry.js');
        const policy = await import('../../../main/applications/pluginmgr/management/policy.js');
        const { discoverPlugins, verifyPluginRecord } =
            await import('../../../main/applications/pluginmgr/discovery/discovery.js');
        const { loadPlugin } = await import('../../../main/applications/pluginmgr/discovery/loader.js');
        const registryProviders = await import('../../../main/applications/pluginmgr/runtime/registry-providers.js');
        const skillRegistryIndex = await import('../../../main/applications/skillmgr/registry/index.js');

        registryProviders.initializePluginRegistryProvider();
        const globalHost = globalHostModule.getPluginHost();
        const originalSkillRegistries = [...skillRegistryIndex.allRegistries];

        try {
            // 1. 通过真实安装 API 安装（目录安装：校验 → 落盘 → integrity → 记录）
            const installed = await manager.installPlugin(sourceDir, { configDirectory: configDir });
            expect(installed).toMatchObject({ success: true, id: 'acme-store-plugin' });

            // 2. 安装记录：source=local、integrity 快照、enabled 默认开
            const record = getPluginRecord('acme-store-plugin', configDir);
            expect(record).toBeDefined();
            expect(record?.source).toBe('local');
            expect(record?.integrity).toBeTruthy();
            expect(record?.enabled).toBe(true);

            // 3. 完整性校验通过（防篡改门不拦截本次安装的注册表插件）
            const verification = verifyPluginRecord(record!, configDir);
            expect(verification.allowed).toBe(true);

            // 4. 发现 → 加载 → 以记录中的授权激活（新装无显式授权 = 请求即授予）
            const discovery = discoverPlugins({ configDirectory: configDir });
            const candidate = discovery.candidates.find((item) => item.id === 'acme-store-plugin');
            expect(candidate?.source).toBe('local');
            const loaded = await loadPlugin(candidate!, configDir, { requireDeclaration: true });
            const entry = await globalHost.activate(loaded.plugin, {
                origin: candidate!.origin,
                pluginDir: loaded.rootDir,
                configDir,
                grantedCapabilities: candidate!.grantedCapabilities,
                integrity: candidate!.integrity
            });
            expect(entry.status).toBe('active');
            expect(entry.grantedCapabilities).toContain('registry');

            // 5. 注册表经 provider 进入 skillmgr 并可搜索
            await skillRegistryIndex.ensureSkillRegistriesSynced();
            expect(skillRegistryIndex.getRegistry('acme-store')).toBeDefined();
            await expect(skillRegistryIndex.searchRegistry('acme-store', {})).resolves.toMatchObject({
                skills: [expect.objectContaining({ id: 'store-skill' })]
            });

            // 6. 授权流：显式授予 ['registry'] 后重激活仍生效
            policy.setPluginGrantedCapabilities('acme-store-plugin', ['registry']);
            expect(getPluginRecord('acme-store-plugin', configDir)?.grantedCapabilities).toEqual(['registry']);
            await globalHost.deactivate('acme-store-plugin');
            const reacquired = discoverPlugins({ configDirectory: configDir }).candidates.find(
                (item) => item.id === 'acme-store-plugin'
            );
            const reloaded = await loadPlugin(reacquired!, configDir, { requireDeclaration: true });
            const reactivated = await globalHost.activate(reloaded.plugin, {
                origin: reacquired!.origin,
                pluginDir: reloaded.rootDir,
                configDir,
                grantedCapabilities: reacquired!.grantedCapabilities
            });
            expect(reactivated.status).toBe('active');
            expect(reactivated.grantedCapabilities).toEqual(['registry']);

            // 7. 撤销授权：grantedCapabilities 为空 → 激活被禁用（plugin.capability_not_granted）
            policy.setPluginGrantedCapabilities('acme-store-plugin', []);
            await globalHost.deactivate('acme-store-plugin');
            const revoked = discoverPlugins({ configDirectory: configDir }).candidates.find(
                (item) => item.id === 'acme-store-plugin'
            );
            expect(revoked?.grantedCapabilities).toEqual([]);
            const revokedLoaded = await loadPlugin(revoked!, configDir, { requireDeclaration: true });
            const revokedEntry = await globalHost.activate(revokedLoaded.plugin, {
                origin: revoked!.origin,
                pluginDir: revokedLoaded.rootDir,
                configDir,
                grantedCapabilities: revoked!.grantedCapabilities
            });
            expect(revokedEntry.status).toBe('disabled');
            expect(revokedEntry.diagnostics[0]?.code).toBe('plugin.capability_not_granted');

            // 8. 卸载回收：记录与目录移除，注册表从列表消失
            await globalHost.deactivate('acme-store-plugin');
            const uninstalled = await manager.uninstallPlugin('acme-store-plugin', configDir);
            expect(uninstalled.success).toBe(true);
            expect(getPluginRecord('acme-store-plugin', configDir)).toBeUndefined();
            expect(fs.existsSync(path.join(configDir, 'plugins', 'acme-store-plugin'))).toBe(false);

            await skillRegistryIndex.ensureSkillRegistriesSynced();
            expect(skillRegistryIndex.getRegistry('acme-store')).toBeUndefined();
        } finally {
            registryProviders.disposePluginRegistryProvider();
            await globalHost.dispose().catch(() => undefined);
            skillRegistryIndex.allRegistries.splice(
                0,
                skillRegistryIndex.allRegistries.length,
                ...originalSkillRegistries
            );
            setCustomOpendeskDirectory(undefined);
            fs.rmSync(sourceDir, { recursive: true, force: true });
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    }, 30_000);
});
