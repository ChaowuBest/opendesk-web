import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { zhCn } from '../../../main/applications/skillmgr/locale/zh-cn.js';
import { enUs } from '../../../main/applications/skillmgr/locale/en-us.js';

/* 技能中心市场（registry）搜索失败的内容区错误态：
   网络错误必须以醒目块展示在结果区并支持重试，而不是搜索框右端的小字 + 「未找到匹配的技能」空态 */
describe('skill center registry search error state', () => {
    let applicationAPICall: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
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
            ResizeObserver: class {
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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () => ({
            showConfirmModal: jest.fn(async () => true),
            bindOverlayDismiss: jest.fn(),
            renderIcon: jest.fn(() => '<i class="mock-icon"></i>')
        }));
        await jest.unstable_mockModule('../../../renderer/components/skills/skill-detail-card.ts', () => ({
            getSkillInitial: () => 'A',
            getSkillPastel: () => ({ bg: '#eee', text: '#333' })
        }));
        await jest.unstable_mockModule('../../../renderer/deferredSubscription.js', () => ({
            adoptDeferredSubscription: jest.fn()
        }));
        await jest.unstable_mockModule('../../../common/markdown/markdown-html-safety.js', () => ({
            neutralizeMarkdownHtml: (html: string) => html
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await jest.unstable_mockModule('../../../main/applications/skillmgr/renderer/duplicateInstallModal.js', () => ({
            showDuplicateInstallModal: jest.fn(async () => null)
        }));

        await import('../../../main/applications/skillmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        applicationAPICall = jest.fn(async () => undefined);
        (window as any).applicationAPI = {
            call: applicationAPICall,
            callMainWorld: jest.fn(async () => undefined),
            streamCall: jest.fn(),
            subscribe: jest.fn(() => () => undefined),
            unsubscribe: jest.fn(),
            sendNotification: jest.fn()
        };
    });

    const NETWORK_ERROR_TEXT = 'fetch failed: getaddrinfo ENOTFOUND api.skillhub.tencent.com';

    function registryState(overrides: Record<string, unknown> = {}) {
        return {
            query: '',
            results: [],
            total: 0,
            searching: false,
            hasSearched: true,
            message: null,
            page: 1,
            hasMore: false,
            loadingMore: false,
            nextCursor: null,
            autoLoaded: true,
            activeFilter: '',
            ...overrides
        };
    }

    function createWidget(skillhubState: Record<string, unknown>) {
        const widget = document.createElement('skillmgr-entry-widget') as any;
        widget.skills = [];
        widget.externalSkills = [];
        widget.builtinSkills = [];
        widget.loading = false;
        widget.error = null;
        widget.activeTab = 'skillhub';
        widget.registryStates['skillhub'] = registryState(skillhubState);
        widget.render();
        return widget;
    }

    const body = (widget: any) => widget.shadowRoot.querySelector('#panel-skillhub .registry-body') as HTMLElement;

    test('网络错误显示醒目错误块，而不是「未找到匹配的技能」空态', () => {
        const widget = createWidget({ message: { text: NETWORK_ERROR_TEXT, isError: true } });
        const errorState = body(widget).querySelector('.registry-error-state');
        expect(errorState).not.toBeNull();
        expect(errorState?.textContent).toContain(zhCn['renderer.skill.error.networkTitle']);
        expect(errorState?.textContent).toContain(zhCn['renderer.skill.error.networkHint']);
        // 原始底层原因以明细展示，便于排查
        expect(errorState?.textContent).toContain('getaddrinfo ENOTFOUND');
        expect(errorState?.querySelector('[data-retry-tab="skillhub"]')).not.toBeNull();
        // 不再出现误导性空态文案
        expect(body(widget).textContent).not.toContain(zhCn['renderer.skill.empty.noMatch']);
        expect(body(widget).querySelector('.empty-state:not(.registry-error-state)')).toBeNull();
    });

    test('错误文本不进入搜索框右端的计数位', () => {
        const widget = createWidget({ message: { text: NETWORK_ERROR_TEXT, isError: true } });
        const count = widget.shadowRoot.querySelector('#panel-skillhub .search-count');
        expect(count).toBeNull();
    });

    test('超时错误复用已有的超时文案', () => {
        const widget = createWidget({
            message: { text: 'Search timed out; check your network and try again', isError: true }
        });
        const errorState = body(widget).querySelector('.registry-error-state');
        expect(errorState?.textContent).toContain(zhCn['renderer.skill.error.searchTimeout']);
    });

    test('非网络错误显示通用失败标题与原始明细', () => {
        const widget = createWidget({ message: { text: '未知 Registry: skillhub', isError: true } });
        const errorState = body(widget).querySelector('.registry-error-state');
        expect(errorState?.textContent).toContain(zhCn['renderer.skill.error.searchFailed']);
        expect(errorState?.textContent).toContain('未知 Registry: skillhub');
    });

    test('点击重试按钮会重新发起当前注册源的搜索', async () => {
        const widget = createWidget({ message: { text: NETWORK_ERROR_TEXT, isError: true } });
        const retryBtn = body(widget).querySelector('[data-retry-tab="skillhub"]') as HTMLElement;
        expect(retryBtn).not.toBeNull();
        retryBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(applicationAPICall).toHaveBeenCalledWith('searchRegistry', 'skillhub', '', 1, 30, null, undefined);
    });

    test('已有结果时加载更多失败只显示错误横幅，不遮盖结果', () => {
        const widget = createWidget({
            results: [
                {
                    id: 'demo',
                    name: 'Demo',
                    description: 'd',
                    source: 'skillhub',
                    installUrl: 'skillhub:demo',
                    canInstall: true
                }
            ],
            total: 1,
            message: { text: NETWORK_ERROR_TEXT, isError: true }
        });
        expect(body(widget).querySelector('.registry-msg.error')).not.toBeNull();
        expect(body(widget).querySelector('.skills-grid')?.textContent).toContain('Demo');
        expect(body(widget).querySelector('.registry-error-state')).toBeNull();
    });

    test('非错误 message（结果计数）仍然显示在搜索框计数位', () => {
        const widget = createWidget({ message: { text: '显示 3 / 10 个结果', isError: false } });
        const count = widget.shadowRoot.querySelector('#panel-skillhub .search-count');
        expect(count?.textContent).toContain('显示 3 / 10 个结果');
        expect(body(widget).querySelector('.registry-error-state')).toBeNull();
    });

    test('新增错误态词条在 zh-CN 与 en-US 中一一对应', () => {
        for (const key of [
            'renderer.skill.error.networkTitle',
            'renderer.skill.error.networkHint',
            'renderer.skill.error.retry'
        ]) {
            expect(typeof zhCn[key as keyof typeof zhCn]).toBe('string');
            expect(typeof enUs[key as keyof typeof enUs]).toBe('string');
            expect(zhCn[key as keyof typeof zhCn]).not.toBe(enUs[key as keyof typeof enUs]);
        }
    });
});
