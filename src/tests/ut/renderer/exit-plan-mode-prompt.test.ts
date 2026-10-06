import { describe, expect, jest, test, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { parseHTML } from 'linkedom';

type ExitPlanModeRequestData = {
    planContent: string;
    planFilePath: string;
};

type ExitPlanModeRequestCallback = (requestId: string, data: ExitPlanModeRequestData) => void;

describe('exit-plan-mode-prompt component', () => {
    const requestCallbacks = new Set<ExitPlanModeRequestCallback>();
    let respondExitPlanMode: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });

        await import('../../../renderer/components/exitPlanModePrompt');
    });

    beforeEach(() => {
        requestCallbacks.clear();
        respondExitPlanMode = jest.fn();
        document.body.innerHTML = '';
        window.exitPlanModeAPI = {
            onExitPlanModeRequest: (callback: ExitPlanModeRequestCallback) => {
                requestCallbacks.add(callback);
            },
            offExitPlanModeRequest: (callback: ExitPlanModeRequestCallback) => {
                requestCallbacks.delete(callback);
            },
            onExitPlanModeDismiss: () => undefined,
            offExitPlanModeDismiss: () => undefined,
            respondExitPlanMode,
            getPendingRequest: async () => null
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('standard mode button responds with execute-standard action', () => {
        const prompt = document.createElement('exit-plan-mode-prompt');
        prompt.id = 'task-parent-exit-plan';
        document.body.appendChild(prompt);

        for (const callback of requestCallbacks) {
            callback('plan-1', { planContent: '# 计划', planFilePath: '/tmp/plan.md' });
        }

        const btn = prompt.querySelector<HTMLButtonElement>('#exit-plan-btn-standard');
        expect(btn).not.toBeNull();
        btn!.click();

        expect(respondExitPlanMode).toHaveBeenCalledWith('plan-1', { action: 'execute-standard' });
    });

    test('renders theme tokens instead of light-only palette classes so dark mode adapts', () => {
        const prompt = document.createElement('exit-plan-mode-prompt');
        prompt.id = 'task-parent-exit-plan';
        document.body.appendChild(prompt);

        for (const callback of requestCallbacks) {
            callback('plan-1', { planContent: '# 计划', planFilePath: '/tmp/plan.md' });
        }

        const html = prompt.innerHTML;
        // 深浅色自适应依赖 html[data-theme] 切换的语义 token（theme.css）；
        // 硬编码 Tailwind 浅色类在深色模式下无法跟随主题，禁止回归。
        const palette = /(?:bg|text|border|ring|from)-(?:gray|slate|blue|amber|emerald|red|purple|green)-\d/;
        expect(palette.test(html)).toBe(false);
        expect(html).not.toContain('bg-white');
        expect(html).not.toContain('to-white');
        expect(html).toContain('var(--chat-');
        expect(html).toContain('var(--od-');
    });
});
