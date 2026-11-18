import { afterAll, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 模块 mock：在 ESM 动态导入前挂好，保证被测模块拿到 mock 版本 ──────────────

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const emittedAppEvents: string[] = [];
const app = {
    isPackaged: true,
    getLoginItemSettings: jest.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true })),
    setLoginItemSettings: jest.fn(),
    getAppPath: () => process.cwd(),
    emit: (name: string) => {
        emittedAppEvents.push(name);
    }
};

let webContentsSeq = 0;

/** 最小 BrowserWindow 替身：只覆盖快速截图遮罩用到的窗口能力。 */
class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];

    webContents = { id: ++webContentsSeq, on: () => undefined, setZoomFactor: () => undefined };
    destroyed = false;
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(public options: Record<string, any>) {
        FakeBrowserWindow.instances.push(this);
    }

    setMenu(): void {}
    setAlwaysOnTop(): void {}

    on(event: string, listener: (...args: any[]) => void): this {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return this;
    }

    once(event: string, listener: (...args: any[]) => void): this {
        return this.on(event, listener);
    }

    emit(event: string, ...args: any[]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    show(): void {}
    focus(): void {}

    isDestroyed(): boolean {
        return this.destroyed;
    }

    close(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
    }

    loadFile(): Promise<void> {
        return Promise.resolve();
    }

    loadURL(): Promise<void> {
        return Promise.resolve();
    }
}

interface FakeImage {
    width: number;
    height: number;
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    crop: (rect: { x: number; y: number; width: number; height: number }) => FakeImage;
    toJPEG: () => Buffer;
}

function makeImage(width: number, height: number): FakeImage {
    return {
        width,
        height,
        isEmpty: () => false,
        getSize: () => ({ width, height }),
        crop: (rect) => makeImage(rect.width, rect.height),
        toJPEG: () => Buffer.from('fake-jpeg')
    };
}

const primaryDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1
};

const getSources = jest.fn(async () => [
    { display_id: '1', thumbnail: makeImage(1920, 1080) },
    { display_id: '2', thumbnail: makeImage(1280, 720) }
]);

const clipboardWriteImage = jest.fn();

jest.unstable_mockModule('electron', () => ({
    app,
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeImage: clipboardWriteImage },
    desktopCapturer: { getSources },
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
    screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 20 }),
        getDisplayNearestPoint: () => primaryDisplay
    }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../../locale/index.js', () => ({
    t: (key: string, params?: Record<string, string | number>) => {
        if (!params) return key;
        const suffix = Object.entries(params)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(',');
        return `${key}:${suffix}`;
    },
    translateWithDomain: (key: string) => key
}));

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
let resolveNativeBridge: typeof import('../../../platforms/bridges/main.js').resolveNativeBridge;
let NativeBridgeProxy: typeof import('../../../platforms/bridges/renderer.js').NativeBridgeProxy;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
// 统一临时目录：用例内一律用 path.join 拼路径，避免硬编码分隔符导致跨平台失败
const platformTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-quickcapture-bridge-'));

beforeAll(async () => {
    ({ registerNativeBridge, resolveNativeBridge } = await import('../../../platforms/bridges/main.js'));
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
    emittedAppEvents.length = 0;
    FakeBrowserWindow.instances = [];
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

test.each(['linux', 'darwin'])('%s falls back to the naive quickCapture kit', async (platform) => {
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

// ── Windows：main.ts globalShortcut 转发 + 不透明遮罩窗口实现 ───────────────────

function useWindowsBridge(): void {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    registerNativeBridge();
}

function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test('windows exposes quick capture as supported and enabled by default', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();

    await expect(kit.getState()).resolves.toEqual({ supported: true, enabled: true });
    await expect(kit.takePendingCapture()).resolves.toBeNull();
});

test('windows hotkey pre-captures the cursor display before showing the overlay', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();

    kit.triggerFromHotkey?.();
    await flushAsync();

    expect(getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(FakeBrowserWindow.instances[0].options).toMatchObject({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        frame: false,
        // 透明窗口在 Windows 上收不到触摸输入，遮罩必须用不透明窗口 + 预截屏背景
        transparent: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false
    });
});

test('windows overlay window isolates electron zoom from the main window', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();

    kit.triggerFromHotkey?.();
    await flushAsync();

    // Electron 的 zoom 按 origin 共享：遮罩若与主窗口共用默认 session，会继承主窗口的
    // 缩放（框选坐标与像素错位），并把 zoom 设回 1 后污染主窗口缩放。必须独立 partition。
    expect(FakeBrowserWindow.instances[0].options.webPreferences).toMatchObject({
        partition: 'opendesk-quickcapture-overlay',
        zoomFactor: 1
    });
});

test('windows hotkey disabled during the async pre-capture does not open the overlay', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();

    // 预截取挂在 pending 状态，期间用户在设置里关掉开关
    let releaseCapture: (() => void) | null = null;
    getSources.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                releaseCapture = () => resolve([{ display_id: '1', thumbnail: makeImage(1920, 1080) }]);
            })
    );

    kit.triggerFromHotkey?.();
    await kit.setEnabled(false);
    releaseCapture!();
    await flushAsync();

    expect(FakeBrowserWindow.instances).toHaveLength(0);
});

