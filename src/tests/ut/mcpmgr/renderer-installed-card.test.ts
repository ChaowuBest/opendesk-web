import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('MCP manager installed card labels', () => {
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
        window.applicationAPI = {
            call: jest.fn(),
            callMainWorld: jest.fn(),
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    function createWidget(servers: unknown[]) {
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.activeTab = 'installed';
        widget.servers = servers;
        widget.render();
        return widget;
    }

    test('市场安装的 server 用 displayName 展示，技术名保持不变', () => {
        const widget = createWidget([
            {
                id: 'mcp_1',
                name: 'tyc-mcp',
                displayName: '天眼查MCP',
                transport: 'stdio',
                enabled: true,
                command: 'npx',
                args: ['-y', 'mcp-remote', 'https://mcp.tianyancha.com/v1'],
                status: 'disconnected',
                tools: []
            }
        ]);

        const card = widget.shadowRoot.querySelector('.installed-card') as HTMLElement;
        expect(card.querySelector('.card-title')?.textContent).toBe('天眼查MCP');

        // 详情里仍能查到技术名，便于排查配置
        card.dispatchEvent(new window.Event('click'));
        const overlay = widget.shadowRoot.getElementById('detail-overlay') as HTMLElement;
        expect(overlay.querySelector('.detail-name')?.textContent).toBe('天眼查MCP');
        expect(overlay.querySelector('.detail-id')?.textContent).toBe('tyc-mcp');
    });

    test('没有 displayName 时回退到 name', () => {
        const widget = createWidget([
            {
                id: 'mcp_2',
                name: 'fetch',
                transport: 'stdio',
                enabled: true,
                command: 'uvx',
                args: ['mcp-server-fetch'],
                status: 'connected',
                tools: []
            }
        ]);

        const card = widget.shadowRoot.querySelector('.installed-card') as HTMLElement;
        expect(card.querySelector('.card-title')?.textContent).toBe('fetch');
    });

    test('搜索能命中展示名', () => {
        const widget = createWidget([
            {
                id: 'mcp_1',
                name: 'tyc-mcp',
                displayName: '天眼查MCP',
                transport: 'stdio',
                enabled: true,
                command: 'npx',
                status: 'disconnected',
                tools: []
            }
        ]);
        widget.installedQuery = '天眼';
        widget.render();

        expect(widget.shadowRoot.querySelectorAll('.installed-card')).toHaveLength(1);
    });
});
