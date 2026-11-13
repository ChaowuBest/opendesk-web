/**
 * Webview 注入脚本 — 共享常量
 * 这些脚本字符串分别通过 preload（webviewPreload.js）和
 * executeJavaScript（browser.ts / entry.ts）两种方式注入到
 * webview guest 页面中，用于 patch window.open / window.opener。
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */
/**
 * window.open Proxy 注入脚本
 *
 * 在 webview guest 中覆盖 window.open，使 Electron deny 弹窗时
 * 仍返回一个模拟 window 对象（而非 null），让页面逻辑正常运行。
 *
 * @param token 一次性信令令牌（见 makeNavInterceptScript 的安全说明）。
 *              proxy.close()/focus() 的 console 信令必须携带该令牌。
 */
export function makeWindowOpenProxyScript(token: string): string {
    return `(function() {
    if (window.__openDeskWindowOpenPatched) return;
    window.__openDeskWindowOpenPatched = true;

    console.log('[OpenDesk::webviewPreload] window.open proxy injected at', Date.now());

    if (!window.__openDeskPopupProxies) window.__openDeskPopupProxies = [];
    var _proxyCounter = 0;
    var SIGNAL_TOKEN = ${JSON.stringify(token)};
    // 空 token（preload 场景）时保持历史无 token 段格式，避免出现 "::" 双隔断
    var SIGNAL_PREFIX = SIGNAL_TOKEN ? SIGNAL_TOKEN + ':' : '';

    const _origOpen = window.open.bind(window);

    window.open = function(url, target, features) {
        console.log('[OpenDesk::webviewPreload] window.open called:', url, 'target:', target);

        const result = _origOpen(url, target, features);
        if (result) {
            console.log('[OpenDesk::webviewPreload] native window.open succeeded, returning real window');
            return result;
        }

        console.log('[OpenDesk::webviewPreload] native window.open returned null, returning proxy');

        var proxyId = ++_proxyCounter;
        var proxy = {
            closed: false,
            close: function() {
                proxy.closed = true;
                console.log('__openDesk_popup_close__:' + SIGNAL_PREFIX + proxyId);
            },
            focus: function() {
                console.log('__openDesk_popup_focus__:' + SIGNAL_PREFIX + proxyId);
            },
            blur: function() {},
            print: function() {},
            stop: function() {},
            postMessage: function(msg, origin) {
                window.dispatchEvent(new MessageEvent('message', {
                    data: msg,
                    origin: origin || '',
                    source: null
                }));
            },
            location: {
                href: url || 'about:blank',
                reload: function() {},
                replace: function(u) { proxy.location.href = u; },
                assign: function(u) { proxy.location.href = u; },
                toString: function() { return proxy.location.href; }
            },
            document: {
                hasFocus: function() { return !proxy.closed; },
                write: function() {},
                writeln: function() {},
                close: function() {},
                open: function() {},
                readyState: 'complete',
                title: '',
                URL: url || 'about:blank'
            },
            navigator: window.navigator,
            opener: window,
            innerWidth: 800,
            innerHeight: 600,
            outerWidth: 800,
            outerHeight: 600,
            screenX: 0,
            screenY: 0,
            moveTo: function() {},
            moveBy: function() {},
            resizeTo: function() {},
            resizeBy: function() {},
            scrollTo: function() {},
            scrollBy: function() {},
            getComputedStyle: function() { return {}; },
            addEventListener: function() {},
            removeEventListener: function() {},
            dispatchEvent: function() { return true; }
        };

        window.__openDeskPopupProxies.push({ id: proxyId, proxy: proxy });
        return proxy;
    };
})();
`;
}

/**
 * Webview preload（document-start）注入用的 window.open 代理脚本。
 *
 * preload 运行早于任何页面脚本，无法预知 per-tab token，因此以空 token 注入；
 * 其发出的 popup 信令不带 token，消费端对 popup 类信令同时接受两种形式（见
 * resolveWebviewConsoleSignal 内的能力等价说明）。renderer 侧 dom-ready 后
 * 仍会用带 token 的版本尝试覆盖（幂等标记决定只有先到者生效）。
 */
export const WINDOW_OPEN_PROXY_SCRIPT = makeWindowOpenProxyScript('');

/**
 * 焦点边界隔离脚本
 *
 * 保留 Chromium 在页面内部的原生 Tab 行为，只在焦点会从首尾边界逃出
 * webview 时进行首尾循环，避免焦点进入 OpenDesk 宿主界面。
 */
