import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

describe('setting-panel update section download progress', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
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

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        delete (window as { updateAPI?: unknown }).updateAPI;
        window.notificationAPI = {
            sendNotification: jest.fn(async () => undefined)
        };
    });

    function createPanel(locale: string = 'zh-CN') {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale,
            resolved_locale: locale,
            gui_config: {},
            debug: {},
            environ: {},
            applications: {},
            providers: [],
            models: []
        };
        panel.gatewayHostOptions = [];
        panel.appVersion = '0.3.7';
        panel._t = createRendererTranslator(panel.currentData);
        return panel;
    }

    function renderUpdateStatus(panel: any): string {
        panel.innerHTML = panel.renderUpdateSection();
        return panel.querySelector('.sp-toggle-desc')?.textContent?.trim() || '';
    }

    test('downloading state shows the received percentage against total bytes', () => {
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 4200, totalBytes: 10000 };

        const status = renderUpdateStatus(panel);

        expect(status).toContain('0.3.8');
        expect(status).toContain('(42%)');
    });

    test('downloading state caps the percentage at 100 when bytes exceed the total', () => {
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 11000, totalBytes: 10000 };

        expect(renderUpdateStatus(panel)).toContain('(100%)');
    });

    test('downloading state omits the percentage when the total size is unknown', () => {
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 4200 };

        const status = renderUpdateStatus(panel);

        expect(status).toContain('0.3.8');
        expect(status).not.toContain('%');
    });

    test('the same progress renders in the English locale', () => {
        const panel = createPanel('en-US');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 500, totalBytes: 10000 };

        const status = renderUpdateStatus(panel);

        expect(status).toContain('Downloading 0.3.8');
        expect(status).toContain('(5%)');
    });

    // 「查看版本说明」按钮：查看场景只展示更新内容，不落 whats-new-seen.json 账
    function mockNotesApi() {
        const api = {
            getReleaseNotes: jest.fn(async (version: string) => ({
                version,
                notes: `# OpenDesk ${version} 更新内容\n\n- 条目`
            })),
            dismissReleaseNotes: jest.fn(async () => true)
        };
        (window as unknown as { updateAPI: unknown }).updateAPI = api;
        return api;
    }

    test('idle state renders only the current-notes button', () => {
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'idle' };
        panel.innerHTML = panel.renderUpdateSection();

        expect(panel.querySelector('#view-current-release-notes')).not.toBeNull();
        expect(panel.querySelector('#view-latest-release-notes')).toBeNull();
    });

    test('a state with a pending version renders both notes buttons', () => {
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 10 };
        panel.innerHTML = panel.renderUpdateSection();

        expect(panel.querySelector('#view-current-release-notes')).not.toBeNull();
        expect(panel.querySelector('#view-latest-release-notes')).not.toBeNull();
    });

    test('viewing current version notes fetches by appVersion and never records seen', async () => {
        const api = mockNotesApi();
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'idle' };
        panel.innerHTML = panel.renderUpdateSection();
        panel._bindUpdateEvent();

        panel.querySelector('#view-current-release-notes').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(api.getReleaseNotes).toHaveBeenCalledWith('0.3.7');
        expect(api.dismissReleaseNotes).not.toHaveBeenCalled();
        const overlay = panel.querySelector('.od-confirm-modal-overlay');
        expect(overlay?.textContent).toContain('OpenDesk 0.3.7 更新内容');
    });

    test('viewing latest version notes fetches by the pending version', async () => {
        const api = mockNotesApi();
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'downloading', version: '0.3.8', receivedBytes: 10 };
        panel.innerHTML = panel.renderUpdateSection();
        panel._bindUpdateEvent();

        panel.querySelector('#view-latest-release-notes').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(api.getReleaseNotes).toHaveBeenCalledWith('0.3.8');
        expect(api.dismissReleaseNotes).not.toHaveBeenCalled();
        const overlay = panel.querySelector('.od-confirm-modal-overlay');
        expect(overlay?.textContent).toContain('OpenDesk 0.3.8 更新内容');
    });

    test('a notes fetch failure still opens the modal with the generic placeholder', async () => {
        const api = mockNotesApi();
        api.getReleaseNotes.mockRejectedValueOnce(new Error('offline'));
        const panel = createPanel('zh-CN');
        panel.updateState = { status: 'idle' };
        panel.innerHTML = panel.renderUpdateSection();
        panel._bindUpdateEvent();

        panel.querySelector('#view-current-release-notes').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(api.dismissReleaseNotes).not.toHaveBeenCalled();
        const paragraph = panel.querySelector('.od-whats-new-paragraph');
        expect(paragraph?.textContent).toBe('本次更新包含稳定性与性能优化。');
    });
});
