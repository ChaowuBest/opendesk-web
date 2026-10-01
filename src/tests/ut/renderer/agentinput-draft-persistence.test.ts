import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 任务输入草稿持久化的集成回归：
 * - 输入停顿后防抖落盘（taskId 已设置时）
 * - 重新创建控件并设置 taskId 后草稿恢复，且不覆盖已有输入
 * - 控件断连（后台释放/销毁）时立即冲刷，不等待防抖
 * - _clearPersistedDraft 同步清除持久化记录（发送/入队路径调用）
 */

class FakeStorage {
    private map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
}

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

describe('agent-input 草稿持久化', () => {
    let storage: FakeStorage;

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
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        // linkedom 未实现 textarea.setSelectionRange，而 attachFilePaths → render 会调用它
        Object.defineProperty(window.HTMLTextAreaElement.prototype, 'setSelectionRange', {
            value: function () {},
            configurable: true
        });
        Object.defineProperty(globalThis, 'localStorage', {
            value: new FakeStorage(),
            writable: true,
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return { available: async () => false };
                }
            }
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        storage = new FakeStorage();
        Object.defineProperty(globalThis, 'localStorage', {
            value: storage,
            writable: true,
            configurable: true
        });
        document.body.innerHTML = '';
        jest.useFakeTimers();
    });

    afterEach(() => {
        restoreRealTimerGlobals();
    });

    interface InputWithDraftApi {
        render: () => void;
        taskId: string | null;
        addImage: (dataUrl: string, name?: string) => void;
        attachFilePaths: (paths: string[]) => Promise<boolean>;
        setTaskLoading: (loading: boolean) => void;
        setDisabled: (disabled: boolean) => void;
        attachedFilePaths: string[];
        _clearPersistedDraft: () => void;
    }

    function createInput(): { input: InputWithDraftApi; textarea: HTMLTextAreaElement } {
        const input = document.createElement('agent-input') as unknown as InputWithDraftApi;
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        return { input, textarea };
    }

    test('输入停顿 500ms 后草稿落盘，新控件设置 taskId 后恢复', () => {
        const { input, textarea } = createInput();
        input.taskId = 'task-1';
        textarea.value = '帮我分析这段构建日志';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // 防抖窗口内尚未落盘
        expect(storage.getItem('opendesk:task-draft:task-1')).toBeNull();
        jest.advanceTimersByTime(500);
        expect(storage.getItem('opendesk:task-draft:task-1')).not.toBeNull();
        expect(JSON.parse(storage.getItem('opendesk:task-draft:task-1')!).text).toBe('帮我分析这段构建日志');

        // 控件销毁重建（模拟后台释放后重新打开）：草稿恢复
        const restored = createInput();
        restored.input.taskId = 'task-1';
        expect(restored.textarea.value).toBe('帮我分析这段构建日志');
    });

    test('taskId 未设置（首页输入框）不落盘', () => {
        const { textarea } = createInput();
        textarea.value = 'home draft';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(1000);
        expect(storage.getItem('opendesk:task-draft:task-1')).toBeNull();
    });

    test('恢复不覆盖已有输入', () => {
        storage.setItem('opendesk:task-draft:task-1', JSON.stringify({ text: 'persisted', images: [] }));
        const { input, textarea } = createInput();
        textarea.value = 'typed already';
        input.taskId = 'task-1';
        expect(textarea.value).toBe('typed already');
    });

    test('图片附件随草稿保存并恢复', () => {
        const { input, textarea } = createInput();
        input.taskId = 'task-1';
        textarea.value = '看这张图';
        input.addImage('data:image/png;base64,AAAA', 'shot.png');
        jest.advanceTimersByTime(500);

        const restored = createInput();
        restored.input.taskId = 'task-1';
        expect(restored.textarea.value).toBe('看这张图');
        const agentInput = restored.input as unknown as { attachedImages: Array<{ dataUrl: string; name: string }> };
        expect(agentInput.attachedImages).toEqual([{ dataUrl: 'data:image/png;base64,AAAA', name: 'shot.png' }]);
    });

    test('控件断连（后台释放）立即冲刷草稿，不等防抖', () => {
        const { input } = createInput();
        input.taskId = 'task-1';
        // 先挂载再取 textarea：connectedCallback 的异步加载完成后会重渲染替换节点
        document.body.appendChild(input as unknown as Node);
        const textarea = (input as unknown as HTMLElement).querySelector(
            '#agent-input-textarea'
        ) as HTMLTextAreaElement;
        textarea.value = 'flush on disconnect';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(storage.getItem('opendesk:task-draft:task-1')).toBeNull();

        document.body.removeChild(input as unknown as Node);
        expect(storage.getItem('opendesk:task-draft:task-1')).not.toBeNull();
        expect(JSON.parse(storage.getItem('opendesk:task-draft:task-1')!).text).toBe('flush on disconnect');
    });

    test('_clearPersistedDraft 同步移除持久化记录（发送/入队路径）', () => {
        const { input, textarea } = createInput();
        input.taskId = 'task-1';
        textarea.value = 'pending';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(500);
        expect(storage.getItem('opendesk:task-draft:task-1')).not.toBeNull();

        input._clearPersistedDraft();
        expect(storage.getItem('opendesk:task-draft:task-1')).toBeNull();

        // 清除后排队的防抖保存不会复活记录
        textarea.value = 'resurrected';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        input._clearPersistedDraft();
        jest.advanceTimersByTime(1000);
        expect(storage.getItem('opendesk:task-draft:task-1')).toBeNull();
    });

    test('文件路径随草稿保存并恢复', async () => {
        const { input, textarea } = createInput();
        input.taskId = 'task-1';
        textarea.value = '看下这个文件';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await input.attachFilePaths(['D:/proj/notes.txt']);
        jest.advanceTimersByTime(500);
        expect(JSON.parse(storage.getItem('opendesk:task-draft:task-1')!).filePaths).toEqual(['D:/proj/notes.txt']);

        // 控件销毁重建后草稿的文本与文件路径一并恢复
        const restored = createInput();
        restored.input.taskId = 'task-1';
        for (let i = 0; i < 5; i++) await Promise.resolve(); // 等待恢复路径上的异步校验完成
        expect(restored.textarea.value).toBe('看下这个文件');
        expect(restored.input.attachedFilePaths).toEqual(['D:/proj/notes.txt']);
    });

    test('输入框已有内容时整个草稿（含图片与文件）都不恢复（统一前提）', async () => {
        storage.setItem(
            'opendesk:task-draft:task-1',
            JSON.stringify({
                text: '旧草稿文本',
                images: [{ dataUrl: 'data:image/png;base64,OLD', name: 'old.png' }],
                filePaths: ['D:/proj/old.txt']
            })
        );
        const { input, textarea } = createInput();
        textarea.value = '用户已开始输入的新内容';
        input.taskId = 'task-1';
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(textarea.value).toBe('用户已开始输入的新内容');
        expect(input.attachedImages).toEqual([]);
        expect(input.attachedFilePaths).toEqual([]);
    });

    test('setTaskLoading 锁定期间输入框不可编辑，解锁后恢复', () => {
        const { input, textarea } = createInput();
        expect(textarea.disabled).toBe(false);
        input.setTaskLoading(true);
        expect(textarea.disabled).toBe(true);
        input.setTaskLoading(false);
        expect(textarea.disabled).toBe(false);
    });

    test('运行中任务（setDisabled(true)）解锁加载锁后占位恢复到正常输入提示', () => {
        const { input, textarea } = createInput();
        input.taskId = 'task-1';
        const normalPlaceholder = textarea.placeholder;
        // 模拟 taskview 对运行中任务的 setDisabled(true)：isDisabled=true，占位此前被冻结
        input.setDisabled(true);
        input.setTaskLoading(true);
        expect(textarea.placeholder).not.toBe(normalPlaceholder); // 锁定时占位已替换为加载文案
        input.setTaskLoading(false);
        // 回归：曾因 updatePlaceholder 的 isDisabled 守卫直接 return，加载文案残留
        expect(textarea.placeholder).toBe(normalPlaceholder);
        expect(textarea.disabled).toBe(false);
    });
});