export const BROWSER_FOCUS_TRAP_SCRIPT = `(function() {
    if (window.__openDeskBrowserFocusTrapInstalled) return;
    window.__openDeskBrowserFocusTrapInstalled = true;

    var focusableSelector = [
        'a[href]',
        'area[href]',
        'button',
        'input',
        'select',
        'textarea',
        'iframe',
        'object',
        'embed',
        'summary',
        '[contenteditable="true"]',
        '[tabindex]'
    ].join(',');

    function isElement(el) {
        return !!el && el.nodeType === Node.ELEMENT_NODE;
    }

    function isVisible(el) {
        if (!isElement(el)) return false;
        if (el.closest('[hidden],[inert]')) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0 || el === document.body || el === document.documentElement;
    }

    function isFocusable(el) {
        if (!isElement(el) || !isVisible(el)) return false;
        var tag = String(el.tagName || '').toLowerCase();
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return false;
        if (el.tabIndex < 0) return false;
        return true;
    }

    function collectFocusable(root, out) {
        if (!root) return;
        var nodes = root.querySelectorAll ? root.querySelectorAll(focusableSelector) : [];
        for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i];
            if (isFocusable(node)) out.push(node);
            if (node.shadowRoot) collectFocusable(node.shadowRoot, out);
        }
    }

    function orderedFocusableElements() {
        var out = [];
        collectFocusable(document.body || document.documentElement, out);
        return out
            .map(function(el, index) {
                return { el: el, index: index, tabIndex: el.tabIndex || 0 };
            })
            .sort(function(a, b) {
                var aPositive = a.tabIndex > 0;
                var bPositive = b.tabIndex > 0;
                if (aPositive && bPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
                if (aPositive !== bPositive) return aPositive ? -1 : 1;
                return a.index - b.index;
            })
            .map(function(item) { return item.el; });
    }

    function deepestActive(root) {
        var active = root.activeElement || document.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
            active = active.shadowRoot.activeElement;
        }
        return active;
    }

    function focusElement(el) {
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }

    window.addEventListener('keydown', function(event) {
        if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;

        var focusables = orderedFocusableElements();
        if (focusables.length === 0) {
            event.preventDefault();
            return;
        }

        var active = deepestActive(document);
        var index = focusables.indexOf(active);
        if (index < 0) {
            index = focusables.findIndex(function(el) {
                return active && (el === active || el.contains(active));
            });
        }
        if (index < 0) return;

        var next = null;
        if (focusables.length === 1) {
            next = focusables[0];
        } else if (event.shiftKey && index <= 0) {
            next = focusables[focusables.length - 1];
        } else if (!event.shiftKey && index >= focusables.length - 1) {
            next = focusables[0];
        }

        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        focusElement(next);
    }, false);
})()`;

/**
 * window.opener 桥接脚本
 *
 * 在弹窗 tab 中注入 window.opener 桥接和 window.close() 覆盖，
 * 使得 SSO 页面可以通过 window.opener.postMessage() 向父 tab 发送消息，
 * 并且 window.close() 能正常关闭 tab（绕过 Chromium 对非 script-opened 窗口的限制）。
 *
 * @param token 一次性信令令牌（见 makeNavInterceptScript 的安全说明）。
 *              opener postMessage / window.close / opener reload 信令必须携带。
 */
export function makeOpenerBridgeScript(token: string): string {
    return `(function() {
    // 安全边界：合成 opener 只允许安装在顶层文档。按 HTML 规范 iframe 的
    // window.opener 恒为 null，若在 iframe 内也提供合成 opener，iframe 内脚本
    // 就能借 console 信令向宿主声明的 opener tab 发消息（规范不允许的能力）。
    if (window.top !== window.self) return;
    if (window.__openDeskOpenerPatched) return;
    window.__openDeskOpenerPatched = true;
    var SIGNAL_TOKEN = ${JSON.stringify(token)};
    if (!window.opener) {
        window.opener = {
            postMessage: function(msg, targetOrigin) {
                window.__openDeskOpenerMessage = { data: msg, origin: targetOrigin };
                console.log('__openDesk_opener_postMessage__:' + SIGNAL_TOKEN + ':' + JSON.stringify({ data: msg, origin: targetOrigin }));
            },
            closed: false,
            focus: function() {},
            blur: function() {},
            location: {
                href: '',
                reload: function() {
                    console.log('__openDesk_opener_reload__:' + SIGNAL_TOKEN);
                },
                replace: function(url) {
                    console.log('__openDesk_opener_navigate__:' + url);
                },
                assign: function(url) {
                    console.log('__openDesk_opener_navigate__:' + url);
                },
                toString: function() { return ''; }
            }
        };
    }
    var _origClose = window.close.bind(window);
    window.close = function() {
        console.log('__openDesk_window_close__:' + SIGNAL_TOKEN);
        try { _origClose(); } catch(e) {}
    };
})()`;
}

