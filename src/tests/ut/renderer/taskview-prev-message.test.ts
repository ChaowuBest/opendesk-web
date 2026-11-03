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

    function createUserMessage(messageId: string, text: string) {
        return {
            role: 'user',
            message_id: messageId,
            content: [{ type: 'text', text, rendered: text }],
            timestamp: new Date().toISOString()
        };
    }

    test('compact progress is temporary and success is anchored once in history', () => {
        const taskView = document.createElement('task-view') as any;
        const history = document.createElement('div');
        history.innerHTML = '<div id="user-msg-kept" class="od-user-msg-container">kept</div>';
        taskView.appendChild(history);
        taskView.getHistoryContainer = () => history;
        taskView.tryScrollToEnd = jest.fn();
        taskView._historyMessages = [createUserMessage('kept', 'kept')];
        taskView._historyRenderStartIndex = 0;
        taskView.handleCompactProgress({ phase: 'start' });
        taskView.handleCompactProgress({ phase: 'start' });
        expect(history.querySelectorAll('.od-compact-progress')).toHaveLength(1);
        expect(history.querySelector('[role="progressbar"]')).toBeNull();
        const completed = {
            phase: 'end',
            compacted: true,
            before_message_id: 'kept',
            boundary: { role: 'compact_separator', message_id: 'boundary', trigger: 'auto' }
        };
        taskView.handleCompactProgress(completed);
        taskView.handleCompactProgress(completed);
        expect(history.querySelector('.od-compact-progress')).toBeNull();
        expect(history.querySelectorAll('.od-compact-boundary')).toHaveLength(1);
        expect(history.firstElementChild?.classList.contains('od-compact-boundary')).toBe(true);
        expect(taskView._historyMessages.map((message: any) => message.message_id)).toEqual(['boundary', 'kept']);
        taskView.handleCompactProgress({ phase: 'start' });
        taskView.handleCompactProgress({ phase: 'end', compacted: false });
        expect(history.querySelector('.od-compact-progress')).toBeNull();
        expect(history.querySelectorAll('.od-compact-boundary')).toHaveLength(1);
    });

    test.each(['text', 'reasoning', 'tool_call'])(
        'compact boundary targets a %s part and survives replacement and streaming updates',
        (type) => {
            const taskView = document.createElement('task-view') as any;
            const history = document.createElement('div');
            taskView.appendChild(history);
            taskView.getHistoryContainer = () => history;
            const boundary = {
                role: 'compact_separator',
                message_id: 'boundary',
                trigger: 'auto',
                kept_anchor_message_id: 'assistant',
                kept_anchor_start_part_index: 1
            };
            const assistant = {
                role: 'assistant',
                message_id: 'assistant',
                content: [
                    { type: 'text', rendered: 'before' },
                    { type, rendered: 'after', toolcalls: [] }
                ]
            };
            taskView._historyMessages = [boundary, createUserMessage('user', 'request'), assistant];
            history.innerHTML = taskView._renderHistoryRangeToHtml(0, 3);
            const content = history.querySelector('#message-content-assistant')!;
            expect(history.querySelectorAll('.od-compact-boundary')).toHaveLength(1);
            expect(
                content
                    .querySelector('.od-compact-boundary')
                    ?.nextElementSibling?.getAttribute('data-output-part-index')
            ).toBe('1');
            expect(content.querySelector('[data-output-part-index="1"]')?.textContent).toContain('after');
            // Same placement path used after message replacement / new streaming parts.
            content.innerHTML = taskView._renderAssistantOutputHtml(assistant.content, { messageId: 'assistant' });
            taskView._placeAssistantCompactBoundary('assistant', content);
            taskView._placeAssistantCompactBoundary('assistant', content);
            expect(content.querySelectorAll('.od-compact-boundary')).toHaveLength(1);
            expect(
                content
                    .querySelector('.od-compact-boundary')
                    ?.nextElementSibling?.getAttribute('data-output-part-index')
            ).toBe('1');
        }
    );

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

    test('快速定位可跳转到尚未渲染的最早消息，并解除底部跟随', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'navigation-history';
        taskView.render();
        taskView.setUpEventListeners();
        const messages = Array.from({ length: 60 }, (_, i) => createUserMessage(`u${i}`, `Question ${i}`));
        taskView._renderInitialHistoryWindow(messages);
        const history = taskView.getHistoryContainer();
        history.scrollTop = 800;
        history.scrollTo = jest.fn();
        const readScrollHeight = jest.fn(() => 60000);
        Object.defineProperty(history, 'scrollHeight', { get: readScrollHeight, configurable: true });
        Object.defineProperty(history, 'clientHeight', { value: 500, configurable: true });
        expect(history.querySelector('#user-msg-u0')).toBeNull();
        expect(taskView._getConversationStops()).toHaveLength(60);
        taskView.setAutoScrollingToBottom(true);
        taskView._navigateConversation('u0');
        expect(history.querySelector('#user-msg-u0')).not.toBeNull();
        expect(history.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }));
        expect(readScrollHeight).toHaveBeenCalledTimes(1);
        expect(taskView.auto_scrolling_to_bottom).toBe(false);
        Object.defineProperty(history, 'scrollHeight', { value: 1000, configurable: true });
        Object.defineProperty(history, 'clientHeight', { value: 500, configurable: true });
        history.scrollTop = 490;
        history.dispatchEvent(new window.Event('scroll'));
        expect(taskView.auto_scrolling_to_bottom).toBe(false);
        history.dispatchEvent(new window.Event('scrollend'));
        history.dispatchEvent(new window.Event('scroll'));
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        taskView._chatNavigation.destroy();
    });

    test('conversation find loads old history, holds scrolling detached, and closes in place on task switch', () => {
        Object.assign(globalThis, { CSS: { escape: (value: string) => value } });
        const taskView = document.createElement('task-view') as any;
        try {
            taskView.task_id = 'find-history';
            taskView.render();
            taskView.setUpEventListeners();
            const messages = Array.from({ length: 60 }, (_, i) => createUserMessage(`u${i}`, `Question ${i}`));
            taskView._renderInitialHistoryWindow(messages);
            const history = taskView.getHistoryContainer();
            expect(history.querySelector('#user-msg-u0')).toBeNull();
            taskView.setAutoScrollingToBottom(true);
            taskView.openChatFind();
            const search = taskView.querySelector('.od-chat-find input');
            search.value = 'Question 0';
            search.dispatchEvent(new window.Event('input'));
            search.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Enter' }));
            expect(history.querySelector('#user-msg-u0')).not.toBeNull();
            expect(taskView.auto_scrolling_to_bottom).toBe(false);
            Object.defineProperty(history, 'scrollHeight', { value: 1000, configurable: true });
            Object.defineProperty(history, 'clientHeight', { value: 500, configurable: true });
            history.scrollTop = 499;
            history.dispatchEvent(new window.Event('scroll'));
            expect(taskView.auto_scrolling_to_bottom).toBe(false);
            history.scrollTop = 321;
            taskView.markViewHidden();
            expect(taskView._chatFind.visible).toBe(false);
            expect(history.scrollTop).toBe(321);
            taskView.markViewShown();
            expect(taskView._chatFind.visible).toBe(false);
            taskView.openChatFind();
            taskView.tryScrollToEnd = jest.fn();
            taskView.querySelector('#taskview-scroll-to-bottom-button').click();
            expect(taskView._chatFind.visible).toBe(false);
            expect(taskView.auto_scrolling_to_bottom).toBe(true);
        } finally {
            taskView._chatFind?.destroy();
            taskView._chatNavigation?.destroy();
            taskView._poolSegObserver?.disconnect();
            taskView._domSanitizer?.disconnect();
            document.removeEventListener('keydown', taskView._historyScrollKeydownHandler);
        }
    });

    test('重复点击已到达的位置不等待不会发生的 scrollend；无效目标不改变跟随状态', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'navigation-noop';
        taskView.render();
        taskView._renderInitialHistoryWindow([createUserMessage('u1', 'Question')]);
        const history = taskView.getHistoryContainer();
        history.scrollTop = 500;
        history.scrollTo = jest.fn();
        Object.defineProperty(history, 'scrollHeight', { value: 1000, configurable: true });
        Object.defineProperty(history, 'clientHeight', { value: 500, configurable: true });
        history.getBoundingClientRect = () => ({ top: 0 });
        history.querySelector('#user-msg-u1').getBoundingClientRect = () => ({ top: 80 });
        taskView._navigateConversation('u1');
        expect(history.scrollTo).not.toHaveBeenCalled();
        expect(taskView._conversationJumpInProgress).toBe(false);
        taskView.setAutoScrollingToBottom(true);
        taskView._navigateConversation('missing');
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

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