test('windows hotkey is ignored when quick capture is disabled', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    await kit.setEnabled(false);

    kit.triggerFromHotkey?.();
    await flushAsync();

    expect(getSources).not.toHaveBeenCalled();
    expect(FakeBrowserWindow.instances).toHaveLength(0);
});

test('windows overlay hands a cropped capture to the main window exactly once', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    kit.triggerFromHotkey?.();
    await flushAsync();

    const overlay = FakeBrowserWindow.instances[0];
    const overlayId = overlay.webContents.id;

    // 非遮罩窗口发起的 IPC 调用一律拒绝
    expect(handlers.get('quickcapture-overlay:ready')!({ sender: { id: -1 } })).toBeNull();

    const strings = await handlers.get('quickcapture-overlay:ready')!({ sender: { id: overlayId } });
    expect(strings).toEqual({
        hintDrag: 'quickcapture.hintDrag',
        hintExit: 'quickcapture.hintExit',
        cancel: 'quickcapture.cancel',
        copy: 'quickcapture.copy',
        send: 'quickcapture.send',
        backdrop: `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`,
        screenWidth: 1920,
        screenHeight: 1080
    });

    const result = await handlers.get('quickcapture-overlay:commit')!(
        { sender: { id: overlayId } },
        { left: 100, top: 50, width: 200, height: 100 }
    );
    expect(result).toEqual({ ok: true, message: 'quickcapture.sent:width=200,height=100' });

    const pending = await kit.takePendingCapture();
    expect(pending).toEqual({ dataUrl: `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}` });
    // Take 语义：取走即清空
    await expect(kit.takePendingCapture()).resolves.toBeNull();

    await handlers.get('quickcapture-overlay:close')!({ sender: { id: overlayId } });
    expect(overlay.isDestroyed()).toBe(true);
    expect(emittedAppEvents).toContain('opendesk:quick-capture:bring-main-to-front');
});

test('windows cancel closes the overlay without bringing the main window to front', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    kit.triggerFromHotkey?.();
    await flushAsync();

    const overlay = FakeBrowserWindow.instances[0];
    await handlers.get('quickcapture-overlay:close')!({ sender: { id: overlay.webContents.id } });

    expect(overlay.isDestroyed()).toBe(true);
    expect(emittedAppEvents).not.toContain('opendesk:quick-capture:bring-main-to-front');
});

test('windows does not open the overlay when the screen capture is empty', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    getSources.mockResolvedValueOnce([]);

    kit.triggerFromHotkey?.();
    await flushAsync();

    expect(FakeBrowserWindow.instances).toHaveLength(0);
    await expect(kit.takePendingCapture()).resolves.toBeNull();
});

test('windows overlay copies the selection to the clipboard instead of handing it to the main window', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    kit.triggerFromHotkey?.();
    await flushAsync();

    const overlay = FakeBrowserWindow.instances[0];
    const overlayId = overlay.webContents.id;

    const result = await handlers.get('quickcapture-overlay:copy')!(
        { sender: { id: overlayId } },
        { left: 100, top: 50, width: 200, height: 100 }
    );
    expect(result).toEqual({ ok: true, message: 'quickcapture.copied:width=200,height=100' });
    expect(clipboardWriteImage).toHaveBeenCalledTimes(1);

    // 复制不进入待处理队列，关闭遮罩后也不把主窗口拉到前台
    await expect(kit.takePendingCapture()).resolves.toBeNull();
    await handlers.get('quickcapture-overlay:close')!({ sender: { id: overlayId } });
    expect(overlay.isDestroyed()).toBe(true);
    expect(emittedAppEvents).not.toContain('opendesk:quick-capture:bring-main-to-front');
});

test('windows copy rejects calls from windows other than the current overlay', async () => {
    useWindowsBridge();
    const kit = await resolveNativeBridge().getQuickCaptureKit();
    kit.triggerFromHotkey?.();
    await flushAsync();

    const result = await handlers.get('quickcapture-overlay:copy')!(
        { sender: { id: -1 } },
        { left: 0, top: 0, width: 10, height: 10 }
    );
    expect(result).toEqual({ ok: false, message: 'quickcapture.copyFailed' });
    expect(clipboardWriteImage).not.toHaveBeenCalled();
});
