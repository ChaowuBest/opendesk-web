/**
 * Tests for action-result observability in BrowserController:
 *
 * P0-1  type(): value read-back verification + submit no-op detection.
 *       Regression scenario (taobao home search): the page's React state kept
 *       the old keyword while the DOM value had been replaced, so Enter
 *       submitted the WRONG text - silently. type() must now read the value
 *       back and warn on mismatch, and warn when submit produced no navigation
 *       and no new tab at all.
 *
 * P0-2  click()/type(): new tab opened by target=_blank links must be detected
 *       (polling window, not a single 100ms check) and reported as newTab.
 *       Regression scenario (taobao item card / ifeng headline): the click
 *       opened a new tab that activated a few hundred ms later; the tool kept
 *       reporting the OLD page url and the agent had to tabs.list manually.
 *
 * P1-6  click(): hit-element check right before dispatching mouse events, so a
 *       floating overlay (ifeng sidebar ad hijack) is reported instead of
 *       silently clicking through it.
 */
import { BrowserController, type BrowserScriptGenerators } from '../main';
import { jest } from '@jest/globals';

const mockScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

interface SessionOpts {
    webContentsId?: number;
    coords?: { x: number; y: number; tag: string; text: string; obscured?: boolean };
    hitElement?: { tag: string; text: string } | null;
    url?: string;
    pageState?: Record<string, any>;
    /** Value returned by the post-type read-back of activeElement.value. */
    value?: string | null;
}

function makeSession(opts: SessionOpts = {}) {
    const coords = opts.coords ?? { x: 100, y: 100, tag: 'button', text: '搜索' };
    const url = opts.url ?? 'https://example.com/page';
    const session: any = {
        webContentsId: opts.webContentsId ?? 5,
        webContents: { focus: jest.fn() },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        send: jest.fn(async (method: string, params: any) => {
            if (
                method === 'Input.dispatchMouseEvent' ||
                method === 'Input.dispatchKeyEvent' ||
                method === 'Input.insertText'
            ) {
                return {};
            }
            const expr = params?.expression || '';
            // Ref coordinate resolution script (contains scrollIntoView + data-od-ref).
            if (expr.includes('data-od-ref') && expr.includes('scrollIntoView')) {
                return { result: { value: JSON.stringify({ ...coords, obscured: !!coords.obscured }) } };
            }
            // New pre-click hit-element check.
            if (expr.includes('elementFromPoint') && !expr.includes('contextmenu')) {
                if (opts.hitElement === null) return { result: { value: '' } };
                return {
                    result: {
                        value: JSON.stringify(opts.hitElement ?? { tag: coords.tag, text: coords.text })
                    }
                };
            }
            // Post-type read-back of the active element value.
            if (expr.includes('document.activeElement')) {
                return { result: { value: opts.value === null ? undefined : (opts.value ?? '') } };
            }
            if (expr.trim() === 'location.href') {
                return { result: { value: url } };
            }
            if (expr.includes('scrollY')) {
                // readPageState
                return {
                    result: {
                        value: JSON.stringify(
                            opts.pageState ?? {
                                url,
                                title: 'Test Page',
                                scrollY: 0,
                                scrollHeight: 1000,
                                viewportHeight: 800
                            }
                        )
                    }
                };
            }
            return { result: { value: undefined } };
        })
    };
    return session;
}

function makeWindow(behavior: (script: string) => any) {
    return {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: {
            executeJavaScript: jest.fn(async (script: string) => behavior(script))
        }
    };
}

/** Tabs where the active tab is a newly opened one. */
const NEW_TABS = [
    { id: 9, title: '新页面', url: 'https://new.example.com', active: true },
    { id: 5, title: '旧页面', url: 'https://example.com/page', active: false }
];

function makeCtrl(session: any, windowBehavior: (script: string) => any) {
    const win = makeWindow(windowBehavior);
    const ctrl = new BrowserController('t-feedback', win as any, mockScriptGen);
    // Speed up the new-tab polling window for tests.
    (ctrl as any)._newTabPollIntervalMs = 1;
    (ctrl as any)._newTabDetectWindowMs = 60;
    (ctrl as any).requireCDP = jest.fn(async () => session);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return { ctrl, win };
}

