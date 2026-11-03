import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const realTimerGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate
};

function restoreRealTimerGlobals(): void {
    jest.useRealTimers();
    Object.assign(globalThis, realTimerGlobals);
}

describe('task-view incremental assistant_replace', () => {
    let receive: (progress: Record<string, unknown>) => void;
    let view: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            sessionStorage: {
                getItem: () => null,
                removeItem: () => undefined
            },
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

        await jest.unstable_mockModule('../../../renderer/components/toolbar.ts', () => ({
            ElasticToolbarWidget: class extends HTMLElement {
                setToolbarTitle() {}
                setToolbarSubtitle() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/taskartifacts.ts', () => ({}));
        await jest.unstable_mockModule('../../../renderer/components/browserPip.ts', () => ({
            BrowserPip: class {
                destroy() {}
                hide() {}
                isClosed() {
                    return false;
                }
                isVisible() {
                    return false;
                }
                resetClosed() {}
                show() {}
                triggerCapture() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/previewer.ts', () => ({
            enhanceCodeBlocks: jest.fn(),
            enhanceToolPreviewCards: jest.fn(),
            renderMermaidBlocks: jest.fn(),
            untrackPreviewerContainers: jest.fn(),
            prepareSearchPreviews: async () => {},
            revealSearchPreview: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define(
            'agent-input',
            class extends HTMLElement {
                availableModels: unknown[] = [];
                setDisabled() {}
                setModel() {}
                setReasoningEffort() {}
                setStopMode() {}
                setSlashCommandContext() {}
            }
        );
        customElements.define(
            'message-queue-panel',
            class extends HTMLElement {
                setCallbacks() {}
                setQueue() {}
            }
        );

        await import('../../../renderer/components/taskview.js');
    });

    beforeEach(async () => {
        receive = undefined as unknown as (progress: Record<string, unknown>) => void;
        window.taskManagerAPI = {
            getFullTask: jest.fn(async () => ({ task_status: 'running', chat_context: { messages: [] } })),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => []),
            subscribeTaskUpdate: jest.fn(async (_id: unknown, callback: typeof receive) => {
                receive = callback;
                return 'delta-sub';
            }),
            unsubscribeTaskUpdate: jest.fn(async () => undefined)
        };
        view = document.createElement('task-view') as any;
        view.setAttribute('task_id', 'delta-task');
        view.setAttribute('embedded', '');
        document.body.appendChild(view);
        for (let i = 0; i < 10 && !receive; i++) await Promise.resolve();
    });

    afterEach(() => {
        view?.remove();
        restoreRealTimerGlobals();
    });

    const fullPart = (index: number, marker = 'v1') => ({
        type: 'text',
        text: `part-${index}-${marker}`,
        rendered: `<p>part-${index}-${marker}</p>`
    });

    test('delta replace with unmodifiedTail rehydrates the omitted prefix from local cache', () => {
        // 前置：先收一次全量 replace 建立 12-part 缓存
        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'delta-message',
            parts: Array.from({ length: 12 }, (_, i) => fullPart(i))
        });
        expect(view._assistantPartsByMessage.get('delta-message')).toHaveLength(12);

        // 增量 replace：只带尾部 2 个 parts + unmodifiedTail=12
        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'delta-message',
            unmodifiedTail: 12,
            parts: [fullPart(12, 'v2'), fullPart(13, 'v2')]
        });

        // 回填后本地 parts 缓存必须是完整 14 个
        const parts = view._assistantPartsByMessage.get('delta-message');
        expect(parts).toHaveLength(14);
        expect(parts[0].text).toBe('part-0-v1');
        expect(parts[12].text).toBe('part-12-v2');
        expect(parts[13].text).toBe('part-13-v2');
    });

    test('delta replace renders the rehydrated full message', () => {
        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'delta-render',
            parts: [fullPart(0), fullPart(1)]
        });

        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'delta-render',
            unmodifiedTail: 2,
            parts: [fullPart(2, 'v2')]
        });

        // 全量渲染路径执行：消息内容包含回填的旧 parts 和新增 part
        const html = view.querySelector('#message-content-delta-render')?.innerHTML ?? '';
        expect(html).toContain('part-0-v1');
        expect(html).toContain('part-1-v1');
        expect(html).toContain('part-2-v2');
    });

    test('delta replace without any local cache falls back to tail-only rendering', () => {
        // 没有前置全量 replace（缓存为空）时不能凭空捏造前缀：
        // 按纯尾部 parts 渲染，与 unmodifiedTail 省略时行为一致。
        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'delta-nocache',
            unmodifiedTail: 5,
            parts: [fullPart(5, 'v2')]
        });

        const parts = view._assistantPartsByMessage.get('delta-nocache');
        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe('part-5-v2');
    });

    test('delta replace for a message before the rendered window updates history data', () => {
        // 隐藏历史消息路径：_applyHiddenAssistantReplaceToHistory 也要做前缀回填
        view._historyMessages = [
            {
                role: 'assistant',
                message_id: 'hidden-delta',
                content: [fullPart(0), fullPart(1), fullPart(2)]
            }
        ];
        const isBeforeWindow = jest
            .spyOn(view, '_isHistoryMessageBeforeRenderedWindow')
            .mockImplementation((messageId: string) => messageId === 'hidden-delta');

        receive({
            type: 'assistant_replace',
            task_status: 'running',
            message_id: 'hidden-delta',
            unmodifiedTail: 3,
            parts: [fullPart(3, 'v2'), fullPart(4, 'v2')]
        });

        const message = view._historyMessages.find((m: any) => m.message_id === 'hidden-delta');
        expect(message.content).toHaveLength(5);
        expect(message.content[0].text).toBe('part-0-v1');
        expect(message.content[4].text).toBe('part-4-v2');
        isBeforeWindow.mockRestore();
    });
});
