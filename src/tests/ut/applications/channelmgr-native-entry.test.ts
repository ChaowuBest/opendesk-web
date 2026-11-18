import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import {
    createNativeChannelPluginEntry,
    isNativeChannelEntry,
    type NativeChannelAdapter,
    type NativeChannelHostDeps
} from '../../../main/applications/channelmgr/native-channel.js';
import type { Channel, ChannelRuntimeContext } from '../../../../packages/plugin-sdk/src/index.js';
import type { ChannelPlugin } from '../../../main/applications/channelmgr/types.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function makeChannel(): Channel {
    return {
        meta: { id: 'demo', label: { en: 'Demo', zh: '示例' }, description: 'demo channel' },
        capabilities: { chatTypes: ['direct'] }
    } as unknown as Channel;
}

const deps: NativeChannelHostDeps = {
    getConfig: () => ({}),
    dispatch: async () => {},
    dispatchInteraction: async () => {},
    setStatus: () => {},
    emit: () => {}
};

beforeEach(() => {
    // 每个用例固定界面语言，避免依赖测试机器的系统语言
    setRuntimeLocale('en-US');
});

afterAll(() => {
    setRuntimeLocale(null);
});

describe('原生渠道条目', () => {
    test('createNativeChannelPluginEntry 只承载渠道适配器，不再伪造插件 manifest/installRecord', () => {
        const entry = createNativeChannelPluginEntry(makeChannel(), deps);

        expect(Object.keys(entry).sort()).toEqual(['channelPlugin', 'id']);
        expect(entry.id).toBe('demo');
        expect(entry.channelPlugin.id).toBe('demo');
        expect(entry.channelPlugin.meta.label).toBe('Demo');
        expect(isNativeChannelEntry(entry)).toBe(true);
    });

    test('isNativeChannelEntry 只识别原生适配器', () => {
        expect(isNativeChannelEntry({ id: 'x', channelPlugin: {} as ChannelPlugin })).toBe(false);
    });
});

describe('渠道 label 按界面语言解析', () => {
    test('meta.label 按当前语言返回 en / zh 条目', () => {
        const entry = createNativeChannelPluginEntry(makeChannel(), deps);

        setRuntimeLocale('en-US');
        expect(entry.channelPlugin.meta.label).toBe('Demo');
        setRuntimeLocale('zh-CN');
        expect(entry.channelPlugin.meta.label).toBe('示例');
    });

    test('语言切换后同一适配器实例的 meta.label 动态更新（每次访问重新解析）', () => {
        const entry = createNativeChannelPluginEntry(makeChannel(), deps);
        const adapter = entry.channelPlugin as unknown as NativeChannelAdapter;

        setRuntimeLocale('zh-CN');
        expect(adapter.meta.label).toBe('示例');
        setRuntimeLocale('en-US');
        expect(adapter.meta.label).toBe('Demo');
    });

    test('字符串 label 原样返回；无匹配语言的映射回退第一个条目', () => {
        const stringLabel = {
            meta: { id: 'demo', label: 'Plain' },
            capabilities: { chatTypes: ['direct'] }
        } as unknown as Channel;
        const partialMap = {
            meta: { id: 'demo', label: { fr: 'Démo' } },
            capabilities: { chatTypes: ['direct'] }
        } as unknown as Channel;

        setRuntimeLocale('zh-CN');
        expect(createNativeChannelPluginEntry(stringLabel, deps).channelPlugin.meta.label).toBe('Plain');
        expect(createNativeChannelPluginEntry(partialMap, deps).channelPlugin.meta.label).toBe('Démo');
    });

    test('无法解析时回退渠道 id', () => {
        const emptyMap = {
            meta: { id: 'demo', label: {} },
            capabilities: { chatTypes: ['direct'] }
        } as unknown as Channel;
        expect(createNativeChannelPluginEntry(emptyMap, deps).channelPlugin.meta.label).toBe('demo');
    });
});

describe('参数登录 displayName 按界面语言解析', () => {
    function makeParamsChannel(): { channel: Channel; captured: { ctx?: ChannelRuntimeContext } } {
        const captured: { ctx?: ChannelRuntimeContext } = {};
        const channel = {
            meta: { id: 'demo', label: 'Demo' },
            capabilities: { chatTypes: ['direct'] },
            getAccountLoginParams: () => [
                { name: 'appId', displayName: { en: 'App ID', zh: '应用 ID' }, required: true },
                { name: 'secret', displayName: 'Secret', required: true, type: 'password' },
                { name: 'weird', displayName: {}, required: false }
            ],
            setChannelRuntimeContext: (ctx: ChannelRuntimeContext) => {
                captured.ctx = ctx;
            }
        } as unknown as Channel;
        return { channel, captured };
    }

    test('映射按当前语言解析为字符串，字符串原样，空映射回退字段名', () => {
        const { channel } = makeParamsChannel();
        const entry = createNativeChannelPluginEntry(channel, deps);
        const adapter = entry.channelPlugin as unknown as NativeChannelAdapter;

        setRuntimeLocale('zh-CN');
        let params = adapter.getLoginParams();
        expect(params[0].displayName).toBe('应用 ID');
        expect(params[1].displayName).toBe('Secret');
        expect(params[2].displayName).toBe('weird');

        setRuntimeLocale('en-US');
        params = adapter.getLoginParams();
        expect(params[0].displayName).toBe('App ID');
        expect(params[1].displayName).toBe('Secret');
        expect(params[2].displayName).toBe('weird');
    });

    test('runtime ctx.locale 动态返回当前界面语言', () => {
        const { channel, captured } = makeParamsChannel();
        const entry = createNativeChannelPluginEntry(channel, deps);
        const adapter = entry.channelPlugin as unknown as NativeChannelAdapter;

        adapter.ensureRuntimeInjected('default');
        expect(captured.ctx).toBeDefined();
        setRuntimeLocale('zh-CN');
        expect(captured.ctx!.locale).toBe('zh-CN');
        setRuntimeLocale('en-US');
        expect(captured.ctx!.locale).toBe('en-US');
    });
});
