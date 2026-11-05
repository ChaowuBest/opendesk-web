import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    assertChannelNameAvailable,
    assertChannelUrlAvailable,
    BENCHMARK_CATALOG_URL,
    fetchChannelCatalog,
    MAX_BENCHMARK_CHANNELS,
    normalizeBenchmarkChannels,
    normalizeChannelName,
    normalizeChannelUrl,
    OFFICIAL_CHANNEL_ID
} from '../../../main/applications/benchmark/channels.js';
import { createBenchmarkRegistries } from '../../../main/applications/benchmark/registry/index.js';

function catalogEntry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'swe-bench',
        name: 'SWE Bench',
        version: '1.0.0',
        tracks: ['core'],
        downloadUrl: 'https://example.com/swe-bench.zip',
        ...overrides
    };
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
    const status = init.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    } as unknown as Response;
}

function tempDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-benchmark-channels-'));
}

describe('normalizeBenchmarkChannels', () => {
    test('always puts the built-in channel first and enabled by default', () => {
        const channels = normalizeBenchmarkChannels(undefined);

        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({
            id: OFFICIAL_CHANNEL_ID,
            name: '',
            url: BENCHMARK_CATALOG_URL,
            isEnabled: true
        });
    });

    test('keeps custom channels after the built-in one, in configured order', () => {
        const channels = normalizeBenchmarkChannels([
            { id: 'a', name: 'Alpha', url: 'https://alpha.example.com/benchmarks.json', isEnabled: true },
            { id: 'b', name: 'Beta', url: 'https://beta.example.com/benchmarks.json', isEnabled: false }
        ]);

        expect(channels.map((channel) => channel.id)).toEqual([OFFICIAL_CHANNEL_ID, 'a', 'b']);
        expect(channels[2].isEnabled).toBe(false);
    });

    test('honours the built-in channel enabled flag while forcing the official url', () => {
        const channels = normalizeBenchmarkChannels([
            { id: OFFICIAL_CHANNEL_ID, name: 'whatever', url: 'https://mirror.example.com/x.json', isEnabled: false }
        ]);

        expect(channels[0].url).toBe(BENCHMARK_CATALOG_URL);
        expect(channels[0].isEnabled).toBe(false);
    });

    test('drops entries without id or url and de-duplicates ids', () => {
        const channels = normalizeBenchmarkChannels([
            { name: 'no id', url: 'https://a.example.com/x.json' },
            { id: 'a', name: 'No url', url: '   ' },
            { id: 'dup', name: 'first', url: 'https://a.example.com/1.json' },
            { id: 'dup', name: 'second', url: 'https://a.example.com/2.json' },
            'not-an-object',
            null
        ]);

        expect(channels.map((channel) => channel.id)).toEqual([OFFICIAL_CHANNEL_ID, 'dup']);
        expect(channels[1].name).toBe('first');
    });

    test('keeps the first built-in entry when it appears twice', () => {
        const channels = normalizeBenchmarkChannels([
            { id: OFFICIAL_CHANNEL_ID, isEnabled: false },
            { id: OFFICIAL_CHANNEL_ID, isEnabled: true }
        ]);

        expect(channels).toHaveLength(1);
        expect(channels[0].isEnabled).toBe(false);
    });

    test('falls back to the url when a custom channel has no name', () => {
        const channels = normalizeBenchmarkChannels([
            { id: 'a', url: 'https://a.example.com/x.json', isEnabled: true }
        ]);

        expect(channels[1].name).toBe('https://a.example.com/x.json');
    });
});

describe('channel field validation', () => {
    test('rejects empty and oversized names', () => {
        expect(() => normalizeChannelName('   ')).toThrow();
        expect(() => normalizeChannelName('x'.repeat(81))).toThrow();
        expect(normalizeChannelName('  Alpha  ')).toBe('Alpha');
    });

    test('accepts http(s) urls and rejects everything else', () => {
        expect(normalizeChannelUrl('https://example.com/benchmarks.json')).toBe('https://example.com/benchmarks.json');
        expect(normalizeChannelUrl('http://example.com/benchmarks.json')).toBe('http://example.com/benchmarks.json');
        expect(() => normalizeChannelUrl('file:///etc/passwd')).toThrow();
        expect(() => normalizeChannelUrl('javascript:alert(1)')).toThrow();
        expect(() => normalizeChannelUrl('not a url')).toThrow();
        expect(() => normalizeChannelUrl('')).toThrow();
    });

    test('rejects duplicate names (case-insensitive) but allows keeping its own name', () => {
        const channels = normalizeBenchmarkChannels([
            { id: 'a', name: 'Alpha', url: 'https://a.example.com/x.json', isEnabled: true }
        ]);

        expect(() => assertChannelNameAvailable(channels, 'alpha', '官方测评集')).toThrow();
        expect(() => assertChannelNameAvailable(channels, '官方测评集', '官方测评集')).toThrow();
        expect(() => assertChannelNameAvailable(channels, 'Alpha', '官方测评集', 'a')).not.toThrow();
        expect(() => assertChannelNameAvailable(channels, 'Beta', '官方测评集')).not.toThrow();
    });

    test('rejects duplicate addresses but allows keeping its own address', () => {
        const channels = normalizeBenchmarkChannels([
            { id: 'a', name: 'Alpha', url: 'https://a.example.com/x.json', isEnabled: true }
        ]);

        expect(() => assertChannelUrlAvailable(channels, 'https://a.example.com/x.json')).toThrow();
        expect(() => assertChannelUrlAvailable(channels, 'https://a.example.com/x.json', 'a')).not.toThrow();
        expect(() => assertChannelUrlAvailable(channels, BENCHMARK_CATALOG_URL)).toThrow();
    });
});

