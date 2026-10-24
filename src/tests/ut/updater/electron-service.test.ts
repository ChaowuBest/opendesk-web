import { afterAll, beforeEach, expect, jest, test } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// updater 仅在 win32 启用（electron-service.ts updaterEnabled），测试进程模拟 Windows；
// arch 也一并固定，否则安装包架构断言在 x64/arm64 宿主机上结果不同
const realPlatform = process.platform;
const realArch = process.arch;
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    Object.defineProperty(process, 'arch', { value: realArch });
});

const installerBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);

const platformFetch = jest.fn<(input: string | URL) => Promise<Response>>();

const feedHtml = `<!doctype html><html><body><ol class="release-list">
    <li data-release-category="stable-release"><article class="release-item">
        <span class="release-item__title">OpenDesk 0.3.8：代理更新测试</span>
        <div class="release-downloads">
            <a href="https://updates.example.test/opendesk-win-x86-0.3.8.exe">Windows x86 安装包</a>
            <a href="https://updates.example.test/opendesk-win-arm64-0.3.8.exe">Windows ARM64 安装包</a>
        </div>
    </article></li>
</ol></body></html>`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-service-'));

jest.unstable_mockModule('electron', () => ({
    app: {
        isPackaged: true,
        getVersion: () => '0.3.7',
        getPath: () => userDataDir
    },
    ipcMain: { handle: jest.fn() }
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
    requestId: crypto.randomUUID(),
    status: 'installed' as const,
    code: 'installed',
    updatedAtUtc: new Date().toISOString()
}));
const reportUpdateHealthToService = jest.fn(async () => ({
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
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
    process.env.OPENDESK_UPDATE_FORCE_ENABLE = '1';
    process.env.OPENDESK_UPDATE_FEED_URL = 'https://updates.example.test/news/';
    delete process.env.OPENDESK_UPDATE_TEST_INSTALLER;
});

test('updater performs feed check and installer download through the platform proxy fetch', async () => {
    platformFetch.mockImplementation(async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.endsWith('/news/')) {
            return new Response(feedHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return new Response(installerBytes, {
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(installerBytes.length) }
        });
    });

    const coordinator = registerElectronUpdateService({
        getMainWindow: () => null,
        prepareWindowsForQuit: async () => true,
        quitForRestart: () => undefined,
        logInfo: () => undefined,
        logError: (message) => throwOnErrorLog(message)
    });
    expect(coordinator).toBeDefined();

    // 注册时触发的 restore → checkForUpdates 链路即完整更新流程
    await waitForStatus(coordinator!, 'installed');

    const fetchedUrls = platformFetch.mock.calls.map((call) =>
        call[0] instanceof URL ? call[0].href : String(call[0])
    );
    expect(fetchedUrls).toEqual([
        'https://updates.example.test/news/',
        'https://updates.example.test/opendesk-win-x86-0.3.8.exe'
    ]);

    // 修复后的下载链路真实落盘：提交给更新服务的记录指向缓存目录中的安装包，
    // 且 sha256 与 mock 下载内容一致（证明写入磁盘的字节正确）
    const submittedRecord = jest.mocked(submitUpdateToService).mock.calls[0][0];
    const expectedInstallerPath = path.join(userDataDir, 'Cache', 'opendesk-win-x86-0.3.8.exe');
    expect(submittedRecord.installerPath).toBe(expectedInstallerPath);
    expect(submittedRecord.version).toBe('0.3.8');
    expect(submittedRecord.sha256).toBe(crypto.createHash('sha256').update(installerBytes).digest('hex'));

    const state = coordinator!.getState();
    expect(state).toMatchObject({ status: 'installed', version: '0.3.8' });
    // 应用更新后安装包与 ready 记录按设计被消费
    expect(fs.existsSync(expectedInstallerPath)).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'Cache', 'ready.json'))).toBe(false);
}, 15000);

function throwOnErrorLog(message: string): void {
    throw new Error(`unexpected updater error log: ${message}`);
}
