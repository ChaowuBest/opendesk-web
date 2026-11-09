/**
 * webview console 信令解析的安全边界测试。
 *
 * console-message 是页面可控的无认证通道（且 <webview> 的该事件不携带 frame
 * 信息），任何页面脚本都能打印任意内容。消费端必须做到：
 *  - 信令必须携带宿主按 tab 注入脚本闭包的一次性 token，缺 token / 错 token
 *    的消息一律忽略（防伪造导航 / opener 消息）；
 *  - opener 类信令只对存在 opener 关系的 tab 生效；
 *  - postMessage 的 origin 由宿主按 tab 当前 URL 计算，不取页面传值。
 */
import vm from 'node:vm';
import {
    createWebviewSignalTokenStore,
    makeNavInterceptScript,
    makeWindowOpenProxyScript,
    makeOpenerBridgeScript,
    resolveWebviewConsoleSignal,
    resolveSignalOrigin,
    NAV_INTERCEPT_CONSOLE_PREFIX
} from '../../../renderer/webviewScripts.js';

const TOKEN = '9f8e7d6c5b4a';

describe('isMainFrame 校验已不可行 → token 校验', () => {
    test('无 token 的信令一律忽略（BUG-35 的伪造通道）', () => {
        expect(resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}https://example.com/t`, '', false)).toEqual({
            kind: 'none'
        });
        // 老 format：没有 token 段 —— 历史上任意页面脚本都能凭空伪造导航
        expect(
            resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}https://example.com/t`, TOKEN, false)
        ).toEqual({ kind: 'none' });
    });

    test('token 不匹配的信令一律忽略', () => {
        expect(
            resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}wrongtoken:https://example.com/t`, TOKEN, false)
        ).toEqual({ kind: 'none' });
    });
});

describe('resolveWebviewConsoleSignal', () => {
    const NAV = `${NAV_INTERCEPT_CONSOLE_PREFIX}${TOKEN}:https://example.com/target`;

    test('携带正确 token 的导航信令被接受', () => {
        expect(resolveWebviewConsoleSignal(NAV, TOKEN, false)).toEqual({
            kind: 'navigate',
            url: 'https://example.com/target'
        });
    });

    test('非 http(s) 的导航目标被忽略', () => {
        expect(
            resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}${TOKEN}:javascript:alert(1)`, TOKEN, false)
        ).toEqual({ kind: 'none' });
        expect(resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}${TOKEN}:`, TOKEN, false)).toEqual({
            kind: 'none'
        });
    });

    test('window.close 信令需要 opener 关系且 token 正确', () => {
        expect(resolveWebviewConsoleSignal(`__openDesk_window_close__:${TOKEN}`, TOKEN, true)).toEqual({
            kind: 'windowClose'
        });
        expect(resolveWebviewConsoleSignal(`__openDesk_window_close__:${TOKEN}`, TOKEN, false)).toEqual({
            kind: 'none'
        });
        expect(resolveWebviewConsoleSignal('__openDesk_window_close__', TOKEN, true)).toEqual({ kind: 'none' });
    });

    test('opener reload 信令需要 opener 关系', () => {
        expect(resolveWebviewConsoleSignal(`__openDesk_opener_reload__:${TOKEN}`, TOKEN, true)).toEqual({
            kind: 'openerReload'
        });
        expect(resolveWebviewConsoleSignal(`__openDesk_opener_reload__:${TOKEN}`, TOKEN, false)).toEqual({
            kind: 'none'
        });
    });

    test('opener postMessage 解析 payload.data，origin 不得采信页面传值', () => {
        const forged =
            `__openDesk_opener_postMessage__:${TOKEN}:` +
            JSON.stringify({ data: 'FORGED-PAYLOAD', origin: 'https://bank.example' });
        const action = resolveWebviewConsoleSignal(forged, TOKEN, true);
        // 解析结果只携带 data；origin 必须由消费端通过 resolveSignalOrigin 宿主侧计算
        expect(action).toEqual({ kind: 'openerPostMessage', data: 'FORGED-PAYLOAD' });
    });

    test('opener postMessage 对无 opener 关系的 tab 无效', () => {
        const msg = `__openDesk_opener_postMessage__:${TOKEN}:{"data":1}`;
        expect(resolveWebviewConsoleSignal(msg, TOKEN, false)).toEqual({ kind: 'none' });
    });

    test('opener postMessage payload 非法 JSON 时忽略', () => {
        expect(resolveWebviewConsoleSignal(`__openDesk_opener_postMessage__:${TOKEN}:{bad`, TOKEN, true)).toEqual({
            kind: 'none'
        });
    });

    test('popup focus / close 信令同时接受带/不带 token 的形式（能力等价，见实现说明）', () => {
        // 带 token（renderer 注入的代理发出）
        expect(resolveWebviewConsoleSignal(`__openDesk_popup_focus__:${TOKEN}:3`, TOKEN, false)).toEqual({
            kind: 'popupFocus',
            proxyId: '3'
        });
        expect(resolveWebviewConsoleSignal(`__openDesk_popup_close__:${TOKEN}:5`, TOKEN, false)).toEqual({
            kind: 'popupClose',
            proxyId: '5'
        });
        // 不带 token（document-start preload 注入的代理发出，无法预知 token）
        expect(resolveWebviewConsoleSignal('__openDesk_popup_focus__:3', TOKEN, false)).toEqual({
            kind: 'popupFocus',
            proxyId: '3'
        });
        expect(resolveWebviewConsoleSignal('__openDesk_popup_close__:5', TOKEN, false)).toEqual({
            kind: 'popupClose',
            proxyId: '5'
        });
    });

    test('导航信令严格要求 token（loadURL 是页面原生不具备的通道）', () => {
        expect(
            resolveWebviewConsoleSignal(`${NAV_INTERCEPT_CONSOLE_PREFIX}wrong:${'https://example.com'}`, TOKEN, false)
        ).toEqual({ kind: 'none' });
    });

    test('未知消息返回 none', () => {
        expect(resolveWebviewConsoleSignal('hello world', TOKEN, true)).toEqual({ kind: 'none' });
        expect(resolveWebviewConsoleSignal('', TOKEN, true)).toEqual({ kind: 'none' });
    });
});

