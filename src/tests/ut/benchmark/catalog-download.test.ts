import { jest } from '@jest/globals';

/**
 * 测评集下载中心：
 * - 版本比较与「未安装 / 可更新 / 已是最新」判定是纯函数；
 * - 下载走本地 http 服务，验证进度、安装、同名覆盖更新与失败清理。
 */

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: { getInstance: () => ({ taskManagerState: { createTask: jest.fn(), initHarness: jest.fn() } }) }
}));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => ({ supportedModes: () => [{ id: 'unlimited' }] }) }
}));
jest.unstable_mockModule('../../../main/aikernel/planning/harness.js', () => ({
    extractAttemptCompletionResult: () => ({ success: true, result: '{}' })
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}));
jest.unstable_mockModule('../../../main/applications/benchmark/script-runtime.js', () => ({
    runScript: async () => ({ ok: true, code: 0, error: '', logError: '' }),
    ScriptExecutionError: class extends Error {
        readonly logError = '';
    }
}));

const { BenchmarkManager } = await import('../../../main/applications/benchmark/manager.js');
const { compareVersions, resolveCatalogInstallState, findLocalDatasetByName } =
    await import('../../../main/applications/benchmark/catalog-common.js');
const { listCatalogDatasets, findCatalogDataset } = await import('../../../main/applications/benchmark/catalog.js');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { setRuntimeLocale } from '../../../locale/index.js';
import type { CatalogDatasetEntry, DatasetSummary } from '../../../main/applications/benchmark/common.js';

beforeEach(() => {
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
});

// ── 纯函数 ───────────────────────────────────────────────────────────────

function makeSummary(patch: Partial<DatasetSummary>): DatasetSummary {
    return {
        id: 'local-1',
        name: 'WorkBuddy Bench',
        description: '',
        homepage: '',
        version: '1.0',
        importedAt: 0,
        caseCount: 2,
        tracks: [],
        ...patch
    };
}

describe('compareVersions', () => {
    test('按数字段比较，缺失段视为 0', () => {
        expect(compareVersions('1.0', '1.1')).toBe(-1);
        expect(compareVersions('1.1', '1.0')).toBe(1);
        expect(compareVersions('1.10', '1.9')).toBe(1);
        expect(compareVersions('1.0.1', '1.0')).toBe(1);
        expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
        expect(compareVersions('', '1.0')).toBe(-1);
        expect(compareVersions('2.0', '2.0')).toBe(0);
    });
});

describe('resolveCatalogInstallState', () => {
    const entry = { name: 'WorkBuddy Bench', version: '1.1' };

    test('本地没有同名测评集时是未安装', () => {
        expect(resolveCatalogInstallState(entry, [])).toBe('not-installed');
        expect(resolveCatalogInstallState(entry, [makeSummary({ name: 'Other' })])).toBe('not-installed');
    });

    test('本地版本更低时可更新', () => {
        expect(resolveCatalogInstallState(entry, [makeSummary({ version: '1.0' })])).toBe('update-available');
    });

    test('本地版本不低于清单版本时已是最新', () => {
        expect(resolveCatalogInstallState(entry, [makeSummary({ version: '1.1' })])).toBe('installed');
        expect(resolveCatalogInstallState(entry, [makeSummary({ version: '2.0' })])).toBe('installed');
    });

    test('按名称匹配时忽略大小写与首尾空白', () => {
        const local = makeSummary({ name: '  workbuddy bench ' });
        expect(findLocalDatasetByName([local], 'WorkBuddy Bench')).toBe(local);
        expect(resolveCatalogInstallState(entry, [local])).toBe('update-available');
    });
});

// ── 下载清单 ─────────────────────────────────────────────────────────────

describe('catalog', () => {
    test('默认清单包含 workbuddy bench 且带下载地址', () => {
        const entries = listCatalogDatasets();
        const entry = entries.find((item) => item.id === 'workbuddy-bench');
        expect(entry).toBeDefined();
        expect(entry!.name).toBe('WorkBuddy Bench');
        expect(entry!.version).toMatch(/^v?\d+(\.\d+)*$/);
        expect(entry!.tracks.map((track) => track.id)).toEqual(['office', 'code']);
        expect(entry!.downloadUrl).toMatch(/^https?:\/\//);
        expect(findCatalogDataset('workbuddy-bench')).not.toBeNull();
        expect(findCatalogDataset('not-exist')).toBeNull();
    });
});

// ── 下载与安装 ───────────────────────────────────────────────────────────

function writeDataset(rootDir: string, options: { name: string; version: string; cases?: number }): void {
    const trackId = 'track-a';
    const caseCount = options.cases ?? 2;
    fs.mkdirSync(path.join(rootDir, 'tracks', trackId), { recursive: true });
    fs.writeFileSync(
        path.join(rootDir, 'dataset.json'),
        JSON.stringify({
            name: options.name,
            description: 'fixture',
            homepage: 'https://example.com',
            version: options.version,
            tracks: [{ id: trackId, name: trackId }]
        })
    );
    fs.writeFileSync(path.join(rootDir, 'tracks', trackId, 'track.json'), '{}');
    for (let index = 1; index <= caseCount; index += 1) {
        const caseDir = path.join(rootDir, 'tracks', trackId, `case-${index}`);
        fs.mkdirSync(caseDir, { recursive: true });
        fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ name: `case-${index}` }));
        fs.writeFileSync(path.join(caseDir, 'run.md'), 'run instruction');
        fs.writeFileSync(path.join(caseDir, 'verify.md'), 'verify instruction');
    }
}

