import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { enUs } from '../../../locale/en-us.js';

// 锁定 en-US locale，使测试不依赖运行环境的 navigator.language
jest.unstable_mockModule('../../../renderer/locale.js', () => {
    const translate = (key: string, params?: Record<string, string | number>): string => {
        let text: string = enUs[key] ?? key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
    return {
        createRendererTranslator: () => translate,
        resolveRendererLocale: () => 'en-US'
    };
});

type FileExplorerModule = typeof import('../../../renderer/components/fileExplorer.js');
const renderMermaidBlocks = jest.fn<(container: HTMLElement) => void>();

jest.unstable_mockModule('../../../renderer/components/previewer.js', () => ({ renderMermaidBlocks }));

describe('file explorer', () => {
    let FileExplorer: FileExplorerModule['FileExplorer'];
    let getFileExplorerCSS: FileExplorerModule['getFileExplorerCSS'];
    let renderFilePreviewMarkdown: FileExplorerModule['renderFilePreviewMarkdown'];
    /** linkedom 窗口引用：其 dispatchEvent 只接受与 document 同源的 Event 实例 */
    let lw: Window;

    beforeAll(async () => {
        jest.unstable_mockModule('ace-builds/css/ace.css', () => ({ default: '' }));
        jest.unstable_mockModule('ace-builds/css/ace.css?inline', () => ({ default: '' }), { virtual: true });

        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        lw = window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements
        });

        ({ FileExplorer, getFileExplorerCSS, renderFilePreviewMarkdown } =
            await import('../../../renderer/components/fileExplorer.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        renderMermaidBlocks.mockClear();
        delete (window as any).officeHostAPI;
        delete (window as any).fsAPI;
    });

    function mountExplorer(workspace = '/workspace') {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const explorer = new FileExplorer() as any;
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = workspace;
        explorer._renderPanel();
        return { container, explorer };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const refreshSettled = () => new Promise((resolve) => setTimeout(resolve, 150));
    /**
     * 轮询等待异步链达到预期状态。
     *
     * 监听刷新是「100ms 去抖 → 一次 0ms 让局部 loading 绘制 → 若干 await」，实测整条链约 120~130ms：
     * 固定 sleep 猜总耗时在 CPU 紧张的并行跑里必然偶发不够（100ms 定时器被推迟，链路整体右移），
     * 所以这里等条件。默认上限 2s（约为实测值的 15 倍），同时保证一个用例里连等两次也不会
     * 撞上 jest 的 5s 单测超时，超时会带上 label 而不是含糊的 timeout。
     */
    async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!condition()) {
            if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    const officeFrame = (container: HTMLElement) => container.querySelector('.ws-office-editor-frame');

    test('refreshes only the changed visible directory and resumes listings when revealed', async () => {
        function entry(path: string, isDirectory = false) {
            return { path, name: path.split('/').at(-1), isDirectory, size: 0, modifiedAt: null };
        }
        const root = '/workspace';
        const child = root + '/child';
        const nested = child + '/nested';
        const callbacks = new Map<string, () => void>();
        const listDirectory = jest.fn(async (dir: string) => {
            if (dir === root) return [entry(child, true)];
            if (dir === child) return [entry(nested, true)];
            return [entry(nested + '/old.txt')];
        });
        (window as any).fsAPI = {
            listDirectory,
            watchDirectory: jest.fn(async (dir: string, callback: () => void) => {
                callbacks.set(dir, callback);
                return () => callbacks.delete(dir);
            })
        };
        const { container, explorer } = mountExplorer();
        await settle();
        explorer._toggleTreeNode(child);
        await settle();
        explorer._toggleTreeNode(nested);
        await settle();
        expect(listDirectory.mock.calls).toEqual([[root], [child], [nested]]);

        listDirectory.mockClear();
        listDirectory.mockResolvedValueOnce([entry(nested + '/new.txt')]);
        callbacks.get(nested)?.();
        callbacks.get(nested)?.();
        await waitFor(() => container.textContent?.includes('new.txt') === true, 'updated directory');
        expect(listDirectory.mock.calls).toEqual([[nested]]);

        const nestedBranch = container.querySelector(`[data-dir="${nested}"]`);
        listDirectory.mockResolvedValueOnce([entry(child, true), entry(root + '/top.txt')]);
        callbacks.get(root)?.();
        await waitFor(() => container.textContent?.includes('top.txt') === true, 'updated root');
        expect(container.querySelector(`[data-dir="${nested}"]`)).toBe(nestedBranch);
        expect(listDirectory.mock.calls).toEqual([[nested], [root]]);

        listDirectory.mockClear();
        const staleCallback = callbacks.get(nested);
        explorer._toggleTreeNode(child);
        expect([...callbacks.keys()]).toEqual([root]);
        explorer.setDirectoryBrowserVisible(false);
        expect(callbacks.size).toBe(0);
        staleCallback?.();
        await refreshSettled();
        expect(listDirectory).not.toHaveBeenCalled();
        explorer.setDirectoryBrowserVisible(true);
        await settle();
        expect(listDirectory.mock.calls).toEqual([[root]]);
        listDirectory.mockClear();
        explorer._setViewMode('grid');
        explorer._enterGridDir(child);
        await settle();
        expect([...callbacks.keys()]).toEqual([child]);
        expect(listDirectory.mock.calls).toEqual([[child]]);
        explorer.setDirectoryBrowserVisible(false);
    });

    async function openWatchedOffice(ext: 'pptx' | 'docx' | 'xlsx') {
        const file = `/workspace/deck.${ext}`;
        let callback!: (change: unknown) => void;
        const dispose = jest.fn();
        const requestClose = jest.fn(async () => true);
        const refreshFile = jest.fn(async () => {});
        (window as any).fsAPI = {
            watchFile: jest.fn(async (_path, cb) => {
                callback = cb;
                return dispose;
            }),
            getFileSize: jest.fn(async () => 4096)
        };
        (window as any).officeHostAPI = {
            prepare: jest.fn(async () => true),
            requestClose,
            refreshFile
        };
        const { container, explorer } = mountExplorer();
        explorer.selectFile(file);
        await settle();
        const editor = container.querySelector('.ws-office-editor-frame') as any;
        editor.getWebContentsId = () => 123;
        editor.classList.remove('ws-office-editor-frame--loading');
        return {
            container,
            explorer,
            editor,
            dispose,
            requestClose,
            refreshFile,
            notify: () => callback({ path: file, type: 'changed' })
        };
    }

    test('synchronizes watched PPT changes in place and releases the watch on close', async () => {
        const s = await openWatchedOffice('pptx');
        s.notify();
        s.notify();
        await waitFor(() => s.refreshFile.mock.calls.length > 0, 'ppt in-place refresh started');
        // 刷新链收尾后（_fileRefreshVersion 归零）仍只有一次：说明去抖窗口内的第二次通知被合并了
        await waitFor(() => s.explorer._fileRefreshVersion === null, 'ppt in-place refresh finished');
        expect(s.refreshFile).toHaveBeenCalledTimes(1);
        expect(s.refreshFile).toHaveBeenCalledWith(123, '/workspace/deck.pptx');
        expect(s.requestClose).not.toHaveBeenCalled();
        expect(officeFrame(s.container)).toBe(s.editor);
        expect(s.container.querySelector('.ws-preview-size')?.textContent).toBe('4.0 KB');
        s.explorer.closeEditor();
        await settle();
        expect(s.dispose).toHaveBeenCalledTimes(1);
    });

    test.each(['docx', 'xlsx'] as const)('keeps the %s editor mounted when a watched file changes', async (ext) => {
        const s = await openWatchedOffice(ext);
        const getFileSize = (window as any).fsAPI.getFileSize;
        await waitFor(() => getFileSize.mock.calls.length === 1, 'initial file size');
        getFileSize.mockResolvedValue(8192);

        s.notify();

        await waitFor(
            () => s.container.querySelector('.ws-preview-size')?.textContent === '8.0 KB',
            'size updated after save'
        );
        expect(s.refreshFile).toHaveBeenCalledWith(123, `/workspace/deck.${ext}`);
        expect(s.requestClose).not.toHaveBeenCalled();
        expect(officeFrame(s.container)).toBe(s.editor);
        s.explorer.stopWatchingFile();
    });

    test('queues a watched Office change while the previous refresh is running', async () => {
        const s = await openWatchedOffice('docx');
        let finish!: () => void;
        s.refreshFile.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        s.notify();
        await waitFor(() => s.refreshFile.mock.calls.length === 1, 'first Word refresh started');
        s.notify();
        finish();
        await waitFor(() => s.refreshFile.mock.calls.length === 2, 'queued Word refresh started');
        await waitFor(() => s.explorer._fileRefreshVersion === null, 'queued Word refresh finished');
        expect(officeFrame(s.container)).toBe(s.editor);
        expect(s.requestClose).not.toHaveBeenCalled();
        s.explorer.stopWatchingFile();
    });

    test('releases a watch registered after closing and ignores its late notifications', async () => {
        let finish!: (dispose: () => void) => void;
        let notify!: (change: unknown) => void;
        const dispose = jest.fn();
        (window as any).fsAPI = {
            watchFile: jest.fn((_path, cb) => {
                notify = cb;
                return new Promise((resolve) => {
                    finish = resolve;
                });
            }),
            readTextFile: jest.fn(async () => ({ content: 'text', size: 4, binary: false, tooLarge: false }))
        };
        const explorer = new FileExplorer() as any;
        explorer.selectFile('/workspace/note.md');
        await settle();
        explorer.closeEditor();
        finish(dispose);
        await settle();
        notify({ path: '/workspace/note.md', type: 'changed' });
        await refreshSettled();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect((window as any).fsAPI.readTextFile).toHaveBeenCalledTimes(1);
    });

    test('refreshes ordinary previews and cancels old watches on switch or workspace reset', async () => {
        const callbacks: Array<(change: unknown) => void> = [];
        const disposers = [jest.fn(), jest.fn()];
        let content = 'before';
        (window as any).fsAPI = {
            watchFile: jest.fn(async (_path, cb) => {
                callbacks.push(cb);
                return disposers[callbacks.length - 1];
            }),
            readTextFile: jest.fn(async () => ({ content, size: content.length, binary: false, tooLarge: false }))
        };
        const explorer = new FileExplorer() as any;
        explorer.selectFile('/workspace/first.md');
        await settle();
        content = 'after';
        callbacks[0]({ path: '/workspace/first.md', type: 'changed' });
        await refreshSettled();
        expect(explorer._previewState.data.content).toBe('after');
        explorer.selectFile('/workspace/second.md');
        await settle();
        expect(disposers[0]).toHaveBeenCalledTimes(1);
        callbacks[0]({ path: '/workspace/first.md', type: 'changed' });
        await refreshSettled();
        expect((window as any).fsAPI.readTextFile).toHaveBeenCalledTimes(3);
        explorer.refresh('/another');
        expect(disposers[1]).toHaveBeenCalledTimes(1);
    });

    test('external reads cannot replace text edited while the disk read is pending', async () => {
        let finish!: (value: unknown) => void;
        (window as any).fsAPI = {
            readTextFile: jest.fn(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    })
            )
        };
        const explorer = new FileExplorer() as any;
        explorer._editorMode = true;
        explorer._editorFilePath = '/workspace/code.ts';
        explorer._editorInstance = { getValue: () => 'unsaved text' };
        const initialize = jest.spyOn(explorer, '_initAceEditor');
        const pending = explorer._loadFileForEditor('/workspace/code.ts', true);
        await settle();
        explorer._editorDirty = true;
        finish({ content: 'external text', size: 13, binary: false, tooLarge: false });
        await pending;
        expect(initialize).not.toHaveBeenCalled();
        expect(explorer._editorInstance.getValue()).toBe('unsaved text');
    });

    test('turns Mermaid fences in Markdown previews into UTF-8-safe placeholders', () => {
        const html = renderFilePreviewMarkdown('```mermaid\nflowchart LR\nA[中文] --> B[完成]\n```');
        const encoded = html.match(/data-mermaid-code="([^"]+)"/)?.[1];

        expect(html).toContain('class="mermaid-block"');
        expect(encoded).toBeDefined();
        expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe('flowchart LR\nA[中文] --> B[完成]');
    });

    test('starts Mermaid rendering after mounting the Markdown preview', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="ws-preview-md-host"></div>';
        const explorer = new FileExplorer() as any;
        explorer._selectedFile = '/workspace/diagram.md';
        explorer._previewState = {
            status: 'idle',
            data: {
                tooLarge: false,
                size: 32,
                limit: 0,
                content: '```mermaid\nflowchart LR\nA --> B\n```',
                binary: false
            }
        };

        explorer._attachMarkdownShadow(root);

        const markdownBody = root
            .querySelector<HTMLElement>('.ws-preview-md-host')
            ?.shadowRoot?.querySelector('.markdown-body');
        const previewStyles = root
            .querySelector<HTMLElement>('.ws-preview-md-host')
            ?.shadowRoot?.querySelector('style');
        expect(markdownBody).not.toBeNull();
        expect(previewStyles?.textContent).toContain('.markdown-body .code-copy-btn');
        expect(renderMermaidBlocks).toHaveBeenCalledWith(markdownBody);
    });

    test('restores the file list after closing a fullscreen preview', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _selectedFile: string;
            _previewFullscreen: boolean;
            _previewState: {
                status: 'idle';
                data: { tooLarge: false; size: number; limit: number; content: string; binary: false };
            };
            _renderPanel(): void;
        };
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._selectedFile = '/workspace/readme.txt';
        explorer._previewFullscreen = true;
        explorer._previewState = {
            status: 'idle',
            data: { tooLarge: false, size: 5, limit: 0, content: 'hello', binary: false }
        };
        explorer._renderPanel();

        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);

        container.querySelector<HTMLButtonElement>('[data-preview-close]')?.click();

        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(false);
        expect(container.querySelector('.ws-preview')?.classList.contains('ws-preview--collapsed')).toBe(true);
    });

    test('opens pptx files in the embedded OpenDesk Office editor', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).officeHostAPI = {
            prepare,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _renderPanel(): void;
        };
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        const onWorkspaceFocusLayoutChange = jest.fn();
        const onAgentInputRequest = jest.fn();
        (explorer as any).onWorkspaceFocusLayoutChange = onWorkspaceFocusLayoutChange;
        explorer.onAgentInputRequest = onAgentInputRequest;
        explorer._renderPanel();

        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        expect(prepare).toHaveBeenCalledWith('slides');
        expect(editor).not.toBeNull();
        const editorUrl = new URL(editor?.getAttribute('src') || '', 'http://localhost');
        expect(editorUrl.pathname).toBe('/slides_editor.html');
        expect(editorUrl.searchParams.get('mode')).toBe('tab');
        expect(editorUrl.searchParams.get('file')).toBe('/workspace/deck.pptx');
        expect(editorUrl.searchParams.get('extensionGroupLabel')).toBeTruthy();
        expect(editorUrl.searchParams.get('selectionActionLabel')).toBeTruthy();
        expect(editorUrl.searchParams.get('selectionActionTitle')).toBeTruthy();
        expect(editor?.getAttribute('title')).toBeTruthy();
        expect(editor?.getAttribute('partition')).toBe('persist:opendesk-office');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);
        expect(onWorkspaceFocusLayoutChange).toHaveBeenLastCalledWith({ active: true, fullscreen: true });

        const extensionActionEvent = new window.Event('ipc-message');
        Object.assign(extensionActionEvent, {
            channel: 'opendesk-office:extension-action',
            args: [
                {
                    action: { id: 'opendesk-ai-selection' },
                    context: { slideIndex: 0, selectedElements: [{ type: 'text', text: 'Title' }] }
                }
            ]
        });
        editor?.dispatchEvent(extensionActionEvent);
        expect(onAgentInputRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'insert-text',
                placement: 'append',
                focus: true
            })
        );
        explorer.closeEditor();
    });

    test('refreshes stale Office size without remounting the editor', async () => {
        const ext = 'pptx';
        let resolveSize!: (size: number) => void;
        const getFileSize = jest.fn(
            () =>
                new Promise<number>((resolve) => {
                    resolveSize = resolve;
                })
        );
        (window as any).fsAPI = { getFileSize };
        (window as any).officeHostAPI = { prepare: jest.fn(async () => true) };
        const { container, explorer } = mountExplorer();
        explorer._childrenCache.set('/workspace', [
            { name: `deck.${ext}`, path: `/workspace/deck.${ext}`, isDirectory: false, size: 1 }
        ]);
        explorer._renderPanel();
        explorer.selectFile(`/workspace/deck.${ext}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const editor = container.querySelector('.ws-office-editor-frame');
        expect(editor).not.toBeNull();
        expect(getFileSize).toHaveBeenCalledWith(`/workspace/deck.${ext}`);
        expect(container.querySelector('.ws-preview-size')?.textContent).not.toBe('0 B');
        resolveSize(12_000_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.querySelector('.ws-preview-size')?.textContent).toBe('11 MB');
        expect(container.querySelector('.ws-office-editor-frame')).toBe(editor);
        explorer.closeEditor();
    });

    test.each([0, undefined])('shows true zero but hides unavailable Office size (%s)', async (size) => {
        (window as any).fsAPI = {
            getFileSize: jest.fn(async () => {
                if (size === undefined) throw new Error('stat failed');
                return size;
            })
        };
        (window as any).officeHostAPI = { prepare: jest.fn(async () => true) };
        const { container, explorer } = mountExplorer();
        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.querySelector('.ws-office-editor-frame')).not.toBeNull();
        expect(container.querySelector('.ws-preview-size')?.textContent).toBe(size === 0 ? '0 B' : '');
        explorer.closeEditor();
    });

    test('ignores an old size response after switching Office files', async () => {
        let resolveOld!: (size: number) => void;
        (window as any).fsAPI = {
            getFileSize: jest.fn((file: string) =>
                file.endsWith('old.pptx')
                    ? new Promise<number>((resolve) => {
                          resolveOld = resolve;
                      })
                    : Promise.resolve(2048)
            )
        };
        (window as any).officeHostAPI = { prepare: jest.fn(async () => true) };
        const { container, explorer } = mountExplorer();
        explorer.selectFile('/workspace/old.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));
        explorer.selectFile('/workspace/new.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolveOld(999999);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.querySelector('.ws-preview-size')?.textContent).toBe('2.0 KB');
        explorer.closeEditor();
    });

    test('normalizes Windows paths before rendering the file breadcrumb and opening Office', async () => {
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        const listDirectory = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
        (window as any).officeHostAPI = {
            prepare,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };
        (window as any).fsAPI = { listDirectory };

        const { container, explorer } = mountExplorer('C:/workspace');

        explorer.selectFile('C:\\workspace\\deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        const editorUrl = new URL(editor?.getAttribute('src') || '', 'http://localhost');
        expect(editorUrl.searchParams.get('file')).toBe('C:/workspace/deck.pptx');
        expect(container.querySelector('.ws-breadcrumb-current')?.textContent).toBe('deck.pptx');

        container.querySelector<HTMLElement>('.ws-breadcrumb-current')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listDirectory).toHaveBeenCalledWith('C:/workspace');
        explorer.closeEditor();
    });

    test('opens docx files in the embedded OpenDesk Office editor', async () => {
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        const bindOfficeTask = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).officeHostAPI = {
            prepare,
            bindOfficeTask,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        const { container, explorer } = mountExplorer();
        explorer.setTaskId('task-a');
        const onWorkspaceFocusLayoutChange = jest.fn();
        (explorer as any).onWorkspaceFocusLayoutChange = onWorkspaceFocusLayoutChange;

        explorer.selectFile('/workspace/report.docx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        expect(prepare).toHaveBeenCalledWith('word');
        expect(editor?.getAttribute('src')).toBe('./word_editor.html?mode=tab&file=%2Fworkspace%2Freport.docx');
        expect(editor?.getAttribute('title')).toBe('Word editor');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(onWorkspaceFocusLayoutChange).toHaveBeenLastCalledWith({ active: true, fullscreen: true });

        (editor as any).getWebContentsId = () => 42;
        const readyEvent = new window.Event('ipc-message');
        Object.assign(readyEvent, { channel: 'opendesk-office:document-ready', args: [] });
        editor?.dispatchEvent(readyEvent);
        expect(bindOfficeTask).toHaveBeenCalledWith('word', 'task-a', '/workspace/report.docx', 42);
    });

    test('opens xlsx files in the embedded OpenDesk Office editor', async () => {
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).officeHostAPI = {
            prepare,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        const { container, explorer } = mountExplorer();

        explorer.selectFile('/workspace/budget.xlsx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        expect(prepare).toHaveBeenCalledWith('sheets');
        expect(editor?.getAttribute('src')).toBe('./sheets_editor.html?mode=tab&file=%2Fworkspace%2Fbudget.xlsx');
        expect(editor?.getAttribute('title')).toBe('Excel editor');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);
    });

    test.each([
        ['slides', 'deck.pptx', 1536, '1.5 KB'],
        ['word', 'report.docx', 24 * 1024, '24 KB'],
        ['sheets', 'budget.xlsx', 2 * 1024 * 1024, '2.0 MB']
    ] as const)('refreshes the size in the %s preview header', async (_kind, name, size, expected) => {
        (window as any).officeHostAPI = {
            prepare: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        (window as any).fsAPI = { getFileSize: jest.fn(async () => size) };
        const filePath = `/workspace/${name}`;
        const { container, explorer } = mountExplorer();
        explorer._childrenCache.set('/workspace', [
            { name, path: filePath, isDirectory: false, size, modifiedAt: null }
        ]);

        explorer.selectFile(filePath);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(container.querySelector('.ws-preview-size')?.textContent).toBe(expected);
    });

    test('opens and refreshes a local PDF through the Office host', async () => {
        const readTextFile = jest.fn();
        const prepare = jest.fn(async () => true);
        const refreshFile = jest.fn(async () => {});
        const requestClose = jest.fn(async () => true);
        let change!: () => void;
        const getFileSize = jest.fn(async () => 4096);
        (window as any).officeHostAPI = { prepare, refreshFile, requestClose };
        (window as any).fsAPI = {
            getFileSize,
            readTextFile,
            watchFile: jest.fn(async (_path, callback: () => void) => {
                change = callback;
                return () => {};
            })
        };
        const { container, explorer } = mountExplorer();
        const filePath = '/workspace/报告 #.PDF';
        explorer.openEditor(filePath);
        await settle();

        const preview = officeFrame(container) as HTMLElement & { getWebContentsId: () => number };
        expect(prepare).toHaveBeenCalledWith('pdf');
        expect(preview?.getAttribute('partition')).toBe('persist:opendesk-office');
        const url = new URL(preview.getAttribute('src')!, 'http://localhost');
        expect(url.pathname).toBe('/pdf_editor.html');
        expect(url.searchParams.get('file')).toBe(filePath);
        expect(container.querySelector('.ws-preview-size')?.textContent).toBe('4.0 KB');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(readTextFile).not.toHaveBeenCalled();

        preview.getWebContentsId = () => 123;
        const readyEvent = new window.Event('ipc-message');
        Object.assign(readyEvent, { channel: 'opendesk-office:document-ready' });
        preview.dispatchEvent(readyEvent);
        getFileSize.mockResolvedValue(8192);
        change();
        await waitFor(() => container.querySelector('.ws-preview-size')?.textContent === '8.0 KB', 'PDF refresh');
        expect(refreshFile).toHaveBeenCalledWith(123, filePath);
        expect(officeFrame(container)).toBe(preview);
        explorer.closeEditor();
        await settle();
        expect(requestClose).toHaveBeenCalledWith('pdf', 123);
        expect(officeFrame(container)).toBeNull();
    });

    test('keeps a shadow-safe loading view visible until the embedded pptx editor is visible', async () => {
        let finishPrepare: ((ready: boolean) => void) | undefined;
        const prepare = jest.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    finishPrepare = resolve;
                })
        );
        (window as any).officeHostAPI = {
            prepare,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        const { container, explorer } = mountExplorer();

        explorer.selectFile('/workspace/deck.pptx');
        const previewRoot = container.querySelector('[data-preview-root]');
        const loadingHost = container.querySelector('.ws-office-editor-host');
        expect(loadingHost?.querySelector('.ws-office-editor-loading-indicator')).not.toBeNull();
        expect(loadingHost?.querySelector('.ws-office-editor-loading-spinner')).not.toBeNull();
        expect(loadingHost?.querySelector('.ws-office-editor-loading-text')?.textContent).toContain('Loading editor');
        expect(getFileExplorerCSS()).toContain('@keyframes ws-office-editor-loading-spin');
        expect(getFileExplorerCSS()).toContain('.ws-office-editor-loading-spinner');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.ws-office-editor-frame')).toBeNull();

        finishPrepare?.(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const editor = container.querySelector<HTMLElement>('.ws-office-editor-frame');
        expect(editor).not.toBeNull();
        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-office-editor-loading-indicator')).not.toBeNull();
        expect(editor?.classList.contains('ws-office-editor-frame--loading')).toBe(true);

        const visibleEvent = new window.Event('ipc-message') as Event & { channel: string };
        visibleEvent.channel = 'opendesk-office:editor-visible';
        editor?.dispatchEvent(visibleEvent);

        expect(container.querySelector('.ws-office-editor-loading-indicator')).toBeNull();
        expect(editor?.classList.contains('ws-office-editor-frame--loading')).toBe(false);
    });

    test('keeps the same pptx editor session when switching the file browser view', async () => {
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).officeHostAPI = {
            prepare,
            requestClose: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
        };

        const { container, explorer } = mountExplorer();
        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const previewRoot = container.querySelector('[data-preview-root]');
        const editor = container.querySelector('.ws-office-editor-frame');
        expect(editor).not.toBeNull();

        container.querySelector<HTMLButtonElement>('[data-view="grid"]')?.click();

        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-office-editor-frame')).toBe(editor);
        expect(container.querySelector('[data-view="grid"]')?.classList.contains('ws-view-active')).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);
    });

    test('switches from editor mode to rendered preview via the preview button', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const readTextFile = jest.fn<() => Promise<unknown>>().mockResolvedValue({
            tooLarge: false,
            size: 8,
            limit: 0,
            content: '# Title\n\nbody text',
            binary: false
        });
        (window as any).fsAPI = { readTextFile };

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _editorMode: boolean;
            _editorFilePath: string | null;
            _selectedFile: string;
            _previewState: {
                status: 'idle';
                data: { tooLarge: boolean; size: number; limit: number; content: string; binary: boolean };
            };
            _renderPanel(): void;
        };
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._editorMode = true;
        explorer._editorFilePath = '/workspace/readme.md';
        explorer._selectedFile = '/workspace/readme.md';
        explorer._previewState = {
            status: 'idle',
            data: { tooLarge: false, size: 8, limit: 0, content: '# Title\n\nbody text', binary: false }
        };
        explorer._renderPanel();

        const previewBtn = container.querySelector<HTMLButtonElement>('[data-action="editor-preview"]');
        expect(previewBtn).not.toBeNull();
        expect(container.querySelector('.ws-editor-host')).not.toBeNull();

        previewBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(explorer._editorMode).toBe(false);
        expect(container.querySelector('.ws-editor-host')).toBeNull();
        expect(container.querySelector('.ws-preview-md-host')).not.toBeNull();
        delete (window as any).fsAPI;
    });

    test('rejects Ace text files larger than 10 MiB with a clear size message', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const readTextFile = jest.fn<() => Promise<unknown>>().mockResolvedValue({
            tooLarge: true,
            size: 10 * 1024 * 1024 + 1,
            limit: 10 * 1024 * 1024,
            content: '',
            binary: false
        });
        (window as any).fsAPI = { readTextFile };

        const explorer = new FileExplorer() as any;
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._renderPanel();

        explorer.selectFile('/workspace/large.txt');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(readTextFile).toHaveBeenCalledWith('/workspace/large.txt', 10 * 1024 * 1024);
        expect(container.querySelector('.ws-preview-info')?.textContent).toContain('10 MB');
        expect(container.querySelector('.ws-editor-container')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--unsupported')).toBe(
            true
        );
    });

    test('keeps the editor dirty and editable when saving before preview fails', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const writeTextFile = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('disk full'));
        (window as any).fsAPI = { writeTextFile };
        const editor = {
            getValue: jest.fn(() => 'changed'),
            setReadOnly: jest.fn()
        };

        const explorer = new FileExplorer() as any;
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._selectedFile = '/workspace/readme.txt';
        explorer._editorMode = true;
        explorer._editorReadOnly = false;
        explorer._editorFilePath = '/workspace/readme.txt';
        explorer._editorInstance = editor;
        explorer._editorDirty = true;
        explorer._previewState = {
            status: 'idle',
            data: { tooLarge: false, size: 7, limit: 0, content: 'changed', binary: false }
        };
        explorer._renderPanel();

        await explorer._toggleEditorReadOnly();

        expect(writeTextFile).toHaveBeenCalledWith('/workspace/readme.txt', 'changed');
        expect(explorer._editorDirty).toBe(true);
        expect(explorer._editorReadOnly).toBe(false);
        expect(explorer._editorSaveError).toBe('disk full');
        expect(editor.setReadOnly).not.toHaveBeenCalled();
    });

    test('ignores stale Ace initialization after another file starts loading', async () => {
        const explorer = new FileExplorer() as any;
        explorer._editorMode = true;
        explorer._editorFilePath = '/workspace/first.txt';
        explorer._currentLoadSeq = 1;
        let finishAceLoad: ((ace: unknown) => void) | undefined;
        explorer._ensureAce = jest.fn(
            () =>
                new Promise((resolve) => {
                    finishAceLoad = resolve;
                })
        );
        explorer._rootNode = {
            querySelector: jest.fn(() => ({ style: {} }))
        };
        explorer._destroyEditorInstance = jest.fn();
        explorer._ensureAceTheme = jest.fn();
        explorer._ensureAceMode = jest.fn();

        const initialization = explorer._initAceEditor('/workspace/first.txt', 'first', 1);
        explorer._editorFilePath = '/workspace/second.txt';
        explorer._currentLoadSeq = 2;
        finishAceLoad?.({ edit: jest.fn() });
        await initialization;

        expect(explorer._ensureAceTheme).not.toHaveBeenCalled();
        expect(explorer._ensureAceMode).not.toHaveBeenCalled();
    });

    test('asks the embedded editor to handle unsaved changes before switching files', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const requestClose = jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        (window as any).officeHostAPI = {
            prepare: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
            requestClose
        };

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _selectedFile: string | null;
            _renderPanel(): void;
        };
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._renderPanel();
        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLElement>('.ws-office-editor-frame')!;
        (editor as any).getWebContentsId = () => 42;
        editor.classList.remove('ws-office-editor-frame--loading');
        const onSwitchBlocked = jest.fn();
        explorer.selectFile('/workspace/readme.txt', undefined, onSwitchBlocked);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestClose).toHaveBeenCalledWith('slides', 42);
        expect(explorer._selectedFile).toBe('/workspace/deck.pptx');
        expect(onSwitchBlocked).toHaveBeenCalledTimes(1);

        explorer.selectFile('/workspace/readme.txt', undefined, onSwitchBlocked);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._selectedFile).toBe('/workspace/readme.txt');
        expect(onSwitchBlocked).toHaveBeenCalledTimes(1);
    });

    test('编辑器打开期间切换主题会实时更新 ace 主题并重新注入 shadow CSS', async () => {
        const container = document.createElement('div');
        const explorer = new FileExplorer() as any;
        explorer._rootNode = container;
        explorer._editorInstance = { setTheme: jest.fn() };
        // 主题数据加载与 shadow CSS 注入均可直接观测
        explorer._ensureAceTheme = jest.fn().mockResolvedValue({ cssText: 'CUSTOM', cssClass: 'ace-dracula' });
        explorer._injectAceShadowStyles = jest.fn();

        document.documentElement.dataset.theme = 'dark';
        explorer._ensureThemeListening();
        document.dispatchEvent(new lw.CustomEvent('opendesk-theme-changed', { detail: { effective: 'dark' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(explorer._editorInstance.setTheme).toHaveBeenCalledWith('ace/theme/dracula');
        expect(explorer._injectAceShadowStyles).toHaveBeenCalledWith('CUSTOM');

        // 浅色切换后应切到 clouds 主题
        document.documentElement.dataset.theme = 'light';
        document.dispatchEvent(new lw.CustomEvent('opendesk-theme-changed', { detail: { effective: 'light' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._editorInstance.setTheme).toHaveBeenCalledWith('ace/theme/clouds');

        // 注销监听后不再响应切换
        explorer._editorInstance.setTheme.mockClear();
        explorer._disposeThemeListening();
        document.dispatchEvent(new lw.CustomEvent('opendesk-theme-changed', { detail: { effective: 'dark' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._editorInstance.setTheme).not.toHaveBeenCalled();
    });

    test('无编辑器实例时主题切换事件不会报错或产生副作用', async () => {
        const container = document.createElement('div');
        const explorer = new FileExplorer() as any;
        explorer._rootNode = container;
        explorer._editorInstance = null;
        explorer._ensureAceTheme = jest.fn();
        explorer._injectAceShadowStyles = jest.fn();

        explorer._ensureThemeListening();
        document.dispatchEvent(new lw.CustomEvent('opendesk-theme-changed', { detail: { effective: 'dark' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._ensureAceTheme).not.toHaveBeenCalled();
        expect(explorer._injectAceShadowStyles).not.toHaveBeenCalled();
    });
});
