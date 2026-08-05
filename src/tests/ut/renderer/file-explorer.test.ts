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
        delete (window as any).slidesHostAPI;
    });

    test('restores the file list after closing a fullscreen preview', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        const explorer = new FileExplorer() as FileExplorerModule['FileExplorer'] & {
            _container: HTMLElement;
            _rootNode: ParentNode;
            _workspaceRoot: string;
            _selectedFile: string;
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
        explorer._previewState = {
            status: 'idle',
            data: { tooLarge: false, size: 5, limit: 0, content: 'hello', binary: false }
        };
        explorer._renderPanel();

        container.querySelector<HTMLButtonElement>('[data-action="preview-fullscreen"]')?.click();
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);

        container.querySelector<HTMLButtonElement>('[data-preview-close]')?.click();

        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(false);
        expect(container.querySelector('.ws-preview')?.classList.contains('ws-preview--collapsed')).toBe(true);
    });

    test('opens pptx files in the embedded Open GenOffice editor', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).slidesHostAPI = {
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
        const onPptxLayoutChange = jest.fn();
        (explorer as any).onPptxLayoutChange = onPptxLayoutChange;
        explorer._renderPanel();

        explorer.selectFile('/workspace/deck.pptx');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const editor = container.querySelector<HTMLIFrameElement>('.ws-pptx-frame');
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(editor).not.toBeNull();
        expect(editor?.getAttribute('src')).toBe('./slides_editor.html?mode=tab&file=%2Fworkspace%2Fdeck.pptx');
        expect(editor?.getAttribute('title')).toBe('PowerPoint editor');
        expect(container.querySelector('[data-action="open-editor"]')).toBeNull();
        expect(container.querySelector('[data-preview-root]')?.classList.contains('ws-preview--fullscreen')).toBe(true);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(true);
        expect(onPptxLayoutChange).toHaveBeenLastCalledWith({ active: true, fullscreen: true });
        explorer.closeEditor();
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
        (window as any).slidesHostAPI = {
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
        const loadingHost = container.querySelector('.ws-pptx-host');
        expect(loadingHost?.querySelector('.ws-pptx-loading-indicator')).not.toBeNull();
        expect(loadingHost?.querySelector('.ws-pptx-loading-spinner')).not.toBeNull();
        expect(loadingHost?.querySelector('.ws-pptx-loading-text')?.textContent).toContain('Loading editor');
        expect(getFileExplorerCSS()).toContain('@keyframes ws-pptx-loading-spin');
        expect(getFileExplorerCSS()).toContain('.ws-pptx-loading-spinner');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.ws-pptx-frame')).toBeNull();

        finishPrepare?.(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const editor = container.querySelector<HTMLElement>('.ws-pptx-frame');
        expect(editor).not.toBeNull();
        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-pptx-loading-indicator')).not.toBeNull();
        expect(editor?.classList.contains('ws-pptx-frame--loading')).toBe(true);

        const visibleEvent = new window.Event('ipc-message') as Event & { channel: string };
        visibleEvent.channel = 'open-genoffice:editor-visible';
        editor?.dispatchEvent(visibleEvent);

        expect(container.querySelector('.ws-pptx-loading-indicator')).toBeNull();
        expect(editor?.classList.contains('ws-pptx-frame--loading')).toBe(false);
    });

    test('keeps the same pptx editor session across fullscreen layout changes', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const prepare = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        (window as any).slidesHostAPI = {
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
        const editor = container.querySelector('.ws-pptx-frame');
        expect(editor).not.toBeNull();
        expect(previewRoot?.classList.contains('ws-preview--fullscreen')).toBe(true);

        container.querySelector<HTMLButtonElement>('[data-action="preview-fullscreen"]')?.click();

        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-pptx-frame')).toBe(editor);
        expect(previewRoot?.classList.contains('ws-preview--fullscreen')).toBe(false);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--hidden')).toBe(false);
        expect(prepare).toHaveBeenCalledTimes(1);

        container.querySelector<HTMLButtonElement>('[data-action="preview-fullscreen"]')?.click();
        expect(previewRoot?.classList.contains('ws-preview--fullscreen')).toBe(true);

        container.querySelector<HTMLButtonElement>('[data-action="preview-fullscreen"]')?.click();
        container.querySelector<HTMLButtonElement>('[data-action="browser-fullscreen"]')?.click();

        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-pptx-frame')).toBe(editor);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--fullscreen')).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);

        container.querySelector<HTMLButtonElement>('[data-action="browser-fullscreen"]')?.click();

        expect(container.querySelector('[data-preview-root]')).toBe(previewRoot);
        expect(container.querySelector('.ws-pptx-frame')).toBe(editor);
        expect(container.querySelector('.ws-browser')?.classList.contains('ws-browser--fullscreen')).toBe(false);
        expect(prepare).toHaveBeenCalledTimes(1);
    });

    test('asks the embedded editor to handle unsaved changes before switching files', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const requestClose = jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        (window as any).slidesHostAPI = {
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

        const editor = container.querySelector<HTMLElement>('.ws-pptx-frame')!;
        (editor as any).getWebContentsId = () => 42;
        explorer.selectFile('/workspace/readme.txt');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestClose).toHaveBeenCalledWith(42);
        expect(explorer._selectedFile).toBe('/workspace/deck.pptx');

        explorer.selectFile('/workspace/readme.txt');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(explorer._selectedFile).toBe('/workspace/readme.txt');
    });
});
