import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('task artifacts browser focus ownership', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
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

        await jest.unstable_mockModule('../../../renderer/components/fileExplorer.ts', () => ({
            FileExplorer: class {},
            getFileExplorerCSS: () => '',
            isHtmlFile: () => false
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({
            EmbeddedBrowser: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));

        await import('../../../renderer/components/taskartifacts.ts');
    });

    function createArtifacts(background: boolean): HTMLElement & {
        browserFocusActiveWebview: () => boolean;
        ensureBrowserReady: jest.Mock;
        _browser: { focusActiveWebview: jest.Mock; setPreviewMode: jest.Mock };
    } {
        const taskView = document.createElement('task-view');
        if (background) taskView.setAttribute('data-background', '1');
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            browserFocusActiveWebview: () => boolean;
            ensureBrowserReady: jest.Mock;
            _browser: { focusActiveWebview: jest.Mock; setPreviewMode: jest.Mock };
        };
        artifacts.ensureBrowserReady = jest.fn();
        artifacts._browser = { focusActiveWebview: jest.fn(() => true), setPreviewMode: jest.fn() };
        taskView.appendChild(artifacts);
        return artifacts;
    }

    test('background browser activation does not publish foreground focus layout', () => {
        const artifacts = createArtifacts(true) as ReturnType<typeof createArtifacts> & {
            _activeTab: string;
            _browserVisible: boolean;
            _syncWorkspaceFocusLayout: () => void;
        };
        const focusStates: Array<{ active: boolean; fullscreen: boolean }> = [];
        artifacts.addEventListener('workspace-focus-layout-change', (event) => {
            focusStates.push((event as CustomEvent<{ active: boolean; fullscreen: boolean }>).detail);
        });
        artifacts._activeTab = 'browser';
        artifacts._browserVisible = true;

        artifacts._syncWorkspaceFocusLayout();

        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
        expect(focusStates).toEqual([]);
    });

    test('background task refuses browser focus without preparing the browser', () => {
        const artifacts = createArtifacts(true);

        expect(artifacts.browserFocusActiveWebview()).toBe(false);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
        expect(artifacts._browser.focusActiveWebview).not.toHaveBeenCalled();
    });

    test('hidden cached task refuses browser focus', () => {
        const artifacts = createArtifacts(false);
        const taskView = artifacts.closest('task-view') as HTMLElement;
        taskView.style.display = 'none';

        expect(artifacts.browserFocusActiveWebview()).toBe(false);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
        expect(artifacts._browser.focusActiveWebview).not.toHaveBeenCalled();
    });

    test('foreground task preserves the existing browser focus path', () => {
        const artifacts = createArtifacts(false);

        expect(artifacts.browserFocusActiveWebview()).toBe(true);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledTimes(1);
        expect(artifacts._browser.focusActiveWebview).toHaveBeenCalledTimes(1);
    });
});
