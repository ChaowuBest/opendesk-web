import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { BaseApplication } from '../../../main/applications/base.js';
import { definePlugin, OPENDESK_PLUGIN_CAPABILITIES } from '../../../../packages/plugin-sdk/src/index.js';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';

class StubApplication extends BaseApplication {
    constructor(bundleName: string) {
        super(bundleName, true);
    }

    getName(): string {
        return this.bundleName;
    }
}

describe('features capability', () => {
    let pluginDir: string;
    let originalApplications: Map<string, BaseApplication>;

    beforeEach(() => {
        pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-features-'));
        resetFeatureManagerForTests();
        originalApplications = ApplicationRegistry.applications;
        ApplicationRegistry.applications = new Map([['filemgr', new StubApplication('filemgr')]]);
    });

    afterEach(() => {
        ApplicationRegistry.applications = originalApplications;
        resetFeatureManagerForTests();
        fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    async function activateFeaturePlugin(
        host: PluginHost,
        id: string,
        setup: (ctx: any) => void,
        grantedCapabilities?: string[]
    ) {
        return await host.activate(
            definePlugin({
                id,
                capabilities: ['features'],
                setup
            }) as any,
            {
                origin: `test:${id}`,
                pluginDir,
                ...(grantedCapabilities ? { grantedCapabilities: grantedCapabilities as any } : {})
            }
        );
    }

    test('features 在插件能力列表中', () => {
        expect(OPENDESK_PLUGIN_CAPABILITIES).toContain('features');
    });

    test('manifest 接受 features 能力', () => {
        const manifest = parsePluginManifest({
            entry: './index.mjs',
            apiVersion: 1,
            capabilities: ['features']
        });
        expect(manifest.capabilities).toEqual(['features']);
    });

    test('未声明 features capability 时 disable 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'features-undeclared',
                capabilities: [],
                setup(ctx: any) {
                    ctx.features.disableFeature('memory');
                }
            }),
            { origin: 'test:features-undeclared', pluginDir }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:features');
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
        await host.dispose();
    });

    test('未授权 features capability 时插件被禁用', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(
            host,
            'features-ungranted',
            (ctx) => {
                ctx.features.disableFeature('memory');
            },
            []
        );

        expect(entry.status).toBe('disabled');
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
        await host.dispose();
    });

    test('disable 禁用内置特性并记录能力', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-memory', (ctx) => {
            ctx.features.disableFeature('memory');
        });

        expect(entry.status).toBe('active');
        expect(entry.capabilities).toContain('features');
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
        expect(getFeatureManager().listDisabledFeatures()).toEqual([{ id: 'memory', pluginIds: ['features-memory'] }]);
        await host.dispose();
    });

    test('disable 未知特性 id 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-unknown', (ctx) => {
            ctx.features.disableFeature('not-a-feature');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('features.unknown_feature:not-a-feature');
        await host.dispose();
    });

    test('disableApplication 校验 bundleName 并禁用应用', async () => {
        const host = new PluginHost();
        const notifications: string[] = [];
        const unsubscribe = getFeatureManager().onApplicationsChanged(() => notifications.push('changed'));

        const entry = await activateFeaturePlugin(host, 'features-app-disable', (ctx) => {
            ctx.features.disableApplication('filemgr');
        });

        expect(entry.status).toBe('active');
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(true);
        expect(notifications).toEqual(['changed']);
        unsubscribe();
        await host.dispose();
    });

    test('disableApplication 未知 bundleName 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-app-unknown', (ctx) => {
            ctx.features.disableApplication('no-such-app');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('features.unknown_application:no-such-app');
        expect(getFeatureManager().isApplicationDisabled('no-such-app')).toBe(false);
        await host.dispose();
    });

    test('registration 释放后禁用回退并发出变更通知', async () => {
        const host = new PluginHost();
        const notifications: string[] = [];
        const unsubscribe = getFeatureManager().onFeaturesChanged(() => notifications.push('changed'));

        const entry = await activateFeaturePlugin(host, 'features-revert', async (ctx) => {
            const registration = ctx.features.disableFeature('memory');
            expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
            await registration.dispose();
        });

        expect(entry.status).toBe('active');
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
        expect(notifications).toEqual(['changed', 'changed']);
        unsubscribe();
        await host.dispose();
    });

    test('多插件叠加禁用：全部停用后才恢复', async () => {
        const host = new PluginHost();
        await activateFeaturePlugin(host, 'features-first', (ctx) => {
            ctx.features.disableFeature('filesystem');
        });
        await activateFeaturePlugin(host, 'features-second', (ctx) => {
            ctx.features.disableFeature('filesystem');
        });
        expect(getFeatureManager().isFeatureDisabled('filesystem')).toBe(true);

        await host.deactivate('features-first');
        expect(getFeatureManager().isFeatureDisabled('filesystem')).toBe(true);

        await host.deactivate('features-second');
        expect(getFeatureManager().isFeatureDisabled('filesystem')).toBe(false);
        await host.dispose();
    });

    test('同一插件多次 disable 需全部释放后才恢复', async () => {
        const host = new PluginHost();
        const registrations: Array<{ dispose: () => void }> = [];
        await activateFeaturePlugin(host, 'features-twice', (ctx) => {
            registrations.push(ctx.features.disableFeature('memory'), ctx.features.disableFeature('memory'));
        });
        expect(registrations).toHaveLength(2);
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);

        registrations[0].dispose();
        // 同一插件仍持有一次未释放的禁用
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);

        registrations[1].dispose();
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
        await host.dispose();
    });

    test('插件停用后其特性与应用禁用一并回退', async () => {
        const host = new PluginHost();
        await activateFeaturePlugin(host, 'features-mixed', (ctx) => {
            ctx.features.disableFeature('memory');
            ctx.features.disableApplication('filemgr');
        });
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(true);

        await host.deactivate('features-mixed');
        expect(getFeatureManager().getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: [],
            hiddenApplications: []
        });
        await host.dispose();
    });

    test('host.dispose 清空全部禁用', async () => {
        const host = new PluginHost();
        await activateFeaturePlugin(host, 'features-dispose', (ctx) => {
            ctx.features.disableFeature('memory');
            ctx.features.disableFeature('filesystem');
            ctx.features.disableApplication('filemgr');
        });

        await host.dispose();
        expect(getFeatureManager().getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: [],
            hiddenApplications: []
        });
    });

    test('telemetry 特性可被插件禁用', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-telemetry', (ctx) => {
            ctx.features.disableFeature('telemetry');
        });

        expect(entry.status).toBe('active');
        expect(getFeatureManager().isFeatureDisabled('telemetry')).toBe(true);
        await host.dispose();
    });

    test('hideApplication 校验 bundleName 并只隐藏入口', async () => {
        const host = new PluginHost();
        const notifications: string[] = [];
        const unsubscribe = getFeatureManager().onApplicationsChanged(() => notifications.push('changed'));

        const entry = await activateFeaturePlugin(host, 'features-app-hide', (ctx) => {
            ctx.features.hideApplication('filemgr');
        });

        expect(entry.status).toBe('active');
        expect(getFeatureManager().isApplicationHidden('filemgr')).toBe(true);
        // 隐藏不动用禁用通道：工具集、事件与 worker 调用照旧
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(false);
        expect(notifications).toEqual(['changed']);
        unsubscribe();
        await host.dispose();
        expect(getFeatureManager().isApplicationHidden('filemgr')).toBe(false);
    });

    test('hideApplication 未知 bundleName 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-app-hide-unknown', (ctx) => {
            ctx.features.hideApplication('no-such-app');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('features.unknown_application:no-such-app');
        expect(getFeatureManager().isApplicationHidden('no-such-app')).toBe(false);
        await host.dispose();
    });

    test('应用注册表为空（plugins status 等一次性命令）时跳过存在性校验', async () => {
        // 一次性 CLI 子命令不初始化应用注册表：不能因为查不到 bundleName 就让插件 setup 失败
        ApplicationRegistry.applications = new Map();

        const host = new PluginHost();
        const entry = await activateFeaturePlugin(host, 'features-app-no-registry', (ctx) => {
            ctx.features.hideApplication('browser');
            ctx.features.disableApplication('filemgr');
        });

        expect(entry.status).toBe('active');
        expect(getFeatureManager().isApplicationHidden('browser')).toBe(true);
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(true);
        await host.dispose();
    });
});
