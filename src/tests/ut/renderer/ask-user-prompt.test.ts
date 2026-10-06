import { describe, expect, jest, test, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { parseHTML } from 'linkedom';

type AskUserRequestData = {
    questions: {
        question: string;
        header: string;
        options: { label: string; description: string }[];
        multiple?: boolean;
    }[];
    taskId: string;
    taskName: string | null;
};

type AskUserRequestCallback = (requestId: string, data: AskUserRequestData) => void;

describe('ask-user-prompt component', () => {
    const requestCallbacks = new Set<AskUserRequestCallback>();
    let respondAskUser: jest.Mock;

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

        await import('../../../renderer/components/askUserPrompt');
    });

    beforeEach(() => {
        requestCallbacks.clear();
        respondAskUser = jest.fn();
        document.body.innerHTML = '';
        window.askUserAPI = {
            onAskUserRequest: (callback: AskUserRequestCallback) => {
                requestCallbacks.add(callback);
            },
            offAskUserRequest: (callback: AskUserRequestCallback) => {
                requestCallbacks.delete(callback);
            },
            onAskUserDismiss: () => undefined,
            offAskUserDismiss: () => undefined,
            respondAskUser
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function buildRequest(): AskUserRequestData {
        return {
            questions: [
                {
                    question: '选择一个方案',
                    header: '方案',
                    multiple: true,
                    options: [
                        { label: '方案 A', description: 'a' },
                        { label: '方案 B', description: 'b' }
                    ]
                }
            ],
            taskId: 'task-parent',
            taskName: null
        };
    }

    test('multi-select flow responds with selected labels', () => {
        const prompt = document.createElement('ask-user-prompt');
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);

        for (const callback of requestCallbacks) {
            callback('ask-1', buildRequest());
        }

        const optionA = prompt.querySelector<HTMLButtonElement>('[data-option-index="0"]');
        expect(optionA).not.toBeNull();
        optionA!.click();

        const confirmBtn = prompt.querySelector<HTMLButtonElement>('#ask-confirm-btn');
        expect(confirmBtn).not.toBeNull();
        expect(confirmBtn!.textContent).toContain('1 项');
        confirmBtn!.click();

        expect(respondAskUser).toHaveBeenCalledWith('ask-1', {
            answers: { 0: ['方案 A'] },
            cancelled: false
        });
    });

    test('renders theme tokens instead of light-only palette classes so dark mode adapts', () => {
        const prompt = document.createElement('ask-user-prompt');
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);

        for (const callback of requestCallbacks) {
            callback('ask-1', buildRequest());
        }

        const html = prompt.innerHTML;
        // 深浅色自适应依赖 html[data-theme] 切换的语义 token（theme.css）；
        // 硬编码 Tailwind 浅色类在深色模式下无法跟随主题，禁止回归。
        const palette = /(?:bg|text|border|ring|from|placeholder)-(?:gray|slate|blue|amber|emerald|red|purple)-\d/;
        expect(palette.test(html)).toBe(false);
        expect(html).not.toContain('bg-white');
        expect(html).not.toContain('to-white');
        expect(html).toContain('var(--chat-');
        expect(html).toContain('var(--od-');
    });
});
