import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

type FileExplorerModule = typeof import('../../../renderer/components/fileExplorer.js');

describe('file explorer', () => {
    let FileExplorer: FileExplorerModule['FileExplorer'];
    let getFileExplorerCSS: FileExplorerModule['getFileExplorerCSS'];

    beforeAll(async () => {
        jest.unstable_mockModule('ace-builds/css/ace.css', () => ({ default: '' }));
        jest.unstable_mockModule('ace-builds/css/ace.css?inline', () => ({ default: '' }), { virtual: true });

        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements
        });

        ({ FileExplorer, getFileExplorerCSS } = await import('../../../renderer/components/fileExplorer.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        delete (window as any).officeHostAPI;
        delete (window as any).fsAPI;
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
        (explorer as any).onWorkspaceFocusLayoutChange = onWorkspaceFocusLayoutChange;
        explorer._renderPanel();

        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        expect(prepare).toHaveBeenCalledWith('slides');
        expect(editor).not.toBeNull();
        expect(editor?.getAttribute('src')).toBe('./slides_editor.html?mode=tab&file=%2Fworkspace%2Fdeck.pptx');
        expect(editor?.getAttribute('title')).toBeTruthy();
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);
        expect(onWorkspaceFocusLayoutChange).toHaveBeenLastCalledWith({ active: true, fullscreen: true });
        explorer.closeEditor();
    });

    test('opens docx files in the embedded OpenDesk Office editor', async () => {
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
        (explorer as any).onWorkspaceFocusLayoutChange = onWorkspaceFocusLayoutChange;
        explorer._renderPanel();

        explorer.selectFile('/workspace/report.docx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-office-editor-frame');
        expect(prepare).toHaveBeenCalledWith('word');
        expect(editor?.getAttribute('src')).toBe('./word_editor.html?mode=tab&file=%2Fworkspace%2Freport.docx');
        expect(editor?.getAttribute('title')).toBe('Word editor');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(onWorkspaceFocusLayoutChange).toHaveBeenLastCalledWith({ active: true, fullscreen: true });
    });

    test('opens xlsx files in the embedded OpenDesk Office editor', async () => {
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
        explorer._renderPanel();

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

    test('keeps a shadow-safe loading view visible until the embedded pptx editor is visible', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
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

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _renderPanel(): void;
        };
        explorer._container = container;
        explorer._rootNode = container;
        explorer._workspaceRoot = '/workspace';
        explorer._renderPanel();

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
        explorer._renderPanel();
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
            querySelector: jest.fn(() => ({}))
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
        explorer.selectFile('/workspace/readme.txt');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestClose).toHaveBeenCalledWith('slides', 42);
        expect(explorer._selectedFile).toBe('/workspace/deck.pptx');

        explorer.selectFile('/workspace/readme.txt');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._selectedFile).toBe('/workspace/readme.txt');
    });
});
