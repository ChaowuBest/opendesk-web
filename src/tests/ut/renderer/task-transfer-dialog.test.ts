import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.js';

describe('task transfer dialog', () => {
    let showTaskTransfer: any;
    let translate: any;
    const pickWorkspace = jest.fn<() => Promise<string | null>>();
    beforeAll(async () => {
        jest.unstable_mockModule('../../../renderer/components/workspacePicker.ts', () => ({
            showWorkspacePicker: pickWorkspace
        }));
        const { window } = parseHTML('<html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements
        });
        ({ showTaskTransfer } = await import('../../../renderer/components/taskTransferDialog.js'));
        translate = createRendererTranslator({ locale: 'zh-CN', resolved_locale: 'zh-CN' });
    });
    beforeEach(() => {
        document.body.innerHTML = '';
        pickWorkspace.mockReset();
        window.taskManagerAPI = {
            previewTaskImport: jest.fn(async () => ({
                token: 'preview',
                workspace: '/current',
                entries: [
                    { id: 'one', name: '<img src=x>', messageCount: 3, duplicate: false },
                    { id: 'two', name: 'duplicate', messageCount: 2, duplicate: true },
                    { id: 'bad', name: 'broken', messageCount: 0, error: 'invalidTask' }
                ]
            })),
            importTaskBundle: jest.fn(async () => ({
                imported: [{ taskId: 'new', name: 'one' }],
                failed: [],
                skipped: 2
            })),
            discardTaskImport: jest.fn(async () => {}),
            getTaskList: jest.fn(async () => [
                { task_id: 'one', task_name: 'First' },
                { task_id: 'two', task_name: 'Second' }
            ]),
            exportTaskBundle: jest.fn(async () => null),
            onTaskTransferProgress: jest.fn(() => () => {})
        };
    });
    const open = (mode = 'import') => showTaskTransfer(document.body, translate, mode);

    test('preselects valid new tasks, skips duplicates, and renders imported names as text', async () => {
        const dialog = await open();
        expect(dialog.selected.has('one')).toBe(true);
        expect(dialog.selected.has('two')).toBe(false);
        expect(dialog.selected.has('bad')).toBe(false);
        expect(document.querySelector('img')).toBeNull();
        await dialog.submit();
        expect(window.taskManagerAPI.importTaskBundle).toHaveBeenCalledWith(
            'preview',
            ['one'],
            expect.any(String),
            '/current'
        );
        expect(document.querySelector('[data-transfer-status]')!.textContent).toContain('导入 1');
        const onProgress = window.taskManagerAPI.onTaskTransferProgress.mock.calls[0][0];
        onProgress({ operationId: dialog.operationId, done: 1, total: 1 });
        expect(document.querySelector('[data-transfer-status]')!.textContent).toContain('已导入 1');
        dialog.close();
    });

    test('opens one file picker before the modal and leaves no modal when canceled', async () => {
        let finish: (value: null) => void;
        window.taskManagerAPI.previewTaskImport.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const pending = open();
        expect(document.querySelector('[data-task-transfer]')).toBeNull();
        await open();
        expect(window.taskManagerAPI.previewTaskImport).toHaveBeenCalledTimes(1);
        finish!(null);
        await pending;
        expect(document.querySelector('[data-task-transfer]')).toBeNull();
    });

    test('uses the shared workspace picker and imports into the chosen directory', async () => {
        const dialog = await open();
        expect(document.querySelector('[data-transfer-info]')).toBeNull();
        pickWorkspace.mockImplementation(async () => {
            expect(document.querySelector('[data-task-transfer]')!.hasAttribute('hidden')).toBe(true);
            return '/chosen';
        });
        await dialog.chooseWorkspace();
        expect(pickWorkspace).toHaveBeenCalledWith(expect.objectContaining({ initialWorkspace: '/current' }));
        expect(document.querySelector('[data-transfer-workspace]')!.textContent).toContain('/chosen');
        expect(document.querySelector('[data-task-transfer]')!.hasAttribute('hidden')).toBe(false);
        await dialog.submit();
        expect(window.taskManagerAPI.importTaskBundle).toHaveBeenCalledWith(
            'preview',
            ['one'],
            expect.any(String),
            '/chosen'
        );
        dialog.close();
    });

    test('shows an export info box and places show-in-folder immediately before close in the footer', async () => {
        window.taskManagerAPI.exportTaskBundle.mockResolvedValue({ count: 2, filePath: '/backup.zip' });
        const dialog = await open('export');
        const info = document.querySelector('[data-transfer-info]')!;
        expect(info.textContent).toContain('包含：对话、工具记录、关联子任务');
        expect(info.textContent).toContain('不包含：外部附件，工作目录文件');
        expect(info.textContent).toContain('运行中任务：导出当前快照');
        expect(document.querySelector('[data-transfer-all]')!.textContent).toBe('全选 / 取消');
        (document.querySelector('[data-transfer-all]') as HTMLElement).click();
        await dialog.submit();
        const close = document.querySelector('[data-transfer-close]')!;
        expect(close.previousElementSibling!.textContent).toBe('打开所在文件夹');
        expect(close.parentElement!.className).toBe('od-confirm-modal-footer');
        dialog.close();
    });

    test('search and select-all apply to filtered rows, and canceled export preserves selection', async () => {
        const dialog = await open('export');
        const search = document.querySelector('[data-transfer-search]') as HTMLInputElement;
        search.value = 'Second';
        search.dispatchEvent(new Event('input'));
        (document.querySelector('[data-transfer-all]') as HTMLInputElement).click();
        expect([...dialog.selected]).toEqual(['two']);
        await dialog.submit();
        expect(window.taskManagerAPI.exportTaskBundle).toHaveBeenCalledWith(['two'], expect.any(String));
        expect(dialog.busy).toBe(false);
        expect([...dialog.selected]).toEqual(['two']);
        dialog.close();
    });
});
