import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * AgentInput 高频写入守卫的回归测试：
 * goal 运行期宿主每秒经 updateStopButtonVisibility 触发
 * setRunningInputMode → setDisabled → setStopMode → updateInputState ×3，
 * 值未变化时这些调用应当短路（跳过整轮 updateInputState 与占位 innerHTML 重建）。
 */
const showConfirmModal = jest.fn(async () => true);

describe('agent-input repeated setter guards', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return { available: async () => false };
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function setupInput() {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
            setStopMode: (showStop: boolean, onStopCallback?: (() => void) | null) => void;
            setDisabled: (disabled: boolean) => void;
            setRunningInputMode: (mode: string) => void;
            updateInputState: () => void;
            updatePlaceholder: () => void;
            showStopButton: boolean;
            onStopCallback: (() => void) | null;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        textarea.setRangeText = jest.fn(function (this: HTMLTextAreaElement, text: string, start: number, end: number) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
        });
        textarea.focus = jest.fn();
        return { input, textarea };
    }

    test('setDisabled 同值重复调用不再触发 updateInputState', () => {
        const { input } = setupInput();
        const spy = jest.spyOn(input, 'updateInputState');
        input.setDisabled(true);
        const callsAfterFirst = spy.mock.calls.length;
        input.setDisabled(true);
        input.setDisabled(true);
        expect(spy.mock.calls.length).toBe(callsAfterFirst);
        input.setDisabled(false);
        expect(spy.mock.calls.length).toBe(callsAfterFirst + 1);
    });

    test('setStopMode 同值只更新回调闭包，不触发 updateInputState', () => {
        const { input } = setupInput();
        const spy = jest.spyOn(input, 'updateInputState');
        input.setStopMode(true, jest.fn());
        const callsAfterFirst = spy.mock.calls.length;
        const latest = jest.fn();
        input.setStopMode(true, latest);
        expect(spy.mock.calls.length).toBe(callsAfterFirst);
        expect(input.onStopCallback).toBe(latest);
        input.setStopMode(false);
        expect(spy.mock.calls.length).toBe(callsAfterFirst + 1);
        expect(input.onStopCallback).toBeNull();
    });

    test('短路时 isRunning 被中间赋值带偏会回正并刷新一次', () => {
        const { input } = setupInput();
        // 模拟运行态：stop 按钮可见、isRunning 已同步
        input.setStopMode(true, jest.fn());
        input.setDisabled(true);
        expect((input as any).isRunning).toBe(true);
        // 外部把 isRunning 带偏（如手工赋值/未来调用序列变化）
        (input as any).isRunning = false;
        const spy = jest.spyOn(input, 'updateInputState');
        input.setStopMode(true, jest.fn());
        expect((input as any).isRunning).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        // 已回正后的重复调用不再刷新
        input.setStopMode(true, jest.fn());
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('setRunningInputMode 同值短路，模式变化时恢复刷新', () => {
        const { input } = setupInput();
        const spy = jest.spyOn(input, 'updateInputState');
        input.setRunningInputMode('queue');
        const callsAfterFirst = spy.mock.calls.length;
        input.setRunningInputMode('queue');
        expect(spy.mock.calls.length).toBe(callsAfterFirst);
        input.setRunningInputMode('goal_supplement');
        expect(spy.mock.calls.length).toBe(callsAfterFirst + 1);
    });

    test('占位文案未变时 overlay 不重建，变化时恢复重建', () => {
        const { input } = setupInput();
        const overlay = input.querySelector('#agent-input-placeholder') as HTMLElement & {
            dataset: Record<string, string>;
        };
        expect(overlay).toBeTruthy();
        const firstHtml = overlay.innerHTML;
        expect(firstHtml.length).toBeGreaterThan(0);
        input.updatePlaceholder();
        input.updatePlaceholder();
        expect(overlay.innerHTML).toBe(firstHtml);
        expect(overlay.firstChild).toBeTruthy();
    });

    test('禁用分支写入门控文案后，恢复时强制重建富文本占位', () => {
        const { input } = setupInput();
        const overlay = input.querySelector('#agent-input-placeholder') as HTMLElement & {
            dataset: Record<string, string>;
        };
        const richPlaceholder = overlay.innerHTML;
        // 走真实的禁用/恢复链路：禁用分支直接写 textContent 并清除签名，
        // 解锁后 updatePlaceholder 必须重建富文本（避免"正在加载"文案残留）。
        (input as any)._taskLoadingLocked = true;
        input.updateInputState();
        expect(overlay.textContent).not.toBe(richPlaceholder);
        (input as any)._taskLoadingLocked = false;
        input.updateInputState();
        expect(overlay.innerHTML).toBe(richPlaceholder);
    });
});
