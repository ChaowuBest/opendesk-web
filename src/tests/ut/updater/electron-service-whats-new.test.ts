import { afterAll, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// What's New 与更新流程解耦：whats-new 通道必须在 updater 关闭的平台（linux、
// 非打包运行）也注册。测试进程模拟该形态，验证全平台可用性。
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });
afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
});

const platformFetch = jest.fn<(input: string | URL) => Promise<Response>>();
// 给 ipcHandle 标注 handler 参数，便于从 mock.calls 取出注册的 IPC 处理函数并直接调用
type RegisteredIpcHandler = (...args: unknown[]) => unknown;
const ipcHandle = jest.fn<(channel: string, handler: RegisteredIpcHandler) => void>();

// 每个用例使用独立 userData 目录，避免 seen 历史互相污染
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-whats-new-service-'));

jest.unstable_mockModule('electron', () => ({
    app: {
        isPackaged: false,
        getVersion: () => '0.3.7',
        getPath: () => userDataDir
    },
    ipcMain: { handle: ipcHandle }
}));

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: {
        getInstance: () => ({
            taskManagerState: {
                tasks: [],
                getTask: () => undefined,
                flushAllPendingSaves: async () => undefined
            }
        })
    }
}));

jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: jest.fn()
}));

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => ({ fetch: platformFetch })
}));

const { registerElectronUpdateService } = await import('../../../main/updater/electron-service.js');

const newsListHtml = `<!doctype html><html><body><ol class="release-list">
    <li data-release-category="stable-release"><article class="release-item">
        <span class="release-item__title">OpenDesk 0.3.7 更新内容</span>
        <a href="/news/2026-11-20-stable-release/">查看详情</a>
    </article></li>
</ol></body></html>`;

const newsDetailHtml = `<!doctype html><html><body>
    <h1>OpenDesk 0.3.7 正式版本更新内容</h1>
    <p>本次发布带来以下改进。</p>
    <h2>新增特性</h2>
    <ul><li>支持自动更新</li></ul>
    <h2>如何升级</h2>
    <p>下载安装包覆盖安装。</p>
</body></html>`;

function registeredHandler(channel: string): RegisteredIpcHandler {
    const handler = ipcHandle.mock.calls.filter(([registered]) => registered === channel).at(-1)?.[1];
    if (typeof handler !== 'function') throw new Error(`missing IPC handler for ${channel}`);
    return handler;
}

function registerService(): void {
    const coordinator = registerElectronUpdateService({
        getMainWindow: () => null,
        prepareWindowsForQuit: async () => true,
        quitForRestart: () => undefined,
        logInfo: () => undefined,
        logError: (message) => {
            throw new Error(`unexpected error log: ${message}`);
        }
    });
    // updater 关闭的平台只注册 stub 与 whats-new 通道，不返回 coordinator
    expect(coordinator).toBeUndefined();
}

beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-whats-new-service-'));
    platformFetch.mockReset();
    ipcHandle.mockClear();
    process.env.OPENDESK_UPDATE_FEED_URL = 'https://updates.example.test/news/';
    delete process.env.OPENDESK_UPDATE_FORCE_ENABLE;
});

test('whats-new channels stay registered on platforms without updater support', () => {
    registerService();
    expect(() => registeredHandler('updater:getPendingReleaseNotes')).not.toThrow();
    expect(() => registeredHandler('updater:dismissReleaseNotes')).not.toThrow();
});

test('getPendingReleaseNotes fetches the current version notes when unseen', async () => {
    platformFetch.mockImplementation(async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.endsWith('/news/')) {
            return new Response(newsListHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return new Response(newsDetailHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    registerService();

    await expect(registeredHandler('updater:getPendingReleaseNotes')()).resolves.toEqual({
        status: 'ok',
        data: {
            version: '0.3.7',
            notes: '# OpenDesk 0.3.7 更新内容\n\n本次发布带来以下改进。\n\n## 新增特性\n- 支持自动更新'
        }
    });
    const fetchedUrls = platformFetch.mock.calls.map((call) =>
        call[0] instanceof URL ? call[0].href : String(call[0])
    );
    expect(fetchedUrls).toEqual([
        'https://updates.example.test/news/',
        'https://updates.example.test/news/2026-11-20-stable-release/'
    ]);
});

test('a network failure still yields the generic pending payload', async () => {
    platformFetch.mockRejectedValue(new Error('offline'));
    registerService();

    await expect(registeredHandler('updater:getPendingReleaseNotes')()).resolves.toEqual({
        status: 'ok',
        data: { version: '0.3.7' }
    });
});

test('dismiss records the version so the next startup skips the modal', async () => {
    platformFetch.mockRejectedValue(new Error('offline'));
    registerService();
    await expect(registeredHandler('updater:getPendingReleaseNotes')()).resolves.toEqual({
        status: 'ok',
        data: { version: '0.3.7' }
    });

    await expect(registeredHandler('updater:dismissReleaseNotes')()).resolves.toEqual({
        status: 'ok',
        data: true
    });
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'Cache', 'whats-new-seen.json'), 'utf8'))).toEqual({
        seen: ['0.3.7']
    });

    // 下次启动：seen 命中当前版本，直接跳过且不再发起网络请求
    platformFetch.mockClear();
    await expect(registeredHandler('updater:getPendingReleaseNotes')()).resolves.toEqual({
        status: 'ok',
        data: undefined
    });
    expect(platformFetch).not.toHaveBeenCalled();
});
