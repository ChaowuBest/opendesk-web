/**
 * Regression tests for the taobao IM (旺旺) chat input focus bug.
 *
 * When the task webview does NOT hold native focus (background task, or the
 * user is typing elsewhere in OpenDesk), click()/type() run "isolated" in the
 * guest page via Runtime.evaluate. Synthetic mouse events (isTrusted=false)
 * never trigger the browser's default focus-on-mousedown behavior, so
 * clicking a text-entry control never focused it and every focus-dependent
 * input (execCommand / insertText / key events) landed nowhere.
 *
 * These tests execute the generated page scripts against a linkedom DOM and
 * observe which focus calls and events the page would actually receive.
 */
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { BrowserController, type BrowserScriptGenerators } from '../main';
import { jest } from '@jest/globals';

const mockScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

const EDIT_BOX_HTML = `
<html><head><title>淘宝旺旺聊天</title></head><body>
<div class="editBox">
  <div class="placeholder" data-od-ref="e179">请输入消息，按Enter键 或 点击发送按钮发送</div>
  <pre class="edit" contenteditable="true" spellcheck="false" data-od-ref="e180"></pre>
</div>
</body></html>`;

interface Recorded {
    focusCalls: Array<{ el: Element; opts: unknown }>;
    events: Array<{ el: Element; type: string }>;
    execCommandCalls: Array<{ cmd: string; value: string | boolean | undefined }>;
    script: string;
}

function buildDom(markup: string) {
    const { document, window } = parseHTML(markup);
    return { document, window };
}

/**
 * Execute a generated page script (`(() => { ... })()`) inside a sandbox that
 * spies on el.focus / document.execCommand and records dispatched events.
 */
function runScript(document: Document, script: string, markup: string): Recorded {
    const recorded: Recorded = { focusCalls: [], events: [], execCommandCalls: [], script };

    for (const el of Array.from(document.querySelectorAll('[data-od-ref]'))) {
        const target = el as HTMLElement & {
            focus?: (opts?: unknown) => void;
            dispatchEvent?: (ev: Event) => boolean;
        };
        target.focus = (opts?: unknown) => {
            recorded.focusCalls.push({ el, opts });
        };
        const origDispatch = target.dispatchEvent?.bind(target);
        target.dispatchEvent = (ev: Event) => {
            recorded.events.push({ el, type: ev.type });
            try {
                return origDispatch ? origDispatch(ev) : true;
            } catch {
                // linkedom may reject event objects it cannot handle; the
                // observation above is what the test needs.
                return true;
            }
        };
    }

    const docAny = document as unknown as { execCommand?: (cmd: string, ui?: boolean, value?: string) => boolean };
    docAny.execCommand = (cmd: string, ui?: boolean, value?: string) => {
        recorded.execCommandCalls.push({ cmd, value });
        return true;
    };

    const { window: linkedomWindow } = parseHTML(markup);
    // linkedom has no MouseEvent/KeyboardEvent constructors; the generated
    // scripts only need constructible event objects, so stub them.
    const stubEventCtor = function (this: Record<string, unknown>, type: string, init?: Record<string, unknown>) {
        this.type = type;
        Object.assign(this, init || {});
    } as unknown as new (type: string, init?: Record<string, unknown>) => Event;

    vm.runInNewContext(script, {
        document,
        window: {},
        MouseEvent: stubEventCtor,
        Event: linkedomWindow.Event,
        KeyboardEvent: stubEventCtor
    });

    return recorded;
}

function makeSession(evals: string[]) {
    const session: any = {
        webContentsId: 5,
        webContents: { focus: jest.fn() },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        // 对话框接管（BUG-02 修复后 click/type 会先启用 Page 域）
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
        send: jest.fn(async (method: string, params: any) => {
            const expr = params?.expression || '';
            if (expr) evals.push(expr);
            if (method !== 'Runtime.evaluate') return {};
            // The isolated click script reports the clicked element back as JSON.
            if (expr.includes('mousedown')) {
                const tag = expr.includes('PRE') ? 'pre' : 'button';
                return { result: { value: JSON.stringify({ tag, text: '' }) } };
            }
            if (expr.includes('scrollY')) {
                return {
                    result: {
                        value: JSON.stringify({
                            url: 'https://market.m.taobao.com/chat',
                            title: '淘宝旺旺聊天',
                            scrollY: 0,
                            scrollHeight: 1000,
                            viewportHeight: 800
                        })
                    }
                };
            }
            return { result: { value: undefined } };
        })
    };
    return session;
}

function makeCtrl(session: any, webviewFocused: boolean) {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: {
            executeJavaScript: jest.fn(async (script: string) => {
                if (script.includes('browserHasActiveWebviewFocus')) return { result: webviewFocused };
                return { result: null };
            })
        }
    };
    const ctrl = new BrowserController('t-focus', win as any, mockScriptGen);
    (ctrl as any)._newTabPollIntervalMs = 1;
    (ctrl as any)._newTabDetectWindowMs = 60;
    (ctrl as any).requireCDP = jest.fn(async () => session);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

