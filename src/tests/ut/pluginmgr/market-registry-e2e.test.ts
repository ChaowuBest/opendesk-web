/**
 * 插件市场的端到端验证：本地起一个伪造的插件 registry（http://127.0.0.1:<port>/category/plugins.json），
 * 用真实的 registry 实现去拉清单、按分类过滤，再从它提供的下载地址把插件装进临时配置目录。
 *
 * 覆盖到的真实链路：
 * - PlainPluginRegistry 走 HTTP 拉清单（list 里声明的 categories / plugins）；
 * - getCatalog(categories) 的分类过滤；
 * - 渠道联网校验（fetchChannelCatalog）对 http 渠道放行 http 下载地址；
 * - installPlugin 流式下载 + 解包 + 校验 + 落盘，并回调下载进度。
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import AdmZip from 'adm-zip';

import { createPluginRegistries, PlainPluginRegistry } from '../../../main/applications/pluginmgr/registry/index.js';
import { fetchChannelCatalog } from '../../../main/applications/pluginmgr/channels.js';
import { installPlugin } from '../../../main/applications/pluginmgr/management/manager.js';

const CATEGORIES = ['开发工具', '效率'];
const PLUGINS = [
    { id: 'dev-plugin', displayName: '开发插件', category: ['开发工具'] },
    { id: 'office-plugin', displayName: '办公插件', category: ['效率'] },
    { id: 'uncategorized-plugin', displayName: '未分类插件' }
];

function buildPluginArchive(pluginId: string): Buffer {
    const zip = new AdmZip();
    zip.addFile(
        'package.json',
        Buffer.from(JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module' }, null, 2))
    );
    zip.addFile(
        'opendesk.plugin.json',
        Buffer.from(
            JSON.stringify({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                category: ['开发工具']
            })
        )
    );
    zip.addFile('index.js', Buffer.from(`export default { id: '${pluginId}', setup: () => ({}) };\n`));
    return zip.toBuffer();
}

describe('plugin marketplace over a real http endpoint', () => {
    const archives = new Map(PLUGINS.map((plugin) => [plugin.id, buildPluginArchive(plugin.id)]));
    let server: http.Server;
    let baseUrl = '';
    let configDirectory = '';

    beforeAll(async () => {
        configDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-market-e2e-'));
        server = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (url.pathname === '/category/plugins.json') {
                const body = JSON.stringify({
                    categories: CATEGORIES,
                    plugins: PLUGINS.map((plugin) => ({
                        id: plugin.id,
                        displayName: { 'zh-CN': plugin.displayName, 'en-US': plugin.id },
                        description: `${plugin.displayName} 的说明`,
                        version: '1.0.0',
                        category: plugin.category,
                        downloadUrl: `${baseUrl}/plugins/${plugin.id}.zip`
                    }))
                });
                response.writeHead(200, {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body)
                });
                response.end(body);
                return;
            }
            const archive = /^\/plugins\/([a-zA-Z0-9._-]+)\.zip$/.exec(url.pathname);
            if (archive && archives.has(archive[1])) {
                const buffer = archives.get(archive[1]) as Buffer;
                response.writeHead(200, { 'content-type': 'application/zip', 'content-length': buffer.byteLength });
                response.end(buffer);
                return;
            }
            response.writeHead(404).end('not found');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(configDirectory, { recursive: true, force: true });
    });

    function catalogUrl(): string {
        return `${baseUrl}/category/plugins.json`;
    }

    function createLocalMarket() {
        const [registry] = createPluginRegistries({
            dataDirectory: configDirectory,
            channels: [
                { id: 'official', isEnabled: false },
                { id: 'local-market', name: '本地测试市场', url: catalogUrl(), isEnabled: true }
            ]
        });
        return registry as PlainPluginRegistry;
    }

    test('registry pulls the catalog from a real http endpoint and reports its categories', async () => {
        const registry = createLocalMarket();

        expect(registry.name).toBe('local-market');

        const entries = await registry.getCatalog();
        expect(entries.map((entry) => entry.id)).toEqual(['dev-plugin', 'office-plugin', 'uncategorized-plugin']);
        expect(registry.categories).toEqual(CATEGORIES);
        expect(await registry.getPluginCount()).toBe(3);

        const devOnly = await registry.getCatalog({ categories: ['开发工具'] });
        expect(devOnly.map((entry) => entry.id)).toEqual(['dev-plugin']);
        expect(await registry.getPluginCount({ categories: ['效率'] })).toBe(1);
        // 未分类的插件不会出现在任何具体分类里，但仍在「全部插件」中
        expect((await registry.getCatalog({ categories: [] })).map((entry) => entry.id)).toEqual([
            'dev-plugin',
            'office-plugin',
            'uncategorized-plugin'
        ]);
    });

    test('a http channel may host plugin archives over http as well', async () => {
        const entries = await fetchChannelCatalog(catalogUrl());
        expect(entries).toHaveLength(3);
        expect(entries.every((entry) => entry.downloadUrl.startsWith('http://127.0.0.1:'))).toBe(true);
    });

    test('installing a plugin from the marketplace streams the archive and reports progress', async () => {
        const registry = createLocalMarket();
        const entry = (await registry.getCatalog()).find((item) => item.id === 'office-plugin');
        expect(entry).toBeTruthy();

        const progress: Array<{ received: number; total: number | null }> = [];
        const result = await installPlugin(entry!.downloadUrl, {
            configDirectory,
            // 测试进程里没有 Electron / CLI 平台，直接给全局 fetch（与主进程注入的平台 fetch 同签名）
            fetch: (input) => fetch(input),
            onDownloadProgress: (received, total) => progress.push({ received, total })
        });

        expect(result).toEqual({ success: true, id: 'office-plugin' });
        const expectedSize = (archives.get('office-plugin') as Buffer).byteLength;
        expect(progress.at(0)).toEqual({ received: 0, total: expectedSize });
        expect(progress.at(-1)).toEqual({ received: expectedSize, total: expectedSize });

        const installed = path.join(configDirectory, 'plugins', 'office-plugin');
        expect((await stat(path.join(installed, 'index.js'))).isFile()).toBe(true);
        expect((await stat(path.join(installed, 'opendesk.plugin.json'))).isFile()).toBe(true);
    });

    test('a second install of the same plugin replaces the previous copy', async () => {
        const registry = createLocalMarket();
        const entry = (await registry.getCatalog()).find((item) => item.id === 'office-plugin');
        expect(entry).toBeTruthy();

        const result = await installPlugin(entry!.downloadUrl, {
            configDirectory,
            fetch: (input) => fetch(input)
        });
        expect(result.success).toBe(true);
        const installed = path.join(configDirectory, 'plugins', 'office-plugin');
        expect((await stat(path.join(installed, 'index.js'))).isFile()).toBe(true);
    });
});