describe('click new-tab reporting (P0-2)', () => {
    test('click that opens a new tab (activating late) reports newTab with title/url', async () => {
        const session = makeSession({});
        let wcIdCalls = 0;
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) {
                wcIdCalls++;
                // First two polls still see the old tab; the new tab activates on the 3rd.
                return { result: wcIdCalls <= 2 ? 5 : 9 };
            }
            if (script.includes('browserListTabs')) {
                return { result: NEW_TABS };
            }
            return { result: null };
        });

        const result = await ctrl.click('e1');

        expect(result.newTab).toEqual({ id: 9, title: '新页面', url: 'https://new.example.com' });
        // The new tab's page-ready wait must have been awaited.
        expect(session.waitForPageReady).toHaveBeenCalled();
    });

    test('click without new tab or navigation reports no newTab and waits for DOM stability', async () => {
        const session = makeSession({});
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.click('e1');

        expect(result.newTab).toBeNull();
        expect(result.page).toMatchObject({ url: 'https://example.com/page' });
        expect(session.waitForDOMStable).toHaveBeenCalled();
    });

    test('click with same-tab navigation returns the new page state', async () => {
        // After the click the URL changes (same-tab navigation).
        let hrefCalls = 0;
        const session = makeSession({ url: 'https://example.com/page' });
        const beforeSpy = session.send;
        session.send = jest.fn(async (method: string, params: any) => {
            const expr = params?.expression || '';
            if (expr === 'location.href' && params?.returnByValue) {
                hrefCalls++;
                return {
                    result: {
                        value: hrefCalls === 1 ? 'https://example.com/page' : 'https://example.com/after-click'
                    }
                };
            }
            if (expr.includes('scrollY')) {
                return {
                    result: {
                        value: JSON.stringify({
                            url: hrefCalls >= 2 ? 'https://example.com/after-click' : 'https://example.com/page',
                            title: 'After Click',
                            scrollY: 0,
                            scrollHeight: 800,
                            viewportHeight: 800
                        })
                    }
                };
            }
            return beforeSpy(method, params);
        });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.click('e1');

        expect(result.newTab).toBeNull();
        expect(result.page).toMatchObject({ url: 'https://example.com/after-click' });
        expect(session.waitForPageReady).toHaveBeenCalled();
    });
});

describe('click hit-element verification (P1-6)', () => {
    test('obscured click reports hitElement and a hijack warning', async () => {
        const session = makeSession({
            coords: { x: 100, y: 100, tag: 'li', text: '这条新闻', obscured: true },
            hitElement: { tag: 'div', text: '张家界旅游广告' }
        });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.click('e1');

        expect(result.hitElement).toEqual({ tag: 'div', text: '张家界旅游广告' });
        expect(result.warning).toContain('遮挡');
    });

    test('unobscured click reports hitElement without warning', async () => {
        const session = makeSession({
            coords: { x: 100, y: 100, tag: 'button', text: '播放' },
            hitElement: { tag: 'button', text: '播放' }
        });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.click('e1');

        expect(result.hitElement).toEqual({ tag: 'button', text: '播放' });
        expect(result.warning).toBeUndefined();
    });
});

describe('type value read-back verification (P0-1)', () => {
    test('type warns when the read-back value does not match the typed text', async () => {
        // React controlled component kept its old state: typed "显卡水冷" but the
        // page still reports the old keyword.
        const session = makeSession({ value: 'ai算力卡' });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.type('e1', '显卡水冷');

        expect(result.typed).toBe(4);
        expect(result.warning).toMatch(/读回|不一致|未同步/);
    });

    test('type with matching read-back returns page state and no warning', async () => {
        const session = makeSession({ value: '机械键盘' });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.type('e1', '机械键盘');

        expect(result.typed).toBe(4);
        expect(result.warning).toBeUndefined();
        expect(result.page).toMatchObject({ url: 'https://example.com/page', title: 'Test Page' });
    });
});

describe('type submit feedback (P0-1)', () => {
    test('submit with no navigation and no new tab warns that submission may not have taken effect', async () => {
        const session = makeSession({ value: '机械键盘' });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.type('e1', '机械键盘', { submit: true });

        expect(result.warning).toMatch(/提交.*(?:未生效|未检测)/);
    });

    test('submit that opens a new tab reports newTab and no no-op warning', async () => {
        const session = makeSession({ value: '机械键盘' });
        let wcIdCalls = 0;
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) {
                wcIdCalls++;
                return { result: wcIdCalls <= 1 ? 5 : 9 };
            }
            if (script.includes('browserListTabs')) {
                return { result: NEW_TABS };
            }
            return { result: null };
        });

        const result = await ctrl.type('e1', '机械键盘', { submit: true });

        expect(result.newTab).toEqual({ id: 9, title: '新页面', url: 'https://new.example.com' });
        expect(result.warning).toBeUndefined();
    });

    test('submit with same-tab navigation does not warn', async () => {
        // After the submit the URL changes (same-tab navigation).
        let hrefCalls = 0;
        const session = makeSession({ value: '机械键盘', url: 'https://example.com/page' });
        const beforeSpy = session.send;
        session.send = jest.fn(async (method: string, params: any) => {
            const expr = params?.expression || '';
            if (expr === 'location.href' && params?.returnByValue) {
                hrefCalls++;
                return {
                    result: {
                        value:
                            hrefCalls === 1
                                ? 'https://example.com/page'
                                : 'https://example.com/search?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98'
                    }
                };
            }
            if (expr.includes('scrollY')) {
                // readPageState — follow the latest URL seen via hrefCalls.
                return {
                    result: {
                        value: JSON.stringify({
                            url:
                                hrefCalls >= 2
                                    ? 'https://example.com/search?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98'
                                    : 'https://example.com/page',
                            title: 'Search',
                            scrollY: 0,
                            scrollHeight: 800,
                            viewportHeight: 800
                        })
                    }
                };
            }
            return beforeSpy(method, params);
        });
        const { ctrl } = makeCtrl(session, (script) => {
            if (script.includes('browserGetWebContentsId')) return { result: 5 };
            return { result: null };
        });

        const result = await ctrl.type('e1', '机械键盘', { submit: true });

        expect(result.warning).toBeUndefined();
        expect(result.page).toMatchObject({ url: 'https://example.com/search?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98' });
    });
});
