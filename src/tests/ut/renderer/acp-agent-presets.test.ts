import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

describe('ACP agent preset picker', () => {
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
        (window as any).systemInfo = { platform: 'linux' };

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        (window as any).notificationAPI = {
            sendNotification: jest.fn(async () => undefined)
        };
    });

    function createPanel() {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale: 'zh-CN',
            resolved_locale: 'zh-CN',
            gui_config: {},
            debug: {},
            environ: {},
            applications: {},
            providers: [],
            models: []
        };
        panel.gatewayHostOptions = [];
        panel._t = createRendererTranslator(panel.currentData);
        panel.updateDefaultModelSelects = jest.fn();
        panel.render();
        panel.setUpEventListeners();
        panel._switchTab('agents');
        return panel;
    }

    test('Add Agent opens the recommended catalog before the custom form', () => {
        const panel = createPanel();

        panel.querySelector('#add-acp-agent-btn').dispatchEvent(new Event('click'));

        const cards = panel.querySelectorAll('.acp-agent-preset-btn');
        expect(cards).toHaveLength(6);
        expect(Array.from(cards).map((card: any) => card.textContent)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('GitHub Copilot'),
                expect.stringContaining('Claude Code'),
                expect.stringContaining('Codex CLI')
            ])
        );
        expect(panel.querySelector('.acp-agent-custom-btn')).not.toBeNull();
    });

    test('selecting a preset fills an editable profile with safe defaults', () => {
        const panel = createPanel();
        panel.querySelector('#add-acp-agent-btn').dispatchEvent(new Event('click'));

        panel.querySelector('[data-preset-id="codex-cli"]').dispatchEvent(new Event('click'));

        expect(panel.querySelector('#acp-agent-name').value).toBe('Codex CLI');
        expect(panel.querySelector('#acp-agent-command').value).toBe('npx');
        expect(panel.querySelector('#acp-agent-args').value).toContain('-y');
        expect(panel.querySelector('#acp-agent-args').value).toContain('@zed-industries/codex-acp@latest');
        expect(panel.querySelector('#acp-agent-enabled').hasAttribute('checked')).toBe(true);
        expect(panel.querySelector('#acp-agent-dispatchable').hasAttribute('checked')).toBe(true);
        expect(panel.querySelector('#acp-agent-preset-download-notice').textContent).toContain('首次测试或使用');
    });

    test('custom agents are dispatchable by default without changing saved profiles', () => {
        const panel = createPanel();
        panel.querySelector('#add-acp-agent-btn').dispatchEvent(new Event('click'));

        panel.querySelector('.acp-agent-custom-btn').dispatchEvent(new Event('click'));

        expect(panel.querySelector('#acp-agent-dispatchable').hasAttribute('checked')).toBe(true);

        panel.currentData.applications.acpmgr = {
            agents: [
                {
                    id: 'saved-agent',
                    name: 'Saved Agent',
                    enabled: true,
                    dispatchable: false,
                    transport: { type: 'stdio', command: 'saved-agent', args: [] }
                }
            ]
        };
        panel.showAcpAgentEditModal(0);

        expect(panel.querySelector('#acp-agent-dispatchable').hasAttribute('checked')).toBe(false);
    });
});
