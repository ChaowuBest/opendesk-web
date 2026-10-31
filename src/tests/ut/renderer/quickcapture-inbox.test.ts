import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// ── 模块 mock：隔离 renderer 侧真实依赖 ───────────────────────────────────────
// 1. renderer.js 静态导入链会触及 electron，裸 Node 环境下不可加载，直接 mock 掉；
//    被测代码只在未注入 getQuickCaptureKit 时才会走到它，正常用例不应触达。
// 2. 图片名取自渲染层翻译器，mock 掉避免触及真实 locale 初始化。
jest.unstable_mockModule('../../../platforms/bridges/renderer.js', () => ({
    NativeBridgeProxy: class {
        async getQuickCaptureKit(): Promise<never> {
            throw new Error('NativeBridgeProxy must be injected in tests');
        }
    }
}));
jest.unstable_mockModule('../../../renderer/locale.ts', () => ({
    createRendererTranslator: () => (key: string) => (key === 'quickcapture.imageName' ? 'Screenshot' : key)
}));

const { consumePendingQuickCapture, installQuickCaptureInbox } =
    await import('../../../renderer/scripts/quickcaptureInbox.ts');
type QuickCaptureInboxDependencies =
    import('../../../renderer/scripts/quickcaptureInbox.ts').QuickCaptureInboxDependencies;

// ── 测试基础设施 ──────────────────────────────────────────────────────────────
// 不引入 jsdom/happy-dom：用最小 event-target stub 模拟 window/document 的监听器
// 语义，测试只依赖 Node 能力，天然跨平台可跑。

type Listener = (event: any) => void;

class FakeEventTarget {
    listeners = new Map<string, Set<Listener>>();

    addEventListener(type: string, fn: Listener): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(fn);
    }

    removeEventListener(type: string, fn: Listener): void {
        this.listeners.get(type)?.delete(fn);
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }

    dispatch(type: string, event: any = {}): void {
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    }
}

function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

function makeAgentInput(): { element: any; calls: Array<{ dataUrl: string; name?: string }> } {
    const calls: Array<{ dataUrl: string; name?: string }> = [];
    return { element: { addImage: (dataUrl: string, name?: string) => void calls.push({ dataUrl, name }) }, calls };
}

const PENDING_CAPTURE = { dataUrl: 'data:image/jpeg;base64,QUJD' };

interface Harness {
    fakeWindow: FakeEventTarget & { systemInfo?: { isOpenHarmony?: boolean; isWindows?: boolean } };
    fakeDocument: FakeEventTarget & { visibilityState: string };
    kitCalls: { takePending: number };
    deps(
        partial?: Partial<QuickCaptureInboxDependencies> & { kit?: { dataUrl: string } | null }
    ): QuickCaptureInboxDependencies;
    install(options?: {
        pending?: { dataUrl: string } | null;
        isOpenHarmony?: boolean;
        isWindows?: boolean;
    }): () => void;
}

