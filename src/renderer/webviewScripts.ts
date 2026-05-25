/**
 * Webview 注入脚本 — 共享常量
 *
 * 这些脚本字符串分别通过 preload（webviewPreload.js）和
 * executeJavaScript（browser.ts / entry.ts）两种方式注入到
 * webview guest 页面中，用于 patch window.open / window.opener。
 *
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * window.open Proxy 注入脚本
 *
 * 在 webview guest 中覆盖 window.open，使 Electron deny 弹窗时
 * 仍返回一个模拟 window 对象（而非 null），让页面逻辑正常运行。
 */
export const WINDOW_OPEN_PROXY_SCRIPT = `(function() {
    if (window.__openDeskWindowOpenPatched) return;
    window.__openDeskWindowOpenPatched = true;

    console.log('[OpenDesk::webviewPreload] window.open proxy injected at', Date.now());

    if (!window.__openDeskPopupProxies) window.__openDeskPopupProxies = [];
    var _proxyCounter = 0;

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
                console.log('__openDesk_popup_close__:' + proxyId);
            },
            focus: function() {
                console.log('__openDesk_popup_focus__:' + proxyId);
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
})()`;

/**
 * window.opener 桥接脚本
 *
 * 在弹窗 tab 中注入 window.opener 桥接和 window.close() 覆盖，
 * 使得 SSO 页面可以通过 window.opener.postMessage() 向父 tab 发送消息，
 * 并且 window.close() 能正常关闭 tab（绕过 Chromium 对非 script-opened 窗口的限制）。
 */
export const OPENER_BRIDGE_SCRIPT = `(function() {
    if (window.__openDeskOpenerPatched) return;
    window.__openDeskOpenerPatched = true;
    if (!window.opener) {
        window.opener = {
            postMessage: function(msg, targetOrigin) {
                window.__openDeskOpenerMessage = { data: msg, origin: targetOrigin };
                console.log('__openDesk_opener_postMessage__:' + JSON.stringify({ data: msg, origin: targetOrigin }));
            },
            closed: false,
            focus: function() {},
            blur: function() {},
            location: {
                href: '',
                reload: function() {
                    console.log('__openDesk_opener_reload__');
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
        console.log('__openDesk_window_close__');
        try { _origClose(); } catch(e) {}
    };
})()`;

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