/**
 * 弹窗关闭通知脚本
 *
 * 当弹窗 tab 关闭时，通知 opener tab 更新所有 proxy.closed 状态。
 */
export const NOTIFY_POPUP_CLOSED_SCRIPT = `(function() {
    if (window.__openDeskPopupProxies) {
        window.__openDeskPopupProxies.forEach(function(item) {
            if (item && item.proxy) item.proxy.closed = true;
        });
    }
})()`;

// ---------------------------------------------------------------------------
// 导航劫持（workaround）：webview guest 的 renderer 自发起跨文档导航会被
// browser process 在提交前静默中止（ERR_ABORTED canceled=true），而
// webview.loadURL 通道正常。此脚本把页面内最常见的同窗口导航入口——左键
// 点击 <a>、GET 表单提交（含 form.submit() 方法）、以及用户意图窗口内的
// 同主域 JS 导航（location 赋值）——转为 console 信令，由宿主 renderer
// 通过 loadURL 完成导航。
//
// 明确放行（保持原生行为）：
//  - 修饰键点击（Ctrl/Meta 新标签、Shift 新窗口）
//  - target=_blank / rel=external（由 setWindowOpenHandler popup 通道处理）
//  - 非 http(s) 协议（javascript: / mailto: / 锚点等）
//  - POST 表单（无法无损转为 URL）
//  - 跨主域的 JS 导航
// ---------------------------------------------------------------------------

/** guest → renderer 导航信令的 console 前缀，与 entry.ts / browser.ts 解析端一致。 */
export const NAV_INTERCEPT_CONSOLE_PREFIX = '__od_nav__:';

/**
 * 生成导航拦截脚本（按 tab 注入，主 frame 专用）。
 *
 * @param token 一次性信令令牌：宿主按 tab 生成随机 token 并保存在渲染进程内存
 *              （WeakMap），随脚本注入 guest 页面闭包。console-message 是页面
 *              完全可控的无认证数据通道（<webview> 的该事件不携带 frame 信息，
 *              渲染进程无法校验来源 frame），消费端必须校验 token：页面脚本读
 *              不到闭包内的 token，无法凭空伪造信令（BUG-35）。
 *              残余风险：页面 hook console.log 可截获一次合法信令中的 token ——
 *              这等价于页面本就拥有的自导航/自点击能力，不构成提权。
 */
