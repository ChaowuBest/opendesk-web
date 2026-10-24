import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('admin panel rendering', () => {
    let WidgetClass: new () => HTMLElement;
    let adminApi: Record<string, jest.Mock>;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        if (!(window.HTMLElement.prototype as any).getBoundingClientRect) {
            (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 200,
                bottom: 120,
                width: 200,
                height: 120
            });
        }

        const module = await import('../../../main/applications/adminconsole/renderer/entry.js');
        WidgetClass = module.AdminConsoleEntryWidget ?? (window.customElements as any).get('adminconsole-entry-widget');
        if (!WidgetClass) {
            // customElements.define 未暴露类时通过构造探测
            WidgetClass = (window.customElements as any).get('adminconsole-entry-widget');
        }
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        adminApi = {
            getServerUrl: jest.fn(async () => 'https://opendesk.matrix.openharmony.cn'),
            loadToken: jest.fn(async () => ({ token: null, canPersist: true })),
            verifyToken: jest.fn(async () => true),
            clearToken: jest.fn(async () => true),
            getDailyStats: jest.fn(async () => ({
                ok: true,
                days: 7,
                range: { start: '', end: '', today_start: '' },
                points: [
                    { day: '2026-10-03', devices: 3, by_type: { pc: 2, phone: 1 } },
                    { day: '2026-10-04', devices: 5, by_type: { pc: 4, phone: 1 } },
                    { day: '2026-10-05', devices: 8, by_type: { pc: 6, tablet: 2 } }
                ]
            })),
            getSummaryStats: jest.fn(async () => ({
                ok: true,
                total: { devices: 42, by_type: {} },
                last_1d: { devices: 6, by_type: {} },
                last_7d: { devices: 20, by_type: {} }
            })),
            getFeedbackList: jest.fn(async () => ({
                ok: true,
                items: [
                    {
                        id: 1,
                        type: 'bug',
                        content: '打开设置页面崩溃',
                        contact: 'user@example.com',
                        time: '2026-10-08T10:00:00.000Z',
                        attachments: [{ attachment_id: 11, filename: 'log.txt' }]
                    },
                    {
                        id: 2,
                        type: 'feature',
                        content: '希望支持深色模式跟随系统',
                        contact: null,
                        time: '2026-10-07T09:00:00.000Z',
                        attachments: []
                    }
                ]
            })),
            downloadAttachment: jest.fn(async () => ({ canceled: false, filePath: '/tmp/log.txt' }))
        };
        // 应用化后 UI 只经 applicationAPI.callMainWorld 访问 main 侧方法，
        // 这里模拟其 { status, data } / { status, code, message } 返回协议
        (window as any).applicationAPI = {
            callMainWorld: jest.fn(async (methodName: string, ...args: any[]) => {
                const impl = adminApi[methodName];
                if (typeof impl !== 'function') {
                    return { status: 'error', message: `method ${methodName} not found` };
                }
                try {
                    return { status: 'ok', data: await impl(...args) };
                } catch (error: any) {
                    return { status: 'error', code: error.code, message: error.message };
                }
            })
        };
        (window as any).settingAPI = {
            loadSettingObject: jest.fn(async () => ({}))
        };
    });

    /**
     * 逐轮让出微任务直到条件成立。callMainWorld 适配层比直连 IPC 多一层 await，
     * 固定轮数的 await 会随实现层数漂移，这里按条件等待。
     */
    async function waitFor(predicate: () => boolean, rounds = 100): Promise<void> {
        for (let i = 0; i < rounds; i++) {
            if (predicate()) return;
            await Promise.resolve();
        }
    }

    function strings(widget: any): Record<string, string> {
        return {
            'renderer.admin.authTitle': 'Admin authorization required',
            'renderer.admin.authHint': 'Enter the admin token.',
            'renderer.admin.tokenPlaceholder': 'Admin token',
            'renderer.admin.verify': 'Verify & enter',
            'renderer.admin.verifying': 'Verifying…',
            'renderer.admin.tokenRequired': 'Please enter the admin token',
            'renderer.admin.authFailed': 'Token verification failed: ${message}',
            'renderer.admin.authUnauthorized': 'Token is invalid or expired, please enter it again',
            'renderer.admin.persistUnavailable': 'Session only',
            'renderer.admin.tabActivity': 'Activity',
            'renderer.admin.tabFeedback': 'Feedback',
            'renderer.admin.refresh': 'Refresh',
            'renderer.admin.logout': 'Clear authorization',
            'renderer.admin.last7Days': 'Active devices, last 7 days',
            'renderer.admin.tipTotal': 'Total active devices',
            'renderer.admin.totalDevices': 'Total devices',
            'renderer.admin.weekDevices': 'Devices (7d)',
            'renderer.admin.dayDevices': 'Devices (1d)',
            'renderer.admin.loading': 'Loading…',
            'renderer.admin.empty': 'No data',
            'renderer.admin.loadFailed': 'Failed to load: ${message}',
            'renderer.admin.reload': 'Retry',
            'renderer.admin.feedbackFilterAll': 'All',
            'renderer.admin.feedbackFilterFeature': 'Feature',
            'renderer.admin.feedbackFilterBug': 'Bug',
            'renderer.admin.feedbackTypeFeature': 'Feature',
            'renderer.admin.feedbackTypeBug': 'Bug',
            'renderer.admin.feedbackContact': 'Contact',
            'renderer.admin.feedbackAttachments': 'Attachments',
            'renderer.admin.feedbackEmpty': 'No feedback yet',
            'renderer.admin.openAttachment': 'Download attachment',
            'renderer.admin.attachmentSaved': 'Attachment saved to ${path}'
        };
    }

    function createWidget(): any {
        const widget = new (WidgetClass as any)();
        widget.t = (key: string, params?: Record<string, string>) => {
            let text = strings(widget)[key] ?? key;
            if (params) {
                for (const [k, v] of Object.entries(params)) text = text.replace(`\${${k}}`, String(v));
            }
            return text;
        };
        return widget;
    }

    test('shows auth form when no stored token', async () => {
        const widget = createWidget();
        document.body.appendChild(widget);
        await Promise.resolve();
        await Promise.resolve();
        expect(widget.shadowRoot.querySelector('#ap-auth-form')).toBeTruthy();
        expect(widget.shadowRoot.querySelector('#ap-server-input')).toBeTruthy();
        expect(widget.shadowRoot.querySelector('#ap-token-input')).toBeTruthy();
        expect(widget.shadowRoot.querySelector('[data-tab]')).toBeNull();
    });

    test('server url from auth form is used for verification', async () => {
        const widget = createWidget();
        document.body.appendChild(widget);
        await Promise.resolve();
        await Promise.resolve();
        widget.shadowRoot.querySelector('#ap-server-input').value = 'http://127.0.0.1:8799';
        widget.shadowRoot.querySelector('#ap-token-input').value = 'local-admin-token';
        widget.shadowRoot
            .querySelector('#ap-auth-form')
            .dispatchEvent(new window.Event('submit', { cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
        expect(adminApi.verifyToken).toHaveBeenCalledWith('http://127.0.0.1:8799', 'local-admin-token');
    });

    test('invalid server url is rejected before submit', async () => {
        const widget = createWidget();
        document.body.appendChild(widget);
        await Promise.resolve();
        await Promise.resolve();
        widget.shadowRoot.querySelector('#ap-server-input').value = 'not-a-url';
        widget.shadowRoot.querySelector('#ap-token-input').value = 'token';
        widget.shadowRoot
            .querySelector('#ap-auth-form')
            .dispatchEvent(new window.Event('submit', { cancelable: true }));
        await Promise.resolve();
        expect(widget.shadowRoot.querySelector('.ap-auth-error')?.textContent).toBeTruthy();
        expect(adminApi.verifyToken).not.toHaveBeenCalled();
    });

    test('theme change event syncs data-theme onto host', async () => {
        const widget = createWidget();
        document.body.appendChild(widget);
        await Promise.resolve();
        expect(widget.dataset.theme).toBe('light');
        document.dispatchEvent(new window.CustomEvent('opendesk-theme-changed', { detail: { effective: 'dark' } }));
        expect(widget.dataset.theme).toBe('dark');
        document.dispatchEvent(new window.CustomEvent('opendesk-theme-changed', { detail: { effective: 'light' } }));
        expect(widget.dataset.theme).toBe('light');
    });

    test('trend chart renders stacked type bars and hover tooltip', async () => {
        adminApi.loadToken.mockResolvedValue({ token: 'stored-token', canPersist: true });
        const widget = createWidget();
        document.body.appendChild(widget);
        // initialize 与 loadActivity 的完整微任务链
        await waitFor(() => widget.shadowRoot.querySelectorAll('.bar-seg').length > 0);
        // 每天都有分段柱（pc/phone 等类型分段 rect）
        const segments = widget.shadowRoot.querySelectorAll('.bar-seg');
        expect(segments.length).toBeGreaterThan(0);
        // pc 类型全部落在 c0 槽位
        const pcSegments = Array.from(widget.shadowRoot.querySelectorAll('.bar-seg.c0'));
        expect(pcSegments.length).toBe(3);
        // 逐日命中区
        const hits = widget.shadowRoot.querySelectorAll('[data-hit-idx]');
        expect(hits.length).toBe(3);
        // 悬浮：hover 第一天显示总数与按类型行，色块与柱同槽位
        widget.shadowRoot
            .querySelector('[data-hit-idx="0"]')
            .dispatchEvent(new window.Event('mouseover', { bubbles: true, composed: true }));
        const tip = widget.shadowRoot.querySelector('.trend-tip');
        expect(tip.classList.contains('show')).toBe(true);
        expect(tip.textContent).toContain('2026-10-03');
        // 总数行 + 按类型两行（pc/phone），数值正确（translator 在 initialize 中被真实翻译器覆盖，不断言具体语言文案）
        const rows = tip.querySelectorAll('.tip-row');
        expect(rows.length).toBe(3);
        expect(tip.querySelectorAll('.chip').length).toBe(2);
        expect(tip.textContent).toContain('3');
        expect(tip.textContent).toContain('2');
        expect(tip.textContent).toContain('1');
        // 移出后隐藏
        widget.shadowRoot
            .querySelector('[data-hit-idx="0"]')
            .dispatchEvent(new window.Event('mouseout', { bubbles: true, composed: true }));
        expect(tip.classList.contains('show')).toBe(false);
    });

    test('verify failure with 401 shows unauthorized message', async () => {
        adminApi.verifyToken.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 'unauthorized' }));
        const widget = createWidget();
        document.body.appendChild(widget);
        await Promise.resolve();
        await Promise.resolve();
        const input = widget.shadowRoot.querySelector('#ap-token-input');
        input.value = 'wrong-token';
        const form = widget.shadowRoot.querySelector('#ap-auth-form');
        form.dispatchEvent(new window.Event('submit', { cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(widget.shadowRoot.querySelector('.ap-auth-error')?.textContent).toBeTruthy();
    });

    test('stored token enters panel and loads activity tab', async () => {
        adminApi.loadToken.mockResolvedValue({ token: 'stored-token', canPersist: true });
        const widget = createWidget();
        document.body.appendChild(widget);
        // 等待异步数据加载完成
        await waitFor(() => widget.shadowRoot.querySelectorAll('.ap-card').length > 0);
        expect(widget.authorized).toBe(true);
        expect(adminApi.getDailyStats).toHaveBeenCalledWith(7);
        expect(adminApi.getSummaryStats).toHaveBeenCalled();
        expect(widget.shadowRoot.querySelector('.ap-tab[data-tab="activity"]')).toBeTruthy();
        expect(widget.shadowRoot.querySelector('.ap-tab[data-tab="feedback"]')).toBeTruthy();
        expect(widget.shadowRoot.querySelectorAll('.ap-card').length).toBe(3);
        expect(widget.shadowRoot.querySelector('.trend')).toBeTruthy();
    });

    test('feedback tab renders items and filter works', async () => {
        adminApi.loadToken.mockResolvedValue({ token: 'stored-token', canPersist: true });
        const widget = createWidget();
        document.body.appendChild(widget);
        // 在 initialize 读取到令牌前切到反馈页，令首次加载走 loadFeedback
        widget.activeTab = 'feedback';
        await waitFor(() => widget.shadowRoot.querySelectorAll('.ap-feedback').length > 0);
        expect(adminApi.getFeedbackList).toHaveBeenCalled();
        expect(widget.shadowRoot.querySelectorAll('.ap-feedback').length).toBe(2);
        widget.shadowRoot.querySelector('[data-filter="bug"]').dispatchEvent(new window.Event('click'));
        expect(widget.shadowRoot.querySelectorAll('.ap-feedback').length).toBe(1);
        expect(widget.shadowRoot.querySelector('[data-attachment="11"]')).toBeTruthy();
    });
});