describe('fetchChannelCatalog', () => {
    test('returns parsed entries for a valid catalog', async () => {
        const entries = await fetchChannelCatalog('https://example.com/benchmarks.json', {
            fetchImpl: (async () => jsonResponse([catalogEntry()])) as unknown as typeof fetch
        });

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('swe-bench');
    });

    test('rejects a non-http(s) document', async () => {
        await expect(
            fetchChannelCatalog('https://example.com/benchmarks.json', {
                fetchImpl: (async () => jsonResponse('<html></html>')) as unknown as typeof fetch
            })
        ).rejects.toThrow();
    });

    test('rejects an empty catalog, which is almost always a wrong address', async () => {
        await expect(
            fetchChannelCatalog('https://example.com/benchmarks.json', {
                fetchImpl: (async () => jsonResponse([])) as unknown as typeof fetch
            })
        ).rejects.toThrow();
    });

    test('rejects a broken entry (strict validation while verifying)', async () => {
        await expect(
            fetchChannelCatalog('https://example.com/benchmarks.json', {
                fetchImpl: (async () => jsonResponse([catalogEntry(), { id: 'broken' }])) as unknown as typeof fetch
            })
        ).rejects.toThrow();
    });

    test('rejects an http error response', async () => {
        await expect(
            fetchChannelCatalog('https://example.com/benchmarks.json', {
                fetchImpl: (async () => jsonResponse('nope', { status: 404 })) as unknown as typeof fetch
            })
        ).rejects.toThrow();
    });

    test('resolves relative downloadUrls against the channel url', async () => {
        const entries = await fetchChannelCatalog('https://example.com/categories/benchmarks.json', {
            fetchImpl: (async () =>
                jsonResponse([catalogEntry({ downloadUrl: 'zips/swe-bench.zip' })])) as unknown as typeof fetch
        });

        expect(entries[0].downloadUrl).toBe('https://example.com/categories/zips/swe-bench.zip');
    });
});

describe('createBenchmarkRegistries with configured channels', () => {
    test('only enabled channels become registries, built-in first', () => {
        const dataDirectory = tempDataDir();
        const registries = createBenchmarkRegistries({
            dataDirectory,
            channels: [
                { id: 'alpha', name: 'Alpha', url: 'https://alpha.example.com/benchmarks.json', isEnabled: true },
                { id: 'beta', name: 'Beta', url: 'https://beta.example.com/benchmarks.json', isEnabled: false }
            ]
        });

        expect(registries.map((registry) => registry.name)).toEqual([OFFICIAL_CHANNEL_ID, 'alpha']);
        expect((registries[1] as unknown as { catalogUrl: string }).catalogUrl).toBe(
            'https://alpha.example.com/benchmarks.json'
        );
        fs.rmSync(dataDirectory, { recursive: true, force: true });
    });

    test('disabling the built-in channel removes it from the registry list', () => {
        const dataDirectory = tempDataDir();
        const registries = createBenchmarkRegistries({
            dataDirectory,
            channels: [{ id: OFFICIAL_CHANNEL_ID, name: '', url: '', isEnabled: false }]
        });

        expect(registries).toHaveLength(0);
        fs.rmSync(dataDirectory, { recursive: true, force: true });
    });

    test('cache file name follows the channel address so an edit cannot reuse a stale catalog', () => {
        const dataDirectory = tempDataDir();
        const first = createBenchmarkRegistries({
            dataDirectory,
            channels: [{ id: 'alpha', name: 'Alpha', url: 'https://alpha.example.com/1.json', isEnabled: true }]
        });
        const second = createBenchmarkRegistries({
            dataDirectory,
            channels: [{ id: 'alpha', name: 'Alpha', url: 'https://alpha.example.com/2.json', isEnabled: true }]
        });

        const firstCache = (first[1] as unknown as { cacheFile: string }).cacheFile;
        const secondCache = (second[1] as unknown as { cacheFile: string }).cacheFile;
        expect(firstCache).toBeTruthy();
        expect(firstCache).not.toBe(secondCache);
        fs.rmSync(dataDirectory, { recursive: true, force: true });
    });

    test('channel count limit is a sane positive number', () => {
        expect(MAX_BENCHMARK_CHANNELS).toBeGreaterThan(1);
    });
});