export function makeNavInterceptScript(token: string): string {
    return `(function() {
    // 安全边界：本脚本只允许安装在顶层文档。iframe（含 sandbox iframe）内的
    // 链接点击 / GET 表单提交属于 frame 自身导航，Chromium 原生即可完成；若在
    // iframe 内也安装拦截，页面 → 宿主的 console 信令会把 iframe 导航"提升"为
    // 顶层 loadURL——这会绕过 sandbox 的 allow-top-navigation 限制（安全漏洞），
    // 也会让 iframe 内普通链接把整个顶层页面顶走。
    if (window.top !== window.self) return;
    if (window.__odNavInterceptInstalled) return;
    window.__odNavInterceptInstalled = true;

    var PREFIX = '${NAV_INTERCEPT_CONSOLE_PREFIX}${token}:';

    function isHttpLike(el) {
        return el && (el.protocol === 'http:' || el.protocol === 'https:');
    }

    function findAnchor(node) {
        while (node) {
            if (node.tagName === 'A') return node;
            node = node.parentElement;
        }
        return null;
    }

    // 左键点击 <a>：修饰键 / 弹窗目标 / 非 http(s) 一律放行
    document.addEventListener('click', function(e) {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        var path = e.composedPath ? e.composedPath() : [];
        var a = null;
        for (var i = 0; i < path.length; i++) {
            if (path[i] && path[i].tagName === 'A') { a = path[i]; break; }
        }
        if (!a && e.target && e.target.closest) a = e.target.closest('a[href]');
        if (!a) return;
        if (a.getAttribute('target') !== null && a.getAttribute('target') !== '_self') return;
        if ((a.getAttribute('rel') || '').indexOf('external') !== -1) return;
        // 带 download 属性的链接语义就是"下载文件"：放行给 Chromium 原生下载。
        // 若也拦下来转成宿主 loadURL，loadURL 会以 ERR_FAILED(-2) 拒绝，并在
        // Electron 的 GUEST_VIEW_MANAGER_CALL handler 里留下一条错误日志。
        if (a.hasAttribute('download')) return;
        if (!isHttpLike(a)) return;
        e.preventDefault();
        console.log(PREFIX + a.href);
    }, true);

    // GET 表单提交（含搜索框回车的隐式提交）：序列化为 URL 后走 loadURL 通道；
    // POST 无法无损转为 URL，放行原生行为。
    document.addEventListener('submit', function(e) {
        if (e.defaultPrevented) return;
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        var t = form.getAttribute('target');
        if (t !== null && t !== '_self') return;
        var action;
        try { action = new URL(form.getAttribute('action') || location.href, location.href); }
        catch (err) { return; }
        if (action.protocol !== 'http:' && action.protocol !== 'https:') return;
        if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return;
        var params = new URLSearchParams(action.search);
        var appended = false;
        try {
            var fd = new FormData(form);
            fd.forEach(function(value, name) {
                if (!name) return;
                if (typeof value === 'string') { params.append(name, value); appended = true; }
            });
        } catch (err) { /* FormData 构造失败则放弃劫持 */ }
        if (!appended) return;
        action.search = params.toString();
        e.preventDefault();
        console.log(PREFIX + action.toString());
    }, true);

    // form.submit() 的原生导航在 webview 中被静默挂起，且不触发 submit 事件，
    // 上面的 submit 拦截捕获不到（Bing 搜索框回车即走此路径）。包装
    // HTMLFormElement.prototype.submit，对可无损转为 URL 的 GET 表单转为信令
    // 走 loadURL 通道；POST / 非 http(s) 放行原生行为。
    var _origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
        var form = this;
        var action;
        try { action = new URL(form.getAttribute('action') || location.href, location.href); }
        catch (err) { return _origSubmit.apply(this, arguments); }
        if (action.protocol !== 'http:' && action.protocol !== 'https:') return _origSubmit.apply(this, arguments);
        if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return _origSubmit.apply(this, arguments);
        var params = new URLSearchParams(action.search);
        var appended = false;
        try {
            var fd = new FormData(form);
            fd.forEach(function(value, name) {
                if (!name) return;
                if (typeof value === 'string') { params.append(name, value); appended = true; }
            });
        } catch (err) { /* FormData 构造失败则放行原生 */ }
        if (!appended) return _origSubmit.apply(this, arguments);
        action.search = params.toString();
        console.log(PREFIX + action.toString());
    };

    // JS 直接导航兜底：location.assign / location.replace。
    // 搜索框回车等场景常由页面 JS 调用 assign/replace 完成导航，这类导航同样
    // 会被 webview 框架层静默中止，这里转为 console 信令走 loadURL 通道。
    // 只拦截 http(s) 完整 URL 且与当前页面同主域（避免误伤登录回调、短链跳转等
    // 跨域重定向）；每个 frame 有独立的 Location 实例，不影响其他 frame。
    //
    // 注意：location.href = url 赋值在 Chromium 中 Location.prototype.href 没有
    // 可覆写的 setter（实测 Object.getOwnPropertyDescriptor 返回 undefined），
    // 无法在 guest 侧拦截，此类导航仍会挂起——这是无法绕过的平台限制。
    //
    // 为避免拦截页面在输入过程中自动发起的 URL 更新导航（这些导航被框架层取消
    // 但页面保持不动，若拦截会导致每次输入都跳转搜索页），仅在用户明确导航
    // 意图（回车 / 左键点击）后的短暂窗口（1s）内生效。
    var _lastNavIntent = 0;
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) _lastNavIntent = Date.now();
    }, true);
    document.addEventListener('click', function(e) {
        if (e.button === 0) _lastNavIntent = Date.now();
    }, true);

    var HTTP_NAV_RE = new RegExp('^https?://', 'i');
    function isHttpNav(url) {
        return typeof url === 'string' && HTTP_NAV_RE.test(url);
    }
    function sameMainDomain(a, b) {
        var ha = String(a).toLowerCase();
        var hb = String(b).toLowerCase();
        if (ha.slice(0, 4) === 'www.') ha = ha.slice(4);
        if (hb.slice(0, 4) === 'www.') hb = hb.slice(4);
        return ha === hb || ha.slice(-hb.length - 1) === '.' + hb || hb.slice(-ha.length - 1) === '.' + ha;
    }
    function routeJsNav(url) {
        if (!isHttpNav(url)) return false;
        if (Date.now() - _lastNavIntent > 1000) return false;
        try {
            if (!sameMainDomain(new URL(url).hostname, location.hostname)) return false;
        } catch (err) { return false; }
        console.log(PREFIX + url);
        return true;
    }
    try {
        var _assign = Location.prototype.assign;
        var _replace = Location.prototype.replace;
        Location.prototype.assign = function(url) {
            if (routeJsNav(url)) return;
            return _assign.apply(this, arguments);
        };
        Location.prototype.replace = function(url) {
            if (routeJsNav(url)) return;
            return _replace.apply(this, arguments);
        };
    } catch (err) { /* Location.prototype 在部分环境不可覆写 */ }
})();
`;
}

