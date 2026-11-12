import { afterAll, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// macOS 一期：electron-service 在 darwin 上放开门禁并进入手动安装模式
// （下载校验完成后停在 ready，等用户挂载 DMG），测试进程模拟 Apple 芯片 Mac；
// arch 也一并固定，否则安装包架构选择在 x64/arm64 宿主机上结果不同
const realPlatform = process.platform;
const realArch = process.arch;
Object.defineProperty(process, 'platform', { value: 'darwin' });
Object.defineProperty(process, 'arch', { value: 'arm64' });
afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    Object.defineProperty(process, 'arch', { value: realArch });
});

const dmgBytes = new Uint8Array([0x78, 0x7a, 0x20, 0x64, 0x6d, 0x67]);

const platformFetch = jest.fn<(input: string | URL) => Promise<Response>>();
const ipcHandle = jest.fn();
const shellOpenPath = jest.fn(async () => '');

const feedHtml = `<!doctype html><html><body><ol class="release-list">
    <li data-release-category="stable-release"><article class="release-item">
        <span class="release-item__title">OpenDesk 0.3.8：macOS 手动安装测试</span>
        <div class="release-downloads">
            <a href="https://updates.example.test/opendesk-win-x86-0.3.8.exe">Windows x86 安装包</a>
            <a href="https://updates.example.test/opendesk-darwin-x86-0.3.8.dmg">macOS 安装包 (Intel 芯片)</a>
            <a href="https://updates.example.test/opendesk-darwin-arm64-0.3.8.dmg">macOS 安装包 (Apple 芯片)</a>
        </div>
    </article></li>
</ol></body></html>`;

// 每个用例使用独立 userData 目录，避免上一个用例留下的 ready 记录干扰 restore 链路
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-darwin-'));

jest.unstable_mockModule('electron', () => ({
    app: {
        isPackaged: true,
        getVersion: () => '0.3.7',
        getPath: () => userDataDir
    },
    ipcMain: { handle: ipcHandle },
    shell: { openPath: shellOpenPath }
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

const submitUpdateToService = jest.fn(async () => ({
    protocolVersion: 1,
    requestId: 'request-id',
    status: 'installed' as const,
    code: 'installed',
    updatedAtUtc: new Date().toISOString()
}));
const reportUpdateHealthToService = jest.fn(async () => ({
    protocolVersion: 1,
    requestId: 'request-id',
    status: 'ok' as const,
    code: 'health_recorded',
    updatedAtUtc: new Date().toISOString()
}));

jest.unstable_mockModule('../../../main/updater/update-service-client.js', () => ({
    submitUpdateToService,
    reportUpdateHealthToService
}));

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => ({ fetch: platformFetch })
}));

const { registerElectronUpdateService } = await import('../../../main/updater/electron-service.js');

// macOS 没有 Windows 更新系统服务，健康上报逻辑只在拿到主窗口时才会触发，
// 因此用一个存活的假窗口让「跳过上报」成为可观察的行为
const fakeMainWindow = {
    isDestroyed: () => false,
    webContents: { isLoadingMainFrame: () => false }
};

async function waitForStatus(coordinator: { getState: () => { status: string } }, status: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (coordinator.getState().status === status) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`update state did not reach "${status}" in time: ${JSON.stringify(coordinator.getState())}`);
}

beforeEach(() => {
    platformFetch.mockReset();
    submitUpdateToService.mockClear();
    reportUpdateHealthToService.mockClear();
    ipcHandle.mockClear();
    shellOpenPath.mockClear();
    process.env.OPENDESK_UPDATE_FORCE_ENABLE = '1';
    process.env.OPENDESK_UPDATE_FEED_URL = 'https://updates.example.test/news/';
    delete process.env.OPENDESK_UPDATE_TEST_INSTALLER;
});

function mockHappyPath(): void {
    platformFetch.mockImplementation(async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.endsWith('/news/')) {
            return new Response(feedHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return new Response(dmgBytes, {
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(dmgBytes.length) }
        });
    });
}

test('macOS updater downloads the apple-silicon dmg and keeps it ready for manual installation', async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-darwin-'));
    mockHappyPath();

    const coordinator = registerElectronUpdateService({
        getMainWindow: () => fakeMainWindow as unknown as import('electron').BrowserWindow,
        prepareWindowsForQuit: async () => true,
        quitForRestart: () => undefined,
        logInfo: () => undefined,
        logError: (message) => throwOnErrorLog(message)
    });
    expect(coordinator).toBeDefined();

    // 注册时触发的 restore → checkForUpdates 链路即完整更新流程，手动安装模式止步于 ready
    await waitForStatus(coordinator!, 'ready');

    // feed 解析必须带上 darwin 平台参数：否则按 win32 默认值找不到稳定版安装包
    const fetchedUrls = platformFetch.mock.calls.map((call) =>
        call[0] instanceof URL ? call[0].href : String(call[0])
    );
    expect(fetchedUrls).toEqual([
        'https://updates.example.test/news/',
        'https://updates.example.test/opendesk-darwin-arm64-0.3.8.dmg'
    ]);

    // 手动安装模式：不提交 Windows 更新服务，也不上报服务健康状态
    expect(submitUpdateToService).not.toHaveBeenCalled();
    expect(reportUpdateHealthToService).not.toHaveBeenCalled();

    // 已下载校验的安装包与 ready 记录保留在缓存目录，等用户手动挂载 DMG
    const installerPath = path.join(userDataDir, 'Cache', 'opendesk-darwin-arm64-0.3.8.dmg');
    expect(coordinator!.getState()).toMatchObject({ status: 'ready', version: '0.3.8', installerPath });
    expect(fs.existsSync(installerPath)).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'Cache', 'ready.json'))).toBe(true);
}, 15000);

test('the updater:openInstaller channel mounts the ready dmg', async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-darwin-'));
    mockHappyPath();

    const coordinator = registerElectronUpdateService({
        getMainWindow: () => fakeMainWindow as unknown as import('electron').BrowserWindow,
        prepareWindowsForQuit: async () => true,
        quitForRestart: () => undefined,
        logInfo: () => undefined,
        logError: (message) => throwOnErrorLog(message)
    });
    await waitForStatus(coordinator!, 'ready');

    const openHandler = ipcHandle.mock.calls.filter(([channel]) => channel === 'updater:openInstaller').at(-1)?.[1];
    expect(typeof openHandler).toBe('function');
    await expect(openHandler!()).resolves.toEqual({ status: 'ok', data: true });

    const installerPath = path.join(userDataDir, 'Cache', 'opendesk-darwin-arm64-0.3.8.dmg');
    expect(shellOpenPath).toHaveBeenCalledTimes(1);
    expect(shellOpenPath).toHaveBeenCalledWith(installerPath);
}, 15000);

function throwOnErrorLog(message: string): void {
    throw new Error(`unexpected updater error log: ${message}`);
}
