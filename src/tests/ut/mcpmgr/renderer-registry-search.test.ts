import fs from 'fs';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('MCP manager registry search experience', () => {
    const showConfirmModalMock = jest.fn(async () => true);
    let callMainWorld: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        // 断言文案取自 zh-CN 词条；Node 的全局 navigator.language 随运行环境解析
        //（本地中文环境得 zh-CN，英文 CI 得 en-US），不锁定会让「刷新中」断言在英文环境翻转
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
        (window as any).applicationAPI = {
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

    function createWidget(
        results = [mcp('a', 'Alpha'), mcp('b', 'Beta')],
        message: any = { text: '显示 2 / 10 个结果', isError: false }
    ) {
        const widget = document.createElement('mcpmgr-entry-widget') as any;
        widget.loadingServers = false;
        widget.registries = [{ id: 'matrix', label: 'Matrix', icon: '◎', slogan: '' }];
        widget.activeTab = 'matrix';
        widget.registryState = {
            query: '',
            results,
            total: 10,
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

    test('searching keeps the previous results mounted and shows progress in the count slot', async () => {
        const widget = createWidget();
        const body = widget.shadowRoot.querySelector('#panel-registry .registry-body') as HTMLElement;
        const gridBefore = widget.shadowRoot.querySelector('#panel-registry .mcp-grid');
        expect(gridBefore).not.toBeNull();

        let resolveSearch: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation((method: string) => {
            if (method === 'searchMcpRegistry') {
                return new Promise((resolve) => {
                    resolveSearch = resolve;
                });
            }
            return Promise.resolve(undefined);
        });

        const pending = widget.searchRegistry('alp', 1);
        // 搜索期间：旧结果仍在，计数处显示转圈与「刷新中」，不出现整块 loading
        expect(widget.shadowRoot.querySelector('#panel-registry .mcp-grid')).toBe(gridBefore);
        expect(widget.shadowRoot.querySelector('#panel-registry .loading-state')).toBeNull();
        const count = widget.shadowRoot.querySelector('#panel-registry .search-count') as HTMLElement;
        expect(count).not.toBeNull();
        expect(count.querySelector('.mini-spinner')).not.toBeNull();
        expect(count.textContent).toContain('刷新中');
        expect((widget.shadowRoot.querySelector('#panel-registry .search-btn') as HTMLButtonElement).disabled).toBe(
            true
        );

        resolveSearch({ mcps: [mcp('c', 'Gamma')], total: 1, hasMore: false, message: '显示 1 / 1 个结果' });
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(widget.shadowRoot.querySelector('#panel-registry .registry-body')).toBe(body);
        const countAfter = widget.shadowRoot.querySelector('#panel-registry .search-count') as HTMLElement;
        expect(countAfter.textContent).toContain('显示 1 / 1 个结果');
        expect(countAfter.querySelector('.mini-spinner')).toBeNull();
        expect(widget.shadowRoot.querySelector('#panel-registry .mcp-grid')?.textContent).toContain('Gamma');
        expect(widget.shadowRoot.querySelector('#panel-registry .mcp-grid')?.textContent).not.toContain('Alpha');
    });

    test('registry errors render as a prominent content-area error state instead of inside the input', async () => {
        const widget = createWidget([mcp('a', 'Alpha')], null);
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'searchMcpRegistry') throw new Error('boom');
            return undefined;
        });

        await widget.searchRegistry('x', 1);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // 错误以内容区醒目错误态呈现（不再画在输入框里，也不退回「未找到 MCP」空态）
        const errorState = widget.shadowRoot.querySelector('#panel-registry .registry-error-state');
        expect(errorState).not.toBeNull();
        expect(errorState?.closest('.registry-body')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('#panel-registry .search-count')).toBeNull();
        expect(widget.shadowRoot.querySelector('#panel-registry .registry-body')?.textContent).not.toContain(
            '未找到 MCP'
        );
    });

    test('an empty registry search box ignores the clear button', () => {
        const widget = createWidget();
        (widget.shadowRoot.querySelector('[data-clear-tab="matrix"]') as HTMLElement).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );
        expect(callMainWorld).not.toHaveBeenCalledWith('searchMcpRegistry', expect.anything());
    });

    test('results that arrive during the fade are not overwritten by a stale snapshot', async () => {
        const widget = createWidget();
        // 触发一次局部替换（例如搜索结果回来，进入 120ms 淡出窗口）
        widget.syncRegistryPanel({ fade: true });
        // 淡出期间又拿到新一页数据（loadMore 追加）
        widget.registryState.results = [mcp('a', 'Alpha'), mcp('b', 'Beta'), mcp('c', 'Gamma')];

        await new Promise((resolve) => setTimeout(resolve, 200));

        // 替换内容必须在定时器触发时才生成，否则旧快照会把新结果覆盖掉
        expect(widget.shadowRoot.querySelector('#panel-registry .mcp-grid')?.textContent).toContain('Gamma');
    });

    test('the panel layout keeps the tightened hero spacing and inline count styles', () => {
        const source = fs
            .readFileSync(new URL('../../../main/applications/mcpmgr/renderer/entry.ts', import.meta.url), 'utf8')
            .replace(/\r\n/g, '\n');
        expect(source).toContain('padding: 6px 20px 20px');
        expect(source).not.toContain('padding: 28px 20px 24px');
        expect(source).toContain('.search-input:placeholder-shown ~ .search-clear { display: none; }');
        expect(source).toContain('.registry-body, .panel-body { transition: opacity 0.18s ease; }');
        expect(source).toContain('.search-input-wrap.has-count .search-input { padding-right: 196px; }');
    });
});
