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
                    ctx.features.disable('memory');
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
                ctx.features.disable('memory');
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
            ctx.features.disable('memory');
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
            ctx.features.disable('not-a-feature');
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
            const registration = ctx.features.disable('memory');
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
            ctx.features.disable('filesystem');
        });
        await activateFeaturePlugin(host, 'features-second', (ctx) => {
            ctx.features.disable('filesystem');
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
            registrations.push(ctx.features.disable('memory'), ctx.features.disable('memory'));
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
            ctx.features.disable('memory');
            ctx.features.disableApplication('filemgr');
        });
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(true);

        await host.deactivate('features-mixed');
        expect(getFeatureManager().getSnapshot()).toEqual({ disabledFeatures: [], disabledApplications: [] });
        await host.dispose();
    });

    test('host.dispose 清空全部禁用', async () => {
        const host = new PluginHost();
        await activateFeaturePlugin(host, 'features-dispose', (ctx) => {
            ctx.features.disable('memory');
            ctx.features.disable('filesystem');
            ctx.features.disableApplication('filemgr');
        });

        await host.dispose();
        expect(getFeatureManager().getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: []
        });
    });
});