describe('resolveSignalOrigin', () => {
    test('origin 由宿主按 tab 当前 URL 计算（防伪造，BUG-36）', () => {
        expect(resolveSignalOrigin('https://popup.example/page?x=1')).toBe('https://popup.example');
    });

    test('URL 不可得/非法时返回空串（opener 按 origin 过滤会安全拒收）', () => {
        expect(resolveSignalOrigin(undefined)).toBe('');
        expect(resolveSignalOrigin('not-a-url')).toBe('');
    });
});

describe('信令脚本注入 token 到闭包', () => {
    test('导航拦截脚本携带 token 且只安装在顶层文档（BUG-01/34）', () => {
        const script = makeNavInterceptScript(TOKEN);
        expect(script).toContain(`var PREFIX = '${NAV_INTERCEPT_CONSOLE_PREFIX}${TOKEN}:';`);
        expect(script).toContain('window.top !== window.self');
        // 脚本必须是合法 JS
        expect(() => new Function(script)).not.toThrow();
    });

    test('window.open proxy 与 opener 桥接脚本的信令携带 token', () => {
        const proxy = makeWindowOpenProxyScript(TOKEN);
        expect(proxy).toContain(`'__openDesk_popup_close__:' + SIGNAL_PREFIX + proxyId`);
        expect(proxy).toContain(`'__openDesk_popup_focus__:' + SIGNAL_PREFIX + proxyId`);
        expect(() => new Function(proxy)).not.toThrow();

        const bridge = makeOpenerBridgeScript(TOKEN);
        expect(bridge).toContain(`'__openDesk_opener_postMessage__:' + SIGNAL_TOKEN + ':'`);
        expect(bridge).toContain(`'__openDesk_window_close__:' + SIGNAL_TOKEN`);
        expect(bridge).toContain(`'__openDesk_opener_reload__:' + SIGNAL_TOKEN`);
        expect(bridge).toContain('window.top !== window.self');
        expect(() => new Function(bridge)).not.toThrow();
    });

    test('空 token（preload 注入）的 popup 信令保持历史无 token 段格式（无双冒号）', () => {
        const logs: string[] = [];
        const windowStub: Record<string, unknown> = {
            open: () => null,
            __openDeskPopupProxies: [],
            dispatchEvent: () => true
        };
        vm.runInNewContext(makeWindowOpenProxyScript(''), {
            console: { log: (...args: unknown[]) => logs.push(args.map(String).join(' ')) },
            window: windowStub,
            MessageEvent: class {
                data: unknown;
                origin: string;
                constructor(_type: string, init?: { data?: unknown; origin?: string }) {
                    this.data = init?.data;
                    this.origin = init?.origin ?? '';
                }
            }
        });
        const proxy = (windowStub.open as (url: string, target: string) => { close: () => void; focus: () => void })(
            'https://x.example/',
            '_blank'
        );
        proxy.close();
        proxy.focus();
        // 历史格式：__openDesk_popup_close__:<proxyId>，无 token 段、无双冒号
        expect(logs).toContain('__openDesk_popup_close__:1');
        expect(logs).toContain('__openDesk_popup_focus__:1');
    });
});

describe('createWebviewSignalTokenStore', () => {
    test('同一 tab 稳定返回同一 token（注入端与消费端必须一致）', () => {
        const tokenOf = createWebviewSignalTokenStore<{ id: number }>();
        const tab = { id: 1 };
        const first = tokenOf(tab);
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(tokenOf(tab)).toBe(first);
    });

    test('不同 tab / 不同仓库的 token 互不相同', () => {
        const tokenOf = createWebviewSignalTokenStore<{ id: number }>();
        const t1 = tokenOf({ id: 1 });
        const t2 = tokenOf({ id: 2 });
        expect(t1).not.toBe(t2);
        // 每个宿主实例（EmbeddedBrowser / task-view 入口）持有独立仓库
        expect(createWebviewSignalTokenStore()({ id: 1 })).not.toBe(t1);
    });
});
