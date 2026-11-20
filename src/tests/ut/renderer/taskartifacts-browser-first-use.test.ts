import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

type RestoredTabs = { tabs: Array<{ url: string; title?: string }>; activeIndex: number };

class BrowserFixture {
    hasContent: boolean;
    onTabsChanged: (() => void) | null = null;
    setPreviewMode = jest.fn();
    hasActiveWebviewFocus = jest.fn(() => true);

    constructor(_panel: HTMLElement, _taskId: string, restored?: RestoredTabs) {
        this.hasContent = restored?.tabs.some((tab) => tab.url !== 'about:blank') ?? false;
    }

    hasActiveContent(): boolean {
        return this.hasContent;
    }

    publishContent(hasContent: boolean): void {
        this.hasContent = hasContent;
        this.onTabsChanged?.();
    }

    getSessionState(): RestoredTabs {
        return { tabs: [{ url: this.hasContent ? 'https://example.test/' : 'about:blank' }], activeIndex: 0 };
    }

    register() {}
    unregister() {}
    destroy() {}
}

type Artifacts = HTMLElement & {
    _activeTab: string;
    _browser: BrowserFixture;
    _browserVisible: boolean;
    _browserRestoreState: RestoredTabs | null;
    switchToTab(tab: 'workspace' | 'browser'): void;
    forceBrowserActive(): void;
    ensureBrowserReady(autoSwitch?: boolean): void;
    exitPreview(): void;
    suspendPreviewLayout(): void;
    recycleBrowser(): void;
    restoreSelectedBrowser(): void;
    consumeInitialBrowserAutoReveal(): boolean;
    markPendingBrowserAutoReveal(): void;
    applyPendingBrowserAutoReveal(): boolean;
    browserHasActiveWebviewFocus(): boolean;
};

let nextTaskId = 0;

describe('task artifacts first Browser Use after a manual preview', () => {
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
                mount() {}
                closeEditor() {}
                setDirectoryBrowserVisible() {}
                stopWatchingFile() {}
                isEditorOpen() {
                    return false;
                }
            },
            getFileExplorerCSS: () => '',
            isHtmlFile: () => false
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({ EmbeddedBrowser: BrowserFixture }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await import('../../../renderer/components/taskartifacts.ts');
    });

    beforeEach(() => {
        jest.useFakeTimers();
        window.setTimeout = globalThis.setTimeout;
        window.clearTimeout = globalThis.clearTimeout;
        window.setInterval = globalThis.setInterval;
        window.clearInterval = globalThis.clearInterval;
    });

    afterEach(() => {
        document.querySelectorAll('task-artifacts').forEach((artifacts) => artifacts.remove());
        document.body.replaceChildren();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    function createArtifacts(visibility: 'foreground' | 'background' | 'hidden' = 'foreground') {
        const taskView = document.createElement('task-view');
        if (visibility === 'background') taskView.setAttribute('data-background', '1');
        if (visibility === 'hidden') taskView.style.display = 'none';
        const artifacts = document.createElement('task-artifacts') as Artifacts;
        artifacts.setAttribute('task-id', `first-use-preview-${++nextTaskId}`);
        taskView.appendChild(artifacts);
        document.body.appendChild(taskView);
        return { artifacts, taskView };
    }

    test.each(['workspace', 'collapsed'] as const)(
        'previewing an empty Browser and returning to %s leaves the actual first-use opportunity available',
        (nextLayout) => {
            const { artifacts } = createArtifacts();
            artifacts.switchToTab('browser');
            artifacts._browser.publishContent(false);
            if (nextLayout === 'workspace') artifacts.exitPreview();
            else {
                artifacts.suspendPreviewLayout();
                artifacts.style.display = 'none';
            }

            expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(true);
            expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(false);
        }
    );

    test('a visible restored document counts as already shown and never reclaims layout after leaving', () => {
        const { artifacts } = createArtifacts();
        artifacts._browserVisible = true;
        artifacts._browserRestoreState = { tabs: [{ url: 'https://example.test/restored' }], activeIndex: 0 };
        artifacts.switchToTab('browser');
        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(true);
        artifacts.exitPreview();
        artifacts._browser.publishContent(true);

        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(false);
        expect(artifacts._activeTab).toBe('workspace');
        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
    });

    test('real content arriving in a visible Browser marks it as shown without repeatedly reclaiming layout', () => {
        const { artifacts } = createArtifacts();
        artifacts.forceBrowserActive();
        artifacts._browser.publishContent(false);
        expect(artifacts._activeTab).toBe('browser');
        expect(artifacts._browserVisible).toBe(true);
        artifacts._browser.publishContent(true);
        artifacts.exitPreview();
        artifacts._browser.publishContent(true);

        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(false);
        expect(artifacts._activeTab).toBe('workspace');
        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
    });

    test.each(['background', 'hidden'] as const)(
        '%s restored content is not counted as a document presented to the user',
        (visibility) => {
            const { artifacts } = createArtifacts(visibility);
            artifacts._browserVisible = true;
            artifacts._browserRestoreState = { tabs: [{ url: 'https://example.test/restored' }], activeIndex: 0 };
            artifacts.switchToTab('browser');
            artifacts._browser.publishContent(true);
            artifacts.restoreSelectedBrowser();

            expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(true);
            expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
            expect(artifacts.browserHasActiveWebviewFocus()).toBe(false);
            expect(artifacts._browser.hasActiveWebviewFocus).not.toHaveBeenCalled();
        }
    );

    test.each(['existing', 'recycled'] as const)(
        'returning to %s Browser content loaded in the background records it before the user leaves',
        (browserState) => {
            const { artifacts, taskView } = createArtifacts();
            artifacts.switchToTab('browser');
            artifacts.suspendPreviewLayout();
            taskView.style.display = 'none';
            artifacts._browser.publishContent(true);
            if (browserState === 'recycled') artifacts.recycleBrowser();

            taskView.style.display = '';
            artifacts.restoreSelectedBrowser();
            artifacts.exitPreview();

            expect(artifacts._activeTab).toBe('workspace');
            expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(false);
            expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
        }
    );

    test('recycling a background blank Browser does not consume the task reveal', () => {
        const { artifacts, taskView } = createArtifacts('background');
        artifacts.forceBrowserActive();
        artifacts.switchToTab('browser');
        artifacts.recycleBrowser();
        artifacts.restoreSelectedBrowser();
        artifacts._browser.publishContent(false);
        taskView.removeAttribute('data-background');
        artifacts.exitPreview();

        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(true);
    });

    test('content that arrives after leaving a blank Browser is still eligible for the actual first tool use', () => {
        const { artifacts } = createArtifacts();
        artifacts.switchToTab('browser');
        artifacts.exitPreview();
        artifacts._browser.publishContent(true);

        expect(artifacts._activeTab).toBe('workspace');
        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(true);
        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
    });

    test('recording visible content does not consume an already claimed pending reveal', () => {
        const { artifacts } = createArtifacts();
        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(true);
        artifacts.markPendingBrowserAutoReveal();
        artifacts.forceBrowserActive();
        artifacts._browser.publishContent(false);
        artifacts._browser.publishContent(true);
        artifacts.restoreSelectedBrowser();

        expect(artifacts.consumeInitialBrowserAutoReveal()).toBe(false);
        expect(artifacts.applyPendingBrowserAutoReveal()).toBe(true);
        expect(artifacts.applyPendingBrowserAutoReveal()).toBe(false);
    });
});