// ---------------------------------------------------------------------------
// console 信令（renderer 侧：token 仓库 + 消费端解析）
//
// guest 页面 → 宿主的全部信令都走 console.log + 固定前缀。console-message 是
// 页面完全可控的数据通道，任何一段页面脚本都能打印任意内容，且 <webview> 的
// 该事件不携带 frame 信息（渲染进程无法校验来源 frame），因此消费端必须校验：
//   1. 信令令牌 —— 注入脚本由宿主按 tab 生成一次性 token 注入闭包（见
//      makeNavInterceptScript），不携带合法 token 的消息一律视为伪造并忽略；
//   2. opener 关系 —— 弹窗→opener 的信令只可能出现在被 window.open 打开的
//      tab 中；
//   3. origin 不可信 —— opener postMessage 的 origin 由宿主按该 tab 的当前
//      URL 计算，不取页面提供的值（见 resolveSignalOrigin）。
// ---------------------------------------------------------------------------

/**
 * console 信令令牌仓库：按 tab（对象身份）生成并缓存一次性随机 token。
 *
 * token 存于宿主渲染进程内存（WeakMap），仅随注入脚本进入 guest 页面闭包，
 * 页面脚本读不到；tab 关闭后随对象一起被 GC。信令注入端（makeNavInterceptScript
 * 等）与消费端（resolveWebviewConsoleSignal）必须使用同一仓库产出的 token。
 */
export function createWebviewSignalTokenStore(): <T extends object>(tab: T) => string {
    const tokens = new WeakMap<object, string>();
    return (tab) => {
        let token = tokens.get(tab);
        if (!token) {
            token = crypto.randomUUID().replace(/-/g, '');
            tokens.set(tab, token);
        }
        return token;
    };
}

/** webview console 信令的解析结果。kind === 'none' 表示忽略该消息。 */
export type WebviewSignalAction =
    | { kind: 'none' }
    /** 页面请求 window.close()（关闭自身 tab） */
    | { kind: 'windowClose' }
    /** 弹窗请求刷新其 opener tab */
    | { kind: 'openerReload' }
    /** 弹窗向 opener tab 发送 postMessage（origin 由宿主另行计算） */
    | { kind: 'openerPostMessage'; data: unknown }
    /** 页面请求切换到它打开的弹窗 tab */
    | { kind: 'popupFocus'; proxyId: string }
    /** 页面请求关闭它打开的弹窗 tab */
    | { kind: 'popupClose'; proxyId: string }
    /** 顶层文档请求同窗口导航 */
    | { kind: 'navigate'; url: string };

const OPENER_POSTMESSAGE_PREFIX = '__openDesk_opener_postMessage__:';

/** popup 信令尾部若带 token 前缀则剥离，返回纯 proxyId。 */
function stripTokenPrefix(suffix: string, token: string): string {
    return suffix.startsWith(`${token}:`) ? suffix.slice(token.length + 1) : suffix;
}

/**
 * 将一条 console 消息解析为宿主动作。所有信令都要求携带该 tab 的一次性
 * token（闭包注入，页面脚本无法读取）；opener 类信令额外要求当前 tab
 * 存在 opener 关系。
 *
 * @param msg       console 消息原文
 * @param token     当前 tab 的信令令牌（见 makeNavInterceptScript）
 * @param hasOpener 当前 tab 是否被其它 tab 打开（openerTabId != null）
 */
