import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('task-view _scrollToUserMessage with lazy-loaded history', () => {
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
            renderMermaidBlocks: jest.fn()
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

    function createUserMessage(messageId: string, text: string) {
        return {
            role: 'user',
            message_id: messageId,
            content: [{ type: 'text', text, rendered: text }],
            timestamp: new Date().toISOString()
        };
    }

    function createUserMessageHtml(messageId: string, text: string): string {
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<div id="user-msg-${messageId}" class="od-user-msg-container" data-message-id="${messageId}">
            <div class="od-user-msg">${escaped}</div>
        </div>`;
    }

    function mockRects(
        container: HTMLElement,
        containerTop: number,
        containerBottom: number,
        userMessageTops: number[]
    ) {
        jest.spyOn(container, 'getBoundingClientRect').mockReturnValue({
            top: containerTop,
            bottom: containerBottom,
            left: 0,
            right: 100,
            width: 100,
            height: containerBottom - containerTop,
            x: 0,
            y: containerTop,
            toJSON: () => ({})
        } as DOMRect);

        const userMessages = Array.from(container.querySelectorAll('.od-user-msg-container'));
        for (let i = 0; i < userMessages.length && i < userMessageTops.length; i++) {
            const top = userMessageTops[i];
            jest.spyOn(userMessages[i] as HTMLElement, 'getBoundingClientRect').mockReturnValue({
                top,
                bottom: top + 50,
                left: 0,
                right: 100,
                width: 100,
                height: 50,
                x: 0,
                y: top,
                toJSON: () => ({})
            } as DOMRect);
        }
    }

    test('topmostVisibleIdx === 0 且 _hasOlderHistory 为 true 时，应触发 _loadOlderHistoryBatch', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-test-1');
        taskView.task_id = 'task-test-1';
        taskView.task_status = 'stopped';

        const allMessages = Array.from({ length: 30 }, (_, i) =>
            createUserMessage(`msg-${String(i).padStart(3, '0')}`, `消息 ${i} 的内容`)
        );

        taskView._historyMessages = allMessages;
        taskView._historyRenderStartIndex = 10;
        taskView._renderedUserParts = new Map();

        taskView.render();

        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        historyContainer.innerHTML = allMessages
            .slice(10)
            .map((m: any) => createUserMessageHtml(m.message_id, m.content[0].text))
            .join('');

        const tops = [50, ...Array.from({ length: 19 }, (_, i) => 600 + i * 50)];
        mockRects(historyContainer, 0, 500, tops);

        // linkedom 缺少 scrollTo / scrollTop / scrollHeight，需要 mock
        (historyContainer as any).scrollTo = () => {};
        (historyContainer as any).scrollTop = 0;
        (historyContainer as any).scrollHeight = 1000;

        expect(taskView._hasOlderHistory()).toBe(true);

        const loadOlderSpy = jest.spyOn(taskView, '_loadOlderHistoryBatch');

        taskView._scrollToUserMessage('prev');

        expect(loadOlderSpy).toHaveBeenCalled();

        loadOlderSpy.mockRestore();
    });

    test('无可见用户消息且所有已渲染消息在下方时，应触发 _loadOlderHistoryBatch', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-test-2');
        taskView.task_id = 'task-test-2';
        taskView.task_status = 'stopped';

        const allMessages = Array.from({ length: 30 }, (_, i) =>
            createUserMessage(`msg-${String(i).padStart(3, '0')}`, `消息 ${i} 的内容`)
        );

        taskView._historyMessages = allMessages;
        taskView._historyRenderStartIndex = 10;
        taskView._renderedUserParts = new Map();

        taskView.render();

        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        historyContainer.innerHTML = allMessages
            .slice(10)
            .map((m: any) => createUserMessageHtml(m.message_id, m.content[0].text))
            .join('');

        const tops = Array.from({ length: 20 }, (_, i) => 600 + i * 50);
        mockRects(historyContainer, 0, 500, tops);

        (historyContainer as any).scrollTo = () => {};
        (historyContainer as any).scrollTop = 0;
        (historyContainer as any).scrollHeight = 1000;

        expect(taskView._hasOlderHistory()).toBe(true);

        const loadOlderSpy = jest.spyOn(taskView, '_loadOlderHistoryBatch');

        taskView._scrollToUserMessage('prev');

        expect(loadOlderSpy).toHaveBeenCalled();

        loadOlderSpy.mockRestore();
    });

    test('target 是第一条已渲染用户消息且有未加载历史时，应触发 _loadOlderHistoryBatch', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-test-3');
        taskView.task_id = 'task-test-3';
        taskView.task_status = 'stopped';

        const allMessages = Array.from({ length: 30 }, (_, i) =>
            createUserMessage(`msg-${String(i).padStart(3, '0')}`, `消息 ${i} 的内容`)
        );

        taskView._historyMessages = allMessages;
        taskView._historyRenderStartIndex = 10;
        taskView._renderedUserParts = new Map();

        taskView.render();

        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        historyContainer.innerHTML = allMessages
            .slice(10)
            .map((m: any) => createUserMessageHtml(m.message_id, m.content[0].text))
            .join('');

        // 模拟：第二条用户消息 (userMessages[1]) 在容器上方不可见，
        // 第一条用户消息 (userMessages[0]) 在容器下方不可见，
        // 全部消息都不在可见区域内 → topmostVisibleIdx === -1
        // for 循环从后往前找，userMessages[1] 的 bottom(50) <= containerTop(100) → target = userMessages[1]
        // 但 userMessages[1] !== userMessages[0]，不会触发加载
        //
        // 我们需要模拟：target === userMessages[0]
        // 即：只有 userMessages[0] 在容器上方
        // userMessages[0].top=50, bottom=100, container.top=200
        const tops = [50, 600, 650];
        mockRects(historyContainer, 200, 700, tops);

        (historyContainer as any).scrollTo = () => {};
        (historyContainer as any).scrollTop = 0;
        (historyContainer as any).scrollHeight = 1000;

        expect(taskView._hasOlderHistory()).toBe(true);

        const loadOlderSpy = jest.spyOn(taskView, '_loadOlderHistoryBatch');

        taskView._scrollToUserMessage('prev');

        // for 循环找到 userMessages[0]（只有它在容器上方）
        // target === userMessages[0] && _hasOlderHistory() → 应触发加载
        expect(loadOlderSpy).toHaveBeenCalled();

        loadOlderSpy.mockRestore();
    });
});
