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
        // 对话框接管（BUG-02 修复后 click/type 会先启用 Page 域）
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
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
            // Post-type read-back of the exact target element value.
            if (expr.includes('return el.value')) {
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

function makeCtrl(session: any, windowBehavior: (script: string) => any, webviewFocused = true) {
    const win = makeWindow((script) => {
        if (script.includes('browserHasActiveWebviewFocus')) return { result: webviewFocused };
        return windowBehavior(script);
    });
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

describe('input focus isolation', () => {
    test('type does not dispatch native mouse or keyboard input when the webview is not already focused', async () => {
        const session = makeSession({ value: '后台输入' });
        const { ctrl, win } = makeCtrl(
            session,
            (script) => {
                if (script.includes('browserGetWebContentsId')) return { result: 5 };
                return { result: null };
            },
            false
        );

        const result = await ctrl.type('e1', '后台输入', { slowly: true });

        expect(result.warning).toBeUndefined();
        expect(win.focus).not.toHaveBeenCalled();
        expect(session.webContents.focus).not.toHaveBeenCalled();
        expect(session.send).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything());
        expect(session.send).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
        expect(session.send).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
        expect(session.send).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({ expression: expect.stringContaining("__odFindRef('e1')") })
        );
    });

    test('nested cross-origin iframe click and type execute in the owning frame without native input', async () => {
        let value = '';
        let clicks = 0;
        const innerFrame: any = {
            url: 'https://nested.example/form',
            frames: [],
            executeJavaScript: jest.fn(async (script: string) => {
                if (script.includes("setter.call(el, '')")) value = '';
                if (script.includes('setter.call(el, text)')) value = 'iframe-value-verified';
                if (script.includes('return el.value')) return value;
                if (script.includes('el.click()')) {
                    clicks++;
                    return JSON.stringify({ tag: 'button', text: 'Nested submit' });
                }
                return undefined;
            })
        };
        const outerFrame: any = {
            url: 'https://inner.example/frame',
            frames: [innerFrame],
            executeJavaScript: jest.fn(async () => ({ index: 0, src: innerFrame.url }))
        };
        const mainFrame: any = {
            url: 'https://host.example/',
            frames: [outerFrame],
            executeJavaScript: jest.fn(async () => ({ index: 0, src: outerFrame.url }))
        };
        const session = makeSession({});
        session.webContents.mainFrame = mainFrame;
        const { ctrl } = makeCtrl(
            session,
            (script) => {
                if (script.includes('browserGetWebContentsId')) return { result: 5 };
                return { result: null };
            },
            false
        );

        const typeResult = await ctrl.type('e1-e2-e3', 'iframe-value-verified');
        const clickResult = await ctrl.click('e1-e2-e4');

        expect(typeResult.warning).toBeUndefined();
        expect(value).toBe('iframe-value-verified');
        expect(clickResult).toMatchObject({ tag: 'button', text: 'Nested submit' });
        expect(clicks).toBe(1);
        expect(session.send).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything());
        expect(session.send).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
        expect(session.send).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
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

describe('evaluate dialog echo (BUG-02 同族)', () => {
    test('evaluate 保持裸值契约：表达式值原样返回，不包 dialog 结构', async () => {
        const session = makeSession({});
        session.send.mockImplementation(async (_method: string, params: any) => {
            if ((params?.expression || '') === '1 + 1') return { result: { value: 2 } };
            return { result: { value: undefined } };
        });
        const { ctrl } = makeCtrl(session, () => null);

        await expect(ctrl.evaluate('1 + 1')).resolves.toBe(2);
    });

    test('evaluateWithDialog 回显表达式触发的对话框（对话框已被自动接受）', async () => {
        const session = makeSession({});
        session.send.mockImplementation(async (_method: string, params: any) => {
            if ((params?.expression || '').includes('DIALOG-MARKER')) return { result: { value: true } };
            return { result: { value: undefined } };
        });
        session.takeLastDialog.mockReturnValueOnce({
            type: 'confirm',
            message: 'DIALOG-MARKER',
            url: 'https://example.com/page'
        });
        const { ctrl } = makeCtrl(session, () => null);

        const { value, dialog } = await ctrl.evaluateWithDialog('confirm("DIALOG-MARKER")');
        expect(value).toBe(true);
        expect(dialog).toContain('DIALOG-MARKER');
        expect(session.takeLastDialog).toHaveBeenCalled();
    });

    test('无对话框时 evaluateWithDialog 不带 dialog 字段', async () => {
        const session = makeSession({});
        session.send.mockImplementation(async (_method: string, params: any) => {
            if ((params?.expression || '') === '1 + 1') return { result: { value: 42 } };
            return { result: { value: undefined } };
        });
        const { ctrl } = makeCtrl(session, () => null);

        const { value, dialog } = await ctrl.evaluateWithDialog('1 + 1');
        expect(value).toBe(42);
        expect(dialog).toBeUndefined();
    });
});

describe('navigation dialog echo (BUG-02 收尾)', () => {
    // 导航是 beforeunload 对话框的主要触发源：若 navigate/goBack/goForward/reload
    // 不消费 takeLastDialog，对话框信息会滞留到下一个无关动作的结果里错挂。
    const DIALOG = { type: 'beforeunload', message: 'LEAVE-PAGE?', url: 'https://example.com/form' };

    function makeNavSession() {
        const session = makeSession({});
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr: string = params?.expression || '';
            // readPageInfo
            if (expr.includes('document.title')) {
                return { result: { value: JSON.stringify({ url: 'https://example.com/next', title: 'Next' }) } };
            }
            return { result: { value: undefined } };
        });
        return session;
    }

    test('goBack 回显导航过程触发的对话框（beforeunload 已自动接受）', async () => {
        const session = makeNavSession();
        session.takeLastDialog.mockReturnValueOnce(DIALOG);
        const { ctrl } = makeCtrl(session, () => ({ result: null }));

        const info = await ctrl.goBack();
        expect(info.url).toBe('https://example.com/next');
        expect(info.dialog).toContain('beforeunload');
        expect(info.dialog).toContain('LEAVE-PAGE?');
        // 只在本次结果消费一次，不残留到下一个动作
        expect(session.takeLastDialog).toHaveBeenCalledTimes(1);
    });

    test('goForward / reload 同样回显', async () => {
        const sessionF = makeNavSession();
        sessionF.takeLastDialog.mockReturnValueOnce(DIALOG);
        const { ctrl: ctrlF } = makeCtrl(sessionF, () => ({ result: null }));
        expect((await ctrlF.goForward()).dialog).toContain('beforeunload');

        const sessionR = makeNavSession();
        sessionR.takeLastDialog.mockReturnValueOnce(DIALOG);
        const { ctrl: ctrlR } = makeCtrl(sessionR, () => ({ result: null }));
        expect((await ctrlR.reload()).dialog).toContain('beforeunload');
    });

    test('navigate 同样回显', async () => {
        const session = makeNavSession();
        session.takeLastDialog.mockReturnValueOnce(DIALOG);
        const { ctrl } = makeCtrl(session, () => ({ result: null }));

        const info = await ctrl.navigate('https://example.com/next');
        expect(info.url).toBe('https://example.com/next');
        expect(info.dialog).toContain('beforeunload');
    });

    test('无对话框时不带 dialog 字段', async () => {
        const session = makeNavSession();
        const { ctrl } = makeCtrl(session, () => ({ result: null }));

        const info = await ctrl.goBack();
        expect(info.dialog).toBeUndefined();
    });
});

describe('历史导航静默失败检测（压测发现）', () => {
    // goBack 在部分状态下会"什么也没发生"：工具照旧返回旧页面的 url/title，
    // agent 完全看不出没后退。这里锁定"URL 未变化 → 明确 error"的语义。
    function makeHistoryCtrl(urls: string[]) {
        let call = 0;
        const session: any = {
            webContentsId: 5,
            webContents: { focus: jest.fn() },
            isHealthy: jest.fn(async () => true),
            waitForPageReady: jest.fn(async () => {}),
            waitForDOMStable: jest.fn(async () => {}),
            ensureDialogHandling: jest.fn(async () => {}),
            takeLastDialog: jest.fn(() => null),
            send: jest.fn(async (_method: string, params: any) => {
                const expr: string = params?.expression || '';
                if (expr.includes('location.href') && expr.includes('document.title')) {
                    const url = urls[Math.min(call, urls.length - 1)];
                    call += 1;
                    return { result: { value: JSON.stringify({ url, title: 'T' }) } };
                }
                return { result: { value: undefined } };
            })
        };
        const ctrl = new BrowserController('t-history', makeWindow(() => ({ result: null })) as any, mockScriptGen);
        (ctrl as any).getCDPSession = jest.fn(async () => session);
        (ctrl as any).requireCDP = jest.fn(async () => session);
        (ctrl as any).callRendererBrowser = jest.fn(async () => ({ ok: true }));
        return ctrl;
    }

    test('goBack 后 URL 未变化时返回 error，不再静默回显旧页面', async () => {
        const ctrl = makeHistoryCtrl(['https://example.com/same', 'https://example.com/same']);

        const info = await ctrl.goBack();
        expect(info.url).toBe('https://example.com/same');
        expect(info.error).toContain('页面 URL 未变化');
    });

    test('goBack 正常回退时不带 error', async () => {
        const ctrl = makeHistoryCtrl(['https://example.com/before', 'https://example.com/after']);

        const info = await ctrl.goBack();
        expect(info.url).toBe('https://example.com/after');
        expect(info.error).toBeUndefined();
    });

    test('goForward 后 URL 未变化时返回 error', async () => {
        const ctrl = makeHistoryCtrl(['https://example.com/same', 'https://example.com/same']);

        const info = await ctrl.goForward();
        expect(info.error).toContain('页面 URL 未变化');
    });
});

describe('navigate 未发生时的提示（压测发现）', () => {
    // navigate 到会触发下载的资源时，Chromium 只下载、不导航：结果里应出现
    // note 说明，而不是让 agent 以为"URL 没变但也许成功了"。
    function makeNavCtrl(urls: string[]) {
        let call = 0;
        const session: any = {
            webContentsId: 5,
            webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
            isHealthy: jest.fn(async () => true),
            waitForPageReady: jest.fn(async () => {}),
            waitForDOMStable: jest.fn(async () => {}),
            ensureDialogHandling: jest.fn(async () => {}),
            takeLastDialog: jest.fn(() => null),
            send: jest.fn(async (_method: string, params: any) => {
                const expr: string = params?.expression || '';
                if (expr.includes('location.href') && expr.includes('document.title')) {
                    const url = urls[Math.min(call, urls.length - 1)];
                    call += 1;
                    return { result: { value: JSON.stringify({ url, title: 'T' }) } };
                }
                return { result: { value: undefined } };
            })
        };
        const ctrl = new BrowserController('t-nav-note', makeWindow(() => ({ result: null })) as any, mockScriptGen);
        (ctrl as any).getCDPSession = jest.fn(async () => session);
        (ctrl as any).requireCDP = jest.fn(async () => session);
        (ctrl as any).callRendererBrowser = jest.fn(async () => ({ ok: true }));
        return ctrl;
    }

    test('导航后 URL 未变化时返回 note，指向可能的下载/拦截', async () => {
        // 第一次 readPageInfo 是"导航前"，之后都还是同一个页面
        const ctrl = makeNavCtrl(['https://example.com/current']);
        const info = await ctrl.navigate('https://example.com/file.zip');

        expect(info.url).toBe('https://example.com/current');
        expect(info.note).toContain('导航未发生');
        expect(info.note).toContain('文件下载');
    });

    test('正常导航不产生 note', async () => {
        const ctrl = makeNavCtrl(['https://example.com/current', 'https://example.com/next']);

        const info = await ctrl.navigate('https://example.com/next');
        expect(info.url).toBe('https://example.com/next');
        expect(info.note).toBeUndefined();
    });

    test('同址导航（等价 reload）不产生 note', async () => {
        const ctrl = makeNavCtrl(['https://example.com/same']);

        const info = await ctrl.navigate('https://example.com/same');
        expect(info.note).toBeUndefined();
    });
});
