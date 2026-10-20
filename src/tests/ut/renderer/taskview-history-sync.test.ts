import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
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

/**
 * 任务执行完成后立即复制 / 导出，必须能拿到刚结束的消息内容。
 *
 * 回归背景：流式期间通过 progress 到达的新消息只更新 DOM 与
 * _assistantPartsByMessage 缓存，从不并入 _historyMessages；而
 * 复制按钮与 HTML 导出都以 _historyMessages 为数据源，导致
 * 任务一结束就复制不到内容、导出 HTML 缺少整轮对话。
 * 重启后 reload() 从磁盘拉全量才恢复正常。
 */
describe('task-view streaming history sync (copy/export source)', () => {
    let receive: (progress: Record<string, unknown>) => void;
    let view: any;
    let writeText: ReturnType<typeof jest.fn>;

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
            CSS: {
                escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
            },
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
            untrackPreviewerContainers: jest.fn()
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
                return 'history-sync-sub';
            }),
            unsubscribeTaskUpdate: jest.fn(async () => undefined)
        };
        view = document.createElement('task-view') as any;
        view.setAttribute('task_id', 'history-sync-task');
        view.setAttribute('embedded', '');
        document.body.appendChild(view);
        for (let i = 0; i < 10 && !receive; i++) await Promise.resolve();

        writeText = jest.fn(async () => undefined);
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN', clipboard: { writeText } },
            configurable: true
        });
    });

    afterEach(() => {
        view?.remove();
        restoreRealTimerGlobals();
    });

    const textPart = (text: string) => ({
        type: 'text',
        text,
        rendered: `<p>${text}</p>`
    });

    test('assistant streaming frames sync the message into _historyMessages', () => {
        receive({
            type: 'assistant',
            task_status: 'running',
            message_id: 'stream-msg',
            last_part_index: 0,
            last_part: textPart('流式回复'),
            streaming: true
        });
        view._assistantProgressBuffer.flush();

        const message = view._historyMessages.find((m: any) => m.message_id === 'stream-msg');
        expect(message).toBeDefined();
        expect(message.role).toBe('assistant');
        expect(message.content[0].text).toBe('流式回复');
    });

    test('terminal assistant_replace syncs the final full message into _historyMessages', () => {
        receive({
            type: 'assistant_replace',
            task_status: 'stopped',
            message_id: 'final-msg',
            parts: [textPart('最终回复')],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        });

        const message = view._historyMessages.find((m: any) => m.message_id === 'final-msg');
        expect(message).toBeDefined();
        expect(message.role).toBe('assistant');
        expect(message.content[0].text).toBe('最终回复');
        expect(message.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    });

    test('user progress syncs the user message into _historyMessages', () => {
        receive({
            type: 'user',
            task_status: 'running',
            message_id: 'user-msg',
            last_part_index: 0,
            last_part: textPart('测试问题'),
            isLastPart: true,
            rawText: '测试问题',
            timestamp: 1792408932354
        });

        const message = view._historyMessages.find((m: any) => m.message_id === 'user-msg');
        expect(message).toBeDefined();
        expect(message.role).toBe('user');
        expect(message.content[0].text).toBe('测试问题');
        expect(message.rawText).toBe('测试问题');
    });

    test('copying an assistant message right after task completion writes the final text', async () => {
        receive({
            type: 'user',
            task_status: 'running',
            message_id: 'copy-user',
            last_part_index: 0,
            last_part: textPart('问题'),
            isLastPart: true,
            rawText: '问题',
            timestamp: 1792408932354
        });
        receive({
            type: 'assistant_replace',
            task_status: 'stopped',
            message_id: 'copy-assistant',
            parts: [textPart('最终回复内容')]
        });

        await view._handleCopyMessage('copy-assistant');
        expect(writeText).toHaveBeenCalledWith('最终回复内容');
    });

    test('exported HTML includes the turn that just finished', () => {
        receive({
            type: 'user',
            task_status: 'running',
            message_id: 'export-user',
            last_part_index: 0,
            last_part: textPart('导出测试问题'),
            isLastPart: true,
            rawText: '导出测试问题',
            timestamp: 1792408932354
        });
        receive({
            type: 'assistant_replace',
            task_status: 'stopped',
            message_id: 'export-assistant',
            parts: [textPart('导出测试回复')]
        });

        const html = view._renderFullHistoryForExport().join('');
        expect(html).toContain('导出测试问题');
        expect(html).toContain('导出测试回复');
    });

    test('copy falls back to the streaming parts cache when history lacks the message', async () => {
        // 消息仅在流式缓存中（历史里没有）也要能复制出原始 markdown
        view._assistantPartsByMessage.set('cache-only', [textPart('缓存中的回复')]);

        await view._handleCopyMessage('cache-only');
        expect(writeText).toHaveBeenCalledWith('缓存中的回复');
    });

    test('copy DOM fallback finds markdown blocks nested in the output flow wrapper', async () => {
        // DOM 兜底：内容包裹在 .od-assistant-output-flow 内（非 message-content 直接子元素）
        view._historyMessages = [];
        view._assistantPartsByMessage.delete('dom-only');
        view.getHistoryContainer().innerHTML =
            '<div id="message-content-dom-only">' +
            '<div class="od-assistant-output-flow"><div class="od-final-result markdown-body">DOM 兜底回复</div></div>' +
            '</div>';

        await view._handleCopyMessage('dom-only');
        expect(writeText).toHaveBeenCalledWith('DOM 兜底回复');
    });
});