function zipDir(sourceDir: string, rootName: string): Buffer {
    const zip = new AdmZip();
    zip.addLocalFolder(sourceDir, rootName);
    return zip.toBuffer();
}

interface StaticServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(routes: Record<string, Buffer | null>): Promise<StaticServer> {
    const server = http.createServer((request, response) => {
        const body = routes[request.url ?? ''];
        if (!body) {
            response.writeHead(404, { 'content-type': 'text/plain' });
            response.end('not found');
            return;
        }
        response.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/zip' });
        response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

function makeEntry(baseUrl: string, options: { version: string; fileName?: string }): CatalogDatasetEntry {
    return {
        id: 'workbuddy-bench',
        name: 'WorkBuddy Bench',
        description: 'fixture dataset',
        homepage: 'https://example.com',
        version: options.version,
        downloadUrl: `${baseUrl}/${options.fileName ?? 'workbuddy-bench.zip'}`,
        tracks: [{ id: 'track-a', name: 'track-a' }]
    };
}

function makeManager(): { manager: InstanceType<typeof BenchmarkManager>; dataDir: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-download-'));
    const manager = new BenchmarkManager(dataDir);
    manager.init();
    return { manager, dataDir };
}

function tmpFiles(dataDir: string): string[] {
    return fs.readdirSync(path.join(dataDir, 'tmp'));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('BenchmarkManager 测评集下载', () => {
    test('下载 zip 后自动安装，并实时上报进度', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'workbuddy-bench'), { name: 'WorkBuddy Bench', version: '1.0' });
        const archive = zipDir(fixtureDir, 'workbuddy-bench');
        const server = await startServer({ '/workbuddy-bench.zip': archive });

        const { manager, dataDir } = makeManager();
        const snapshots: Array<{ status: string; received: number; total: number | null }> = [];
        let datasetChangeCount = 0;
        manager.onChange(() => {
            datasetChangeCount += 1;
        });
        // 下载进度走独立一路：混进 onChange 会让渲染层整页重建（打散卡片 hover）
        manager.onDownloadChange(() => {
            for (const state of manager.listDownloads()) {
                snapshots.push({ status: state.status, received: state.receivedBytes, total: state.totalBytes });
            }
        });
        const datasetChangesBeforeDownload = datasetChangeCount;

        try {
            const summary = await manager.downloadDataset(makeEntry(server.baseUrl, { version: '1.0' }));
            expect(summary.name).toBe('WorkBuddy Bench');
            expect(summary.version).toBe('1.0');
            expect(summary.caseCount).toBe(2);

            const datasets = manager.listDatasets();
            expect(datasets).toHaveLength(1);
            expect(datasets[0].id).toBe(summary.id);
            expect(fs.existsSync(path.join(dataDir, 'datasets', summary.id, 'dataset.json'))).toBe(true);

            // 进度：下载 → 安装 → 完成，每个阶段都对外发过通知
            const states = manager.listDownloads();
            expect(states).toHaveLength(1);
            expect(states[0]).toMatchObject({
                catalogId: 'workbuddy-bench',
                status: 'done',
                totalBytes: archive.length
            });
            expect(states[0].receivedBytes).toBe(archive.length);
            expect(snapshots.some((item) => item.status === 'installing')).toBe(true);
            expect(snapshots.some((item) => item.status === 'done')).toBe(true);
            // 装完之后才通知「测评集变了」，进度本身不算
            expect(datasetChangeCount).toBe(datasetChangesBeforeDownload + 1);

            // 下载用的临时压缩包不残留
            expect(tmpFiles(dataDir).filter((name) => name.startsWith('download-'))).toEqual([]);
        } finally {
            await server.close();
        }
    });

    test('下载过程中按已接收字节上报进度', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'workbuddy-bench'), { name: 'WorkBuddy Bench', version: '1.0' });
        const archive = zipDir(fixtureDir, 'workbuddy-bench');
        const half = Math.floor(archive.length / 2);

        // 用可控的流模拟慢速下载：推完前半段后停下来检查主进程里的进度状态
        let push: ((chunk: Uint8Array | null) => void) | null = null;
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        push = (chunk) => {
                            if (chunk) controller.enqueue(chunk);
                            else controller.close();
                        };
                        controller.enqueue(new Uint8Array(archive.subarray(0, half)));
                    }
                }),
                { status: 200, headers: { 'content-length': String(archive.length) } }
            )) as unknown as typeof fetch;

        const { manager } = makeManager();
        const pending = manager.downloadDataset(makeEntry('http://127.0.0.1/mock.zip', { version: '1.0' }), {
            fetchImpl
        });

        await waitFor(() => manager.listDownloads()[0]?.receivedBytes === half);
        expect(manager.listDownloads()[0]).toMatchObject({
            status: 'downloading',
            receivedBytes: half,
            totalBytes: archive.length,
            error: ''
        });

        push!(new Uint8Array(archive.subarray(half)));
        push!(null);
        const summary = await pending;
        expect(summary.caseCount).toBe(2);
        expect(manager.listDatasets()).toHaveLength(1);
        expect(manager.listDownloads()[0]).toMatchObject({
            status: 'done',
            receivedBytes: archive.length,
            totalBytes: archive.length
        });
    });

    test('已安装同名测评集时按更新覆盖，沿用原 datasetId', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'v1'), { name: 'WorkBuddy Bench', version: '1.0' });
        writeDataset(path.join(fixtureDir, 'v2'), { name: 'WorkBuddy Bench', version: '1.1', cases: 3 });
        const server = await startServer({
            '/workbuddy-bench-1.0.zip': zipDir(path.join(fixtureDir, 'v1'), 'workbuddy-bench'),
            '/workbuddy-bench-1.1.zip': zipDir(path.join(fixtureDir, 'v2'), 'workbuddy-bench')
        });
        const { manager } = makeManager();

        try {
            const first = await manager.downloadDataset(
                makeEntry(server.baseUrl, { version: '1.0', fileName: 'workbuddy-bench-1.0.zip' })
            );
            expect(manager.listDatasets()[0]).toMatchObject({ id: first.id, version: '1.0' });

            // 清单版本更高 → 界面会给「更新」
            const listBefore = manager.listDatasets();
            expect(resolveCatalogInstallState({ name: 'WorkBuddy Bench', version: '1.1' }, listBefore)).toBe(
                'update-available'
            );

            const updated = await manager.downloadDataset(
                makeEntry(server.baseUrl, { version: '1.1', fileName: 'workbuddy-bench-1.1.zip' })
            );
            expect(updated.id).toBe(first.id);
            expect(updated.version).toBe('1.1');
            expect(updated.caseCount).toBe(3);
            const datasets = manager.listDatasets();
            expect(datasets).toHaveLength(1);
            expect(datasets[0]).toMatchObject({ id: first.id, version: '1.1', caseCount: 3 });
        } finally {
            await server.close();
        }
    });

    test('下载失败时记录失败状态且不安装', async () => {
        const server = await startServer({});
        const { manager, dataDir } = makeManager();

        try {
            await expect(manager.downloadDataset(makeEntry(server.baseUrl, { version: '1.0' }))).rejects.toThrow();
            expect(manager.listDatasets()).toEqual([]);
            const state = manager.listDownloads()[0];
            expect(state.status).toBe('failed');
            expect(state.error).toContain('404');
            expect(tmpFiles(dataDir).filter((name) => name.startsWith('download-'))).toEqual([]);
        } finally {
            await server.close();
        }
    });

    test('压缩包内的测评集与清单名称不一致时拒绝安装', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'other'), { name: 'Somebody Else Bench', version: '1.0' });
        const server = await startServer({ '/workbuddy-bench.zip': zipDir(fixtureDir, 'other') });
        const { manager } = makeManager();

        try {
            await expect(manager.downloadDataset(makeEntry(server.baseUrl, { version: '1.0' }))).rejects.toThrow(
                'WorkBuddy Bench'
            );
            expect(manager.listDatasets()).toEqual([]);
        } finally {
            await server.close();
        }
    });

    test('更新失败时不破坏本地已安装的测评集', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'v1'), { name: 'WorkBuddy Bench', version: '1.0' });
        writeDataset(path.join(fixtureDir, 'broken'), { name: 'WorkBuddy Bench', version: '1.1', cases: 0 });
        const server = await startServer({
            '/workbuddy-bench-1.0.zip': zipDir(path.join(fixtureDir, 'v1'), 'workbuddy-bench'),
            '/workbuddy-bench-1.1.zip': zipDir(path.join(fixtureDir, 'broken'), 'workbuddy-bench')
        });
        const { manager, dataDir } = makeManager();

        try {
            const first = await manager.downloadDataset(
                makeEntry(server.baseUrl, { version: '1.0', fileName: 'workbuddy-bench-1.0.zip' })
            );
            // 新包一个用例都没有 → 安装失败，旧版本必须原地还在
            await expect(
                manager.downloadDataset(
                    makeEntry(server.baseUrl, { version: '1.1', fileName: 'workbuddy-bench-1.1.zip' })
                )
            ).rejects.toThrow();

            const datasets = manager.listDatasets();
            expect(datasets).toHaveLength(1);
            expect(datasets[0]).toMatchObject({ id: first.id, version: '1.0', caseCount: 2 });
            expect(fs.existsSync(path.join(dataDir, 'datasets', first.id, 'dataset.json'))).toBe(true);
        } finally {
            await server.close();
        }
    });

    test('更新时新目录换位失败会回滚，旧测评集不会丢', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-src-'));
        writeDataset(path.join(fixtureDir, 'v1'), { name: 'WorkBuddy Bench', version: '1.0' });
        writeDataset(path.join(fixtureDir, 'v2'), { name: 'WorkBuddy Bench', version: '1.1', cases: 3 });
        const server = await startServer({
            '/workbuddy-bench-1.0.zip': zipDir(path.join(fixtureDir, 'v1'), 'workbuddy-bench'),
            '/workbuddy-bench-1.1.zip': zipDir(path.join(fixtureDir, 'v2'), 'workbuddy-bench')
        });
        const { manager, dataDir } = makeManager();

        try {
            const first = await manager.downloadDataset(
                makeEntry(server.baseUrl, { version: '1.0', fileName: 'workbuddy-bench-1.0.zip' })
            );
            // Windows 上杀毒/索引进程短暂占用目标目录时 rename 会失败，模拟这一步
            const realRenameSync = fs.renameSync;
            let armed = true;
            (fs as any).renameSync = (from: string, to: string) => {
                if (armed && path.dirname(to) === path.join(dataDir, 'datasets')) {
                    armed = false;
                    throw new Error('EPERM: 目标被占用');
                }
                return realRenameSync(from, to);
            };
            try {
                await expect(
                    manager.downloadDataset(
                        makeEntry(server.baseUrl, { version: '1.1', fileName: 'workbuddy-bench-1.1.zip' })
                    )
                ).rejects.toThrow();
            } finally {
                (fs as any).renameSync = realRenameSync;
            }

            const datasets = manager.listDatasets();
            expect(datasets).toHaveLength(1);
            expect(datasets[0]).toMatchObject({ id: first.id, version: '1.0', caseCount: 2 });
            expect(fs.existsSync(path.join(dataDir, 'datasets', first.id, 'dataset.json'))).toBe(true);
            // 回滚用的备份目录不能留在 tmp 里
            expect(tmpFiles(dataDir).filter((name) => name.startsWith('replace-'))).toEqual([]);
        } finally {
            await server.close();
        }
    });

    test('传输停滞时按超时失败，不把下载状态永久卡在 downloading', async () => {
        // 推完一个 chunk 后既不 close 也不 error，模拟连接假死
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                    }
                }),
                { status: 200 }
            )) as unknown as typeof fetch;

        const { manager, dataDir } = makeManager();
        await expect(
            manager.downloadDataset(makeEntry('http://127.0.0.1/mock.zip', { version: '1.0' }), {
                fetchImpl,
                stallTimeoutMs: 80
            })
        ).rejects.toThrow('下载连接长时间没有响应');

        expect(manager.listDatasets()).toEqual([]);
        const state = manager.listDownloads()[0];
        expect(state.status).toBe('failed');
        // 失败后能重试：状态没有停在 downloading
        expect(state.receivedBytes).toBe(3);
        expect(tmpFiles(dataDir).filter((name) => name.startsWith('download-'))).toEqual([]);
    });

    test('连响应头都拿不到时也会超时失败', async () => {
        // 连接建起来但服务端一直不回响应头，fetch 永远不 settle
        const fetchImpl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
        const { manager } = makeManager();

        await expect(
            manager.downloadDataset(makeEntry('http://127.0.0.1/mock.zip', { version: '1.0' }), {
                fetchImpl,
                stallTimeoutMs: 60
            })
        ).rejects.toThrow('下载连接长时间没有响应');
        expect(manager.listDownloads()[0].status).toBe('failed');
    });
});
