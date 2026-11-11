import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

/**
 * 编辑已存在的用户消息时，消息下方菜单不应再出现"复制/编辑"等动作，
 * 而应换成一个常驻高亮（不随鼠标移出折叠）的"发送并重新执行"按钮，
 * 其点击行为与编辑态下敲回车完全一致。
 */
describe('task-view user message edit menu', () => {
    let TaskViewClass: any;
    let windowRef: any;
    let confirmMock: jest.Mock;
    let rewindMock: jest.Mock;
    let notifyMock: jest.Mock;

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        windowRef = window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            // linkedom 未实现 CSS.escape，消息查询选择器依赖它
            CSS: { escape: (value: string) => value },
            sessionStorage: { getItem: () => null, removeItem: () => undefined },
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
        // linkedom 的 textarea 没有选区 API，编辑态会调用它把光标放到末尾
        (window.HTMLTextAreaElement.prototype as any).setSelectionRange = () => undefined;

        confirmMock = jest.fn(async () => true);
        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({ showConfirmModal: confirmMock })
        );
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

        customElements.define('agent-input', class extends HTMLElement {});
        customElements.define('message-queue-panel', class extends HTMLElement {});

        await import('../../../renderer/components/taskview.js');
        TaskViewClass = customElements.get('task-view');
    });

    beforeEach(() => {
        confirmMock.mockClear();
        notifyMock = jest.fn();
        rewindMock = jest.fn(async () => undefined);
        (windowRef as any).taskManagerAPI = { rewindToUserMessage: rewindMock };
        (windowRef as any).notificationAPI = { sendNotification: notifyMock };
    });

    /** 渲染一条带 meta row（含 hover 菜单）的用户消息，返回容器。 */
    function renderUserMessageInto(taskView: any, messageId = 'u1', text = '原始内容') {
        const holder = document.createElement('div');
        holder.innerHTML = taskView.renderUserMessage({
            role: 'user',
            message_id: messageId,
            timestamp: 1700000000000,
            rawText: text,
            content: [{ type: 'text', text, rendered: text }]
        });
        taskView.appendChild(holder);
        return holder.querySelector(`#user-msg-${messageId}`) as HTMLElement;
    }

    function createTaskView() {
        const taskView: any = new TaskViewClass();
        taskView.task_id = 'task-edit-menu';
        taskView.reload = jest.fn(async () => undefined);
        return taskView;
    }

    /** 模拟用户输入：写值并触发 input，让"发送并重新执行"的 disabled 状态同步。 */
    function typeInto(textarea: HTMLTextAreaElement, value: string) {
        textarea.value = value;
        textarea.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
    }

    test('编辑态菜单只保留常驻高亮的"发送并重新执行"，点击行为等同回车', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView);

        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        expect(menu.querySelector('[data-action="copy"]')).not.toBeNull();

        taskView._handleEditUserMessage('u1');

        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(true);
        expect(menu.querySelectorAll('.od-msg-action-btn')).toHaveLength(1);
        expect(menu.querySelector('[data-action="copy"]')).toBeNull();
        expect(menu.querySelector('[data-action="edit"]')).toBeNull();

        const sendAgainBtn = menu.querySelector('.od-msg-action-btn--send-again') as HTMLElement;
        expect(sendAgainBtn).not.toBeNull();
        expect(sendAgainBtn.querySelector('.od-msg-action-label')?.textContent).toBe('发送并重新执行');
        // 图标与"发送并重新执行"一致（paper-plane 路径）
        expect(sendAgainBtn.querySelector('svg path')?.getAttribute('d')).toBe('m22 2-7 20-4-9-9-4Z');
        expect(container.querySelector('.od-user-msg')?.classList.contains('od-user-msg-editing')).toBe(true);

        await flush();

        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;
        typeInto(textarea, '改后的内容');
        expect((sendAgainBtn as HTMLButtonElement).disabled).toBe(false);

        // 真实交互：先 mousedown 再 click，mousedown 不能把编辑态提前撤掉
        sendAgainBtn.dispatchEvent(new windowRef.Event('mousedown', { bubbles: true }));
        expect(container.querySelector('.od-user-msg-editor')).not.toBeNull();

        sendAgainBtn.dispatchEvent(new windowRef.Event('click', { bubbles: true }));
        await flush();

        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(rewindMock).toHaveBeenCalledWith('task-edit-menu', 'u1', {
            resubmit: true,
            overrideMessageText: '改后的内容'
        });
        expect(taskView.reload).toHaveBeenCalledTimes(1);

        // 提交后退出编辑态，原菜单恢复
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(false);
        expect(menu.querySelector('[data-action="copy"]')).not.toBeNull();
        expect(menu.querySelector('[data-action="edit"]')).not.toBeNull();
        expect(container.querySelector('.od-user-msg')?.classList.contains('od-user-msg-editing')).toBe(false);
    });

    test('正文未改动（含清空）时"发送并重新执行"禁用，改动后启用', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u4');
        taskView._handleEditUserMessage('u4');
        await flush();

        const sendAgainBtn = container.querySelector('.od-msg-action-btn--send-again') as HTMLButtonElement;
        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;

        // 进入编辑态时内容与原文一致 → 禁用
        expect(sendAgainBtn.disabled).toBe(true);

        typeInto(textarea, '改了一点');
        expect(sendAgainBtn.disabled).toBe(false);

        // 改回原文 → 重新禁用
        typeInto(textarea, '原始内容');
        expect(sendAgainBtn.disabled).toBe(true);

        // 清空 → 仍然禁用（空内容不可提交）
        typeInto(textarea, '   ');
        expect(sendAgainBtn.disabled).toBe(true);
    });

    test('禁用态下点击不会发出请求，也不退出编辑态', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u5');
        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        taskView._handleEditUserMessage('u5');
        await flush();

        const sendAgainBtn = menu.querySelector('.od-msg-action-btn--send-again') as HTMLButtonElement;
        expect(sendAgainBtn.disabled).toBe(true);
        // linkedom 的 dispatchEvent 绕过 disabled 的点击抑制，这里验证"即使收到 click 也不提交"
        sendAgainBtn.dispatchEvent(new windowRef.Event('click', { bubbles: true }));
        await flush();

        expect(confirmMock).not.toHaveBeenCalled();
        expect(rewindMock).not.toHaveBeenCalled();
        expect(container.querySelector('.od-user-msg-editor')).not.toBeNull();
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(true);
    });

    test('确认框取消后保持编辑态与"发送并重新执行"按钮', async () => {
        confirmMock.mockResolvedValueOnce(false);
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u3');
        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        taskView._handleEditUserMessage('u3');
        await flush();

        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;
        typeInto(textarea, '取消的内容');
        (menu.querySelector('.od-msg-action-btn--send-again') as HTMLElement).dispatchEvent(
            new windowRef.Event('click', { bubbles: true })
        );
        await flush();

        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(rewindMock).not.toHaveBeenCalled();
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(true);
        expect(container.querySelector('.od-user-msg-editor')).not.toBeNull();
        expect(textarea.value).toBe('取消的内容');
    });

    test('回车提交与"发送并重新执行"走同一条路径', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView);
        taskView._handleEditUserMessage('u1');
        await flush();

        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;
        typeInto(textarea, '回车改的内容');
        const enterEvent: any = new windowRef.Event('keydown', { bubbles: true, cancelable: true });
        enterEvent.key = 'Enter';
        enterEvent.shiftKey = false;
        enterEvent.isComposing = false;
        textarea.dispatchEvent(enterEvent);
        await flush();

        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(rewindMock).toHaveBeenCalledWith('task-edit-menu', 'u1', {
            resubmit: true,
            overrideMessageText: '回车改的内容'
        });
    });

    test('Esc 与点击外部退出编辑态并恢复原菜单', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u2');
        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        taskView._handleEditUserMessage('u2');
        await flush();

        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(true);
        const escapeEvent: any = new windowRef.Event('keydown', { bubbles: true, cancelable: true });
        escapeEvent.key = 'Escape';
        (container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement).dispatchEvent(escapeEvent);

        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(false);
        expect(menu.querySelector('.od-msg-action-btn--send-again')).toBeNull();
        expect(menu.querySelector('[data-action="copy"]')).not.toBeNull();
        expect(container.querySelector('.od-user-msg-editor')).toBeNull();

        // 再次进入编辑态后点击外部
        taskView._handleEditUserMessage('u2');
        await flush();
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(true);

        document.dispatchEvent(new windowRef.Event('mousedown', { bubbles: true }));
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(false);
        expect(container.querySelector('.od-user-msg-editor')).toBeNull();
        expect(confirmMock).not.toHaveBeenCalled();
    });

    test('编辑态右键不再叠加消息菜单，让编辑框自身的编辑菜单生效', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u6');
        taskView.addEventListener('contextmenu', (e: any) => taskView._handleChatHistoryContextMenu(e));
        taskView._handleEditUserMessage('u6');
        await flush();

        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;
        const ev: any = new windowRef.Event('contextmenu', { bubbles: true, cancelable: true });
        textarea.dispatchEvent(ev);

        // 不 preventDefault、不弹消息菜单：事件继续交给注入脚本的编辑菜单
        expect(ev.defaultPrevented).toBe(false);
        expect(document.getElementById('od-user-msg-ctx')).toBeNull();
    });

    test('重复进入编辑态被忽略，退出后正文与菜单完好', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u7');
        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        taskView._handleEditUserMessage('u7');
        await flush();

        // 第二次进入（历史路径：右键菜单的"编辑"项）
        taskView._handleEditUserMessage('u7');
        await flush();

        document.dispatchEvent(new windowRef.Event('mousedown', { bubbles: true }));
        await flush();

        expect(container.querySelector('.od-user-msg-editor')).toBeNull();
        expect(container.querySelector('.od-user-msg')?.textContent).toContain('原始内容');
        expect(menu.classList.contains('od-msg-hover-menu--pinned')).toBe(false);
        expect(menu.querySelector('[data-action="edit"]')).not.toBeNull();
        expect(menu.querySelector('[data-action="resend"]')).not.toBeNull();
    });

    test('rewind 失败时提示错误并还原正文', async () => {
        rewindMock.mockRejectedValueOnce(new Error('boom'));
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u8');
        taskView._handleEditUserMessage('u8');
        await flush();

        const textarea = container.querySelector('.od-user-msg-editor') as HTMLTextAreaElement;
        typeInto(textarea, '会失败的改动');
        const ev: any = new windowRef.Event('keydown', { bubbles: true, cancelable: true });
        ev.key = 'Enter';
        ev.shiftKey = false;
        ev.isComposing = false;
        textarea.dispatchEvent(ev);
        await flush();

        expect(notifyMock).toHaveBeenCalledTimes(1);
        expect(notifyMock.mock.calls[0][0]).toBe('error');
        expect(taskView.reload).not.toHaveBeenCalled();
        expect(container.querySelector('.od-user-msg-editor')).toBeNull();
        expect(container.querySelector('.od-user-msg')?.textContent).toContain('原始内容');
    });

    test('hover 菜单里 resubmit 与 resend 是两条不同文案', () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView);
        const menu = container.querySelector('.od-msg-hover-menu') as HTMLElement;
        const labelOf = (action: string) =>
            menu.querySelector(`[data-action="${action}"] .od-msg-action-label`)?.textContent;

        // 两者行为相反（截断重跑 / 末尾追加），文案不能撞车
        expect(labelOf('resubmit')).toBe('发送并重新执行');
        expect(labelOf('resend')).toBe('再次发送');
    });

    test('原文带首尾空白时，进入编辑态仍判定为未改动', async () => {
        const taskView = createTaskView();
        const container = renderUserMessageInto(taskView, 'u9', ' 缩进开头的消息  ');
        taskView._handleEditUserMessage('u9');
        await flush();

        // 一字未改，按钮必须保持禁用，否则点一下就截断后续对话重跑
        const sendAgainBtn = container.querySelector('.od-msg-action-btn--send-again') as HTMLButtonElement;
        expect(sendAgainBtn.disabled).toBe(true);
    });
});
