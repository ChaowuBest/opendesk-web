import { afterAll, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 模块 mock：在 ESM 动态导入前挂好，保证被测模块拿到 mock 版本 ──────────────

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const app = {
    isPackaged: true,
    getLoginItemSettings: jest.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true })),
    setLoginItemSettings: jest.fn()
};

let backendEnabled = true;
let pendingPath: string | null = null;
/** 置位后下一次 TakePendingCapture 返回无法 JSON.parse 的脏数据，用于验证畸形 envelope 传播。 */
let corruptNextTakePending = false;

const arktsCall = jest.fn(async (method: string, _retType: string, args: any[]) => {
    if (method === 'QuickCaptureAdapter.IsEnabled') {
        return JSON.stringify({ ok: true, error: null, enabled: backendEnabled });
    }
    if (method === 'QuickCaptureAdapter.SetEnabled') {
        backendEnabled = args[0] === 'true';
        return JSON.stringify({ ok: true, error: null, enabled: backendEnabled });
    }
    if (method === 'QuickCaptureAdapter.TakePendingCapture') {
        const path = pendingPath;
        pendingPath = null;
        if (corruptNextTakePending) {
            return 'not-json-at-all';
        }
        return JSON.stringify({ ok: true, error: null, path });
    }
    throw new Error(`unexpected arkts call: ${method}`);
});

jest.unstable_mockModule('electron', () => ({
    app,
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { info: jest.fn() } }));
jest.unstable_mockModule('../../../platforms/bridges/darwin/speech.js', () => ({ DarwinSpeechKit: class {} }));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/speech.js', () => ({ HarmonyOSSpeechKit: class {} }));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/database.js', () => ({
    HarmonyOSDatabaseKit: class {}
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/account.js', () => ({
    HarmonyOSHuaweiAccountKit: class {}
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/arkts.js', () => ({
    hasArkTSAdapter: () => true,
    callArkTS: arktsCall,
    EtsBridgeMethods: {
        QUICKCAPTURE_SET_ENABLED: 'QuickCaptureAdapter.SetEnabled',
        QUICKCAPTURE_IS_ENABLED: 'QuickCaptureAdapter.IsEnabled',
        QUICKCAPTURE_TAKE_PENDING: 'QuickCaptureAdapter.TakePendingCapture'
    }
}));

let registerNativeBridge: typeof import('../../../platforms/bridges/main.js').registerNativeBridge;
let NativeBridgeProxy: typeof import('../../../platforms/bridges/renderer.js').NativeBridgeProxy;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
// 统一临时目录：用例内一律用 path.join 拼路径，避免硬编码分隔符导致跨平台失败
const platformTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-quickcapture-bridge-'));

beforeAll(async () => {
    ({ registerNativeBridge } = await import('../../../platforms/bridges/main.js'));
    ({ NativeBridgeProxy } = await import('../../../platforms/bridges/renderer.js'));
    (globalThis as any).window = {
        native: {
            call: async (method: string, ...args: any[]) =>
                (await handlers.get('native:call')!({}, method, ...args)).data
        }
    };
});

beforeEach(() => {
    jest.clearAllMocks();
    backendEnabled = true;
    pendingPath = null;
    corruptNextTakePending = false;
});

/** 在统一临时目录下写一个假 JPEG，返回路径与原始字节。 */
function writeTempCapture(): { filePath: string; bytes: Buffer } {
    const bytes = Buffer.from('fake-jpeg-bytes');
    const filePath = path.join(platformTmpDir, `qc-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(filePath, bytes);
    return { filePath, bytes };
}

afterAll(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    delete (globalThis as any).window;
    fs.rmSync(platformTmpDir, { recursive: true, force: true });
});

test('openharmony quickCapture round-trips through the native:call dispatcher', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();

    expect(await kit.getState()).toEqual({ supported: true, enabled: true });
    expect(arktsCall).toHaveBeenLastCalledWith('QuickCaptureAdapter.IsEnabled', 'string', []);

    expect(await kit.setEnabled(false)).toEqual({ supported: true, enabled: false });
    expect(arktsCall).toHaveBeenLastCalledWith('QuickCaptureAdapter.SetEnabled', 'string', ['false']);
    expect(await kit.getState()).toEqual({ supported: true, enabled: false });

    expect(await kit.setEnabled(true)).toEqual({ supported: true, enabled: true });
    expect(arktsCall).toHaveBeenLastCalledWith('QuickCaptureAdapter.SetEnabled', 'string', ['true']);
});

test.each(['win32', 'linux', 'darwin'])('%s falls back to the naive quickCapture kit', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();

    await expect(kit.getState()).resolves.toEqual({ supported: false, enabled: false });
    await expect(kit.setEnabled(true)).rejects.toThrow('not available');
    await expect(kit.takePendingCapture()).resolves.toBeNull();
    expect(arktsCall).not.toHaveBeenCalled();
});

test('openharmony envelope failure surfaces as an error', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();

    arktsCall.mockResolvedValueOnce(
        JSON.stringify({ ok: false, error: { code: 'invalid_argument', message: 'bad input' }, enabled: true })
    );
    await expect(kit.setEnabled(true)).rejects.toThrow(/invalid_argument/);
});

test('openharmony takePendingCapture reads the queued file into a data url and deletes it', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();
    const { filePath, bytes } = writeTempCapture();
    pendingPath = filePath;

    const pending = await kit.takePendingCapture();
    expect(pending).toEqual({ dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` });
    expect(fs.existsSync(filePath)).toBe(false);

    // Take 语义：取走后再调用返回 null（不报错、不再触碰文件系统）。
    await expect(kit.takePendingCapture()).resolves.toBeNull();
});

test('openharmony takePendingCapture returns null when nothing is queued', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();

    await expect(kit.takePendingCapture()).resolves.toBeNull();
});

test('openharmony takePendingCapture swallows file read failures and clears the queue', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();
    pendingPath = path.join(platformTmpDir, 'qc-missing.jpg');
    // 读失败是有意为之的场景，静音预期中的 console.error 并断言其确实发生
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(kit.takePendingCapture()).resolves.toBeNull();
    expect(pendingPath).toBeNull();
    // 逐字段断言而非 toHaveBeenCalledWith/toBeInstanceOf：ESM vm 隔离下
    // 模块内的 Error 构造器与测试文件的全局 Error 身份不同，跨 realm 匹配必失败
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('failed to read pending capture');
    expect(String(errorSpy.mock.calls[0][1])).toContain('ENOENT');
    errorSpy.mockRestore();
});

test('openharmony takePendingCapture keeps the capture when only the file cleanup fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();
    const { filePath, bytes } = writeTempCapture();
    pendingPath = filePath;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // 注入 rmSync 一次性失败（EBUSY 场景的跨平台等价模拟）：
    // 文件内容已成功读出，清理失败不应丢弃截图。
    jest.spyOn(fs, 'rmSync').mockImplementationOnce((target: any) => {
        if (String(target) === filePath) throw new Error('EBUSY');
    });

    const pending = await kit.takePendingCapture();
    expect(pending).toEqual({ dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
});

test('openharmony malformed TakePendingCapture envelope propagates the error to the renderer', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getQuickCaptureKit();
    corruptNextTakePending = true;

    await expect(kit.takePendingCapture()).rejects.toThrow(/Unexpected token/i);
});