function makeHarness(): Harness {
    const fakeWindow = Object.assign(new FakeEventTarget(), { systemInfo: undefined as any });
    const fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' });
    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = fakeDocument;

    const kitCalls = { takePending: 0 };

    /**
     * 构造消费依赖。partial.kit 控制待处理截图：undefined=默认有一条，null=无待处理；
     * 其余字段覆盖 openHomePage / findAgentInput / mount 轮询参数 / 整个 getQuickCaptureKit。
     */
    const deps: Harness['deps'] = (partial = {}) => {
        const input = makeAgentInput();
        const resolved: QuickCaptureInboxDependencies = {
            openHomePage: (partial.openHomePage ?? jest.fn()) as any,
            findAgentInput: partial.findAgentInput ?? (() => input.element)
        };
        if (partial.getQuickCaptureKit) {
            resolved.getQuickCaptureKit = partial.getQuickCaptureKit;
        } else {
            const pending = partial.kit === undefined ? PENDING_CAPTURE : partial.kit;
            resolved.getQuickCaptureKit = async () => ({
                takePendingCapture: async () => {
                    kitCalls.takePending += 1;
                    return pending;
                }
            });
        }
        if (partial.mountPollIntervalMs !== undefined) resolved.mountPollIntervalMs = partial.mountPollIntervalMs;
        if (partial.mountPollMaxAttempts !== undefined) resolved.mountPollMaxAttempts = partial.mountPollMaxAttempts;
        return resolved;
    };

    /** 按 installQuickCaptureInbox 的真实默认路径安装（只注入 kit 与输入框）。 */
    const install: Harness['install'] = (options = {}) => {
        const isOpenHarmony = options.isOpenHarmony ?? !options.isWindows;
        const systemInfo: { isOpenHarmony?: boolean; isWindows?: boolean } = {};
        if (isOpenHarmony) systemInfo.isOpenHarmony = true;
        if (options.isWindows) systemInfo.isWindows = true;
        fakeWindow.systemInfo = systemInfo;
        const pending = options.pending === undefined ? PENDING_CAPTURE : options.pending;
        return installQuickCaptureInbox({
            getQuickCaptureKit: async () => ({
                takePendingCapture: async () => {
                    kitCalls.takePending += 1;
                    return pending;
                }
            }),
            findAgentInput: () => makeAgentInput().element
        });
    };

    return { fakeWindow, fakeDocument, kitCalls, deps, install };
}

let h: Harness;

beforeEach(() => {
    h = makeHarness();
});

afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    jest.restoreAllMocks();
});

describe('consumePendingQuickCapture', () => {
    test('injects a pending capture into the main agent input without opening the home page', async () => {
        const openHomePage = jest.fn();
        const calls: Array<{ dataUrl: string; name?: string }> = [];
        const element = { addImage: (dataUrl: string, name?: string) => void calls.push({ dataUrl, name }) };

        const injected = await consumePendingQuickCapture(
            h.deps({
                findAgentInput: () => element,
                openHomePage
            })
        );

        expect(injected).toBe(true);
        expect(calls).toEqual([{ dataUrl: PENDING_CAPTURE.dataUrl, name: 'Screenshot' }]);
        expect(openHomePage).not.toHaveBeenCalled();
    });

    test('returns false without touching the home page when nothing is pending', async () => {
        const openHomePage = jest.fn();
        const findAgentInput = jest.fn(() => null);

        const injected = await consumePendingQuickCapture(h.deps({ kit: null, findAgentInput, openHomePage }));

        expect(injected).toBe(false);
        expect(openHomePage).not.toHaveBeenCalled();
        expect(findAgentInput).not.toHaveBeenCalled();
    });

    test('opens the home page once and polls until the input mounts', async () => {
        const openHomePage = jest.fn();
        const input = makeAgentInput();
        let findCalls = 0;
        const findAgentInput = () => {
            findCalls += 1;
            return findCalls >= 3 ? input.element : null;
        };

        const injected = await consumePendingQuickCapture(
            h.deps({ openHomePage, findAgentInput, mountPollIntervalMs: 1, mountPollMaxAttempts: 20 })
        );

        expect(injected).toBe(true);
        expect(openHomePage).toHaveBeenCalledTimes(1);
        expect(input.calls).toHaveLength(1);
    });

    test('drops the capture when the input never mounts', async () => {
        const openHomePage = jest.fn();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        const injected = await consumePendingQuickCapture(
            h.deps({ openHomePage, findAgentInput: () => null, mountPollIntervalMs: 1, mountPollMaxAttempts: 2 })
        );

        expect(injected).toBe(false);
        expect(openHomePage).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('main agent input not found'));
    });

    test('drops the capture when the mounted input has no addImage capability', async () => {
        const openHomePage = jest.fn();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        const injected = await consumePendingQuickCapture(h.deps({ openHomePage, findAgentInput: () => ({}) as any }));

        expect(injected).toBe(false);
        // 输入框已存在，不应触发导航
        expect(openHomePage).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('main agent input not found'));
    });
});

