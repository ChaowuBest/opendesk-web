import { beforeEach, describe, expect, test } from '@jest/globals';
import {
    createPluginRegistries,
    listPluginRegistryProviders,
    PlainPluginRegistry,
    registerPluginRegistryProvider,
    resetPluginRegistryProviders
} from '../../../main/applications/pluginmgr/registry/index.js';
import type { BasePluginRegistry } from '../../../main/applications/pluginmgr/registry/base.js';

/**
 * registry provider 注入点。
 *
 * 内置实现只认 HTTP 上的 plugins.json；未来换协议（分页 RPC、需要认证的私有市场）时，
 * 注册一个 provider 认领对应渠道即可，createPluginRegistries 与 app.ts 都不用动。
 * 这些用例守住三件事：默认行为不变、认领只作用于自己的渠道、provider 出错不放大成空市场。
 */

const OFFICIAL_CHANNEL = { id: 'official', name: '', url: 'https://official.example.com/plugins.json' };
const CUSTOM_CHANNEL = { id: 'channel-proto', name: '新协议市场', url: 'https://proto.example.com/index' };

function channels(): unknown {
    return [
        { ...OFFICIAL_CHANNEL, isEnabled: true },
        { ...CUSTOM_CHANNEL, isEnabled: true }
    ];
}

function createRegistries(): BasePluginRegistry[] {
    return createPluginRegistries({ dataDirectory: 'C:/tmp/pluginmgr-test', channels: channels() });
}

/** 一个只认 `proto.example.com` 的假 registry：用来证明注入点真的接管了渠道 */
function providedRegistry(name: string): BasePluginRegistry {
    return {
        name,
        displayName: '新协议市场',
        getCatalog: async () => [],
        getPluginCount: async () => 0
    };
}

beforeEach(() => {
    resetPluginRegistryProviders();
});

describe('plugin registry providers', () => {
    test('没有 provider 时全部走内置清单实现', () => {
        const registries = createRegistries();

        expect(registries.map((registry) => registry.name)).toEqual(['official', CUSTOM_CHANNEL.id]);
        expect(registries.every((registry) => registry instanceof PlainPluginRegistry)).toBe(true);
    });

    test('provider 只接管自己认领的渠道，其余仍走内置实现', () => {
        registerPluginRegistryProvider({
            id: 'proto',
            supports: (channel) => channel.url.includes('proto.example.com'),
            create: (channel) => providedRegistry(`proto:${channel.id}`)
        });

        const registries = createRegistries();

        expect(registries.map((registry) => registry.name)).toEqual(['official', `proto:${CUSTOM_CHANNEL.id}`]);
        expect(registries[0]).toBeInstanceOf(PlainPluginRegistry);
        expect(registries[1]).not.toBeInstanceOf(PlainPluginRegistry);
    });

    test('退订之后该渠道回到内置实现', () => {
        const unregister = registerPluginRegistryProvider({
            id: 'proto',
            supports: (channel) => channel.url.includes('proto.example.com'),
            create: (channel) => providedRegistry(`proto:${channel.id}`)
        });
        expect(createRegistries()[1]).not.toBeInstanceOf(PlainPluginRegistry);

        unregister();
        expect(listPluginRegistryProviders()).toEqual([]);
        expect(createRegistries()[1]).toBeInstanceOf(PlainPluginRegistry);
    });

    test('同 id 重复注册直接报错，避免两个 provider 抢同一个渠道', () => {
        registerPluginRegistryProvider({ id: 'proto', supports: () => false, create: () => undefined });

        expect(() =>
            registerPluginRegistryProvider({ id: 'proto', supports: () => false, create: () => undefined })
        ).toThrow(/already registered/);
    });

    test('provider 抛错时回落到内置实现，不把整个市场列表拖空', () => {
        registerPluginRegistryProvider({
            id: 'broken',
            supports: () => {
                throw new Error('boom');
            },
            create: () => {
                throw new Error('boom');
            }
        });
        registerPluginRegistryProvider({
            id: 'picker',
            supports: (channel) => channel.url.includes('proto.example.com'),
            create: () => {
                throw new Error('boom');
            }
        });

        const registries = createRegistries();

        expect(registries).toHaveLength(2);
        expect(registries.every((registry) => registry instanceof PlainPluginRegistry)).toBe(true);
    });
});
