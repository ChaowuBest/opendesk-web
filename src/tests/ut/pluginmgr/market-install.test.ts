import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * 从插件市场下载安装：远程归档包走流式下载，进度按块回调。
 *
 * 关键约定：
 * - 下载地址来自市场清单，安装前先落盘到暂存目录，中途失败不留半截包；
 * - 进度回调的 total 取自 content-length，末块必须把 received 推到 total；
 * - 装好后插件落在 `<configDirectory>/plugins/<id>`，并写入注册表记录。
 */

const { installPlugin } = await import('../../../main/applications/pluginmgr/management/manager.js');

const tempDirs: string[] = [];

beforeEach(() => {
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-install-'));
    tempDirs.push(dir);
    return dir;
}

/** 造一个最小可安装的插件归档包 */
function buildPluginArchive(pluginId: string): Buffer {
    const zip = new AdmZip();
    zip.addFile(
        'package.json',
        Buffer.from(JSON.stringify({ name: pluginId, version: '1.2.3', type: 'module' }, null, 2))
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
    zip.addFile(
        'index.js',
        Buffer.from('export default { id: "PLUGIN_ID", setup: () => ({}) };\n'.replace('PLUGIN_ID', pluginId))
    );
    return zip.toBuffer();
}

describe('installPlugin over http with download progress', () => {
    test('streams the archive, reports progress and installs the plugin', async () => {
        const configDirectory = tempDir();
        const archive = buildPluginArchive('market-demo');
        const progress: Array<{ received: number; total: number | null }> = [];
        const fetchMock = jest.fn(async () => {
            return new Response(archive, {
                status: 200,
                headers: { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) }
            });
        });

        const result = await installPlugin('https://example.com/market-demo-1.2.3.zip', {
            configDirectory,
            fetch: fetchMock as unknown as typeof fetch,
            runNpm: async () => undefined,
            onDownloadProgress: (received, total) => progress.push({ received, total })
        });

        expect(result).toEqual({ success: true, id: 'market-demo' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // 首块之前的 0 进度 + 至少一次到达总量的进度
        expect(progress[0]).toEqual({ received: 0, total: archive.byteLength });
        expect(progress.at(-1)).toEqual({ received: archive.byteLength, total: archive.byteLength });
        // 进度必须单调不减
        for (let index = 1; index < progress.length; index += 1) {
            expect(progress[index].received).toBeGreaterThanOrEqual(progress[index - 1].received);
        }

        const installed = path.join(configDirectory, 'plugins', 'market-demo');
        expect(fs.existsSync(path.join(installed, 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(installed, 'opendesk.plugin.json'))).toBe(true);
    });

    test('works when the server does not declare a content length', async () => {
        const configDirectory = tempDir();
        const archive = buildPluginArchive('no-length-demo');
        const progress: Array<{ received: number; total: number | null }> = [];

        const result = await installPlugin('https://example.com/no-length-demo.zip', {
            configDirectory,
            fetch: (async () =>
                new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } })) as never,
            runNpm: async () => undefined,
            onDownloadProgress: (received, total) => progress.push({ received, total })
        });

        expect(result.success).toBe(true);
        expect(progress.every((item) => item.total === null)).toBe(true);
        expect(progress.at(-1)?.received).toBe(archive.byteLength);
    });

    test('ignores content-length when the body is compressed', async () => {
        const configDirectory = tempDir();
        const archive = buildPluginArchive('compressed-demo');
        const progress: Array<{ received: number; total: number | null }> = [];

        const result = await installPlugin('https://example.com/compressed-demo.zip', {
            configDirectory,
            // CDN 给归档包加了 gzip 时，content-length 是压缩后的长度，与解压后的流对不上
            fetch: (async () =>
                new Response(archive, {
                    status: 200,
                    headers: {
                        'content-type': 'application/zip',
                        'content-encoding': 'gzip',
                        'content-length': String(Math.floor(archive.byteLength / 2))
                    }
                })) as never,
            runNpm: async () => undefined,
            onDownloadProgress: (received, total) => progress.push({ received, total })
        });

        expect(result.success).toBe(true);
        // 传的不是真实长度：宁可只报「已下载多少」，也不要让进度条冲到 100% 之后继续涨
        expect(progress.every((item) => item.total === null)).toBe(true);
        expect(progress.at(-1)?.received).toBe(archive.byteLength);
    });

    test('fails the install when the archive cannot be downloaded', async () => {
        const configDirectory = tempDir();
        const progress: Array<{ received: number; total: number | null }> = [];

        const result = await installPlugin('https://example.com/missing.zip', {
            configDirectory,
            fetch: (async () => new Response('not found', { status: 404 })) as never,
            runNpm: async () => undefined,
            onDownloadProgress: (received, total) => progress.push({ received, total })
        });

        expect(result.success).toBe(false);
        expect(result.errorCode).toBeDefined();
        // 404 在解包前就失败，没有进度可报
        expect(progress).toEqual([]);
        expect(fs.existsSync(path.join(configDirectory, 'plugins', 'missing'))).toBe(false);
    });
});
