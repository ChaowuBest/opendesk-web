import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { zhCn } from '../../../main/applications/mcpmgr/locale/zh-cn.js';
import { enUs } from '../../../main/applications/mcpmgr/locale/en-us.js';
import { confirmModalMockShim } from '../../confirmModalMock.js';

/* MCP 广场（registry）搜索失败的内容区错误态：
   网络错误必须以醒目块展示在结果区并支持重试，而不是搜索框右端的小字 + 「未找到 MCP」空态 */
describe('MCP manager registry search error state', () => {
    const showConfirmModalMock = jest.fn(async () => true);
    let callMainWorld: jest.Mock;
    let windowRef: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        windowRef = window;
        // 断言文案取自 zh-CN 词条；Node 的全局 navigator.language 随运行环境解析
        Object.defineProperty(globalThis, 'navigator', {
            value: { language: 'zh-CN', languages: ['zh-CN'] },
            configurable: true
        });
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
        callMainWorld = jest.fn(async () => undefined);
        (windowRef as any).applicationAPI = {
            call: jest.fn(),
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    const mcp = (id: string, name: string) => ({
        id,
        name,
        description: `${name} description`,
        source: 'matrix',
        installUrl: `matrix:${id}`,
        canInstall: true
    });

    const NETWORK_ERROR_TEXT = 'fetch failed: getaddrinfo ENOTFOUND matrix.openharmony.cn';

    function createWidget(results: any[] = [], message: any = null) {
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.registries = [{ id: 'matrix', label: 'Matrix', icon: '◎', slogan: '' }];
        widget.activeTab = 'matrix';
        widget.registryState = {
            query: '',
            results,
            total: results.length,
            page: 1,
            hasMore: false,
            searching: false,
            loadingMore: false,
            hasSearched: true,
            message
        };
        widget.render();
        return widget;
    }

    const body = (widget: any) => widget.shadowRoot.querySelector('#panel-registry .registry-body') as HTMLElement;

    test('主进程回传 error 字段时，渲染为内容区醒目错误块', async () => {
        const widget = createWidget([], null);
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'searchMcpRegistry')
                return { mcps: [], total: 0, hasMore: false, error: NETWORK_ERROR_TEXT };
            return undefined;
        });

        await widget.searchRegistry('x', 1);
        await new Promise((resolve) => setTimeout(resolve, 200));

        const errorState = body(widget).querySelector('.registry-error-state');
        expect(errorState).not.toBeNull();
        expect(errorState?.textContent).toContain(zhCn['renderer.mcp.error.networkTitle']);
        expect(errorState?.textContent).toContain(zhCn['renderer.mcp.error.networkHint']);
        expect(errorState?.textContent).toContain('getaddrinfo ENOTFOUND');
        expect(errorState?.querySelector('[data-retry-tab="matrix"]')).not.toBeNull();
        // 不再出现误导性空态文案
        expect(body(widget).textContent).not.toContain(zhCn['renderer.mcp.registry.empty.searched']);
        expect(body(widget).querySelector('.empty-state:not(.registry-error-state)')).toBeNull();
        // 错误不进入搜索框右端计数位
        expect(widget.shadowRoot.querySelector('#panel-registry .search-count')).toBeNull();
    });

    test('IPC 抛错（断网时 worker/桥异常）同样渲染醒目错误块', async () => {
        const widget = createWidget([], null);
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'searchMcpRegistry') throw new Error(NETWORK_ERROR_TEXT);
            return undefined;
        });

        await widget.searchRegistry('x', 1);
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(body(widget).querySelector('.registry-error-state')).not.toBeNull();
        expect(body(widget).textContent).not.toContain(zhCn['renderer.mcp.registry.empty.searched']);
    });

    test('点击重试按钮会重新发起当前注册源的搜索', async () => {
        const widget = createWidget([], { text: NETWORK_ERROR_TEXT, isError: true });
        const retryBtn = body(widget).querySelector('[data-retry-tab="matrix"]') as HTMLElement;
        expect(retryBtn).not.toBeNull();
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'searchMcpRegistry') return { mcps: [mcp('a', 'Alpha')], total: 1, hasMore: false };
            return undefined;
        });

        retryBtn.dispatchEvent(new windowRef.Event('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(callMainWorld).toHaveBeenCalledWith('searchMcpRegistry', 'matrix', '', 1, 30);
        expect(body(widget).querySelector('.registry-error-state')).toBeNull();
        expect(body(widget).textContent).toContain('Alpha');
    });

    test('已有结果时加载更多失败只显示错误横幅，不遮盖结果', async () => {
        const widget = createWidget([mcp('a', 'Alpha')], null);
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'searchMcpRegistry') throw new Error(NETWORK_ERROR_TEXT);
            return undefined;
        });
        widget.registryState.hasMore = true;
        widget.registryState.page = 1;

        await widget.loadMoreRegistry();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(body(widget).querySelector('.registry-msg.error')).not.toBeNull();
        expect(body(widget).querySelector('.registry-msg.error')?.textContent).toContain('getaddrinfo ENOTFOUND');
        expect(body(widget).querySelector('.mcp-grid')?.textContent).toContain('Alpha');
        // 结果没有被清掉
        expect(widget.registryState.results.length).toBe(1);
    });

    test('非错误 message（结果计数）仍然显示在搜索框计数位', () => {
        const widget = createWidget([mcp('a', 'Alpha')], { text: '显示 1 / 10 个结果', isError: false });
        const count = widget.shadowRoot.querySelector('#panel-registry .search-count');
        expect(count?.textContent).toContain('显示 1 / 10 个结果');
        expect(body(widget).querySelector('.registry-error-state')).toBeNull();
    });

    test('新增错误态词条在 zh-CN 与 en-US 中一一对应', () => {
        for (const key of [
            'renderer.mcp.error.networkTitle',
            'renderer.mcp.error.networkHint',
            'renderer.mcp.error.searchTimeout',
            'renderer.mcp.error.retry'
        ]) {
            expect(typeof zhCn[key]).toBe('string');
            expect(typeof enUs[key]).toBe('string');
            expect(zhCn[key]).not.toBe(enUs[key]);
        }
    });
});
