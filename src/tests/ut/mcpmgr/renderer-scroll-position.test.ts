import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('MCP manager installed list scroll position', () => {
    let getServers: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            CSS: { escape: (value: string) => value },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });

        await jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends HTMLElement {},
            RendererTool: class {},
            RendererToolset: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn(),
                bindOverlayDismiss: jest.fn()
            })
        );

        await import('../../../main/applications/mcpmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        getServers = jest.fn();
        window.applicationAPI = {
            call: jest.fn(),
            callMainWorld: (method: string) => {
                if (method === 'getServersForUI') return getServers();
                return undefined;
            },
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    function createWidget() {
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.activeTab = 'installed';
        widget.servers = [
            {
                id: 'server-1',
                name: 'Server 1',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: []
            }
        ];
        widget.render();
        return widget;
    }

    test('restores the installed panel position after a full render', () => {
        const widget = createWidget();
        const previousPanel = widget.shadowRoot.getElementById('panel-installed') as HTMLElement;
        previousPanel.scrollTop = 240;

        widget.servers[0].status = 'error';
        widget.render();

        const nextPanel = widget.shadowRoot.getElementById('panel-installed') as HTMLElement;
        expect(nextPanel).not.toBe(previousPanel);
        expect(nextPanel.scrollTop).toBe(240);
    });

    test('keeps the existing list mounted while refreshed server data is pending', async () => {
        const widget = createWidget();
        const previousPanel = widget.shadowRoot.getElementById('panel-installed') as HTMLElement;
        previousPanel.scrollTop = 320;
        let resolveServers: (servers: unknown[]) => void = () => undefined;
        getServers.mockReturnValue(
            new Promise((resolve) => {
                resolveServers = resolve;
            })
        );

        const refresh = widget.loadServers();

        expect(widget.shadowRoot.getElementById('panel-installed')).toBe(previousPanel);
        resolveServers([
            {
                id: 'server-1',
                name: 'Server 1',
                transport: 'stdio',
                enabled: true,
                status: 'disconnected',
                tools: []
            }
        ]);
        await refresh;

        expect(widget.shadowRoot.getElementById('panel-installed').scrollTop).toBe(320);
    });

    test('shows agent-provided servers without mutable configuration controls', () => {
        const widget = createWidget();
        widget.servers = [
            {
                id: 'agent-server',
                name: 'Agent Server',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [],
                source: 'Agent',
                agentIds: ['/agents/alpha']
            }
        ];
        widget.render();

        expect(widget.shadowRoot.querySelector('.installed-card')?.textContent).toContain('Agent');
        expect(widget.shadowRoot.querySelector('[data-toggle-id]')).toBeNull();

        widget.shadowRoot.querySelector('.installed-card')?.dispatchEvent(new window.Event('click'));
        expect(widget.shadowRoot.querySelector('#detail-edit')).toBeNull();
        expect(widget.shadowRoot.querySelector('#detail-delete')).toBeNull();
        expect(widget.shadowRoot.querySelector('#detail-reconnect')).not.toBeNull();
    });

    test('renders provider-owned MCP servers without mutable controls', () => {
        const widget = createWidget();
        widget.servers[0].readOnly = true;
        widget.servers[0].source = 'Review Helper';
        widget.servers[0].providerId = 'pluginMgr';
        widget.render();

        const card = widget.shadowRoot.querySelector('[data-server-id="server-1"]');
        expect(card.querySelector('[data-toggle-id]')).toBeNull();
        expect(card.innerHTML).toContain('Review Helper');
        expect(card.innerHTML).not.toContain('plugin:review-helper');

        card.dispatchEvent(new window.Event('click'));
        expect(widget.shadowRoot.querySelector('#detail-edit')).toBeNull();
        expect(widget.shadowRoot.querySelector('#detail-delete')).toBeNull();
        expect(widget.shadowRoot.querySelector('#detail-reconnect')).toBeNull();
    });
});
