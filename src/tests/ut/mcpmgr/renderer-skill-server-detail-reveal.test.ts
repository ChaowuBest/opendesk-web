import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import type { McpServerState } from '../../../main/applications/mcpmgr/common.js';

function skillServer(overrides: Partial<McpServerState> = {}): McpServerState {
    return {
        id: 'pluginskill_a',
        name: 'fs',
        transport: 'stdio',
        enabled: true,
        status: 'error',
        pluginId: 'p1',
        pluginSkillName: 's1',
        readOnly: true,
        tools: [],
        ...overrides
    } as McpServerState;
}

/** 等待内部 server 的懒加载 reveal 链路（reveal → loadServers → 更新判断）跑完 */
async function flushReveal(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MCP manager 内部 server 详情的懒加载 reveal', () => {
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

    let getServersForUI: jest.Mock;
    let reveal: jest.Mock;

    beforeEach(() => {
        document.body.innerHTML = '';
        getServersForUI = jest.fn();
        reveal = jest.fn();
        (window as any).applicationAPI = {
            call: jest.fn(),
            callMainWorld: (method: string) => {
                if (method === 'getServersForUI') return getServersForUI();
                if (method === 'revealPluginSkillServers') return reveal();
                return undefined;
            },
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    /** 挂载 widget 并等 connectedCallback 的初始加载跑完，避免其非静默 render 冲掉测试中打开的弹窗 */
    async function createWidget(servers: McpServerState[]) {
        getServersForUI.mockResolvedValue(servers);
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.activeTab = 'builtin';
        widget.servers = servers;
        widget.render();
        document.body.appendChild(widget);
        await flushReveal();
        return widget;
    }

    test('详情弹窗关闭后 reveal 完成不得复活弹窗', async () => {
        reveal.mockResolvedValue(undefined);
        const widget = await createWidget([skillServer()]);

        widget.showServerDetail('pluginskill_a');
        expect(widget.shadowRoot.getElementById('detail-overlay')).not.toBeNull();

        // 用户在懒加载完成前关闭弹窗
        widget.removeDetailDialog();
        await flushReveal();

        // selectedServerId 残留但弹窗已不在 DOM：不得走 showDetailDialog 的新建分支复活弹窗
        expect(widget.selectedServerId).toBe('pluginskill_a');
        expect(widget.shadowRoot.getElementById('detail-overlay')).toBeNull();
    });

    test('弹窗保持打开时 reveal 完成就地更新且不重建弹窗', async () => {
        const widget = await createWidget([skillServer()]);
        getServersForUI.mockResolvedValue([
            skillServer({ status: 'connected', tools: [{ name: 'read', description: 'd' }] })
        ]);
        reveal.mockResolvedValue(undefined);

        widget.showServerDetail('pluginskill_a');
        const dialog = widget.shadowRoot.getElementById('detail-overlay') as HTMLElement;
        expect(dialog).not.toBeNull();

        await flushReveal();

        // 骨架不重建（同一元素），内容已反映连接后的最新状态
        expect(widget.shadowRoot.getElementById('detail-overlay')).toBe(dialog);
        expect(dialog.textContent).toContain('read');
    });
});
