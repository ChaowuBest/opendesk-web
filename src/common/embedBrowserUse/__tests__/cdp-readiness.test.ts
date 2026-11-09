import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BrowserController, CDP_READY_BUDGET_MS, type BrowserScriptGenerators } from '../main.js';

/**
 * 回归测试：requireCDP 的就绪等待（BUG-29）。
 *
 * 此前是固定退避重试（纯时间预算），真实站点首帧慢（webview attach + 首个
 * 执行上下文建立超过退避窗口）时表现为"首次 snapshot 偶发 CDP session not
 * available，需要重试"。现在事件驱动：监听宿主窗口的 did-attach-webview，
 * 事件到达立即重试；总预算有界（CDP_READY_BUDGET_MS）。
 */

const mockScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

/** 可手动派发 did-attach-webview 的宿主窗口替身。 */
function makeEmitterWindow() {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        isDestroyed: () => false,
        webContents: {
            on: (event: string, fn: (...args: unknown[]) => void) => {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event)!.add(fn);
            },
            removeListener: (event: string, fn: (...args: unknown[]) => void) => {
                listeners.get(event)?.delete(fn);
            },
            emit: (event: string) => {
                for (const fn of listeners.get(event) ?? []) fn();
            },
            executeJavaScript: jest.fn(async () => ({ result: null }))
        }
    } as any;
}

function makeCtrl(win: any, getCDPSessionImpl: () => Promise<any>) {
    const ctrl = new BrowserController('t-ready', win, mockScriptGen);
    (ctrl as any).getCDPSession = jest.fn(getCDPSessionImpl);
    return ctrl;
}

describe('requireCDP 事件驱动就绪（BUG-29）', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('已就绪时立即返回（不进入等待循环）', async () => {
        const win = makeEmitterWindow();
        const session = { isHealthy: async () => true };
        const ctrl = makeCtrl(win, async () => session);

        await expect(ctrl.requireCDP()).resolves.toBe(session);
    });

    test('webview 尚未 attach 时等待 did-attach-webview 事件后立即就绪', async () => {
        const win = makeEmitterWindow();
        let attached = false;
        let attempts = 0;
        const session = { isHealthy: async () => true };
        const ctrl = makeCtrl(win, async () => {
            attempts++;
            return attached ? session : null;
        });

        const promise = ctrl.requireCDP();
        // 第一次尝试失败 → 进入 attach 事件等待；随后事件到达，立即重试成功
        await jest.advanceTimersByTimeAsync(100);
        expect(attempts).toBeGreaterThanOrEqual(1);
        attached = true;
        win.webContents.emit('did-attach-webview');
        await jest.advanceTimersByTimeAsync(10);
        await expect(promise).resolves.toBe(session);
        // 事件驱动：attach 后立即重试成功，而不是烧完整退避窗口（总尝试次数很少）
        expect(attempts).toBeLessThanOrEqual(4);
    });

    test('永不就绪时在预算内失败', async () => {
        const win = makeEmitterWindow();
        const ctrl = makeCtrl(win, async () => null);

        const rejection = expect(ctrl.requireCDP()).rejects.toThrow('browser may not be ready');
        await jest.advanceTimersByTimeAsync(CDP_READY_BUDGET_MS + 5000);
        await rejection;
    });

    test('宿主窗口已销毁时快速失败，不做无意义的等待', async () => {
        const win = makeEmitterWindow();
        win.isDestroyed = () => true;
        const ctrl = makeCtrl(win, async () => null);

        // 快速路径：不等 attach 事件、不烧就绪预算
        await expect(ctrl.requireCDP()).rejects.toThrow();
    });
});