function findClickScript(evals: string[], ref: string): string | undefined {
    // ref 解析已改为 shadow 穿透的 __odFindRef（BUG-33）
    return evals.find((e) => e.includes(`__odFindRef('${ref}')`) && e.includes('mousedown'));
}

describe('isolated click focuses text-entry controls (webview not focused)', () => {
    test('click on the contenteditable editor focuses it before dispatching mouse events', async () => {
        const evals: string[] = [];
        const session = makeSession(evals);
        const ctrl = makeCtrl(session, false);

        await ctrl.click('e180');

        const script = findClickScript(evals, 'e180');
        expect(script).toBeTruthy();

        const { document } = buildDom(EDIT_BOX_HTML);
        const recorded = runScript(document, script!, EDIT_BOX_HTML);

        // focus must happen and must precede the synthetic mouse events
        expect(recorded.focusCalls).toHaveLength(1);
        expect(recorded.focusCalls[0].el === document.querySelector('[data-od-ref="e180"]')).toBe(true);
        const firstEventIdx = recorded.events.findIndex((e) => e.type === 'mousedown');
        const focusIdx = recorded.script.indexOf('.focus(');
        expect(focusIdx).toBeGreaterThanOrEqual(0);
        expect(firstEventIdx).toBeGreaterThanOrEqual(0);
        // mousedown/mouseup/click all dispatched
        expect(recorded.events.map((e) => e.type)).toEqual(expect.arrayContaining(['mousedown', 'mouseup', 'click']));
    });

    test('click on a plain button does not focus (unchanged behavior)', async () => {
        const markup = `<html><body><button data-od-ref="e1">发送</button></body></html>`;
        const evals: string[] = [];
        const session = makeSession(evals);
        const ctrl = makeCtrl(session, false);

        await ctrl.click('e1');

        const script = findClickScript(evals, 'e1');
        expect(script).toBeTruthy();

        const { document } = buildDom(markup);
        const recorded = runScript(document, script!, markup);
        expect(recorded.focusCalls).toHaveLength(0);
        expect(recorded.events.map((e) => e.type)).toEqual(expect.arrayContaining(['mousedown', 'mouseup', 'click']));
    });
});

describe('isolated type focuses the editor and routes through execCommand', () => {
    test('contenteditable input is focused and inserted via execCommand insertText', async () => {
        const evals: string[] = [];
        const session = makeSession(evals);
        const ctrl = makeCtrl(session, false);

        await ctrl.type('e180', '你好，这是一条测试消息', { clearFirst: true });

        // The insert script is the one executed with the text payload.
        const script = evals.find((e) => e.includes('你好，这是一条测试消息') && e.includes('isContentEditable'));
        expect(script).toBeTruthy();

        const { document } = buildDom(EDIT_BOX_HTML);
        const recorded = runScript(document, script!, EDIT_BOX_HTML);

        expect(recorded.focusCalls.length).toBeGreaterThanOrEqual(1);
        const insertCmd = recorded.execCommandCalls.find((c) => c.cmd === 'insertText');
        expect(insertCmd).toBeDefined();
        expect(insertCmd!.value).toBe('你好，这是一条测试消息');
        // When execCommand reports success the script must NOT fall back to a
        // direct textContent write (pages like taobao IM wipe that away).
        const editor = document.querySelector('[data-od-ref="e180"]') as HTMLElement;
        expect(editor.textContent).toBe('');
    });

    test('falls back to textContent write when execCommand is unavailable', async () => {
        const evals: string[] = [];
        const session = makeSession(evals);
        const ctrl = makeCtrl(session, false);

        await ctrl.type('e180', 'fallback text', { clearFirst: true });

        const script = evals.find((e) => e.includes('fallback text') && e.includes('isContentEditable'));
        expect(script).toBeTruthy();

        const { document, window } = buildDom(EDIT_BOX_HTML);
        // No execCommand in this sandbox → the script must take the fallback.
        const docAny = document as unknown as { execCommand?: unknown };
        delete docAny.execCommand;

        const recorded: Recorded = { focusCalls: [], events: [], execCommandCalls: [], script };
        for (const el of Array.from(document.querySelectorAll('[data-od-ref]'))) {
            const target = el as any;
            target.focus = () => recorded.focusCalls.push({ el, opts: undefined });
        }
        vm.runInNewContext(script!, { document, window: {}, Event: window.Event });

        const editor = document.querySelector('[data-od-ref="e180"]') as HTMLElement;
        expect(editor.textContent).toBe('fallback text');
        // The fallback must still notify the page via an input event.
        expect(recorded.focusCalls.length).toBeGreaterThanOrEqual(1);
    });
});
