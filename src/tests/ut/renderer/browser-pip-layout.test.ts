import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 画中画浮窗的默认布局与首帧时机：
 * - 默认位置在 taskview 右下角，右边缘与 agent-input 输入框右侧对齐，
 *   下边缘贴在输入框顶部上方（锚点对齐），每次 show() 都按当前布局重新计算；
 * - 截图区域固定 16:9（与画中画视口一致），浮窗尺寸只由宽度决定，
 *   截图加载/比例变化不会让浮窗先变大再跳回；
 * - show() 不立刻截图：要先等 webview 视口切成 16:9，否则拿到的是切换前的窄高画面。
 */
describe('browser pip default layout', () => {
    let BrowserPip: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        ({ BrowserPip } = await import('../../../renderer/components/browserPip.ts'));
    });

    const PIP_WIDTH = 308;
    // 默认宽度 308 下：截图高度 round(308 / (1280 / 720)) = 173，加 24px 状态栏 = 197
    const PIP_IMG_HEIGHT = 173;
    const PIP_HEIGHT = 197;
    const ANCHOR_GAP = 12;

    interface PipOptions {
        capturePage?: () => Promise<string | null>;
    }

    function createPip(
        containerRect: { left: number; top: number; width: number; height: number },
        anchorRect: any,
        options: PipOptions = {}
    ) {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        container.getBoundingClientRect = () =>
            ({
                left: containerRect.left,
                top: containerRect.top,
                right: containerRect.left + containerRect.width,
                bottom: containerRect.top + containerRect.height,
                width: containerRect.width,
                height: containerRect.height,
                x: containerRect.left,
                y: containerRect.top,
                toJSON: () => ({})
            }) as DOMRect;
        document.body.appendChild(container);

        const pip = new BrowserPip(container, {
            onRestore: () => undefined,
            getAnchorRect: () => anchorRect,
            capturePage: options.capturePage ?? (async () => null),
            getTabCount: () => 1,
            getActiveTabTitle: () => '示例页面',
            getActiveTabUrl: () => 'https://example.com'
        });

        return { pip, container };
    }

    function pipRect(pip: any): { left: number; top: number; width: number } {
        return {
            left: Number.parseFloat(pip._el.style.left),
            top: Number.parseFloat(pip._el.style.top),
            width: Number.parseFloat(pip._el.style.width)
        };
    }

    describe('default position', () => {
        test('aligns with the agent input: right edges match and the bottom sits above it', () => {
            const anchor = { top: 500, right: 700, width: 640 };
            const { pip } = createPip({ left: 0, top: 0, width: 800, height: 600 }, anchor);

            pip.show();
            const rect = pipRect(pip);

            expect(rect.width).toBe(PIP_WIDTH);
            // 右边缘与输入框右侧对齐
            expect(rect.left + rect.width).toBeCloseTo(anchor.right, 6);
            // 下边缘贴在输入框顶部上方，预留间距
            expect(rect.top + PIP_HEIGHT).toBeCloseTo(anchor.top - ANCHOR_GAP, 6);
            pip.destroy();
        });

        test('converts the anchor rect into container-local coordinates', () => {
            const anchor = { top: 560, right: 740, width: 640 };
            const { pip } = createPip({ left: 40, top: 60, width: 800, height: 600 }, anchor);

            pip.show();
            const rect = pipRect(pip);

            expect(rect.left).toBeCloseTo(740 - 40 - PIP_WIDTH, 6);
            expect(rect.top).toBeCloseTo(560 - 60 - PIP_HEIGHT - ANCHOR_GAP, 6);
            pip.destroy();
        });

        test('falls back to the container bottom-right corner when no anchor is available', () => {
            const { pip } = createPip({ left: 0, top: 0, width: 800, height: 600 }, null);

            pip.show();
            const rect = pipRect(pip);

            expect(rect.left).toBeCloseTo(800 - PIP_WIDTH - 8, 6);
            expect(rect.top).toBeCloseTo(600 - PIP_HEIGHT - 8, 6);
            pip.destroy();
        });

        test('recomputes the default position on every show', () => {
            let anchor = { top: 500, right: 700, width: 640 };
            const { pip } = createPip({ left: 0, top: 0, width: 800, height: 600 }, null);
            // 覆盖回调以在两次 show 之间改变锚点位置
            pip._callbacks = { ...pip._callbacks, getAnchorRect: () => anchor };

            pip.show();
            const first = pipRect(pip);

            pip.hide();
            anchor = { top: 460, right: 660, width: 600 };
            pip.show();
            const second = pipRect(pip);

            expect(first.left + first.width).toBeCloseTo(700, 6);
            expect(second.left + second.width).toBeCloseTo(660, 6);
            expect(second.top + PIP_HEIGHT).toBeCloseTo(460 - ANCHOR_GAP, 6);
            pip.destroy();
        });
    });

    describe('stable frame size', () => {
        test('keeps the screenshot box at the fixed 16:9 height regardless of the image', () => {
            const { pip } = createPip({ left: 0, top: 0, width: 800, height: 600 }, null);

            // 无截图、有截图都不改变浮窗尺寸：高度只由宽度决定
            expect(pip._imgWrapEl.style.height).toBe(`${PIP_IMG_HEIGHT}px`);
            expect(pip._totalHeight()).toBe(PIP_HEIGHT);

            pip.show();
            pip._imgEl.src = 'data:image/png;base64,AAAA';

            expect(pip._imgWrapEl.style.height).toBe(`${PIP_IMG_HEIGHT}px`);
            pip.destroy();
        });

        test('recomputes the fixed box height when resized', () => {
            const { pip } = createPip({ left: 0, top: 0, width: 800, height: 600 }, null);

            pip._width = 400;
            pip._applySize();

            expect(pip._imgWrapEl.style.height).toBe('225px');
            expect(pip._el.style.width).toBe('400px');
            pip.destroy();
        });
    });

    describe('first frame timing', () => {
        test('does not capture while the viewport is still switching', () => {
            jest.useFakeTimers();
            try {
                let captures = 0;
                const { pip } = createPip(
                    { left: 0, top: 0, width: 800, height: 600 },
                    { top: 500, right: 700, width: 640 },
                    {
                        capturePage: async () => {
                            captures += 1;
                            return null;
                        }
                    }
                );

                pip.show();
                // show() 会先把视口切成固定 16:9，立刻截图会拿到切换前的窄高画面
                expect(captures).toBe(0);

                jest.advanceTimersByTime(250);
                expect(captures).toBe(1);

                pip.destroy();
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
