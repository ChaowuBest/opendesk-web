import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ChatContext } from '../../../main/aikernel/messages.js';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import { disposePluginHost, initializePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import {
    getPluginsDirectory,
    setRuntimePluginsDirectories
} from '../../../main/applications/pluginmgr/management/paths.js';
import { getPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { ModelInstance, Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

declare global {
    // 插件模块在宿主全局上累计 setup 次数，用于断言插件是否被重新执行
    var __deltaKeeperSetups: number | undefined;
    var __deltaFirstSetups: number | undefined;
    var __deltaChannel: unknown;
    var __deltaKeeperChannel: unknown;
}

/**
 * 回归测试：在插件管理界面关闭（禁用）单个插件时，其他未受影响的插件实例
 * 不得被销毁重建（模块重新执行 / teardown / 重启）。修复前 setEnabled 无条件
 * 走 reloadPluginHost 全量 dispose + initialize，导致所有插件一起重启。
 */
describe('插件单插件差量启停', () => {
    // 用例走真实落盘插件加载与宿主生命周期，全量并发跑时易受 CPU 饥饿影响，
    // 默认 5s 会被拖到超时（单跑/目录跑均 ~1s 内完成），这里放宽到 30s。
    jest.setTimeout(30000);

    let configDirectory: string;

    /** 调度 beforeChatModelRequest 钩子并返回钩子改写后的请求选项 */
    async function applyChatModelRequestOptions(): Promise<{ extraHeaders?: Record<string, string> }> {
        const ctx = {
            chat: new ChatContext(),
            model: new ModelInstance('mock-model', 'https://example.test/v1', 'key', true),
            options: {} as { extraHeaders?: Record<string, string> }
        };
        await GlobalHooks.applyBeforeChatModelRequest(ctx);
        return ctx.options;
    }

    /** 写入一个真实落盘的插件 */
    function writePlugin(id: string, body: string): void {
        const localDirectory = getPluginsDirectory(configDirectory);
        fs.mkdirSync(localDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(localDirectory, `${id}.mjs`),
            `export default { id: '${id}', setup(ctx) { ${body} } };`
        );
    }

    /** 落盘并启用一个插件，确保宿主中实际激活 */
    async function activatePlugin(id: string, body: string): Promise<void> {
        writePlugin(id, body);
        const application = new PluginMgrApplication();
        await application.setEnabled(id, true);
        if (!getPluginHost().get(id)) throw new Error(`plugin ${id} not activated`);
    }

    /** 以 pluginmgr 身份注册应用实例，使 emitEvent 走真实派发路径 */
    async function withRegisteredPluginMgr<T>(application: PluginMgrApplication, task: () => Promise<T>): Promise<T> {
        const { ApplicationRegistry } = await import('../../../main/applications/registry.js');
        const previous = ApplicationRegistry.applications.get('pluginmgr');
        ApplicationRegistry.applications.set('pluginmgr', application);
        application.setRegistry(ApplicationRegistry);
        try {
            return await task();
        } finally {
            if (previous) {
                ApplicationRegistry.applications.set('pluginmgr', previous);
            } else {
                ApplicationRegistry.applications.delete('pluginmgr');
            }
        }
    }

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-delta-'));
        setCustomOpendeskDirectory(configDirectory);
        setRuntimePluginsDirectories('');
        Setting.clearCache();
    });

    afterEach(async () => {
        await disposePluginHost();
        setRuntimePluginsDirectories('');
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('禁用单个插件时其他插件的实例与注册贡献保持不变', async () => {
        await activatePlugin(
            'delta-keeper',
            `globalThis.__deltaKeeperSetups = (globalThis.__deltaKeeperSetups ?? 0) + 1;
             ctx.hooks.on('chat.headers', (_i, o) => { o.headers['x-keeper'] = 'v1'; });`
        );
        await activatePlugin(
            'delta-victim',
            `ctx.hooks.on('chat.headers', (_i, o) => { o.headers['x-victim'] = 'v1'; });`
        );
        await initializePluginHost();
        expect(getPluginHost().get('delta-keeper')?.status).toBe('active');
        expect(getPluginHost().get('delta-victim')?.status).toBe('active');

        const application = new PluginMgrApplication();
        const setupsBefore = globalThis.__deltaKeeperSetups;
        await application.setEnabled('delta-victim', false);

        // 目标插件已从运行时移除
        expect(getPluginHost().get('delta-victim')).toBeUndefined();
        // 保留插件未被重启（模块未重新执行），其 hook 继续生效且被禁用插件的 hook 不残留
        expect(globalThis.__deltaKeeperSetups).toBe(setupsBefore);
        const { extraHeaders } = await applyChatModelRequestOptions();
        expect(extraHeaders).toEqual({ 'x-keeper': 'v1' });
    });

    test('启用单个插件时只加载新插件，其他插件实例保持不变', async () => {
        const application = new PluginMgrApplication();
        // 先落盘并置为禁用，保证随后的 initialize 只激活 first 一个插件
        writePlugin('delta-later', '');
        await application.setEnabled('delta-later', false);
        await activatePlugin(
            'delta-first',
            `globalThis.__deltaFirstSetups = (globalThis.__deltaFirstSetups ?? 0) + 1;
             ctx.hooks.on('chat.headers', (_i, o) => { o.headers['x-first'] = 'v1'; });`
        );
        await initializePluginHost();
        expect(getPluginHost().get('delta-first')?.status).toBe('active');
        expect(getPluginHost().get('delta-later')).toBeUndefined();

        const setupsBefore = globalThis.__deltaFirstSetups;
        await application.setEnabled('delta-later', true);

        expect(getPluginHost().get('delta-later')).toMatchObject({ id: 'delta-later', status: 'active' });
        // 未受影响插件不经历 deactivate + activate 循环（模块未重新执行）
        expect(globalThis.__deltaFirstSetups).toBe(setupsBefore);
    });

    test('差量启停后插件贡献的 agent 按插件差量同步到 AgentRegistry', async () => {
        await activatePlugin('delta-agent-keeper', '');
        await activatePlugin(
            'delta-agent-victim',
            `ctx.agents.register({ name: 'side-agent', whenToUse: 'side agent for tests', body: 'side agent body', dispatchable: true });`
        );
        await initializePluginHost();
        expect(AgentRegistry.getAgent('delta-agent-victim:side-agent')).toBeDefined();

        const application = new PluginMgrApplication();
        await application.setEnabled('delta-agent-victim', false);

        expect(AgentRegistry.getAgent('delta-agent-victim:side-agent')).toBeUndefined();
        // 其他插件的 agent 不受影响
        expect(getPluginHost().get('delta-agent-keeper')?.status).toBe('active');
    });

    test('非渠道类插件启停同样广播 pluginsChanged（事件契约）', async () => {
        await activatePlugin(
            'delta-hook-only',
            `ctx.hooks.on('chat.headers', (_i, o) => { o.headers['x-hook'] = 'v1'; });`
        );
        await initializePluginHost();

        const { ApplicationRegistry } = await import('../../../main/applications/registry.js');
        const changedIds: Array<string | undefined> = [];
        const removeListener = ApplicationRegistry.onApplicationEvent((bundleName, eventName, args) => {
            if (bundleName === 'pluginmgr' && eventName === 'pluginsChanged') {
                changedIds.push((args[0] as { id?: string } | undefined)?.id);
            }
        });

        const application = new PluginMgrApplication();
        try {
            await withRegisteredPluginMgr(application, async () => {
                await application.setEnabled('delta-hook-only', false);
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        } finally {
            removeListener();
        }

        // 事件是公开契约（todomgr 触发器、插件订阅者），非渠道插件的启停同样要广播
        expect(changedIds).toEqual(['delta-hook-only']);
    });

    test('启用失败时抛出原因并回滚注册表状态', async () => {
        writePlugin('delta-broken', `throw new Error('boom');`);
        const application = new PluginMgrApplication();
        // 先在宿主未加载该插件时置为禁用，避免随后 initialize 时被加载
        await application.setEnabled('delta-broken', false);

        await expect(application.setEnabled('delta-broken', true)).rejects.toThrow('plugin.activate_failed');
        expect(getPluginHost().get('delta-broken')).toBeUndefined();
        // 注册表回滚为禁用，不留下「已启用但未生效」的状态
        expect(getPluginRecord('delta-broken', configDirectory)?.enabled).toBe(false);
    });

    test('渠道类插件启停按宿主注册表差量同步，不依赖 channel id 与插件 id 相同', async () => {
        const { ChannelMgrApplication } = await import('../../../main/applications/channelmgr/app.js');

        const makeChannel = (id: string): any => ({
            meta: { id, label: id, description: `${id} channel` },
            capabilities: { chatTypes: ['direct'], media: false, threading: false, interactive: false },
            setChannelRuntimeContext: jest.fn(),
            listAccounts: jest.fn(async () => [{ accountId: 'default', accountName: id }]),
            start: jest.fn(async () => {}),
            stop: jest.fn(async () => {}),
            sendOutboundMessage: jest.fn(async () => ({}))
        });

        await initializePluginHost();
        // victim 与 keeper 都通过真实落盘插件注册（渠道实例经 globalThis 传递给插件模块），
        // 且 channel id 与插件 id 故意不同：差量同步不能依赖两者相等
        const keeperChannel = makeChannel('delta-ch-keeper');
        const victimChannel = makeChannel('delta-ch-victim-channel');
        globalThis.__deltaChannel = victimChannel;
        globalThis.__deltaKeeperChannel = keeperChannel;
        writePlugin('delta-ch-victim-plugin', `ctx.channels.register(globalThis.__deltaChannel);`);
        writePlugin('delta-ch-keeper-plugin', `ctx.channels.register(globalThis.__deltaKeeperChannel);`);
        await new PluginMgrApplication().setEnabled('delta-ch-victim-plugin', true);
        await new PluginMgrApplication().setEnabled('delta-ch-keeper-plugin', true);

        const channelApplication = new ChannelMgrApplication();
        const app = channelApplication as unknown as {
            plugins: Array<{ id: string; channelPlugin?: unknown }>;
            loadNativeChannels: () => void;
            startChannelPlugin: (entry: unknown) => Promise<void>;
            subscribePluginChangedBridge: () => void;
        };
        // 注册与 initialize() 相同的 pluginsChanged 桥接监听
        app.subscribePluginChangedBridge();
        // 预置渠道运行时：仅保留本测试注册的两个渠道（仓库内置渠道插件不在断言范围）
        app.plugins = [];
        app.loadNativeChannels();
        app.plugins = app.plugins.filter((entry) => entry.id.startsWith('delta-ch-'));
        for (const entry of app.plugins.filter((p) => p.channelPlugin)) {
            await app.startChannelPlugin(entry);
        }
        expect(keeperChannel.start).toHaveBeenCalledTimes(1);
        expect(victimChannel.start).toHaveBeenCalledTimes(1);

        const application = new PluginMgrApplication();
        // 注册应用使 pluginsChanged 经 ApplicationRegistry 真实派发到差量同步方法
        await withRegisteredPluginMgr(application, async () => {
            await application.setEnabled('delta-ch-victim-plugin', false);
            await new Promise((resolve) => setTimeout(resolve, 20));

            // 禁用：victim 渠道被停止并移除，keeper 保留且连接未被重启
            expect(app.plugins.map((entry) => entry.id)).toEqual(['delta-ch-keeper']);
            expect(keeperChannel.start).toHaveBeenCalledTimes(1);
            expect(keeperChannel.stop).not.toHaveBeenCalled();
            expect(victimChannel.stop).toHaveBeenCalled();

            // 重新启用：按插件 id 对应的 channel id 重新收集并启动该渠道
            await application.setEnabled('delta-ch-victim-plugin', true);
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(app.plugins.map((entry) => entry.id).sort()).toEqual(['delta-ch-keeper', 'delta-ch-victim-channel']);
            expect(victimChannel.start).toHaveBeenCalledTimes(2);
            expect(keeperChannel.start).toHaveBeenCalledTimes(1);

            // 插件重载后宿主会用新的 channel 实例重新注册：本地运行时必须换成新实例，
            // 否则收发会落到已销毁的插件对象上
            const rebuiltChannel = makeChannel('delta-ch-victim-channel');
            globalThis.__deltaChannel = rebuiltChannel;
            await application.reload('delta-ch-victim-plugin');
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(app.plugins.map((entry) => entry.id).sort()).toEqual(['delta-ch-keeper', 'delta-ch-victim-channel']);
            expect(victimChannel.stop).toHaveBeenCalled();
            expect(rebuiltChannel.start).toHaveBeenCalledTimes(1);
            // 其他插件的渠道仍以同一实例注册：连接保持，不因无关重载被动重启
            expect(keeperChannel.start).toHaveBeenCalledTimes(1);
            expect(keeperChannel.stop).toHaveBeenCalledTimes(0);
        });
    });
});
