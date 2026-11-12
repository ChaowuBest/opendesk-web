import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

// macOS 一期手动安装：ready 态由用户打开 DMG 完成，与 Windows 的后台安装走不同文案与交互
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const WINDOWS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function setNavigatorUserAgent(userAgent: string): void {
    Object.defineProperty(globalThis, 'navigator', {
        value: { languages: ['zh-CN'], language: 'zh-CN', userAgent },
        configurable: true
    });
}

describe('setting-panel update section manual install rendering', () => {
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
        setNavigatorUserAgent(MAC_USER_AGENT);

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        setNavigatorUserAgent(MAC_USER_AGENT);
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

    function renderReadySection(panel: any) {
        panel.updateState = {
            status: 'ready',
            version: '0.3.8',
            installerPath: '/cache/opendesk-darwin-arm64-0.3.8.dmg',
            activeTaskCount: 0
        };
        panel.innerHTML = panel.renderUpdateSection();
        return {
            statusText: panel.querySelector('.sp-toggle-desc')?.textContent?.trim() || '',
            action: panel.querySelector('#software-update-action') as HTMLButtonElement
        };
    }

    test('ready on macOS shows manual install guidance with an enabled open-installer button', () => {
        const panel = createPanel('zh-CN');
        const { statusText, action } = renderReadySection(panel);

        expect(statusText).toContain('0.3.8');
        expect(statusText).toContain('手动安装');
        expect(action.textContent).toContain('打开安装包');
        expect(action.disabled).toBe(false);
    });

    test('ready on non-macOS keeps the background installation copy', () => {
        setNavigatorUserAgent(WINDOWS_USER_AGENT);
        const panel = createPanel('zh-CN');
        const { statusText, action } = renderReadySection(panel);

        expect(statusText).toContain('等待后台安装');
        expect(action.disabled).toBe(true);
    });

    test('the manual install guidance renders in the English locale', () => {
        const panel = createPanel('en-US');
        const { statusText, action } = renderReadySection(panel);

        expect(statusText).toContain('manually');
        expect(action.textContent).toContain('Open Installer');
    });

    test('clicking the action opens the downloaded dmg instead of re-checking', async () => {
        const panel = createPanel('zh-CN');
        const { action } = renderReadySection(panel);
        panel._bindUpdateEvent();
        const openInstaller = jest.fn(async () => true);
        const check = jest.fn(async () => ({ status: 'ready' }));
        (window as unknown as { updateAPI: unknown }).updateAPI = { openInstaller, check };

        action.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(openInstaller).toHaveBeenCalledTimes(1);
        expect(check).not.toHaveBeenCalled();
    });
});
