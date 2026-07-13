import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

type FileExplorerModule = typeof import('../../../renderer/components/fileExplorer.js');

describe('file explorer', () => {
    let FileExplorer: FileExplorerModule['FileExplorer'];

    beforeAll(async () => {
        jest.unstable_mockModule('ace-builds/css/ace.css', () => ({ default: '' }));
        jest.unstable_mockModule('ace-builds/css/ace.css?inline', () => ({ default: '' }), { virtual: true });

        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement
        });

        ({ FileExplorer } = await import('../../../renderer/components/fileExplorer.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '';
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
});