export function resolveWebviewConsoleSignal(msg: string, token: string, hasOpener: boolean): WebviewSignalAction {
    if (!msg || !token) return { kind: 'none' };

    if (hasOpener) {
        if (msg === `__openDesk_window_close__:${token}`) return { kind: 'windowClose' };
        if (msg === `__openDesk_opener_reload__:${token}`) return { kind: 'openerReload' };
        const openerPrefix = `${OPENER_POSTMESSAGE_PREFIX}${token}:`;
        if (msg.startsWith(openerPrefix)) {
            try {
                const payload = JSON.parse(msg.slice(openerPrefix.length));
                // 注意：payload.origin 不可信，消费端必须用宿主计算的真实 origin。
                return { kind: 'openerPostMessage', data: payload?.data };
            } catch {
                return { kind: 'none' };
            }
        }
    }

    const popupFocusPrefix = '__openDesk_popup_focus__:';
    if (msg.startsWith(popupFocusPrefix)) {
        // popup 类信令同时接受带/不带 token 两种形式：preload 在 document-start
        // 注入的 window.open 代理无法预知 per-tab token（不带 token），而页面本就
        // 持有 window.open 返回的 proxy 引用、可以直接调用其 close()/focus()，
        // 这两个信令的能力等价于页面既有能力，token 不构成额外边界。
        return { kind: 'popupFocus', proxyId: stripTokenPrefix(msg.slice(popupFocusPrefix.length), token) };
    }
    const popupClosePrefix = '__openDesk_popup_close__:';
    if (msg.startsWith(popupClosePrefix)) {
        return { kind: 'popupClose', proxyId: stripTokenPrefix(msg.slice(popupClosePrefix.length), token) };
    }

    const navPrefix = `${NAV_INTERCEPT_CONSOLE_PREFIX}${token}:`;
    if (msg.startsWith(navPrefix)) {
        const url = msg.slice(navPrefix.length);
        if (url && /^https?:\/\//.test(url)) return { kind: 'navigate', url };
    }

    return { kind: 'none' };
}

/**
 * 计算 opener postMessage 的真实 origin（宿主侧计算，不信任页面提供的值，
 * BUG-36）。<webview> 的 console-message 事件不携带 frame 信息，宿主侧可用的
 * 真实数据源是该弹窗 tab 当前 URL 的 origin；不可得时返回空串（opener 侧按
 * origin 过滤的消息会被安全地拒收）。
 */
export function resolveSignalOrigin(tabUrl: string | undefined): string {
    try {
        return tabUrl ? new URL(tabUrl).origin : '';
    } catch {
        return '';
    }
}

/**
 * 调用 `<webview>.loadURL` 并吞掉"预期内"的导航拒绝。
 *
 * loadURL 返回 Promise：当目标地址是下载资源（Content-Disposition / 二进制响应）
 * 或导航被主动中断时，Promise 会以 ERR_FAILED(-2) / ERR_ABORTED(-3) 拒绝。此前
 * 各调用点只用了同步 try/catch，于是拒绝变成未处理 rejection，冒到 Electron 的
 * GUEST_VIEW_MANAGER_CALL handler 里刷错误日志：
 *   Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2) loading '…'
 * 这里统一收口：-2/-3 视为正常结果（触发了下载 / 被中断），其余仅记录 warn。
 *
 * @param onRejected 拒绝时的回调（错误码）：调用方据此回滚"乐观更新"的 tab.url
 *                   —— 导航没发生却把地址栏/tab 记录改成资源地址，会让
 *                   tabs list 与实际页面不一致。
 * @returns true 表示已通过 loadURL 发起导航（调用方无需回退到 `webview.src`）
 */
export function loadWebviewUrlQuietly(
    webview: any,
    url: string,
    onRejected?: (errorCode: number | undefined) => void
): boolean {
    if (!webview || typeof webview.loadURL !== 'function') return false;
    try {
        const pending = webview.loadURL(url);
        if (pending && typeof pending.catch === 'function') {
            void pending.catch((err: any) => {
                const code = err?.errno ?? err?.code;
                try {
                    onRejected?.(typeof code === 'number' ? code : undefined);
                } catch {
                    /* 回调异常不能影响主流程 */
                }
                // -2 ERR_FAILED（下载资源常见）/ -3 ERR_ABORTED（主动中断）
                if (code === -2 || code === -3) return;
                try {
                    console.warn('[browser] loadURL failed:', url, err?.message || String(err));
                } catch {
                    /* ignore */
                }
            });
        }
        return true;
    } catch {
        return false;
    }
}
