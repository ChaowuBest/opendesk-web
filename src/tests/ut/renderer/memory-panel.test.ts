import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('记忆面板交互', () => {
    let memories: Array<Record<string, unknown>>;
    let updateUserPortrait: jest.Mock;
    let updateMemory: jest.Mock;
    let cleanupMemories: jest.Mock;
    let removeMemory: jest.Mock;

    const flush = async (): Promise<void> => {
        for (let index = 0; index < 6; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html lang="zh-CN"><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLButtonElement: window.HTMLButtonElement,
            customElements: window.customElements,
            CSS: { escape: (value: string) => value }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        (window.HTMLInputElement.prototype as any).reportValidity = () => true;
        (window.HTMLTextAreaElement.prototype as any).reportValidity = () => true;
        await jest.unstable_mockModule('../../../renderer/styles/print-markdown.css?inline', () => ({ default: '' }));
        await import('../../../renderer/components/memory_panel.ts');
    });

    beforeEach(() => {
        memories = [
            {
                scope: 'workspace',
                uid: 'memory-1',
                title: '项目构建',
                content: '使用 npm run build。',
                heat: 2,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ];
        updateUserPortrait = jest.fn(async (content: string) => ({ raw: content }));
        updateMemory = jest.fn(async (uid: string, title: string, content: string) => {
            memories = memories.map((memory) =>
                memory.uid === uid ? { ...memory, title, content, updatedAt: new Date().toISOString() } : memory
            );
            return { updated: true };
        });
        cleanupMemories = jest.fn(async () => ({ removed: 0, byScope: { workspace: 0, global: 0 } }));
        removeMemory = jest.fn(async (uid: string) => {
            memories = memories.filter((memory) => memory.uid !== uid);
            return { removed: true };
        });
        (window as any).settingAPI = {
            loadSettingObject: async () => ({ locale: 'zh-CN' }),
            onSettingChanged: () => undefined
        };
        (window as any).memoryAPI = {
            getUserPortrait: async () => ({ raw: '# 用户画像\n\n- 偏好简洁回答' }),
            listMemories: async () => memories,
            updateUserPortrait,
            updateMemory,
            removeMemory,
            cleanupMemories
        };
        document.body.replaceChildren();
    });

    test('下划线 Tab 切换，并可编辑保存用户画像', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        expect(root.querySelector('.tabs')).not.toBeNull();
        expect(root.querySelector('[data-tab="portrait"]')?.getAttribute('aria-selected')).toBe('true');
        expect(root.innerHTML).toContain('偏好简洁回答');

        (root.querySelector('[data-action="edit-portrait"]') as HTMLButtonElement).click();
        await flush();
        const editor = root.querySelector('#portrait-editor') as HTMLTextAreaElement;
        editor.value = '# 用户画像\n\n- 偏好结构化回答';
        (root.querySelector('[data-action="save-portrait"]') as HTMLButtonElement).click();
        await flush();

        expect(updateUserPortrait).toHaveBeenCalledWith('# 用户画像\n\n- 偏好结构化回答');
        expect(root.innerHTML).toContain('用户画像已保存');
    });

    test('记忆以时间线分组展示，点击卡片展开后可编辑和手动清理', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        (root.querySelector('[data-tab="facts"]') as HTMLButtonElement).click();
        await flush();
        expect(root.innerHTML).toContain('本周');
        expect(root.querySelectorAll('.tl-card')).toHaveLength(1);

        // 点击时间线卡片展开
        (root.querySelector('.tl-card[data-uid="memory-1"]') as HTMLElement).click();
        await flush();
        expect(root.querySelector('.expand-card')).not.toBeNull();

        // 点击展开卡内的编辑按钮进入编辑态
        (root.querySelector('[data-action="edit-memory"]') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('#memory-title-memory-1') as HTMLInputElement).value = '新项目构建';
        (root.querySelector('#memory-content-memory-1') as HTMLTextAreaElement).value = '使用 npm run build-cli。';
        (root.querySelector('[data-action="save-memory"]') as HTMLButtonElement).click();
        await flush();
        expect(updateMemory).toHaveBeenCalledWith('memory-1', '新项目构建', '使用 npm run build-cli。');

        (root.querySelector('[data-action="cleanup"]') as HTMLButtonElement).click();
        await flush();
        expect(cleanupMemories).toHaveBeenCalledTimes(1);
        expect(root.innerHTML).toContain('没有需要清理的过期记忆');
    });

    test('再次点击已展开的卡片会收起', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        (root.querySelector('[data-tab="facts"]') as HTMLButtonElement).click();
        await flush();

        // 展开
        (root.querySelector('.tl-card[data-uid="memory-1"]') as HTMLElement).click();
        await flush();
        expect(root.querySelector('.expand-card')).not.toBeNull();

        // 再次点击收起
        (root.querySelector('.tl-card[data-uid="memory-1"]') as HTMLElement).click();
        await flush();
        expect(root.querySelector('.expand-card')).toBeNull();
    });

    test('画像左右分栏布局：元数据栏 + 内容区', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        expect(root.querySelector('.pt-meta')).not.toBeNull();
        expect(root.querySelector('.pt-content')).not.toBeNull();
        expect(root.querySelector('.eyebrow')?.textContent).toBe('用户画像');
        expect(root.querySelector('.pt-meta h2')?.textContent).toBe('关于我');
    });

    test('点击删除按钮进入确认态，再次点击确认删除', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        (root.querySelector('[data-tab="facts"]') as HTMLButtonElement).click();
        await flush();

        (root.querySelector('.tl-card[data-uid="memory-1"]') as HTMLElement).click();
        await flush();
        expect(root.querySelector('[data-action="delete-memory"]')).not.toBeNull();

        // 第一次点击删除按钮 -> 进入确认态
        (root.querySelector('[data-action="delete-memory"]') as HTMLButtonElement).click();
        await flush();
        expect(root.querySelector('[data-action="confirm-delete"]')).not.toBeNull();
        expect(root.querySelector('[data-action="delete-memory"]')).toBeNull();

        // 点击确认删除
        (root.querySelector('[data-action="confirm-delete"]') as HTMLButtonElement).click();
        await flush();
        expect(removeMemory).toHaveBeenCalledWith('memory-1');
        expect(root.innerHTML).toContain('记忆已删除');
        expect(root.querySelectorAll('.tl-card')).toHaveLength(0);
    });

    test('点击删除按钮后点击其他地方，还原为删除按钮', async () => {
        const panel = document.createElement('memory-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;

        (root.querySelector('[data-tab="facts"]') as HTMLButtonElement).click();
        await flush();

        (root.querySelector('.tl-card[data-uid="memory-1"]') as HTMLElement).click();
        await flush();

        // 进入确认态
        (root.querySelector('[data-action="delete-memory"]') as HTMLButtonElement).click();
        await flush();
        expect(root.querySelector('[data-action="confirm-delete"]')).not.toBeNull();

        // 点击展开卡的其他区域（标题）
        (root.querySelector('.expand-title') as HTMLElement).click();
        await flush();
        expect(root.querySelector('[data-action="delete-memory"]')).not.toBeNull();
        expect(root.querySelector('[data-action="confirm-delete"]')).toBeNull();
        expect(removeMemory).not.toHaveBeenCalled();
    });
});
