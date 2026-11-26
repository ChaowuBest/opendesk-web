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
            FileExplorer: class {
                stopWatchingFile() {}
            },
            getFileExplorerCSS: () => '',
            isHtmlFile: () => false
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({
            EmbeddedBrowser: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));

        await import('../../../renderer/components/taskartifacts.ts');
    });

    function createArtifacts(background: boolean): HTMLElement & {
        browserHasActiveWebviewFocus: () => boolean;
        ensureBrowserReady: jest.Mock;
        _browser: { hasActiveWebviewFocus: jest.Mock; setPreviewMode: jest.Mock };
    } {
        const taskView = document.createElement('task-view');
        if (background) taskView.setAttribute('data-background', '1');
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            browserHasActiveWebviewFocus: () => boolean;
            ensureBrowserReady: jest.Mock;
            _browser: { hasActiveWebviewFocus: jest.Mock; setPreviewMode: jest.Mock };
        };
        artifacts.ensureBrowserReady = jest.fn();
        artifacts._browser = { hasActiveWebviewFocus: jest.fn(() => true), setPreviewMode: jest.fn() };
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

    test('background task reports that its browser does not own focus without preparing it', () => {
        const artifacts = createArtifacts(true);

        expect(artifacts.browserHasActiveWebviewFocus()).toBe(false);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
        expect(artifacts._browser.hasActiveWebviewFocus).not.toHaveBeenCalled();
    });

    test('hidden cached task refuses browser focus', () => {
        const artifacts = createArtifacts(false);
        const taskView = artifacts.closest('task-view') as HTMLElement;
        taskView.style.display = 'none';

        expect(artifacts.browserHasActiveWebviewFocus()).toBe(false);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
        expect(artifacts._browser.hasActiveWebviewFocus).not.toHaveBeenCalled();
    });

    test('foreground task only reports existing browser focus without moving it', () => {
        const artifacts = createArtifacts(false);

        expect(artifacts.browserHasActiveWebviewFocus()).toBe(true);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
        expect(artifacts._browser.hasActiveWebviewFocus).toHaveBeenCalledTimes(1);
    });

    test('keeps an inactive browser panel renderable without exposing it over the user tab', () => {
        const artifacts = createArtifacts(false) as ReturnType<typeof createArtifacts> & {
            _browserVisible: boolean;
            keepBrowserPanelRenderable: () => void;
            restoreBrowserPanelLayout: () => void;
        };
        artifacts.shadowRoot!.innerHTML = `
            <div class="tab-content" data-tab="workspace"></div>
            <div class="tab-content" data-tab="browser" style="display:none"></div>
        `;
        artifacts._browserVisible = true;

        artifacts.keepBrowserPanelRenderable();

        const browserPanel = artifacts.shadowRoot!.querySelector<HTMLElement>('[data-tab="browser"]')!;
        expect(browserPanel.style.display).toBe('');
        expect(browserPanel.style.width).toBe('1280px');
        expect(browserPanel.style.height).toBe('800px');
        expect(browserPanel.style.opacity).toBe('0');
        expect(browserPanel.style.pointerEvents).toBe('none');
        expect(browserPanel.dataset.keepAlive).toBe('1');

        artifacts.restoreBrowserPanelLayout();

        expect(browserPanel.style.display).toBe('none');
        expect(browserPanel.style.width).toBe('');
        expect(browserPanel.style.height).toBe('');
        expect(browserPanel.style.opacity).toBe('');
        expect(browserPanel.style.pointerEvents).toBe('');
        expect(browserPanel.dataset.keepAlive).toBeUndefined();
    });
});