describe('installQuickCaptureInbox', () => {
    test('consumes once immediately on openharmony at install time', async () => {
        h.install({ pending: PENDING_CAPTURE });
        await flushMicrotasks();

        expect(h.kitCalls.takePending).toBe(1);
        expect(h.fakeWindow.listenerCount('focus')).toBe(1);
        expect(h.fakeDocument.listenerCount('visibilitychange')).toBe(1);
        expect(h.fakeWindow.listenerCount('openDesk:visibilityChanged')).toBe(1);
    });

    test('consumes once immediately on Windows at install time', async () => {
        h.install({ isWindows: true });
        await flushMicrotasks();

        expect(h.kitCalls.takePending).toBe(1);
        expect(h.fakeWindow.listenerCount('focus')).toBe(1);
        expect(h.fakeDocument.listenerCount('visibilitychange')).toBe(1);
        expect(h.fakeWindow.listenerCount('openDesk:visibilityChanged')).toBe(1);
    });

    test('installs nothing and consumes nothing on platforms without quick capture', async () => {
        const dispose = h.install({ isOpenHarmony: false });
        await flushMicrotasks();

        expect(h.kitCalls.takePending).toBe(0);
        expect(h.fakeWindow.listenerCount('focus')).toBe(0);
        expect(h.fakeDocument.listenerCount('visibilitychange')).toBe(0);
        expect(h.fakeWindow.listenerCount('openDesk:visibilityChanged')).toBe(0);
        expect(typeof dispose).toBe('function');
        dispose();
    });

    test('focus and visibility signals trigger exactly one consumption each', async () => {
        h.install({});
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);

        h.fakeWindow.dispatch('focus');
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(2);

        h.fakeDocument.dispatch('visibilitychange', {});
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(3);

        // document.hidden 时不应消费
        (h.fakeDocument as any).visibilityState = 'hidden';
        h.fakeDocument.dispatch('visibilitychange', {});
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(3);
        (h.fakeDocument as any).visibilityState = 'visible';

        h.fakeWindow.dispatch('openDesk:visibilityChanged', { detail: true });
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(4);

        // detail=false（窗口隐藏）不应消费
        h.fakeWindow.dispatch('openDesk:visibilityChanged', { detail: false });
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(4);
    });

    test('in-flight consumption suppresses re-entrant signals', async () => {
        let releaseGate: () => void = () => undefined;
        const gatePromise = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const kit = {
            takePendingCapture: async () => {
                h.kitCalls.takePending += 1;
                if (h.kitCalls.takePending === 1) {
                    await gatePromise;
                }
                return PENDING_CAPTURE;
            }
        };
        // 手装实例仍需通过平台门卫检查
        h.fakeWindow.systemInfo = { isOpenHarmony: true };
        installQuickCaptureInbox({
            getQuickCaptureKit: async () => kit,
            findAgentInput: () => makeAgentInput().element
        });

        // 安装即触发的首次消费已进入 takePendingCapture 并被闸门挂起
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);

        // 挂起期间到达的 focus 信号必须被 in-flight 标记抑制
        h.fakeWindow.dispatch('focus');
        h.fakeWindow.dispatch('focus');
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);

        // 闸门释放：本次消费正常完成，但不补消费挂起期间的信号
        releaseGate();
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);

        // 挂起解除后新的信号恢复正常消费
        h.fakeWindow.dispatch('focus');
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(2);
    });

    test('dispose removes every listener so signals stop consuming', async () => {
        const dispose = h.install({});
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);

        dispose();
        expect(h.fakeWindow.listenerCount('focus')).toBe(0);
        expect(h.fakeDocument.listenerCount('visibilitychange')).toBe(0);
        expect(h.fakeWindow.listenerCount('openDesk:visibilityChanged')).toBe(0);

        h.fakeWindow.dispatch('focus');
        h.fakeDocument.dispatch('visibilitychange', {});
        h.fakeWindow.dispatch('openDesk:visibilityChanged', { detail: true });
        await flushMicrotasks();
        expect(h.kitCalls.takePending).toBe(1);
    });
});
