import { describe, expect, jest, test } from '@jest/globals';
import {
    assertChannelNameAvailable,
    assertChannelUrlAvailable,
    fetchChannelCatalog,
    MAX_PLUGIN_CHANNELS,
    normalizeChannelName,
    normalizeChannelUrl,
    normalizePluginChannels,
    OFFICIAL_PLUGIN_CHANNEL_ID,
    PLUGIN_CATALOG_URL
} from '../../../main/applications/pluginmgr/channels.js';

/**
 * 插件渠道（插件市场来源）的归一化与校验。
 *
 * 关键约定：
 * - 官方渠道永远排第一，地址取自常量，用户只能启停；
 * - 自定义渠道缺 id / 缺地址的直接丢弃，id 重复保留先出现的；
 * - 新增/编辑渠道时严格解析清单（任何一条写坏都要报错），避免存下不可用的渠道。
 */

function entry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'hello-plugin',
        version: '1.0.0',
        downloadUrl: 'https://example.com/hello-plugin-1.0.0.zip',
        ...overrides
    };
}

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    } as unknown as Response;
}

describe('normalizePluginChannels', () => {
    test('always puts the official channel first and enabled by default', () => {
        const channels = normalizePluginChannels(undefined);

        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({
            id: OFFICIAL_PLUGIN_CHANNEL_ID,
            name: '',
            url: PLUGIN_CATALOG_URL,
            isEnabled: true
        });
    });

    test('keeps custom channels after the official one, in configured order', () => {
        const channels = normalizePluginChannels([
            { id: 'a', name: 'Alpha', url: 'https://alpha.example.com/plugins.json', isEnabled: true },
            { id: 'b', name: 'Beta', url: 'https://beta.example.com/plugins.json', isEnabled: false }
        ]);

        expect(channels.map((channel) => channel.id)).toEqual([OFFICIAL_PLUGIN_CHANNEL_ID, 'a', 'b']);
        expect(channels[2].isEnabled).toBe(false);
    });

    test('drops channels without id or url and dedupes ids', () => {
        const channels = normalizePluginChannels([
            { id: 'a', name: 'Alpha', url: 'https://alpha.example.com/plugins.json' },
            { id: 'a', name: 'Alpha again', url: 'https://alpha2.example.com/plugins.json' },
            { id: 'no-url', name: 'Broken' },
            { name: 'no-id', url: 'https://example.com/plugins.json' }
        ]);

        expect(channels.map((channel) => channel.id)).toEqual([OFFICIAL_PLUGIN_CHANNEL_ID, 'a']);
        expect(channels[1].name).toBe('Alpha');
    });

    test('honours a disabled official channel but keeps the constant url', () => {
        const channels = normalizePluginChannels([
            { id: OFFICIAL_PLUGIN_CHANNEL_ID, url: 'https://stale.example.com/plugins.json', isEnabled: false }
        ]);

        expect(channels[0]).toMatchObject({ isEnabled: false, url: PLUGIN_CATALOG_URL });
    });
});

describe('channel name / url validation', () => {
    test('normalizes a valid name and url', () => {
        expect(normalizeChannelName('  社区市场  ')).toBe('社区市场');
        expect(normalizeChannelUrl('https://example.com/category/plugins.json')).toBe(
            'https://example.com/category/plugins.json'
        );
    });

    test('rejects empty / overlong names and non-http urls', () => {
        expect(() => normalizeChannelName('   ')).toThrow(/请填写渠道名称/);
        expect(() => normalizeChannelName('x'.repeat(81))).toThrow(/80/);
        expect(() => normalizeChannelUrl('')).toThrow(/请填写插件清单地址/);
        expect(() => normalizeChannelUrl('file:///etc/passwd')).toThrow(/不合法/);
        expect(() => normalizeChannelUrl('not-a-url')).toThrow(/不合法/);
    });

    test('blocks duplicate names and urls, skipping the edited channel', () => {
        const channels = normalizePluginChannels([
            { id: 'a', name: 'Alpha', url: 'https://alpha.example.com/plugins.json' }
        ]);

        expect(() => assertChannelNameAvailable(channels, 'alpha', '官方插件市场')).toThrow(/已被使用/);
        expect(() => assertChannelNameAvailable(channels, '官方插件市场', '官方插件市场')).toThrow(/已被使用/);
        expect(() => assertChannelNameAvailable(channels, 'Alpha', '官方插件市场', 'a')).not.toThrow();

        expect(() => assertChannelUrlAvailable(channels, 'https://alpha.example.com/plugins.json')).toThrow(
            /已被其它渠道使用/
        );
        expect(() => assertChannelUrlAvailable(channels, 'https://alpha.example.com/plugins.json', 'a')).not.toThrow();
    });

    test('exposes the documented custom channel limit', () => {
        expect(MAX_PLUGIN_CHANNELS).toBeGreaterThan(0);
    });
});

describe('fetchChannelCatalog', () => {
    test('returns the parsed entries of a reachable catalog', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ plugins: [entry(), entry({ id: 'second' })] }));

        const entries = await fetchChannelCatalog('https://example.com/category/plugins.json', {
            fetchImpl: fetchImpl as unknown as typeof fetch
        });

        expect(entries.map((item) => item.id)).toEqual(['hello-plugin', 'second']);
    });

    test('rejects a catalog with a broken entry', async () => {
        const fetchImpl = jest.fn(async () =>
            jsonResponse({ plugins: [entry(), entry({ id: 'broken', downloadUrl: 'https://example.com/x.exe' })] })
        );

        await expect(
            fetchChannelCatalog('https://example.com/category/plugins.json', {
                fetchImpl: fetchImpl as unknown as typeof fetch
            })
        ).rejects.toThrow(/第 2 条插件不可用/);
    });

    test('rejects an empty catalog, an HTTP error and invalid JSON', async () => {
        const empty = jest.fn(async () => jsonResponse({ plugins: [] }));
        const failing = jest.fn(async () => jsonResponse({}, 500));
        const broken = jest.fn(async () => jsonResponse('{ not json'));

        await expect(
            fetchChannelCatalog('https://example.com/plugins.json', {
                fetchImpl: empty as unknown as typeof fetch
            })
        ).rejects.toThrow(/没有任何插件/);
        await expect(
            fetchChannelCatalog('https://example.com/plugins.json', {
                fetchImpl: failing as unknown as typeof fetch
            })
        ).rejects.toThrow(/插件清单验证失败/);
        await expect(
            fetchChannelCatalog('https://example.com/plugins.json', {
                fetchImpl: broken as unknown as typeof fetch
            })
        ).rejects.toThrow(/插件清单验证失败/);
    });

    test('allows http download urls only for non-https channels', async () => {
        const body = { plugins: [entry({ downloadUrl: 'http://127.0.0.1:8080/plugins/hello.zip' })] };
        const fetchImpl = jest.fn(async () => jsonResponse(body));

        await expect(
            fetchChannelCatalog('https://example.com/plugins.json', {
                fetchImpl: fetchImpl as unknown as typeof fetch
            })
        ).rejects.toThrow(/https/);

        await expect(
            fetchChannelCatalog('http://127.0.0.1:8080/category/plugins.json', {
                fetchImpl: fetchImpl as unknown as typeof fetch
            })
        ).resolves.toHaveLength(1);
    });
});
