import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('MCP manager batch selection and local refresh', () => {
    const showConfirmModalMock = jest.fn(async () => true);
    let getServers: jest.Mock;
    let callMainWorld: jest.Mock;

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
            IntersectionObserver: class {
                observe() {}
                disconnect() {}
                unobserve() {}
            },
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
            confirmModalMockShim({ showConfirmModal: showConfirmModalMock })
        );

        await import('../../../main/applications/mcpmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        showConfirmModalMock.mockClear();
        getServers = jest.fn(async () => serversFixture());
        callMainWorld = jest.fn(async (method: string, ...args: unknown[]) => {
            if (method === 'getServersForUI') return serversFixture();
            if (method === 'deleteServers' || method === 'setServersEnabled') {
                return { changed: (args[0] as string[]).length, failed: [] };
            }
            return undefined;
        });
        (window as any).applicationAPI = {
            call: jest.fn(),
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    function serversFixture() {
        return [
            { id: 's1', name: 'Alpha', transport: 'stdio', enabled: true, status: 'connected', tools: [] },
            { id: 's2', name: 'Beta', transport: 'stdio', enabled: true, status: 'connected', tools: [] },
            {
                id: 's3',
                name: 'ReadOnly',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [],
                readOnly: true,
                source: 'plugin'
            }
        ];
    }

    function createWidget() {
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.activeTab = 'installed';
        widget.servers = serversFixture();
        widget.render();
        return widget;
    }

    function checkboxes(widget: any): any[] {
        return [...widget.shadowRoot.querySelectorAll('[data-batch-check]')];
    }

    function toggleCheckbox(widget: any, id: string, checked: boolean) {
        const input = widget.shadowRoot.querySelector(`[data-batch-check="${id}"]`) as any;
        input.checked = checked;
        // 真实浏览器的 change 事件会冒泡到面板根节点，批量委托依赖这一点
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        return input;
    }

    test('read-only entries get no checkbox so they can never enter a batch action', () => {
        const widget = createWidget();
        expect(widget.shadowRoot.querySelector('[data-server-id="s1"] [data-batch-check]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-server-id="s3"] [data-batch-check]')).toBeNull();
        expect(checkboxes(widget)).toHaveLength(2);
    });

    test('selecting cards fills the tray and the ⋯ badge without rebuilding the tray node', () => {
        const widget = createWidget();
        toggleCheckbox(widget, 's1', true);
        const tray = widget.shadowRoot.querySelector('.batch-tray') as HTMLElement;
        expect(tray).not.toBeNull();
        expect(tray.querySelectorAll('.tray-chip')).toHaveLength(1);

        toggleCheckbox(widget, 's2', true);
        const trayAfter = widget.shadowRoot.querySelector('.batch-tray') as HTMLElement;
        // 托盘节点复用，避免每次勾选重播入场动画（闪烁）
        expect(trayAfter).toBe(tray);
        expect(trayAfter.querySelectorAll('.tray-chip')).toHaveLength(2);
        expect(trayAfter.querySelector('.tray-label')?.textContent).toContain('2');
        expect(widget.shadowRoot.querySelector('.more-btn .more-badge')?.textContent).toBe('2');
    });

    test('tray chip removal and clear drop the selection back to empty', () => {
        const widget = createWidget();
        toggleCheckbox(widget, 's1', true);
        toggleCheckbox(widget, 's2', true);

        (widget.shadowRoot.querySelector('[data-tray-remove="s1"]') as HTMLElement).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );
        expect(widget.shadowRoot.querySelectorAll('.batch-tray .tray-chip')).toHaveLength(1);
        expect((widget.shadowRoot.querySelector('[data-batch-check="s1"]') as any).checked).toBe(false);

        (widget.shadowRoot.querySelector('[data-tray-clear]') as HTMLElement).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );
        expect(widget.shadowRoot.querySelector('.batch-tray')).toBeNull();
        expect(widget.shadowRoot.querySelector('.more-btn .more-badge')).toBeNull();
    });

    test('batch delete asks once and deletes every selected server through one batch call', async () => {
        const widget = createWidget();
        toggleCheckbox(widget, 's1', true);
        toggleCheckbox(widget, 's2', true);

        widget.showBatchMenu = true;
        widget.render();
        (widget.shadowRoot.querySelector('[data-batch-action="delete-sel"]') as HTMLElement).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(showConfirmModalMock).toHaveBeenCalledTimes(1);
        const batchCalls = callMainWorld.mock.calls.filter((call) => call[0] === 'deleteServers');
        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0][1]).toEqual(['s1', 's2']);
        // 单条接口不再被逐条调用
        expect(callMainWorld.mock.calls.filter((call) => call[0] === 'deleteServer')).toHaveLength(0);
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(widget.shadowRoot.querySelector('.batch-tray')).toBeNull();
    });

    test('batch enable goes through one batch call and skips already enabled entries', async () => {
        const widget = createWidget();
        widget.servers[0].enabled = false;
        widget.render();
        toggleCheckbox(widget, 's1', true);
        toggleCheckbox(widget, 's2', true);

        widget.showBatchMenu = true;
        widget.render();
        (widget.shadowRoot.querySelector('[data-batch-action="enable-sel"]') as HTMLElement).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        const batchCalls = callMainWorld.mock.calls.filter((call) => call[0] === 'setServersEnabled');
        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0][1]).toEqual(['s1']);
        expect(batchCalls[0][2]).toBe(true);
    });

    test('installed search swaps only the result area and keeps the selection tray mounted', async () => {
        const widget = createWidget();
        toggleCheckbox(widget, 's1', true);
        const tray = widget.shadowRoot.querySelector('.batch-tray') as HTMLElement;
        const body = widget.shadowRoot.querySelector('#panel-installed .panel-body') as HTMLElement;

        const input = widget.shadowRoot.querySelector('[data-search-tab="installed"]') as any;
        input.value = 'beta';
        input.dispatchEvent(new window.Event('input'));
        (widget.shadowRoot.querySelector('[data-search-btn="installed"]') as HTMLElement).dispatchEvent(
            new window.Event('click')
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(widget.shadowRoot.querySelector('#panel-installed .panel-body')).toBe(body);
        expect(widget.shadowRoot.querySelector('.batch-tray')).toBe(tray);
        expect(body.textContent).toContain('Beta');
        expect(body.textContent).not.toContain('Alpha');
    });

    test('a background servers update keeps the scroll position, a search resets it', async () => {
        const widget = createWidget();
        const panel = widget.shadowRoot.getElementById('panel-installed') as HTMLElement;
        panel.scrollTop = 120;

        // 后台推送（连接状态变化）只换内容，不把用户正在看的位置顶走
        await widget.loadServers({ silent: true });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(panel.scrollTop).toBe(120);

        // 搜索改变了结果集，才回到顶部
        const input = widget.shadowRoot.querySelector('[data-search-tab="installed"]') as any;
        input.value = 'beta';
        input.dispatchEvent(new window.Event('input'));
        (widget.shadowRoot.querySelector('[data-search-btn="installed"]') as HTMLElement).dispatchEvent(
            new window.Event('click')
        );
        expect(panel.scrollTop).toBe(0);
    });

    test('an empty installed search box ignores the clear button', () => {
        const widget = createWidget();
        let renders = 0;
        const originalRender = widget.render.bind(widget);
        widget.render = () => {
            renders += 1;
            originalRender();
        };
        (widget.shadowRoot.querySelector('[data-clear-tab="installed"]') as HTMLElement).dispatchEvent(
            new window.Event('click')
        );
        expect(renders).toBe(0);
    });

    test('refresh spins only the toolbar button and keeps the panel and tray mounted', async () => {
        const widget = createWidget();
        toggleCheckbox(widget, 's1', true);
        const panel = widget.shadowRoot.getElementById('panel-installed');
        const tray = widget.shadowRoot.querySelector('.batch-tray');
        expect(tray).not.toBeNull();

        let resolveServers: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation((method: string) => {
            if (method === 'getServersForUI') {
                return new Promise((resolve) => {
                    resolveServers = resolve;
                });
            }
            return Promise.resolve(undefined);
        });

        const refreshBtn = widget.shadowRoot.querySelector('#refresh-btn') as any;
        refreshBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 刷新期间：只有按钮进入忙碌态，面板与已选托盘原地不动
        expect(refreshBtn.disabled).toBe(true);
        expect(refreshBtn.querySelector('.mini-spinner')).not.toBeNull();
        expect(widget.shadowRoot.getElementById('panel-installed')).toBe(panel);
        expect(widget.shadowRoot.querySelector('.batch-tray')).toBe(tray);
        expect(widget.shadowRoot.querySelector('#panel-installed .loading-state')).toBeNull();

        resolveServers(serversFixture());
        await new Promise((resolve) => setTimeout(resolve, 220));

        const btnAfter = widget.shadowRoot.querySelector('#refresh-btn') as any;
        expect(btnAfter.disabled).toBe(false);
        expect(btnAfter.innerHTML).toContain('↻');
        expect(widget.shadowRoot.getElementById('panel-installed')).toBe(panel);
    });
});
